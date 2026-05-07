import { ANCHOR_SEPARATOR, POOL } from "./pool.js";

export const CONTEXT_LINES = 3;

export const READ_ANCHORED_DESCRIPTION = `Read a file with one anchor prefix per line in the format "<anchor>${ANCHOR_SEPARATOR}<content>". When parsing a returned line, split on the first ${ANCHOR_SEPARATOR} character; later ${ANCHOR_SEPARATOR} characters belong to file content. Anchors are opaque IDs drawn from a session-scoped pool of ${POOL.length} single-BPE-token capitalized English words; once the pool is exhausted, the allocator falls back to multi-word concatenations (e.g. "MorelloMagnificent"), which are no longer single-token but remain unique. Anchors are stable across edits unless the line itself changes (Myers-diff reconciler reassigns only changed lines). Use the anchor in subsequent edit_anchored calls instead of repeating line content. Returns empty content if offset is at or beyond the file's line count.`;

export const EDIT_ANCHORED_DESCRIPTION = `Edit a file by anchor reference. Modes: "replace" (overwrite lines from start_anchor through end_anchor inclusive; end_anchor defaults to start_anchor for single-line replace), "insert_before" (insert new_content as new lines above start_anchor), "insert_after" (insert below start_anchor), "delete" (remove lines from start_anchor through end_anchor inclusive; new_content is ignored). end_anchor is only valid with mode=replace or mode=delete; passing it with insert_before/insert_after raises INVALID_RANGE. To delete via replace, pass mode=replace with empty new_content. Rejects with ANCHOR_NOT_FOUND if start_anchor or end_anchor is missing in the current map. CRLF input is normalized to LF on write. The reply shows the affected range with refreshed anchors so you can chain follow-up edits without re-reading. For bulk same-string substitution within a file, prefer a CLI tool (sd 'pattern' 'replacement' file, rg --replace 'replacement' 'pattern' file, sg run --rewrite ...) or the host's replace-all primitive; anchored edits pay off for chained surgical edits where line stability matters.`;

export const WRITE_TO_FILE_DESCRIPTION =
  "Write full content to a file (creates the file if missing, overwrites if it exists). Prefer edit_anchored for surgical changes; use write_to_file for new files or full rewrites. Content is written as supplied; subsequent reads tolerate CRLF. The structured response reports total_lines plus newly-allocated anchor runs (Myers-added regions only); unchanged lines retain their prior anchors so they are not re-emitted. On first write to a path the changes array contains a single run covering all written lines. Call read_anchored if you need the full post-write anchor map.";

export const EDIT_MODE_DESCRIPTION =
  "replace: overwrite lines from start_anchor through end_anchor inclusive, or delete the range by passing empty new_content; insert_before: insert new_content above start_anchor's line; insert_after: insert below start_anchor's line; delete: remove lines from start_anchor through end_anchor inclusive (new_content is ignored).";

export const END_ANCHOR_DESCRIPTION =
  "Anchor of the last line in the edit range (inclusive). Used with mode=replace and mode=delete; defaults to start_anchor when omitted (single-line replace or single-line delete). Rejected with mode=insert_before or mode=insert_after.";

export const NEW_CONTENT_DESCRIPTION =
  "Replacement or insertion content. Use a real newline character (LF, U+000A) for line breaks; do not type a backslash followed by the letter n, which would be written literally to the file. Defaults to empty string. With mode=replace, an empty value deletes the range. Ignored when mode=delete.";

export const START_ANCHOR_DESCRIPTION =
  "Anchor of the first line in the edit range. Required for all modes.";

export const MCP_ERROR_META_NOTE =
  ' On a domain failure, the MCP response sets isError=true and _meta["anchor-edit.dev/errorCode"] to a value from the AnchorEditCode union exported by this package. Clients should treat unknown codes as the generic class. Other failures (filesystem, OS, programmer errors) surface as isError=true without _meta; read content[0].text for the underlying message.';
