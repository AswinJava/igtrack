import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

describe.runIf(available)("schema & migrations", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createFreshTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  it("creates all MVP tables on a fresh database", async () => {
    const rows = await handle.sql<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `;
    const names = rows.map((r) => r.name);
    for (const expected of [
      "users",
      "sources",
      "ig_accounts",
      "targets",
      "evidence",
      "profile_snapshots",
      "profile_changes",
      "stories",
      "story_mentions",
      "posts",
      "post_comments",
      "follow_snapshots",
      "follow_snapshot_members",
      "follow_deltas",
      "interactions",
      "media_assets",
      "monitoring_jobs",
      "job_checkpoints",
      "source_health",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("installs append-only triggers on observation tables", async () => {
    const rows = await handle.sql<{ name: string }[]>`
      SELECT tgname AS name FROM pg_trigger
      WHERE tgname LIKE '%_no_update' ORDER BY tgname
    `;
    expect(rows.length).toBe(11);
  });

  it("rejects updates to append-only profile_snapshots", async () => {
    await expect(
      handle.sql.unsafe(
        `UPDATE profile_snapshots SET follower_count = 1 WHERE false`,
      ),
    ).resolves.toBeDefined();

    const source = await handle.sql`
      INSERT INTO sources (id, kind, name) VALUES ('t:src', 'FIXTURE', 'test')
      RETURNING id
    `;
    const account = await handle.sql`
      INSERT INTO ig_accounts (id, username, username_lower)
      VALUES ('t:acc', 'immutable_probe', 'immutable_probe')
      RETURNING id
    `;
    await handle.sql`
      INSERT INTO profile_snapshots
        (id, ig_account_id, observed_at, source_id, username, follower_count, confidence)
      VALUES ('t:snap', ${account[0]!.id}, now(), ${source[0]!.id}, 'immutable_probe', 10, 'HIGH')
    `;

    await expect(
      handle.sql.unsafe(
        `UPDATE profile_snapshots SET follower_count = 999 WHERE id = 't:snap'`,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("re-running migrations is a safe no-op", async () => {
    const { runMigrations } = await import("../src/index.js");
    await expect(runMigrations(handle.db)).resolves.toBeUndefined();
  });
});

describe.skipIf(available)("schema & migrations (no database)", () => {
  it("is skipped because no test database is reachable", () => {
    expect(true).toBe(true);
  });
});
