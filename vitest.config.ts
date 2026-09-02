import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "workers/*/test/**/*.test.ts"],
    environment: "node",
    typecheck: { enabled: false },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
