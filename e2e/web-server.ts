import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB_PORT = process.env.E2E_PORT ?? "3100";
export const DATABASE_URL =
  process.env.IGTRACK_DATABASE_URL ??
  "postgresql://igtrack:igtrack@127.0.0.1:5432/igtrack_e2e";

// Starts the Next dev server with an isolated E2E database and dev-login
// enabled (dev-login is production-disabled by NODE_ENV, see lib/auth.ts).
export function startWebServer() {
  const child = spawn(
    process.execPath,
    ["apps/web/node_modules/next/dist/bin/next", "dev", "-p", WEB_PORT],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: WEB_PORT,
        DATABASE_URL,
        IGTRACK_ALLOW_DEV_LOGIN: "true",
      },
      shell: false,
      stdio: "pipe",
    },
  );
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

export const globalSetupPath = fileURLToPath(
  new URL("./global-setup.ts", import.meta.url),
);