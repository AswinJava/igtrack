import { createDb } from "@igtrack/database";
import { providerFromEnv, pollOnce, makeWorkerId } from "./index.js";

// One-shot dev worker: claims and runs a single job, then exits.
// For `pnpm --filter @igtrack/monitoring run-once`.
export async function runOnce(): Promise<void> {
  const handle = createDb();
  try {
    const src = providerFromEnv();
    const workerId = makeWorkerId();
    const outcome = await pollOnce(handle.db, workerId, src);
    console.log(`worker ${workerId}:`, JSON.stringify(outcome));
  } finally {
    await handle.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;

if (invokedDirectly) {
  runOnce().catch((err) => {
    console.error("worker error:", err);
    process.exit(1);
  });
}

