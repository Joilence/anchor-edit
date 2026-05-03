import { ANCHOR_SEPARATOR } from "./pool.js";
import { AnchorEditError } from "./state.js";

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
