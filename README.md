# anchor-edit

Stateful single-token anchored file editing for coding agents. Faithful port of [Dirac](https://github.com/dirac-run/dirac)'s edit primitive (anchored edits + Myers-diff reconciler).

The `anchor-edit mcp` subcommand exposes the editor as an MCP server for Claude Code. The bin is structured as a subcommand router so additional commands can be added later without restructuring.

Original mechanism and design rationale: Dirac's blog post [Hash Anchors + Myers Diff + Single-Token Anchors](https://dirac.run/posts/hash-anchors-myers-diff-single-token) and the [`dirac-run/dirac`](https://github.com/dirac-run/dirac) source.

## Caveat

Agents using anchor-edit lose native diff UI. Diff rendering is text-only in agent responses. For full visual feedback (side-by-side diffs, inline preview), use anchor-edit directly in Claude Code or similar coding environments.

## Why

Claude Code's built-in `Edit` tool costs `O(S+R)` output tokens because the model echoes the entire `old_string` search block plus the `new_string` replacement. Anchored edits collapse the search block to a single opaque token per addressed line, so cost drops to `O(R)` plus a small constant.

`anchor-edit` is the **stateful single-token** variant:

1. Pool of ~6,744 single-BPE English words from `o200k_base` is the anchor namespace.
2. Per-session in-memory `Map<file_path, FileState>` (lines, anchors, used-pool words) persists across edits.
3. After every edit, a Myers-diff reconciler reassigns anchors only on changed lines, so unchanged lines keep their identity across the session.

## When not to use

Anchor-edit's value is chained surgical edits where line stability matters. Skip it for:

1. **Bulk same-string rename in one file**: prefer the host's existing replace-all tool, or a CLI command (`sed`/`sd`, `rg --replace`). Same `O(S+R)` cost, one call.
2. **Same-string rename across many files**: prefer a CLI command (`sd`, `rg --replace`) or a one-shot script. One tool call total.
3. **Symbol-level edits** ("replace this function body"): use [serena](https://github.com/oraios/serena).

## MCP tools

The `mcp` subcommand exposes:

1. `read_anchored`: returns file content with one anchor prefix per line.
2. `edit_anchored`: replace / insert_before / insert_after by anchor; empty `new_content` with `replace` deletes the range.
3. `write_to_file`: creates or overwrites a file; returns the rebuilt anchor map.

## Anchor allocation behavior

Mirrors Dirac's `AnchorStateManager`. Implementation: [`src/state.ts`](src/state.ts).

1. Each file has its own monotonically growing `usedWords` set. Anchors are pulled from the pool in order on first allocation; deleted lines do **not** return their anchors to the pool.
2. When the pool (6,744 words from `o200k_base`) is exhausted, the allocator falls back to random two-word combinations (`MorelloMagnificent`); on collision, three-word, then four-word.
3. Line splitting is `/\r?\n/` (CRLF tolerated); writes always emit `\n`.

## Register with Claude Code

CLI:

```sh
claude mcp add anchor-edit --scope user -- npx -y anchor-edit mcp
```

Or commit a project-scoped `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "anchor-edit": {
      "command": "npx",
      "args": ["-y", "anchor-edit", "mcp"]
    }
  }
}
```

Verify:

```sh
claude mcp list
# anchor-edit: npx -y anchor-edit mcp - Connected
```

## Develop locally

```sh
pnpm install
pnpm run build:pool   # one-time pool generation
pnpm run build
pnpm test
```
