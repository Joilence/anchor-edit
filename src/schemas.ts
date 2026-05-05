import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  CONTEXT_LINES,
  EDIT_MODE_DESCRIPTION,
  END_ANCHOR_DESCRIPTION,
  NEW_CONTENT_DESCRIPTION,
  START_ANCHOR_DESCRIPTION,
} from "./descriptions.js";
import { EDIT_MODES } from "./state.js";

const absolutePath = z
  .string()
  .refine((p) => isAbsolute(p), { message: "file_path must be an absolute path" });

const lineRange = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([start, end]) => end >= start, {
    message: "affected_lines end must be >= start",
  });

export const readAnchoredInput = z.object({
  file_path: absolutePath.describe("Absolute path to the file."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("0-indexed line offset to start reading from."),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to return."),
});

export const editAnchoredInput = z.object({
  file_path: absolutePath.describe("Absolute path to the file."),
  start_anchor: z.string().describe(START_ANCHOR_DESCRIPTION),
  end_anchor: z.string().optional().describe(END_ANCHOR_DESCRIPTION),
  new_content: z.string().default("").describe(NEW_CONTENT_DESCRIPTION),
  mode: z.enum(EDIT_MODES).default("replace").describe(EDIT_MODE_DESCRIPTION),
});

export const writeFileInput = z.object({
  file_path: absolutePath.describe("Absolute path to the file. Created if it does not exist."),
  content: z
    .string()
    .describe(
      "Full new content for the file. Overwrites any existing content. The response reports total_lines plus newly-allocated anchor runs; unchanged lines keep their prior anchors and are not re-emitted."
    ),
});

export const readAnchoredOutput = z.object({
  total_lines: z
    .number()
    .int()
    .nonnegative()
    .describe("Total line count of the file (independent of offset/limit)."),
  anchored_text: z
    .string()
    .describe(
      'Returned slice as "<anchor>§<content>" lines joined by LF. Split on the first § per line to recover (anchor, content). Empty string if the slice is empty.'
    ),
  notes: z
    .array(z.string())
    .optional()
    .describe("Free-form hints or warnings; omitted when there is nothing to flag."),
});

export const editAnchoredOutput = z.object({
  total_lines: z
    .number()
    .int()
    .nonnegative()
    .describe("Total line count of the file after the edit."),
  affected_lines: lineRange.describe(
    "1-indexed inclusive range. For replace/insert it is the post-edit range now occupied by the new lines. For delete it is the pre-edit range that was removed."
  ),
  diff: z
    .string()
    .describe(
      `Unified-diff-style block with up to ${CONTEXT_LINES} lines of context before and after the affected range. Each entry is "<prefix><anchor>§<content>" where prefix is " " (context/unchanged), "-" (removed), or "+" (added). Context-before and removed lines carry pre-edit anchors; added and context-after lines carry post-edit anchors.`
    ),
  notes: z
    .array(z.string())
    .optional()
    .describe("Free-form hints or warnings; omitted when there is nothing to flag."),
});

export const writeFileOutput = z.object({
  total_lines: z
    .number()
    .int()
    .nonnegative()
    .describe("Total line count of the file after the write."),
  changes: z
    .array(
      z.object({
        start_line: z
          .number()
          .int()
          .positive()
          .describe("1-indexed line number of the first added line in this run."),
        anchors: z
          .array(z.string())
          .describe("Anchors for the contiguous run of newly-allocated lines."),
      })
    )
    .describe(
      "Newly-allocated anchor runs from the Myers-added regions. Lines unchanged vs the cached state retain their prior anchors and are not re-emitted. For first writes to a path the array contains a single run covering all lines."
    ),
  notes: z
    .array(z.string())
    .optional()
    .describe("Free-form hints or warnings; omitted when there is nothing to flag."),
});
