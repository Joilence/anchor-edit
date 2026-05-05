import type { z } from "zod";
import { CONTEXT_LINES } from "./descriptions.js";
import { ANCHOR_SEPARATOR } from "./pool.js";
import type { editAnchoredOutput, readAnchoredOutput, writeFileOutput } from "./schemas.js";
import { type AddedRange, AnchorEditError, type EditResult, type ReadResult } from "./state.js";

export type ReadStructured = z.infer<typeof readAnchoredOutput>;
export type EditStructured = z.infer<typeof editAnchoredOutput>;
export type WriteStructured = z.infer<typeof writeFileOutput>;

export function formatLines(anchors: readonly string[], lines: readonly string[]): string {
  if (anchors.length !== lines.length) {
    throw new AnchorEditError(
      `Mismatched anchors (${anchors.length}) and lines (${lines.length})`,
      "FORMAT_MISMATCH"
    );
  }
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
