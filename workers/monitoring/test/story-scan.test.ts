import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtemp, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  available,
  CapabilityErrorKind,
  Confidence,
  CapabilityStatus,
  ObservationCategory,
  partial,
  SourceKind,
  unavailable,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedAccountRef,
  type NormalizedStory,
} from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  evidence as evidenceTable,
  getSourceHealth,
  igAccounts,
  stories as storiesTable,
  storyMentions,
  targets,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { FixtureProvider } from "@igtrack/ingestion";
import { runStoryScan } from "../src/provider.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-27T14:00:00.000Z";

function storyFixture(id: string, mentions: NormalizedStory["mentions"]): NormalizedStory {
  return {
    storyId: id,
    mediaType: "IMAGE",
    takenAt: OBSERVED_AT,
    expiresAt: "2026-08-28T14:00:00.000Z",
    hasLink: false,
    stickerKinds: [],
    mentions,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: OBSERVED_AT,
    },
  };
}

interface StorySourceConfig {
  stories?: NormalizedStory[];
  status?: CapabilityStatus;
  note?: string;
  rawPayloadHash?: string;
  rawReference?: string;
  capabilityAvailable?: boolean;
  sourceId?: string;
}

function storySource(config: StorySourceConfig = {}): ExecutionSource {
  const sourceId = config.sourceId ?? "stub:story";
  const sourceRef = { sourceId, kind: SourceKind.FIXTURE };
  const status = config.status ?? CapabilityStatus.AVAILABLE;
  const provider: InstagramProvider = {
    sourceId,
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: config.capabilityAvailable ?? true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: true,
    }),
    resolveAccount: async () => {
      throw new Error("stub: resolveAccount not wired");
    },
    getProfile: async () => {
      throw new Error("stub: getProfile not wired");
    },
    getStories: async (): Promise<CapabilityResult<NormalizedStory[]>> => {
      if (status === CapabilityStatus.UNAVAILABLE) {
        return unavailable(
          { observedAt: OBSERVED_AT, source: sourceRef },
          config.note ?? "Stories unavailable from this source.",
        );
      }
      if (status === CapabilityStatus.PARTIAL) {
        return partial(config.stories ?? [], {
          observedAt: OBSERVED_AT,
          source: sourceRef,
          confidence: Confidence.MEDIUM,
          note: config.note ?? "Partial story result",
          ...(config.rawPayloadHash !== undefined
            ? { rawPayloadHash: config.rawPayloadHash }
            : {}),
        });
      }
      return available(config.stories ?? [], {
        observedAt: OBSERVED_AT,
        source: sourceRef,
        confidence: Confidence.HIGH,
        ...(config.rawPayloadHash !== undefined
          ? { rawPayloadHash: config.rawPayloadHash }
          : {}),
        ...(config.rawReference !== undefined
          ? { rawReference: config.rawReference }
          : {}),
      });
    },
    getFollowers: async () => {
      throw new Error("stub: getFollowers not wired");
    },
    getFollowing: async () => {
      throw new Error("stub: getFollowing not wired");
    },
    getPublicPosts: async () => {
      throw new Error("stub: getPublicPosts not wired");
    },
    getPublicComments: async () => {
      throw new Error("stub: getPublicComments not wired");
    },
  };
  return {
    provider,
    source: { id: sourceId, kind: SourceKind.FIXTURE, name: "story stub" },
  };
}

async function realFixtureSource(): Promise<ExecutionSource> {
  const version = "v1";
  const repoFixtures = join(
    tmpdir(),
    `igtrack-story-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(repoFixtures, { recursive: true });
  // Copy the real repo fixture set so the scan exercises genuine normalization.
  const { readFile } = await import("node:fs/promises");
  const manifestText = await readFile(
    join(process.cwd(), "packages", "ingestion", "fixtures", version, "manifest.json"),
    "utf8",
  );
  await writeFile(join(repoFixtures, "manifest.json"), manifestText);
  for (const file of ["profile.json", "stories.json"]) {
    await copyFile(
      join(process.cwd(), "packages", "ingestion", "fixtures", version, file),
      join(repoFixtures, file),
    );
  }
  const provider = new FixtureProvider({ fixturesDir: repoFixtures });
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "story fixture" },
  };
}

async function malformedStoriesSource(): Promise<ExecutionSource> {
  const dir = await mkdtemp(join(tmpdir(), "igtrack-story-bad-"));
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: "v1",
      target_username: "aurora.wilde",
      captured_at: OBSERVED_AT,
      files: {
        profile: "profile.json",
        stories: "stories.json",
        followers: [],
        following: [],
        posts: [],
        comments: {},
      },
    }),
  );
  await writeFile(join(dir, "stories.json"), "{ broken json");
  const provider = new FixtureProvider({ fixturesDir: dir });
  return {
    provider,
    source: { id: provider.sourceId, kind: SourceKind.FIXTURE, name: "malformed story fixture" },
  };
}

describe.runIf(dbAvailable)("worker STORY_SCAN", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "story-scan@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function makeTarget(): Promise<string> {
    targetCounter += 1;
    const { target } = await createTarget(handle.db, {
      userId,
      username: `story_target_${targetCounter}`,
    });
    return target.id;
  }

  async function makeJob(targetId: string): Promise<JobRecord> {
    const { job } = await enqueueJob(handle.db, {
      kind: "STORY_SCAN",
      targetId,
    });
    const claimed = await claimJob(handle.db, "worker-story");
    if (claimed === null || claimed.id !== job.id) {
      throw new Error("test setup: expected to claim the freshly enqueued job");
    }
    return claimed;
  }

  async function storyRows(targetId: string) {
    return handle.db
      .select({
        storyId: storiesTable.storyId,
        id: storiesTable.id,
        mediaType: storiesTable.mediaType,
        expiresAt: storiesTable.expiresAt,
        hasLink: storiesTable.hasLink,
        evidenceId: storiesTable.evidenceId,
      })
      .from(storiesTable)
      .innerJoin(igAccounts, sql`${igAccounts.id} = ${storiesTable.igAccountId}`)
      .innerJoin(targets, sql`${targets.igAccountId} = ${storiesTable.igAccountId}`)
      .where(sql`${targets.id} = ${targetId}`)
      .orderBy(storiesTable.storyId);
  }

  async function mentionRowsFor(storyDbId: string) {
    return handle.db
      .select({
        visibilityClass: storyMentions.visibilityClass,
        username: igAccounts.username,
        evidenceId: storyMentions.evidenceId,
      })
      .from(storyMentions)
      .innerJoin(igAccounts, sql`${igAccounts.id} = ${storyMentions.mentionedAccountId}`)
      .where(sql`${storyMentions.storyDbId} = ${storyDbId}`);
  }

  it("AVAILABLE with stories → story + mention rows + evidence (ST1)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = storySource({
      rawPayloadHash: "a".repeat(64),
      rawReference: "fixture:v1/stories.json",
      stories: [
        storyFixture("story-1", [
          {
            account: { username: "noah.frames", igId: "9000000002" },
            visibilityClass: "VISIBLE",
            meta: { category: "OBSERVED", confidence: "HIGH", observedAt: OBSERVED_AT },
          },
        ]),
        storyFixture("story-2", []),
      ],
    });

    const result = await runStoryScan(handle.db, job, src);
    expect(result).toBe("succeeded");

    const rows = await storyRows(targetId);
    expect(rows.map((r) => r.storyId)).toEqual(["story-1", "story-2"]);
    expect(rows[0]?.evidenceId).not.toBeNull();
    expect(rows[0]?.expiresAt).not.toBeNull();

    const mentions = await mentionRowsFor(rows[0]!.id);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.username).toBe("noah.frames");
    expect(mentions[0]?.visibilityClass).toBe("VISIBLE");
    expect(mentions[0]?.evidenceId).not.toBeNull();
  });

  it("AVAILABLE with zero stories → honest success, no fabricated rows (ST2)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = storySource({ stories: [] });

    const result = await runStoryScan(handle.db, job, src);
    expect(result).toBe("succeeded-empty");

    expect(await storyRows(targetId)).toHaveLength(0);
    const health = await getSourceHealth(handle.db, "stub:story");
    expect(health.find((h) => h.capability === "getStories")?.status).toBe("HEALTHY");
  });

  it("UNAVAILABLE → no story rows, no 'no story' claims, source health UNAVAILABLE (ST3, ST8)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = storySource({ status: CapabilityStatus.UNAVAILABLE });

    const result = await runStoryScan(handle.db, job, src);
    expect(result).toBe("unavailable");

    expect(await storyRows(targetId)).toHaveLength(0);
    const health = await getSourceHealth(handle.db, "stub:story");
    expect(health.find((h) => h.capability === "getStories")?.status).toBe("UNAVAILABLE");
  });

  it("capability off → UNAVAILABLE, no rows (ST3)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = storySource({ capabilityAvailable: false });

    const result = await runStoryScan(handle.db, job, src);
    expect(result).toBe("unavailable");
    expect(await storyRows(targetId)).toHaveLength(0);
  });

  it("PARTIAL is preserved, never upgraded (ST4)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = storySource({
      status: CapabilityStatus.PARTIAL,
      stories: [storyFixture("story-p1", [])],
      note: "Story tray truncated by source",
    });

    const result = await runStoryScan(handle.db, job, src);
    expect(result).toBe("succeeded-partial");

    const rows = await storyRows(targetId);
    expect(rows).toHaveLength(1);
    const ev = await handle.db
      .select({ metadata: evidenceTable.metadata })
      .from(evidenceTable)
      .where(sql`${evidenceTable.id} = ${rows[0]?.evidenceId}`);
    expect((ev[0]?.metadata as { completion?: string })?.completion).toBe("PARTIAL");
  });

  it("malformed story fixture → non-retryable SCHEMA_MISMATCH, no rows (ST5)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);

    await expect(runStoryScan(handle.db, job, await malformedStoriesSource()))
      .rejects.toMatchObject({
        name: "JobExecutionError",
        kind: CapabilityErrorKind.SCHEMA_MISMATCH,
        retryable: false,
      });
    expect(await storyRows(targetId)).toHaveLength(0);
  });

  it("duplicate story ingestion across logical scans dedupes (ST6)", async () => {
    const targetId = await makeTarget();
    const stories = [
      storyFixture("story-dup", [
        {
          account: { username: "repeat.person" },
          visibilityClass: "METADATA_ONLY",
          meta: { category: "OBSERVED", confidence: "LOW", observedAt: OBSERVED_AT },
        },
      ]),
    ];

    const job1 = await makeJob(targetId);
    await runStoryScan(handle.db, job1, storySource({ stories }));
    await completeJob(handle.db, job1.id, "worker-story");

    const job2 = await makeJob(targetId);
    await runStoryScan(handle.db, job2, storySource({ stories }));

    const rows = await storyRows(targetId);
    expect(rows).toHaveLength(1);
    const mentions = await mentionRowsFor(rows[0]!.id);
    expect(mentions).toHaveLength(1);
  });

  it("mention evidence carries story linkage, source, timestamps, confidence, hashes (ST7, ST9)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = storySource({
      rawPayloadHash: "b".repeat(64),
      rawReference: "fixture:v1/stories.json",
      stories: [
        storyFixture("story-ev", [
          {
            account: { username: "evidence.check" },
            visibilityClass: "POSSIBLY_HIDDEN",
            rawVisibilityFlag: true,
            meta: { category: "OBSERVED", confidence: "HIGH", observedAt: OBSERVED_AT },
          },
        ]),
      ],
    });

    await runStoryScan(handle.db, job, src);

    const story = (await storyRows(targetId))[0]!;
    const storyEv = await handle.db
      .select()
      .from(evidenceTable)
      .where(sql`${evidenceTable.id} = ${story.evidenceId}`);
    expect(storyEv[0]?.rawHash).toBe("b".repeat(64));
    expect(storyEv[0]?.sourceReference).toBe("fixture:v1/stories.json");

    const mention = (await mentionRowsFor(story.id))[0]!;
    const mentionEv = await handle.db
      .select()
      .from(evidenceTable)
      .where(sql`${evidenceTable.id} = ${mention.evidenceId}`);
    const metadata = mentionEv[0]?.metadata as
      | { storyId?: string; classification?: string; mentionedUsername?: string }
      | undefined;
    expect(metadata?.storyId).toBe("story-ev");
    expect(metadata?.classification).toBe("POSSIBLY_HIDDEN");
    expect(metadata?.mentionedUsername).toBe("evidence.check");
    expect(mentionEv[0]?.rawHash).toBe("b".repeat(64));
    expect(mentionEv[0]?.normalizedHash).not.toBeNull();
  });

  it("stub provider without raw payload keeps raw_hash NULL (ST9, Phase 5 E-invariant)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);
    const src = storySource({ stories: [storyFixture("story-noraw", [])] });

    await runStoryScan(handle.db, job, src);

    const story = (await storyRows(targetId))[0]!;
    const storyEv = await handle.db
      .select({ rawHash: evidenceTable.rawHash })
      .from(evidenceTable)
      .where(sql`${evidenceTable.id} = ${story.evidenceId}`);
    expect(storyEv[0]?.rawHash).toBeNull();
  });

  it("real fixture set end-to-end: normalizes stories and classifies every mention variant (ST7)", async () => {
    const targetId = await makeTarget();
    const job = await makeJob(targetId);

    const result = await runStoryScan(handle.db, job, await realFixtureSource());
    expect(result).toBe("succeeded");

    const rows = await storyRows(targetId);
    expect(rows.map((r) => r.storyId)).toEqual(["story-1001", "story-1002", "story-1003"]);

    const byStory = new Map<string, Awaited<ReturnType<typeof mentionRowsFor>>>();
    for (const row of rows) {
      byStory.set(row.storyId, await mentionRowsFor(row.id));
    }
    expect(byStory.get("story-1001")?.[0]?.visibilityClass).toBe("VISIBLE");
    expect(byStory.get("story-1002")?.[0]?.visibilityClass).toBe("POSSIBLY_HIDDEN");
    expect(
      byStory.get("story-1003")?.find((m) => m.username === "theo.north")?.visibilityClass,
    ).toBe("OFF_CANVAS");
    expect(
      byStory.get("story-1003")?.find((m) => m.username === "ivy.cast")?.visibilityClass,
    ).toBe("METADATA_ONLY");
  });
});
