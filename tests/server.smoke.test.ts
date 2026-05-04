import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ANCHOR_SEPARATOR } from "../src/pool.js";
import { buildServer } from "../src/server.js";

interface TextContent {
  type: string;
  text: string;
}

interface ToolResult {
  content: TextContent[];
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
      const read = asToolResult(
        await client.callTool({ name: "read_anchored", arguments: { file_path: path } })
      );
      expect(read.content[0]?.text).toEqual(written.content[0]?.text);
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
});
