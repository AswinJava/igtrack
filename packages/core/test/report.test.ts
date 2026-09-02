import { describe, expect, it } from "vitest";
import {
  REPORT_EVIDENCE_SAMPLE_LIMIT,
  buildPeriodReport,
  computeAudienceSets,
  enumerateReportWindows,
  isoWeekLabel,
  renderPeriodReportMarkdown,
  reportWindow,
  type PeriodReport,
  type PeriodReportInput,
  type ReportFact,
  type ReportPost,
  type ReportSection,
} from "../src/report.js";

// ---------------------------------------------------------------------------
// The report engine is the honesty-critical surface: it is where a product is
// most tempted to print a zero for "we could not look". These tests pin the
// opposite: calendar windows are unambiguous, only COMPLETE snapshots anchor a
// diff, an unreadable family is UNAVAILABLE with a reason, and the same ledger
// renders byte-identically every time.
// ---------------------------------------------------------------------------

const WINDOW = reportWindow("monthly", new Date("2026-10-15T10:00:00.000Z"));

function post(
  overrides: Partial<Omit<ReportPost, "id" | "takenAt" | "evidenceId">> & {
    id: string;
    takenAt: string;
    evidenceId: string;
  },
): ReportPost {
  return {
    caption: null,
    mediaType: "IMAGE",
    likeCount: null,
    commentCount: null,
    ...overrides,
  };
}

function input(overrides: Partial<PeriodReportInput> = {}): PeriodReportInput {
  const base: PeriodReportInput = {
    target: { username: "aurora.wilde", platformId: null, observationMode: "DISCOVERY" },
    window: WINDOW,
    generatedAt: "2026-11-01T00:00:00.000Z",
    evidence: { sourceIds: ["web"], evidenceClass: "LIVE", synthetic: false, note: "Public observations only." },
    ledger: {
      earliestAt: "2026-01-05T00:00:00.000Z",
      baseline: {
        id: "profile_0",
        at: "2026-09-30T00:00:00.000Z",
        followerCount: 100,
        followingCount: 50,
        postCount: 10,
        completeness: "COMPLETE",
        evidenceId: "ev_base",
      },
      profilePoints: [],
      profileChanges: { rows: [], readable: true, reason: null },
    },
    audience: {
      deltas: { rows: [], readable: true, reason: null },
      followers: { complete: 0, partial: 0, latestCompleteAt: null },
      following: { complete: 0, partial: 0, latestCompleteAt: null },
    },
    posts: { rows: [], readable: true, reason: null },
    stories: { rows: [], readable: true, reason: null },
    comments: { rows: [], readable: true, reason: null },
    mentions: { rows: [], readable: true, reason: null },
    tags: { rows: [], readable: true, reason: null },
    insights: { rows: [], readable: true, reason: null },
    relationships: { rows: [], readable: true, reason: null },
  };
  return {
    ...base,
    ...overrides,
    target: { ...base.target, ...overrides.target },
    ledger: { ...base.ledger, ...overrides.ledger },
    audience: { ...base.audience, ...overrides.audience },
  };
}

function section(report: PeriodReport, id: string): ReportSection {
  const found = report.sections.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`report has no section "${id}"`);
  return found;
}

function factOf(owner: ReportSection, label: string): ReportFact {
  const found = owner.facts.find((entry) => entry.label === label);
  if (found === undefined) throw new Error(`section "${owner.id}" has no fact "${label}"`);
  return found;
}

const CONTENT_ROWS: ReportPost[] = [
  post({
    id: "post_1",
    takenAt: "2026-10-02T09:00:00.000Z",
    caption: "sunset over the pier #goldenhour #film",
    likeCount: 10,
    commentCount: 2,
    evidenceId: "ev_post1",
  }),
  post({
    id: "post_2",
    takenAt: "2026-10-09T09:00:00.000Z",
    caption: "another #goldenhour",
    likeCount: null,
    commentCount: 1,
    evidenceId: "ev_post2",
  }),
];

describe("reportWindow", () => {
  it("buckets an instant into its Monday-start UTC week", () => {
    const window = reportWindow("weekly", new Date("2026-10-29T23:59:59.000Z"));
    expect(window.start).toBe("2026-10-26T00:00:00.000Z");
    expect(window.end).toBe("2026-11-02T00:00:00.000Z");
    expect(window.label).toBe("2026-W44");
  });

  it("keeps Sunday in the week that began the Monday before", () => {
    const window = reportWindow("weekly", new Date("2026-11-01T05:00:00.000Z"));
    expect(window.start).toBe("2026-10-26T00:00:00.000Z");
    expect(window.label).toBe("2026-W44");
  });

  it("labels the ISO week-year, not the calendar year", () => {
    expect(isoWeekLabel(new Date("2025-12-29T12:00:00.000Z"))).toBe("2026-W01");
    expect(isoWeekLabel(new Date("2027-01-03T12:00:00.000Z"))).toBe("2026-W53");
    const window = reportWindow("weekly", new Date("2027-01-01T08:00:00.000Z"));
    expect(window.start).toBe("2026-12-28T00:00:00.000Z");
    expect(window.end).toBe("2027-01-04T00:00:00.000Z");
    expect(window.label).toBe("2026-W53");
  });

  it("cuts months, quarters and years on UTC boundaries with exclusive ends", () => {
    const month = reportWindow("monthly", new Date("2026-10-31T23:59:59.000Z"));
    expect([month.start, month.end, month.label]).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "2026-10",
    ]);
    const quarter = reportWindow("quarterly", new Date("2026-11-15T00:00:00.000Z"));
    expect([quarter.start, quarter.end, quarter.label]).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
      "2026-Q4",
    ]);
    const year = reportWindow("yearly", new Date("2026-03-01T00:00:00.000Z"));
    expect([year.start, year.end, year.label]).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
      "2026",
    ]);
  });
});

describe("enumerateReportWindows", () => {
  it("lists newest-first windows back to the ledger start", () => {
    const windows = enumerateReportWindows(
      "monthly",
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-10-29T00:00:00.000Z"),
    );
    expect(windows.map((window) => window.label)).toEqual(["2026-10", "2026-09", "2026-08"]);
  });

  it("stops at the requested cap", () => {
    const windows = enumerateReportWindows(
      "weekly",
      new Date("2020-01-01T00:00:00.000Z"),
      new Date("2026-10-29T00:00:00.000Z"),
      3,
    );
    expect(windows).toHaveLength(3);
    expect(windows[0]?.label).toBe("2026-W44");
  });
});

describe("computeAudienceSets", () => {
  it("computes mutuals and both one-way sets, case-insensitively", () => {
    const sets = computeAudienceSets(
      { usernames: ["Alice", "bob", "carol"], complete: true, takenAt: "2026-10-30T00:00:00.000Z" },
      { usernames: ["alice", "BOB", "dave"], complete: true, takenAt: "2026-10-30T00:00:00.000Z" },
    );
    expect(sets.complete).toBe(true);
    expect(sets.followerCount).toBe(3);
    expect(sets.followingCount).toBe(3);
    expect(sets.mutualCount).toBe(2);
    // The follower side's spelling wins, so the set reads like an audience list.
    expect(sets.mutuals).toEqual(["Alice", "bob"]);
    expect(sets.notFollowingBack).toEqual(["carol"]);
    expect(sets.notFollowedBack).toEqual(["dave"]);
    expect(sets.notes).toEqual([]);
  });

  it("names the missing COMPLETE snapshot instead of calling the sets an answer", () => {
    const sets = computeAudienceSets(
      { usernames: ["alice"], complete: true, takenAt: null },
      { usernames: [], complete: false, takenAt: null },
    );
    expect(sets.complete).toBe(false);
    // The following roster was never read, so "alice follows you, not back"
    // would be an invented one-way claim. No set is computed, and the absent
    // side's count is null rather than a zero.
    expect(sets.followerCount).toBe(1);
    expect(sets.followingCount).toBeNull();
    expect(sets.mutualCount).toBeNull();
    expect(sets.mutuals).toEqual([]);
    expect(sets.notFollowingBack).toEqual([]);
    expect(sets.notFollowedBack).toEqual([]);
    expect(sets.notes).toHaveLength(2);
    expect(sets.notes[0]).toMatch(/Following roster is not from a COMPLETE snapshot/);
    expect(sets.notes[1]).toContain("absent roster is not an empty audience");
  });
});

describe("buildPeriodReport: states", () => {
  it("marks a readable-but-empty family EMPTY with its reason, never zero", () => {
    const report = buildPeriodReport(input());
    expect(section(report, "stories").state).toBe("EMPTY");
    expect(section(report, "stories").facts).toEqual([]);
    expect(section(report, "content").state).toBe("EMPTY");
    expect(report.sections.at(-1)?.id).toBe("coverage");
    expect(report.sections).toHaveLength(11);
    expect(report.gaps.some((gap) => gap.section === "Stories")).toBe(true);
    expect(report.gaps.every((gap) => gap.reason.length > 0)).toBe(true);
    expect(report.gaps.some((gap) => gap.section.includes("Coverage"))).toBe(false);
  });

  it("reports UNAVAILABLE with the source's own reason when a family cannot be read", () => {
    const report = buildPeriodReport(
      input({
        posts: { rows: [], readable: false, reason: "The configured provider does not expose media." },
      }),
    );
    const content = section(report, "content");
    expect(content.state).toBe("UNAVAILABLE");
    expect(content.reason).toBe("The configured provider does not expose media.");
    expect(report.gaps).toContainEqual({
      section: "Posts and cadence",
      reason: "The configured provider does not expose media.",
    });
    const markdown = renderPeriodReportMarkdown(report);
    expect(markdown).toContain("> The configured provider does not expose media.");
  });

  it("keeps an unreadable relationship family out of the ranking entirely", () => {
    const report = buildPeriodReport(
      input({
        relationships: { rows: [], readable: false, reason: "No signal source is configured." },
      }),
    );
    expect(section(report, "relationships").state).toBe("UNAVAILABLE");
    expect(section(report, "relationships").facts).toEqual([]);
  });
});

describe("buildPeriodReport: profile and audience diffs", () => {
  it("diffs only COMPLETE snapshots and never lets a PARTIAL read anchor a change", () => {
    const base = input();
    const report = buildPeriodReport(
      input({
        ledger: {
          ...base.ledger,
          profilePoints: [
            {
              id: "profile_1",
              at: "2026-10-10T00:00:00.000Z",
              followerCount: 130,
              followingCount: 51,
              postCount: 12,
              completeness: "COMPLETE",
              evidenceId: "ev_complete",
            },
            {
              id: "profile_2",
              at: "2026-10-24T00:00:00.000Z",
              followerCount: 999,
              followingCount: 999,
              postCount: 999,
              completeness: "PARTIAL",
              evidenceId: "ev_partial",
            },
          ],
        },
      }),
    );
    const profile = section(report, "profile");
    expect(profile.state).toBe("OBSERVED");
    const change = factOf(profile, "Follower count change");
    expect(change.value).toBe(30);
    expect(change.state).toBe("DERIVED");
    expect(change.evidenceIds).toEqual(["ev_base", "ev_complete"]);
    expect(factOf(profile, "Follower count at latest observation").value).toBe(130);
    expect(factOf(profile, "Profile snapshots in window").value).toBe(2);
    expect(factOf(profile, "Profile snapshots in window").note).toContain(
      "1 stored snapshot(s) were PARTIAL",
    );
  });

  it("stores a PARTIAL-only window as EMPTY, with no count change invented", () => {
    const base = input();
    const report = buildPeriodReport(
      input({
        ledger: {
          ...base.ledger,
          profilePoints: [
            {
              id: "profile_1",
              at: "2026-10-10T00:00:00.000Z",
              followerCount: 999,
              followingCount: null,
              postCount: null,
              completeness: "PARTIAL",
              evidenceId: "ev_partial",
            },
          ],
        },
      }),
    );
    const profile = section(report, "profile");
    expect(profile.state).toBe("EMPTY");
    expect(profile.reason).toMatch(/PARTIAL/);
    const change = factOf(profile, "Follower count change");
    expect(change.state).toBe("ABSENT");
    expect(change.value).toBeNull();
    expect(factOf(profile, "Follower count at latest observation").value).toBeNull();
  });

  it("counts recorded audience movement separately from the follower total", () => {
    const base = input();
    const report = buildPeriodReport(
      input({
        audience: {
          ...base.audience,
          deltas: {
            readable: true,
            reason: null,
            rows: [
              { change: "NEW_FOLLOWER", username: "alice", at: "2026-10-02T00:00:00.000Z", evidenceId: "ev_a" },
              { change: "NEW_FOLLOWER", username: "bob", at: "2026-10-03T00:00:00.000Z", evidenceId: "ev_b" },
              { change: "LOST_FOLLOWER", username: "carol", at: "2026-10-04T00:00:00.000Z", evidenceId: "ev_c" },
            ],
          },
          followers: { complete: 2, partial: 1, latestCompleteAt: "2026-10-31T00:00:00.000Z" },
        },
      }),
    );
    const audience = section(report, "audience");
    expect(audience.state).toBe("DERIVED");
    expect(audience.summary).toContain("2 new and 1 lost follower(s)");
    expect(factOf(audience, "New followers").value).toBe(2);
    expect(factOf(audience, "Lost followers").value).toBe(1);
    expect(factOf(audience, "Net follower change (recorded movements)").value).toBe(1);
    expect(factOf(audience, "Follower snapshots in window").value).toBe(3);
    expect(factOf(audience, "Follower snapshots in window").note).toContain(
      "2 COMPLETE (diffable), 1 PARTIAL",
    );
  });

  it("does not claim an earlier observation when no baseline exists", () => {
    const base = input();
    const report = buildPeriodReport(input({ ledger: { ...base.ledger, baseline: null } }));
    const profile = section(report, "profile");
    expect(profile.state).toBe("EMPTY");
    expect(profile.reason).toContain("No profile snapshot exists at or before this window");
    expect(profile.reason).not.toContain("observed before this window");
  });

  it("does not claim 'no change' when only in-window points exist", () => {
    const base = input();
    const report = buildPeriodReport(
      input({
        ledger: {
          ...base.ledger,
          baseline: null,
          profilePoints: [
            {
              id: "profile_1",
              at: "2026-10-29T00:00:00.000Z",
              followerCount: 101,
              followingCount: 50,
              postCount: 10,
              completeness: "COMPLETE",
              evidenceId: "ev_p1",
            },
          ],
        },
      }),
    );
    const profile = section(report, "profile");
    expect(profile.state).toBe("OBSERVED");
    expect(profile.summary).toContain("no count change can be computed");
    expect(profile.summary).not.toContain("No profile field changed");
  });

  it("distinguishes a window with no roster snapshot from one with no movement", () => {
    const base = input();
    const none = section(buildPeriodReport(input()), "audience");
    expect(none.state).toBe("EMPTY");
    expect(none.summary).toContain("No roster snapshot falls inside this window");
    expect(none.reason).toContain("observation gap");
    const noneNewFollowers = factOf(none, "New followers");
    expect(noneNewFollowers.value).toBeNull();
    expect(noneNewFollowers.state).toBe("ABSENT");
    expect(noneNewFollowers.note).toContain("movement is not observable");
    expect(factOf(none, "Net follower change (recorded movements)").value).toBeNull();

    const partial = section(
      buildPeriodReport(
        input({
          audience: { ...base.audience, followers: { complete: 0, partial: 1, latestCompleteAt: null } },
        }),
      ),
      "audience",
    );
    expect(partial.summary).toContain("Only PARTIAL roster snapshots");
    expect(partial.reason).toContain("never diffed");
    expect(factOf(partial, "New followers").value).toBeNull();
  });

  it("reports zero movement only when COMPLETE rosters were actually diffed", () => {
    const base = input();
    const report = buildPeriodReport(
      input({
        audience: {
          ...base.audience,
          deltas: { rows: [], readable: true, reason: null },
          followers: { complete: 2, partial: 0, latestCompleteAt: "2026-10-31T00:00:00.000Z" },
        },
      }),
    );
    const audience = section(report, "audience");
    expect(audience.state).toBe("EMPTY");
    expect(factOf(audience, "New followers").value).toBe(0);
    expect(factOf(audience, "New followers").state).toBe("DERIVED");
    expect(factOf(audience, "New followers").note).toBe("—");
  });

  it("says the roster is unavailable rather than reporting an empty audience", () => {
    const base = input();
    const report = buildPeriodReport(
      input({
        audience: {
          ...base.audience,
          deltas: { rows: [], readable: false, reason: "The provider does not expose follower rosters." },
        },
      }),
    );
    const audience = section(report, "audience");
    expect(audience.state).toBe("UNAVAILABLE");
    expect(audience.reason).toBe("The provider does not expose follower rosters.");
    expect(factOf(audience, "New followers").value).toBeNull();
    expect(factOf(audience, "New following").value).toBeNull();
  });

  it("does not surface a CDN-query-only picture change as a profile edit", () => {
    const base = input();
    const artifactOnly = buildPeriodReport(
      input({
        ledger: {
          ...base.ledger,
          profileChanges: {
            rows: [
              {
                field: "profilePicUrl",
                from: "https://a.cdninstagram.com/v/t51.2885-19/abc_n.jpg?oh=1",
                to: "https://b.fbcdn.net/v/t51.2885-19/abc_n.jpg?_nc_oc=2",
                at: "2026-10-12T00:00:00.000Z",
                evidenceId: "ev_pic",
              },
            ],
            readable: true,
            reason: null,
          },
        },
      }),
    );
    const quiet = section(artifactOnly, "profile");
    expect(quiet.summary).toContain("No profile field changed");
    expect(quiet.facts.some((f) => f.label === "profilePicUrl changed")).toBe(false);

    const real = buildPeriodReport(
      input({
        ledger: {
          ...base.ledger,
          profileChanges: {
            rows: [
              {
                field: "profilePicUrl",
                from: "https://a.cdninstagram.com/v/t51.2885-19/abc_n.jpg?oh=1",
                to: "https://a.cdninstagram.com/v/t51.2885-19/def_n.jpg?oh=1",
                at: "2026-10-12T00:00:00.000Z",
                evidenceId: "ev_pic",
              },
            ],
            readable: true,
            reason: null,
          },
        },
      }),
    );
    expect(section(real, "profile").summary).toContain("1 profile field change(s)");
    expect(factOf(section(real, "profile"), "profilePicUrl changed").evidenceIds).toEqual(["ev_pic"]);
  });
});

describe("buildPeriodReport: content and engagement", () => {
  it("computes cadence, hashtags, media mix and publish hours from stored posts", () => {
    const report = buildPeriodReport(input({ posts: { rows: CONTENT_ROWS, readable: true, reason: null } }));
    const content = section(report, "content");
    expect(content.state).toBe("DERIVED");
    expect(factOf(content, "Posts observed").value).toBe(2);
    const gap = factOf(content, "Median gap between posts");
    expect(gap.value).toBe(7);
    expect(gap.unit).toBe("days");
    expect(factOf(content, "Longest gap between posts").value).toBe(7);
    // October has 31 days; two posts over the window is 0.06 posts/day.
    expect(factOf(content, "Posts per day").value).toBe(0.06);
    expect(factOf(content, "Posts per day").unit).toBe("posts/day");
    // 2 and 9 October 2026 are Fridays.
    expect(factOf(content, "Weekday distribution (UTC)").value).toBe(
      "Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 2, Sat: 0, Sun: 0",
    );
    expect(factOf(content, "Media mix").value).toBe("IMAGE: 2");
    expect(factOf(content, "Hashtags").value).toBe("#goldenhour (2), #film (1)");
    expect(factOf(content, "Most common publish hours (UTC)").value).toBe("09:00 (2)");
  });

  it("refuses a longest gap below two distinct publish times", () => {
    const one = [post({ id: "post_1", takenAt: "2026-10-02T09:00:00.000Z", evidenceId: "ev_1" })];
    const report = buildPeriodReport(input({ posts: { rows: one, readable: true, reason: null } }));
    const longest = factOf(section(report, "content"), "Longest gap between posts");
    expect(longest.value).toBeNull();
    expect(longest.note).toContain("Fewer than two distinct publish times");
  });

  it("excludes posts with no returned count instead of zero-filling them", () => {
    const report = buildPeriodReport(input({ posts: { rows: CONTENT_ROWS, readable: true, reason: null } }));
    const engagement = section(report, "engagement");
    expect(engagement.state).toBe("DERIVED");
    const likeRows = factOf(engagement, "Posts with a returned like count");
    expect(likeRows.value).toBe(1);
    expect(likeRows.note).toContain("1 post(s) did not return a like count");
    expect(factOf(engagement, "Likes summed over returned counts").value).toBe(10);
    expect(factOf(engagement, "Mean likes per post with a count").value).toBe(10);
    expect(factOf(engagement, "Mean comments per post with a count").value).toBe(1.5);
  });

  it("reports engagement UNAVAILABLE when media rows carry no counts at all", () => {
    const rows = [post({ id: "post_1", takenAt: "2026-10-02T09:00:00.000Z", evidenceId: "ev_1" })];
    const report = buildPeriodReport(input({ posts: { rows, readable: true, reason: null } }));
    const engagement = section(report, "engagement");
    expect(engagement.state).toBe("UNAVAILABLE");
    expect(engagement.reason).toMatch(/absence is reported, not zero/i);
  });
});

describe("buildPeriodReport: evidence and derived values", () => {
  it("caps fact evidence ids while reporting the true count", () => {
    const rows: ReportPost[] = Array.from(
      { length: REPORT_EVIDENCE_SAMPLE_LIMIT + 3 },
      (_, index) =>
        post({
          id: `post_${index}`,
          takenAt: `2026-10-${String(index + 1).padStart(2, "0")}T09:00:00.000Z`,
          likeCount: index,
          commentCount: 0,
          evidenceId: `ev_${String(index).padStart(2, "0")}`,
        }),
    );
    const first = rows[0];
    if (first === undefined) throw new Error("fixture is empty");
    rows.push({
      ...first,
      id: "post_duplicate_evidence",
      takenAt: "2026-10-20T10:00:00.000Z",
    });
    const report = buildPeriodReport(input({ posts: { rows, readable: true, reason: null } }));
    const observed = factOf(section(report, "content"), "Posts observed");
    expect(observed.value).toBe(REPORT_EVIDENCE_SAMPLE_LIMIT + 4);
    expect(observed.evidenceIds).toHaveLength(REPORT_EVIDENCE_SAMPLE_LIMIT);
    expect(observed.evidenceCount).toBe(REPORT_EVIDENCE_SAMPLE_LIMIT + 3);
    expect(renderPeriodReportMarkdown(report)).toContain("+3 more");
  });

  it("renders a metric path and keeps an absence's recorded reason", () => {
    const report = buildPeriodReport(
      input({
        insights: {
          readable: true,
          reason: null,
          rows: [
            { metric: "reach", observedAt: "2026-10-02T00:00:00.000Z", value: 100, unavailableReason: null, evidenceId: "ev_i1" },
            { metric: "reach", observedAt: "2026-10-16T00:00:00.000Z", value: 250, unavailableReason: null, evidenceId: "ev_i2" },
            {
              metric: "profile_views",
              observedAt: "2026-10-17T00:00:00.000Z",
              value: null,
              unavailableReason: "Source returns no profile views.",
              evidenceId: "ev_i3",
            },
          ],
        },
      }),
    );
    const insights = section(report, "insights");
    expect(insights.state).toBe("OBSERVED");
    const reach = factOf(insights, "reach");
    expect(reach.value).toBe("100 → 250 (Δ 150)");
    expect(reach.evidenceCount).toBe(2);
    const views = factOf(insights, "profile_views");
    expect(views.value).toBeNull();
    expect(views.state).toBe("ABSENT");
    expect(views.note).toBe("Source returns no profile views.");
  });

  it("never marks an absent fact as observed, or an observed fact as absent", () => {
    const report = buildPeriodReport(input({ posts: { rows: CONTENT_ROWS, readable: true, reason: null } }));
    for (const owner of report.sections) {
      for (const entry of owner.facts) {
        if (entry.value === null) expect(entry.state).toBe("ABSENT");
        else expect(["OBSERVED", "DERIVED"]).toContain(entry.state);
      }
    }
  });

  it("keeps relationship rows in their evidence class", () => {
    const report = buildPeriodReport(
      input({
        relationships: {
          readable: true,
          reason: null,
          rows: [
            {
              username: "alice",
              score: 4.5,
              mentions: 2,
              comments: 1,
              deltas: 0,
              lastSignalAt: "2026-10-10T00:00:00.000Z",
              sourceClass: "LIVE",
            },
          ],
        },
      }),
    );
    const relationships = section(report, "relationships");
    expect(relationships.state).toBe("DERIVED");
    const alice = factOf(relationships, "@alice");
    expect(alice.value).toBe(4.5);
    expect(alice.note).toContain("LIVE — 2 mention(s), 1 comment(s), 0 delta(s)");
  });

  it("counts story days and surfaces mention evidence", () => {
    const report = buildPeriodReport(
      input({
        stories: {
          readable: true,
          reason: null,
          rows: [
            { id: "story_1", takenAt: "2026-10-03T08:00:00.000Z", mediaType: "IMAGE", expiresAt: null, evidenceId: "ev_s1" },
            { id: "story_2", takenAt: "2026-10-03T18:00:00.000Z", mediaType: "VIDEO", expiresAt: null, evidenceId: "ev_s2" },
          ],
        },
        mentions: {
          readable: true,
          reason: null,
          rows: [
            {
              id: "mention_1",
              observedAt: "2026-10-03T08:00:00.000Z",
              mentionedUsername: "alice",
              storyId: "story_1",
              evidenceId: "ev_s1",
            },
          ],
        },
      }),
    );
    const stories = section(report, "stories");
    expect(stories.state).toBe("OBSERVED");
    expect(factOf(stories, "Stories observed").note).toContain("1 distinct UTC day(s)");
    expect(factOf(stories, "Accounts mentioned in stories").value).toBe("@alice (1)");
  });
});

describe("renderPeriodReportMarkdown", () => {
  it("renders byte-identically for the same ledger and window", () => {
    const source = input({ posts: { rows: CONTENT_ROWS, readable: true, reason: null } });
    const first = renderPeriodReportMarkdown(buildPeriodReport(source));
    // A different composition instant must not change a byte: the window, not
    // the clock, decides what the Markdown says.
    const second = renderPeriodReportMarkdown(
      buildPeriodReport({ ...source, generatedAt: "2027-03-04T05:06:07.000Z" }),
    );
    expect(first).toBe(second);
    expect(first).not.toContain("Generated:");
    expect(first).toContain("# aurora.wilde — monthly report 2026-10");
    expect(first).toContain("| Follower count at window start | 100 followers | OBSERVED |");
    expect(first).toContain("_not observable_");
    expect(first).toContain("it is never zero");
    expect(first).toContain("Window: **1 Oct 2026 00:00 UTC → 1 Nov 2026 00:00 UTC**");
  });

  it("prints the evidence class derived from the rows, including MIXED and NONE", () => {
    const mixed = renderPeriodReportMarkdown(
      buildPeriodReport(
        input({
          evidence: {
            sourceIds: ["fixture:v1", "public:web:v1"],
            evidenceClass: "MIXED",
            synthetic: false,
            note: "Mixed sources.",
          },
        }),
      ),
    );
    expect(mixed).toContain(
      "Evidence class: **MIXED** · sources: fixture:v1, public:web:v1",
    );
    expect(mixed).toContain("| Evidence class | MIXED | OBSERVED | Mixed sources. |");

    const none = renderPeriodReportMarkdown(
      buildPeriodReport(
        input({
          evidence: {
            sourceIds: [],
            evidenceClass: "NONE",
            synthetic: false,
            note: "No rows.",
          },
        }),
      ),
    );
    expect(none).toContain("Evidence class: **NONE**\n");
    expect(none).toContain("| Evidence class | _not observable_ | ABSENT | No rows. |");
  });
});
