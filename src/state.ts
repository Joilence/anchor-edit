import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { diffArrays } from "diff";
import { POOL } from "./pool.js";

export type AnchorEditCode =
  | "ANCHOR_NOT_FOUND"
  | "INVALID_RANGE"
  | "FILE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "IS_DIRECTORY"
  | "BINARY_FILE"
  | "FORMAT_MISMATCH"
  | "RECONCILE_MISMATCH"
  | "POOL_EMPTY"
  | "POOL_EXHAUSTED";

export class AnchorEditError extends Error {
  code: AnchorEditCode;

  constructor(message: string, code: AnchorEditCode) {
    super(message);
    this.name = "AnchorEditError";
    this.code = code;
  }
}

export const EDIT_MODES = ["replace", "insert_before", "insert_after", "delete"] as const;
export type EditMode = (typeof EDIT_MODES)[number];

export interface EditArgs {
  filePath: string;
  startAnchor: string;
  endAnchor?: string;
  newContent: string;
  mode: EditMode;
}

export interface ReadResult {
  lines: string[];
  anchors: string[];
}

export interface EditResult extends ReadResult {
  affectedRange: [number, number];
}

export interface StateManagerOptions {
  poolOverride?: readonly string[];
}

const LINE_SPLIT = /\r?\n/;
const MULTIWORD_MAX_TRIES = 100;

interface FileState {
  path: string;
  content: string;
  lines: string[];
  anchorByLine: string[];
  available: string[];
  usedWords: Set<string>;
  hadTrailingNewline: boolean;
}

function splitLogicalLines(content: string): { lines: string[]; hadTrailingNewline: boolean } {
  if (content === "") return { lines: [], hadTrailingNewline: false };
  const hadTrailingNewline = content.endsWith("\n");
  const raw = content.split(LINE_SPLIT);
  return { lines: hadTrailingNewline ? raw.slice(0, -1) : raw, hadTrailingNewline };
}

function joinLogicalLines(lines: readonly string[], hadTrailingNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (hadTrailingNewline ? "\n" : "");
}

export class StateManager {
  private files = new Map<string, FileState>();
  private pool: readonly string[];

  constructor(options: StateManagerOptions = {}) {
    this.pool = options.poolOverride ?? POOL;
  }

  read(filePath: string, offset?: number, limit?: number): ReadResult {
    const state = this.loadAndSync(filePath);
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : state.lines.length;
    return {
      lines: state.lines.slice(start, end),
      anchors: state.anchorByLine.slice(start, end),
    };
  }

  edit(args: EditArgs): EditResult {
    const state = this.loadAndSync(args.filePath);
    const mode: Exclude<EditMode, "delete"> = args.mode === "delete" ? "replace" : args.mode;
    const newContent = args.mode === "delete" ? "" : args.newContent;

    const startIdx = state.anchorByLine.indexOf(args.startAnchor);
    if (startIdx < 0) {
      throw new AnchorEditError(
        `start_anchor "${args.startAnchor}" is not in the current anchor map for ${state.path}. Re-read the file to refresh.`,
        "ANCHOR_NOT_FOUND"
      );
    }

    let endIdx = startIdx;
    if (mode === "replace") {
      const endAnchor = args.endAnchor ?? args.startAnchor;
      endIdx = state.anchorByLine.indexOf(endAnchor);
      if (endIdx < 0) {
        throw new AnchorEditError(
          `end_anchor "${endAnchor}" is not in the current anchor map for ${state.path}. Re-read the file to refresh.`,
          "ANCHOR_NOT_FOUND"
        );
      }
      if (endIdx < startIdx) {
        throw new AnchorEditError(
          `end_anchor must come at or after start_anchor (got start=${startIdx}, end=${endIdx}).`,
          "INVALID_RANGE"
        );
      }
    }

    const insertedLines =
      newContent === "" && mode === "replace" ? [] : newContent.split(LINE_SPLIT);

    let updatedLines: string[];
    let affectedStart: number;
    if (mode === "replace") {
      updatedLines = [
        ...state.lines.slice(0, startIdx),
        ...insertedLines,
        ...state.lines.slice(endIdx + 1),
      ];
      affectedStart = startIdx;
    } else if (mode === "insert_before") {
      updatedLines = [
        ...state.lines.slice(0, startIdx),
        ...insertedLines,
        ...state.lines.slice(startIdx),
      ];
      affectedStart = startIdx;
    } else {
      updatedLines = [
        ...state.lines.slice(0, startIdx + 1),
        ...insertedLines,
        ...state.lines.slice(startIdx + 1),
      ];
      affectedStart = startIdx + 1;
    }

    const newHadTrailingNewline = updatedLines.length > 0 && state.hadTrailingNewline;
    const updatedContent = joinLogicalLines(updatedLines, newHadTrailingNewline);

    try {
      this.writeFile(state.path, updatedContent);
      this.reconcile(state, updatedLines);
      state.content = updatedContent;
      state.hadTrailingNewline = newHadTrailingNewline;
    } catch (err) {
      this.files.delete(state.path);
      throw err;
    }

    const affectedEnd = affectedStart + insertedLines.length - 1;
    return {
      lines: [...state.lines],
      anchors: [...state.anchorByLine],
      affectedRange: [affectedStart, affectedEnd],
    };
  }

  write(filePath: string, content: string): ReadResult {
    const abs = resolvePath(filePath);
    this.writeFile(abs, content);
    return this.read(abs);
  }

  reset(filePath?: string): void {
    if (filePath === undefined) {
      this.files.clear();
      return;
    }
    this.files.delete(resolvePath(filePath));
  }

  private writeFile(path: string, content: string): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
    } catch (err) {
      translateFsError(err, path);
    }
  }

  private loadAndSync(filePath: string): FileState {
    const abs = resolvePath(filePath);
    let buffer: Buffer;
    try {
      buffer = readFileSync(abs);
    } catch (err) {
      translateFsError(err, abs);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new AnchorEditError(`File appears to be binary or non-UTF-8: ${abs}`, "BINARY_FILE");
    }
    const { lines, hadTrailingNewline } = splitLogicalLines(content);

    const existing = this.files.get(abs);
    if (!existing) {
      const fresh: FileState = {
        path: abs,
        content,
        lines,
        anchorByLine: [],
        available: [...this.pool],
        usedWords: new Set(),
        hadTrailingNewline,
      };
      fresh.anchorByLine = lines.map(() => this.allocate(fresh));
      this.files.set(abs, fresh);
      return fresh;
    }

    if (existing.content !== content) {
      this.reconcile(existing, lines);
      existing.content = content;
      existing.hadTrailingNewline = hadTrailingNewline;
    }
    return existing;
  }

  private reconcile(state: FileState, newLines: string[]): void {
    const oldAnchors = state.anchorByLine;
    const diff = diffArrays(state.lines, newLines);

    const newAnchors: string[] = [];
    let oldIdx = 0;

    for (const part of diff) {
      const len = part.value.length;
      if (part.added) {
        for (let i = 0; i < len; i++) newAnchors.push(this.allocate(state));
      } else if (part.removed) {
        oldIdx += len;
      } else {
        for (let i = 0; i < len; i++) {
          const a = oldAnchors[oldIdx + i];
          newAnchors.push(a ?? this.allocate(state));
        }
        oldIdx += len;
      }
    }

    if (newAnchors.length !== newLines.length) {
      throw new AnchorEditError(
        `Reconcile produced ${newAnchors.length} anchors for ${newLines.length} lines (internal bug).`,
        "RECONCILE_MISMATCH"
      );
    }

    state.lines = newLines;
    state.anchorByLine = newAnchors;
  }

  private allocate(state: FileState): string {
    const a = state.available.shift();
    if (a) {
      state.usedWords.add(a);
      return a;
    }
    return this.allocateMultiWord(state, 2);
  }

  private allocateMultiWord(state: FileState, parts: number): string {
    for (let attempt = 0; attempt < MULTIWORD_MAX_TRIES; attempt++) {
      const pieces: string[] = [];
      for (let i = 0; i < parts; i++) {
        const word = this.pool[Math.floor(Math.random() * this.pool.length)];
        if (word === undefined) {
          throw new AnchorEditError(
            "Pool is empty; cannot allocate multi-word anchor.",
            "POOL_EMPTY"
          );
        }
        pieces.push(word);
      }
      const candidate = pieces.join("");
      if (!state.usedWords.has(candidate)) {
        state.usedWords.add(candidate);
        return candidate;
      }
    }
    if (parts < 4) return this.allocateMultiWord(state, parts + 1);
    throw new AnchorEditError(
      `Anchor allocation failed for ${state.path} after exhausting pool and multi-word fallbacks.`,
      "POOL_EXHAUSTED"
    );
  }
}

function translateFsError(err: unknown, path: string): never {
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    if (err.code === "ENOENT") {
      throw new AnchorEditError(`File not found: ${path}`, "FILE_NOT_FOUND");
    }
    if (err.code === "EACCES") {
      throw new AnchorEditError(`Permission denied: ${path}`, "PERMISSION_DENIED");
    }
    if (err.code === "EISDIR") {
      throw new AnchorEditError(`Path is a directory: ${path}`, "IS_DIRECTORY");
    }
  }
  throw err;
}
