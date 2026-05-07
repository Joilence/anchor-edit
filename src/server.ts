import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  EDIT_ANCHORED_DESCRIPTION,
  MCP_ERROR_META_NOTE,
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

export const ERROR_CODE_META_KEY = "anchor-edit.dev/errorCode";

function toErrorResult(err: unknown) {
  if (err instanceof AnchorEditError) {
    return {
      content: [{ type: "text" as const, text: err.message }],
      isError: true as const,
      _meta: { [ERROR_CODE_META_KEY]: err.code },
    };
  }
  throw err;
}

export function buildServer(state: StateManager = new StateManager()): McpServer {
  const server = new McpServer({ name: "anchor-edit", version: "0.0.1" });

  server.registerTool(
    "read_anchored",
    {
      description: READ_ANCHORED_DESCRIPTION + MCP_ERROR_META_NOTE,
      inputSchema: readAnchoredInput.shape,
      outputSchema: readAnchoredOutput.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input: z.infer<typeof readAnchoredInput>) => {
      try {
        const result = state.read(input.file_path, input.offset, input.limit);
        const { text, structured } = buildReadResult(result, result.totalLines);
        return {
          content: [{ type: "text", text }],
          structuredContent: structured,
        };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    "edit_anchored",
    {
      description: EDIT_ANCHORED_DESCRIPTION + MCP_ERROR_META_NOTE,
      inputSchema: editAnchoredInput.shape,
      outputSchema: editAnchoredOutput.shape,
    },
    async (input: z.infer<typeof editAnchoredInput>) => {
      if (input.end_anchor !== undefined && input.mode !== "replace" && input.mode !== "delete") {
        return toErrorResult(
          new AnchorEditError(
            "end_anchor is only valid with mode=replace or mode=delete.",
            "INVALID_RANGE"
          )
        );
      }
      try {
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
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    "write_to_file",
    {
      description: WRITE_TO_FILE_DESCRIPTION + MCP_ERROR_META_NOTE,
      inputSchema: writeFileInput.shape,
      outputSchema: writeFileOutput.shape,
    },
    async (input: z.infer<typeof writeFileInput>) => {
      try {
        const result = state.write(input.file_path, input.content);
        const { text, structured } = buildWriteResult(result.lines.length, result.addedRanges);
        return {
          content: [{ type: "text", text }],
          structuredContent: structured,
        };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  return server;
}
