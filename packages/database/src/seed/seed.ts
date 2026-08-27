import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import type { Database } from "../client/client.js";
import { upsertAccount } from "../repositories/accounts.js";
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
import { enqueueJob } from "../jobs/queue.js";
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

  await enqueueJob(db, {
    kind: "PROFILE_SCAN",
    targetId: target.id,
    idempotencyKey: "seed:profile-scan:day-2",
    payload: { synthetic: true },
  });

  const latest = await latestFollowSnapshot(db, target.id, "FOLLOWING");
  if (latest === null) {
    throw new Error("igtrack seed: follow snapshot missing after seed");
  }
}
