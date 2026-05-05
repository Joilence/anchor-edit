# anchor-edit

Stateful single-token anchored file editing tools for coding agents, bringing[^dirac-post]:

- ~60% less token usage for file editing (from `O(S+R)` to `O(R)`)
- Smaller context, better LLM reasoning

## Usage

The `anchor-edit mcp` subcommand exposes the editor as an MCP server for coding agents like Claude Code.

### Claude Code as MCP

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

### Pi coding agent as extension

`anchor-edit` also ships a native [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension.

```sh
pi install npm:anchor-edit
```

Restart pi, or run `/reload` in an existing pi session. The extension registers:

1. `read_anchored`
2. `edit_anchored`
3. `write_to_file`

Paths may be relative to pi's current working directory or absolute. The extension keeps anchor state in memory for the active pi runtime. After `/reload`, restart, `/new`, `/resume`, or `/fork`, call `read_anchored` again before `edit_anchored`.

For local development from this repository:

```sh
pi -e ./src/pi-extension.ts
```

## Implementation

Reimplements the design from [Dirac](https://github.com/dirac-run/dirac) (anchored edits + Myers-diff reconciler) in TypeScript with AI assistance.

`anchor-edit` is the **stateful single-token** variant:

1. Pool of ~6,744 single-BPE English words from `o200k_base` is the anchor namespace.
2. Per-session in-memory `Map<file_path, FileState>` (lines, anchors, used-pool words) persists across edits.
3. After every edit, a Myers-diff reconciler reassigns anchors only on changed lines, so unchanged lines keep their identity across the session.

For the full mechanism and design rationale, see Dirac's blog post[^dirac-post] and the [`dirac-run/dirac`](https://github.com/dirac-run/dirac) source.

### Allocation

Mirrors Dirac's `AnchorStateManager`. Implementation: [`src/state.ts`](src/state.ts).

1. Each file has its own monotonically growing `usedWords` set. Anchors are pulled from the pool in order on first allocation; deleted lines do **not** return their anchors to the pool.
2. When the pool (6,744 words from `o200k_base`) is exhausted, the allocator falls back to random two-word combinations (`MorelloMagnificent`); on collision, three-word, then four-word.
3. Line splitting is `/\r?\n/` (CRLF tolerated). Anchored edits rewrite logical lines with `\n`; `write_to_file` writes content as supplied.

### Tools

1. `read_anchored`: returns file content with one anchor prefix per line in the format `<anchor>§<content>`.
2. `edit_anchored`: `replace` / `insert_before` / `insert_after` / `delete` by anchor; empty `new_content` with `mode=replace` also deletes the range.
3. `write_to_file`: creates or overwrites a file; returns newly-allocated anchor runs (Myers-added regions). Call `read_anchored` afterwards if you need the full post-write anchor map.

For multi-line `content` and `new_content`, pass real newline characters (LF, U+000A); literal backslash-n is written to the file verbatim.

## When not

Edits made via anchor-edit don't render in Claude Code's native diff UI; tool responses are text-only. Reach for Claude Code's built-in `Edit` tool when visual diffs matter.

Anchor-edit's value is chained surgical edits where line stability matters. Skip it for:

1. **Bulk same-string rename in one file**: prefer the host's existing replace-all tool, or a CLI command (`sed`/`sd`, `rg --replace`). One tool call.
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

## Credits

Original idea comes from [Dirac](https://github.com/dirac-run/dirac) (Apache-2.0).

[^dirac-post]: [Hash Anchors + Myers Diff + Single-Token Anchors](https://dirac.run/posts/hash-anchors-myers-diff-single-token)
