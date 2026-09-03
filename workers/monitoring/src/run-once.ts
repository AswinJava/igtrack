import { createDb } from "@igtrack/database";
import { providerFromEnv, pollOnce, makeWorkerId, runSchedulerTick } from "./index.js";

// One-shot dev worker: one scheduler tick (idempotent enqueue) plus one
// claimed job, then exits. Matches `start -- --once` with MAX_ITER=1 for a
// single-job probe; production ephemeral runs use `start -- --once` with
// IGTRACK_JOB_MAX_ITER=25 (bounded drain).
// For `pnpm --filter @igtrack/monitoring run-once`.
export async function runOnce(): Promise<void> {
  const handle = createDb();
  try {
    const src = providerFromEnv();
    const workerId = makeWorkerId();
    try {
      await runSchedulerTick(handle.db);
    } catch (err) {
      console.error("scheduler tick failed (continuing to poll):", err);
    }
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

