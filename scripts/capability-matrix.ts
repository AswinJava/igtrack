import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Relative import into the workspace package, matching the other root scripts:
// the root package has no dependency on @igtrack/core by design.
import { renderCapabilityMatrixDocument } from "../packages/core/src/index.js";

// Regenerate docs/CAPABILITIES.md from the capability registry.
// `pnpm docs:capabilities`. The doc is a build artifact; a test in
// packages/core/test/capability-matrix.test.ts fails when it is stale.

const target = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "docs",
  "CAPABILITIES.md",
);
const document = renderCapabilityMatrixDocument();
writeFileSync(target, document, "utf8");
process.stdout.write(
  `igtrack: wrote ${target} (${document.split("\n").length - 1} lines) from the capability registry\n`,
);
