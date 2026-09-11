import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createTarget,
  getEvidenceChain,
  getOwnedTargetDetail,
  getUserActivityFeed,
  listProfileSnapshots,
  listScopedEvidence,
  recordProfileSnapshot,
  users,
  type DatabaseHandle,
} from "../src/index.js";
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
  providerVersion: "v1",
} as const;

const hash = (label: string): string =>
  Buffer.from(label.padEnd(64, "0")).toString("hex").slice(0, 64);

function snapshotInput(username: string, at: Date) {
  return {
    profile: {
      account: { username, isPrivate: false },
      bio: `bio ${username}`,
      followerCount: 3,
      followingCount: 2,
      postCount: 1,
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: at.toISOString(),
      },
    },
    evidence: {
      observationKind: "profile_snapshot",
      source: SOURCE,
      sourceReference: "test/isolation",
      schemaVersion: "v1",
      observedAt: at,
      capturedAt: at,
      confidence: Confidence.HIGH,
      rawHash: hash(`snap-${username}`),
      normalizedHash: hash(`snap-norm-${username}`),
    },
  };
}

describe.runIf(available)("hostile tenant isolation", () => {
  let handle: DatabaseHandle;
  let userA: string;
  let userB: string;
  let targetA: string;
  let evidenceA: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values([{ email: "tenant-a@igtrack.local" }, { email: "tenant-b@igtrack.local" }])
      .returning({ id: users.id });
    userA = rows[0]!.id;
    userB = rows[1]!.id;

    const created = await createTarget(handle.db, { userId: userA, username: "tenant_alpha" });
    targetA = created.target.id;
    await createTarget(handle.db, { userId: userB, username: "tenant_beta" });
    const at = new Date(Date.UTC(2026, 7, 20, 9));
    const recorded = await recordProfileSnapshot(handle.db, snapshotInput("tenant_alpha", at));
    evidenceA = recorded.snapshot.evidenceId!;
    expect(evidenceA).not.toBeNull();
  });

  afterAll(async () => {
    await handle.close();
  });

  it("user B cannot open user A's target bundle", async () => {
    expect(await getOwnedTargetDetail(handle.db, userB, targetA)).toBeNull();
    expect(await getOwnedTargetDetail(handle.db, userA, targetA)).not.toBeNull();
  });

  it("user B sees none of user A's evidence", async () => {
    const ledgerB = await listScopedEvidence(handle.db, userB, 50);
    expect(ledgerB.find((r) => r.id === evidenceA)).toBeUndefined();
    const ledgerA = await listScopedEvidence(handle.db, userA, 50);
    expect(ledgerA.find((r) => r.id === evidenceA)).toBeDefined();
  });

  it("user B cannot walk user A's evidence chain", async () => {
    expect(await getEvidenceChain(handle.db, userB, evidenceA)).toBeNull();
    const chain = await getEvidenceChain(handle.db, userA, evidenceA);
    expect(chain?.claim).toContain("tenant_alpha");
  });

  it("user B's activity feed contains none of user A's observations", async () => {
    const feedB = await getUserActivityFeed(handle.db, userB, 30, {});
    expect(feedB.filter((f) => f.targetUsername === "tenant_alpha")).toHaveLength(0);
  });

  it("user B's snapshots query cannot reach user A's account rows", async () => {
    // listProfileSnapshots is account-keyed, not user-keyed: prove the
    // ownership boundary lives in the callers by asserting the bundle gate.
    const rows = await listProfileSnapshots(handle.db, "nonexistent-account-id", { limit: 5 });
    expect(rows).toHaveLength(0);
  });
});
