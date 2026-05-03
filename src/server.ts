import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { formatLines } from "./format.js";
import { ANCHOR_SEPARATOR, POOL } from "./pool.js";
import { editAnchoredInput, readAnchoredInput, writeFileInput } from "./schemas.js";
import { StateManager } from "./state.js";

export function buildServer(state: StateManager = new StateManager()): McpServer {
  const server = new McpServer({ name: "anchor-edit", version: "0.0.1" });

  server.registerTool(
    "read_anchored",
    {
      description: `Read a file with one anchor prefix per line in the format "<anchor>${ANCHOR_SEPARATOR}<content>". When parsing a returned line, split on the first ${ANCHOR_SEPARATOR} character; later ${ANCHOR_SEPARATOR} characters belong to file content. Anchors are opaque IDs drawn from a session-scoped pool of ${POOL.length} single-BPE-token capitalized English words; once the pool is exhausted, the allocator falls back to multi-word concatenations (e.g. "MorelloMagnificent"), which are no longer single-token but remain unique. Anchors are stable across edits unless the line itself changes (Myers-diff reconciler reassigns only changed lines). Use the anchor in subsequent edit_anchored calls instead of repeating line content. Returns empty content if offset is at or beyond the file's line count.`,
      inputSchema: readAnchoredInput.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input: z.infer<typeof readAnchoredInput>) => {
      const { lines, anchors } = state.read(input.file_path, input.offset, input.limit);
      return { content: [{ type: "text", text: formatLines(anchors, lines) }] };
    }
  );

  server.registerTool(
    "edit_anchored",
    {
      description: `Edit a file by anchor reference. Modes: "replace" (overwrite lines from start_anchor through end_anchor inclusive; end_anchor defaults to start_anchor for single-line replace; empty new_content deletes the range), "insert_before" (insert new_content as new lines above start_anchor), "insert_after" (insert below start_anchor). Rejects with ANCHOR_NOT_FOUND if start_anchor or end_anchor is missing in the current map. CRLF input is normalized to LF on write. The reply shows the affected range with refreshed anchors so you can chain follow-up edits without re-reading. For bulk same-string rename, prefer the host's existing replace-all tool or a CLI command (sed/sd, rg --replace); anchored edits pay off for chained surgical edits where line stability matters.`,
      inputSchema: editAnchoredInput.shape,
    },
    async (input: z.infer<typeof editAnchoredInput>) => {
      const { lines, anchors, affectedRange } = state.edit({
        filePath: input.file_path,
        startAnchor: input.start_anchor,
        endAnchor: input.end_anchor,
        newContent: input.new_content,
        mode: input.mode,
      });
      const hint =
        input.new_content.includes("\\n") && !input.new_content.includes("\n")
          ? "\n\nNote: new_content contained literal backslash-n but no real newline characters. It was written to the file verbatim. If you intended a line break, retry with a real newline character (LF, U+000A) in new_content."
          : "";
      const [start, end] = affectedRange;
      if (end < start) {
        return {
          content: [
            { type: "text", text: `Edit applied. Range deleted at line ${start + 1}.${hint}` },
          ],
        };
      }
      const view = formatLines(anchors.slice(start, end + 1), lines.slice(start, end + 1));
      return {
        content: [
          {
            type: "text",
            text: `Edit applied. Updated lines ${start + 1}-${end + 1}:\n${view}${hint}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "write_to_file",
    {
      description:
        "Write full content to a file (creates the file if missing, overwrites if it exists). Prefer edit_anchored for surgical changes; use write_to_file for new files or full rewrites. CRLF input is normalized to LF on write. Returns the rebuilt anchor map (Myers-diffed against any cached state) so unchanged lines keep their anchors without a follow-up read_anchored call.",
      inputSchema: writeFileInput.shape,
    },
    async (input: z.infer<typeof writeFileInput>) => {
      const { lines, anchors } = state.write(input.file_path, input.content);
      return { content: [{ type: "text", text: formatLines(anchors, lines) }] };
    }
  );

  return server;
}
