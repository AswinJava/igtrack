import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createTarget,
  enqueueJob,
  listStories,
  recordStory,
  recordStorySighting,
  sightingSummariesForAccount,
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
} as const;

const hash = (label: string): string =>
  Buffer.from(label.padEnd(64, "0")).toString("hex").slice(0, 64);

const T0 = new Date(Date.UTC(2026, 7, 26, 18, 0, 0));
const T1 = new Date(Date.UTC(2026, 7, 26, 18, 30, 0));

function storyInput() {
  return {
    owner: { username: "sighting_target", igId: "9100000099" },
    sourceId: SOURCE.id,
    story: {
      storyId: "sighting-1",
      mediaType: "IMAGE" as const,
      takenAt: new Date(Date.UTC(2026, 7, 26, 17, 0, 0)).toISOString(),
      hasLink: false,
      stickerKinds: [],
      mentions: [],
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: T0.toISOString(),
      },
    },
    evidence: {
      observationKind: "story",
      source: SOURCE,
      observedAt: T0,
      capturedAt: T0,
      confidence: Confidence.HIGH,
      rawHash: hash("sighting-1"),
    },
  };
}

describe.runIf(available)("story sightings", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "sightings@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
    const { target } = await createTarget(handle.db, {
      userId,
      username: "sighting_target",
    });
    accountId = target.igAccountId;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("records first observation with an empty sighting summary", async () => {
    const recorded = await recordStory(handle.db, storyInput());
    expect(recorded.deduplicated).toBe(false);
    const summaries = await sightingSummariesForAccount(handle.db, accountId);
    expect(summaries[recorded.story.id]).toBeUndefined();
  });

  it("re-observations append sightings without touching the story row", async () => {
    const { target } = await createTarget(handle.db, { userId, username: "sighting_jobs" });
    const jobIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { job } = await enqueueJob(handle.db, { kind: "STORY_SCAN", targetId: target.id });
      jobIds.push(job.id);
    }
    const first = await recordStory(handle.db, storyInput());
    expect(first.deduplicated).toBe(true);
    await recordStorySighting(handle.db, {
      storyDbId: first.story.id,
      observedAt: T0,
      jobId: jobIds[0]!,
    });
    await recordStorySighting(handle.db, {
      storyDbId: first.story.id,
      observedAt: T1,
      jobId: jobIds[1]!,
    });
    // Idempotent on (story, observed_at): a retried scan collapses.
    await recordStorySighting(handle.db, {
      storyDbId: first.story.id,
      observedAt: T1,
      jobId: jobIds[2]!,
    });
    const summaries = await sightingSummariesForAccount(handle.db, accountId);
    const summary = summaries[first.story.id];
    expect(summary?.count).toBe(2);
    expect(summary?.firstSeenAt?.toISOString()).toBe(T0.toISOString());
    expect(summary?.lastSeenAt?.toISOString()).toBe(T1.toISOString());
    // The immutable story row still carries first-observation timestamps.
    const rows = await listStories(handle.db, accountId, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observedAt.toISOString()).toBe(T0.toISOString());
  });
});
