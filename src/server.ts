import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  EDIT_ANCHORED_DESCRIPTION,
  READ_ANCHORED_DESCRIPTION,
  WRITE_TO_FILE_DESCRIPTION,
} from "./descriptions.js";
import { buildEditResult, buildReadResult, buildWriteResult } from "./format.js";
import {
  editAnchoredInput,
  editAnchoredOutput,
  readAnchoredInput,
  readAnchoredOutput,
  writeFileInput,
  writeFileOutput,
} from "./schemas.js";
import { AnchorEditError, StateManager } from "./state.js";

export function buildServer(state: StateManager = new StateManager()): McpServer {
  const server = new McpServer({ name: "anchor-edit", version: "0.0.1" });

  server.registerTool(
    "read_anchored",
    {
      description: READ_ANCHORED_DESCRIPTION,
      inputSchema: readAnchoredInput.shape,
      outputSchema: readAnchoredOutput.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input: z.infer<typeof readAnchoredInput>) => {
      const result = state.read(input.file_path, input.offset, input.limit);
      const { text, structured } = buildReadResult(result, result.totalLines);
      return {
        content: [{ type: "text", text }],
        structuredContent: structured,
      };
    }
  );

  server.registerTool(
    "edit_anchored",
    {
      description: EDIT_ANCHORED_DESCRIPTION,
      inputSchema: editAnchoredInput.shape,
      outputSchema: editAnchoredOutput.shape,
    },
    async (input: z.infer<typeof editAnchoredInput>) => {
      if (input.end_anchor !== undefined && input.mode !== "replace" && input.mode !== "delete") {
        throw new AnchorEditError(
          "end_anchor is only valid with mode=replace or mode=delete.",
          "INVALID_RANGE"
        );
      }

      const result = state.edit({
        filePath: input.file_path,
        startAnchor: input.start_anchor,
        endAnchor: input.end_anchor,
        newContent: input.new_content,
        mode: input.mode,
      });
      const { text, structured } = buildEditResult(result, input.new_content);
      return {
        content: [{ type: "text", text }],
        structuredContent: structured,
      };
    }
  );

  server.registerTool(
    "write_to_file",
    {
      description: WRITE_TO_FILE_DESCRIPTION,
      inputSchema: writeFileInput.shape,
      outputSchema: writeFileOutput.shape,
    },
    async (input: z.infer<typeof writeFileInput>) => {
      const result = state.write(input.file_path, input.content);
      const { text, structured } = buildWriteResult(result.lines.length, result.addedRanges);
      return {
        content: [{ type: "text", text }],
        structuredContent: structured,
      };
    }
  );

  return server;
}
