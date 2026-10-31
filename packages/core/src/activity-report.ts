import { deriveThemes, type SynthesisTerm } from "./synthesis.js";
import {
  REPORT_EVIDENCE_SAMPLE_LIMIT,
  formatUtcInstant,
  reportWindow,
  type ReportComment,
  type ReportEvidenceClass,
  type ReportFollowCoverage,
  type ReportFollowDelta,
  type ReportMention,
  type ReportPeriod,
  type ReportPost,
  type ReportStory,
  type ReportTag,
} from "./report.js";

// ---------------------------------------------------------------------------
// The four-tab Activity Report over a CLI/MCP observation ledger.
//
// The report renders four tabs over a monitor record: Activity Analytics,
// Ties & Trails, Stories & Highlights and AI Insights. This module composes
// that contract from rows IGTrack actually stored.
//
// Deliberate divergences, all required by AGENTS.md invariants 1, 3, 7 and 10:
//   - a metric the source cannot answer is null + UNAVAILABLE + registry
//     reason, never 0;
//   - likes given, liker identities, interaction history, highlights, verified
//     ratios and AI inferences have no lawful source and are refused;
//   - every aggregate states the rows it was computed from;
//   - the download is an IGTrack command that reads the same rows, not an
//     opaque server URL;
//   - there is no subscription, plan, renewal or preview-task state.
//
// Pure: no clock, no I/O. Callers supply the window, the rows and the ledger
// aggregates, so the same input renders byte-identically.
// ---------------------------------------------------------------------------

export const ACTIVITY_PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;
export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];

export const ACTIVITY_DATA_TYPES = {
  daily: "DAILY",
  weekly: "WEEK",
  monthly: "MONTH",
  quarterly: "SEASON",
  yearly: "YEAR",
} as const;
export type ActivityDataType = (typeof ACTIVITY_DATA_TYPES)[ActivityPeriod];

export interface ActivityWindow {
  period: ActivityPeriod;
  /** Inclusive UTC start, ISO instant. */
  start: string;
  /** Exclusive UTC end, ISO instant. */
  end: string;
  /** 2026-10-31, 2026-W44, 2026-10, 2026-Q4 or 2026. */
  label: string;
  dataType: ActivityDataType;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function utcStartOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function activityWindow(period: ActivityPeriod, at: Date = new Date()): ActivityWindow {
  if (period === "daily") {
    const start = utcStartOfDay(at);
    return {
      period,
      start: start.toISOString(),
      end: addDays(start, 1).toISOString(),
      label: start.toISOString().slice(0, 10),
      dataType: "DAILY",
    };
  }
  const base = reportWindow(period as ReportPeriod, at);
  return {
    period,
    start: base.start,
    end: base.end,
    label: base.label,
    dataType: ACTIVITY_DATA_TYPES[period],
  };
}

/** Windows overlapping [from, to], newest first, capped. */
export function enumerateActivityWindows(
  period: ActivityPeriod,
  from: Date,
  to: Date,
  limit = 180,
): ActivityWindow[] {
  const out: ActivityWindow[] = [];
  let cursor = new Date(to.getTime());
  while (out.length < limit) {
    const window = activityWindow(period, cursor);
    if (new Date(window.end) <= from) break;
    out.push(window);
    cursor = addDays(new Date(window.start), -1);
  }
  return out;
}

export function activityDataId(targetKey: string, window: ActivityWindow): string {
  return `igtrack:${targetKey}:${window.period}:${window.start}`;
}

export function activityReportId(targetKey: string, window: ActivityWindow): string {
  return `igtrack-report:${targetKey}:${window.period}:${window.start}`;
}

export function activityBadge(period: ActivityPeriod): string | null {
  switch (period) {
    case "daily":
      return "Beta";
    case "monthly":
      return "Monthly Report";
    case "quarterly":
      return "Quarterly Report";
    case "yearly":
      return "Year Report";
    case "weekly":
      return null;
  }
}

export function activityCommandPrefix(period: ActivityPeriod): string {
  return period === "weekly" ? "" : ` --period ${period}`;
}

// ---------------------------------------------------------------------------
// Absence reasons
//
// LIKES, HIGHLIGHTS and INTERACTIONS reproduce the capability registry's
// whyUnavailable text verbatim; a core test pins them. The rest describe
// capabilities that no supported source supplies. None is a placeholder: each
// names what would have to exist.
// ---------------------------------------------------------------------------

export const ACTIVITY_ABSENCE_REASONS = {
  likes:
    "Instagram exposes no liker list through any supported interface: no liker edge exists on IG Media or IG Comment (the Facebook Comment likes edge is Facebook-only and must not be conflated). Anything labeled 'likes' beyond post/comment metadata would be fabricated.",
  highlights:
    "The Instagram Graph API exposes no highlights edge (the exhaustive IG User edge list has none; the stories edge returns last-24h stories only). The only known alternative is the undocumented private reels_media endpoint, which this project forbids: no private endpoints, no session use, no access-control circumvention.",
  interactions:
    "No supported provider exposes interaction history. LIKE_SIGNAL in the model describes a shape, not a source. The insights edge was considered and rejected: it yields aggregates without actors or per-event timestamps, which cannot satisfy actor+kind+timestamp evidence.",
  aiInsights:
    "IGTrack has no AI-insight provider. Personality, MBTI, relationship, financial and location inferences are not observations; no supported source returns them, and generating them from this ledger would be fabrication. The AI Insights tab is therefore UNAVAILABLE.",
  verified:
    "The configured sources carry no verified-account flag for these rows (the IG User reference has no is_verified field), so a verified ratio cannot be computed without inventing one.",
  externalPlatforms:
    "No supported source maps this account to other social platforms. Stored observations contain Instagram rows only; cross-platform identities are not inferred.",
  places:
    "No supported source returns visited places. The stored edges carry no check-in or place-visit object, so inventing a places list would be fabrication.",
  mediaAssets:
    "Media bytes and stable asset URLs are not archived: provider URLs expire and no download permission is recorded. Cover images are therefore not rendered.",
  interestTags:
    "The target's outbound interests are not exposed by any supported source. Interest tags would require a liker or interest feed that does not exist, so this field is UNAVAILABLE rather than guessed from unrelated text.",
  followingRoster:
    "No COMPLETE following roster is stored, so the followed-account total is unavailable. A PARTIAL roster is never used: every unread member would look absent.",
  subscription:
    "IGTrack is self-hosted and has no subscription, plan, renewal or expiry state. Access failures are typed provider errors, not report-body states.",
  previewTasks:
    "IGTrack has no preview-task stream. Daily periods are composed directly from stored rows, with no background task to poll.",
  avatar: "No stable profile image URL is archived; the provider CDN URL is not persisted.",
} as const;

/** Same keys, open string values: callers may substitute registry text. */
export type ActivityAbsenceReasons = Record<keyof typeof ACTIVITY_ABSENCE_REASONS, string>;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type ActivityValueState =
  | "OBSERVED"
  | "DERIVED"
  | "EMPTY"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE";

export interface ActivityReadable {
  readable: boolean;
  reason: string | null;
}

export interface ActivityMetric {
  key: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  state: ActivityValueState;
  reason: string | null;
  evidenceIds: string[];
  evidenceCount: number;
}

export interface ActivityPersonRow {
  username: string;
  observed_at: string;
  evidence_id: string | null;
}

export interface ActivityCommentRank {
  username: string;
  count: number;
}

export interface ActivityPostRow {
  id: string;
  taken_at: string;
  caption: string | null;
  media_type: string | null;
  like_count: number | null;
  comment_count: number | null;
  media_url: null;
  media_url_state: "UNAVAILABLE";
  media_url_reason: string;
  evidence_id: string | null;
}

export interface ActivityRankBlock<T> {
  state: ActivityValueState;
  reason: string | null;
  rows: T[];
}

/**
 * Each Ties & Trails total is rendered as `total` plus `month_new`. Both
 * halves carry their own state: a zero month is only printed when a COMPLETE
 * roster pair existed to produce a measured zero.
 */
export interface ActivityTotalBlock {
  total: ActivityMetric;
  month_new: ActivityMetric;
}

export interface ActivityDownload {
  kind: "COMMAND";
  label: string;
  command: string | null;
  url: null;
  state: ActivityValueState;
  reason: string | null;
}

export interface ActivityTrailCounts {
  newFollowing: number;
  lostFollowing: number;
  newFollowers: number;
  lostFollowers: number;
  posts: number;
  stories: number;
  comments: number;
  tags: number;
  mentions: number;
  profileSnapshots: number;
  insights: number;
  total: number;
}

export interface ActivityTrailBucketInput extends ActivityTrailCounts {
  /** UTC bucket start, YYYY-MM-DD (Monday for a weekly bucket). */
  bucket: string;
  topCommenter: ActivityCommentRank | null;
  /** COMPLETE FOLLOWING snapshots inside the bucket: a measured-zero witness. */
  completeFollowingSnapshots: number;
}

export interface ActivityCommentInput {
  id: string;
  username: string;
  body: string;
  commentedAt: string;
  likeCount: number | null;
  postId: string;
  evidenceId: string | null;
}

export interface ActivityTrailInput {
  sinceDate: string | null;
  /** COMPLETE roster snapshots up to the selected window end, either side. */
  completeRosterSnapshots: number;
  buckets: ActivityTrailBucketInput[];
  monthCounts: {
    newFollowing: number;
    lostFollowing: number;
    posts: number;
  };
  /** COMPLETE snapshots before / inside the reporting month (end-clamped). */
  completeRosterBeforeMonth: number;
  completeRosterInMonth: number;
  topCommenters: ActivityCommentRank[];
  topMentioned: ActivityCommentRank[];
  captions: string[];
  captionRows: number;
  recentComments: ActivityCommentInput[];
  followingRosterSize: number | null;
}

export interface ActivityInventoryWindowInput {
  window: ActivityWindow;
  eventCount: number;
}

export interface ActivityInventoryEntry {
  data_id: string;
  report_id: string;
  label: string;
  data_type: ActivityDataType;
  begin_time: string;
  end_time: string;
  has_data: boolean;
  state: "DELIVERED" | "EMPTY" | "IN_PROGRESS" | "UNAVAILABLE";
  event_count: number;
  badge: string | null;
  selected: boolean;
  command: string;
}

export interface ActivityReportInput {
  target: {
    id: string;
    username: string;
    platformId: string | null;
    observationMode: "OWNED" | "DISCOVERY";
    localName?: string | null;
  };
  period: ActivityPeriod;
  window: ActivityWindow;
  generatedAt: string;
  evidence: {
    sourceIds: string[];
    evidenceClass: ReportEvidenceClass;
    synthetic: boolean;
    note: string;
  };
  readable: {
    follows: ActivityReadable;
    posts: ActivityReadable;
    stories: ActivityReadable;
    comments: ActivityReadable;
    tags: ActivityReadable;
  };
  followCoverage: {
    followers: ReportFollowCoverage;
    following: ReportFollowCoverage;
  };
  absence: ActivityAbsenceReasons;
  rows: {
    followDeltas: ReportFollowDelta[];
    posts: ReportPost[];
    stories: ReportStory[];
    comments: ReportComment[];
    mentions: ReportMention[];
    tags: ReportTag[];
  };
  trail: ActivityTrailInput;
  inventory: ActivityInventoryWindowInput[];
  inventoryNote: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ActivityNarrativeLine {
  text: string;
  state: ActivityValueState;
  reason: string | null;
}

export interface ActivityTrailEntry {
  period: {
    data_id: string;
    report_id: string;
    label: string;
    data_type: ActivityDataType;
    begin_time: string;
    end_time: string;
  };
  can_open: boolean;
  /** The period has not closed; counts are partial and labels say so. */
  provisional: boolean;
  state: ActivityValueState;
  total_events: number | null;
  most_likes: { count: null; username: null; state: "UNAVAILABLE"; reason: string };
  most_comments: {
    count: number | null;
    username: string | null;
    state: ActivityValueState;
    reason: string | null;
  };
  posts: {
    count: number | null;
    state: ActivityValueState;
    reason: string | null;
    images: [];
    images_state: "UNAVAILABLE";
  };
  stories: {
    count: number | null;
    state: ActivityValueState;
    reason: string | null;
    images: [];
    images_state: "UNAVAILABLE";
  };
  highlights: { count: null; state: "UNAVAILABLE"; reason: string; images: [] };
  follows: { count: number | null; state: ActivityValueState; reason: string | null };
  unfollows: { count: number | null; state: ActivityValueState; reason: string | null };
  command: string;
}

export interface ActivityActivityAnalyticsTab {
  state: ActivityValueState;
  narrative: ActivityNarrativeLine[];
  active_begin_time: string | null;
  active_end_time: string | null;
  active_window_state: ActivityValueState;
  active_window_reason: string | null;
  like_num: ActivityMetric;
  like_pic_num: ActivityMetric;
  like_video_num: ActivityMetric;
  like_acct_num: ActivityMetric;
  like_acct_verify_num: ActivityMetric;
  like_user_num: ActivityMetric;
  like_avg_per_user_num: ActivityMetric;
  like_user_verify_num: ActivityMetric;
  following_num: ActivityMetric;
  un_follow_num: ActivityMetric;
  like_tags: ActivityMetric;
  following_tags: ActivityMetric;
  post_hashtags: ActivityMetric;
  post_num: ActivityMetric;
  story_num: ActivityMetric;
  highlights_num: ActivityMetric;
  comment_num: ActivityMetric;
  tagged_num: ActivityMetric;
  new_followings: ActivityPersonRow[];
  un_follows: ActivityPersonRow[];
  tagged_users: ActivityPersonRow[];
  like_ranks: ActivityRankBlock<never>;
  comment_ranks: ActivityRankBlock<ActivityCommentRank>;
  top5comment_users: string[];
  social_platforms: ActivityMetric;
  post_list: ActivityRankBlock<ActivityPostRow>;
  download: ActivityDownload;
}

export interface ActivityTiesAndTrailsTab {
  state: ActivityValueState;
  totals: {
    followed_data: ActivityTotalBlock;
    post_data: ActivityTotalBlock;
    like_data: ActivityTotalBlock;
    unfollowed_data: ActivityTotalBlock;
  };
  days_analyzed: ActivityMetric;
  social_map: {
    social_like_list: ActivityRankBlock<never>;
    social_comment_list: ActivityRankBlock<ActivityCommentRank>;
  };
  connection_counts: Record<string, ActivityMetric>;
  connection_narrative: ActivityNarrativeLine[];
  media_tags: ActivityRankBlock<SynthesisTerm>;
  media_terms: ActivityRankBlock<SynthesisTerm>;
  interest_tags: ActivityRankBlock<never>;
  timeline: ActivityTrailEntry[];
  timeline_total: number;
  timeline_non_empty: number;
  top_content: {
    comments: ActivityRankBlock<ActivityCommentInput>;
    places_visited: ActivityRankBlock<never>;
  };
}

export interface ActivityStoriesHighlightsTab {
  state: ActivityValueState;
  enabled: boolean;
  report_id: string;
  begin_date: string;
  end_date: string;
  data_type: ActivityDataType;
  stories: ActivityRankBlock<{
    id: string;
    taken_at: string;
    media_type: string;
    expires_at: string | null;
    media_url: null;
    media_url_state: "UNAVAILABLE";
    evidence_id: string | null;
  }>;
  new_highlights: ActivityRankBlock<never>;
  old_highlights: ActivityRankBlock<never>;
  empty_data: boolean | null;
  not_start: boolean;
  not_start_reason: string | null;
  need_upgrade: false;
  plan_gating: "NOT_APPLICABLE";
  plan_gating_reason: string;
  batch_download: ActivityDownload;
}

export interface ActivityAiInsightsTab {
  has_insights: false;
  state: "UNAVAILABLE";
  reason: string;
  sub_type: "NOT_APPLICABLE";
  status: "UNAVAILABLE";
  alternative: string;
}

export interface ActivityReport {
  feature: "igtrack.activity-report";
  adaptation: "igtrack-cli";
  identification: string;
  media_name: string;
  avatar_url: null;
  avatar_state: "UNAVAILABLE";
  avatar_reason: string;
  data_type: ActivityDataType;
  data_id: string;
  report_id: string;
  begin_time: string;
  end_time: string;
  has_data: boolean;
  period_state: ActivityInventoryEntry["state"];
  generated_at: string;
  periods: ActivityInventoryEntry[];
  periods_note: string;
  reports_delivered: number;
  task_num: number;
  tabs: {
    activity_analytics: ActivityActivityAnalyticsTab;
    ties_and_trails: ActivityTiesAndTrailsTab;
    stories_highlights: ActivityStoriesHighlightsTab;
    ai_insights: ActivityAiInsightsTab;
  };
  evidence: ActivityReportInput["evidence"];
  divergences: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleEvidence(ids: ReadonlyArray<string | null | undefined>): {
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
  return { evidenceIds: seen.slice(0, REPORT_EVIDENCE_SAMPLE_LIMIT), evidenceCount: seen.length };
}

function metric(
  key: string,
  label: string,
  value: number | string | null,
  state: ActivityValueState,
  options: {
    unit?: string | null;
    reason?: string | null;
    evidence?: ReadonlyArray<string | null | undefined>;
  } = {},
): ActivityMetric {
  const evidence = sampleEvidence(options.evidence ?? []);
  return {
    key,
    label,
    value,
    unit: options.unit ?? null,
    state,
    reason: options.reason ?? null,
    evidenceIds: evidence.evidenceIds,
    evidenceCount: evidence.evidenceCount,
  };
}

function unavailable(key: string, label: string, reason: string): ActivityMetric {
  return metric(key, label, null, "UNAVAILABLE", { reason });
}

function emptyReason(input: ActivityReadable, fallback: string): string | null {
  return input.readable ? fallback : input.reason;
}

function countBy<T>(rows: readonly T[], key: (row: T) => string | null): ActivityCommentRank[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = key(row);
    if (value === null || value === "") continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([username, count]) => ({ username, count }))
    .sort((a, b) => b.count - a.count || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
}

function dayStart(iso: string): number {
  const d = new Date(iso);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysAnalyzed(sinceDate: string | null, window: ActivityWindow): number | null {
  if (sinceDate === null) return null;
  const end = new Date(new Date(window.end).getTime() - 1);
  const endDay = dayStart(end.toISOString());
  const sinceDay = dayStart(sinceDate);
  return Math.max(1, Math.floor((endDay - sinceDay) / 86_400_000) + 1);
}

function hasAnyTrailCount(entry: ActivityTrailEntry): boolean {
  return (
    (entry.most_comments.count ?? 0) > 0 ||
    (entry.posts.count ?? 0) > 0 ||
    (entry.stories.count ?? 0) > 0 ||
    (entry.follows.count ?? 0) > 0 ||
    (entry.unfollows.count ?? 0) > 0
  );
}

function buildInventory(input: ActivityReportInput): ActivityInventoryEntry[] {
  const generated = new Date(input.generatedAt).getTime();
  return input.inventory
    .map(({ window, eventCount }) => {
      const closed = new Date(window.end).getTime() <= generated;
      const state: ActivityInventoryEntry["state"] = !closed
        ? "IN_PROGRESS"
        : eventCount > 0
          ? "DELIVERED"
          : "EMPTY";
      return {
        data_id: activityDataId(input.target.id, window),
        report_id: activityReportId(input.target.id, window),
        label: window.label,
        data_type: window.dataType,
        begin_time: window.start,
        end_time: window.end,
        has_data: eventCount > 0,
        state,
        event_count: eventCount,
        badge: activityBadge(window.period),
        selected: window.start === input.window.start && window.period === input.window.period,
        command:
          `igtrack activity-report @${input.target.username}${activityCommandPrefix(window.period)} --at ${window.start.slice(0, 10)}`,
      };
    })
    .sort((a, b) => (a.begin_time < b.begin_time ? 1 : a.begin_time > b.begin_time ? -1 : 0));
}

function buildAnalytics(input: ActivityReportInput, absence: ActivityAbsenceReasons): ActivityActivityAnalyticsTab {
  const { rows, readable } = input;
  const evidence = (ids: ReadonlyArray<string | null | undefined>) => ids;

  const postsEvidence = rows.posts.map((row) => row.evidenceId);
  const storyEvidence = rows.stories.map((row) => row.evidenceId);
  const commentEvidence = rows.comments.map((row) => row.evidenceId);
  const tagEvidence = rows.tags.map((row) => row.evidenceId);
  const followEvidence = rows.followDeltas.map((row) => row.evidenceId);

  const newFollowRows = rows.followDeltas.filter((row) => row.change === "NEW_FOLLOWING");
  const lostFollowRows = rows.followDeltas.filter((row) => row.change === "LOST_FOLLOWING");
  const followCompared =
    newFollowRows.length + lostFollowRows.length > 0 ||
    input.followCoverage.following.complete > 0;
  // A readable source without a COMPLETE roster is a coverage gap, not a
  // measured zero: printing EMPTY/0 here would say "nothing changed" when the
  // member list was never read.
  const followState: ActivityValueState = followCompared ? "DERIVED" : "UNAVAILABLE";
  const followReason = followCompared
    ? null
    : readable.follows.readable
      ? "No COMPLETE following roster was compared in this window, so no delta can be counted. Zero would mean 'nothing changed', which was not measured."
      : readable.follows.reason;

  const postState: ActivityValueState = readable.posts.readable
    ? rows.posts.length > 0
      ? "DERIVED"
      : "EMPTY"
    : "UNAVAILABLE";
  const storyState: ActivityValueState = readable.stories.readable
    ? rows.stories.length > 0
      ? "DERIVED"
      : "EMPTY"
    : "UNAVAILABLE";
  const commentState: ActivityValueState = readable.comments.readable
    ? rows.comments.length > 0
      ? "DERIVED"
      : "EMPTY"
    : "UNAVAILABLE";
  const tagState: ActivityValueState = readable.tags.readable
    ? rows.tags.length > 0
      ? "DERIVED"
      : "EMPTY"
    : "UNAVAILABLE";

  const timestamps = [
    ...rows.posts.map((row) => row.takenAt),
    ...rows.stories.map((row) => row.takenAt),
    ...rows.comments.map((row) => row.commentedAt),
    ...rows.followDeltas.map((row) => row.at),
    ...rows.tags.map((row) => row.observedAt),
    ...rows.mentions.map((row) => row.observedAt),
  ].sort();
  const activeBegin = timestamps[0] ?? null;
  const activeEnd = timestamps[timestamps.length - 1] ?? null;
  const anyFamilyReadable = Object.values(readable).some((family) => family.readable);
  const activeState: ActivityValueState =
    timestamps.length > 0 ? "DERIVED" : anyFamilyReadable ? "EMPTY" : "UNAVAILABLE";
  const activeReason =
    timestamps.length > 0
      ? "Minimum and maximum of the timestamps actually stored in this window; this is observed activity, not a claim about unobserved time."
      : anyFamilyReadable
        ? "No timestamped row was stored in this window, so there is no observed active window."
        : "No readable source can supply a timestamped row for this window.";

  const commentRanks = countBy(rows.comments, (row) => row.authorUsername);
  const hashtags = deriveThemes(rows.posts.map((row) => row.caption), { limit: 100 }).hashtags;
  const taggedUsers = rows.tags
    .filter((row) => row.ownerUsername !== null)
    .map((row) => ({
      username: row.ownerUsername as string,
      observed_at: row.observedAt,
      evidence_id: row.evidenceId,
    }));
  const top5 = commentRanks.slice(0, 5).map((row) => row.username);

  const state: ActivityValueState =
    rows.posts.length + rows.stories.length + rows.comments.length + rows.tags.length + rows.followDeltas.length + rows.mentions.length > 0
      ? "OBSERVED"
      : anyFamilyReadable
        ? "EMPTY"
        : "UNAVAILABLE";

  const narrative: ActivityNarrativeLine[] = [
    {
      text: `@${input.target.username} activity for ${input.window.dataType} ${input.window.label}.`,
      state: "OBSERVED",
      reason: null,
    },
  ];
  if (rows.posts.length > 0) {
    narrative.push({
      text:
        activeBegin !== null && activeEnd !== null
          ? `Total posts: ${rows.posts.length}, Peak Activity Periods: ${formatUtcInstant(activeBegin)} ~ ${formatUtcInstant(activeEnd)}.`
          : `Total posts: ${rows.posts.length}.`,
      state: "DERIVED",
      reason: null,
    });
  } else {
    narrative.push({
      text: "Total posts: no post row was stored in this window.",
      state: postState,
      reason: postState === "UNAVAILABLE" ? readable.posts.reason : null,
    });
  }
  narrative.push(
    top5.length > 0
      ? {
          text: `Top commenters on: ${top5.map((name) => `@${name}`).join("、")}.`,
          state: "DERIVED",
          reason: null,
        }
      : {
          text: "Top commenters on: no comment row was stored in this window.",
          state: commentState,
          reason: commentState === "UNAVAILABLE" ? readable.comments.reason : null,
        },
  );
  narrative.push({
    text:
      followState === "DERIVED"
        ? `${newFollowRows.length} new following(s) and ${lostFollowRows.length} unfollow(s) were first observed in this window.`
        : "Follow movement cannot be counted for this window.",
    state: followState,
    reason: followReason,
  });
  narrative.push({
    text: "Most-liked account: unavailable — no liker feed exists.",
    state: "UNAVAILABLE",
    reason: absence.likes,
  });

  const followingMetric = metric(
    "following_num",
    "New following accounts",
    followCompared ? newFollowRows.length : null,
    followState,
    {
      unit: "accounts",
      reason: followReason,
      evidence: evidence(followEvidence),
    },
  );
  const unfollowMetric = metric(
    "un_follow_num",
    "Unfollows",
    followCompared ? lostFollowRows.length : null,
    followState,
    {
      unit: "accounts",
      reason: followReason,
      evidence: evidence(followEvidence),
    },
  );
  const postMetric = metric(
    "post_num",
    "Posts",
    readable.posts.readable ? rows.posts.length : null,
    postState,
    {
      reason: postState === "UNAVAILABLE" ? readable.posts.reason : null,
      evidence: evidence(postsEvidence),
    },
  );
  const storyMetric = metric("story_num", "Stories", readable.stories.readable ? rows.stories.length : null, storyState, {
    reason: storyState === "UNAVAILABLE" ? readable.stories.reason : null,
    evidence: evidence(storyEvidence),
  });
  const commentMetric = metric("comment_num", "Comments", readable.comments.readable ? rows.comments.length : null, commentState, {
    reason: commentState === "UNAVAILABLE" ? readable.comments.reason : null,
    evidence: evidence(commentEvidence),
  });
  const taggedMetric = metric("tagged_num", "Tagged media rows", readable.tags.readable ? rows.tags.length : null, tagState, {
    reason: tagState === "UNAVAILABLE" ? readable.tags.reason : null,
    evidence: evidence(tagEvidence),
  });
  const hashtagMetric = metric(
    "post_hashtags",
    "Hashtags in stored post captions",
    hashtags.length > 0 ? hashtags.map((tag) => `#${tag.term}`).slice(0, 10).join(" ") : null,
    postState === "UNAVAILABLE" ? "UNAVAILABLE" : hashtags.length > 0 ? "DERIVED" : "EMPTY",
    {
      reason:
        postState === "UNAVAILABLE"
          ? readable.posts.reason
          : hashtags.length > 0
            ? null
            : "Stored post captions in this window contain no hashtags.",
      evidence: evidence(postsEvidence),
    },
  );

  const postListRows: ActivityPostRow[] = rows.posts.map((row) => ({
    id: row.id,
    taken_at: row.takenAt,
    caption: row.caption,
    media_type: row.mediaType,
    like_count: row.likeCount,
    comment_count: row.commentCount,
    media_url: null,
    media_url_state: "UNAVAILABLE",
    media_url_reason: absence.mediaAssets,
    evidence_id: row.evidenceId,
  }));

  return {
    state,
    narrative,
    active_begin_time: activeBegin,
    active_end_time: activeEnd,
    active_window_state: activeState,
    active_window_reason: activeReason,
    like_num: unavailable("like_num", "Likes given", absence.likes),
    like_pic_num: unavailable("like_pic_num", "Photo likes given", absence.likes),
    like_video_num: unavailable("like_video_num", "Video likes given", absence.likes),
    like_acct_num: unavailable("like_acct_num", "Accounts liked", absence.likes),
    like_acct_verify_num: unavailable("like_acct_verify_num", "Verified accounts liked", absence.likes),
    like_user_num: unavailable("like_user_num", "Like actors", absence.likes),
    like_avg_per_user_num: unavailable("like_avg_per_user_num", "Average likes per actor", absence.likes),
    like_user_verify_num: unavailable("like_user_verify_num", "Verified like actors", absence.likes),
    following_num: followingMetric,
    un_follow_num: unfollowMetric,
    like_tags: unavailable("like_tags", "Liked-media tags", absence.likes),
    following_tags: unavailable("following_tags", "Following tags", absence.interestTags),
    post_hashtags: hashtagMetric,
    post_num: postMetric,
    story_num: storyMetric,
    highlights_num: unavailable("highlights_num", "Highlights", absence.highlights),
    comment_num: commentMetric,
    tagged_num: taggedMetric,
    new_followings: newFollowRows.map((row) => ({
      username: row.username,
      observed_at: row.at,
      evidence_id: row.evidenceId,
    })),
    un_follows: lostFollowRows.map((row) => ({
      username: row.username,
      observed_at: row.at,
      evidence_id: row.evidenceId,
    })),
    tagged_users: taggedUsers,
    like_ranks: { state: "UNAVAILABLE", reason: absence.likes, rows: [] },
    comment_ranks: {
      state: commentState === "UNAVAILABLE" ? "UNAVAILABLE" : commentRanks.length > 0 ? "DERIVED" : "EMPTY",
      reason: commentState === "UNAVAILABLE" ? readable.comments.reason : null,
      rows: commentRanks,
    },
    top5comment_users: top5,
    social_platforms: unavailable("social_platforms", "Cross-platform identities", absence.externalPlatforms),
    post_list: {
      state: postState,
      reason: postState === "UNAVAILABLE" ? readable.posts.reason : null,
      rows: postListRows,
    },
    download: {
      kind: "COMMAND",
      label: "Download this period",
      command: `igtrack export @${input.target.username} --kind report --period ${input.period} --at ${input.window.start.slice(0, 10)} --format csv`,
      url: null,
      state: "OBSERVED",
      reason:
        "IGTrack emits the command that writes the same stored rows with provenance columns; no server URL is invented.",
    },
  };
}

function buildTrails(input: ActivityReportInput, absence: ActivityAbsenceReasons): ActivityTiesAndTrailsTab {
  const { trail, rows, readable } = input;
  const windowEnd = new Date(input.window.end).getTime();
  const trailBuckets = trail.buckets
    .filter((bucket) => new Date(`${bucket.bucket}T00:00:00.000Z`).getTime() < windowEnd)
    .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

  const totalsSum = trailBuckets
    .filter((bucket) => new Date(activityWindow(input.period, new Date(`${bucket.bucket}T00:00:00.000Z`)).end).getTime() <= new Date(input.generatedAt).getTime())
    .reduce(
      (acc, bucket) => ({
        newFollowing: acc.newFollowing + bucket.newFollowing,
        lostFollowing: acc.lostFollowing + bucket.lostFollowing,
        posts: acc.posts + bucket.posts,
        comments: acc.comments + bucket.comments,
        stories: acc.stories + bucket.stories,
      }),
      { newFollowing: 0, lostFollowing: 0, posts: 0, comments: 0, stories: 0 },
    );

  // Only deltas from the following side feed these totals. A complete
  // followers roster proves nothing about who the target follows.
  const rosterCompared =
    input.followCoverage.following.complete > 0 ||
    totalsSum.newFollowing + totalsSum.lostFollowing > 0;
  const followTotalState: ActivityValueState = rosterCompared ? "DERIVED" : "UNAVAILABLE";
  const followTotalReason = rosterCompared
    ? "Sum of stored follow deltas; each delta was produced by two COMPLETE following-roster snapshots."
    : readable.follows.readable
      ? "No COMPLETE following roster was compared on or before this window's end, so no delta exists to sum. A PARTIAL roster is never diffed."
      : readable.follows.reason;

  // A zero month is honest only when a COMPLETE snapshot pair existed inside
  // that month (or an earlier complete baseline was diffed against one taken
  // inside it). Otherwise the month was not measured.
  const monthFollowMeasured =
    trail.monthCounts.newFollowing + trail.monthCounts.lostFollowing > 0 ||
    trail.completeRosterInMonth >= 2 ||
    (trail.completeRosterBeforeMonth >= 1 && trail.completeRosterInMonth >= 1);
  const monthFollowState: ActivityValueState = monthFollowMeasured ? "DERIVED" : "UNAVAILABLE";
  const monthFollowReason = monthFollowMeasured
    ? "Deltas whose first observation falls inside the reporting month."
    : "No COMPLETE roster pair was compared inside the reporting month, so a zero month would not mean 'nothing changed'.";

  const postsState: ActivityValueState = readable.posts.readable
    ? totalsSum.posts > 0
      ? "DERIVED"
      : "EMPTY"
    : "UNAVAILABLE";
  const commentsState: ActivityValueState = readable.comments.readable
    ? trail.topCommenters.length > 0
      ? "DERIVED"
      : "EMPTY"
    : "UNAVAILABLE";
  const hashtags = deriveThemes(trail.captions, { limit: 100 });
  const tagsState: ActivityValueState =
    !readable.posts.readable
      ? "UNAVAILABLE"
      : hashtags.hashtags.length > 0
        ? "DERIVED"
        : trail.captionRows > 0
          ? "EMPTY"
          : "UNAVAILABLE";
  const tagsReason =
    tagsState === "UNAVAILABLE"
      ? readable.posts.readable
        ? "No caption text is stored, so a tag corpus does not exist. Zero tags would be a fabricated reading of an absent corpus."
        : readable.posts.reason
      : tagsState === "EMPTY"
        ? "Stored captions contain no hashtags."
        : null;

  const topCommenter = trail.topCommenters[0] ?? null;
  const days = daysAnalyzed(trail.sinceDate, input.window);
  const inProgressReason =
    "This period has not closed. Its counts are partial, and a zero here is not a completed zero.";
  const unmeasuredPeriodReason =
    "No COMPLETE following-roster pair covers this period, so a zero would not mean 'nobody was followed'.";
  const timeline: ActivityTrailEntry[] = trailBuckets
    .map((bucket): ActivityTrailEntry => {
      const window = activityWindow(input.period, new Date(`${bucket.bucket}T00:00:00.000Z`));
      const closed = new Date(window.end).getTime() <= new Date(input.generatedAt).getTime();
      const rawAny =
        bucket.posts +
        bucket.stories +
        bucket.comments +
        bucket.newFollowing +
        bucket.lostFollowing;
      // A zero is a measured result only after the period closes; while it is
      // open, "nothing stored yet" and "nothing happened" are different facts.
      const partial = (count: number): number | null => (count > 0 || closed ? count : null);
      const measuredFollowing =
        bucket.newFollowing + bucket.lostFollowing > 0 || bucket.completeFollowingSnapshots > 0;
      const followCount = rosterCompared && measuredFollowing ? partial(bucket.newFollowing) : null;
      const unfollowCount = rosterCompared && measuredFollowing ? partial(bucket.lostFollowing) : null;
      const followReason =
        followCount !== null
          ? null
          : rosterCompared
            ? measuredFollowing
              ? inProgressReason
              : unmeasuredPeriodReason
            : followTotalReason;
      const bucketCommenter = bucket.topCommenter;
      return {
        period: {
          data_id: activityDataId(input.target.id, window),
          report_id: activityReportId(input.target.id, window),
          label: window.label,
          data_type: window.dataType,
          begin_time: window.start,
          end_time: window.end,
        },
        can_open: true,
        provisional: !closed,
        state: (rawAny > 0 ? "OBSERVED" : closed ? "EMPTY" : "UNAVAILABLE") as ActivityValueState,
        total_events: rawAny === 0 && !closed ? null : bucket.total,
        most_likes: {
          count: null,
          username: null,
          state: "UNAVAILABLE",
          reason: absence.likes,
        },
        most_comments: {
          count: bucketCommenter?.count ?? (readable.comments.readable && closed ? 0 : null),
          username: bucketCommenter?.username ?? null,
          state:
            bucketCommenter !== null
              ? "DERIVED"
              : !readable.comments.readable || !closed
                ? "UNAVAILABLE"
                : "EMPTY",
          reason:
            bucketCommenter !== null
              ? null
              : !readable.comments.readable
                ? readable.comments.reason
                : !closed
                  ? inProgressReason
                  : null,
        },
        posts: {
          count: readable.posts.readable ? partial(bucket.posts) : null,
          state: !readable.posts.readable
            ? "UNAVAILABLE"
            : bucket.posts > 0
              ? "OBSERVED"
              : closed
                ? "EMPTY"
                : "UNAVAILABLE",
          reason: !readable.posts.readable
            ? readable.posts.reason
            : bucket.posts === 0 && !closed
              ? inProgressReason
              : null,
          images: [],
          images_state: "UNAVAILABLE",
        },
        stories: {
          count: readable.stories.readable ? partial(bucket.stories) : null,
          state: !readable.stories.readable
            ? "UNAVAILABLE"
            : bucket.stories > 0
              ? "OBSERVED"
              : closed
                ? "EMPTY"
                : "UNAVAILABLE",
          reason: !readable.stories.readable
            ? readable.stories.reason
            : bucket.stories === 0 && !closed
              ? inProgressReason
              : null,
          images: [],
          images_state: "UNAVAILABLE",
        },
        highlights: { count: null, state: "UNAVAILABLE", reason: absence.highlights, images: [] },
        follows: {
          count: followCount,
          state: followCount === null ? "UNAVAILABLE" : "DERIVED",
          reason: followReason,
        },
        unfollows: {
          count: unfollowCount,
          state: unfollowCount === null ? "UNAVAILABLE" : "DERIVED",
          reason: followReason,
        },
        command: `igtrack activity-report @${input.target.username}${activityCommandPrefix(window.period)} --at ${window.start.slice(0, 10)}`,
      };
    })
    .sort((a, b) => (a.period.begin_time < b.period.begin_time ? 1 : a.period.begin_time > b.period.begin_time ? -1 : 0));

  const connectionCounts: Record<string, ActivityMetric> = {
    total_like_num: unavailable("total_like_num", "Total likes", absence.likes),
    most_like_media_name: unavailable("most_like_media_name", "Most-liked account", absence.likes),
    most_like_avatar: unavailable("most_like_avatar", "Most-liked account avatar", absence.mediaAssets),
    most_like_num: unavailable("most_like_num", "Likes on most-liked account", absence.likes),
    most_comment_media_name: metric(
      "most_comment_media_name",
      "Most-commenting account",
      topCommenter?.username ?? null,
      commentsState,
      { reason: commentsState === "UNAVAILABLE" ? readable.comments.reason : null },
    ),
    most_comment_avatar: unavailable("most_comment_avatar", "Most-commenting account avatar", absence.mediaAssets),
    most_comment_num: metric(
      "most_comment_num",
      "Comments by most-commenting account",
      topCommenter?.count ?? null,
      commentsState,
      { reason: commentsState === "UNAVAILABLE" ? readable.comments.reason : null },
    ),
    total_followed_num: metric(
      "total_followed_num",
      "Following roster size",
      trail.followingRosterSize,
      trail.followingRosterSize === null ? "UNAVAILABLE" : "OBSERVED",
      { reason: trail.followingRosterSize === null ? absence.followingRoster : null },
    ),
    verify_followed_num: unavailable("verify_followed_num", "Verified accounts followed", absence.verified),
    most_like_verify_media_name: unavailable("most_like_verify_media_name", "Verified account with most likes", absence.likes),
    most_like_verify_num: unavailable("most_like_verify_num", "Likes on verified account", absence.likes),
    new_followed_num: metric(
      "new_followed_num",
      "New followings",
      rosterCompared ? totalsSum.newFollowing : null,
      followTotalState,
      { reason: followTotalReason },
    ),
    new_followed_verify_num: unavailable("new_followed_verify_num", "New verified followings", absence.verified),
    un_followed_num: metric(
      "un_followed_num",
      "Unfollows",
      rosterCompared ? totalsSum.lostFollowing : null,
      followTotalState,
      { reason: followTotalReason },
    ),
    un_followed_verify_num: unavailable("un_followed_verify_num", "Verified unfollows", absence.verified),
  };

  const connectionNarrative: ActivityNarrativeLine[] = [
    topCommenter === null
      ? {
          text: "Most comments: no comment row was stored in the tracked range.",
          state: commentsState,
          reason: commentsState === "UNAVAILABLE" ? readable.comments.reason : null,
        }
      : {
          text: `Most comments: @${topCommenter.username} with ${topCommenter.count} comment(s) on owned media.`,
          state: "DERIVED",
          reason: null,
        },
    { text: "Most likes: unavailable — no liker feed exists.", state: "UNAVAILABLE", reason: absence.likes },
    {
      text: "Verified-follow ratio: unavailable — no verified flag is returned for these rows.",
      state: "UNAVAILABLE",
      reason: absence.verified,
    },
    {
      text: "Verified account with most likes: unavailable — no liker feed exists.",
      state: "UNAVAILABLE",
      reason: absence.likes,
    },
  ];

  const state: ActivityValueState =
    totalsSum.newFollowing + totalsSum.lostFollowing + totalsSum.posts + totalsSum.comments + totalsSum.stories > 0
      ? "OBSERVED"
      : readable.follows.readable || readable.posts.readable || readable.comments.readable
        ? "EMPTY"
        : "UNAVAILABLE";

  return {
    state,
    totals: {
      followed_data: {
        total: metric(
          "followed_data.total",
          "Total new follows",
          rosterCompared ? totalsSum.newFollowing : null,
          followTotalState,
          { reason: followTotalReason },
        ),
        month_new: metric(
          "followed_data.month_new",
          "New follows this month",
          monthFollowMeasured ? trail.monthCounts.newFollowing : null,
          monthFollowState,
          { reason: monthFollowReason },
        ),
      },
      post_data: {
        total: metric("post_data.total", "Total new updates", readable.posts.readable ? totalsSum.posts : null, postsState, {
          reason: postsState === "UNAVAILABLE" ? readable.posts.reason : null,
        }),
        month_new: metric(
          "post_data.month_new",
          "New updates this month",
          readable.posts.readable ? trail.monthCounts.posts : null,
          postsState === "UNAVAILABLE" ? "UNAVAILABLE" : "DERIVED",
          { reason: postsState === "UNAVAILABLE" ? readable.posts.reason : null },
        ),
      },
      like_data: {
        total: unavailable("like_data.total", "Total likes given", absence.likes),
        month_new: unavailable("like_data.month_new", "Likes given this month", absence.likes),
      },
      unfollowed_data: {
        total: metric(
          "unfollowed_data.total",
          "Total unfollows",
          rosterCompared ? totalsSum.lostFollowing : null,
          followTotalState,
          { reason: followTotalReason },
        ),
        month_new: metric(
          "unfollowed_data.month_new",
          "Unfollows this month",
          monthFollowMeasured ? trail.monthCounts.lostFollowing : null,
          monthFollowState,
          { reason: monthFollowReason },
        ),
      },
    },
    days_analyzed: metric(
      "days_analyzed",
      "Days analyzed",
      days,
      days === null ? "UNAVAILABLE" : "DERIVED",
      {
        reason:
          days === null
            ? "No stored row exists for this target, so the analyzed range has no start."
            : "Inclusive UTC days between the earliest stored activity and the selected window's last day. Deterministic for a fixed window.",
      },
    ),
    social_map: {
      social_like_list: { state: "UNAVAILABLE", reason: absence.likes, rows: [] },
      social_comment_list: {
        state: commentsState === "UNAVAILABLE" ? "UNAVAILABLE" : trail.topCommenters.length > 0 ? "DERIVED" : "EMPTY",
        reason: commentsState === "UNAVAILABLE" ? readable.comments.reason : null,
        rows: trail.topCommenters,
      },
    },
    connection_counts: connectionCounts,
    connection_narrative: connectionNarrative,
    media_tags: { state: tagsState, reason: tagsReason, rows: hashtags.hashtags },
    media_terms: {
      state: tagsState === "UNAVAILABLE" ? "UNAVAILABLE" : hashtags.terms.length > 0 ? "DERIVED" : "EMPTY",
      reason: tagsReason,
      rows: hashtags.terms,
    },
    interest_tags: { state: "UNAVAILABLE", reason: absence.interestTags, rows: [] },
    timeline,
    timeline_total: timeline.length,
    timeline_non_empty: timeline.filter(hasAnyTrailCount).length,
    top_content: {
      comments: {
        state:
          commentsState === "UNAVAILABLE"
            ? "UNAVAILABLE"
            : trail.recentComments.length > 0
              ? "OBSERVED"
              : "EMPTY",
        reason: commentsState === "UNAVAILABLE" ? readable.comments.reason : null,
        rows: trail.recentComments,
      },
      places_visited: { state: "UNAVAILABLE", reason: absence.places, rows: [] },
    },
  };
}

function buildStories(
  input: ActivityReportInput,
  absence: ActivityAbsenceReasons,
): ActivityStoriesHighlightsTab {
  const enabled = input.period !== "daily";
  const storiesReadable = input.readable.stories;
  const rows = input.rows.stories.map((story) => ({
    id: story.id,
    taken_at: story.takenAt,
    media_type: story.mediaType,
    expires_at: story.expiresAt,
    media_url: null,
    media_url_state: "UNAVAILABLE" as const,
    evidence_id: story.evidenceId,
  }));
  const state: ActivityValueState = !storiesReadable.readable
    ? "UNAVAILABLE"
    : rows.length > 0
      ? "OBSERVED"
      : "EMPTY";
  const emptyData = !storiesReadable.readable ? null : rows.length === 0;
  const notStart = input.trail.sinceDate === null;
  return {
    state,
    enabled,
    report_id: activityReportId(input.target.id, input.window),
    begin_date: input.window.start,
    end_date: input.window.end,
    data_type: input.window.dataType,
    stories: {
      state,
      reason: !storiesReadable.readable ? storiesReadable.reason : rows.length === 0 ? "The source answered; no story was stored in this window." : null,
      rows,
    },
    new_highlights: { state: "UNAVAILABLE", reason: absence.highlights, rows: [] },
    old_highlights: { state: "UNAVAILABLE", reason: absence.highlights, rows: [] },
    empty_data: emptyData,
    not_start: notStart,
    not_start_reason: notStart
      ? "No stored row exists for this target, so tracking has not started."
      : null,
    need_upgrade: false,
    plan_gating: "NOT_APPLICABLE",
    plan_gating_reason: absence.subscription,
    batch_download: {
      kind: "COMMAND",
      label: "Export stories for this period",
      command:
        rows.length > 0
          ? `igtrack export @${input.target.username} --kind stories --period ${input.period} --at ${input.window.start.slice(0, 10)} --format csv`
          : null,
      url: null,
      state: rows.length > 0 ? "OBSERVED" : state,
      reason:
        rows.length > 0
          ? "The command writes stored story rows with provenance."
          : "No story row exists in this window, so there is nothing to download.",
    },
  };
}

function buildInsights(input: ActivityReportInput, absence: ActivityAbsenceReasons): ActivityAiInsightsTab {
  return {
    has_insights: false,
    state: "UNAVAILABLE",
    reason: absence.aiInsights,
    sub_type: "NOT_APPLICABLE",
    status: "UNAVAILABLE",
    alternative: `igtrack insights @${input.target.username} reads own-account metric series; it does not infer personality or relationships.`,
  };
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export function buildActivityReport(input: ActivityReportInput): ActivityReport {
  const inventory = buildInventory(input);
  const selected = inventory.find(
    (entry) => entry.begin_time === input.window.start && entry.data_type === input.window.dataType,
  );
  const hasData =
    selected?.has_data ??
    (input.rows.posts.length +
      input.rows.stories.length +
      input.rows.comments.length +
      input.rows.tags.length +
      input.rows.followDeltas.length +
      input.rows.mentions.length >
      0);
  const reportsDelivered = inventory.filter(
    (entry) => entry.data_type !== "DAILY" && entry.has_data,
  ).length;

  return {
    feature: "igtrack.activity-report",
    adaptation: "igtrack-cli",
    identification: input.target.id,
    media_name: input.target.username,
    avatar_url: null,
    avatar_state: "UNAVAILABLE",
    avatar_reason: input.absence.avatar,
    data_type: input.window.dataType,
    data_id: activityDataId(input.target.id, input.window),
    report_id: activityReportId(input.target.id, input.window),
    begin_time: input.window.start,
    end_time: input.window.end,
    has_data: hasData,
    period_state: selected?.state ?? (hasData ? "DELIVERED" : "EMPTY"),
    generated_at: input.generatedAt,
    periods: inventory,
    periods_note: input.inventoryNote,
    reports_delivered: reportsDelivered,
    task_num: reportsDelivered,
    tabs: {
      activity_analytics: buildAnalytics(input, input.absence),
      ties_and_trails: buildTrails(input, input.absence),
      stories_highlights: buildStories(input, input.absence),
      ai_insights: buildInsights(input, input.absence),
    },
    evidence: input.evidence,
    divergences: [
      "Missing metrics are null plus an UNAVAILABLE reason, never zero.",
      "Likes given, liker identities, interaction history and highlights have no lawful source in IGTrack and are refused with the registry reason.",
      "AI Insights is unavailable by design: no personality, MBTI, relationship or location inference is generated from this ledger.",
      "Download is an IGTrack export command over the same stored rows, not a server-generated file URL.",
      "There is no subscription, plan, renewal, private-mark or preview-task state: IGTrack is self-hosted and stores typed provider errors instead.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function valueOf(metric: ActivityMetric): string {
  if (metric.value === null) return `UNAVAILABLE${metric.reason === null ? "" : ` — ${metric.reason}`}`;
  return `${metric.value}${metric.unit === null ? "" : ` ${metric.unit}`}`;
}

function metricLine(metric: ActivityMetric): string {
  return `- ${metric.label}: ${valueOf(metric)} (${metric.state})${metric.evidenceCount > 0 ? ` · ${metric.evidenceCount} evidence row(s)` : ""}`;
}

function blockReason<T>(block: ActivityRankBlock<T>): string {
  return block.state === "UNAVAILABLE" ? `UNAVAILABLE — ${block.reason ?? "the source cannot answer."}` : block.state;
}

function compactMetric(metric: ActivityMetric): string {
  return metric.value === null ? "UNAVAILABLE" : `${metric.value}${metric.unit === null ? "" : ` ${metric.unit}`}`;
}

export interface ActivityRenderOptions {
  /** Render one tab; the header, inventory and divergences are always kept. */
  tab?: "all" | "analytics" | "trails" | "stories" | "insights";
  /** Bound the printed timeline rows; the total counts stay complete. */
  timelineLimit?: number;
}

const ACTIVITY_TAB_HEADINGS: Record<Exclude<NonNullable<ActivityRenderOptions["tab"]>, "all">, string> = {
  analytics: "## Activity Analytics",
  trails: "## Ties & Trails",
  stories: "## Stories & Highlights",
  insights: "## AI Insights",
};

export function renderActivityReportMarkdown(
  report: ActivityReport,
  options: ActivityRenderOptions = {},
): string {
  const analytics = report.tabs.activity_analytics;
  const trails = report.tabs.ties_and_trails;
  const stories = report.tabs.stories_highlights;
  const insights = report.tabs.ai_insights;

  const lines: string[] = [];
  lines.push(`# Activity Report — @${report.media_name}`);
  lines.push("");
  if (report.evidence.synthetic) {
    lines.push("> **SYNTHETIC DATA.** Every attributed row is fixture data; this is not a real account observation.");
    lines.push("");
  }
  lines.push(
    table(
      ["field", "value"],
      [
        ["data type", report.data_type],
        ["period", `${report.begin_time} → ${report.end_time} (exclusive)`],
        ["data id", report.data_id],
        ["report id", report.report_id],
        ["has data", report.has_data ? "yes" : "no"],
        ["period state", report.period_state],
        ["reports delivered", report.reports_delivered],
        ["evidence class", report.evidence.evidenceClass],
        ["source ids", report.evidence.sourceIds.length === 0 ? "none" : report.evidence.sourceIds.join(", ")],
      ],
    ),
  );
  lines.push("");
  lines.push(report.evidence.note);
  lines.push("");
  lines.push("## Activity Analytics");
  lines.push("");
  lines.push(`State: ${analytics.state}`);
  lines.push("");
  for (const line of analytics.narrative) {
    lines.push(`- ${line.text}${line.state === "UNAVAILABLE" && line.reason !== null ? ` (UNAVAILABLE — ${line.reason})` : ""}`);
  }
  lines.push("");
  lines.push(
    table(
      ["metric", "value", "state"],
      [
        ["likes given", valueOf(analytics.like_num), analytics.like_num.state],
        ["accounts liked", valueOf(analytics.like_acct_num), analytics.like_acct_num.state],
        ["new followings", valueOf(analytics.following_num), analytics.following_num.state],
        ["unfollows", valueOf(analytics.un_follow_num), analytics.un_follow_num.state],
        ["posts", valueOf(analytics.post_num), analytics.post_num.state],
        ["stories", valueOf(analytics.story_num), analytics.story_num.state],
        ["comments", valueOf(analytics.comment_num), analytics.comment_num.state],
        ["tagged media", valueOf(analytics.tagged_num), analytics.tagged_num.state],
        ["highlights", valueOf(analytics.highlights_num), analytics.highlights_num.state],
        ["active window", analytics.active_begin_time === null ? "unavailable" : `${analytics.active_begin_time} ~ ${analytics.active_end_time}`, analytics.active_window_state],
      ],
    ),
  );
  lines.push("");
  if (analytics.active_window_reason !== null) {
    lines.push(`Active window note: ${analytics.active_window_reason}`);
    lines.push("");
  }
  const list = (title: string, rows: ActivityPersonRow[]): void => {
    lines.push(`### ${title} (${rows.length})`);
    lines.push("");
    if (rows.length === 0) {
      lines.push("No stored row in this window.");
    } else {
      lines.push(table(["account", "observed", "evidence"], rows.map((row) => [`@${row.username}`, row.observed_at, row.evidence_id])));
    }
    lines.push("");
  };
  list("New followings", analytics.new_followings);
  list("Unfollows", analytics.un_follows);
  list("Tagged users", analytics.tagged_users);
  lines.push(`### Comment ranks`);
  lines.push("");
  lines.push(blockReason(analytics.comment_ranks));
  if (analytics.comment_ranks.rows.length > 0) {
    lines.push("");
    lines.push(table(["account", "comments"], analytics.comment_ranks.rows.map((row) => [`@${row.username}`, row.count])));
  }
  lines.push("");
  lines.push("### Like ranks");
  lines.push("");
  lines.push(blockReason(analytics.like_ranks));
  lines.push("");
  lines.push("### Social platforms");
  lines.push("");
  lines.push(metricLine(analytics.social_platforms));
  lines.push("");
  lines.push("### Posts");
  lines.push("");
  lines.push(`State: ${analytics.post_list.state}`);
  if (analytics.post_list.rows.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["post", "taken at", "type", "likes", "comments", "caption"],
        analytics.post_list.rows.map((row) => [
          row.id,
          row.taken_at,
          row.media_type,
          row.like_count,
          row.comment_count,
          row.caption === null ? null : row.caption.slice(0, 80),
        ]),
      ),
    );
    lines.push("");
    lines.push(`Media assets: ${analytics.post_list.rows[0]?.media_url_reason ?? "unavailable"}`);
  } else if (analytics.post_list.reason !== null) {
    lines.push("");
    lines.push(analytics.post_list.reason);
  }
  lines.push("");
  lines.push("### Download");
  lines.push("");
  lines.push(
    analytics.download.command === null
      ? `No download command is available (${analytics.download.state}).`
      : `\`${analytics.download.command}\``,
  );
  lines.push("");
  lines.push("## Ties & Trails");
  lines.push("");
  lines.push(`State: ${trails.state} · ${trails.days_analyzed.value ?? "unavailable"} days analyzed`);
  lines.push("");
  lines.push(
    table(
      ["summary", "total", "total state", "this month", "month state"],
      [
        [
          "new follows",
          compactMetric(trails.totals.followed_data.total),
          trails.totals.followed_data.total.state,
          compactMetric(trails.totals.followed_data.month_new),
          trails.totals.followed_data.month_new.state,
        ],
        [
          "new updates",
          compactMetric(trails.totals.post_data.total),
          trails.totals.post_data.total.state,
          compactMetric(trails.totals.post_data.month_new),
          trails.totals.post_data.month_new.state,
        ],
        [
          "likes given",
          compactMetric(trails.totals.like_data.total),
          trails.totals.like_data.total.state,
          compactMetric(trails.totals.like_data.month_new),
          trails.totals.like_data.month_new.state,
        ],
        [
          "unfollows",
          compactMetric(trails.totals.unfollowed_data.total),
          trails.totals.unfollowed_data.total.state,
          compactMetric(trails.totals.unfollowed_data.month_new),
          trails.totals.unfollowed_data.month_new.state,
        ],
      ],
    ),
  );
  lines.push("");
  lines.push(`Month semantics: ${trails.totals.followed_data.month_new.reason ?? "deltas whose first observation falls inside the reporting month."}`);
  lines.push("");
  lines.push("### Connection narrative");
  lines.push("");
  for (const line of trails.connection_narrative) {
    lines.push(`- ${line.text}${line.state === "UNAVAILABLE" && line.reason !== null ? ` (${line.reason})` : ""}`);
  }
  lines.push("");
  lines.push("### Media tags");
  lines.push("");
  lines.push(blockReason(trails.media_tags));
  if (trails.media_tags.rows.length > 0) {
    lines.push("");
    lines.push(trails.media_tags.rows.map((row) => `#${row.term} (${row.count})`).join(", "));
  }
  lines.push("");
  lines.push("### Interest tags");
  lines.push("");
  lines.push(blockReason(trails.interest_tags));
  lines.push("");
  lines.push("### Timeline");
  lines.push("");
  lines.push(`${trails.timeline_total} period(s), ${trails.timeline_non_empty} with activity. Newest first.`);
  const timelineLimit = options.timelineLimit;
  const shownTimeline =
    timelineLimit === undefined ? trails.timeline : trails.timeline.slice(0, Math.max(0, timelineLimit));
  if (timelineLimit !== undefined) {
    lines.push(
      `Showing ${shownTimeline.length} of ${trails.timeline.length} period(s); the counts above are complete.`,
    );
  }
  lines.push("");
  if (shownTimeline.length > 0) {
    lines.push(
      table(
        ["period", "begin", "end", "posts", "stories", "comments", "follows", "unfollows", "total", "state", "provisional"],
        shownTimeline.map((entry) => [
          entry.period.label,
          entry.period.begin_time,
          entry.period.end_time,
          entry.posts.count,
          entry.stories.count,
          entry.most_comments.count,
          entry.follows.count,
          entry.unfollows.count,
          entry.total_events,
          entry.state,
          entry.provisional ? "yes" : null,
        ]),
      ),
    );
  }
  lines.push("");
  lines.push("### Top content");
  lines.push("");
  lines.push(`Comments: ${trails.top_content.comments.state}${trails.top_content.comments.reason === null ? "" : ` — ${trails.top_content.comments.reason}`}`);
  if (trails.top_content.comments.rows.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["when", "author", "comment", "likes", "evidence"],
        trails.top_content.comments.rows.map((row) => [
          row.commentedAt,
          `@${row.username}`,
          row.body.slice(0, 100),
          row.likeCount,
          row.evidenceId,
        ]),
      ),
    );
  }
  lines.push("");
  lines.push(`Places visited: ${blockReason(trails.top_content.places_visited)}`);
  lines.push("");
  lines.push("## Stories & Highlights");
  lines.push("");
  lines.push(`State: ${stories.state} · enabled: ${stories.enabled ? "yes" : "no (DAILY periods never request story data)"}`);
  lines.push("");
  lines.push(`Report identity: ${stories.report_id} · ${stories.begin_date} → ${stories.end_date}`);
  lines.push("");
  lines.push(`### Stories (${stories.stories.rows.length})`);
  lines.push("");
  lines.push(stories.stories.reason ?? "Stored story rows for this period.");
  if (stories.stories.rows.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["story", "taken at", "type", "expires", "evidence"],
        stories.stories.rows.map((row) => [row.id, row.taken_at, row.media_type, row.expires_at, row.evidence_id]),
      ),
    );
  }
  lines.push("");
  lines.push(`New highlights: ${blockReason(stories.new_highlights)}`);
  lines.push("");
  lines.push(`Old highlights: ${blockReason(stories.old_highlights)}`);
  lines.push("");
  lines.push(
    stories.batch_download.command === null
      ? `Batch download: ${stories.batch_download.state} — ${stories.batch_download.reason ?? "nothing to download."}`
      : `Batch download: \`${stories.batch_download.command}\``,
  );
  lines.push("");
  lines.push("## AI Insights");
  lines.push("");
  lines.push(`State: ${insights.state}`);
  lines.push("");
  lines.push(insights.reason);
  lines.push("");
  lines.push(insights.alternative);
  lines.push("");
  lines.push("## Period inventory");
  lines.push("");
  lines.push(`Delivered (non-daily, with stored rows): ${report.reports_delivered} of ${report.periods.length} listed period(s).`);
  lines.push("");
  if (report.periods.length > 0) {
    lines.push(
      table(
        ["period", "data type", "begin", "end", "state", "events", "badge", "compose with"],
        report.periods.map((entry) => [
          entry.label,
          entry.data_type,
          entry.begin_time,
          entry.end_time,
          entry.state,
          entry.event_count,
          entry.badge,
          entry.command,
        ]),
      ),
    );
  }
  lines.push("");
  lines.push(report.periods_note);
  lines.push("");
  lines.push("## Deliberate divergences");
  lines.push("");
  for (const divergence of report.divergences) {
    lines.push(`- ${divergence}`);
  }
  lines.push("");

  const tab = options.tab ?? "all";
  let visible = lines;
  if (tab !== "all") {
    const keepHeading = ACTIVITY_TAB_HEADINGS[tab];
    const alwaysKeep = new Set([keepHeading, "## Period inventory", "## Deliberate divergences"]);
    let section: string | null = null;
    visible = lines.filter((line) => {
      if (line.startsWith("## ")) section = line;
      return section === null || alwaysKeep.has(section);
    });
  }
  return `${visible.join("\n").trimEnd()}\n`;
}
