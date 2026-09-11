import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Confidence, ObservationCategory, SourceKind } from "@igtrack/core";
import {
  createTarget,
  listMentionsForStory,
  listStories,
  recordStory,
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

const OBSERVED = new Date(Date.UTC(2026, 7, 26, 18, 0, 0));

function storyInput() {
  return {
    owner: {
      username: "target_a",
      igId: "9100000001",
      displayName: "Target A",
      isPrivate: false,
    },
    sourceId: SOURCE.id,
    story: {
      storyId: "story-1001",
      mediaType: "IMAGE" as const,
      takenAt: new Date(Date.UTC(2026, 7, 26, 17, 0, 0)).toISOString(),
      expiresAt: new Date(Date.UTC(2026, 7, 27, 17, 0, 0)).toISOString(),
      caption: "test story",
      hasLink: true,
      stickerKinds: ["mention", "link"],
      mentions: [
        {
          account: { username: "person_alpha", igId: "9100000002", isPrivate: false },
          geometry: {
            x: 420,
            y: 1500,
            width: 240,
            height: 60,
            canvasWidth: 1080,
            canvasHeight: 1920,
          },
          rawVisibilityFlag: false,
          visibilityClass: "VISIBLE" as const,
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.HIGH,
            observedAt: OBSERVED.toISOString(),
          },
        },
        {
          account: { username: "person_beta", isPrivate: false },
          visibilityClass: "METADATA_ONLY" as const,
          meta: {
            category: ObservationCategory.OBSERVED,
            confidence: Confidence.LOW,
            observedAt: OBSERVED.toISOString(),
          },
        },
      ],
      meta: {
        category: ObservationCategory.OBSERVED,
        confidence: Confidence.HIGH,
        observedAt: OBSERVED.toISOString(),
      },
    },
    evidence: {
      observationKind: "story",
      source: SOURCE,
      observedAt: OBSERVED,
      capturedAt: OBSERVED,
      confidence: Confidence.HIGH,
      rawHash: hash("story-1001"),
    },
  };
}

describe.runIf(available)("stories & mentions", () => {
  let handle: DatabaseHandle;
  let userId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "stories@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
    await createTarget(handle.db, { userId, username: "target_a" });
  });

  afterAll(async () => {
    await handle.close();
  });

  it("records a story with classified mentions", async () => {
    const result = await recordStory(handle.db, storyInput());
    expect(result.deduplicated).toBe(false);
    expect(result.story.hasLink).toBe(true);
    expect(result.story.stickerKinds).toEqual(["mention", "link"]);
    expect(result.mentions).toHaveLength(2);

    const visible = result.mentions.find(
      (m) => m.visibilityClass === "VISIBLE",
    );
    expect(visible?.positionX).toBe(420);
    expect(visible?.rawVisibilityFlag).toBe(false);
    const metadataOnly = result.mentions.find(
      (m) => m.visibilityClass === "METADATA_ONLY",
    );
    expect(metadataOnly?.positionX).toBeNull();
    expect(metadataOnly?.confidence).toBe("LOW");
  });

  it("deduplicates story re-ingestion without duplicating mentions", async () => {
    const first = await recordStory(handle.db, storyInput());
    expect(first.deduplicated).toBe(true);

    const stories = await listStories(handle.db, first.story.igAccountId);
    expect(stories).toHaveLength(1);
    const mentions = await listMentionsForStory(handle.db, first.story.id);
    expect(mentions).toHaveLength(2);
  });
});
