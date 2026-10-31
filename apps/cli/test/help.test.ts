import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function helpFor(command: string): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "src/main.ts", command, "--help"],
    { cwd: cliRoot, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
  );
}

describe("--help is a read, never an execution", () => {
  it("prints status help without opening the database", () => {
    expect(helpFor("status")).toContain("igtrack status [--json]");
  });

  it("prints doctor help without running diagnostics", () => {
    expect(helpFor("doctor")).toContain("igtrack doctor [--json]");
  });

  it("prints mcp help without starting the stdio server", () => {
    expect(helpFor("mcp")).toContain("igtrack mcp");
  });
});
