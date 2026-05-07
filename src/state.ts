import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { diffArrays } from "diff";
import { POOL } from "./pool.js";

export type AnchorEditCode =
  | "ANCHOR_NOT_FOUND"
  | "INVALID_RANGE"
  | "BINARY_FILE"
  | "ANCHOR_POOL_EXHAUSTED";

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
  totalLines: number;
}

export interface AddedRange {
  startIdx: number;
  anchors: string[];
}

export type EditOperation = "replace" | "insert" | "delete";

export interface EditResult extends ReadResult {
  affectedRange: [number, number];
  originalRange: [number, number] | null;
  originalLines: string[];
  originalAnchors: string[];
  postAfterStart: number;
  operation: EditOperation;
}

export interface WriteResult extends ReadResult {
  addedRanges: AddedRange[];
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
    const { state } = this.loadAndSync(filePath);
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : state.lines.length;
    return {
      lines: state.lines.slice(start, end),
      anchors: state.anchorByLine.slice(start, end),
      totalLines: state.lines.length,
    };
  }

  edit(args: EditArgs): EditResult {
    const { state } = this.loadAndSync(args.filePath);
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

    const isDelete = insertedLines.length === 0 && mode === "replace";
    const operation: EditOperation = isDelete
      ? "delete"
      : mode === "replace"
        ? "replace"
        : "insert";
    const originalLines = [...state.lines];
    const originalAnchors = [...state.anchorByLine];
    let updatedLines: string[];
    let affectedStart: number;
    let affectedEnd: number;
    let originalRange: [number, number] | null;
    let postAfterStart: number;
    if (mode === "replace") {
      updatedLines = [
        ...state.lines.slice(0, startIdx),
        ...insertedLines,
        ...state.lines.slice(endIdx + 1),
      ];
      if (isDelete) {
        affectedStart = startIdx;
        affectedEnd = endIdx;
      } else {
        affectedStart = startIdx;
        affectedEnd = startIdx + insertedLines.length - 1;
      }
      originalRange = [startIdx, endIdx];
      postAfterStart = startIdx + insertedLines.length;
    } else if (mode === "insert_before") {
      updatedLines = [
        ...state.lines.slice(0, startIdx),
        ...insertedLines,
        ...state.lines.slice(startIdx),
      ];
      affectedStart = startIdx;
      affectedEnd = startIdx + insertedLines.length - 1;
      originalRange = null;
      postAfterStart = startIdx + insertedLines.length;
    } else {
      updatedLines = [
        ...state.lines.slice(0, startIdx + 1),
        ...insertedLines,
        ...state.lines.slice(startIdx + 1),
      ];
      affectedStart = startIdx + 1;
      affectedEnd = startIdx + insertedLines.length;
      originalRange = null;
      postAfterStart = startIdx + 1 + insertedLines.length;
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

    return {
      lines: [...state.lines],
      anchors: [...state.anchorByLine],
      totalLines: state.lines.length,
      affectedRange: [affectedStart, affectedEnd],
      originalRange,
      originalLines,
      originalAnchors,
      postAfterStart,
      operation,
    };
  }

  write(filePath: string, content: string): WriteResult {
    const abs = resolvePath(filePath);
    this.writeFile(abs, content);
    const { state, addedRanges } = this.loadAndSync(abs);
    return {
      lines: [...state.lines],
      anchors: [...state.anchorByLine],
      totalLines: state.lines.length,
      addedRanges,
    };
  }

  reset(filePath?: string): void {
    if (filePath === undefined) {
      this.files.clear();
      return;
    }
    this.files.delete(resolvePath(filePath));
  }

  private writeFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  private loadAndSync(filePath: string): { state: FileState; addedRanges: AddedRange[] } {
    const abs = resolvePath(filePath);
    const buffer = readFileSync(abs);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AnchorEditError(
        `File appears to be binary or non-UTF-8: ${abs} (${detail})`,
        "BINARY_FILE"
      );
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
      const addedRanges: AddedRange[] =
        lines.length > 0 ? [{ startIdx: 0, anchors: [...fresh.anchorByLine] }] : [];
      return { state: fresh, addedRanges };
    }

    if (existing.content !== content) {
      const addedRanges = this.reconcile(existing, lines);
      existing.content = content;
      existing.hadTrailingNewline = hadTrailingNewline;
      return { state: existing, addedRanges };
    }
    return { state: existing, addedRanges: [] };
  }

  private reconcile(state: FileState, newLines: string[]): AddedRange[] {
    const oldAnchors = state.anchorByLine;
    const diff = diffArrays(state.lines, newLines);

    const newAnchors: string[] = [];
    const addedRanges: AddedRange[] = [];
    let oldIdx = 0;
    let newIdx = 0;

    for (const part of diff) {
      const len = part.value.length;
      if (part.added) {
        const runAnchors: string[] = [];
        for (let i = 0; i < len; i++) {
          const a = this.allocate(state);
          runAnchors.push(a);
          newAnchors.push(a);
        }
        addedRanges.push({ startIdx: newIdx, anchors: runAnchors });
        newIdx += len;
      } else if (part.removed) {
        oldIdx += len;
      } else {
        for (let i = 0; i < len; i++) {
          const a = oldAnchors[oldIdx + i];
          newAnchors.push(a ?? this.allocate(state));
        }
        oldIdx += len;
        newIdx += len;
      }
    }

    state.lines = newLines;
    state.anchorByLine = newAnchors;
    return addedRanges;
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
        pieces.push(this.pool[Math.floor(Math.random() * this.pool.length)]);
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
      "ANCHOR_POOL_EXHAUSTED"
    );
  }
}
