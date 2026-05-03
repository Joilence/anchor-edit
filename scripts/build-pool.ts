#!/usr/bin/env bun
/**
 * Generate src/pool.json: a list of capitalized English words that each
 * encode to exactly one BPE token under o200k_base. Iterates the entire
 * vocabulary, filters by /^[A-Z][a-z]{3,12}$/, and verifies round-trip
 * (decoded id re-encodes back to the same single id).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getEncoding } from "js-tiktoken";

const O200K_VOCAB_SIZE = 200_019;
const WORD_RE = /^[A-Z][a-z]{3,12}$/;
const MIN_POOL_SIZE = 1700;

const enc = getEncoding("o200k_base");

const candidates: string[] = [];

for (let id = 0; id < O200K_VOCAB_SIZE; id++) {
  let decoded: string;
  try {
    decoded = enc.decode([id]);
  } catch {
    continue;
  }

  if (!WORD_RE.test(decoded)) continue;

  const reencoded = enc.encode(decoded);
  if (reencoded.length !== 1 || reencoded[0] !== id) continue;

  candidates.push(decoded);
}

const pool = Array.from(new Set(candidates)).sort();

if (pool.length < MIN_POOL_SIZE) {
  throw new Error(`Pool too small: ${pool.length} (need at least ${MIN_POOL_SIZE})`);
}

const payload = {
  encoding: "o200k_base",
  size: pool.length,
  candidatesScanned: O200K_VOCAB_SIZE,
  generatedAt: new Date().toISOString(),
  words: pool,
};

const outPath = resolve(import.meta.dirname, "..", "src", "pool.json");
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

console.error(
  `Wrote ${pool.length} anchors to ${outPath} (scanned ${O200K_VOCAB_SIZE} vocab entries)`
);
