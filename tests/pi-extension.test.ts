import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentToolResult,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Text } from "@mariozechner/pi-tui";

import type { Static, TSchema } from "typebox";
import { type PiToolRegistrar, registerAnchorEditPiTools } from "../src/pi-extension.js";
import { ANCHOR_SEPARATOR } from "../src/pool.js";

interface CapturedTool {
  name: string;
  prepareArguments?: (args: unknown) => unknown;
  execute: (params: unknown, ctx: ExtensionContext) => Promise<AgentToolResult<unknown>>;
  renderCall?: (args: unknown, theme: Theme) => Text;
  renderResult?: (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme
  ) => Text;
}

function captureTool<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>
): CapturedTool {
  const renderCall = tool.renderCall;
  const renderResult = tool.renderResult;
  return {
    name: tool.name,
    prepareArguments: tool.prepareArguments,
    execute: (params, ctx) =>
      tool.execute("test", params as Static<TParams>, undefined, undefined, ctx),
    renderCall: renderCall
      ? (args, theme) =>
          renderCall(args as Static<TParams>, theme, {} as Parameters<typeof renderCall>[2]) as Text
      : undefined,
    renderResult: renderResult
      ? (result, options, theme) =>
          renderResult(
            result as AgentToolResult<TDetails>,
            options,
            theme,
            {} as Parameters<typeof renderResult>[3]
          ) as Text
      : undefined,
  };
}

const stubTheme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
  inverse: (text: string): string => `«${text}»`,
} as unknown as Theme;

const stubOptions: ToolRenderResultOptions = { expanded: false, isPartial: false };

function rendered(text: Text): string {
  return text.render(1000).join("\n");
}

function collectTools(): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const registrar: PiToolRegistrar = {
    registerTool(tool) {
      const captured = captureTool(tool);
      tools.set(captured.name, captured);
    },
  };
  registerAnchorEditPiTools(registrar);
  return tools;
}

function getTool(tools: Map<string, CapturedTool>, name: string): CapturedTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function context(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

function resultText(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("Expected text result");
  return first.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailString(result: AgentToolResult<unknown>, key: string): string {
  if (!isRecord(result.details)) throw new Error("Expected result details");
  const value = result.details[key];
  if (typeof value !== "string") throw new Error(`Expected string detail: ${key}`);
  return value;
}

function anchorAt(result: AgentToolResult<unknown>, index: number): string {
  const line = resultText(result).split("\n")[index];
  if (line === undefined) throw new Error(`Missing anchored line at index ${index}`);
  const anchor = line.split(ANCHOR_SEPARATOR)[0];
  if (!anchor) throw new Error(`Missing anchor at index ${index}`);
  return anchor;
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("Expected promise to reject");
}

describe("pi extension", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anchor-edit-pi-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("registers the three anchored tools", () => {
    const tools = collectTools();
    expect([...tools.keys()].sort()).toEqual(["edit_anchored", "read_anchored", "write_to_file"]);
  });

  test("read_anchored resolves relative paths from pi cwd", async () => {
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta", "utf8");
    const readTool = getTool(collectTools(), "read_anchored");

    const result = await readTool.execute({ path: "a.txt" }, context(dir));

    const text = resultText(result);
    expect(text).toContain(`${ANCHOR_SEPARATOR}alpha`);
    expect(text).toContain(`${ANCHOR_SEPARATOR}beta`);
  });

  test("read_anchored resolves absolute and @-prefixed paths", async () => {
    const absolutePath = join(dir, "absolute.txt");
    writeFileSync(absolutePath, "absolute", "utf8");
    writeFileSync(join(dir, "at-relative.txt"), "at-relative", "utf8");
    const atAbsolutePath = join(dir, "at-absolute.txt");
    writeFileSync(atAbsolutePath, "at-absolute", "utf8");
    const readTool = getTool(collectTools(), "read_anchored");

    expect(resultText(await readTool.execute({ path: absolutePath }, context("/")))).toContain(
      `${ANCHOR_SEPARATOR}absolute`
    );
    expect(
      resultText(await readTool.execute({ path: "@at-relative.txt" }, context(dir)))
    ).toContain(`${ANCHOR_SEPARATOR}at-relative`);
    expect(
      resultText(await readTool.execute({ path: `@${atAbsolutePath}` }, context("/")))
    ).toContain(`${ANCHOR_SEPARATOR}at-absolute`);
  });

  test("read_anchored applies offset and limit", async () => {
    writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma", "utf8");
    const readTool = getTool(collectTools(), "read_anchored");

    const result = await readTool.execute({ path: "a.txt", offset: 1, limit: 1 }, context(dir));

    const text = resultText(result);
    expect(text).toContain(`${ANCHOR_SEPARATOR}beta`);
    expect(text).not.toContain("alpha");
    expect(text).not.toContain("gamma");
    expect(detailString(result, "display_text")).toBe(
      ` 2 ${anchorAt(result, 0)}${ANCHOR_SEPARATOR} beta`
    );
  });

  test("prepareArguments accepts MCP-style file_path", () => {
    const readTool = getTool(collectTools(), "read_anchored");
    expect(readTool.prepareArguments?.({ file_path: "a.txt" })).toEqual({ path: "a.txt" });
  });

  test("edit_anchored uses prior anchors and updates the file", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");

    const readResult = await readTool.execute({ path: "a.txt" }, context(dir));
    const betaAnchor = anchorAt(readResult, 1);

    const editResult = await editTool.execute(
      { path: "a.txt", start_anchor: betaAnchor, new_content: "BETA" },
      context(dir)
    );

    expect(readFileSync(filePath, "utf8")).toBe("alpha\nBETA\ngamma");
    expect(resultText(editResult)).toContain("Edit applied. Lines 2-2.");
  });

  test("edit_anchored inserts before an anchor", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");
    const betaAnchor = anchorAt(await readTool.execute({ path: "a.txt" }, context(dir)), 1);

    const result = await editTool.execute(
      { path: "a.txt", start_anchor: betaAnchor, new_content: "before", mode: "insert_before" },
      context(dir)
    );

    expect(readFileSync(filePath, "utf8")).toBe("alpha\nbefore\nbeta\ngamma");
    expect(resultText(result)).toContain("Edit applied. Lines 2-2.");
    const after = await readTool.execute({ path: "a.txt" }, context(dir));
    expect(resultText(after).split("\n")[1]).toContain(`${ANCHOR_SEPARATOR}before`);
  });

  test("edit_anchored inserts after an anchor", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");
    const betaAnchor = anchorAt(await readTool.execute({ path: "a.txt" }, context(dir)), 1);

    const result = await editTool.execute(
      { path: "a.txt", start_anchor: betaAnchor, new_content: "after", mode: "insert_after" },
      context(dir)
    );

    expect(readFileSync(filePath, "utf8")).toBe("alpha\nbeta\nafter\ngamma");
    expect(resultText(result)).toContain("Edit applied. Lines 3-3.");
    const after = await readTool.execute({ path: "a.txt" }, context(dir));
    expect(resultText(after).split("\n")[2]).toContain(`${ANCHOR_SEPARATOR}after`);
  });

  test("edit_anchored deletes a range with empty replacement", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");
    const betaAnchor = anchorAt(await readTool.execute({ path: "a.txt" }, context(dir)), 1);

    const result = await editTool.execute(
      { path: "a.txt", start_anchor: betaAnchor, new_content: "", mode: "replace" },
      context(dir)
    );

    expect(readFileSync(filePath, "utf8")).toBe("alpha\ngamma");
    expect(resultText(result)).toContain("Edit applied. Lines 2-2 deleted.");
  });

  test("edit_anchored replaces a multi-line range", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");
    const readResult = await readTool.execute({ path: "a.txt" }, context(dir));
    const betaAnchor = anchorAt(readResult, 1);
    const gammaAnchor = anchorAt(readResult, 2);

    const result = await editTool.execute(
      {
        path: "a.txt",
        start_anchor: betaAnchor,
        end_anchor: gammaAnchor,
        new_content: "BETA-GAMMA",
        mode: "replace",
      },
      context(dir)
    );

    expect(readFileSync(filePath, "utf8")).toBe("alpha\nBETA-GAMMA\ndelta");
    expect(resultText(result)).toContain("Edit applied. Lines 2-2.");
    const after = await readTool.execute({ path: "a.txt" }, context(dir));
    expect(resultText(after).split("\n")[1]).toContain(`${ANCHOR_SEPARATOR}BETA-GAMMA`);
  });

  test("edit_anchored rejects end_anchor outside replace mode", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");
    const readResult = await readTool.execute({ path: "a.txt" }, context(dir));
    const betaAnchor = anchorAt(readResult, 1);
    const gammaAnchor = anchorAt(readResult, 2);

    const message = await rejectionMessage(
      editTool.execute(
        {
          path: "a.txt",
          start_anchor: betaAnchor,
          end_anchor: gammaAnchor,
          new_content: "before",
          mode: "insert_before",
        },
        context(dir)
      )
    );

    expect(message).toContain("end_anchor is only valid with mode=replace");
    expect(readFileSync(filePath, "utf8")).toBe("alpha\nbeta\ngamma");
  });

  test("edit_anchored warns on literal backslash-n without real newlines", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");
    const betaAnchor = anchorAt(await readTool.execute({ path: "a.txt" }, context(dir)), 1);

    const result = await editTool.execute(
      { path: "a.txt", start_anchor: betaAnchor, new_content: "line one\\nline two" },
      context(dir)
    );

    expect(readFileSync(filePath, "utf8")).toBe("alpha\nline one\\nline two\ngamma");
    expect(resultText(result)).toContain("literal backslash-n");
  });

  test("write_to_file creates files and returns anchors", async () => {
    const tools = collectTools();
    const writeTool = getTool(tools, "write_to_file");
    const readTool = getTool(tools, "read_anchored");

    const result = await writeTool.execute(
      { path: "nested/new.txt", content: "one\ntwo" },
      context(dir)
    );

    expect(readFileSync(join(dir, "nested/new.txt"), "utf8")).toBe("one\ntwo");
    expect(resultText(result)).toContain("Wrote 2 lines.");
    const after = await readTool.execute({ path: "nested/new.txt" }, context(dir));
    const text = resultText(after);
    expect(text).toContain(`${ANCHOR_SEPARATOR}one`);
    expect(text).toContain(`${ANCHOR_SEPARATOR}two`);
  });

  test("renderCall collapses $HOME to '~'", () => {
    const home = homedir();
    expect(home).toBeTruthy();
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const callRender = readTool.renderCall;
    if (!callRender) throw new Error("Expected renderCall");

    const output = rendered(callRender({ path: `${home}/some/file.txt` }, stubTheme));

    expect(output).toContain("read_anchored ");
    expect(output).toContain("~/some/file.txt");
    expect(output).not.toContain(home);
  });

  test("read renderResult normalizes tabs and strips carriage returns", async () => {
    writeFileSync(join(dir, "a.txt"), "alpha\n\tbeta\r\ngamma", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const result = await readTool.execute({ path: "a.txt" }, context(dir));
    const resultRender = readTool.renderResult;
    if (!resultRender) throw new Error("Expected renderResult");

    const output = rendered(resultRender(result, stubOptions, stubTheme));

    expect(output).toContain("   beta");
    expect(output).not.toContain("\t");
    expect(output).not.toContain("\r");
  });

  test("edit renderResult highlights changed words on a 1-1 replace", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta bar\ngamma", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");
    const betaAnchor = anchorAt(await readTool.execute({ path: "a.txt" }, context(dir)), 1);

    const editResult = await editTool.execute(
      { path: "a.txt", start_anchor: betaAnchor, new_content: "beta baz" },
      context(dir)
    );
    const resultRender = editTool.renderResult;
    if (!resultRender) throw new Error("Expected renderResult");
    const output = rendered(resultRender(editResult, stubOptions, stubTheme));

    expect(output).toContain("«bar»");
    expect(output).toContain("«baz»");
    expect(output).toContain("beta «bar»");
    expect(output).toContain("beta «baz»");
  });

  test("edit renderResult plain-colors a multi-line N-M replace", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma\ndelta", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");
    const readResult = await readTool.execute({ path: "a.txt" }, context(dir));
    const betaAnchor = anchorAt(readResult, 1);
    const gammaAnchor = anchorAt(readResult, 2);

    const editResult = await editTool.execute(
      {
        path: "a.txt",
        start_anchor: betaAnchor,
        end_anchor: gammaAnchor,
        new_content: "BETA\nGAMMA",
        mode: "replace",
      },
      context(dir)
    );
    const resultRender = editTool.renderResult;
    if (!resultRender) throw new Error("Expected renderResult");
    const output = rendered(resultRender(editResult, stubOptions, stubTheme));

    expect(output).not.toContain("«");
    expect(output).toMatch(/-\s+2\s+\S+\s*§ beta/);
    expect(output).toMatch(/-\s+3\s+\S+\s*§ gamma/);
    expect(output).toMatch(/\+\s+2\s+\S+\s*§ BETA/);
    expect(output).toMatch(/\+\s+3\s+\S+\s*§ GAMMA/);
  });

  test("edit renderResult colors insert-only runs without intra-line markers", async () => {
    const filePath = join(dir, "a.txt");
    writeFileSync(filePath, "alpha\nbeta\ngamma", "utf8");
    const tools = collectTools();
    const readTool = getTool(tools, "read_anchored");
    const editTool = getTool(tools, "edit_anchored");
    const betaAnchor = anchorAt(await readTool.execute({ path: "a.txt" }, context(dir)), 1);

    const editResult = await editTool.execute(
      { path: "a.txt", start_anchor: betaAnchor, new_content: "after", mode: "insert_after" },
      context(dir)
    );
    const resultRender = editTool.renderResult;
    if (!resultRender) throw new Error("Expected renderResult");
    const output = rendered(resultRender(editResult, stubOptions, stubTheme));

    expect(output).not.toContain("«");
    expect(output).toMatch(/\+\s+3\s+\S+\s*§ after/);
  });
});
