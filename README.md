# anchor-edit

Stateful single-token anchored file editing tools for coding agents. Clean port of [Dirac](https://github.com/dirac-run/dirac)'s edit primitive (anchored edits + Myers-diff reconciler).

## Usage

The `anchor-edit mcp` subcommand exposes the editor as an MCP server for coding agents like Claude Code. For example, with Claude Code:

- CLI: `claude mcp add anchor-edit --scope user -- npx -y anchor-edit mcp`

- Example `.mcp.json`:

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

- Verify: `claude mcp list`

## Why

Claude Code's built-in `Edit` tool costs `O(S+R)` output tokens because the model echoes the entire `old_string` search block plus the `new_string` replacement. Anchored edits collapse the search block to a single opaque token per addressed line, so cost drops to `O(R)` plus a small constant.

## Implementation

`anchor-edit` is the **stateful single-token** variant:

1. Pool of ~6,744 single-BPE English words from `o200k_base` is the anchor namespace.
2. Per-session in-memory `Map<file_path, FileState>` (lines, anchors, used-pool words) persists across edits.
3. After every edit, a Myers-diff reconciler reassigns anchors only on changed lines, so unchanged lines keep their identity across the session.

For the full mechanism and design rationale, see Dirac's blog post [Hash Anchors + Myers Diff + Single-Token Anchors](https://dirac.run/posts/hash-anchors-myers-diff-single-token) and the [`dirac-run/dirac`](https://github.com/dirac-run/dirac) source.

### Allocation

Mirrors Dirac's `AnchorStateManager`. Implementation: [`src/state.ts`](src/state.ts).

1. Each file has its own monotonically growing `usedWords` set. Anchors are pulled from the pool in order on first allocation; deleted lines do **not** return their anchors to the pool.
2. When the pool (6,744 words from `o200k_base`) is exhausted, the allocator falls back to random two-word combinations (`MorelloMagnificent`); on collision, three-word, then four-word.
3. Line splitting is `/\r?\n/` (CRLF tolerated); writes always emit `\n`.

### Tools

1. `read_anchored`: returns file content with one anchor prefix per line in the format `<anchor>§<content>`.
2. `edit_anchored`: replace / insert_before / insert_after by anchor; empty `new_content` with `replace` deletes the range.
3. `write_to_file`: creates or overwrites a file; returns the rebuilt anchor map.

For multi-line `content` and `new_content`, pass real newline characters (LF, U+000A); literal backslash-n is written to the file verbatim.

## When not

Edits made via anchor-edit don't render in Claude Code's native diff UI; tool responses are text-only. Reach for Claude Code's built-in `Edit` tool when visual diffs matter.

Anchor-edit's value is chained surgical edits where line stability matters. Skip it for:

1. **Bulk same-string rename in one file**: prefer the host's existing replace-all tool, or a CLI command (`sed`/`sd`, `rg --replace`). Same `O(S+R)` cost, one call.
2. **Same-string rename across many files**: prefer a CLI command (`sd`, `rg --replace`) or a one-shot script. One tool call total.

## Development

```sh
# Install dependencies
pnpm install

# Build the bin and types
pnpm run build:pool # one-time pool generation
pnpm run build

# Run tests
pnpm test           # bun test, all suites
pnpm run typecheck
pnpm run lint
```
