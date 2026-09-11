import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "../src/index.js";
import { getAccountByUsername, upsertAccount } from "../src/repositories/accounts.js";
import { igAccounts } from "../src/schema/tables.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

describe.runIf(available)("account identity", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createFreshTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  it("matches a rename by platform id instead of forking the account", async () => {
    const first = await upsertAccount(handle.db, {
      username: "identity_person",
      igId: "9100000100",
    });
    const renamed = await upsertAccount(handle.db, {
      username: "identity_person_renamed",
      igId: "9100000100",
    });

    expect(renamed.id).toBe(first.id);
    expect(renamed.username).toBe("identity_person_renamed");
    expect(await getAccountByUsername(handle.db, "identity_person")).toBeNull();
  });

  it("refuses to rewrite a username row onto a different platform id", async () => {
    const first = await upsertAccount(handle.db, {
      username: "identity_collision",
      igId: "9100000200",
    });

    await expect(
      upsertAccount(handle.db, {
        username: "IDENTITY_COLLISION",
        igId: "9100000201",
      }),
    ).rejects.toThrow(/identity conflict/i);

    const unchanged = await getAccountByUsername(handle.db, "identity_collision");
    expect(unchanged?.id).toBe(first.id);
    expect(unchanged?.igId).toBe("9100000200");
  });

  it("refuses an id-first rename onto a handle already bound to another id", async () => {
    const alpha = await upsertAccount(handle.db, { username: "rename_alpha", igId: "9100000300" });
    const beta = await upsertAccount(handle.db, { username: "rename_beta", igId: "9100000301" });

    // 9100000300 is renamed to a handle 9100000301 still holds. Refusing must
    // surface as the descriptive conflict, never a raw unique-index error.
    await expect(
      upsertAccount(handle.db, { username: "rename_beta", igId: "9100000300" }),
    ).rejects.toThrow(/identity conflict/i);

    // Neither identity moved: no merge, no silent overwrite.
    expect(await getAccountByUsername(handle.db, "rename_alpha")).toMatchObject({
      id: alpha.id,
      igId: "9100000300",
    });
    expect(await getAccountByUsername(handle.db, "rename_beta")).toMatchObject({
      id: beta.id,
      igId: "9100000301",
    });
  });

  it("refuses to bind an id already held elsewhere when the target handle has no id", async () => {
    const owner = await upsertAccount(handle.db, { username: "idless_owner", igId: "9100000400" });
    const idless = await upsertAccount(handle.db, { username: "idless_handle" });
    expect(idless.igId).toBeNull();

    // The id can only belong to one account; binding it to a second row would
    // violate the platform-id unique index.
    await expect(
      upsertAccount(handle.db, { username: "idless_handle", igId: "9100000400" }),
    ).rejects.toThrow(/identity conflict/i);

    expect(await getAccountByUsername(handle.db, "idless_owner")).toMatchObject({
      id: owner.id,
      igId: "9100000400",
    });
    expect(await getAccountByUsername(handle.db, "idless_handle")).toMatchObject({
      id: idless.id,
      igId: null,
    });
  });

  it("keeps exactly one row when two concurrent writes claim one username", async () => {
    const results = await Promise.allSettled([
      upsertAccount(handle.db, { username: "race_identity", igId: "9100000500" }),
      upsertAccount(handle.db, { username: "race_identity", igId: "9100000501" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason.message).toMatch(/identity conflict/i);

    const row = await getAccountByUsername(handle.db, "race_identity");
    expect(row?.igId === "9100000500" || row?.igId === "9100000501").toBe(true);
  });

  it("rolls the whole transaction back when a later write hits an identity conflict", async () => {
    await upsertAccount(handle.db, { username: "tx_taken", igId: "9100000600" });

    await expect(
      handle.db.transaction(async (tx) => {
        await upsertAccount(tx, { username: "tx_early", igId: "9100000601" });
        await upsertAccount(tx, { username: "tx_taken", igId: "9100000602" });
      }),
    ).rejects.toThrow(/identity conflict/i);

    // The write that preceded the conflict must not survive it.
    expect(await getAccountByUsername(handle.db, "tx_early")).toBeNull();
    expect(await getAccountByUsername(handle.db, "tx_taken")).toMatchObject({
      igId: "9100000600",
    });
  });

  it("describes a concurrent identity race instead of leaking a driver error", async () => {
    // Two observations of one account under different handles at the same
    // instant: neither NOT EXISTS guard can see the other's uncommitted write,
    // so the platform-id index is what actually fires. Whatever the database
    // interleaving, the loser must get a described conflict — never a
    // "Failed query: insert into ig_accounts…" — and one identity survives.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const igId = String(9100000900 + attempt);
      const results = await Promise.allSettled([
        upsertAccount(handle.db, { username: `race_same_a${attempt}`, igId }),
        upsertAccount(handle.db, { username: `race_same_b${attempt}`, igId }),
      ]);

      for (const result of results) {
        if (result.status === "fulfilled") continue;
        const message = String((result.reason as Error).message);
        expect(message).not.toMatch(/Failed query|duplicate key|unique constraint|23505/);
        expect(message).toMatch(/identity conflict/i);
      }

      const rows = await handle.db
        .select({ id: igAccounts.id })
        .from(igAccounts)
        .where(sql`${igAccounts.igId} = ${igId}`);
      expect(rows.length).toBeLessThanOrEqual(1);
    }
  });
});
