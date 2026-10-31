import {
  ACTIVITY_DATA_TYPES,
  activityBadge,
  activityDataId,
  activityReportId,
  activityWindow,
  type ActivityAbsenceReasons,
  type ActivityDataType,
  type ActivityMetric,
  type ActivityPeriod,
  type ActivityPostRow,
  type ActivityReadable,
  type ActivityValueState,
  type ActivityWindow,
} from "./activity-report.js";
import type {
  ReportComment,
  ReportEvidenceClass,
  ReportFollowCoverage,
  ReportFollowDelta,
  ReportMention,
  ReportPost,
  ReportStory,
  ReportTag,
} from "./report.js";
import { deriveThemes, type SynthesisTerm } from "./synthesis.js";

// ---------------------------------------------------------------------------
// The Activity Tracker: a watchlist of observed accounts, each with a card
// composed from the same stored ledger the four-tab Activity Report reads.
//
// This module adds no acquisition and no second data path. It selects a
// closed calendar window (the latest one unless the caller names a period),
// then projects the rows the report already knows how to read. The negative
// contract is identical: a metric with no lawful source is null +
// UNAVAILABLE + a registry reason, never zero; a roster that was never
// compared is a coverage gap, not an empty list.
//
// Pure: no clock, no I/O. Callers supply the window, rows, coverage and
// evidence class, so the same input renders byte-identically.
// ---------------------------------------------------------------------------

export const TRACKER_EMAIL_ABSENCE_REASON =
  "IGTrack is self-hosted and has no email delivery: no address is collected, no message is sent and no hosted report link exists. The local equivalents are `igtrack digest` and `igtrack alerts`, which read the same stored rows and write files you name.";

export const TRACKER_PEOPLE_LIMIT = 100;
export const TRACKER_POST_LIMIT = 50;
export const TRACKER_COMMENT_LIMIT = 20;
export const TRACKER_RANK_LIMIT = 10;
export const TRACKER_HASHTAG_LIMIT = 100;

// ---------------------------------------------------------------------------
// Window selection
// ---------------------------------------------------------------------------

/**
 * The latest calendar window whose end is not after `now`. A tracker card is
 * a closed-period card — an open window's zero is not a completed zero.
 * Weeks start Monday and every bound is UTC, matching `activityWindow`.
 */
export function latestClosedActivityWindow(
  period: ActivityPeriod,
  now: Date = new Date(),
): ActivityWindow {
  const current = activityWindow(period, now);
  if (new Date(current.end).getTime() <= now.getTime()) return current;
  return activityWindow(period, new Date(new Date(current.start).getTime() - 1));
}

export interface TrackerWindowOptions {
  /** The instant named by --at, when it was named. */
  at?: Date;
  explicitAt: boolean;
  now?: Date;
}

/**
 * The window a tracker call reads. An explicit --at selects the containing
 * window exactly, including a window that has not closed (the card then says
 * IN_PROGRESS); otherwise the latest closed window is selected.
 */
export function trackerWindow(
  period: ActivityPeriod,
  options: TrackerWindowOptions,
): ActivityWindow {
  const now = options.now ?? new Date();
  if (options.explicitAt) return activityWindow(period, options.at ?? now);
  return latestClosedActivityWindow(period, now);
}

export function trackerCardCommand(
  username: string,
  period: ActivityPeriod,
  window: ActivityWindow,
): string {
  return `igtrack tracker @${username} --period ${period} --at ${window.start.slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface TrackerEvidence {
  sourceIds: string[];
  evidenceClass: ReportEvidenceClass;
  synthetic: boolean;
  note: string;
}

export function trackerEvidenceNote(evidenceClass: ReportEvidenceClass): string {
  switch (evidenceClass) {
    case "NONE":
      return "No stored row in this window carries an evidence id; no source is attributed.";
    case "SYNTHETIC":
      return "Every attributed row is synthetic fixture data. Not a real account observation.";
    case "MIXED":
      return "Attributed rows mix synthetic and non-synthetic sources; they are listed verbatim and never blended into one class.";
    case "LIVE":
      return "Attributed from stored observation rows; the class describes the rows, not the configured provider.";
  }
}

export interface TrackerLatestJobInput {
  status: string | null;
  outcome: string | null;
  completedAt: string | null;
  availableAt: string | null;
}

export interface TrackerTargetInput {
  id: string;
  username: string;
  localName: string | null;
  observationMode: "OWNED" | "DISCOVERY";
  status: string;
  isPrivate: boolean | null;
  trackingSince: string | null;
  lastObservedAt: string | null;
  latestJob: TrackerLatestJobInput;
}

export interface TrackerCardInput {
  target: TrackerTargetInput;
  period: ActivityPeriod;
  window: ActivityWindow;
  generatedAt: string;
  evidence: TrackerEvidence;
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
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type TrackerPeriodState = "IN_PROGRESS" | "DELIVERED" | "EMPTY" | "UNAVAILABLE";

export interface TrackerPersonRow {
  username: string;
  /** First instant this deployment observed the delta — not Instagram's follow time. */
  observed_at: string;
  evidence_id: string | null;
}

export interface TrackerRecentComment {
  id: string;
  username: string;
  body: string;
  commented_at: string;
  like_count: number | null;
  post_id: string;
  evidence_id: string | null;
}

export interface TrackerRankRow {
  username: string;
  count: number;
}

export interface TrackerPeopleBlock {
  state: ActivityValueState;
  reason: string | null;
  total: number;
  truncated: boolean;
  rows: TrackerPersonRow[];
}

export interface TrackerRankBlock {
  state: ActivityValueState;
  reason: string | null;
  total: number;
  truncated: boolean;
  rows: TrackerRankRow[];
}

export interface TrackerCommentBlock {
  state: ActivityValueState;
  reason: string | null;
  /** How to read a null like_count on a row; null is a stored value, not a zero. */
  like_count_note: string;
  total: number;
  truncated: boolean;
  rows: TrackerRecentComment[];
}

export interface TrackerPostBlock {
  state: ActivityValueState;
  reason: string | null;
  total: number;
  truncated: boolean;
  rows: ActivityPostRow[];
}

export interface TrackerHashtagBlock {
  state: ActivityValueState;
  reason: string | null;
  caption_rows: number;
  rows: SynthesisTerm[];
}

export interface TrackerNextScan {
  at: string | null;
  state: "SCHEDULED" | "UNAVAILABLE";
  reason: string | null;
  note: string;
}

export interface TrackerForbidden {
  capability: string;
  reason: string;
}

export interface TrackerPeriodView {
  period: ActivityPeriod;
  data_type: ActivityDataType;
  label: string;
  begin_time: string;
  end_time: string;
  data_id: string;
  report_id: string;
  badge: string | null;
  state: TrackerPeriodState;
  provisional: boolean;
  has_data: boolean;
}

export interface TrackerTargetView {
  id: string;
  username: string;
  local_name: string | null;
  observation_mode: "OWNED" | "DISCOVERY";
  status: string;
  is_private: boolean | null;
  tracking_since: string | null;
  last_observed_at: string | null;
  latest_job: { status: string | null; outcome: string | null; completed_at: string | null };
  next_scan: TrackerNextScan;
}

export interface TrackerKpis {
  new_followings: ActivityMetric;
  un_follows: ActivityMetric;
  posts: ActivityMetric;
  stories: ActivityMetric;
  comments: ActivityMetric;
  tags: ActivityMetric;
  mentions: ActivityMetric;
  accounts_liked: ActivityMetric;
  highlights: ActivityMetric;
  verified_follows: ActivityMetric;
}

export interface TrackerCard {
  feature: "igtrack.tracker";
  adaptation: "igtrack-cli";
  mode: "target";
  target: TrackerTargetView;
  period: TrackerPeriodView;
  kpis: TrackerKpis;
  new_followings: TrackerPeopleBlock;
  un_follows: TrackerPeopleBlock;
  top_commenters: TrackerRankBlock;
  recent_comments: TrackerCommentBlock;
  posts: TrackerPostBlock;
  hashtags: TrackerHashtagBlock;
  ai_insights: {
    has_insights: false;
    state: "UNAVAILABLE";
    reason: string;
    sub_type: "NOT_APPLICABLE";
  };
  evidence: TrackerEvidence;
  refusals: TrackerForbidden[];
  delivery: {
    mode: "LOCAL";
    email: null;
    email_state: "UNAVAILABLE";
    email_reason: string;
    digest_command: string;
    note: string;
  };
  commands: { tracker: string; activity_report: string; reports: string };
  note: string;
}

export interface TrackerListCard {
  target: {
    id: string;
    username: string;
    local_name: string | null;
    observation_mode: "OWNED" | "DISCOVERY";
    status: string;
    is_private: boolean | null;
    last_observed_at: string | null;
  };
  period: TrackerPeriodView;
  kpis: Pick<
    TrackerKpis,
    "new_followings" | "un_follows" | "posts" | "stories" | "comments" | "tags" | "mentions"
  >;
  evidence: TrackerEvidence;
  commands: { tracker: string; activity_report: string };
}

export interface TrackerOverview {
  feature: "igtrack.tracker";
  adaptation: "igtrack-cli";
  mode: "overview";
  generated_at: string;
  period: ActivityPeriod;
  window: ActivityWindow;
  totals: {
    tracked: number;
    active: number;
    paused: number;
    stopped: number;
    displayed: number;
  };
  cards: TrackerListCard[];
  evidence: TrackerEvidence;
  refusals: TrackerForbidden[];
  note: string;
}

export interface TrackerOverviewInput {
  period: ActivityPeriod;
  window: ActivityWindow;
  generatedAt: string;
  totals: TrackerOverview["totals"];
  cards: TrackerCard[];
  evidence: TrackerEvidence;
  refusals: TrackerForbidden[];
  note: string;
}

// ---------------------------------------------------------------------------
// Builders
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
  return { evidenceIds: seen.slice(0, 24), evidenceCount: seen.length };
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

function followState(
  compared: boolean,
  readable: ActivityReadable,
): { state: ActivityValueState; reason: string | null } {
  if (compared) return { state: "DERIVED", reason: null };
  return {
    state: "UNAVAILABLE",
    reason: readable.readable
      ? "No COMPLETE following roster was compared in this window, so no delta can be counted. Zero would mean 'nothing changed', which was not measured."
      : (readable.reason ?? "The configured source cannot answer follow movement for this window."),
  };
}

export function trackerNextScan(latestJob: TrackerLatestJobInput): TrackerNextScan {
  const note =
    "A queue timestamp is when the scheduler may start the latest pending job; it is not a promise that the observation will succeed.";
  if (latestJob.status === "queued" || latestJob.status === "retry_wait") {
    if (latestJob.availableAt !== null) {
      return { at: latestJob.availableAt, state: "SCHEDULED", reason: null, note };
    }
    return {
      at: null,
      state: "UNAVAILABLE",
      reason: "The latest scan job is pending but carries no scheduled time.",
      note,
    };
  }
  if (latestJob.status === "running") {
    return {
      at: null,
      state: "UNAVAILABLE",
      reason: "A scan job is running; its next run time is not recorded until the job completes.",
      note,
    };
  }
  if (latestJob.status === null) {
    return {
      at: null,
      state: "UNAVAILABLE",
      reason: "No scan job has been recorded for this target.",
      note,
    };
  }
  return {
    at: null,
    state: "UNAVAILABLE",
    reason:
      "No pending scan job is recorded. The scheduler enqueues the next scan from the deployment cadence, and that future time is not stored.",
    note,
  };
}

export function trackerRefusals(absence: ActivityAbsenceReasons): TrackerForbidden[] {
  return [
    { capability: "ACCOUNTS_LIKED", reason: absence.likes },
    { capability: "HIGHLIGHTS", reason: absence.highlights },
    { capability: "VERIFIED_FOLLOWS", reason: absence.verified },
    { capability: "AI_INSIGHTS", reason: absence.aiInsights },
    { capability: "EXTERNAL_PLATFORMS", reason: absence.externalPlatforms },
    { capability: "PLACES", reason: absence.places },
    { capability: "EMAIL_DELIVERY", reason: TRACKER_EMAIL_ABSENCE_REASON },
  ];
}

function personRows(deltas: readonly ReportFollowDelta[]): TrackerPersonRow[] {
  return [...deltas]
    .sort((a, b) => b.at.localeCompare(a.at) || a.username.localeCompare(b.username))
    .map((row) => ({ username: row.username, observed_at: row.at, evidence_id: row.evidenceId }));
}

function peopleBlock(
  deltas: readonly ReportFollowDelta[],
  state: ActivityValueState,
  reason: string | null,
): TrackerPeopleBlock {
  const rows = personRows(deltas);
  return {
    state,
    reason,
    total: rows.length,
    truncated: rows.length > TRACKER_PEOPLE_LIMIT,
    rows: rows.slice(0, TRACKER_PEOPLE_LIMIT),
  };
}

function activityCount(rows: TrackerCardInput["rows"]): number {
  return (
    rows.followDeltas.length +
    rows.posts.length +
    rows.stories.length +
    rows.comments.length +
    rows.tags.length +
    rows.mentions.length
  );
}

export function buildTrackerCard(input: TrackerCardInput): TrackerCard {
  const { rows, readable, absence } = input;
  const generatedAt = new Date(input.generatedAt);
  const closed = new Date(input.window.end).getTime() <= generatedAt.getTime();
  const anyReadable = Object.values(readable).some((family) => family.readable);
  const eventCount = activityCount(rows);

  const periodState: TrackerPeriodState = !closed
    ? "IN_PROGRESS"
    : eventCount > 0
      ? "DELIVERED"
      : anyReadable
        ? "EMPTY"
        : "UNAVAILABLE";

  const compared =
    rows.followDeltas.length > 0 || input.followCoverage.following.complete > 0;
  const follow = followState(compared, readable.follows);
  const newFollowRows = rows.followDeltas.filter((row) => row.change === "NEW_FOLLOWING");
  const lostFollowRows = rows.followDeltas.filter((row) => row.change === "LOST_FOLLOWING");

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
  const mentionState: ActivityValueState = readable.stories.readable
    ? rows.mentions.length > 0
      ? "DERIVED"
      : "EMPTY"
    : "UNAVAILABLE";

  const themes = deriveThemes(
    rows.posts.map((row) => row.caption),
    { limit: TRACKER_HASHTAG_LIMIT },
  );
  const hashtagState: ActivityValueState = !readable.posts.readable
    ? "UNAVAILABLE"
    : themes.hashtags.length > 0
      ? "DERIVED"
      : themes.captionRows > 0
        ? "EMPTY"
        : "UNAVAILABLE";
  const hashtagReason =
    hashtagState === "UNAVAILABLE"
      ? readable.posts.readable
        ? "No caption text is stored, so a hashtag corpus does not exist. Zero hashtags would be a fabricated reading of an absent corpus."
        : (readable.posts.reason ?? "The configured source exposes no media listing.")
      : hashtagState === "EMPTY"
        ? "Stored captions contain no hashtags."
        : null;

  const commentRanks = new Map<string, number>();
  for (const comment of rows.comments) {
    commentRanks.set(comment.authorUsername, (commentRanks.get(comment.authorUsername) ?? 0) + 1);
  }
  const rankedCommenters: TrackerRankRow[] = [...commentRanks.entries()]
    .map(([username, count]) => ({ username, count }))
    .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username));

  const recentComments = [...rows.comments]
    .sort((a, b) => b.commentedAt.localeCompare(a.commentedAt) || b.id.localeCompare(a.id))
    .map((row) => ({
      id: row.id,
      username: row.authorUsername,
      body: row.body,
      commented_at: row.commentedAt,
      like_count: row.likeCount ?? null,
      post_id: row.postId,
      evidence_id: row.evidenceId,
    }));

  const postRows: ActivityPostRow[] = [...rows.posts]
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt) || a.id.localeCompare(b.id))
    .map((row) => ({
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

  const period: TrackerPeriodView = {
    period: input.period,
    data_type: ACTIVITY_DATA_TYPES[input.period],
    label: input.window.label,
    begin_time: input.window.start,
    end_time: input.window.end,
    data_id: activityDataId(input.target.id, input.window),
    report_id: activityReportId(input.target.id, input.window),
    badge: activityBadge(input.period),
    state: periodState,
    provisional: !closed,
    has_data: eventCount > 0,
  };

  const kpis: TrackerKpis = {
    new_followings: metric(
      "new_followings",
      "New followings",
      compared ? newFollowRows.length : null,
      follow.state,
      {
        unit: "accounts",
        reason: follow.reason,
        evidence: newFollowRows.map((row) => row.evidenceId),
      },
    ),
    un_follows: metric(
      "un_follows",
      "Unfollows",
      compared ? lostFollowRows.length : null,
      follow.state,
      {
        unit: "accounts",
        reason: follow.reason,
        evidence: lostFollowRows.map((row) => row.evidenceId),
      },
    ),
    posts: metric(
      "posts",
      "Posts",
      readable.posts.readable ? rows.posts.length : null,
      postState,
      {
        reason: postState === "UNAVAILABLE" ? readable.posts.reason : null,
        evidence: rows.posts.map((row) => row.evidenceId),
      },
    ),
    stories: metric(
      "stories",
      "Stories",
      readable.stories.readable ? rows.stories.length : null,
      storyState,
      {
        reason: storyState === "UNAVAILABLE" ? readable.stories.reason : null,
        evidence: rows.stories.map((row) => row.evidenceId),
      },
    ),
    comments: metric(
      "comments",
      "Comments",
      readable.comments.readable ? rows.comments.length : null,
      commentState,
      {
        reason: commentState === "UNAVAILABLE" ? readable.comments.reason : null,
        evidence: rows.comments.map((row) => row.evidenceId),
      },
    ),
    tags: metric(
      "tags",
      "Tagged media",
      readable.tags.readable ? rows.tags.length : null,
      tagState,
      {
        reason: tagState === "UNAVAILABLE" ? readable.tags.reason : null,
        evidence: rows.tags.map((row) => row.evidenceId),
      },
    ),
    mentions: metric(
      "mentions",
      "Story mentions",
      readable.stories.readable ? rows.mentions.length : null,
      mentionState,
      {
        reason: mentionState === "UNAVAILABLE" ? readable.stories.reason : null,
        evidence: rows.mentions.map((row) => row.evidenceId),
      },
    ),
    accounts_liked: unavailable("accounts_liked", "Accounts liked", absence.likes),
    highlights: unavailable("highlights", "Highlights", absence.highlights),
    verified_follows: unavailable("verified_follows", "Verified followings", absence.verified),
  };

  const note = `Composed from stored rows in ${input.window.start}–${input.window.end} (UTC, end exclusive). ${
    periodState === "IN_PROGRESS"
      ? "The period has not closed; its counts are partial and a zero is not a completed zero."
      : "A zero is printed only where a readable source or a COMPLETE following-roster comparison measured it."
  } Counts match igtrack activity-report for this window because both read the same ledger.`;

  return {
    feature: "igtrack.tracker",
    adaptation: "igtrack-cli",
    mode: "target",
    target: {
      id: input.target.id,
      username: input.target.username,
      local_name: input.target.localName,
      observation_mode: input.target.observationMode,
      status: input.target.status,
      is_private: input.target.isPrivate,
      tracking_since: input.target.trackingSince,
      last_observed_at: input.target.lastObservedAt,
      latest_job: {
        status: input.target.latestJob.status,
        outcome: input.target.latestJob.outcome,
        completed_at: input.target.latestJob.completedAt,
      },
      next_scan: trackerNextScan(input.target.latestJob),
    },
    period,
    kpis,
    new_followings: peopleBlock(newFollowRows, follow.state, follow.reason),
    un_follows: peopleBlock(lostFollowRows, follow.state, follow.reason),
    top_commenters: {
      state: commentState,
      reason: commentState === "UNAVAILABLE" ? readable.comments.reason : null,
      total: rankedCommenters.length,
      truncated: rankedCommenters.length > TRACKER_RANK_LIMIT,
      rows: rankedCommenters.slice(0, TRACKER_RANK_LIMIT),
    },
    recent_comments: {
      state: commentState,
      reason: commentState === "UNAVAILABLE" ? readable.comments.reason : null,
      like_count_note:
        "like_count is the value stored with the comment; null means the source listing carried no like count for that comment, not that it had zero likes.",
      total: recentComments.length,
      truncated: recentComments.length > TRACKER_COMMENT_LIMIT,
      rows: recentComments.slice(0, TRACKER_COMMENT_LIMIT),
    },
    posts: {
      state: postState,
      reason: postState === "UNAVAILABLE" ? readable.posts.reason : null,
      total: postRows.length,
      truncated: postRows.length > TRACKER_POST_LIMIT,
      rows: postRows.slice(0, TRACKER_POST_LIMIT),
    },
    hashtags: {
      state: hashtagState,
      reason: hashtagReason,
      caption_rows: themes.captionRows,
      rows: themes.hashtags,
    },
    ai_insights: {
      has_insights: false,
      state: "UNAVAILABLE",
      reason: absence.aiInsights,
      sub_type: "NOT_APPLICABLE",
    },
    evidence: input.evidence,
    refusals: trackerRefusals(absence),
    delivery: {
      mode: "LOCAL",
      email: null,
      email_state: "UNAVAILABLE",
      email_reason: TRACKER_EMAIL_ABSENCE_REASON,
      digest_command: `igtrack digest @${input.target.username} --since ${input.window.start.slice(0, 10)}`,
      note:
        "The digest covers everything observed since the window start, including later rows; for this exact closed window use commands.activity_report.",
    },
    commands: {
      tracker: trackerCardCommand(input.target.username, input.period, input.window),
      activity_report: `igtrack activity-report @${input.target.username} --period ${input.period} --at ${input.window.start.slice(0, 10)}`,
      reports: `igtrack reports @${input.target.username} --period ${input.period}`,
    },
    note,
  };
}

export function buildTrackerOverview(input: TrackerOverviewInput): TrackerOverview {
  const cards: TrackerListCard[] = input.cards.map((card) => ({
    target: {
      id: card.target.id,
      username: card.target.username,
      local_name: card.target.local_name,
      observation_mode: card.target.observation_mode,
      status: card.target.status,
      is_private: card.target.is_private,
      last_observed_at: card.target.last_observed_at,
    },
    period: card.period,
    kpis: {
      new_followings: card.kpis.new_followings,
      un_follows: card.kpis.un_follows,
      posts: card.kpis.posts,
      stories: card.kpis.stories,
      comments: card.kpis.comments,
      tags: card.kpis.tags,
      mentions: card.kpis.mentions,
    },
    evidence: card.evidence,
    commands: {
      tracker: card.commands.tracker,
      activity_report: card.commands.activity_report,
    },
  }));

  return {
    feature: "igtrack.tracker",
    adaptation: "igtrack-cli",
    mode: "overview",
    generated_at: input.generatedAt,
    period: input.period,
    window: input.window,
    totals: input.totals,
    cards,
    evidence: input.evidence,
    refusals: input.refusals,
    note: input.note,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function metricValue(metricRow: ActivityMetric): string {
  if (metricRow.value === null) return "UNAVAILABLE";
  return metricRow.unit === null
    ? String(metricRow.value)
    : `${metricRow.value} ${metricRow.unit}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function pushStateLine(
  lines: string[],
  block: { state: ActivityValueState; reason: string | null },
): void {
  if (block.state === "DERIVED" || block.state === "OBSERVED") return;
  const suffix = block.reason !== null ? ` — ${block.reason}` : block.state === "EMPTY" ? " — measured zero." : "";
  lines.push(`${block.state}${suffix}`);
}

function kpiEntries(kpis: TrackerKpis): Array<[string, ActivityMetric]> {
  return [
    ["new_followings", kpis.new_followings],
    ["un_follows", kpis.un_follows],
    ["posts", kpis.posts],
    ["stories", kpis.stories],
    ["comments", kpis.comments],
    ["tags", kpis.tags],
    ["mentions", kpis.mentions],
    ["accounts_liked", kpis.accounts_liked],
    ["highlights", kpis.highlights],
    ["verified_follows", kpis.verified_follows],
  ];
}

export function renderTrackerCardMarkdown(card: TrackerCard): string {
  const lines: string[] = [];
  lines.push(`# Activity Tracker — @${card.target.username}`);
  lines.push("");
  lines.push(
    `Target: ${card.target.status} · ${card.target.observation_mode}${
      card.target.is_private === true ? " · private" : ""
    }`,
  );
  lines.push(`Tracked since: ${card.target.tracking_since ?? "—"}`);
  lines.push(`Last observed: ${card.target.last_observed_at ?? "—"}`);
  lines.push(
    `Next scan: ${card.target.next_scan.at ?? "UNAVAILABLE"}${
      card.target.next_scan.reason !== null ? ` — ${card.target.next_scan.reason}` : ""
    }`,
  );
  lines.push(
    `Latest job: ${card.target.latest_job.status ?? "none"}${
      card.target.latest_job.outcome !== null ? ` (${card.target.latest_job.outcome})` : ""
    }`,
  );
  lines.push("");
  lines.push(`Period: ${card.period.data_type} ${card.period.label}`);
  lines.push(`Window: ${card.period.begin_time} → ${card.period.end_time} (UTC, end exclusive)`);
  lines.push(
    `State: ${card.period.state}${
      card.period.provisional ? " (provisional; the period has not closed)" : ""
    }`,
  );
  lines.push("");
  lines.push("## KPIs");
  lines.push("");
  lines.push("| Metric | Value | State |");
  lines.push("|---|---|---|");
  for (const [, metricRow] of kpiEntries(card.kpis)) {
    lines.push(`| ${metricRow.label} | ${metricValue(metricRow)} | ${metricRow.state} |`);
  }
  const metricAbsences = kpiEntries(card.kpis)
    .map(([, metricRow]) => metricRow)
    .filter((metricRow) => metricRow.state === "UNAVAILABLE");
  if (metricAbsences.length > 0) {
    lines.push("");
    lines.push("UNAVAILABLE metrics:");
    for (const metricRow of metricAbsences) {
      lines.push(`- ${metricRow.label}: ${metricRow.reason}`);
    }
  }

  lines.push("");
  lines.push(`## New followings (${card.new_followings.total})`);
  pushStateLine(lines, card.new_followings);
  if (card.new_followings.rows.length > 0) {
    lines.push("");
    lines.push("| Username | First observed | Evidence |");
    lines.push("|---|---|---|");
    for (const row of card.new_followings.rows) {
      lines.push(`| @${row.username} | ${row.observed_at} | ${row.evidence_id ?? "—"} |`);
    }
    if (card.new_followings.truncated) {
      lines.push("");
      lines.push(`Showing ${card.new_followings.rows.length} of ${card.new_followings.total}.`);
    }
  }

  lines.push("");
  lines.push(`## Unfollows (${card.un_follows.total})`);
  pushStateLine(lines, card.un_follows);
  if (card.un_follows.rows.length > 0) {
    lines.push("");
    lines.push("| Username | First observed | Evidence |");
    lines.push("|---|---|---|");
    for (const row of card.un_follows.rows) {
      lines.push(`| @${row.username} | ${row.observed_at} | ${row.evidence_id ?? "—"} |`);
    }
    if (card.un_follows.truncated) {
      lines.push("");
      lines.push(`Showing ${card.un_follows.rows.length} of ${card.un_follows.total}.`);
    }
  }

  lines.push("");
  lines.push(`## Top commenters (${card.top_commenters.total})`);
  pushStateLine(lines, card.top_commenters);
  if (card.top_commenters.rows.length > 0) {
    lines.push("");
    for (const row of card.top_commenters.rows) {
      lines.push(`- @${row.username} — ${row.count} comment(s)`);
    }
    if (card.top_commenters.truncated) {
      lines.push(`- Showing ${card.top_commenters.rows.length} of ${card.top_commenters.total}.`);
    }
  }

  lines.push("");
  lines.push(`## Recent comments (${card.recent_comments.total})`);
  pushStateLine(lines, card.recent_comments);
  if (card.recent_comments.rows.length > 0) {
    lines.push("");
    for (const row of card.recent_comments.rows) {
      lines.push(
        `- @${row.username} at ${row.commented_at} on post ${row.post_id}: "${oneLine(row.body)}" (likes ${
          row.like_count === null ? "not stored" : row.like_count
        }, evidence ${row.evidence_id ?? "—"})`,
      );
    }
    if (card.recent_comments.truncated) {
      lines.push(`- Showing ${card.recent_comments.rows.length} of ${card.recent_comments.total}.`);
    }
    lines.push("");
    lines.push(card.recent_comments.like_count_note);
  }

  lines.push("");
  lines.push(`## Posts (${card.posts.total})`);
  pushStateLine(lines, card.posts);
  if (card.posts.rows.length > 0) {
    lines.push("");
    lines.push("| Published | Caption | Likes | Comments | Evidence |");
    lines.push("|---|---|---|---|---|");
    for (const row of card.posts.rows) {
      lines.push(
        `| ${row.taken_at} | ${oneLine(row.caption ?? "—").replace(/\|/g, "\\|")} | ${
          row.like_count ?? "—"
        } | ${row.comment_count ?? "—"} | ${row.evidence_id ?? "—"} |`,
      );
    }
    if (card.posts.truncated) {
      lines.push("");
      lines.push(`Showing ${card.posts.rows.length} of ${card.posts.total}.`);
    }
    lines.push("");
    lines.push(`Media assets: ${card.posts.rows[0]?.media_url_reason ?? "unavailable"}`);
  }

  lines.push("");
  lines.push(`## Hashtags (${card.hashtags.rows.length})`);
  if (card.hashtags.state !== "DERIVED") {
    lines.push(
      `${card.hashtags.state}${card.hashtags.reason !== null ? ` — ${card.hashtags.reason}` : ""}`,
    );
  }
  if (card.hashtags.rows.length > 0) {
    lines.push("");
    lines.push(card.hashtags.rows.map((row) => `#${row.term} (${row.count})`).join(" · "));
  }

  lines.push("");
  lines.push("## AI Insights");
  lines.push(`UNAVAILABLE — ${card.ai_insights.reason}`);

  lines.push("");
  lines.push("## Refusals");
  for (const refusal of card.refusals) {
    lines.push(`- ${refusal.capability}: ${refusal.reason}`);
  }

  lines.push("");
  lines.push("## Delivery");
  lines.push(`Local only. ${card.delivery.email_reason}`);
  lines.push(`Digest: \`${card.delivery.digest_command}\` — ${card.delivery.note}`);

  lines.push("");
  lines.push("## Evidence");
  lines.push(
    `Sources: ${card.evidence.sourceIds.length === 0 ? "none attributed" : card.evidence.sourceIds.join(", ")}`,
  );
  lines.push(`Class: ${card.evidence.evidenceClass} — ${card.evidence.note}`);

  lines.push("");
  lines.push("## Commands");
  lines.push(`- \`${card.commands.activity_report}\``);
  lines.push(`- \`${card.commands.reports}\``);
  lines.push(`- \`${card.commands.tracker}\``);

  lines.push("");
  lines.push(card.note);
  lines.push("");
  return lines.join("\n");
}

export function renderTrackerOverviewMarkdown(overview: TrackerOverview): string {
  const lines: string[] = [];
  lines.push(`# Activity Tracker — ${overview.window.label}`);
  lines.push("");
  lines.push(`Period: ${ACTIVITY_DATA_TYPES[overview.period]} ${overview.window.label}`);
  lines.push(
    `Window: ${overview.window.start} → ${overview.window.end} (UTC, end exclusive)`,
  );
  lines.push(
    `Tracked: ${overview.totals.tracked} (active ${overview.totals.active}, paused ${overview.totals.paused}, stopped ${overview.totals.stopped}) — showing ${overview.totals.displayed}`,
  );
  lines.push("");

  if (overview.cards.length === 0) {
    lines.push("No target is displayed for this deployment.");
  }

  const constantReasons = new Set(overview.refusals.map((refusal) => refusal.reason));
  for (const card of overview.cards) {
    lines.push(`## @${card.target.username} — ${card.period.state}`);
    lines.push(
      [
        `status ${card.target.status}`,
        `mode ${card.target.observation_mode}`,
        card.target.is_private === true ? "private" : null,
        `last observed ${card.target.last_observed_at ?? "—"}`,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
    );
    lines.push(
      [
        ["new followings", card.kpis.new_followings],
        ["unfollows", card.kpis.un_follows],
        ["posts", card.kpis.posts],
        ["stories", card.kpis.stories],
        ["comments", card.kpis.comments],
        ["tags", card.kpis.tags],
        ["mentions", card.kpis.mentions],
      ]
        .map(([label, metricRow]) => {
          const entry = metricRow as ActivityMetric;
          return `${label as string} ${entry.value ?? "UNAVAILABLE"}`;
        })
        .join(" · "),
    );
    const specificAbsences = [
      card.kpis.new_followings,
      card.kpis.un_follows,
      card.kpis.posts,
      card.kpis.stories,
      card.kpis.comments,
      card.kpis.tags,
      card.kpis.mentions,
    ].filter(
      (metricRow) =>
        metricRow.state === "UNAVAILABLE" && !constantReasons.has(metricRow.reason ?? ""),
    );
    if (specificAbsences.length > 0) {
      lines.push("");
      lines.push("Unavailable for this card:");
      for (const metricRow of specificAbsences) {
        lines.push(`- ${metricRow.label}: ${metricRow.reason}`);
      }
    }
    lines.push("");
    lines.push(`Card: \`${card.commands.tracker}\``);
    lines.push("");
  }

  lines.push("## Unavailable by design");
  for (const refusal of overview.refusals) {
    lines.push(`- ${refusal.capability}: ${refusal.reason}`);
  }
  lines.push("");
  lines.push("## Evidence");
  lines.push(
    `Sources: ${overview.evidence.sourceIds.length === 0 ? "none attributed" : overview.evidence.sourceIds.join(", ")}`,
  );
  lines.push(`Class: ${overview.evidence.evidenceClass} — ${overview.evidence.note}`);
  lines.push("");
  lines.push(overview.note);
  lines.push("");
  return lines.join("\n");
}
