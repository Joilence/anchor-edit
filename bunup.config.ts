import { defineConfig } from "bunup";

export default defineConfig({
  entry: ["src/server.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
});
