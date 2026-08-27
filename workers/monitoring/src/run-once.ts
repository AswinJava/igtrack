import { createDb } from "@igtrack/database";
import { providerFromEnv, pollOnce, makeWorkerId } from "./index.js";

// One-shot dev worker: runs once (optionally repeatedly via IGTRACK_JOB_MAX_ITER)
// and exits. For `pnpm --filter @igtrack/monitoring run-once`.
export async function runOnce(): Promise<void> {
  const handle = createDb();
  try {
    const src = providerFromEnv();
    const workerId = makeWorkerId();
    const outcome = await pollOnce(handle.db, workerId, src);
    // eslint-disable-next-line no-console
    console.log(`worker ${workerId}:`, JSON.stringify(outcome));
  } finally {
    await handle.close();
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  runOnce().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker error:", err);
    process.exit(1);
  });
}
