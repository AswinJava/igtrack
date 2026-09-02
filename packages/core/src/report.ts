import { deriveCadence, deriveThemes, type SynthesisTerm } from "./synthesis.js";
import { isMaterialProfileFieldChange } from "./diff/profile-diff.js";

// ---------------------------------------------------------------------------
// Periodic reports over the stored ledger.
//
// A weekly/monthly narrative built from rows whose provenance stays visible.
// This module composes that artifact from rows IGTrack actually stored: every fact is either OBSERVED (a row says
// it), DERIVED (arithmetic over rows), EMPTY (the source answered, and nothing
// moved) or UNAVAILABLE (the source cannot answer, and the reason is printed).
//
// Pure: no clock, no I/O. The caller supplies the window and the rows, so the
// same ledger renders byte-identically on every run — which is what makes an
// old report reproducible instead of a snapshot of the product's mood.
// ---------------------------------------------------------------------------

export const REPORT_PERIODS = ["weekly", "monthly", "quarterly", "yearly"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export interface ReportWindow {
  period: ReportPeriod;
  /** Inclusive UTC start, ISO instant. */
  start: string;
  /** Exclusive UTC end, ISO instant. */
  end: string;
  /** Calendar label: 2026-W44, 2026-10, 2026-Q4, 2026. */
  label: string;
}

function utcStartOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** ISO-8601 week label for the week containing `d` (Monday-based). */
export function isoWeekLabel(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The calendar window containing `at`, in UTC. Weeks start Monday; months,
 * quarters and years follow the UTC calendar. The end is exclusive.
 */
export function reportWindow(period: ReportPeriod, at: Date = new Date()): ReportWindow {
  const day = utcStartOfDay(at);
  switch (period) {
    case "weekly": {
      const start = addDays(day, -((day.getUTCDay() + 6) % 7));
      return {
        period,
        start: start.toISOString(),
        end: addDays(start, 7).toISOString(),
        label: isoWeekLabel(start),
      };
    }
    case "monthly": {
      const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
      const end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1));
      return {
        period,
        start: start.toISOString(),
        end: end.toISOString(),
        label: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
      };
    }
    case "quarterly": {
      const quarter = Math.floor(day.getUTCMonth() / 3);
      const start = new Date(Date.UTC(day.getUTCFullYear(), quarter * 3, 1));
      const end = new Date(Date.UTC(day.getUTCFullYear(), quarter * 3 + 3, 1));
      return {
        period,
        start: start.toISOString(),
        end: end.toISOString(),
        label: `${start.getUTCFullYear()}-Q${quarter + 1}`,
      };
    }
    case "yearly": {
      const start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
      const end = new Date(Date.UTC(day.getUTCFullYear() + 1, 0, 1));
      return {
        period,
        start: start.toISOString(),
        end: end.toISOString(),
        label: `${start.getUTCFullYear()}`,
      };
    }
  }
}

/**
 * Windows between `from` and `to`, newest first, capped. Used by `reports` to
 * enumerate what the ledger can answer; nothing is precomputed or cached.
 */
export function enumerateReportWindows(
  period: ReportPeriod,
  from: Date,
  to: Date,
  limit = 26,
): ReportWindow[] {
  const out: ReportWindow[] = [];
  let cursor = new Date(to.getTime());
  while (out.length < limit) {
    const window = reportWindow(period, cursor);
    if (new Date(window.end) <= from) break;
    out.push(window);
    cursor = addDays(new Date(window.start), -1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input rows
// ---------------------------------------------------------------------------

export interface ReportProfilePoint {
  id: string;
  at: string;
  followerCount: number | null;
  followingCount: number | null;
  postCount: number | null;
  completeness: string;
  evidenceId: string | null;
}

export interface ReportProfileChange {
  field: string;
  from: string | null;
  to: string | null;
  at: string;
  evidenceId: string | null;
}

export type ReportFollowChange =
  | "NEW_FOLLOWER"
  | "LOST_FOLLOWER"
  | "NEW_FOLLOWING"
  | "LOST_FOLLOWING";

export interface ReportFollowDelta {
  change: ReportFollowChange;
  username: string;
  at: string;
  evidenceId: string | null;
}

export interface ReportFollowCoverage {
  /** COMPLETE snapshots inside the window — the only ones diffable. */
  complete: number;
  /** PARTIAL snapshots inside the window: stored, never diffed. */
  partial: number;
  latestCompleteAt: string | null;
}

export interface ReportPost {
  id: string;
  takenAt: string;
  caption: string | null;
  mediaType: string | null;
  likeCount: number | null;
  commentCount: number | null;
  evidenceId: string | null;
}

export interface ReportStory {
  id: string;
  takenAt: string;
  mediaType: string;
  expiresAt: string | null;
  evidenceId: string | null;
}

export interface ReportComment {
  id: string;
  commentedAt: string;
  authorUsername: string;
  postId: string;
  /** The comment text exactly as the source returned it. */
  body: string;
  evidenceId: string | null;
}

export interface ReportMention {
  id: string;
  observedAt: string;
  mentionedUsername: string;
  storyId: string;
  evidenceId: string | null;
}

export interface ReportTag {
  id: string;
  observedAt: string;
  ownerUsername: string | null;
  mediaId: string;
  evidenceId: string | null;
}

export interface ReportInsightPoint {
  metric: string;
  observedAt: string;
  value: number | null;
  unavailableReason: string | null;
  evidenceId: string | null;
}

export interface ReportRelationship {
  username: string;
  score: number;
  mentions: number;
  comments: number;
  deltas: number;
  lastSignalAt: string | null;
  /** Which evidence class produced the rank; live and synthetic are never blended. */
  sourceClass: "LIVE" | "SYNTHETIC";
}

/**
 * A data family's input. `readable` is the caller's statement about whether the
 * configured sources can answer this class at all — not whether rows exist. A
 * readable family with zero rows is EMPTY; an unreadable one is UNAVAILABLE
 * with the source's reason. The composer never decides this from row count,
 * because "no rows" and "cannot look" are different findings.
 */
export interface ReportSectionInput<T> {
  rows: T[];
  readable: boolean;
  reason: string | null;
}

export type ReportEvidenceClass = "LIVE" | "SYNTHETIC" | "MIXED" | "NONE";

export interface PeriodReportInput {
  target: {
    username: string;
    platformId: string | null;
    observationMode: "OWNED" | "DISCOVERY";
    localName?: string | null;
  };
  window: ReportWindow;
  generatedAt: string;
  evidence: {
    sourceIds: string[];
    /**
     * Derived from the stored evidence rows this window actually used — never
     * from whichever provider is configured right now. A live observation
     * must not be relabelled synthetic (or vice versa) because the CLI happens
     * to run with a different provider.
     */
    evidenceClass: ReportEvidenceClass;
    synthetic: boolean;
    note: string;
  };
  ledger: {
    earliestAt: string | null;
    baseline: ReportProfilePoint | null;
    profilePoints: ReportProfilePoint[];
    profileChanges: ReportSectionInput<ReportProfileChange>;
  };
  audience: {
    deltas: ReportSectionInput<ReportFollowDelta>;
    followers: ReportFollowCoverage;
    following: ReportFollowCoverage;
  };
  posts: ReportSectionInput<ReportPost>;
  stories: ReportSectionInput<ReportStory>;
  comments: ReportSectionInput<ReportComment>;
  mentions: ReportSectionInput<ReportMention>;
  tags: ReportSectionInput<ReportTag>;
  insights: ReportSectionInput<ReportInsightPoint>;
  relationships: ReportSectionInput<ReportRelationship>;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type ReportSectionState = "OBSERVED" | "DERIVED" | "EMPTY" | "UNAVAILABLE";
export type ReportFactState = "OBSERVED" | "DERIVED" | "ABSENT";

export interface ReportFact {
  label: string;
  value: number | string | null;
  unit: string | null;
  state: ReportFactState;
  evidenceIds: string[];
  /** Total evidence rows behind the fact; `evidenceIds` is bounded. */
  evidenceCount: number;
  note: string | null;
}

export interface ReportSection {
  id: string;
  title: string;
  state: ReportSectionState;
  summary: string;
  facts: ReportFact[];
  reason: string | null;
}

export interface PeriodReport {
  target: PeriodReportInput["target"];
  period: ReportPeriod;
  window: ReportWindow;
  generatedAt: string;
  evidence: PeriodReportInput["evidence"];
  ledger: { earliestAt: string | null; baselineAt: string | null };
  sections: ReportSection[];
  gaps: Array<{ section: string; reason: string }>;
}

export const REPORT_EVIDENCE_SAMPLE_LIMIT = 12;

function uniqueEvidence(ids: ReadonlyArray<string | null | undefined>): {
  evidenceIds: string[];
  evidenceCount: number;
} {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || set.has(id)) continue;
    set.add(id);
    seen.push(id);
  }
  return {
    evidenceIds: seen.slice(0, REPORT_EVIDENCE_SAMPLE_LIMIT),
    evidenceCount: seen.length,
  };
}

function fact(
  label: string,
  value: number | string | null,
  options: {
    unit?: string | null;
    state?: ReportFactState;
    evidence?: ReadonlyArray<string | null | undefined>;
    note?: string | null;
  } = {},
): ReportFact {
  const evidence = uniqueEvidence(options.evidence ?? []);
  return {
    label,
    value,
    unit: options.unit ?? null,
    state: options.state ?? (value === null ? "ABSENT" : "OBSERVED"),
    evidenceIds: evidence.evidenceIds,
    evidenceCount: evidence.evidenceCount,
    note: options.note ?? null,
  };
}

function derivedFact(
  label: string,
  value: number | string | null,
  evidence: ReadonlyArray<string | null | undefined>,
  options: { unit?: string | null; note?: string | null } = {},
): ReportFact {
  return fact(label, value, {
    ...options,
    state: value === null ? "ABSENT" : "DERIVED",
    evidence,
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function countBy<T>(rows: readonly T[], key: (row: T) => string | null): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    if (k === null || k === "") continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function sectionState<T>(input: ReportSectionInput<T>, rowCount?: number): ReportSectionState {
  const count = rowCount ?? input.rows.length;
  if (!input.readable) return "UNAVAILABLE";
  return count > 0 ? "OBSERVED" : "EMPTY";
}

function emptyReason<T>(input: ReportSectionInput<T>, fallback: string): string {
  if (!input.readable) return input.reason ?? fallback;
  return input.reason ?? "The source answered; nothing was recorded in this window.";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatUtcInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = MONTHS[d.getUTCMonth()] ?? "?";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()} ${hh}:${mm} UTC`;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function profileSection(input: PeriodReportInput): ReportSection {
  const baseline = input.ledger.baseline;
  const points = input.ledger.profilePoints;
  // Only COMPLETE snapshots may anchor a count comparison: a PARTIAL read is
  // stored, but diffing against it could manufacture a follower change.
  const completePoints = points.filter((p) => p.completeness === "COMPLETE");
  const last = completePoints.length > 0 ? completePoints[completePoints.length - 1] ?? null : null;
  const changes = input.ledger.profileChanges;
  const readable = input.ledger.baseline !== null || points.length > 0 || changes.readable;

  if (!readable) {
    return {
      id: "profile",
      title: "Profile",
      state: "UNAVAILABLE",
      summary: "No profile observation exists for this account, so no growth can be reported.",
      facts: [],
      reason:
        changes.reason ??
        "No profile snapshot was recorded at or before this window. Run a profile scan first.",
    };
  }

  const facts: ReportFact[] = [];
  const baselineEvidence = baseline?.evidenceId ?? null;
  const endEvidence = last?.evidenceId ?? baselineEvidence;

  const addCount = (label: string, pick: (p: ReportProfilePoint) => number | null, unit: string) => {
    const before = baseline === null ? null : pick(baseline);
    const after = last === null ? null : pick(last);
    facts.push(
      fact(`${label} at window start`, before, {
        unit,
        evidence: baselineEvidence === null ? [] : [baselineEvidence],
        note: baseline === null ? "No snapshot at or before the window start." : formatUtcInstant(baseline.at),
      }),
    );
    facts.push(
      fact(`${label} at latest observation`, after, {
        unit,
        evidence: endEvidence === null ? [] : [endEvidence],
        note: last === null ? "No snapshot inside this window." : formatUtcInstant(last.at),
      }),
    );
    const delta = before !== null && after !== null ? after - before : null;
    facts.push(
      derivedFact(`${label} change`, delta, [baselineEvidence, endEvidence].filter((x): x is string => x !== null), {
        unit,
        note:
          delta === null
            ? "Both endpoints must be observed before a change can be computed; one is missing."
            : "After minus before, over the snapshots named on the endpoints.",
      }),
    );
  };

  addCount("Follower count", (p) => p.followerCount, "followers");
  addCount("Following count", (p) => p.followingCount, "accounts");
  addCount("Post count", (p) => p.postCount, "posts");

  const partialPoints = points.filter((p) => p.completeness !== "COMPLETE").length;
  facts.push(
    fact("Profile snapshots in window", points.length, {
      note:
        partialPoints > 0
          ? `${partialPoints} stored snapshot(s) were PARTIAL and are never diffed.`
          : "All snapshots in this window were COMPLETE.",
    }),
  );

  const materialChanges = changes.rows.filter((change) =>
    isMaterialProfileFieldChange(change.field, change.from, change.to),
  );
  for (const change of materialChanges) {
    facts.push(
      fact(`${change.field} changed`, `${change.from ?? "—"} → ${change.to ?? "—"}`, {
        state: "DERIVED",
        evidence: [change.evidenceId],
        note: formatUtcInstant(change.at),
      }),
    );
  }

  const changed = materialChanges.length > 0;
  const hasPoints = completePoints.length > 0;
  return {
    id: "profile",
    title: "Profile",
    state: hasPoints || changed ? (changed ? "DERIVED" : "OBSERVED") : "EMPTY",
    summary: changed
      ? `${materialChanges.length} profile field change(s); counts are compared against the last snapshot at or before the window start.`
      : baseline === null
        ? "No snapshot exists at or before the window start, so no count change can be computed; the counts shown are the observations inside this window."
        : "No profile field changed. Counts compare the baseline snapshot with the latest observation.",
    facts,
    reason: hasPoints || changed
      ? null
      : points.length > 0
        ? "Every snapshot in this window was PARTIAL; partial reads are stored but never diffed, so no count change is reported."
        : baseline === null
          ? "No profile snapshot exists at or before this window, so there is no endpoint to compare and no count change can be reported."
          : "The account was observed before this window but not inside it.",
  };
}

function audienceSection(input: PeriodReportInput): ReportSection {
  const { deltas, followers, following } = input.audience;
  const facts: ReportFact[] = [];
  const byChange = (change: ReportFollowChange) => deltas.rows.filter((d) => d.change === change);
  const newFollowers = byChange("NEW_FOLLOWER");
  const lostFollowers = byChange("LOST_FOLLOWER");
  const newFollowing = byChange("NEW_FOLLOWING");
  const lostFollowing = byChange("LOST_FOLLOWING");

  const named = (rows: ReportFollowDelta[], limit = 10): string =>
    rows.length === 0 ? "—" : rows.slice(0, limit).map((r) => `@${r.username}`).join(", ") +
      (rows.length > limit ? ` (+${rows.length - limit} more)` : "");

  const rosterSnapshots = followers.complete + followers.partial + following.complete + following.partial;
  const completeSnapshots = followers.complete + following.complete;
  // A delta count of 0 is a claim that two COMPLETE rosters were diffed and
  // nothing moved. Without such a roster in the window the count is unknown,
  // not zero, so the fact prints `_not observable_` instead.
  const movementObservable = deltas.readable && (completeSnapshots > 0 || deltas.rows.length > 0);
  const movementNote = (rows: ReportFollowDelta[]): string =>
    movementObservable
      ? named(rows)
      : "No COMPLETE roster snapshot in this window; movement is not observable.";

  facts.push(
    derivedFact(
      "New followers",
      movementObservable ? newFollowers.length : null,
      newFollowers.map((r) => r.evidenceId),
      { note: movementNote(newFollowers) },
    ),
  );
  facts.push(
    derivedFact(
      "Lost followers",
      movementObservable ? lostFollowers.length : null,
      lostFollowers.map((r) => r.evidenceId),
      { note: movementNote(lostFollowers) },
    ),
  );
  facts.push(
    derivedFact(
      "New following",
      movementObservable ? newFollowing.length : null,
      newFollowing.map((r) => r.evidenceId),
      { note: movementNote(newFollowing) },
    ),
  );
  facts.push(
    derivedFact(
      "Lost following",
      movementObservable ? lostFollowing.length : null,
      lostFollowing.map((r) => r.evidenceId),
      { note: movementNote(lostFollowing) },
    ),
  );
  facts.push(
    derivedFact(
      "Net follower change (recorded movements)",
      movementObservable ? newFollowers.length - lostFollowers.length : null,
      [...newFollowers, ...lostFollowers].map((r) => r.evidenceId),
      {
        note: movementObservable
          ? "Counts recorded change events, not the account's own follower total. A week with no scans has no events; it is not a week with no movement."
          : "No COMPLETE roster snapshot in this window; a net change is not observable.",
      },
    ),
  );
  facts.push(
    fact("Follower snapshots in window", followers.complete + followers.partial, {
      note: `${followers.complete} COMPLETE (diffable), ${followers.partial} PARTIAL (stored, never diffed). Latest COMPLETE: ${
        followers.latestCompleteAt === null ? "none" : formatUtcInstant(followers.latestCompleteAt)
      }.`,
    }),
  );
  facts.push(
    fact("Following snapshots in window", following.complete + following.partial, {
      note: `${following.complete} COMPLETE (diffable), ${following.partial} PARTIAL (stored, never diffed). Latest COMPLETE: ${
        following.latestCompleteAt === null ? "none" : formatUtcInstant(following.latestCompleteAt)
      }.`,
    }),
  );

  const state = !deltas.readable && rosterSnapshots === 0
    ? "UNAVAILABLE"
    : deltas.rows.length > 0
      ? "DERIVED"
      : "EMPTY";
  const emptySummary =
    completeSnapshots > 0
      ? "Roster snapshots exist for this window, but no membership change was recorded."
      : rosterSnapshots > 0
        ? "Only PARTIAL roster snapshots fall inside this window; partial reads are stored but never diffed, so no membership change is reported."
        : "No roster snapshot falls inside this window, so no membership change can be recorded.";
  const emptyReason =
    completeSnapshots > 0
      ? "Zero recorded deltas means no change was observed between COMPLETE snapshots, not that the account had no activity."
      : rosterSnapshots > 0
        ? "Only PARTIAL roster snapshots fall inside this window; they are stored but never diffed, so no unfollow or follow is invented."
        : "No COMPLETE roster snapshot was taken inside this window. Silence here is an observation gap, not an unchanged audience.";
  return {
    id: "audience",
    title: "Audience",
    state,
    summary:
      state === "UNAVAILABLE"
        ? "No follower/following roster has ever been recorded, so movement cannot be reported."
        : state === "EMPTY"
          ? emptySummary
          : `${newFollowers.length} new and ${lostFollowers.length} lost follower(s) were recorded; ${newFollowing.length} new and ${lostFollowing.length} lost following.`,
    facts,
    reason:
      state === "UNAVAILABLE"
        ? deltas.reason ??
          "The configured source does not expose rosters. Follow counts remain observable in the Profile section; the roster itself is documented absent."
        : state === "EMPTY"
          ? emptyReason
          : null,
  };
}

function contentSection(input: PeriodReportInput): ReportSection {
  const posts = input.posts;
  const facts: ReportFact[] = [];
  if (!posts.readable) {
    return {
      id: "content",
      title: "Posts and cadence",
      state: "UNAVAILABLE",
      summary: "The configured source does not expose media, so no publishing activity can be reported.",
      facts: [],
      reason: posts.reason ?? "No media source is available for this target.",
    };
  }
  if (posts.rows.length === 0) {
    return {
      id: "content",
      title: "Posts and cadence",
      state: "EMPTY",
      summary: "No post with a published time inside this window was observed.",
      facts: [],
      reason: posts.reason ?? "The source answered; nothing was published in this window.",
    };
  }

  const timestamps = posts.rows.map((p) => new Date(p.takenAt));
  const cadence = deriveCadence(timestamps);
  const themes = deriveThemes(posts.rows.map((p) => p.caption), { limit: 8 });
  const media = countBy(posts.rows, (p) => p.mediaType);

  facts.push(
    fact("Posts observed", posts.rows.length, {
      evidence: posts.rows.map((p) => p.evidenceId),
      note: `Published between ${formatUtcInstant(cadence.firstPublishedAt ?? input.window.start)} and ${formatUtcInstant(cadence.lastPublishedAt ?? input.window.end)}.`,
    }),
  );
  facts.push(
    derivedFact(
      "Median gap between posts",
      cadence.medianGapDays,
      posts.rows.map((p) => p.evidenceId),
      {
        unit: "days",
        note:
          cadence.medianGapDays === null
            ? "Fewer than two distinct publish times; a cadence would be invented."
            : `Computed across ${cadence.timestampRows} distinct publish times.`,
      },
    ),
  );
  const windowDays = (Date.parse(input.window.end) - Date.parse(input.window.start)) / 86_400_000;
  facts.push(
    derivedFact(
      "Posts per day",
      round2(posts.rows.length / windowDays),
      posts.rows.map((p) => p.evidenceId),
      {
        unit: "posts/day",
        note: `${posts.rows.length} post(s) over the ${windowDays} calendar day(s) of the window. Days the source was not scanned still count as days.`,
      },
    ),
  );
  facts.push(
    derivedFact(
      "Longest gap between posts",
      cadence.longestGapDays,
      posts.rows.map((p) => p.evidenceId),
      {
        unit: "days",
        note:
          cadence.longestGapDays === null
            ? "Fewer than two distinct publish times inside the window; a longest gap would be invented."
            : `Largest interval across ${cadence.timestampRows} distinct publish times inside the window. Gaps to posts outside the window are not counted.`,
      },
    ),
  );
  const weekdayCounts = new Map<string, number>();
  for (const p of posts.rows) {
    const d = new Date(p.takenAt);
    if (Number.isNaN(d.getTime())) continue;
    const name = WEEKDAYS[(d.getUTCDay() + 6) % 7] as string;
    weekdayCounts.set(name, (weekdayCounts.get(name) ?? 0) + 1);
  }
  facts.push(
    derivedFact(
      "Weekday distribution (UTC)",
      [...weekdayCounts.keys()].length === 0
        ? null
        : WEEKDAYS.map((name) => `${name}: ${weekdayCounts.get(name) ?? 0}`).join(", "),
      posts.rows.map((p) => p.evidenceId),
      { note: "Counts of stored publish weekdays. Kept as a distribution, not an inferred lifestyle." },
    ),
  );

  facts.push(
    fact(
      "Media mix",
      media.length === 0
        ? null
        : media.map(([type, count]) => `${type}: ${count}`).join(", "),
      { evidence: posts.rows.map((p) => p.evidenceId) },
    ),
  );
  facts.push(
    derivedFact(
      "Hashtags",
      themes.hashtags.length === 0 ? null : themes.hashtags.map((h: SynthesisTerm) => `#${h.term} (${h.count})`).join(", "),
      posts.rows.map((p) => p.evidenceId),
      {
        note: `Across ${themes.captionRows} caption(s) with text. An empty list means those captions carried no hashtags.`,
      },
    ),
  );
  facts.push(
    derivedFact(
      "Top caption terms",
      themes.terms.length === 0 ? null : themes.terms.map((t) => `${t.term} (${t.count})`).join(", "),
      posts.rows.map((p) => p.evidenceId),
      {
        note: "Counts over the stored captions only. This is text frequency, not an inferred interest.",
      },
    ),
  );

  const activeHours = countBy(posts.rows, (p) => {
    const d = new Date(p.takenAt);
    return Number.isNaN(d.getTime()) ? null : `${String(d.getUTCHours()).padStart(2, "0")}:00`;
  })
    .slice(0, 3)
    .map(([hour, count]) => `${hour} (${count})`)
    .join(", ");
  facts.push(
    derivedFact("Most common publish hours (UTC)", activeHours === "" ? null : activeHours, posts.rows.map((p) => p.evidenceId), {
      note: "Distribution of the stored publish timestamps; not a platform 'best time' recommendation.",
    }),
  );

  return {
    id: "content",
    title: "Posts and cadence",
    state: "DERIVED",
    summary: `${posts.rows.length} post(s) published in the window; cadence and caption terms are computed from those rows.`,
    facts,
    reason: null,
  };
}

function engagementSection(input: PeriodReportInput): ReportSection {
  const posts = input.posts;
  if (!posts.readable) {
    return {
      id: "engagement",
      title: "Engagement",
      state: "UNAVAILABLE",
      summary: "No media source is available, so engagement counts cannot be reported.",
      facts: [],
      reason: posts.reason ?? "The source does not expose media.",
    };
  }
  const withLikes = posts.rows.filter((p) => p.likeCount !== null);
  const withComments = posts.rows.filter((p) => p.commentCount !== null);
  if (posts.rows.length === 0) {
    return {
      id: "engagement",
      title: "Engagement",
      state: "EMPTY",
      summary: "No post in this window, so there is no engagement to aggregate.",
      facts: [],
      reason: posts.reason ?? "No posts published in this window.",
    };
  }
  const likes = withLikes.map((p) => p.likeCount as number);
  const comments = withComments.map((p) => p.commentCount as number);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const facts: ReportFact[] = [
    fact("Posts with a returned like count", withLikes.length, {
      evidence: withLikes.map((p) => p.evidenceId),
      note: `${posts.rows.length - withLikes.length} post(s) did not return a like count; those are excluded, not zero-filled.`,
    }),
    derivedFact("Likes summed over returned counts", likes.length === 0 ? null : sum(likes), withLikes.map((p) => p.evidenceId), {
      note: likes.length === 0 ? "No post returned a like count." : null,
    }),
    derivedFact(
      "Mean likes per post with a count",
      likes.length === 0 ? null : round1(sum(likes) / likes.length),
      withLikes.map((p) => p.evidenceId),
    ),
    fact("Posts with a returned comment count", withComments.length, {
      evidence: withComments.map((p) => p.evidenceId),
      note: `${posts.rows.length - withComments.length} post(s) did not return a comment count.`,
    }),
    derivedFact(
      "Mean comments per post with a count",
      comments.length === 0 ? null : round1(sum(comments) / comments.length),
      withComments.map((p) => p.evidenceId),
    ),
  ];
  const state = likes.length === 0 && comments.length === 0 ? "UNAVAILABLE" : "DERIVED";
  return {
    id: "engagement",
    title: "Engagement",
    state,
    summary:
      state === "UNAVAILABLE"
        ? "The media rows carry no like or comment count, so engagement cannot be aggregated."
        : `${likes.length} post(s) returned likes and ${comments.length} returned comments; sums and means cover only those rows.`,
    facts,
    reason:
      state === "UNAVAILABLE"
        ? "This source does not return like/comment counts on the observed media. Absence is reported, not zero."
        : null,
  };
}

function storiesSection(input: PeriodReportInput): ReportSection {
  const stories = input.stories;
  const mentions = input.mentions;
  if (!stories.readable) {
    return {
      id: "stories",
      title: "Stories",
      state: "UNAVAILABLE",
      summary: "The configured source does not expose stories, so story activity cannot be reported.",
      facts: [],
      reason: stories.reason ?? "No story source is available for this target.",
    };
  }
  if (stories.rows.length === 0) {
    return {
      id: "stories",
      title: "Stories",
      state: "EMPTY",
      summary: "No story with a publish time inside this window was observed.",
      facts: [],
      reason: stories.reason ?? "The source answered; no active story was recorded in this window.",
    };
  }
  const days = new Set(stories.rows.map((s) => s.takenAt.slice(0, 10)));
  const media = countBy(stories.rows, (s) => s.mediaType);
  const facts: ReportFact[] = [
    fact("Stories observed", stories.rows.length, {
      evidence: stories.rows.map((s) => s.evidenceId),
      note: `${days.size} distinct UTC day(s). Stories expire after ~24h; this counts first observations, not views.`,
    }),
    fact(
      "Story media mix",
      media.length === 0 ? null : media.map(([type, count]) => `${type}: ${count}`).join(", "),
      { evidence: stories.rows.map((s) => s.evidenceId) },
    ),
  ];
  if (mentions.readable) {
    const named = countBy(mentions.rows, (m) => m.mentionedUsername);
    facts.push(
      derivedFact(
        "Accounts mentioned in stories",
        mentions.rows.length === 0 ? null : named.map(([name, count]) => `@${name} (${count})`).join(", "),
        mentions.rows.map((m) => m.evidenceId),
        {
          note:
            mentions.rows.length === 0
              ? "No mention was recorded in the window's stories."
              : "Mention presence is stored metadata; it is not proof the sticker rendered.",
        },
      ),
    );
  }
  return {
    id: "stories",
    title: "Stories",
    state: "OBSERVED",
    summary: `${stories.rows.length} story observation(s) across ${days.size} day(s).`,
    facts,
    reason: null,
  };
}

function commentsSection(input: PeriodReportInput): ReportSection {
  const comments = input.comments;
  if (!comments.readable) {
    return {
      id: "comments",
      title: "Comments",
      state: "UNAVAILABLE",
      summary: "The configured source does not expose comment lists, so comment activity cannot be reported.",
      facts: [],
      reason: comments.reason ?? "No comment source is available for this target.",
    };
  }
  if (comments.rows.length === 0) {
    return {
      id: "comments",
      title: "Comments",
      state: "EMPTY",
      summary: "No comment inside this window was observed.",
      facts: [],
      reason: comments.reason ?? "The source answered; no comment was recorded in this window.",
    };
  }
  const authors = countBy(comments.rows, (c) => c.authorUsername);
  return {
    id: "comments",
    title: "Comments",
    state: "OBSERVED",
    summary: `${comments.rows.length} comment(s) from ${authors.length} account(s).`,
    facts: [
      fact("Comments observed", comments.rows.length, {
        evidence: comments.rows.map((c) => c.evidenceId),
        note: "Only comments the source returned; a truncated listing is labelled as such by the scan, not here.",
      }),
      derivedFact("Distinct authors", authors.length, comments.rows.map((c) => c.evidenceId)),
      derivedFact(
        "Top authors",
        authors.slice(0, 5).map(([name, count]) => `@${name} (${count})`).join(", ") || null,
        comments.rows.map((c) => c.evidenceId),
      ),
    ],
    reason: null,
  };
}

function tagsSection(input: PeriodReportInput): ReportSection {
  const tags = input.tags;
  if (!tags.readable) {
    return {
      id: "tagged",
      title: "Tagged media",
      state: "UNAVAILABLE",
      summary: "The configured source does not expose the tags edge, so tagged media cannot be reported.",
      facts: [],
      reason: tags.reason ?? "No tagged-media source is available for this target.",
    };
  }
  if (tags.rows.length === 0) {
    return {
      id: "tagged",
      title: "Tagged media",
      state: "EMPTY",
      summary: "No tagged-media row was first observed in this window.",
      facts: [],
      reason:
        tags.reason ??
        "Rows are insert-once: an account already observed before this window does not reappear. This is not proof the tag was removed.",
    };
  }
  const owners = countBy(tags.rows, (t) => t.ownerUsername);
  return {
    id: "tagged",
    title: "Tagged media",
    state: "OBSERVED",
    summary: `${tags.rows.length} tagged-media row(s) first observed, from ${owners.length} owner account(s).`,
    facts: [
      fact("Tagged media first observed", tags.rows.length, {
        evidence: tags.rows.map((t) => t.evidenceId),
        note: "First observation only. A row never rewrites, and removal is never claimed.",
      }),
      derivedFact(
        "Owners",
        owners.slice(0, 10).map(([name, count]) => `@${name} (${count})`).join(", ") || null,
        tags.rows.map((t) => t.evidenceId),
      ),
    ],
    reason: null,
  };
}

function insightsSection(input: PeriodReportInput): ReportSection {
  const insights = input.insights;
  if (!insights.readable) {
    return {
      id: "insights",
      title: "Account insights",
      state: "UNAVAILABLE",
      summary: "No insights source is available for this account.",
      facts: [],
      reason: insights.reason ?? "The configured source does not expose own-account insights.",
    };
  }
  if (insights.rows.length === 0) {
    return {
      id: "insights",
      title: "Account insights",
      state: "EMPTY",
      summary: "No insight point was recorded in this window.",
      facts: [],
      reason: insights.reason ?? "The source answered; no insight point was recorded in this window.",
    };
  }
  const metrics = new Map<string, ReportInsightPoint[]>();
  for (const point of insights.rows) {
    const list = metrics.get(point.metric) ?? [];
    list.push(point);
    metrics.set(point.metric, list);
  }
  const facts: ReportFact[] = [];
  for (const [metric, points] of [...metrics.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const values = points.filter((p) => p.value !== null);
    const first = values[0];
    const last = values[values.length - 1];
    const delta = first !== undefined && last !== undefined && values.length >= 2
      ? (last.value as number) - (first.value as number)
      : null;
    facts.push(
      derivedFact(
        metric,
        values.length === 0
          ? null
          : `${first?.value ?? "?"} → ${last?.value ?? "?"}${delta === null ? "" : ` (Δ ${round1(delta)})`}`,
        points.map((p) => p.evidenceId),
        {
          note:
            values.length === 0
              ? points[0]?.unavailableReason ?? "All points for this metric are absences with a reason."
              : `${values.length} measured point(s)${points.length > values.length ? `, ${points.length - values.length} absence row(s)` : ""}.`,
        },
      ),
    );
  }
  return {
    id: "insights",
    title: "Account insights",
    state: "OBSERVED",
    summary: `${metrics.size} metric(s) carry rows in this window; absence rows keep their recorded reason.`,
    facts,
    reason: null,
  };
}

function relationshipsSection(input: PeriodReportInput): ReportSection {
  const rel = input.relationships;
  if (!rel.readable) {
    return {
      id: "relationships",
      title: "Relationships",
      state: "UNAVAILABLE",
      summary: "Relationship ranking is not available for this target.",
      facts: [],
      reason: rel.reason ?? "No signal source is available.",
    };
  }
  if (rel.rows.length === 0) {
    return {
      id: "relationships",
      title: "Relationships",
      state: "EMPTY",
      summary: "No account carried an observed relationship signal.",
      facts: [],
      reason:
        rel.reason ??
        "Mentions, comment authorship and recorded follow deltas are the only signals; absence of a signal is not absence of a relationship.",
    };
  }
  const facts = rel.rows.slice(0, 10).map((rank) =>
    derivedFact(
      `@${rank.username}`,
      rank.score,
      [],
      {
        note: `${rank.sourceClass} — ${rank.mentions} mention(s), ${rank.comments} comment(s), ${rank.deltas} delta(s); last signal ${
          rank.lastSignalAt === null ? "not recorded" : formatUtcInstant(rank.lastSignalAt)
        }.`,
      },
    ),
  );
  return {
    id: "relationships",
    title: "Relationships",
    state: "DERIVED",
    summary: `${rel.rows.length} account(s) carry observed signal inside this window. Score weights are those used by \`igtrack relationships\`; counts are bounded by the window, not a rolling recency view.`,
    facts,
    reason: null,
  };
}

export function buildPeriodReport(input: PeriodReportInput): PeriodReport {
  const sections: ReportSection[] = [
    profileSection(input),
    audienceSection(input),
    contentSection(input),
    engagementSection(input),
    storiesSection(input),
    commentsSection(input),
    mentionsSection(input),
    tagsSection(input),
    insightsSection(input),
    relationshipsSection(input),
  ];

  const coverage: ReportSection = {
    id: "coverage",
    title: "Coverage and provenance",
    state: "OBSERVED",
    summary: "What this report could read, and what it could not.",
    facts: [
      fact("Window", `${formatUtcInstant(input.window.start)} → ${formatUtcInstant(input.window.end)}`, {
        note: `Calendar label ${input.window.label}; end exclusive.`,
      }),
      fact("Ledger begins", input.ledger.earliestAt === null ? null : formatUtcInstant(input.ledger.earliestAt), {
        note: input.ledger.earliestAt === null ? "No rows exist for this target." : "Nothing before this instant can appear in any report.",
      }),
      fact(
        "Baseline snapshot",
        input.ledger.baseline === null ? null : formatUtcInstant(input.ledger.baseline.at),
        {
          note:
            input.ledger.baseline === null
              ? "No snapshot at or before the window start; count deltas are absent rather than guessed."
              : "The last profile observation at or before the window start.",
        },
      ),
      fact("Sources", input.evidence.sourceIds.length === 0 ? null : input.evidence.sourceIds.join(", ")),
      fact("Evidence class", input.evidence.evidenceClass === "NONE" ? null : input.evidence.evidenceClass, {
        note: input.evidence.note,
      }),
    ],
    reason: null,
  };
  sections.push(coverage);

  const gaps = sections
    .filter((s) => s.state === "UNAVAILABLE" || s.state === "EMPTY")
    .map((s) => ({ section: s.title, reason: s.reason ?? s.summary }));

  return {
    target: input.target,
    period: input.window.period,
    window: input.window,
    generatedAt: input.generatedAt,
    evidence: input.evidence,
    ledger: {
      earliestAt: input.ledger.earliestAt,
      baselineAt: input.ledger.baseline?.at ?? null,
    },
    sections,
    gaps,
  };
}

function mentionsSection(input: PeriodReportInput): ReportSection {
  const mentions = input.mentions;
  if (!mentions.readable) {
    return {
      id: "mentions",
      title: "Story mentions",
      state: "UNAVAILABLE",
      summary: "The configured source does not expose story metadata, so mentions cannot be reported.",
      facts: [],
      reason: mentions.reason ?? "No story-mention source is available for this target.",
    };
  }
  if (mentions.rows.length === 0) {
    return {
      id: "mentions",
      title: "Story mentions",
      state: "EMPTY",
      summary: "No story mention was observed in this window.",
      facts: [],
      reason: mentions.reason ?? "The source answered; no mention appeared in the stored stories.",
    };
  }
  const named = countBy(mentions.rows, (m) => m.mentionedUsername);
  const stories = new Set(mentions.rows.map((m) => m.storyId));
  return {
    id: "mentions",
    title: "Story mentions",
    state: "OBSERVED",
    summary: `${mentions.rows.length} mention row(s) across ${stories.size} stor(ies).`,
    facts: [
      fact("Mention rows observed", mentions.rows.length, {
        evidence: mentions.rows.map((m) => m.evidenceId),
      }),
      derivedFact(
        "Mentioned accounts",
        named.slice(0, 10).map(([name, count]) => `@${name} (${count})`).join(", ") || null,
        mentions.rows.map((m) => m.evidenceId),
        {
          note: "Metadata presence only; geometry/visibility classes are reported by the story surfaces.",
        },
      ),
    ],
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function displayValue(value: number | string | null, unit: string | null): string {
  if (value === null) return "_not observable_";
  if (typeof value === "number") {
    const rendered = Number.isInteger(value) ? String(value) : String(value);
    return unit === null ? rendered : `${rendered} ${unit}`;
  }
  return unit === null ? value : `${value} ${unit}`;
}

function evidenceSuffix(f: ReportFact): string {
  if (f.evidenceCount === 0) return "";
  const shown = f.evidenceIds.map((id) => `\`${id}\``).join(", ");
  const more = f.evidenceCount > f.evidenceIds.length ? `, +${f.evidenceCount - f.evidenceIds.length} more` : "";
  return ` — evidence: ${shown}${more}`;
}

export function renderPeriodReportMarkdown(report: PeriodReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.target.username} — ${report.window.period} report ${report.window.label}`);
  lines.push("");
  lines.push(`Window: **${formatUtcInstant(report.window.start)} → ${formatUtcInstant(report.window.end)}** (end exclusive)`);
  lines.push("");
  lines.push(
    `Evidence class: **${report.evidence.evidenceClass}**${
      report.evidence.sourceIds.length === 0 ? "" : ` · sources: ${report.evidence.sourceIds.join(", ")}`
    }`,
  );
  lines.push("");
  lines.push("This report is computed from stored rows only; it fetches nothing. The JSON payload carries `generatedAt`; this rendering is window-deterministic.");
  lines.push("");

  for (const section of report.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    lines.push(`**${section.state}** — ${section.summary}`);
    lines.push("");
    if (section.facts.length > 0) {
      lines.push("| Fact | Value | Class | Note |");
      lines.push("|---|---|---|---|");
      for (const f of section.facts) {
        const note = `${f.note ?? ""}${evidenceSuffix(f)}`.replace(/\|/g, "\\|");
        lines.push(`| ${f.label.replace(/\|/g, "\\|")} | ${displayValue(f.value, f.unit).replace(/\|/g, "\\|")} | ${f.state} | ${note} |`);
      }
      lines.push("");
    }
    if (section.state === "UNAVAILABLE" || section.state === "EMPTY") {
      lines.push(`> ${section.reason ?? section.summary}`);
      lines.push("");
    }
  }

  if (report.gaps.length > 0) {
    lines.push("## Gaps in this report");
    lines.push("");
    for (const gap of report.gaps) {
      lines.push(`- **${gap.section}** — ${gap.reason}`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(
    "Every number above is a stored row or arithmetic over stored rows. `_not observable_` means the source did not answer that class; it is never zero. A report window with no scans records nothing, which is not the same as a quiet account.",
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Audience set algebra (pure)
// ---------------------------------------------------------------------------

export interface AudienceSets {
  /** Roster length when that side has a COMPLETE snapshot; null otherwise. */
  followerCount: number | null;
  followingCount: number | null;
  /** Null unless both rosters are COMPLETE; a one-sided count would be a guess. */
  mutualCount: number | null;
  /** Follows the target; the target does not follow back. */
  notFollowingBack: string[];
  /** Followed by the target; does not follow back. */
  notFollowedBack: string[];
  mutuals: string[];
  /**
   * True when both rosters came from COMPLETE snapshots. When false the caller
   * must not present the sets as an audience answer.
   */
  complete: boolean;
  notes: string[];
}

/**
 * Set algebra over the latest COMPLETE snapshots. Names are compared
 * case-insensitively because a platform username is case-insensitive; the
 * stored spelling of the follower side wins. A partial snapshot must never be
 * passed here — its rows are a truncated read, and set arithmetic over a
 * truncated read invents "unfollows".
 */
export function computeAudienceSets(
  followers: { usernames: readonly string[]; complete: boolean; takenAt: string | null },
  following: { usernames: readonly string[]; complete: boolean; takenAt: string | null },
): AudienceSets {
  const notes: string[] = [];
  if (!followers.complete) notes.push("Follower roster is not from a COMPLETE snapshot; sets are not an audience answer.");
  if (!following.complete) notes.push("Following roster is not from a COMPLETE snapshot; sets are not an audience answer.");
  if (!followers.complete || !following.complete) {
    // Set algebra against an absent roster turns silence into "does not follow
    // back". Refuse the whole answer instead of returning one-sided sets.
    notes.push("An absent roster is not an empty audience: no set is computed until both sides have a COMPLETE snapshot.");
    return {
      followerCount: followers.complete ? followers.usernames.length : null,
      followingCount: following.complete ? following.usernames.length : null,
      mutualCount: null,
      notFollowingBack: [],
      notFollowedBack: [],
      mutuals: [],
      complete: false,
      notes,
    };
  }
  const followerMap = new Map<string, string>();
  for (const name of followers.usernames) followerMap.set(name.toLowerCase(), name);
  const followingMap = new Map<string, string>();
  for (const name of following.usernames) followingMap.set(name.toLowerCase(), name);

  const mutuals: string[] = [];
  const notFollowingBack: string[] = [];
  for (const [key, name] of followerMap) {
    if (followingMap.has(key)) mutuals.push(name);
    else notFollowingBack.push(name);
  }
  const notFollowedBack: string[] = [];
  for (const [key, name] of followingMap) {
    if (!followerMap.has(key)) notFollowedBack.push(name);
  }
  const byName = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
  mutuals.sort(byName);
  notFollowingBack.sort(byName);
  notFollowedBack.sort(byName);
  return {
    followerCount: followers.usernames.length,
    followingCount: following.usernames.length,
    mutualCount: mutuals.length,
    notFollowingBack,
    notFollowedBack,
    mutuals,
    complete: followers.complete && following.complete,
    notes,
  };
}
