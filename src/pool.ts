import { getEncoding } from "js-tiktoken";
import poolData from "./pool.json" with { type: "json" };

export const ANCHOR_SEPARATOR = "§";

const enc = getEncoding("o200k_base");
const sepTokens = enc.encode(ANCHOR_SEPARATOR);
if (sepTokens.length !== 1) {
  throw new Error(
    `Separator "${ANCHOR_SEPARATOR}" is not single-token in o200k_base (got ${sepTokens.length} tokens). Pick a different separator and rebuild.`
  );
}

export const POOL: readonly string[] = Object.freeze([...poolData.words]);
export const POOL_SET: ReadonlySet<string> = new Set(poolData.words);
export const POOL_ENCODING = poolData.encoding;
