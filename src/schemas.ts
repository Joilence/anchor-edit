import { isAbsolute } from "node:path";
import { z } from "zod";

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
  start_anchor: z
    .string()
    .describe("Anchor of the first line in the edit range. Required for all modes."),
  end_anchor: z
    .string()
    .optional()
    .describe(
      "Anchor of the last line in the edit range (inclusive). Used only for replace mode; defaults to start_anchor for single-line replace."
    ),
  new_content: z
    .string()
    .describe(
      "Replacement content. Use a real newline character (LF, U+000A) for line breaks; do not type a backslash followed by the letter n, which would be written literally to the file. Empty string with mode=replace deletes the range."
    ),
  mode: z
    .enum(["replace", "insert_before", "insert_after"])
    .default("replace")
    .describe(
      "replace: overwrite lines from start_anchor through end_anchor (empty new_content deletes); insert_before: insert new_content above start_anchor's line; insert_after: insert below start_anchor's line."
    ),
});

export const writeFileInput = z.object({
  file_path: absolutePath.describe("Absolute path to the file. Created if it does not exist."),
  content: z
    .string()
    .describe(
      "Full new content for the file. Overwrites any existing content. The response includes the rebuilt anchor map (Myers-diffed against any cached lines)."
    ),
});
