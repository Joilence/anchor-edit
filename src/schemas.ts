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
      "Full new content for the file. Overwrites any existing content. The response includes the rebuilt anchor map (Myers-diffed against any cached lines)."
    ),
});
