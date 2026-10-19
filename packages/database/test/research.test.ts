import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addClaim,
  addResearchDocument,
  createResearchRun,
  createTarget,
  deleteTargetWithObservations,
  finishResearchRun,
  findFreshFetchedDocument,
  getResearchRun,
  listClaims,
  listResearchDocuments,
  listResearchRuns,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import { createFreshTestDb, probeDatabase, TEST_DATABASE_URL } from "./helpers.js";

// ---------------------------------------------------------------------------
// The research persistence layer (FOUNDING §19, D69):
//   * migration 0021 created both tables and the claims provenance column;
//   * a run's totals are written once, at finish, and read back;
//   * every read is scoped to the owner — another user sees nothing;
//   * freshness reuse decides on (user, url, FETCHED, window) only;
//   * runs and claims cascade together on target delete, so the no-FK
//     provenance column can never dangle through a code path;
//   * concurrent runs are separate rows, not a merge.
//
// Requires the Docker Compose test database; skipped loudly when absent.
// ---------------------------------------------------------------------------

const available = await probeDatabase(TEST_DATABASE_URL);

describe.runIf(available)("research runs and documents (migration 0021)", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let otherUserId: string;
  let targetId: string;
  let otherTargetId: string;

  const baseRun = (target: string) => ({
    userId,
    targetId: target,
    question: "What organization runs this account?",
    focusIntent: "ORGANIZATION",
    focusPriorities: ["ORGANIZATION_NAME", "LOCATION_STATED"],
    focusRationale: "organization question",
    maxSources: 10,
    maxDepth: 1,
    searchProvider: null,
    searchQueries: ['"target" organization'],
    searchUnavailableReason: "no provider",
    operatorUrlCount: 1,
    boundsTruncated: 0,
    startedAt: new Date(),
  });

  const baseDoc = (runId: string, url: string) => ({
    runId,
    userId,
    url,
    sourceType: "OPERATOR_SUPPLIED_URL",
    outcome: "FETCHED" as const,
    outcomeReason: null,
    httpStatus: 200,
    title: "About",
    contentType: "text/html",
    byteSize: 1024,
    contentSha256: "a".repeat(64),
    retrievedAt: new Date(),
    candidatesFound: 2,
    linksNotFollowed: 3,
  });

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values([{ email: "research@igtrack.local" }, { email: "stranger@igtrack.local" }])
      .returning({ id: users.id });
    userId = rows[0]!.id;
    otherUserId = rows[1]!.id;
    const mine = await createTarget(handle.db, { userId, username: "research_target" });
    targetId = mine.target.id;
    const theirs = await createTarget(handle.db, {
      userId: otherUserId,
      username: "research_target", // same account, different owner
    });
    otherTargetId = theirs.target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("created both tables and the claims provenance column (0021 applied)", async () => {
    const columns = await handle.sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_name IN ('research_runs', 'research_documents')`;
    const names = new Set(columns.map((c) => `${String(c.table_name)}.${String(c.column_name)}`));
    expect(names.has("research_runs.question")).toBe(true);
    expect(names.has("research_runs.bounds_truncated")).toBe(true);
    expect(names.has("research_documents.content_sha256")).toBe(true);
    expect(names.has("research_documents.retrieved_at")).toBe(true);

    const claimColumn = await handle.sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'claims' AND column_name = 'research_run_id'`;
    expect(claimColumn).toHaveLength(1);
  });

  it("records a run in-progress, then its finished totals exactly once", async () => {
    const run = await createResearchRun(handle.db, baseRun(targetId));
    expect(run.status).toBe("COMPLETED_PARTIAL"); // nothing finished yet — never "COMPLETED"

    const finished = await finishResearchRun(handle.db, {
      runId: run.id,
      userId,
      status: "COMPLETED_PARTIAL",
      documentsPlanned: 2,
      documentsFetched: 1,
      documentsFailed: 1,
      candidatesFound: 4,
      claimsStored: 3,
      claimsDuplicate: 1,
      claimsRefused: 0,
      finishedAt: new Date(),
    });
    expect(finished.documentsFetched).toBe(1);
    expect(finished.documentsFailed).toBe(1);
    expect(finished.claimsStored).toBe(3);

    const readBack = await getResearchRun(handle.db, { userId, runId: run.id });
    expect(readBack?.status).toBe("COMPLETED_PARTIAL");
    expect(readBack?.focusPriorities).toEqual(["ORGANIZATION_NAME", "LOCATION_STATED"]);
    expect(readBack?.searchUnavailableReason).toBe("no provider");
  });

  it("scopes reads to the owner: another user cannot read the run or its documents", async () => {
    const run = await createResearchRun(handle.db, baseRun(targetId));
    await addResearchDocument(handle.db, baseDoc(run.id, "https://aurora.example/about"));

    expect(await getResearchRun(handle.db, { userId: otherUserId, runId: run.id })).toBeNull();
    expect(await listResearchDocuments(handle.db, { userId: otherUserId, runId: run.id })).toEqual(
      [],
    );
    // Even the target id, known exactly, does not leak across owners.
    expect(await listResearchRuns(handle.db, { userId: otherUserId, targetId })).toEqual([]);
    // …and the owner does see it.
    const mine = await listResearchRuns(handle.db, { userId, targetId });
    expect(mine.some((r) => r.id === run.id)).toBe(true);
  });

  it("records every per-document outcome, including failures, with their reason", async () => {
    const run = await createResearchRun(handle.db, baseRun(targetId));
    await addResearchDocument(handle.db, baseDoc(run.id, "https://aurora.example/ok"));
    await addResearchDocument(handle.db, {
      ...baseDoc(run.id, "https://aurora.example/private"),
      outcome: "BLOCKED_BY_ROBOTS",
      outcomeReason: "robots.txt disallows /private",
      httpStatus: null,
      title: null,
      contentType: null,
      byteSize: null,
      contentSha256: null,
      retrievedAt: null,
      candidatesFound: 0,
      linksNotFollowed: 0,
    });

    const docs = await listResearchDocuments(handle.db, { userId, runId: run.id });
    expect(docs).toHaveLength(2);
    const blocked = docs.find((d) => d.outcome === "BLOCKED_BY_ROBOTS");
    expect(blocked?.outcomeReason).toMatch(/robots\.txt/);
    expect(blocked?.contentSha256).toBeNull(); // a refusal carries no fake digest
  });

  it("refuses the same URL twice in one run (the unique index backs the engine's dedup)", async () => {
    const run = await createResearchRun(handle.db, baseRun(targetId));
    await addResearchDocument(handle.db, baseDoc(run.id, "https://aurora.example/dupe"));
    let caught: unknown;
    try {
      await addResearchDocument(handle.db, baseDoc(run.id, "https://aurora.example/dupe"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
  });

  describe("freshness reuse (D69)", () => {
    it("finds a recent FETCHED document for the same URL, cross-target for the same user", async () => {
      const run = await createResearchRun(handle.db, baseRun(targetId));
      const retrievedAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
      await addResearchDocument(handle.db, {
        ...baseDoc(run.id, "https://fresh.example/page"),
        retrievedAt,
      });

      const found = await findFreshFetchedDocument(handle.db, {
        userId,
        url: "https://fresh.example/page",
        since: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      expect(found?.outcome).toBe("FETCHED");
      expect(found?.retrievedAt?.getTime()).toBe(retrievedAt.getTime());
    });

    it("returns null outside the window, for another user, another URL, or a non-FETCHED outcome", async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const oldRun = await createResearchRun(handle.db, baseRun(targetId));
      await addResearchDocument(handle.db, {
        ...baseDoc(oldRun.id, "https://old.example/page"),
        retrievedAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // too old
      });
      expect(
        await findFreshFetchedDocument(handle.db, { userId, url: "https://old.example/page", since }),
      ).toBeNull();

      const run = await createResearchRun(handle.db, baseRun(targetId));
      await addResearchDocument(handle.db, {
        ...baseDoc(run.id, "https://reused.example/page"),
        outcome: "REUSED",
      });
      expect(
        await findFreshFetchedDocument(handle.db, {
          userId,
          url: "https://reused.example/page",
          since,
        }),
      ).toBeNull();

      expect(
        await findFreshFetchedDocument(handle.db, {
          userId: otherUserId,
          url: "https://fresh.example/page",
          since,
        }),
      ).toBeNull();
      expect(
        await findFreshFetchedDocument(handle.db, {
          userId,
          url: "https://never.example/page",
          since,
        }),
      ).toBeNull();
    });
  });

  it("stamps claims with the run that extracted them, and leaves it null otherwise", async () => {
    const run = await createResearchRun(handle.db, baseRun(targetId));
    const extracted = await addClaim(handle.db, {
      userId,
      targetId,
      predicate: "ORGANIZATION_NAME",
      value: "Extracted Studio",
      sourceKind: "WEB",
      sourceUrl: "https://extracted.example/about",
      excerpt: "Extracted Studio.",
      researchRunId: run.id,
    });
    expect(extracted.researchRunId).toBe(run.id);

    const submitted = await addClaim(handle.db, {
      userId,
      targetId,
      predicate: "ORGANIZATION_NAME",
      value: "Submitted Studio",
      sourceKind: "OPERATOR",
    });
    expect(submitted.researchRunId).toBeNull();

    const rows = await listClaims(handle.db, { userId, targetId });
    expect(rows.find((c) => c.id === extracted.id)?.researchRunId).toBe(run.id);
  });

  it("deleting the target removes runs, documents AND claims together — no dangling provenance", async () => {
    const doomed = await createTarget(handle.db, { userId, username: "doomed_target" });
    const run = await createResearchRun(handle.db, baseRun(doomed.target.id));
    await addResearchDocument(handle.db, baseDoc(run.id, "https://doomed.example/page"));
    await addClaim(handle.db, {
      userId,
      targetId: doomed.target.id,
      predicate: "LOCATION_STATED",
      value: "Leeds",
      sourceKind: "WEB",
      sourceUrl: "https://doomed.example/page",
      researchRunId: run.id,
    });

    await deleteTargetWithObservations(handle.db, doomed.target.id);

    expect(await getResearchRun(handle.db, { userId, runId: run.id })).toBeNull();
    const orphanDocs = await handle.sql`
      SELECT id FROM research_documents WHERE run_id = ${run.id}`;
    expect(orphanDocs).toHaveLength(0);
    const orphanClaims = await handle.sql`
      SELECT id FROM claims WHERE target_id = ${doomed.target.id}`;
    expect(orphanClaims).toHaveLength(0);
  });

  it("concurrent runs stay separate rows with independent ids", async () => {
    const [a, b] = await Promise.all([
      createResearchRun(handle.db, baseRun(targetId)),
      createResearchRun(handle.db, baseRun(targetId)),
    ]);
    expect(a.id).not.toBe(b.id);
    const ids = new Set([a.id, b.id]);
    expect(ids.size).toBe(2);
    // The stranger's target id never admits these runs.
    expect(await listResearchRuns(handle.db, { userId: otherUserId, targetId: otherTargetId })).toEqual(
      [],
    );
  });
});
