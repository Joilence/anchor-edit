import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  EDIT_ANCHORED_DESCRIPTION,
  READ_ANCHORED_DESCRIPTION,
  WRITE_TO_FILE_DESCRIPTION,
} from "./descriptions.js";
import { formatEditAppliedText, formatLines } from "./format.js";
import { editAnchoredInput, readAnchoredInput, writeFileInput } from "./schemas.js";
import { AnchorEditError, StateManager } from "./state.js";

export function buildServer(state: StateManager = new StateManager()): McpServer {
  const server = new McpServer({ name: "anchor-edit", version: "0.0.1" });

  server.registerTool(
    "read_anchored",
    {
      description: READ_ANCHORED_DESCRIPTION,
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
      description: EDIT_ANCHORED_DESCRIPTION,
      inputSchema: editAnchoredInput.shape,
    },
    async (input: z.infer<typeof editAnchoredInput>) => {
      if (input.end_anchor !== undefined && input.mode !== "replace") {
        throw new AnchorEditError("end_anchor is only valid with mode=replace.", "INVALID_RANGE");
      }

      const result = state.edit({
        filePath: input.file_path,
        startAnchor: input.start_anchor,
        endAnchor: input.end_anchor,
        newContent: input.new_content,
        mode: input.mode,
      });
      return {
        content: [{ type: "text", text: formatEditAppliedText(result, input.new_content) }],
      };
    }
  );

  server.registerTool(
    "write_to_file",
    {
      description: WRITE_TO_FILE_DESCRIPTION,
      inputSchema: writeFileInput.shape,
    },
    async (input: z.infer<typeof writeFileInput>) => {
      const { lines, anchors } = state.write(input.file_path, input.content);
      return { content: [{ type: "text", text: formatLines(anchors, lines) }] };
    }
  );

  return server;
}
