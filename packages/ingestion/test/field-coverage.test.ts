import { describe, expect, it } from "vitest";
import {
  COVERAGE_AREA_BY_CAPABILITY,
  coverageKeysForArea,
  findUnmappedFields,
  GRAPH_FIELD_COVERAGE,
  REQUESTED_FIELDS_BY_AREA,
} from "../src/graph/field-coverage.js";

// Drift guard for the §15 audit: the coverage table, the adapter's request
// shapes, and the no-speculative-fields rule must never part ways silently.

/** Split a `fields` list on top-level commas (braces nest expansions). */
function topLevelFields(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) out.push(current);
  return out.map((f) => f.split("{")[0]!.trim()).filter((f) => f.length > 0);
}

describe("graph field coverage audit", () => {
  it("every requested field is documented (no speculative fields)", () => {
    for (const row of GRAPH_FIELD_COVERAGE) {
      if (row.requested) {
        expect(row.documented, `${row.area}.${row.graphField} requested but undocumented`).toBe(true);
      }
    }
  });

  it("every requested row appears in the matching GRAPH_*_FIELDS constant", () => {
    for (const row of GRAPH_FIELD_COVERAGE) {
      if (!row.requested) continue;
      const constant = REQUESTED_FIELDS_BY_AREA[row.area];
      expect(constant, `no request constant for area ${row.area}`).toBeDefined();
      expect(
        constant!.includes(row.graphField),
        `${row.area}.${row.graphField} marked requested but missing from the request constant`,
      ).toBe(true);
    }
  });

  it("every requested constant field is covered by a row (no silent requests)", () => {
    const byArea = new Map<string, Set<string>>();
    for (const row of GRAPH_FIELD_COVERAGE) {
      if (!row.requested) continue;
      const set = byArea.get(row.area) ?? new Set<string>();
      set.add(row.graphField);
      byArea.set(row.area, set);
    }
    for (const [area, constant] of Object.entries(REQUESTED_FIELDS_BY_AREA)) {
      for (const field of topLevelFields(constant)) {
        expect(
          byArea.get(area)?.has(field) ?? false,
          `${area} requests ${field} with no coverage row`,
        ).toBe(true);
      }
    }
  });

  it("mapped rows name their model slot, tables, and reason", () => {
    for (const row of GRAPH_FIELD_COVERAGE) {
      expect(row.reason.length, `${row.area}.${row.graphField} needs a reason`).toBeGreaterThan(0);
      expect(row.docsRef.length, `${row.area}.${row.graphField} needs a docs ref`).toBeGreaterThan(0);
      if (row.status === "MAPPED") {
        expect(row.mappedTo, `${row.area}.${row.graphField} needs a model slot`).toMatch(/./);
        expect(
          row.persistedIn?.length ?? 0,
          `${row.area}.${row.graphField} needs persistence`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("new provider field detection (Phase 17)", () => {
  it("flags unknown provider keys, passes known ones", () => {
    expect(findUnmappedFields("media", ["id", "caption", "like_count"], "provider")).toEqual([]);
    expect(findUnmappedFields("media", ["id", "some_future_field"], "provider")).toEqual([
      "some_future_field",
    ]);
  });

  it("matches normalized keys by mappedTo last segment", () => {
    // account.igId row matches the nested igId key; username matches flat.
    expect(
      findUnmappedFields("profile", ["igId", "username", "meta"], "normalized", ["meta"]),
    ).toEqual([]);
    expect(findUnmappedFields("comments", ["commentId", "likeCount"], "normalized")).toEqual([]);
  });

  it("dedupes, sorts, and honors the ignore list", () => {
    expect(findUnmappedFields("media", ["zzz", "aaa", "zzz", "id"], "provider")).toEqual([
      "aaa",
      "zzz",
    ]);
    expect(findUnmappedFields("media", ["meta"], "normalized", ["meta"])).toEqual([]);
  });

  it("covers every live-probed capability with a known area", () => {
    for (const capability of [
      "resolveAccount",
      "getProfile",
      "getPublicPosts",
      "getPostChildren",
      "getPublicComments",
      "getStories",
    ]) {
      expect(
        COVERAGE_AREA_BY_CAPABILITY[capability],
        `harness capability ${capability} has no coverage area`,
      ).toBeDefined();
    }
  });

  it("normalized key space is non-empty for every probed area", () => {
    for (const area of new Set(Object.values(COVERAGE_AREA_BY_CAPABILITY))) {
      expect(
        coverageKeysForArea(area, "normalized").size,
        `area ${area} has no normalized keys`,
      ).toBeGreaterThan(0);
    }
  });
});
