import { createDb } from "../client/client.js";
import { runMigrations } from "../client/migrate.js";

const handle = createDb();
try {
  await runMigrations(handle.db);
  console.log("igtrack: migrations applied");
} finally {
  await handle.close();
}
