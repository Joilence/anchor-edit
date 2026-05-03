import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POOL } from "../src/pool.js";
import { type AnchorEditCode, AnchorEditError, StateManager } from "../src/state.js";

function expectAnchorEditError(fn: () => unknown, code: AnchorEditCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AnchorEditError);
  if (caught instanceof AnchorEditError) {
    expect(caught.code).toBe(code);
  }
}

describe("StateManager", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anchor-edit-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content, "utf8");
    return path;
  }

  test("read assigns one unique anchor per line", () => {
    const path = writeFile("a.txt", "alpha\nbeta\ngamma");
    const sm = new StateManager();
    const { lines, anchors } = sm.read(path);
    expect(lines).toEqual(["alpha", "beta", "gamma"]);
    expect(anchors).toHaveLength(3);
    expect(new Set(anchors).size).toBe(3);
  });

  test("re-read returns identical anchors", () => {
    const path = writeFile("a.txt", "alpha\nbeta");
    const sm = new StateManager();
    const first = sm.read(path);
    const second = sm.read(path);
    expect(second.anchors).toEqual(first.anchors);
  });

  test("offset and limit slice correctly", () => {
    const path = writeFile("a.txt", "one\ntwo\nthree\nfour");
    const sm = new StateManager();
    const all = sm.read(path);
    const window = sm.read(path, 1, 2);
    expect(window.lines).toEqual(["two", "three"]);
    expect(window.anchors).toEqual([all.anchors[1], all.anchors[2]]);
  });

  test("replace single line keeps neighbouring anchors", () => {
    const path = writeFile("a.txt", "alpha\nbeta\ngamma");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    const result = sm.edit({
      filePath: path,
      startAnchor: anchors[1],
      newContent: "BETA",
      mode: "replace",
    });
    expect(result.lines).toEqual(["alpha", "BETA", "gamma"]);
    expect(result.anchors[0]).toBe(anchors[0]);
    expect(result.anchors[2]).toBe(anchors[2]);
    expect(result.anchors[1]).not.toBe(anchors[1]);
    expect(result.affectedRange).toEqual([1, 1]);
  });

  test("replace multi-line range", () => {
    const path = writeFile("a.txt", "alpha\nbeta\ngamma\ndelta");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    const result = sm.edit({
      filePath: path,
      startAnchor: anchors[1],
      endAnchor: anchors[2],
      newContent: "B\nG",
      mode: "replace",
    });
    expect(result.lines).toEqual(["alpha", "B", "G", "delta"]);
    expect(result.anchors[0]).toBe(anchors[0]);
    expect(result.anchors[3]).toBe(anchors[3]);
    expect(result.affectedRange).toEqual([1, 2]);
  });

  test("replace with empty new_content deletes the range", () => {
    const path = writeFile("a.txt", "alpha\nbeta\ngamma");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    const result = sm.edit({
      filePath: path,
      startAnchor: anchors[1],
      newContent: "",
      mode: "replace",
    });
    expect(result.lines).toEqual(["alpha", "gamma"]);
    expect(result.anchors).toEqual([anchors[0], anchors[2]]);
    expect(readFileSync(path, "utf8")).toBe("alpha\ngamma");
  });

  test("replace multi-line range with empty new_content deletes the range", () => {
    const path = writeFile("a.txt", "alpha\nbeta\ngamma\ndelta");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    const result = sm.edit({
      filePath: path,
      startAnchor: anchors[1],
      endAnchor: anchors[2],
      newContent: "",
      mode: "replace",
    });
    expect(result.lines).toEqual(["alpha", "delta"]);
    expect(result.anchors).toEqual([anchors[0], anchors[3]]);
  });

  test("insert_before adds lines above the anchor", () => {
    const path = writeFile("a.txt", "alpha\nbeta");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    const result = sm.edit({
      filePath: path,
      startAnchor: anchors[1],
      newContent: "MIDDLE",
      mode: "insert_before",
    });
    expect(result.lines).toEqual(["alpha", "MIDDLE", "beta"]);
    expect(result.anchors[0]).toBe(anchors[0]);
    expect(result.anchors[2]).toBe(anchors[1]);
    expect(result.affectedRange).toEqual([1, 1]);
  });

  test("insert_after adds lines below the anchor", () => {
    const path = writeFile("a.txt", "alpha\nbeta");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    const result = sm.edit({
      filePath: path,
      startAnchor: anchors[0],
      newContent: "MIDDLE",
      mode: "insert_after",
    });
    expect(result.lines).toEqual(["alpha", "MIDDLE", "beta"]);
    expect(result.anchors[0]).toBe(anchors[0]);
    expect(result.anchors[2]).toBe(anchors[1]);
    expect(result.affectedRange).toEqual([1, 1]);
  });

  test("unknown start_anchor raises ANCHOR_NOT_FOUND", () => {
    const path = writeFile("a.txt", "alpha");
    const sm = new StateManager();
    sm.read(path);
    expectAnchorEditError(
      () =>
        sm.edit({
          filePath: path,
          startAnchor: "NotARealAnchor",
          newContent: "x",
          mode: "replace",
        }),
      "ANCHOR_NOT_FOUND"
    );
  });

  test("pool-valid anchor not allocated to file raises ANCHOR_NOT_FOUND", () => {
    const path = writeFile("a.txt", "alpha");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    const stranger = POOL.find((w) => w !== anchors[0]);
    if (stranger === undefined) throw new Error("pool too small for test");
    expectAnchorEditError(
      () => sm.edit({ filePath: path, startAnchor: stranger, newContent: "x", mode: "replace" }),
      "ANCHOR_NOT_FOUND"
    );
  });

  test("end_anchor before start_anchor raises INVALID_RANGE", () => {
    const path = writeFile("a.txt", "alpha\nbeta\ngamma");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    expectAnchorEditError(
      () =>
        sm.edit({
          filePath: path,
          startAnchor: anchors[2],
          endAnchor: anchors[0],
          newContent: "x",
          mode: "replace",
        }),
      "INVALID_RANGE"
    );
  });

  test("external modification reconciles anchors", () => {
    const path = writeFile("a.txt", "alpha\nbeta\ngamma");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    writeFileSync(path, "alpha\nNEW\nbeta\ngamma", "utf8");
    const after = sm.read(path);
    expect(after.lines).toEqual(["alpha", "NEW", "beta", "gamma"]);
    expect(after.anchors[0]).toBe(anchors[0]);
    expect(after.anchors[2]).toBe(anchors[1]);
    expect(after.anchors[3]).toBe(anchors[2]);
  });

  test("edit writes back to disk", () => {
    const path = writeFile("a.txt", "alpha\nbeta");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    sm.edit({
      filePath: path,
      startAnchor: anchors[0],
      newContent: "ALPHA",
      mode: "replace",
    });
    expect(readFileSync(path, "utf8")).toBe("ALPHA\nbeta");
  });

  test("two files have independent anchor pools", () => {
    const a = writeFile("a.txt", "alpha");
    const b = writeFile("b.txt", "beta");
    const sm = new StateManager();
    const ra = sm.read(a);
    const rb = sm.read(b);
    expect(ra.anchors[0]).toBe(rb.anchors[0]);
  });

  test("file-not-found raises FILE_NOT_FOUND", () => {
    const sm = new StateManager();
    expectAnchorEditError(() => sm.read(join(dir, "missing.txt")), "FILE_NOT_FOUND");
  });

  test("directory path raises IS_DIRECTORY", () => {
    const sm = new StateManager();
    expectAnchorEditError(() => sm.read(dir), "IS_DIRECTORY");
  });

  test("binary file raises BINARY_FILE", () => {
    const path = join(dir, "blob.bin");
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc0, 0x80]));
    const sm = new StateManager();
    expectAnchorEditError(() => sm.read(path), "BINARY_FILE");
  });

  test("released anchors never resurface within the file", () => {
    const path = writeFile("a.txt", "x\ny\nz");
    const sm = new StateManager();
    const { anchors: initial } = sm.read(path);
    sm.edit({
      filePath: path,
      startAnchor: initial[1],
      newContent: "Y2",
      mode: "replace",
    });
    sm.edit({
      filePath: path,
      startAnchor: initial[2],
      newContent: "Z2",
      mode: "replace",
    });
    const final = sm.read(path);
    const seen = new Set([...initial, ...final.anchors]);
    expect(seen.size).toBe(initial.length + 2);
  });

  test("falls back to multi-word anchors when pool exhausts", () => {
    const path = writeFile("a.txt", "u\nv\nw");
    const sm = new StateManager({ poolOverride: ["Aa", "Bb"] });
    const { anchors } = sm.read(path);
    expect(anchors).toHaveLength(3);
    const longer = anchors.find((a) => a.length > 2);
    expect(longer).toBeDefined();
  });

  test("write_to_file creates a new file and assigns anchors", () => {
    const path = join(dir, "new.txt");
    const sm = new StateManager();
    const result = sm.write(path, "first\nsecond");
    expect(result.lines).toEqual(["first", "second"]);
    expect(result.anchors).toHaveLength(2);
    expect(readFileSync(path, "utf8")).toBe("first\nsecond");
  });

  test("trailing newline produces N anchors not N+1", () => {
    const path = writeFile("a.txt", "alpha\nbeta\ngamma\n");
    const sm = new StateManager();
    const result = sm.read(path);
    expect(result.lines).toEqual(["alpha", "beta", "gamma"]);
    expect(result.anchors).toHaveLength(3);
  });

  test("empty file produces zero anchors", () => {
    const path = writeFile("a.txt", "");
    const sm = new StateManager();
    const result = sm.read(path);
    expect(result.lines).toEqual([]);
    expect(result.anchors).toEqual([]);
  });

  test("edit preserves trailing newline on disk", () => {
    const path = writeFile("a.txt", "alpha\nbeta\n");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    sm.edit({
      filePath: path,
      startAnchor: anchors[0],
      newContent: "ALPHA",
      mode: "replace",
    });
    expect(readFileSync(path, "utf8")).toBe("ALPHA\nbeta\n");
  });

  test("edit on no-trailing-newline file keeps no trailing newline", () => {
    const path = writeFile("a.txt", "alpha\nbeta");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    sm.edit({
      filePath: path,
      startAnchor: anchors[1],
      newContent: "BETA",
      mode: "replace",
    });
    expect(readFileSync(path, "utf8")).toBe("alpha\nBETA");
  });

  test("deleting the only line empties the file completely", () => {
    const path = writeFile("a.txt", "only\n");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    sm.edit({
      filePath: path,
      startAnchor: anchors[0],
      newContent: "",
      mode: "replace",
    });
    expect(readFileSync(path, "utf8")).toBe("");
  });

  test("write_to_file with trailing newline preserves it", () => {
    const path = join(dir, "trailing.txt");
    const sm = new StateManager();
    const result = sm.write(path, "x\ny\n");
    expect(result.lines).toEqual(["x", "y"]);
    expect(result.anchors).toHaveLength(2);
    expect(readFileSync(path, "utf8")).toBe("x\ny\n");
  });

  test("write_to_file auto-creates missing parent directories", () => {
    const path = join(dir, "nested", "deeply", "new.txt");
    const sm = new StateManager();
    const result = sm.write(path, "hello");
    expect(result.lines).toEqual(["hello"]);
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  test("write_to_file overwrites and preserves anchors for unchanged lines", () => {
    const path = writeFile("a.txt", "alpha\nbeta\ngamma");
    const sm = new StateManager();
    const { anchors } = sm.read(path);
    const after = sm.write(path, "alpha\nBETA\ngamma");
    expect(after.lines).toEqual(["alpha", "BETA", "gamma"]);
    expect(after.anchors[0]).toBe(anchors[0]);
    expect(after.anchors[2]).toBe(anchors[2]);
    expect(after.anchors[1]).not.toBe(anchors[1]);
  });

  test("edit failure on write evicts cache so next read rebuilds from disk", () => {
    const path = writeFile("a.txt", "alpha\nbeta");
    const sm = new StateManager();
    const { anchors: initial } = sm.read(path);
    chmodSync(path, 0o400);
    expectAnchorEditError(
      () =>
        sm.edit({
          filePath: path,
          startAnchor: initial[0],
          newContent: "ALPHA",
          mode: "replace",
        }),
      "PERMISSION_DENIED"
    );
    chmodSync(path, 0o600);
    const reread = sm.read(path);
    expect(reread.lines).toEqual(["alpha", "beta"]);
  });

  test("reset clears single-file state", () => {
    const path = writeFile("a.txt", "alpha");
    const sm = new StateManager();
    const first = sm.read(path);
    sm.reset(path);
    const second = sm.read(path);
    expect(second.anchors).toEqual(first.anchors);
  });

  test("reset clears all state when no path given", () => {
    const a = writeFile("a.txt", "alpha");
    const b = writeFile("b.txt", "beta");
    const sm = new StateManager();
    sm.read(a);
    sm.read(b);
    sm.reset();
    const ra = sm.read(a);
    expect(ra.lines).toEqual(["alpha"]);
  });
});
