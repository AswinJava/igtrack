import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  available,
  CapabilityErrorKind,
  CapabilityStatus,
  Confidence,
  errored,
  ObservationCategory,
  SourceKind,
  unavailable,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedTagPage,
  type NormalizedTaggedMedia,
} from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  getSourceHealth,
  users,
  type DatabaseHandle,
} from "@igtrack/database";
import { JobExecutionError, runTagsScan } from "../src/provider.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

// ---------------------------------------------------------------------------
// TAGS_SCAN — the documented IG User tags edge of the OWNED account. The
// behavior worth pinning is the epistemics, not "rows get stored":
//   * append-only first-observation-wins: a re-scan never rewrites a stored
//     row, and a row leaving a later listing is never claimed as removed;
//   * a capped or truncated read completes PARTIAL and records that fact in
//     the listing evidence — it must never read as "these are all the tags";
//   * rows are references to media owned by OTHER accounts, never this
//     account's own media;
//   * the mode guard holds at execution, not only at enqueue (D47/D59).
// ---------------------------------------------------------------------------

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-08-27T09:20:00.000Z";
const FIRST_SEEN_AT = "2026-08-26T10:00:00.000Z";
const LATER_SEEN_AT = "2026-08-27T10:00:00.000Z";

function tagged(
  mediaId: string,
  overrides: Partial<NormalizedTaggedMedia> = {},
): NormalizedTaggedMedia {
  return {
    mediaId,
    ownerUsername: "mira.lens",
    caption: `tagged media ${mediaId}`,
    permalink: `https://www.instagram.com/p/${mediaId}/`,
    mediaType: "IMAGE",
    takenAt: "2026-08-25T15:40:00.000Z",
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: FIRST_SEEN_AT,
    },
    ...overrides,
  };
}

type PageSpec =
  | { kind: "available"; items: NormalizedTaggedMedia[] }
  | { kind: "partial"; items: NormalizedTaggedMedia[]; nextCursor?: string }
  | { kind: "unavailable"; note?: string }
  | { kind: "error"; message?: string };

interface TagsStub {
  source: ExecutionSource;
  calls: () => number;
  cursors: () => Array<string | undefined>;
}

/** A provider double that serves one canned page per getTags call. */
function tagsSource(
  pages: PageSpec[],
  options: { capabilityAvailable?: boolean; sourceId?: string } = {},
): TagsStub {
  const sourceId = options.sourceId ?? "stub:tags";
  const sourceRef = { sourceId, kind: SourceKind.FIXTURE };
  const meta = { observedAt: OBSERVED_AT, source: sourceRef };
  let calls = 0;
  const cursors: Array<string | undefined> = [];

  const unwired =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(`stub: ${name} not wired`);
    };

  const provider: InstagramProvider = {
    sourceId,
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: false,
      getFollowing: false,
      getPublicPosts: true,
      getPublicComments: true,
      getPostChildren: false,
      getTags: options.capabilityAvailable ?? true,
      getMentionedComment: false,
      getAccountInsights: false,
      discoverAccount: false,
    }),
    getTags: async (
      _account,
      cursor,
    ): Promise<CapabilityResult<NormalizedTagPage>> => {
      const spec = pages[Math.min(calls, pages.length - 1)]!;
      calls += 1;
      cursors.push(cursor?.value);
      if (spec.kind === "available") {
        return available(
          {
            items: spec.items,
            complete: true,
            meta: {
              category: ObservationCategory.OBSERVED,
              confidence: Confidence.HIGH,
              observedAt: OBSERVED_AT,
            },
          },
          { ...meta, confidence: Confidence.HIGH },
        );
      }
      if (spec.kind === "partial") {
        return {
          status: CapabilityStatus.PARTIAL,
          data: {
            items: spec.items,
            complete: false,
            ...(spec.nextCursor !== undefined ? { nextCursor: spec.nextCursor } : {}),
            meta: {
              category: ObservationCategory.OBSERVED,
              confidence: Confidence.MEDIUM,
              observedAt: OBSERVED_AT,
            },
          },
          ...(spec.nextCursor !== undefined ? { nextCursor: spec.nextCursor } : {}),
          observedAt: OBSERVED_AT,
          source: sourceRef,
          confidence: Confidence.MEDIUM,
        };
      }
      if (spec.kind === "unavailable") {
        return unavailable(meta, spec.note ?? "Tags unavailable from this source.");
      }
      return errored(meta, {
        kind: CapabilityErrorKind.NETWORK,
        message: spec.message ?? "network down",
        retryable: true,
      });
    },
    resolveAccount: unwired("resolveAccount"),
    getProfile: unwired("getProfile"),
    getStories: unwired("getStories"),
    getFollowers: unwired("getFollowers"),
    getFollowing: unwired("getFollowing"),
    getPublicPosts: unwired("getPublicPosts"),
    getPublicComments: unwired("getPublicComments"),
    getPostChildren: unwired("getPostChildren"),
    getMentionedComment: unwired("getMentionedComment"),
    getAccountInsights: unwired("getAccountInsights"),
    discoverAccount: unwired("discoverAccount"),
  };

  return {
    source: {
      provider,
      source: { id: sourceId, kind: SourceKind.FIXTURE, name: "tags stub" },
    },
    calls: () => calls,
    cursors: () => cursors,
  };
}

describe.runIf(dbAvailable)("worker TAGS_SCAN (FOUNDING §17)", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "tags-scan@igtrack.local" })
      .returning({ id: users.id });
    userId = rows[0]!.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  async function makeTarget(username?: string): Promise<string> {
    targetCounter += 1;
    const { target } = await createTarget(handle.db, {
      userId,
      username: username ?? `tags_target_${targetCounter}`,
    });
    return target.id;
  }

  async function scan(
    targetId: string,
    src: ExecutionSource,
  ): Promise<string> {
    const { job } = await enqueueJob(handle.db, { kind: "TAGS_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-tags");
    if (claimed === null || claimed.id !== job.id) {
      throw new Error("test setup: expected to claim the freshly enqueued job");
    }
    const result = await runTagsScan(handle.db, claimed, src);
    await completeJob(handle.db, claimed.id, "worker-tags");
    return result;
  }

  async function tagRows(targetId: string) {
    return handle.sql<
      {
        media_id: string;
        owner_username: string | null;
        caption: string | null;
        permalink: string | null;
        media_type: string | null;
        taken_at: Date | string | null;
        observed_at: Date | string;
        confidence: string;
        evidence_id: string | null;
      }[]
    >`
      SELECT tm.media_id, tm.owner_username, tm.caption, tm.permalink,
             tm.media_type, tm.taken_at, tm.observed_at, tm.confidence, tm.evidence_id
      FROM tagged_media tm
      JOIN targets t ON t.ig_account_id = tm.ig_account_id
      WHERE t.id = ${targetId}
      ORDER BY tm.media_id
    `;
  }

  async function listingEvidence(targetId: string) {
    return handle.sql<
      { id: string; observation_kind: string; metadata: Record<string, unknown> | null; observed_at: Date | string }[]
    >`
      SELECT e.id, e.observation_kind, e.metadata, e.observed_at
      FROM evidence e
      JOIN ig_accounts a ON a.id::text = split_part(split_part(e.observation_id, ':', 2), '@', 1)
      JOIN targets t ON t.ig_account_id = a.id
      WHERE t.id = ${targetId} AND e.observation_kind = 'tagged_media_listing'
      ORDER BY e.observed_at
    `;
  }

  it("AVAILABLE → append-only rows sharing one listing evidence row (TG1)", async () => {
    const targetId = await makeTarget();
    const stub = tagsSource([
      { kind: "available", items: [tagged("tag-a"), tagged("tag-b", { ownerUsername: "saga.pixel" })] },
    ]);

    expect(await scan(targetId, stub.source)).toBe("succeeded");

    const rows = await tagRows(targetId);
    expect(rows.map((r) => r.media_id)).toEqual(["tag-a", "tag-b"]);
    expect(rows.find((r) => r.media_id === "tag-b")?.owner_username).toBe("saga.pixel");
    // Every row carries the evidence of the listing that observed it.
    expect(rows.every((r) => r.evidence_id !== null)).toBe(true);
    expect(new Set(rows.map((r) => r.evidence_id)).size).toBe(1);

    const listings = await listingEvidence(targetId);
    expect(listings).toHaveLength(1);
    expect(listings[0]?.metadata?.["completion"]).toBe("COMPLETE");
    expect(listings[0]?.metadata?.["pages"]).toBe(1);
    expect(rows[0]?.evidence_id).toBe(listings[0]?.id);

    const health = await getSourceHealth(handle.db, "stub:tags");
    expect(health.find((h) => h.capability === "getTags")?.status).toBe("HEALTHY");
  });

  it("a re-scan never rewrites a stored observation, and an absent row is not a removal (TG2)", async () => {
    const targetId = await makeTarget();
    const first = tagsSource([
      { kind: "available", items: [tagged("tag-keep", { caption: "as first seen" })] },
    ]);
    await scan(targetId, first.source);

    // The provider now returns a different caption and a different set: the new
    // observation must not rewrite the row, and the missing row must not be
    // claimed as removed.
    const second = tagsSource([
      {
        kind: "available",
        items: [
          tagged("tag-keep", {
            caption: "edited later by its owner",
            meta: {
              category: ObservationCategory.OBSERVED,
              confidence: Confidence.HIGH,
              observedAt: LATER_SEEN_AT,
            },
          }),
          tagged("tag-new"),
        ],
      },
    ]);
    await scan(targetId, second.source);

    const rows = await tagRows(targetId);
    expect(rows.map((r) => r.media_id)).toEqual(["tag-keep", "tag-new"]);
    const keep = rows.find((r) => r.media_id === "tag-keep");
    expect(keep?.caption).toBe("as first seen");
    expect(new Date(keep!.observed_at).toISOString()).toBe(FIRST_SEEN_AT);

    // Each scan observed the listing (two evidence rows), while only the first
    // scan's evidence wrote the kept row.
    const listings = await listingEvidence(targetId);
    expect(listings).toHaveLength(2);
    expect(keep?.evidence_id).toBe(listings[0]?.id);
  });

  it("follows the cursor across pages and reports COMPLETE only when the source says so (TG3)", async () => {
    const targetId = await makeTarget();
    const stub = tagsSource([
      { kind: "partial", items: [tagged("page-1")], nextCursor: "cursor-1" },
      { kind: "available", items: [tagged("page-2")] },
    ]);

    expect(await scan(targetId, stub.source)).toBe("succeeded");
    expect(stub.calls()).toBe(2);
    expect(stub.cursors()).toEqual([undefined, "cursor-1"]);

    const rows = await tagRows(targetId);
    expect(rows.map((r) => r.media_id)).toEqual(["page-1", "page-2"]);
    const listings = await listingEvidence(targetId);
    expect(listings[0]?.metadata?.["completion"]).toBe("COMPLETE");
    expect(listings[0]?.metadata?.["pages"]).toBe(2);
  });

  it("a PARTIAL tail stores what was read and says PARTIAL where the rows live (TG4)", async () => {
    const targetId = await makeTarget();
    const stub = tagsSource([{ kind: "partial", items: [tagged("half")] }]);

    expect(await scan(targetId, stub.source)).toBe("succeeded-partial");

    expect((await tagRows(targetId)).map((r) => r.media_id)).toEqual(["half"]);
    const listings = await listingEvidence(targetId);
    expect(listings[0]?.metadata?.["completion"]).toBe("PARTIAL");
  });

  it("UNAVAILABLE stores nothing and records the source's reason (TG5)", async () => {
    const targetId = await makeTarget();
    const stub = tagsSource([
      { kind: "unavailable", note: "This source does not expose the tags edge." },
    ]);

    expect(await scan(targetId, stub.source)).toBe("unavailable");

    expect(await tagRows(targetId)).toHaveLength(0);
    expect(await listingEvidence(targetId)).toHaveLength(0);
    const health = await getSourceHealth(handle.db, "stub:tags");
    const row = health.find((h) => h.capability === "getTags");
    expect(row?.status).toBe("UNAVAILABLE");
    expect(row?.coverageNote).toContain("does not expose the tags edge");
  });

  it("a page ERROR throws a retryable failure instead of storing a half listing (TG6)", async () => {
    const targetId = await makeTarget();
    const stub = tagsSource([{ kind: "error", message: "upstream 503" }]);

    await expect(scan(targetId, stub.source)).rejects.toBeInstanceOf(JobExecutionError);

    expect(await tagRows(targetId)).toHaveLength(0);
    expect(await listingEvidence(targetId)).toHaveLength(0);
  });

  it("capability off → UNAVAILABLE without a provider call (TG7)", async () => {
    const targetId = await makeTarget();
    const stub = tagsSource([{ kind: "available", items: [tagged("never")] }], {
      capabilityAvailable: false,
    });

    expect(await scan(targetId, stub.source)).toBe("unavailable");
    expect(stub.calls()).toBe(0);
    expect(await tagRows(targetId)).toHaveLength(0);
  });

  it("a DISCOVERY target is refused at execution, not only at enqueue (TG8)", async () => {
    targetCounter += 1;
    const { target } = await createTarget(handle.db, {
      userId,
      username: `tags_discovery_${targetCounter}`,
      observationMode: "DISCOVERY",
    });
    // Raw insert bypasses the queue's mode guard on purpose: the executor gate
    // must hold even for a job that reaches it another way (D47/D59).
    const jobId = randomUUID();
    await handle.sql`
      INSERT INTO monitoring_jobs (id, kind, target_id)
      VALUES (${jobId}, 'TAGS_SCAN', ${target.id})
    `;
    const claimed = await claimJob(handle.db, "worker-tags");
    expect(claimed?.id).toBe(jobId);

    const stub = tagsSource([{ kind: "available", items: [tagged("never")] }]);
    await expect(
      runTagsScan(handle.db, claimed!, stub.source),
    ).rejects.toBeInstanceOf(JobExecutionError);
    expect(stub.calls()).toBe(0);
    expect(await tagRows(target.id)).toHaveLength(0);
  });
});
