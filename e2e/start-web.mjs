import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = process.env.E2E_PORT ?? "3100";
const DATABASE_URL =
  process.env.IGTRACK_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_e2e";

const NEXT_BIN = fileURLToPath(
  new URL("../apps/web/node_modules/next/dist/bin/next", import.meta.url),
);
const WEB_DIR = fileURLToPath(new URL("../apps/web", import.meta.url));

// Launcher used by Playwright's webServer (must be a shell command). Spawns
// the Next dev server against the isolated E2E database with dev-login on.
const child = spawn(
  process.execPath,
  [NEXT_BIN, "dev", "-p", PORT, "-H", "127.0.0.1"],
  {
    cwd: WEB_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL,
      IGTRACK_ALLOW_DEV_LOGIN: "true",
      NEXT_PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 0));