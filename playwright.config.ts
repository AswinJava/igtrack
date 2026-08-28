import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const startLauncher = fileURLToPath(
  new URL("./e2e/start-web.mjs", import.meta.url),
).replace(/\\/g, "/");

export default defineConfig({
  testDir: "./e2e/tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  globalSetup: fileURLToPath(
    new URL("./e2e/global-setup.ts", import.meta.url),
  ),
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], headless: true },
    },
  ],
  webServer: {
    command: `node ${startLauncher}`,
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});