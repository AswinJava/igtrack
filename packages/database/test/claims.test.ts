import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, AppErrorCode } from "@igtrack/core";
import {
  addClaim,
  createTarget,
  getClaimForUser,
  hashClaimExcerpt,
  listClaims,
  retractClaim,
  users,
  type DatabaseHandle,
} from "../src/index.js";
import { createFreshTestDb, probeDatabase, TEST_DATABASE_URL } from "./helpers.js";

const available = await probeDatabase(TEST_DATABASE_URL);

// ---------------------------------------------------------------------------
// The claims ledger's honesty rules, at the storage layer:
//   * a duplicate submission is REFUSED — duplication is not corroboration;
//   * a second source for the same value is a different row (it corroborates);
//   * retraction keeps the row readable and never deletes it;
//   * every read and write is scoped to the owner.
// ---------------------------------------------------------------------------

describe.runIf(available)("claims ledger", () => {
  let handle: DatabaseHandle;
  let userId: string;
  let otherUserId: string;
  let targetId: string;

  beforeAll(async () => {
    handle = await createFreshTestDb();
    const rows = await handle.db
      .insert(users)
      .values([{ email: "claims@igtrack.local" }, { email: "other@igtrack.local" }])
      .returning({ id: users.id });
    userId = rows[0]!.id;
    otherUserId = rows[1]!.id;
    const { target } = await createTarget(handle.db, {
      userId,
      username: "claims_target",
    });
    targetId = target.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("stores an excerpt as text plus a sha256 hash, never the hash alone", async () => {
    const claim = await addClaim(handle.db, {
      userId,
      targetId,
      predicate: "ORGANIZATION_NAME",
      value: "Aurora Print Studio",
      sourceKind: "WEB",
      sourceUrl: "https://auroraprint.example.org/about",
      excerpt: "Aurora Print Studio is a two-person printing studio.",
      retrievedAt: new Date(Date.UTC(2026, 9, 1)),
    });
    expect(claim.status).toBe("ACTIVE");
    expect(claim.excerptHash).toBe(
      hashClaimExcerpt("Aurora Print Studio is a two-person printing studio."),
    );
    expect(claim.sourceUrl).toBe("https://auroraprint.example.org/about");
  });

  it("refuses the exact same finding as a duplicate and names the existing row", async () => {
    let caught: unknown;
    try {
      await addClaim(handle.db, {
        userId,
        targetId,
        predicate: "ORGANIZATION_NAME",
        value: "Aurora Print Studio",
        sourceKind: "WEB",
        sourceUrl: "https://auroraprint.example.org/about",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.code).toBe(AppErrorCode.CONFLICT);
    // The message must be actionable: it points at the row that already exists.
    expect(error.message).toMatch(/claim [0-9a-f-]{36}/);
  });

  it("refuses a duplicate operator assertion (null sourceUrl) too", async () => {
    const operator = {
      userId,
      targetId,
      predicate: "CONTACT_CHANNEL" as const,
      value: "studio@aurora.example",
      sourceKind: "OPERATOR" as const,
    };
    await addClaim(handle.db, operator);
    await expect(addClaim(handle.db, operator)).rejects.toMatchObject({
      code: AppErrorCode.CONFLICT,
    });
  });

  it("accepts the same value from a different source — that is corroboration, not duplication", async () => {
    const second = await addClaim(handle.db, {
      userId,
      targetId,
      predicate: "ORGANIZATION_NAME",
      value: "Aurora Print Studio",
      sourceKind: "WEB",
      sourceUrl: "https://directory.example.net/aurora-print-studio",
    });
    const rows = await listClaims(handle.db, {
      userId,
      targetId,
      predicate: "ORGANIZATION_NAME",
    });
    expect(rows.map((r) => r.id)).toContain(second.id);
    expect(rows.filter((r) => r.value === "Aurora Print Studio").length).toBe(2);
  });

  it("retraction keeps the row readable with its reason and stops it listing by default", async () => {
    const claim = await addClaim(handle.db, {
      userId,
      targetId,
      predicate: "PRODUCT_OR_SERVICE",
      value: "Ceramics",
      sourceKind: "WEB",
      sourceUrl: "https://auroraprint.example.org/services",
    });
    const retracted = await retractClaim(handle.db, {
      userId,
      claimId: claim.id,
      reason: "Source updated: the ceramics service was discontinued.",
    });
    expect(retracted.status).toBe("RETRACTED");
    expect(retracted.retractedAt).not.toBeNull();
    expect(retracted.retractionReason).toContain("discontinued");

    const activeOnly = await listClaims(handle.db, { userId, targetId });
    expect(activeOnly.map((r) => r.id)).not.toContain(claim.id);
    const withRetracted = await listClaims(handle.db, {
      userId,
      targetId,
      includeRetracted: true,
    });
    const row = withRetracted.find((r) => r.id === claim.id);
    expect(row?.retractionReason).toContain("discontinued");

    // Retracting twice is a conflict, never a silent no-op: the second reason
    // someone supplies would otherwise be lost.
    await expect(
      retractClaim(handle.db, { userId, claimId: claim.id, reason: "again" }),
    ).rejects.toMatchObject({ code: AppErrorCode.CONFLICT });
  });

  it("scopes every read and write to the owner", async () => {
    const mine = await addClaim(handle.db, {
      userId,
      targetId,
      predicate: "LOCATION_STATED",
      value: "Lisbon",
      sourceKind: "WEB",
      sourceUrl: "https://news.example.com/aurora-lisbon",
    });
    const asOther = await getClaimForUser(handle.db, {
      userId: otherUserId,
      claimId: mine.id,
    });
    expect(asOther).toBeNull();
    await expect(
      retractClaim(handle.db, { userId: otherUserId, claimId: mine.id, reason: "no" }),
    ).rejects.toMatchObject({ code: AppErrorCode.NOT_FOUND });
    // Owner's row is untouched by the failed attempt.
    const still = await getClaimForUser(handle.db, { userId, claimId: mine.id });
    expect(still?.status).toBe("ACTIVE");
  });
});
