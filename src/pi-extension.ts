import { isAbsolute, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
  EDIT_ANCHORED_DESCRIPTION,
  EDIT_MODE_DESCRIPTION,
  READ_ANCHORED_DESCRIPTION,
  WRITE_TO_FILE_DESCRIPTION,
} from "./descriptions.js";
import { formatEditAppliedText, formatLines } from "./format.js";
import { ANCHOR_SEPARATOR } from "./pool.js";
import { AnchorEditError, StateManager } from "./state.js";

export interface PiToolRegistrar {
  registerTool: ExtensionAPI["registerTool"];
}

const pathInput = Type.String({
  description: "Path to the file. Relative paths resolve from the current pi working directory.",
});

const readAnchoredParams = Type.Object({
  path: pathInput,
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "0-indexed line offset to start reading from." })
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: "Maximum number of lines to return." })
  ),
});

type ReadAnchoredParams = Static<typeof readAnchoredParams>;

const editMode = StringEnum(["replace", "insert_before", "insert_after"] as const, {
  description: EDIT_MODE_DESCRIPTION,
  default: "replace",
});

const editAnchoredParams = Type.Object({
  path: pathInput,
  start_anchor: Type.String({
    description: "Anchor of the first line in the edit range. Required for all modes.",
  }),
  end_anchor: Type.Optional(
    Type.String({
      description:
        "Anchor of the last line in the edit range, inclusive. Used only for replace mode; defaults to start_anchor.",
    })
  ),
  new_content: Type.String({
    description:
      "Replacement content. Use real LF newline characters for line breaks. Empty string with mode=replace deletes the range.",
  }),
  mode: Type.Optional(editMode),
});

type EditAnchoredParams = Static<typeof editAnchoredParams>;

const writeFileParams = Type.Object({
  path: pathInput,
  content: Type.String({
    description:
      "Full new content for the file. Overwrites any existing content and returns the rebuilt anchor map.",
  }),
});

type WriteFileParams = Static<typeof writeFileParams>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyPathAlias(args: unknown): unknown {
  if (!isRecord(args) || typeof args.path === "string" || typeof args.file_path !== "string") {
    return args;
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key !== "file_path") next[key] = value;
  }
  next.path = args.file_path;
  return next;
}

function prepareReadArguments(args: unknown): ReadAnchoredParams {
  return applyPathAlias(args) as ReadAnchoredParams;
}

function prepareEditArguments(args: unknown): EditAnchoredParams {
  return applyPathAlias(args) as EditAnchoredParams;
}

function prepareWriteArguments(args: unknown): WriteFileParams {
  return applyPathAlias(args) as WriteFileParams;
}

function resolveToolPath(path: string, cwd: string): string {
  const normalized = path.startsWith("@") ? path.slice(1) : path;
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

export function registerAnchorEditPiTools(
  pi: PiToolRegistrar,
  state: StateManager = new StateManager()
): void {
  pi.registerTool({
    name: "read_anchored",
    label: "read anchored",
    description: READ_ANCHORED_DESCRIPTION,
    promptSnippet: "Read file content with stable per-line anchor IDs for follow-up anchored edits",
    promptGuidelines: [
      `Use read_anchored before edit_anchored; split returned lines on the first ${ANCHOR_SEPARATOR} to get anchor and content.`,
    ],
    parameters: readAnchoredParams,
    prepareArguments: prepareReadArguments,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = resolveToolPath(params.path, ctx.cwd);
      return withFileMutationQueue(path, async () => {
        const { lines, anchors } = state.read(path, params.offset, params.limit);
        return {
          content: [{ type: "text", text: formatLines(anchors, lines) }],
          details: undefined,
        };
      });
    },
  });

  pi.registerTool({
    name: "edit_anchored",
    label: "edit anchored",
    description: EDIT_ANCHORED_DESCRIPTION,
    promptSnippet: "Edit file lines by stable anchor ID instead of repeating old text",
    promptGuidelines: [
      "Use edit_anchored for surgical changes after read_anchored when replacing an exact oldText block would waste tokens.",
      "Use edit_anchored only with anchors from the latest read_anchored or edit_anchored result for that file.",
    ],
    parameters: editAnchoredParams,
    prepareArguments: prepareEditArguments,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = resolveToolPath(params.path, ctx.cwd);
      return withFileMutationQueue(path, async () => {
        const mode = params.mode ?? "replace";
        if (params.end_anchor !== undefined && mode !== "replace") {
          throw new AnchorEditError("end_anchor is only valid with mode=replace.", "INVALID_RANGE");
        }

        const result = state.edit({
          filePath: path,
          startAnchor: params.start_anchor,
          endAnchor: params.end_anchor,
          newContent: params.new_content,
          mode,
        });
        return {
          content: [{ type: "text", text: formatEditAppliedText(result, params.new_content) }],
          details: undefined,
        };
      });
    },
  });

  pi.registerTool({
    name: "write_to_file",
    label: "write anchored file",
    description: WRITE_TO_FILE_DESCRIPTION,
    promptSnippet: "Create or overwrite a file and return its anchored line map",
    promptGuidelines: [
      "Use write_to_file for new files or complete rewrites; use edit_anchored for surgical changes.",
    ],
    parameters: writeFileParams,
    prepareArguments: prepareWriteArguments,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = resolveToolPath(params.path, ctx.cwd);
      return withFileMutationQueue(path, async () => {
        const { lines, anchors } = state.write(path, params.content);
        return {
          content: [{ type: "text", text: formatLines(anchors, lines) }],
          details: undefined,
        };
      });
    },
  });
}

export default function anchorEditPiExtension(pi: ExtensionAPI): void {
  registerAnchorEditPiTools(pi);
}
