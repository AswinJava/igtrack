import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTarget,
  deleteTargetWithObservations,
  getAccountByUsername,
  getTarget,
  listProfileSnapshots,
  recordProfileSnapshot,
  users,
  withTransaction,
  igAccounts,
  type DatabaseHandle,
} from "../src/index.js";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

const SOURCE = {
  id: "fixture:v1",
  kind: SourceKind.FIXTURE,
  name: "Fixture v1",
} as const;

const hash = (label: string): string =>
  Buffer.from(label.padEnd(64, "0")).toString("hex").slice(0, 64);

describe.runIf(available)("transactions & retention", () => {
  let handle: DatabaseHandle;
  let userId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "tx@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("rolls back all writes when a transaction throws", async () => {
    await expect(
      withTransaction(handle.db, async (tx) => {
        await tx.insert(igAccounts).values({
          username: "rollback_probe",
          usernameLower: "rollback_probe",
        });
        throw new Error("simulated mid-transaction failure");
      }),
    ).rejects.toThrow("simulated mid-transaction failure");

    const account = await getAccountByUsername(handle.db, "rollback_probe");
    expect(account).toBeNull();
  });

  it("deletes a target with all observations and evidence", async () => {
    const { target } = await createTarget(handle.db, {
      userId,
      username: "retention_probe",
    });

    const observedAt = new Date(Date.UTC(2026, 7, 25, 9, 0, 0));
    await recordProfileSnapshot(handle.db, {
      profile: {
        account: { username: "retention_probe", isPrivate: false },
        followerCount: 10,
        isVerified: false,
        meta: {
          category: ObservationCategory.OBSERVED,
          confidence: Confidence.HIGH,
          observedAt: observedAt.toISOString(),
        },
      },
      evidence: {
        observationKind: "profile_snapshot",
        source: SOURCE,
        observedAt,
        capturedAt: observedAt,
        confidence: Confidence.HIGH,
        rawHash: hash("retention-1"),
      },
    });

    const account = await getAccountByUsername(handle.db, "retention_probe");
    expect(account).not.toBeNull();
    const snapshotsBefore = await listProfileSnapshots(handle.db, account!.id);
    expect(snapshotsBefore).toHaveLength(1);
    const evidenceBefore = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM evidence
    `;
    expect(evidenceBefore[0]!.n).toBe(1);

    await deleteTargetWithObservations(handle.db, target.id);

    expect(await getTarget(handle.db, target.id)).toBeNull();
    const snapshotsAfter = await listProfileSnapshots(handle.db, account!.id);
    expect(snapshotsAfter).toHaveLength(0);
    const evidenceAfter = await handle.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM evidence
    `;
    expect(evidenceAfter[0]!.n).toBe(0);

    const accountAfter = await getAccountByUsername(handle.db, "retention_probe");
    expect(accountAfter).not.toBeNull();
  });
});
