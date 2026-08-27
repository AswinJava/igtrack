import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { igAccounts, type DatabaseHandle } from "../src/index.js";
import { upsertAccount } from "../src/repositories/accounts.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

describe.runIf(available)("privacy / unknown semantics (D1)", () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = await createFreshTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  async function readPrivacy(username: string) {
    const rows = await handle.db
      .select({
        isPrivate: igAccounts.isPrivate,
        isVerified: igAccounts.isVerified,
      })
      .from(igAccounts)
      .where(sql`${igAccounts.usernameLower} = ${username.toLowerCase()}`);
    return rows[0] ?? null;
  }

  it("V1: a follow/member record without privacy metadata never overwrites a known-private account", async () => {
    await upsertAccount(handle.db, { username: "v1_account", isPrivate: true });

    // Simulates recordFollowSnapshot's member upsert: no privacy information.
    await upsertAccount(handle.db, { username: "V1_ACCOUNT" });

    const row = await readPrivacy("v1_account");
    expect(row?.isPrivate).toBe(true);
  });

  it("V2: an unknown account without privacy metadata persists as NULL (unknown)", async () => {
    await upsertAccount(handle.db, { username: "v2_account" });

    const row = await readPrivacy("v2_account");
    expect(row?.isPrivate).toBeNull();
    expect(row?.isVerified).toBeNull();
  });

  it("V3: an explicit observation still sets and updates privacy", async () => {
    await upsertAccount(handle.db, { username: "v3_account", isPrivate: false, isVerified: true });
    expect((await readPrivacy("v3_account"))?.isPrivate).toBe(false);
    expect((await readPrivacy("v3_account"))?.isVerified).toBe(true);

    await upsertAccount(handle.db, { username: "v3_account", isPrivate: true });
    expect((await readPrivacy("v3_account"))?.isPrivate).toBe(true);
  });

  it("an explicit unknown-absent profile observation leaves existing verification untouched", async () => {
    await upsertAccount(handle.db, { username: "v4_account", isVerified: true });

    // A later observation that does not carry verification must not erase it.
    await upsertAccount(handle.db, { username: "v4_account", isPrivate: false });

    const row = await readPrivacy("v4_account");
    expect(row?.isVerified).toBe(true);
    expect(row?.isPrivate).toBe(false);
  });
});