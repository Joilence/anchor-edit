import type { z } from "zod";
import { CONTEXT_LINES } from "./descriptions.js";
import { ANCHOR_SEPARATOR } from "./pool.js";
import type { editAnchoredOutput, readAnchoredOutput, writeFileOutput } from "./schemas.js";
import type { AddedRange, EditResult, ReadResult } from "./state.js";

export type ReadStructured = z.infer<typeof readAnchoredOutput>;
export type EditStructured = z.infer<typeof editAnchoredOutput>;
export type WriteStructured = z.infer<typeof writeFileOutput>;

export function formatLines(anchors: readonly string[], lines: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < anchors.length; i++) {
    out.push(`${anchors[i]}${ANCHOR_SEPARATOR}${lines[i]}`);
  }
  return out.join("\n");
}

export function buildReadResult(
  result: ReadResult,
  totalLines: number
): { text: string; structured: ReadStructured } {
  const anchored_text = formatLines(result.anchors, result.lines);
  return {
    text: anchored_text,
    structured: { total_lines: totalLines, anchored_text },
  };
}

export function lineNumberWidth(maxLineNumber: number): number {
  return Math.max(2, String(maxLineNumber).length);
}

export interface DisplayLine {
  prefix: " " | "-" | "+";
  lineNumber: number;
  anchor: string;
  line: string;
}

export type DisplayEntry = { kind: "ellipsis" } | { kind: "line"; line: DisplayLine };

export function anchorColumnWidth(entries: readonly DisplayEntry[]): number {
  return entries.reduce(
    (width, entry) => (entry.kind === "line" ? Math.max(width, entry.line.anchor.length) : width),
    0
  );
}

export function displayAnchoredChrome(
  line: DisplayLine,
  lineWidth: number,
  anchorWidth: number
): string {
  return `${line.prefix} ${String(line.lineNumber).padStart(lineWidth)} ${line.anchor.padEnd(anchorWidth)}${ANCHOR_SEPARATOR} `;
}

export function displayAnchoredLine(
  line: DisplayLine,
  lineWidth: number,
  anchorWidth: number
): string {
  return displayAnchoredChrome(line, lineWidth, anchorWidth) + line.line;
}

function displayReadLine(
  lineNumber: number,
  lineWidth: number,
  anchorWidth: number,
  anchor: string,
  line: string
): string {
  return `${String(lineNumber).padStart(lineWidth)} ${anchor.padEnd(anchorWidth)}${ANCHOR_SEPARATOR} ${line}`;
}

export function displayEllipsis(lineWidth: number, anchorWidth: number): string {
  // +4 matches the prefix + inter-column spaces in `displayAnchoredChrome`
  // ("<prefix> <lineNumber> <anchor>§ "): keep in sync if that chrome changes.
  return `${" ".repeat(lineWidth + anchorWidth + ANCHOR_SEPARATOR.length + 4)}...`;
}

export function buildReadDisplay(result: ReadResult, offset = 0): string {
  const lineWidth = lineNumberWidth(result.totalLines);
  const anchorWidth = result.anchors.reduce((width, anchor) => Math.max(width, anchor.length), 0);
  const lines: string[] = [];
  for (let i = 0; i < result.lines.length; i++) {
    lines.push(
      displayReadLine(offset + i + 1, lineWidth, anchorWidth, result.anchors[i], result.lines[i])
    );
  }
  return lines.join("\n");
}

export function buildEditDisplayEntries(result: EditResult): {
  entries: DisplayEntry[];
  lineWidth: number;
} {
  const [postStart, postEnd] = result.affectedRange;
  const isDelete = result.operation === "delete";
  const [origStart, origEnd] = result.originalRange ?? [postStart, postStart - 1];
  const lineWidth = lineNumberWidth(Math.max(result.originalLines.length, result.lines.length));
  const entries: DisplayEntry[] = [];

  const beforeStart = Math.max(0, origStart - CONTEXT_LINES);
  if (beforeStart > 0) entries.push({ kind: "ellipsis" });
  for (let i = beforeStart; i < origStart; i++) {
    entries.push({
      kind: "line",
      line: {
        prefix: " ",
        lineNumber: i + 1,
        anchor: result.originalAnchors[i],
        line: result.originalLines[i],
      },
    });
  }

  const postAnchorsInRange = isDelete
    ? new Set<string>()
    : new Set(result.anchors.slice(postStart, postEnd + 1));
  for (let i = origStart; i <= origEnd; i++) {
    const anchor = result.originalAnchors[i];
    if (!postAnchorsInRange.has(anchor)) {
      entries.push({
        kind: "line",
        line: { prefix: "-", lineNumber: i + 1, anchor, line: result.originalLines[i] },
      });
    }
  }

  if (!isDelete) {
    const origAnchorsInRange = new Set(result.originalAnchors.slice(origStart, origEnd + 1));
    for (let i = postStart; i <= postEnd; i++) {
      const anchor = result.anchors[i];
      entries.push({
        kind: "line",
        line: {
          prefix: origAnchorsInRange.has(anchor) ? " " : "+",
          lineNumber: i + 1,
          anchor,
          line: result.lines[i],
        },
      });
    }
  }

  const afterEnd = Math.min(result.lines.length, result.postAfterStart + CONTEXT_LINES);
  for (let i = result.postAfterStart; i < afterEnd; i++) {
    entries.push({
      kind: "line",
      line: {
        prefix: " ",
        lineNumber: i + 1,
        anchor: result.anchors[i],
        line: result.lines[i],
      },
    });
  }
  if (afterEnd < result.lines.length) entries.push({ kind: "ellipsis" });

  return { entries, lineWidth };
}

function detectLiteralBackslashN(content: string): string | undefined {
  return content.includes("\\n") && !content.includes("\n")
    ? "new_content contained literal backslash-n but no real newline characters. It was written verbatim. If you intended a line break, retry with a real newline (LF, U+000A)."
    : undefined;
}

function diffLine(prefix: " " | "-" | "+", anchor: string, line: string): string {
  return `${prefix}${anchor}${ANCHOR_SEPARATOR}${line}`;
}

function buildDiff(result: EditResult): string {
  const [postStart, postEnd] = result.affectedRange;
  const isDelete = result.operation === "delete";
  const [origStart, origEnd] = result.originalRange ?? [postStart, postStart - 1];
  const out: string[] = [];

  const beforeStart = Math.max(0, origStart - CONTEXT_LINES);
  for (let i = beforeStart; i < origStart; i++) {
    const a = result.originalAnchors[i];
    const l = result.originalLines[i];
    if (a !== undefined && l !== undefined) out.push(diffLine(" ", a, l));
  }

  const postAnchorsInRange = isDelete
    ? new Set<string>()
    : new Set(result.anchors.slice(postStart, postEnd + 1));
  for (let i = origStart; i <= origEnd; i++) {
    const a = result.originalAnchors[i];
    const l = result.originalLines[i];
    if (a !== undefined && l !== undefined && !postAnchorsInRange.has(a)) {
      out.push(diffLine("-", a, l));
    }
  }

  if (!isDelete) {
    const origAnchorsInRange = new Set(result.originalAnchors.slice(origStart, origEnd + 1));
    for (let i = postStart; i <= postEnd; i++) {
      const a = result.anchors[i];
      const l = result.lines[i];
      if (a !== undefined && l !== undefined) {
        out.push(diffLine(origAnchorsInRange.has(a) ? " " : "+", a, l));
      }
    }
  }

  const afterEnd = Math.min(result.lines.length, result.postAfterStart + CONTEXT_LINES);
  for (let i = result.postAfterStart; i < afterEnd; i++) {
    const a = result.anchors[i];
    const l = result.lines[i];
    if (a !== undefined && l !== undefined) out.push(diffLine(" ", a, l));
  }

  return out.join("\n");
}

export function buildEditResult(
  result: EditResult,
  newContent: string
): { text: string; structured: EditStructured } {
  const [startIdx, endIdx] = result.affectedRange;
  const startLine = startIdx + 1;
  const endLine = endIdx + 1;
  const diff = buildDiff(result);
  const notes: string[] = [];
  if (result.operation !== "delete") {
    const note = detectLiteralBackslashN(newContent);
    if (note) notes.push(note);
  } else if (newContent !== "") {
    notes.push(
      "new_content was ignored because mode=delete; use mode=replace if substitution was intended."
    );
  }
  const summary =
    result.operation === "delete"
      ? `Edit applied. Lines ${startLine}-${endLine} deleted.`
      : `Edit applied. Lines ${startLine}-${endLine}.`;
  const structured: EditStructured = {
    total_lines: result.lines.length,
    affected_lines: [startLine, endLine],
    diff,
  };
  if (notes.length > 0) structured.notes = notes;
  const textParts = [summary];
  if (diff) textParts.push(diff);
  for (const n of notes) textParts.push(n);
  return {
    text: textParts.join("\n\n"),
    structured,
  };
}

export function buildWriteResult(
  totalLines: number,
  addedRanges: readonly AddedRange[]
): { text: string; structured: WriteStructured } {
  const changes = addedRanges.map((r) => ({
    start_line: r.startIdx + 1,
    anchors: [...r.anchors],
  }));
  const text = `Wrote ${totalLines} lines. ${changes.length} anchor run${changes.length === 1 ? "" : "s"} added.`;
  return {
    text,
    structured: { total_lines: totalLines, changes },
  };
}
