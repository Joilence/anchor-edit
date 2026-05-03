#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

const USAGE = `Usage: anchor-edit <command>

Commands:
  mcp     Run the MCP server over stdio (for Claude Code, etc.)
  help    Show this message`;

async function runMcp(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "mcp":
      await runMcp();
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("anchor-edit error:", err);
  process.exit(1);
});
