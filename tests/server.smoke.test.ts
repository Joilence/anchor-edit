import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ANCHOR_SEPARATOR } from "../src/pool.js";
import { editAnchoredOutput, readAnchoredOutput, writeFileOutput } from "../src/schemas.js";
import { buildServer } from "../src/server.js";

interface TextContent {
  type: string;
  text: string;
}

interface ToolResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function setupClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function asToolResult(value: unknown): ToolResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("content" in value) ||
    !Array.isArray((value as { content: unknown }).content)
  ) {
    throw new Error(`expected tool result, got ${JSON.stringify(value)}`);
  }
  return value as ToolResult;
}

function anchorAt(text: string, idx: number): string {
  const line = text.split("\n")[idx] ?? "";
  return line.split(ANCHOR_SEPARATOR)[0] ?? "";
}

describe("MCP server smoke", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anchor-edit-smoke-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("tools/list returns the three anchor tools", async () => {
    const { client, close } = await setupClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["edit_anchored", "read_anchored", "write_to_file"]);
    } finally {
      await close();
    }
  });

  test("read_anchored returns formatted output with anchor separator", async () => {
    const path = join(dir, "a.txt");
    writeFileSync(path, "alpha\nbeta", "utf8");
    const { client, close } = await setupClient();
    try {
      const result = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      expect(text).toContain(ANCHOR_SEPARATOR);
      expect(text.split("\n")).toHaveLength(2);
    } finally {
      await close();
    }
  });

  test("AnchorEditError surfaces as isError tool result", async () => {
    const { client, close } = await setupClient();
    try {
      const result = asToolResult(
        await client.callTool({
          name: "read_anchored",
          arguments: { file_path: join(dir, "missing.txt") },
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("File not found");
    } finally {
      await close();
    }
  });

  test("write_to_file then read_anchored round-trips", async () => {
    const path = join(dir, "new.txt");
    const { client, close } = await setupClient();
    try {
      const written = asToolResult(
        await client.callTool({
          name: "write_to_file",
          arguments: { file_path: path, content: "first\nsecond\nthird" },
        })
      );
      expect(written.isError).toBeFalsy();
      expect(readFileSync(path, "utf8")).toBe("first\nsecond\nthird");
      expect(written.content[0]?.text).toContain("Wrote 3 lines");
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const lines = (read.content[0]?.text ?? "").split("\n");
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line).toContain(ANCHOR_SEPARATOR);
      }
    } finally {
      await close();
    }
  });

  test("relative file_path is rejected by schema", async () => {
    const { client, close } = await setupClient();
    try {
      const result = await client.callTool({
        name: "read_anchored",
        arguments: { file_path: "relative.txt" },
      });
      const tool = asToolResult(result);
      expect(tool.isError).toBeTruthy();
    } finally {
      await close();
    }
  });
  test("edit_anchored rejects end_anchor outside replace mode", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const lines = (read.content[0]?.text ?? "").split("\n");
      const betaAnchor = (lines[1] ?? "").split(ANCHOR_SEPARATOR)[0] ?? "";
      const gammaAnchor = (lines[2] ?? "").split(ANCHOR_SEPARATOR)[0] ?? "";
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            end_anchor: gammaAnchor,
            new_content: "before",
            mode: "insert_before",
          },
        })
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("end_anchor is only valid with mode=replace");
      expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\ngamma");
    } finally {
      await close();
    }
  });

  test("edit_anchored hints when new_content has literal backslash-n but no real newline", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const betaLine = (read.content[0]?.text ?? "").split("\n")[1] ?? "";
      const betaAnchor = betaLine.split(ANCHOR_SEPARATOR)[0] ?? "";
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            new_content: "line one\\nline two",
            mode: "replace",
          },
        })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("literal backslash-n");
      expect(readFileSync(path, "utf8")).toBe("alpha\nline one\\nline two\ngamma");
    } finally {
      await close();
    }
  });

  test("edit_anchored stays silent when new_content has real newlines", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const betaLine = (read.content[0]?.text ?? "").split("\n")[1] ?? "";
      const betaAnchor = betaLine.split(ANCHOR_SEPARATOR)[0] ?? "";
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            new_content: "line one\nline two",
            mode: "replace",
          },
        })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).not.toContain("literal backslash-n");
    } finally {
      await close();
    }
  });

  test("edit_anchored stays silent when new_content mixes literal backslash-n with real newlines", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const betaLine = (read.content[0]?.text ?? "").split("\n")[1] ?? "";
      const betaAnchor = betaLine.split(ANCHOR_SEPARATOR)[0] ?? "";
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            new_content: 'x = "a\\nb"\nprint(x)',
            mode: "replace",
          },
        })
      );
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).not.toContain("literal backslash-n");
    } finally {
      await close();
    }
  });

  test("edit_anchored mode=delete removes a range via end_anchor", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma\ndelta", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const lines = (read.content[0]?.text ?? "").split("\n");
      const betaAnchor = (lines[1] ?? "").split(ANCHOR_SEPARATOR)[0] ?? "";
      const gammaAnchor = (lines[2] ?? "").split(ANCHOR_SEPARATOR)[0] ?? "";
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            end_anchor: gammaAnchor,
            mode: "delete",
          },
        })
      );
      expect(result.isError).toBeFalsy();
      expect(readFileSync(path, "utf8")).toBe("alpha\ndelta");
    } finally {
      await close();
    }
  });

  test("read_anchored returns structuredContent with total_lines and anchored_text", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const result = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.total_lines).toBe(3);
      const anchored = result.structuredContent?.anchored_text;
      expect(typeof anchored).toBe("string");
      expect((anchored as string).split("\n")).toHaveLength(3);
    } finally {
      await close();
    }
  });

  test("edit_anchored returns structuredContent with affected_lines and unified diff", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const betaAnchor =
        ((read.content[0]?.text ?? "").split("\n")[1] ?? "").split(ANCHOR_SEPARATOR)[0] ?? "";
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            new_content: "B1\nB2",
            mode: "replace",
          },
        })
      );
      expect(result.structuredContent?.total_lines).toBe(4);
      expect(result.structuredContent?.affected_lines).toEqual([2, 3]);
      const diff = result.structuredContent?.diff as string;
      const diffLines = diff.split("\n");
      expect(diffLines.some((l) => l.startsWith(" ") && l.includes("alpha"))).toBe(true);
      expect(diffLines.some((l) => l.startsWith("-") && l.includes("beta"))).toBe(true);
      expect(diffLines.some((l) => l.startsWith("+") && l.includes("B1"))).toBe(true);
      expect(diffLines.some((l) => l.startsWith("+") && l.includes("B2"))).toBe(true);
      expect(diffLines.some((l) => l.startsWith(" ") && l.includes("gamma"))).toBe(true);
    } finally {
      await close();
    }
  });

  test("edit_anchored delete returns diff with - lines and pre-edit affected_lines", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma\ndelta", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const lines = (read.content[0]?.text ?? "").split("\n");
      const betaAnchor = (lines[1] ?? "").split(ANCHOR_SEPARATOR)[0] ?? "";
      const gammaAnchor = (lines[2] ?? "").split(ANCHOR_SEPARATOR)[0] ?? "";
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            end_anchor: gammaAnchor,
            mode: "delete",
          },
        })
      );
      expect(result.structuredContent?.affected_lines).toEqual([2, 3]);
      const diff = result.structuredContent?.diff as string;
      const diffLines = diff.split("\n");
      expect(diffLines.some((l) => l.startsWith(" ") && l.includes("alpha"))).toBe(true);
      expect(diffLines.some((l) => l.startsWith("-") && l.includes("beta"))).toBe(true);
      expect(diffLines.some((l) => l.startsWith("-") && l.includes("gamma"))).toBe(true);
      expect(diffLines.some((l) => l.startsWith(" ") && l.includes("delta"))).toBe(true);
      expect(diffLines.every((l) => !l.startsWith("+"))).toBe(true);
      expect(result.structuredContent?.total_lines).toBe(2);
    } finally {
      await close();
    }
  });

  test("write_to_file returns structuredContent with one run for first write", async () => {
    const path = join(dir, "fresh.txt");
    const { client, close } = await setupClient();
    try {
      const result = asToolResult(
        await client.callTool({
          name: "write_to_file",
          arguments: { file_path: path, content: "one\ntwo\nthree" },
        })
      );
      expect(result.structuredContent?.total_lines).toBe(3);
      const changes = result.structuredContent?.changes as Array<{
        start_line: number;
        anchors: string[];
      }>;
      expect(changes).toHaveLength(1);
      expect(changes[0]?.start_line).toBe(1);
      expect(changes[0]?.anchors).toHaveLength(3);
    } finally {
      await close();
    }
  });

  test("write_to_file emits only Myers-added runs on incremental rewrite", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma\ndelta", "utf8");
    const { client, close } = await setupClient();
    try {
      await client.callTool({ name: "read_anchored", arguments: { file_path: path } });
      const result = asToolResult(
        await client.callTool({
          name: "write_to_file",
          arguments: { file_path: path, content: "alpha\nBETA\ngamma\ndelta" },
        })
      );
      const changes = result.structuredContent?.changes as Array<{
        start_line: number;
        anchors: string[];
      }>;
      expect(changes).toHaveLength(1);
      expect(changes[0]?.start_line).toBe(2);
      expect(changes[0]?.anchors).toHaveLength(1);
    } finally {
      await close();
    }
  });

  test("edit_anchored insert_before emits diff with + lines and no - lines", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const betaAnchor = anchorAt(read.content[0]?.text ?? "", 1);
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            new_content: "INSERTED",
            mode: "insert_before",
          },
        })
      );
      expect(result.isError).toBeFalsy();
      const diff = (result.structuredContent?.diff as string).split("\n");
      expect(diff.some((l) => l.startsWith("+") && l.includes("INSERTED"))).toBe(true);
      expect(diff.every((l) => !l.startsWith("-"))).toBe(true);
      expect(diff.some((l) => l.startsWith(" ") && l.includes("alpha"))).toBe(true);
      expect(diff.some((l) => l.startsWith(" ") && l.includes("beta"))).toBe(true);
    } finally {
      await close();
    }
  });

  test("edit_anchored insert_after emits diff with + lines and no - lines", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const betaAnchor = anchorAt(read.content[0]?.text ?? "", 1);
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            new_content: "INSERTED",
            mode: "insert_after",
          },
        })
      );
      expect(result.isError).toBeFalsy();
      const diff = (result.structuredContent?.diff as string).split("\n");
      expect(diff.some((l) => l.startsWith("+") && l.includes("INSERTED"))).toBe(true);
      expect(diff.every((l) => !l.startsWith("-"))).toBe(true);
      expect(diff.some((l) => l.startsWith(" ") && l.includes("beta"))).toBe(true);
      expect(diff.some((l) => l.startsWith(" ") && l.includes("gamma"))).toBe(true);
    } finally {
      await close();
    }
  });

  test("edit_anchored at file start has no before-context", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const alphaAnchor = anchorAt(read.content[0]?.text ?? "", 0);
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: alphaAnchor,
            new_content: "ALPHA",
            mode: "replace",
          },
        })
      );
      const diff = (result.structuredContent?.diff as string).split("\n");
      expect(diff[0]?.startsWith(" ")).toBe(false);
      expect(diff.some((l) => l.startsWith("-") && l.includes("alpha"))).toBe(true);
      expect(diff.some((l) => l.startsWith("+") && l.includes("ALPHA"))).toBe(true);
      expect(diff.some((l) => l.startsWith(" ") && l.includes("beta"))).toBe(true);
    } finally {
      await close();
    }
  });

  test("edit_anchored at file end has no after-context", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const gammaAnchor = anchorAt(read.content[0]?.text ?? "", 2);
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: gammaAnchor,
            new_content: "GAMMA",
            mode: "replace",
          },
        })
      );
      const diff = (result.structuredContent?.diff as string).split("\n");
      expect(diff.at(-1)?.startsWith(" ")).toBe(false);
      expect(diff.some((l) => l.startsWith("-") && l.includes("gamma"))).toBe(true);
      expect(diff.some((l) => l.startsWith("+") && l.includes("GAMMA"))).toBe(true);
    } finally {
      await close();
    }
  });

  test("edit_anchored on single-line file has no before/after context", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "only", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const onlyAnchor = anchorAt(read.content[0]?.text ?? "", 0);
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: onlyAnchor,
            new_content: "ONLY",
            mode: "replace",
          },
        })
      );
      const diff = (result.structuredContent?.diff as string).split("\n");
      expect(diff.every((l) => !l.startsWith(" "))).toBe(true);
      expect(diff.some((l) => l.startsWith("-") && l.includes("only"))).toBe(true);
      expect(diff.some((l) => l.startsWith("+") && l.includes("ONLY"))).toBe(true);
    } finally {
      await close();
    }
  });

  test("legacy delete via mode=replace with empty new_content emits delete-shaped diff", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const betaAnchor = anchorAt(read.content[0]?.text ?? "", 1);
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            new_content: "",
            mode: "replace",
          },
        })
      );
      expect(result.content[0]?.text).toContain("Lines 2-2 deleted.");
      const diff = (result.structuredContent?.diff as string).split("\n");
      expect(diff.every((l) => !l.startsWith("+"))).toBe(true);
      expect(diff.some((l) => l.startsWith("-") && l.includes("beta"))).toBe(true);
    } finally {
      await close();
    }
  });

  test("mode=delete without end_anchor removes only the start anchor line", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const betaAnchor = anchorAt(read.content[0]?.text ?? "", 1);
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: { file_path: path, start_anchor: betaAnchor, mode: "delete" },
        })
      );
      expect(result.isError).toBeFalsy();
      expect(readFileSync(path, "utf8")).toBe("alpha\ngamma");
      expect(result.structuredContent?.affected_lines).toEqual([2, 2]);
    } finally {
      await close();
    }
  });

  test("mode=delete with non-empty new_content surfaces a notes warning", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta\ngamma", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      const betaAnchor = anchorAt(read.content[0]?.text ?? "", 1);
      const result = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            new_content: "ignored",
            mode: "delete",
          },
        })
      );
      const notes = result.structuredContent?.notes as string[] | undefined;
      expect(notes).toBeDefined();
      expect(notes?.some((n) => n.includes("ignored because mode=delete"))).toBe(true);
    } finally {
      await close();
    }
  });

  test("structuredContent conforms to declared outputSchema", async () => {
    const path = join(dir, "x.py");
    writeFileSync(path, "alpha\nbeta", "utf8");
    const { client, close } = await setupClient();
    try {
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      expect(() => readAnchoredOutput.parse(read.structuredContent)).not.toThrow();

      const betaAnchor = anchorAt(read.content[0]?.text ?? "", 1);
      const edit = asToolResult(
        await client.callTool({
          name: "edit_anchored",
          arguments: {
            file_path: path,
            start_anchor: betaAnchor,
            new_content: "BETA",
            mode: "replace",
          },
        })
      );
      expect(() => editAnchoredOutput.parse(edit.structuredContent)).not.toThrow();

      const write = asToolResult(
        await client.callTool({
          name: "write_to_file",
          arguments: { file_path: join(dir, "fresh.txt"), content: "x\ny" },
        })
      );
      expect(() => writeFileOutput.parse(write.structuredContent)).not.toThrow();
    } finally {
      await close();
    }
  });
});
