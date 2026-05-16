import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  type Theme,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { diffWords } from "diff";
import { type Static, Type } from "typebox";
import {
  EDIT_ANCHORED_DESCRIPTION,
  EDIT_MODE_DESCRIPTION,
  END_ANCHOR_DESCRIPTION,
  NEW_CONTENT_DESCRIPTION,
  READ_ANCHORED_DESCRIPTION,
  START_ANCHOR_DESCRIPTION,
  WRITE_TO_FILE_DESCRIPTION,
} from "./descriptions.js";
import {
  anchorColumnWidth,
  buildEditDisplayEntries,
  buildEditResult,
  buildReadDisplay,
  buildReadResult,
  buildWriteResult,
  type DisplayEntry,
  type DisplayLine,
  displayAnchoredChrome,
  displayAnchoredLine,
  displayEllipsis,
  type EditStructured,
  type ReadStructured,
  type WriteStructured,
} from "./format.js";
import { ANCHOR_SEPARATOR } from "./pool.js";
import { AnchorEditError, EDIT_MODES, StateManager } from "./state.js";

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

const editMode = StringEnum(EDIT_MODES, {
  description: EDIT_MODE_DESCRIPTION,
  default: "replace",
});

const editAnchoredParams = Type.Object({
  path: pathInput,
  start_anchor: Type.String({ description: START_ANCHOR_DESCRIPTION }),
  end_anchor: Type.Optional(Type.String({ description: END_ANCHOR_DESCRIPTION })),
  new_content: Type.String({ description: NEW_CONTENT_DESCRIPTION, default: "" }),
  mode: Type.Optional(editMode),
});

type EditAnchoredParams = Static<typeof editAnchoredParams>;

const writeFileParams = Type.Object({
  path: pathInput,
  content: Type.String({
    description:
      "Full new content for the file. Overwrites any existing content. The response reports total_lines plus newly-allocated anchor runs; unchanged lines keep their prior anchors and are not re-emitted.",
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

interface ReadPiDetails extends ReadStructured {
  display_text: string;
}

interface EditPiDetails extends EditStructured {
  displayEntries: readonly DisplayEntry[];
  displayLineWidth: number;
}

function textResult(text: string): { type: "text"; text: string }[] {
  return [{ type: "text", text }];
}

function firstText(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

function shortenPath(path: string): string {
  const home = homedir();
  if (!home || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) return `~${rest}`;
  return path;
}

// 3-space tabs match pi's convention.
function normalizeForDisplay(text: string): string {
  return text.replace(/\t/g, "   ").replace(/\r/g, "");
}

function renderToolCall(toolName: string, path: string, theme: Theme): Text {
  return new Text(
    theme.fg("toolTitle", theme.bold(`${toolName} `)) + theme.fg("muted", shortenPath(path)),
    0,
    0
  );
}

function renderIntraLineDiff(
  oldText: string,
  newText: string,
  theme: Theme
): { removedSuffix: string; addedSuffix: string } {
  const parts = diffWords(oldText, newText);
  let removedSuffix = "";
  let addedSuffix = "";
  // Leading whitespace on the first removed/added part is indent that the user
  // did not change; render it plain so the inverse highlight covers only the
  // word that actually differs.
  let isFirstRemoved = true;
  let isFirstAdded = true;
  for (const part of parts) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const lead = value.match(/^\s*/)?.[0] ?? "";
        value = value.slice(lead.length);
        removedSuffix += lead;
        isFirstRemoved = false;
      }
      if (value) removedSuffix += theme.inverse(value);
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const lead = value.match(/^\s*/)?.[0] ?? "";
        value = value.slice(lead.length);
        addedSuffix += lead;
        isFirstAdded = false;
      }
      if (value) addedSuffix += theme.inverse(value);
    } else {
      removedSuffix += part.value;
      addedSuffix += part.value;
    }
  }
  return { removedSuffix, addedSuffix };
}

function renderLine(line: DisplayLine, lineWidth: number, anchorWidth: number): string {
  return normalizeForDisplay(displayAnchoredLine(line, lineWidth, anchorWidth));
}

function renderDiffEntries(
  entries: readonly DisplayEntry[],
  lineWidth: number,
  theme: Theme
): Text {
  const anchorWidth = anchorColumnWidth(entries);
  const out: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (entry.kind === "ellipsis") {
      out.push(theme.fg("toolDiffContext", displayEllipsis(lineWidth, anchorWidth)));
      i++;
      continue;
    }
    const prefix = entry.line.prefix;
    if (prefix === "-") {
      const removed: DisplayLine[] = [];
      while (i < entries.length) {
        const e = entries[i];
        if (e.kind !== "line" || e.line.prefix !== "-") break;
        removed.push(e.line);
        i++;
      }
      const added: DisplayLine[] = [];
      while (i < entries.length) {
        const e = entries[i];
        if (e.kind !== "line" || e.line.prefix !== "+") break;
        added.push(e.line);
        i++;
      }
      if (removed.length === 1 && added.length === 1) {
        const removedChrome = displayAnchoredChrome(removed[0], lineWidth, anchorWidth);
        const addedChrome = displayAnchoredChrome(added[0], lineWidth, anchorWidth);
        const { removedSuffix, addedSuffix } = renderIntraLineDiff(
          normalizeForDisplay(removed[0].line),
          normalizeForDisplay(added[0].line),
          theme
        );
        out.push(theme.fg("toolDiffRemoved", removedChrome + removedSuffix));
        out.push(theme.fg("toolDiffAdded", addedChrome + addedSuffix));
      } else {
        for (const r of removed) {
          out.push(theme.fg("toolDiffRemoved", renderLine(r, lineWidth, anchorWidth)));
        }
        for (const a of added) {
          out.push(theme.fg("toolDiffAdded", renderLine(a, lineWidth, anchorWidth)));
        }
      }
    } else if (prefix === "+") {
      out.push(theme.fg("toolDiffAdded", renderLine(entry.line, lineWidth, anchorWidth)));
      i++;
    } else {
      out.push(theme.fg("toolDiffContext", renderLine(entry.line, lineWidth, anchorWidth)));
      i++;
    }
  }
  return new Text(out.join("\n"), 0, 0);
}

export function registerAnchorEditPiTools(
  pi: PiToolRegistrar,
  state: StateManager = new StateManager()
): void {
  pi.registerTool<typeof readAnchoredParams, ReadPiDetails>({
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
        const result = state.read(path, params.offset, params.limit);
        const { text, structured } = buildReadResult(result, result.totalLines);
        return {
          content: textResult(text),
          details: {
            ...structured,
            display_text: buildReadDisplay(result, params.offset ?? 0),
          },
        };
      });
    },
    renderCall(args, theme) {
      return renderToolCall("read_anchored", args.path, theme);
    },
    renderResult(result) {
      return new Text(normalizeForDisplay(result.details?.display_text ?? firstText(result)), 0, 0);
    },
  });

  pi.registerTool<typeof editAnchoredParams, EditPiDetails>({
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
        if (params.end_anchor !== undefined && mode !== "replace" && mode !== "delete") {
          throw new AnchorEditError(
            "end_anchor is only valid with mode=replace or mode=delete.",
            "INVALID_RANGE"
          );
        }

        const result = state.edit({
          filePath: path,
          startAnchor: params.start_anchor,
          endAnchor: params.end_anchor,
          newContent: params.new_content ?? "",
          mode,
        });
        const { text, structured } = buildEditResult(result, params.new_content ?? "");
        const { entries, lineWidth } = buildEditDisplayEntries(result);
        return {
          content: textResult(text),
          details: {
            ...structured,
            displayEntries: entries,
            displayLineWidth: lineWidth,
          },
        };
      });
    },
    renderCall(args, theme) {
      return renderToolCall("edit_anchored", args.path, theme);
    },
    renderResult(result, _options, theme) {
      const entries = result.details?.displayEntries;
      const lineWidth = result.details?.displayLineWidth;
      return entries && lineWidth !== undefined
        ? renderDiffEntries(entries, lineWidth, theme)
        : new Text(firstText(result), 0, 0);
    },
  });

  pi.registerTool<typeof writeFileParams, WriteStructured>({
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
        const result = state.write(path, params.content);
        const { text, structured } = buildWriteResult(result.lines.length, result.addedRanges);
        return {
          content: textResult(text),
          details: structured,
        };
      });
    },
    renderCall(args, theme) {
      return renderToolCall("write_to_file", args.path, theme);
    },
    renderResult(result) {
      return new Text(normalizeForDisplay(firstText(result)), 0, 0);
    },
  });
}

export default function anchorEditPiExtension(pi: ExtensionAPI): void {
  registerAnchorEditPiTools(pi);
}
