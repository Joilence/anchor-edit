import { describe, expect, test } from "bun:test";
import { getEncoding } from "js-tiktoken";
import { ANCHOR_SEPARATOR, POOL, POOL_ENCODING, POOL_SET } from "../src/pool.js";

describe("pool", () => {
  test("loads at least 1700 anchors", () => {
    expect(POOL.length).toBeGreaterThanOrEqual(1700);
  });

  test("all entries are unique", () => {
    expect(POOL_SET.size).toBe(POOL.length);
  });

  test("all entries match capitalized-word pattern", () => {
    for (const w of POOL) {
      expect(w).toMatch(/^[A-Z][a-z]{3,12}$/);
    }
  });

  test("encoding metadata is o200k_base", () => {
    expect(POOL_ENCODING).toBe("o200k_base");
  });

  test("separator is single-token in o200k_base", () => {
    const enc = getEncoding("o200k_base");
    expect(enc.encode(ANCHOR_SEPARATOR)).toHaveLength(1);
  });

  test("every pool entry round-trips to one o200k_base token", () => {
    const enc = getEncoding("o200k_base");
    for (const w of POOL) {
      expect(enc.encode(w)).toHaveLength(1);
    }
  });
});
