import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ABSENCE_REASONS,
  CAPABILITY_REGISTRY,
  activityBadge,
  activityDataId,
  activityReportId,
  activityWindow,
  buildActivityReport,
  enumerateActivityWindows,
  renderActivityReportMarkdown,
  type ActivityReportInput,
} from "../src/index.js";

// The contract being pinned: the four-tab Activity Report shape, rendered from
// rows IGTrack stored, with every structurally absent field a typed refusal
// instead of a zero. These tests are behavior tests: they assert what a caller
// sees, not how the composer is built.

const WINDOW = activityWindow("monthly", new Date("2026-08-14T12:00:00.000Z"));
const GENERATED = "2026-10-31T12:00:00.000Z";

function baseInput(): ActivityReportInput {
  return {
    target: {
      id: "target-1",
      username: "aurora.wilde",
      platformId: "17841400000000000",
      observationMode: "OWNED",
    },
    period: "monthly",
    window: WINDOW,
    generatedAt: GENERATED,
    evidence: {
      sourceIds: ["fixture@1"],
      evidenceClass: "SYNTHETIC",
      synthetic: true,
      note: "Synthetic fixture rows; not a live account observation.",
    },
    readable: {
      follows: { readable: true, reason: null },
      posts: { readable: true, reason: null },
      stories: { readable: true, reason: null },
      comments: { readable: true, reason: null },
      tags: { readable: true, reason: null },
    },
    followCoverage: {
      followers: { complete: 2, partial: 0, latestCompleteAt: "2026-08-20T00:00:00.000Z" },
      following: { complete: 3, partial: 1, latestCompleteAt: "2026-08-20T00:00:00.000Z" },
    },
    absence: { ...ACTIVITY_ABSENCE_REASONS },
    rows: {
      followDeltas: [
        { change: "NEW_FOLLOWING", username: "bob", at: "2026-08-05T10:00:00.000Z", evidenceId: "ev-1" },
        { change: "NEW_FOLLOWING", username: "carol", at: "2026-08-06T10:00:00.000Z", evidenceId: "ev-2" },
        { change: "LOST_FOLLOWING", username: "dave", at: "2026-08-07T10:00:00.000Z", evidenceId: "ev-3" },
      ],
      posts: [
        {
          id: "post-1",
          takenAt: "2026-08-06T09:00:00.000Z",
          caption: "sunset over the bay #goldenhour",
          mediaType: "IMAGE",
          likeCount: null,
          commentCount: null,
          evidenceId: "ev-4",
        },
      ],
      stories: [
        {
          id: "story-1",
          takenAt: "2026-08-07T09:00:00.000Z",
          mediaType: "IMAGE",
          expiresAt: "2026-08-08T09:00:00.000Z",
          evidenceId: "ev-5",
        },
      ],
      comments: [
        {
          id: "comment-1",
          commentedAt: "2026-08-08T09:00:00.000Z",
          authorUsername: "alice",
          postId: "post-1",
          body: "beautiful",
          evidenceId: "ev-6",
        },
        {
          id: "comment-2",
          commentedAt: "2026-08-09T09:00:00.000Z",
          authorUsername: "alice",
          postId: "post-1",
          body: "again",
          evidenceId: "ev-7",
        },
      ],
      mentions: [],
      tags: [],
    },
    trail: {
      sinceDate: "2026-06-01T00:00:00.000Z",
      completeRosterSnapshots: 3,
      buckets: [
        {
          bucket: "2026-06-01",
          newFollowing: 1,
          lostFollowing: 0,
          newFollowers: 0,
          lostFollowers: 0,
          posts: 1,
          stories: 0,
          comments: 0,
          tags: 0,
          mentions: 0,
          profileSnapshots: 2,
          insights: 0,
          completeFollowingSnapshots: 2,
          total: 2,
          topCommenter: null,
        },
        {
          bucket: "2026-07-01",
          newFollowing: 1,
          lostFollowing: 0,
          newFollowers: 0,
          lostFollowers: 0,
          posts: 1,
          stories: 0,
          comments: 2,
          tags: 0,
          mentions: 0,
          profileSnapshots: 2,
          insights: 1,
          completeFollowingSnapshots: 2,
          total: 4,
          topCommenter: { username: "alice", count: 2 },
        },
        {
          bucket: "2026-08-01",
          newFollowing: 1,
          lostFollowing: 1,
          newFollowers: 0,
          lostFollowers: 0,
          posts: 1,
          stories: 1,
          comments: 2,
          tags: 0,
          mentions: 0,
          profileSnapshots: 2,
          insights: 1,
          completeFollowingSnapshots: 1,
          total: 6,
          topCommenter: { username: "alice", count: 2 },
        },
      ],
      monthCounts: { newFollowing: 1, lostFollowing: 1, posts: 1 },
      completeRosterBeforeMonth: 2,
      completeRosterInMonth: 1,
      topCommenters: [{ username: "alice", count: 2 }],
      topMentioned: [],
      captions: ["sunset over the bay #goldenhour"],
      captionRows: 1,
      recentComments: [
        {
          id: "comment-2",
          username: "alice",
          body: "again",
          commentedAt: "2026-08-09T09:00:00.000Z",
          likeCount: null,
          postId: "post-1",
          evidenceId: "ev-7",
        },
      ],
      followingRosterSize: 42,
    },
    inventory: [
      { window: activityWindow("monthly", new Date("2026-06-15T00:00:00.000Z")), eventCount: 2 },
      { window: activityWindow("monthly", new Date("2026-07-15T00:00:00.000Z")), eventCount: 4 },
      { window: activityWindow("monthly", new Date("2026-08-15T00:00:00.000Z")), eventCount: 6 },
      { window: activityWindow("monthly", new Date("2026-09-15T00:00:00.000Z")), eventCount: 0 },
    ],
    inventoryNote: "Periods are enumerated backwards from the run time in UTC month units.",
  };
}

function registryReason(id: string): string {
  const entry = CAPABILITY_REGISTRY.find((candidate) => candidate.id === id);
  if (entry === undefined || entry.whyUnavailable === null) {
    throw new Error(`registry entry ${id} must exist and be unavailable`);
  }
  return entry.whyUnavailable;
}

describe("activity report windows", () => {
  it("derives UTC boundaries for all five period types", () => {
    const daily = activityWindow("daily", new Date("2026-08-14T23:30:00.000Z"));
    expect(daily.start).toBe("2026-08-14T00:00:00.000Z");
    expect(daily.end).toBe("2026-08-15T00:00:00.000Z");
    expect(daily.label).toBe("2026-08-14");
    expect(daily.dataType).toBe("DAILY");

    const weekly = activityWindow("weekly", new Date("2026-08-14T12:00:00.000Z"));
    expect(weekly.start).toBe("2026-08-10T00:00:00.000Z");
    expect(weekly.end).toBe("2026-08-17T00:00:00.000Z");
    expect(weekly.label).toBe("2026-W33");
    expect(weekly.dataType).toBe("WEEK");

    const monthly = activityWindow("monthly", new Date("2026-08-14T12:00:00.000Z"));
    expect(monthly.start).toBe("2026-08-01T00:00:00.000Z");
    expect(monthly.end).toBe("2026-09-01T00:00:00.000Z");
    expect(monthly.label).toBe("2026-08");
    expect(monthly.dataType).toBe("MONTH");

    const quarterly = activityWindow("quarterly", new Date("2026-08-14T12:00:00.000Z"));
    expect(quarterly.start).toBe("2026-07-01T00:00:00.000Z");
    expect(quarterly.end).toBe("2026-10-01T00:00:00.000Z");
    expect(quarterly.label).toBe("2026-Q3");
    expect(quarterly.dataType).toBe("SEASON");

    const yearly = activityWindow("yearly", new Date("2026-08-14T12:00:00.000Z"));
    expect(yearly.start).toBe("2026-01-01T00:00:00.000Z");
    expect(yearly.end).toBe("2027-01-01T00:00:00.000Z");
    expect(yearly.label).toBe("2026");
    expect(yearly.dataType).toBe("YEAR");
  });

  it("enumerates periods backwards without crossing the ledger start", () => {
    const windows = enumerateActivityWindows(
      "monthly",
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-08-14T12:00:00.000Z"),
      12,
    );
    expect(windows.map((window) => window.label)).toEqual(["2026-08", "2026-07", "2026-06"]);
  });

  it("uses the audited badge mapping and stable period ids", () => {
    expect(activityBadge("daily")).toBe("Beta");
    expect(activityBadge("weekly")).toBeNull();
    expect(activityBadge("monthly")).toBe("Monthly Report");
    expect(activityBadge("quarterly")).toBe("Quarterly Report");
    expect(activityBadge("yearly")).toBe("Year Report");

    const report = buildActivityReport(baseInput());
    expect(report.data_id).toBe("igtrack:target-1:monthly:2026-08-01T00:00:00.000Z");
    expect(report.report_id).toBe("igtrack-report:target-1:monthly:2026-08-01T00:00:00.000Z");
    expect(activityDataId("target-1", WINDOW)).toBe(report.data_id);
    expect(activityReportId("target-1", WINDOW)).toBe(report.report_id);
  });
});

describe("activity report contract", () => {
  it("keeps the four tabs in order", () => {
    const report = buildActivityReport(baseInput());
    expect(Object.keys(report.tabs)).toEqual([
      "activity_analytics",
      "ties_and_trails",
      "stories_highlights",
      "ai_insights",
    ]);
    expect(report.feature).toBe("igtrack.activity-report");
    expect(report.adaptation).toBe("igtrack-cli");
    expect(report.data_type).toBe("MONTH");
    expect(report.media_name).toBe("aurora.wilde");
  });

  it("marks the period inventory with badges, states, ids and compose commands", () => {
    const report = buildActivityReport(baseInput());
    expect(report.periods).toHaveLength(4);
    expect(report.periods.map((entry) => entry.label)).toEqual([
      "2026-09",
      "2026-08",
      "2026-07",
      "2026-06",
    ]);
    const august = report.periods.find((entry) => entry.label === "2026-08");
    expect(august).toMatchObject({
      data_type: "MONTH",
      has_data: true,
      state: "DELIVERED",
      event_count: 6,
      badge: "Monthly Report",
      selected: true,
    });
    expect(august?.command).toBe("igtrack activity-report @aurora.wilde --period monthly --at 2026-08-01");
    const september = report.periods.find((entry) => entry.label === "2026-09");
    expect(september).toMatchObject({ has_data: false, state: "EMPTY", event_count: 0 });
    expect(report.period_state).toBe("DELIVERED");
    expect(report.has_data).toBe(true);
  });

  it("counts reports delivered as closed non-daily periods with stored rows", () => {
    const input = baseInput();
    input.inventory.push({
      window: activityWindow("daily", new Date("2026-08-14T00:00:00.000Z")),
      eventCount: 5,
    });
    const report = buildActivityReport(input);
    expect(report.periods.some((entry) => entry.data_type === "DAILY" && entry.has_data)).toBe(true);
    expect(report.reports_delivered).toBe(3);
    expect(report.task_num).toBe(3);
  });

  it("refuses every structurally absent field instead of zeroing it", () => {
    const report = buildActivityReport(baseInput());
    const analytics = report.tabs.activity_analytics;
    for (const metric of [
      analytics.like_num,
      analytics.like_pic_num,
      analytics.like_video_num,
      analytics.like_acct_num,
      analytics.like_acct_verify_num,
      analytics.like_user_num,
      analytics.like_avg_per_user_num,
      analytics.like_user_verify_num,
      analytics.highlights_num,
    ]) {
      expect(metric.value).toBeNull();
      expect(metric.state).toBe("UNAVAILABLE");
      expect(metric.reason).not.toBeNull();
    }
    expect(analytics.like_num.reason).toBe(ACTIVITY_ABSENCE_REASONS.likes);
    expect(analytics.highlights_num.reason).toBe(ACTIVITY_ABSENCE_REASONS.highlights);
    expect(analytics.like_ranks).toEqual({
      state: "UNAVAILABLE",
      reason: ACTIVITY_ABSENCE_REASONS.likes,
      rows: [],
    });

    const trails = report.tabs.ties_and_trails;
    expect(trails.totals.like_data.total).toMatchObject({
      value: null,
      state: "UNAVAILABLE",
      reason: ACTIVITY_ABSENCE_REASONS.likes,
    });
    expect(trails.totals.like_data.month_new).toMatchObject({ value: null, state: "UNAVAILABLE" });
    expect(trails.connection_counts.total_like_num!.value).toBeNull();
    expect(trails.connection_counts.verify_followed_num!.value).toBeNull();
    expect(trails.interest_tags).toEqual({
      state: "UNAVAILABLE",
      reason: ACTIVITY_ABSENCE_REASONS.interestTags,
      rows: [],
    });
    expect(trails.top_content.places_visited.state).toBe("UNAVAILABLE");

    const stories = report.tabs.stories_highlights;
    expect(stories.new_highlights).toMatchObject({
      state: "UNAVAILABLE",
      reason: ACTIVITY_ABSENCE_REASONS.highlights,
    });
    expect(stories.old_highlights.state).toBe("UNAVAILABLE");

    const insights = report.tabs.ai_insights;
    expect(insights).toMatchObject({
      has_insights: false,
      state: "UNAVAILABLE",
      status: "UNAVAILABLE",
      sub_type: "NOT_APPLICABLE",
    });
    expect(insights.reason).toBe(ACTIVITY_ABSENCE_REASONS.aiInsights);
  });

  it("pins the absence reasons to the capability registry", () => {
    expect(ACTIVITY_ABSENCE_REASONS.likes).toBe(registryReason("LIKES"));
    expect(ACTIVITY_ABSENCE_REASONS.highlights).toBe(registryReason("HIGHLIGHTS"));
    expect(ACTIVITY_ABSENCE_REASONS.interactions).toBe(registryReason("INTERACTIONS"));
    expect(ACTIVITY_ABSENCE_REASONS.aiInsights).toBe(registryReason("AI_INSIGHTS"));
  });

  it("derives follows, totals and the timeline only from observed rows", () => {
    const report = buildActivityReport(baseInput());
    const analytics = report.tabs.activity_analytics;
    expect(analytics.following_num).toMatchObject({ value: 2, state: "DERIVED" });
    expect(analytics.un_follow_num).toMatchObject({ value: 1, state: "DERIVED" });
    expect(analytics.post_num.value).toBe(1);
    expect(analytics.story_num.value).toBe(1);
    expect(analytics.comment_num.value).toBe(2);
    expect(analytics.comment_ranks.rows).toEqual([{ username: "alice", count: 2 }]);
    expect(analytics.social_platforms.value).toBeNull();
    expect(analytics.social_platforms.state).toBe("UNAVAILABLE");
    expect(analytics.post_list.state).toBe("DERIVED");
    expect(analytics.post_list.rows[0]?.media_url).toBeNull();
    expect(analytics.post_list.rows[0]?.media_url_state).toBe("UNAVAILABLE");

    const trails = report.tabs.ties_and_trails;
    expect(trails.totals.followed_data.total).toMatchObject({ value: 3, state: "DERIVED" });
    expect(trails.totals.unfollowed_data.total).toMatchObject({ value: 1, state: "DERIVED" });
    expect(trails.totals.followed_data.month_new).toMatchObject({ value: 1, state: "DERIVED" });
    expect(trails.totals.unfollowed_data.month_new).toMatchObject({ value: 1, state: "DERIVED" });
    expect(trails.totals.post_data.total).toMatchObject({ value: 3, state: "DERIVED" });
    expect(trails.totals.post_data.month_new.value).toBe(1);
    expect(trails.media_tags.state).toBe("DERIVED");
    expect(trails.media_tags.rows.map((row) => row.term)).toContain("goldenhour");

    expect(trails.timeline_total).toBe(3);
    expect(trails.timeline_non_empty).toBe(3);
    expect(trails.timeline.map((entry) => entry.period.label)).toEqual([
      "2026-08",
      "2026-07",
      "2026-06",
    ]);
    expect(trails.timeline[0]?.period.data_id).toBe("igtrack:target-1:monthly:2026-08-01T00:00:00.000Z");
    expect(trails.timeline[0]?.posts.count).toBe(1);
    expect(trails.timeline[0]?.most_comments).toMatchObject({
      count: 2,
      username: "alice",
      state: "DERIVED",
    });
    expect(trails.timeline[0]?.most_likes).toMatchObject({
      count: null,
      state: "UNAVAILABLE",
      reason: ACTIVITY_ABSENCE_REASONS.likes,
    });
    expect(trails.timeline.every((entry) => entry.provisional === false)).toBe(true);
    expect(trails.timeline.every((entry) => entry.can_open)).toBe(true);
  });

  it("refuses follow metrics and month counts when no COMPLETE roster pair exists", () => {
    const input = baseInput();
    input.followCoverage.following = { complete: 0, partial: 3, latestCompleteAt: null };
    input.trail.completeRosterSnapshots = 0;
    input.trail.completeRosterBeforeMonth = 0;
    input.trail.completeRosterInMonth = 0;
    input.trail.monthCounts = { newFollowing: 0, lostFollowing: 0, posts: 1 };
    for (const bucket of input.trail.buckets) {
      bucket.newFollowing = 0;
      bucket.lostFollowing = 0;
      bucket.completeFollowingSnapshots = 0;
    }
    input.rows.followDeltas = [];
    const report = buildActivityReport(input);
    const trails = report.tabs.ties_and_trails;
    expect(trails.totals.followed_data.total.value).toBeNull();
    expect(trails.totals.followed_data.total.state).toBe("UNAVAILABLE");
    expect(trails.totals.followed_data.total.reason).not.toBeNull();
    expect(trails.totals.unfollowed_data.total.value).toBeNull();
    expect(trails.totals.followed_data.month_new.value).toBeNull();
    expect(trails.totals.followed_data.month_new.state).toBe("UNAVAILABLE");
    for (const entry of trails.timeline) {
      expect(entry.follows.count).toBeNull();
      expect(entry.follows.state).toBe("UNAVAILABLE");
      expect(entry.unfollows.count).toBeNull();
    }
    expect(report.tabs.activity_analytics.following_num.value).toBeNull();
    expect(report.tabs.activity_analytics.following_num.state).toBe("UNAVAILABLE");
  });

  it("never prints a zero for a period that has not closed", () => {
    const input = baseInput();
    const openWindow = activityWindow("monthly", new Date("2026-09-14T12:00:00.000Z"));
    input.period = "monthly";
    input.window = openWindow;
    input.generatedAt = "2026-09-15T12:00:00.000Z";
    input.inventory = [
      { window: activityWindow("monthly", new Date("2026-08-15T00:00:00.000Z")), eventCount: 6 },
      { window: openWindow, eventCount: 0 },
    ];
    input.trail.buckets = [
      {
        bucket: "2026-08-01",
        newFollowing: 1,
        lostFollowing: 0,
        newFollowers: 0,
        lostFollowers: 0,
        posts: 1,
        stories: 0,
        comments: 0,
        tags: 0,
        mentions: 0,
        profileSnapshots: 1,
        insights: 0,
        completeFollowingSnapshots: 1,
        total: 2,
        topCommenter: null,
      },
      {
        bucket: "2026-09-01",
        newFollowing: 0,
        lostFollowing: 0,
        newFollowers: 0,
        lostFollowers: 0,
        posts: 0,
        stories: 0,
        comments: 0,
        tags: 0,
        mentions: 0,
        profileSnapshots: 0,
        insights: 0,
        completeFollowingSnapshots: 0,
        total: 0,
        topCommenter: null,
      },
    ];
    input.rows = { followDeltas: [], posts: [], stories: [], comments: [], mentions: [], tags: [] };
    input.trail.monthCounts = { newFollowing: 0, lostFollowing: 0, posts: 0 };
    input.trail.completeRosterBeforeMonth = 1;
    input.trail.completeRosterInMonth = 0;
    input.trail.topCommenters = [];
    input.trail.captions = [];
    input.trail.captionRows = 0;
    input.trail.recentComments = [];

    const report = buildActivityReport(input);
    const september = report.periods.find((entry) => entry.label === "2026-09");
    expect(september?.state).toBe("IN_PROGRESS");
    expect(report.period_state).toBe("IN_PROGRESS");

    const open = report.tabs.ties_and_trails.timeline.find((entry) => entry.period.label === "2026-09");
    if (open === undefined) throw new Error("expected an open 2026-09 timeline entry");
    expect(open.provisional).toBe(true);
    expect(open.total_events).toBeNull();
    expect(open.posts.count).toBeNull();
    expect(open.posts.state).toBe("UNAVAILABLE");
    expect(open.stories.count).toBeNull();
    expect(open.follows.count).toBeNull();
    expect(open.most_comments.count).toBeNull();
    expect(open.state).toBe("UNAVAILABLE");

    // A pending period with observed rows keeps the partial count, labelled.
    const partial = baseInput();
    partial.window = openWindow;
    partial.generatedAt = "2026-09-15T12:00:00.000Z";
    partial.inventory = [{ window: openWindow, eventCount: 2 }];
    partial.trail.buckets = [
      {
        ...input.trail.buckets[1]!,
        posts: 2,
        completeFollowingSnapshots: 1,
        total: 2,
      },
    ];
    partial.trail.monthCounts = { newFollowing: 0, lostFollowing: 0, posts: 2 };
    partial.rows = { ...partial.rows, followDeltas: [] };
    const partialReport = buildActivityReport(partial);
    const pending = partialReport.tabs.ties_and_trails.timeline[0];
    expect(pending?.provisional).toBe(true);
    expect(pending?.posts.count).toBe(2);
    expect(pending?.posts.state).toBe("OBSERVED");
  });

  it("keeps an unreadable family UNAVAILABLE with its source reason", () => {
    const input = baseInput();
    input.readable.posts = { readable: false, reason: "No post source is configured." };
    input.rows.posts = [];
    input.trail.captions = [];
    input.trail.captionRows = 0;
    input.trail.buckets = input.trail.buckets.map((bucket) => ({ ...bucket, posts: 0 }));
    input.trail.monthCounts = { ...input.trail.monthCounts, posts: 0 };
    const report = buildActivityReport(input);
    const analytics = report.tabs.activity_analytics;
    expect(analytics.post_num).toMatchObject({
      value: null,
      state: "UNAVAILABLE",
      reason: "No post source is configured.",
    });
    expect(analytics.post_list.state).toBe("UNAVAILABLE");
    const trails = report.tabs.ties_and_trails;
    expect(trails.totals.post_data.total.value).toBeNull();
    expect(trails.totals.post_data.month_new.value).toBeNull();
    expect(trails.timeline.every((entry) => entry.posts.count === null)).toBe(true);
    expect(trails.media_tags.state).toBe("UNAVAILABLE");
  });

  it("disables story requests for daily periods", () => {
    const input = baseInput();
    const daily = activityWindow("daily", new Date("2026-08-14T12:00:00.000Z"));
    input.period = "daily";
    input.window = daily;
    input.inventory = [{ window: daily, eventCount: 1 }];
    const report = buildActivityReport(input);
    expect(report.data_type).toBe("DAILY");
    expect(report.periods[0]?.badge).toBe("Beta");
    expect(report.tabs.stories_highlights.enabled).toBe(false);
    expect(report.tabs.stories_highlights.report_id).toBe(
      "igtrack-report:target-1:daily:2026-08-14T00:00:00.000Z",
    );
  });

  it("emits a download command, never a server URL", () => {
    const report = buildActivityReport(baseInput());
    expect(report.tabs.activity_analytics.download).toMatchObject({
      kind: "COMMAND",
      url: null,
      state: "OBSERVED",
    });
    expect(report.tabs.activity_analytics.download.command).toContain("igtrack export @aurora.wilde");
  });

  it("labels synthetic evidence in both JSON and Markdown", () => {
    const report = buildActivityReport(baseInput());
    expect(report.evidence).toMatchObject({
      evidenceClass: "SYNTHETIC",
      synthetic: true,
    });
    const markdown = renderActivityReportMarkdown(report);
    expect(markdown).toContain("SYNTHETIC DATA");
  });
});

describe("activity report markdown", () => {
  it("renders byte-identically for the same input", () => {
    const first = renderActivityReportMarkdown(buildActivityReport(baseInput()));
    const second = renderActivityReportMarkdown(buildActivityReport(baseInput()));
    expect(first).toBe(second);
  });

  it("renders the four tabs in order and can filter to one", () => {
    const report = buildActivityReport(baseInput());
    const markdown = renderActivityReportMarkdown(report);
    const analyticsAt = markdown.indexOf("## Activity Analytics");
    const trailsAt = markdown.indexOf("## Ties & Trails");
    const storiesAt = markdown.indexOf("## Stories & Highlights");
    const insightsAt = markdown.indexOf("## AI Insights");
    expect(analyticsAt).toBeGreaterThan(-1);
    expect(trailsAt).toBeGreaterThan(analyticsAt);
    expect(storiesAt).toBeGreaterThan(trailsAt);
    expect(insightsAt).toBeGreaterThan(storiesAt);

    const analyticsOnly = renderActivityReportMarkdown(report, { tab: "analytics" });
    expect(analyticsOnly).toContain("## Activity Analytics");
    expect(analyticsOnly).not.toContain("## Ties & Trails");
    expect(analyticsOnly).not.toContain("## AI Insights");
    expect(analyticsOnly).toContain("## Period inventory");
  });

  it("bounds the printed timeline while keeping complete counts", () => {
    const markdown = renderActivityReportMarkdown(buildActivityReport(baseInput()), {
      timelineLimit: 1,
    });
    expect(markdown).toContain("Showing 1 of 3 period(s); the counts above are complete.");
    expect(markdown).toContain("3 period(s), 3 with activity.");
  });

  it("prints UNAVAILABLE with its reason, never a zero, for absent metrics", () => {
    const markdown = renderActivityReportMarkdown(buildActivityReport(baseInput()));
    expect(markdown).toContain("| likes given | UNAVAILABLE");
    expect(markdown).toContain("| highlights | UNAVAILABLE");
    expect(markdown).toContain("New highlights: UNAVAILABLE");
    expect(markdown).toContain("AI-insight provider");
    expect(markdown).toContain("Places visited: UNAVAILABLE");
  });
});
