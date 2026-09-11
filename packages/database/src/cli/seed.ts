import { createDb } from "../client/client.js";
import { runMigrations } from "../client/migrate.js";
import { seed } from "../seed/seed.js";

const handle = createDb();
try {
  await runMigrations(handle.db);
  await seed(handle.db);
  console.log("igtrack: seed complete (all data synthetic)");
} finally {
  await handle.close();
}
