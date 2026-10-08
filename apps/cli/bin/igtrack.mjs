#!/usr/bin/env node
// IGTrack CLI launcher.
//
// Why a launcher instead of pointing `bin` at a .ts file: the CLI runs through
// tsx (the repository's zero-build TypeScript runtime for Node). Resolving tsx
// from THIS file's location keeps the command working from any working
// directory, and stdio is inherited so the MCP mode can speak JSON-RPC on
// stdout without a wrapper corrupting the stream.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

let tsxUrl;
try {
  // Resolves relative to this file, so tsx must be a dependency of @igtrack/cli
  // (it is) rather than something the caller happens to have installed.
  tsxUrl = await import.meta.resolve("tsx");
} catch {
  process.stderr.write(
    "igtrack: tsx is not installed. Run `pnpm install` in the repository root.\n",
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--import", tsxUrl, main, ...process.argv.slice(2)],
  { stdio: "inherit", cwd: process.cwd() },
);

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on("error", (err) => {
  process.stderr.write(`igtrack: failed to launch: ${err.message}\n`);
  process.exit(1);
});
