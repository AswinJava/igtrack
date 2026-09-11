import { AppError, AppErrorCode, Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import type { Database } from "../client/client.js";
import { upsertAccount } from "../repositories/accounts.js";
import { addClaim, listClaims, retractClaim } from "../repositories/claims.js";
import { createTarget } from "../repositories/targets.js";
import { recordProfileSnapshot } from "../repositories/observations.js";
import { recordStory } from "../repositories/stories.js";
import {
  latestFollowSnapshot,
  persistFollowDiff,
  recordFollowSnapshot,
} from "../repositories/follows.js";
import {
  recordCapabilityFailure,
  recordCapabilitySuccess,
  markCapabilityUnavailable,
} from "../repositories/source-health.js";
import { users } from "../schema/index.js";
import { sql } from "drizzle-orm";

const SYNTHETIC_SOURCE = {
  id: "fixture:v1",
  kind: SourceKind.FIXTURE,
  name: "Synthetic fixture source",
  providerVersion: "v1",
} as const;

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 7, 20, 9, 0, 0);
const at = (daysFromBase: number, hour = 9): Date =>
  new Date(BASE + daysFromBase * DAY + hour * 3_600_000);

const fixedHash = (label: string): string =>
  Buffer.from(`${label}:${"0".repeat(64 - label.length)}`).toString("hex").slice(0, 64);

export async function seed(db: Database): Promise<void> {
  const userRows = await db
    .insert(users)
    .values({
      email: "dev@igtrack.local",
      displayName: "Local Developer (synthetic)",
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  let userId = userRows[0]?.id;
  if (userId === undefined) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`${users.email} = 'dev@igtrack.local'`)
      .limit(1);
    userId = existing[0]?.id;
  }
  if (userId === undefined) throw new Error("igtrack seed: no user");

  const { target } = await createTarget(db, {
    userId,
    username: "target_a",
    localName: "Primary synthetic target",
    tags: ["synthetic", "seed"],
    notes: "Deterministic seed data. All accounts are fictional.",
  });

  for (const person of ["person_alpha", "person_beta", "person_gamma"]) {
    await upsertAccount(db, { username: person, seenAt: at(0) });
  }

  const profileBase = {
    account: {
      username: "target_a",
      igId: "9100000001",
      displayName: "Target A",
      isPrivate: false,
    },
    bio: "Synthetic account used for IGTrack development.",
    profilePicUrl: "https://cdn.igtrack.test/avatars/target_a.jpg",
    isVerified: false,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: "",
    },
  };

  const snapshots = [
    { day: 0, followerCount: 420, followingCount: 87, postCount: 12 },
    { day: 1, followerCount: 427, followingCount: 87, postCount: 13 },
    { day: 2, followerCount: 431, followingCount: 88, postCount: 13 },
  ];
  for (const s of snapshots) {
    const observedAt = at(s.day);
    await recordProfileSnapshot(db, {
      profile: {
        ...profileBase,
        followerCount: s.followerCount,
        followingCount: s.followingCount,
        postCount: s.postCount,
        meta: { ...profileBase.meta, observedAt: observedAt.toISOString() },
      },
      evidence: {
        observationKind: "profile_snapshot",
        source: SYNTHETIC_SOURCE,
        sourceReference: "seed:v1/profile",
        schemaVersion: "v1",
        observedAt,
        capturedAt: observedAt,
        confidence: Confidence.HIGH,
        rawHash: fixedHash(`profile-${s.day}`),
        normalizedHash: fixedHash(`profile-norm-${s.day}`),
        metadata: { synthetic: true },
      },
    });
  }

  const storyObservedAt = at(2, 18);
  await recordStory(db, {
    owner: profileBase.account,
    sourceId: SYNTHETIC_SOURCE.id,
    story: {
      storyId: "seed-story-1",
      mediaType: "IMAGE",
      takenAt: at(2, 17).toISOString(),
      expiresAt: at(3, 17).toISOString(),
      caption: "Synthetic story for development",
      hasLink: false,
      stickerKinds: ["mention"],
      mentions: [
        {
          account: {
            username: "person_alpha",
            igId: "9100000002",
            isPrivate: false,
          },
          geometry: {
            x: 420,
            y: 1500,
            width: 240,
            height: 60,
            canvasWidth: 1080,
            canvasHeight: 1920,
          },
          rawVisibilityFlag: false,
          visibilityClass: "VISIBLE",
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.HIGH,
            observedAt: storyObservedAt.toISOString(),
          },
        },
        {
          account: { username: "person_beta", isPrivate: false },
          visibilityClass: "METADATA_ONLY",
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.LOW,
            observedAt: storyObservedAt.toISOString(),
          },
        },
      ],
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: storyObservedAt.toISOString(),
      },
    },
    evidence: {
      observationKind: "story",
      source: SYNTHETIC_SOURCE,
      sourceReference: "seed:v1/stories",
      schemaVersion: "v1",
      observedAt: storyObservedAt,
      capturedAt: storyObservedAt,
      confidence: Confidence.HIGH,
      rawHash: fixedHash("seed-story-1"),
      metadata: { synthetic: true },
    },
  });

  const snap1 = await recordFollowSnapshot(db, {
    targetId: target.id,
    direction: "FOLLOWING",
    source: SYNTHETIC_SOURCE,
    takenAt: at(1),
    evidence: {
      observationKind: "follow_snapshot",
      source: SYNTHETIC_SOURCE,
      sourceReference: "seed:v1/following",
      schemaVersion: "v1",
      observedAt: at(1),
      capturedAt: at(1),
      confidence: Confidence.HIGH,
      rawHash: fixedHash("follow-snap-1"),
      normalizedHash: fixedHash("follow-snap-norm-1"),
      metadata: { synthetic: true },
    },
    page: {
      entries: [
        { username: "person_alpha", igId: "9100000002" },
        { username: "person_beta", igId: "9100000003" },
      ],
      complete: true,
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: at(1).toISOString(),
      },
    },
  });
  const snap2 = await recordFollowSnapshot(db, {
    targetId: target.id,
    direction: "FOLLOWING",
    source: SYNTHETIC_SOURCE,
    takenAt: at(2),
    evidence: {
      observationKind: "follow_snapshot",
      source: SYNTHETIC_SOURCE,
      sourceReference: "seed:v1/following",
      schemaVersion: "v1",
      observedAt: at(2),
      capturedAt: at(2),
      confidence: Confidence.HIGH,
      rawHash: fixedHash("follow-snap-2"),
      normalizedHash: fixedHash("follow-snap-norm-2"),
      metadata: { synthetic: true },
    },
    page: {
      entries: [
        { username: "person_alpha", igId: "9100000002" },
        { username: "person_gamma", igId: "9100000004" },
      ],
      complete: true,
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: at(2).toISOString(),
      },
    },
  });
  if (!snap1.deduplicated && !snap2.deduplicated) {
    await persistFollowDiff(db, {
      targetId: target.id,
      direction: "FOLLOWING",
      fromSnapshotId: snap1.snapshot.id,
      toSnapshotId: snap2.snapshot.id,
    });
  }

  await recordCapabilitySuccess(db, {
    source: SYNTHETIC_SOURCE,
    capability: "getProfile",
    latencyMs: 12,
  });
  await recordCapabilitySuccess(db, {
    source: SYNTHETIC_SOURCE,
    capability: "getStories",
    latencyMs: 30,
  });
  await recordCapabilityFailure(db, {
    source: SYNTHETIC_SOURCE,
    capability: "getFollowers",
    reason: "seed: simulated transient failure",
    errorCategory: "NETWORK",
  });
  await markCapabilityUnavailable(db, {
    source: SYNTHETIC_SOURCE,
    capability: "getLikesHistory",
    coverageNote:
      "Instagram does not expose a complete public feed of everything an account liked.",
  });

  // Claims fixtures: a corroborated pair on one predicate, a
  // conflicting pair on another, an operator assertion, one retracted row, and
  // one past the 180-day review horizon. Fixed dates, like the rest of the
  // seed; relation labels are computed at read time from exactly these rows.
  const seedClaims: Array<{
    predicate:
      | "ORGANIZATION_NAME"
      | "LOCATION_STATED"
      | "CONTACT_CHANNEL"
      | "PRODUCT_OR_SERVICE"
      | "HISTORICAL_CHANGE_STATED";
    value: string;
    sourceUrl?: string;
    sourceTitle?: string;
    excerpt?: string;
    statedAt?: Date;
    retrievedAt?: Date;
  }> = [
    {
      predicate: "ORGANIZATION_NAME",
      value: "Aurora Print Studio",
      sourceUrl: "https://auroraprint.example.org/about",
      sourceTitle: "About — Aurora Print Studio",
      excerpt: "Aurora Print Studio is a two-person printing studio.",
      statedAt: at(-30),
      retrievedAt: at(1),
    },
    {
      predicate: "ORGANIZATION_NAME",
      value: "Aurora Print Studio",
      sourceUrl: "https://directory.example.net/aurora-print-studio",
      sourceTitle: "Craft directory listing",
      excerpt: "Aurora Print Studio — listing in the craft directory.",
      retrievedAt: at(1),
    },
    {
      predicate: "LOCATION_STATED",
      value: "Lisbon",
      sourceUrl: "https://news.example.com/aurora-lisbon",
      excerpt: "The studio works out of Lisbon.",
      retrievedAt: at(2),
    },
    {
      predicate: "LOCATION_STATED",
      value: "Porto",
      sourceUrl: "https://blog.example.org/aurora-porto",
      excerpt: "Based in Porto since the move.",
      retrievedAt: at(2),
    },
    {
      predicate: "CONTACT_CHANNEL",
      value: "studio@aurora.example",
      // Operator assertion: no source URL, so it can support but never
      // corroborate a value.
    },
    {
      predicate: "PRODUCT_OR_SERVICE",
      value: "Ceramics",
      sourceUrl: "https://auroraprint.example.org/services",
      excerpt: "The studio also sells ceramics.",
      retrievedAt: at(2),
    },
    {
      predicate: "HISTORICAL_CHANGE_STATED",
      value: "Moved from Lisbon to Porto",
      sourceUrl: "https://blog.example.org/aurora-porto",
      excerpt: "We left Lisbon for Porto last spring.",
      statedAt: at(-240),
      retrievedAt: at(-200),
    },
  ];
  for (const claim of seedClaims) {
    try {
      await addClaim(db, {
        userId,
        targetId: target.id,
        predicate: claim.predicate,
        value: claim.value,
        sourceKind: claim.sourceUrl === undefined ? "OPERATOR" : "WEB",
        ...(claim.sourceUrl !== undefined ? { sourceUrl: claim.sourceUrl } : {}),
        ...(claim.sourceTitle !== undefined ? { sourceTitle: claim.sourceTitle } : {}),
        ...(claim.excerpt !== undefined ? { excerpt: claim.excerpt } : {}),
        ...(claim.statedAt !== undefined ? { statedAt: claim.statedAt } : {}),
        ...(claim.retrievedAt !== undefined ? { retrievedAt: claim.retrievedAt } : {}),
      });
    } catch (err) {
      // Re-running the seed is expected: an identical existing claim is the
      // same finding (dedup refused the repeat), not an error.
      if (!(err instanceof AppError && err.code === AppErrorCode.CONFLICT)) throw err;
    }
  }
  const ceramics = (
    await listClaims(db, {
      userId,
      targetId: target.id,
      predicate: "PRODUCT_OR_SERVICE",
      includeRetracted: true,
    })
  ).find((row) => row.value === "Ceramics");
  if (ceramics !== undefined && ceramics.status === "ACTIVE") {
    await retractClaim(db, {
      userId,
      claimId: ceramics.id,
      reason: "Source updated: the ceramics service was discontinued — row kept for the record.",
    });
  }

  // The seed writes its OWN observations, with their own evidence and the
  // synthetic source id. It deliberately enqueues NO provider scan: a scan is
  // executed by whatever provider the deployment has configured, and that
  // provider observes a bounded set of accounts — `target_a` is not one of
  // them. Queueing it would produce a job that can only fail, and (before the
  // worker's identity gate) a job that filed the fixture set's synthetic
  // roster under this account. The demo flow is: add a target the configured
  // source can observe, then `igtrack scans run` and `igtrack work`.

  const latest = await latestFollowSnapshot(db, target.id, "FOLLOWING");
  if (latest === null) {
    throw new Error("igtrack seed: follow snapshot missing after seed");
  }
}
