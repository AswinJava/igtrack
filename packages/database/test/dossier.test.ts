import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createTarget,
  getTargetDossier,
  markCapabilityUnavailable,
  recordProfileSnapshot,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// getTargetDossier — the read-back half of D50. The dossier is a REPORT over
// stored observations: this suite pins that it says exactly what is stored —
// nothing outside the owner's scope, no rows invented for an unobserved
// target, and an unavailability reason only from a source that actually
// observed the account.
// ---------------------------------------------------------------------------

const available = await probeDatabase(TEST_DATABASE_URL);

const SOURCE = {
  id: "fixture:v1",
  kind: SourceKind.FIXTURE,
  name: "Fixture v1",
  providerVersion: "v1",
} as const;

// A source that recorded health but never wrote an observation for the
// account: its UNAVAILABLE rows are deployment-wide facts about that route,
// but they are not facts about *this account's* dossier.
const SILENT_SOURCE = {
  id: "graph:v1",
  kind: SourceKind.GRAPH_API,
  name: "Graph v1",
} as const;

const hash = (label: string): string =>
  Buffer.from(label.padEnd(64, "0")).toString("hex").slice(0, 64);

function snapshotInput(username: string, at: Date) {
  return {
    profile: {
      account: { username, isPrivate: false },
      bio: `bio ${username}`,
      followerCount: 7,
      followingCount: 3,
      postCount: 2,
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: at.toISOString(),
      },
    },
    evidence: {
      observationKind: "profile_snapshot",
      source: SOURCE,
      sourceReference: "test/dossier",
      schemaVersion: "v1",
      observedAt: at,
      capturedAt: at,
      confidence: Confidence.HIGH,
      rawHash: hash(`dossier-${username}`),
      normalizedHash: hash(`dossier-norm-${username}`),
    },
  };
}

describe.runIf(available)("getTargetDossier", () => {
  let handle: DatabaseHandle;
  let userA: string;
  let userB: string;
  let targetA: string;
  let unobservedTarget: string;
  const observedAt = new Date(Date.UTC(2026, 7, 24, 10));

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values([{ email: "dossier-a@igtrack.local" }, { email: "dossier-b@igtrack.local" }])
      .returning({ id: users.id });
    userA = rows[0]!.id;
    userB = rows[1]!.id;

    targetA = (await createTarget(handle.db, { userId: userA, username: "dossier_alpha" }))
      .target.id;
    unobservedTarget = (
      await createTarget(handle.db, { userId: userA, username: "dossier_unobserved" })
    ).target.id;
    await createTarget(handle.db, { userId: userB, username: "dossier_beta" });

    await recordProfileSnapshot(handle.db, snapshotInput("dossier_alpha", observedAt));
  });

  afterAll(async () => {
    await handle.close();
  });

  it("is null outside the owner's scope, and for a target that does not exist", async () => {
    expect(await getTargetDossier(handle.db, userB, targetA)).toBeNull();
    expect(await getTargetDossier(handle.db, userA, randomUUID())).toBeNull();
    expect(await getTargetDossier(handle.db, userA, targetA)).not.toBeNull();
  });

  it("counts what is stored and reads the latest snapshot back", async () => {
    const dossier = (await getTargetDossier(handle.db, userA, targetA))!;
    expect(dossier.account.username).toBe("dossier_alpha");
    expect(dossier.counts.profileSnapshots.count).toBe(1);
    expect(dossier.counts.profileSnapshots.latestAt?.toISOString()).toBe(
      observedAt.toISOString(),
    );
    expect(dossier.latestProfileSnapshot?.followerCount).toBe(7);
    expect(dossier.latestProfileSnapshot?.completeness).toBe("COMPLETE");
    // Nothing else was ever observed for this account: counts are counts of
    // stored rows (a fact about this store), not claims about the platform.
    expect(dossier.counts.posts.count).toBe(0);
    expect(dossier.counts.stories.count).toBe(0);
    expect(dossier.counts.followDeltas.count).toBe(0);
    // No media rows stored → no media block at all, never an empty shell.
    expect(dossier.media).toBeNull();
  });

  it("an unobserved target reports zero stored rows, not empty data", async () => {
    const dossier = (await getTargetDossier(handle.db, userA, unobservedTarget))!;
    expect(dossier.counts.profileSnapshots.count).toBe(0);
    expect(dossier.counts.profileSnapshots.latestAt).toBeNull();
    expect(dossier.latestProfileSnapshot).toBeNull();
    expect(dossier.media).toBeNull();
    expect(dossier.observingSources).toEqual([]);
    expect(dossier.routeUnavailability).toEqual([]);
  });

  it("surfaces a route's UNAVAILABLE reason only for sources that observed the account", async () => {
    await markCapabilityUnavailable(handle.db, {
      source: SOURCE,
      capability: "getPublicComments",
      coverageNote: "Instagram exposes no public comment feed for another account's media.",
    });
    await markCapabilityUnavailable(handle.db, {
      source: SILENT_SOURCE,
      capability: "getStoryViewers",
      coverageNote: "Story viewers are only exposed to the account itself.",
    });

    const dossier = (await getTargetDossier(handle.db, userA, targetA))!;
    expect(dossier.observingSources).toEqual(["fixture:v1"]);
    const commentGap = dossier.routeUnavailability.find(
      (r) => r.capability === "getPublicComments",
    );
    expect(commentGap?.sourceId).toBe("fixture:v1");
    expect(commentGap?.note).toContain("no public comment feed");
    // graph:v1 never observed this account — its route limits belong to no
    // dossier this deployment holds observations for.
    expect(
      dossier.routeUnavailability.some((r) => r.sourceId === "graph:v1"),
    ).toBe(false);
  });
});
