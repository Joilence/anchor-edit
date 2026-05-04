import { ANCHOR_SEPARATOR } from "./pool.js";
import { AnchorEditError, type EditResult } from "./state.js";

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

export function formatEditAppliedText(result: EditResult, newContent: string): string {
  const [start, end] = result.affectedRange;
  const hint =
    newContent.includes("\\n") && !newContent.includes("\n")
      ? "\n\nNote: new_content contained literal backslash-n but no real newline characters. It was written to the file verbatim. If you intended a line break, retry with a real newline character (LF, U+000A) in new_content."
      : "";
  if (end < start) {
    return `Edit applied. Range deleted at line ${start + 1}.${hint}`;
  }
  const view = formatLines(
    result.anchors.slice(start, end + 1),
    result.lines.slice(start, end + 1)
  );
  return `Edit applied. Updated lines ${start + 1}-${end + 1}:\n${view}${hint}`;
}
