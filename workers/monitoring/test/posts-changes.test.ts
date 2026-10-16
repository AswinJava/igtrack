import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CapabilityStatus,
  Confidence,
  ObservationCategory,
  SourceKind,
  available,
  partial,
  type CapabilityResult,
  type InstagramProvider,
  type NormalizedPost,
} from "@igtrack/core";
import {
  claimJob,
  completeJob,
  createTarget,
  enqueueJob,
  getTargetDossier,
  getUserActivityFeed,
  users,
  type DatabaseHandle,
  type JobRecord,
} from "@igtrack/database";
import { runPostScan } from "../src/provider.js";
import type { ExecutionSource } from "../src/index.js";
import {
  createFreshTestDb,
  probeDatabase,
  TEST_DATABASE_URL,
} from "../../../packages/database/test/helpers.js";

const dbAvailable = await probeDatabase(TEST_DATABASE_URL);

const OBSERVED_AT = "2026-09-01T10:00:00.000Z";

// The fixture files are immutable, so history-dependent behavior (a caption
// that changes between scans, a post that leaves the listing) runs against a
// mutable provider double with the same CapabilityResult contract.
function post(postId: string, caption?: string): NormalizedPost {
  return {
    postId,
    takenAt: OBSERVED_AT,
    ...(caption !== undefined ? { caption } : {}),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: OBSERVED_AT,
    },
  };
}

interface MutableStub {
  source: ExecutionSource;
  setPosts(next: NormalizedPost[]): void;
  setPartial(next: boolean): void;
}

function mutableStub(): MutableStub {
  const sourceId = "stub:post-changes";
  const sourceRef = { sourceId, kind: SourceKind.FIXTURE };
  let posts: NormalizedPost[] = [];
  let asPartial = false;
  const provider: InstagramProvider = {
    sourceId,
    capabilities: () => ({
      resolveAccount: true,
      getProfile: true,
      getStories: true,
      getFollowers: true,
      getFollowing: true,
      getPublicPosts: true,
      getPublicComments: false,
      getPostChildren: false,
      getAccountInsights: false,
      discoverAccount: false,
    }),
    resolveAccount: async () => {
      throw new Error("stub: resolveAccount not wired");
    },
    getProfile: async () => {
      throw new Error("stub: getProfile not wired");
    },
    getStories: async () => {
      throw new Error("stub: getStories not wired");
    },
    getFollowers: async () => {
      throw new Error("stub: getFollowers not wired");
    },
    getFollowing: async () => {
      throw new Error("stub: getFollowing not wired");
    },
    getPublicPosts: async (): Promise<CapabilityResult<NormalizedPost[]>> => {
      const meta = {
        observedAt: OBSERVED_AT,
        source: sourceRef,
        confidence: Confidence.HIGH,
      };
      if (asPartial) {
        return partial(posts, { ...meta, note: "stub: partial final page" });
      }
      return available(posts, meta);
    },
    getPublicComments: async () => {
      throw new Error("stub: getPublicComments not wired");
    },
    getPostChildren: async () => {
      throw new Error("stub: getPostChildren not wired");
    },
    discoverAccount: async () => {
      throw new Error("stub: discoverAccount not wired");
    },
    getAccountInsights: async () => {
      throw new Error("stub: getAccountInsights not wired");
    },
  };
  return {
    source: { provider, source: { id: sourceId, kind: SourceKind.FIXTURE, name: "stub" } },
    setPosts: (next) => {
      posts = next;
    },
    setPartial: (next) => {
      asPartial = next;
    },
  };
}

describe.runIf(dbAvailable)("worker POSTS_SCAN media change detection (Phase G)", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let targetCounter = 0;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values({ email: "post-changes@igtrack.local" })
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
      username: `changes_target_${targetCounter}`,
    });
    return target.id;
  }

  async function scan(
    targetId: string,
    src: ExecutionSource,
  ): Promise<{ result: string; job: JobRecord }> {
    const { job } = await enqueueJob(handle.db, { kind: "POSTS_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-changes");
    if (claimed === null || claimed.id !== job.id) {
      throw new Error("test setup: expected to claim the freshly enqueued job");
    }
    const result = await runPostScan(handle.db, claimed, src);
    await completeJob(handle.db, claimed.id, "worker-changes");
    return { result, job: claimed };
  }

  function scanInstant(job: JobRecord): number {
    return new Date(job.startedAt ?? 0).getTime();
  }

  async function presenceByPostId(targetId: string) {
    return handle.sql<
      {
        post_id: string;
        state: string;
        last_caption: string | null;
        last_scan_at: Date | string;
        first_seen_at: Date | string;
      }[]
    >`
      SELECT p.post_id, pp.state, pp.last_caption, pp.last_scan_at, pp.first_seen_at
      FROM post_presence pp
      JOIN posts p ON p.id = pp.post_db_id
      WHERE pp.target_id = ${targetId}
      ORDER BY p.post_id
    `;
  }

  async function changesByPostId(targetId: string) {
    return handle.sql<
      {
        post_id: string;
        change: string;
        old_value: string | null;
        new_value: string | null;
        detected_at: Date | string;
        confidence: string;
        evidence_id: string | null;
      }[]
    >`
      SELECT p.post_id, pc.change, pc.old_value, pc.new_value, pc.detected_at,
             pc.confidence, pc.evidence_id
      FROM post_changes pc
      JOIN posts p ON p.id = pc.post_db_id
      WHERE pc.target_id = ${targetId}
      ORDER BY pc.detected_at, p.post_id, pc.change
    `;
  }

  it("a first complete scan records presence silently (G1)", async () => {
    const targetId = await makeTarget();
    const stub = mutableStub();
    stub.setPosts([post("p1", "alpha"), post("p2", "beta")]);

    const { result, job } = await scan(targetId, stub.source);
    expect(result).toBe("succeeded");

    const presence = await presenceByPostId(targetId);
    expect(presence.map((r) => r.post_id)).toEqual(["p1", "p2"]);
    for (const row of presence) {
      expect(row.state).toBe("PRESENT");
      // Our logical scan instant, not the provider's clock.
      expect(new Date(row.last_scan_at).getTime()).toBe(scanInstant(job));
      expect(new Date(row.first_seen_at).getTime()).toBe(
        new Date(OBSERVED_AT).getTime(),
      );
    }
    expect(presence[0]!.last_caption).toBe("alpha");
    expect(presence[1]!.last_caption).toBe("beta");
    expect(await changesByPostId(targetId)).toHaveLength(0);
  });

  it("a caption read different from the caption last read records one POST_EDITED (G2)", async () => {
    const targetId = await makeTarget();
    const stub = mutableStub();
    stub.setPosts([post("p1", "alpha")]);
    await scan(targetId, stub.source);

    stub.setPosts([post("p1", "alpha edited")]);
    const second = await scan(targetId, stub.source);
    expect(second.result).toBe("succeeded");

    const changes = await changesByPostId(targetId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.change).toBe("CAPTION_EDITED");
    expect(changes[0]!.old_value).toBe("alpha");
    expect(changes[0]!.new_value).toBe("alpha edited");
    // The observation bounds the edit interval: detected at OUR scan instant.
    expect(new Date(changes[0]!.detected_at).getTime()).toBe(scanInstant(second.job));
    expect(changes[0]!.evidence_id).not.toBeNull();

    const evidence = await handle.sql<{ observation_kind: string }[]>`
      SELECT observation_kind FROM evidence WHERE id = ${changes[0]!.evidence_id}
    `;
    expect(evidence[0]!.observation_kind).toBe("posts_listing");

    // Reporting surfaces carry the change: dossier count + activity feed item.
    const dossier = await getTargetDossier(handle.db, userId, targetId);
    expect(dossier?.counts.postChanges.count).toBe(1);
    const feed = await getUserActivityFeed(handle.db, userId, 50, {
      types: ["POST_EDITED"],
    });
    const item = feed.find(
      (i) => i.targetUsername === `changes_target_${targetCounter}`,
    );
    expect(item).toBeDefined();
    expect(item?.type).toBe("POST_EDITED");
    expect(item?.evidenceId).not.toBeNull();

    // Re-observing the same caption records nothing new.
    await scan(targetId, stub.source);
    expect(await changesByPostId(targetId)).toHaveLength(1);
  });

  it("absence is claimed once, only from a complete listing; return is silent (G3)", async () => {
    const targetId = await makeTarget();
    const stub = mutableStub();
    stub.setPosts([post("p1", "one"), post("p2", "two")]);
    await scan(targetId, stub.source);

    // p2 leaves a COMPLETE listing → one NO_LONGER_OBSERVED, never "deleted".
    stub.setPosts([post("p1", "one")]);
    const removed = await scan(targetId, stub.source);
    let changes = await changesByPostId(targetId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.change).toBe("NO_LONGER_OBSERVED");
    expect(changes[0]!.post_id).toBe("p2");
    expect(changes[0]!.old_value).toBe("two");
    expect(changes[0]!.new_value).toBeNull();
    expect(new Date(changes[0]!.detected_at).getTime()).toBe(scanInstant(removed.job));
    expect(
      (await presenceByPostId(targetId)).find((r) => r.post_id === "p2")!.state,
    ).toBe("ABSENT");

    // Still gone → no repeat event.
    await scan(targetId, stub.source);
    expect(await changesByPostId(targetId)).toHaveLength(1);

    // Back with the same caption → PRESENT again, still no event row.
    stub.setPosts([post("p1", "one"), post("p2", "two")]);
    await scan(targetId, stub.source);
    expect(
      (await presenceByPostId(targetId)).find((r) => r.post_id === "p2")!.state,
    ).toBe("PRESENT");
    expect(await changesByPostId(targetId)).toHaveLength(1);

    // Gone again → a second event under its own detected_at.
    stub.setPosts([post("p1", "one")]);
    await scan(targetId, stub.source);
    changes = await changesByPostId(targetId);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.change === "NO_LONGER_OBSERVED")).toBe(true);
    expect(
      new Date(changes[0]!.detected_at).getTime(),
    ).not.toBe(new Date(changes[1]!.detected_at).getTime());
  });

  it("a PARTIAL listing suppresses absence but reads a caption edit (G4)", async () => {
    const targetId = await makeTarget();
    const stub = mutableStub();
    stub.setPosts([post("p1", "one"), post("p2", "two")]);
    await scan(targetId, stub.source);

    // PARTIAL listing without p2: no absence claim, presence still updated.
    stub.setPosts([post("p1", "one")]);
    stub.setPartial(true);
    const second = await scan(targetId, stub.source);
    expect(second.result).toBe("succeeded-partial");
    expect(await changesByPostId(targetId)).toHaveLength(0);
    const after = await presenceByPostId(targetId);
    expect(after.find((r) => r.post_id === "p2")!.state).toBe("PRESENT");
    expect(new Date(after.find((r) => r.post_id === "p1")!.last_scan_at).getTime()).toBe(
      scanInstant(second.job),
    );

    // A caption read is a fact regardless of listing completeness (D56).
    stub.setPosts([post("p1", "one edited")]);
    const third = await scan(targetId, stub.source);
    expect(third.result).toBe("succeeded-partial");
    const changes = await changesByPostId(targetId);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.change).toBe("CAPTION_EDITED");
    expect(changes[0]!.new_value).toBe("one edited");
  });

  it("a first-ever caption is not an edit and an omitted caption clears nothing (G5)", async () => {
    const targetId = await makeTarget();
    const stub = mutableStub();
    stub.setPosts([post("p1")]);
    await scan(targetId, stub.source);
    expect(
      (await presenceByPostId(targetId)).find((r) => r.post_id === "p1")!.last_caption,
    ).toBeNull();
    expect(await changesByPostId(targetId)).toHaveLength(0);

    // First caption appears: stored, not claimed as an edit.
    stub.setPosts([post("p1", "born")]);
    await scan(targetId, stub.source);
    expect(
      (await presenceByPostId(targetId)).find((r) => r.post_id === "p1")!.last_caption,
    ).toBe("born");
    expect(await changesByPostId(targetId)).toHaveLength(0);

    // A real edit now has a previous value to compare against.
    stub.setPosts([post("p1", "born edited")]);
    await scan(targetId, stub.source);
    expect(await changesByPostId(targetId)).toHaveLength(1);

    // Omitted caption field = "not exposed in this observation": no edit, no clear.
    stub.setPosts([post("p1")]);
    await scan(targetId, stub.source);
    expect(
      (await presenceByPostId(targetId)).find((r) => r.post_id === "p1")!.last_caption,
    ).toBe("born edited");
    expect(await changesByPostId(targetId)).toHaveLength(1);
  });

  it("a DISCOVERY target records no presence and no changes (G6)", async () => {
    targetCounter += 1;
    const { target } = await createTarget(handle.db, {
      userId,
      username: `changes_discovery_${targetCounter}`,
      observationMode: "DISCOVERY",
    });
    // The queue refuses owned kinds for DISCOVERY targets (D47); this inserts
    // the job directly to prove the executor gate holds even for a job that
    // reaches it another way (D59). Raw insert, so the id is explicit — the
    // Drizzle-layer uuid default does not exist at the database level.
    const jobId = randomUUID();
    await handle.sql`
      INSERT INTO monitoring_jobs (id, kind, target_id)
      VALUES (${jobId}, 'POSTS_SCAN', ${target.id})
    `;
    const claimed = await claimJob(handle.db, "worker-changes");
    expect(claimed?.id).toBe(jobId);

    const stub = mutableStub();
    stub.setPosts([post("p1", "alpha")]);
    expect(await runPostScan(handle.db, claimed!, stub.source)).toBe("succeeded");

    // The posts themselves are stored (pre-existing behavior); the change
    // claim surface stays empty because a bounded preview cannot support it.
    expect(await changesByPostId(target.id)).toHaveLength(0);
    expect(await presenceByPostId(target.id)).toHaveLength(0);
  });

  it("re-executing the same logical scan (retry) never doubles an event (G7)", async () => {
    const targetId = await makeTarget();
    const stub = mutableStub();
    stub.setPosts([post("p1", "v1")]);
    await scan(targetId, stub.source);

    stub.setPosts([post("p1", "v2")]);
    const { job } = await enqueueJob(handle.db, { kind: "POSTS_SCAN", targetId });
    const claimed = await claimJob(handle.db, "worker-changes");
    expect(claimed?.id).toBe(job.id);

    // Two executions of the same claimed job = lease loss + reclaim shape.
    // job.startedAt is the logical scan instant, so the second execution
    // re-derives the same difference and records nothing new.
    expect(await runPostScan(handle.db, claimed!, stub.source)).toBe("succeeded");
    expect(await runPostScan(handle.db, claimed!, stub.source)).toBe("succeeded");
    expect(await changesByPostId(targetId)).toHaveLength(1);
    await completeJob(handle.db, claimed!.id, "worker-changes");
  });
});
