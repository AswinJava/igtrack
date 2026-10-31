import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ABSENCE_REASONS,
  ACTIVITY_DATA_TYPES,
  activityWindow,
} from "../src/activity-report.js";
import {
  buildTrackerCard,
  buildTrackerOverview,
  latestClosedActivityWindow,
  renderTrackerCardMarkdown,
  renderTrackerOverviewMarkdown,
  trackerEvidenceNote,
  trackerNextScan,
  trackerWindow,
  TRACKER_EMAIL_ABSENCE_REASON,
  type TrackerCardInput,
} from "../src/tracker.js";

const WINDOW = activityWindow("weekly", new Date("2026-08-26T12:00:00.000Z"));
const GENERATED_AT = "2026-09-02T12:00:00.000Z";

function baseInput(overrides: Partial<TrackerCardInput> = {}): TrackerCardInput {
  return {
    target: {
      id: "target-1",
      username: "aurora.wilde",
      localName: "Fixture account",
      observationMode: "DISCOVERY",
      status: "ACTIVE",
      isPrivate: false,
      trackingSince: "2026-08-01T00:00:00.000Z",
      lastObservedAt: "2026-08-27T09:15:00.000Z",
      latestJob: {
        status: "succeeded",
        outcome: "OK",
        completedAt: "2026-08-27T09:15:00.000Z",
        availableAt: null,
      },
    },
    period: "weekly",
    window: WINDOW,
    generatedAt: GENERATED_AT,
    evidence: {
      sourceIds: ["fixture:v1"],
      evidenceClass: "SYNTHETIC",
      synthetic: true,
      note: trackerEvidenceNote("SYNTHETIC"),
    },
    readable: {
      follows: { readable: true, reason: null },
      posts: { readable: true, reason: null },
      stories: { readable: true, reason: null },
      comments: { readable: true, reason: null },
      tags: { readable: true, reason: null },
    },
    followCoverage: {
      followers: { complete: 0, partial: 0, latestCompleteAt: null },
      following: { complete: 0, partial: 0, latestCompleteAt: null },
    },
    absence: ACTIVITY_ABSENCE_REASONS,
    rows: {
      followDeltas: [],
      posts: [],
      stories: [],
      comments: [],
      mentions: [],
      tags: [],
    },
    ...overrides,
  };
}

describe("tracker window selection", () => {
  it("selects the latest closed window, not the window containing now", () => {
    const now = new Date("2026-08-26T12:00:00.000Z");
    const weekly = latestClosedActivityWindow("weekly", now);
    expect(weekly.start).toBe("2026-08-17T00:00:00.000Z");
    expect(weekly.end).toBe("2026-08-24T00:00:00.000Z");
    expect(weekly.label).toBe("2026-W34");

    const daily = latestClosedActivityWindow("daily", now);
    expect(daily.start).toBe("2026-08-25T00:00:00.000Z");
    expect(daily.end).toBe("2026-08-26T00:00:00.000Z");

    const monthly = latestClosedActivityWindow("monthly", now);
    expect(monthly.start).toBe("2026-07-01T00:00:00.000Z");
    expect(monthly.end).toBe("2026-08-01T00:00:00.000Z");
  });

  it("treats a boundary instant as belonging to the window that just opened", () => {
    const mondayMidnight = new Date("2026-08-24T00:00:00.000Z");
    expect(activityWindow("weekly", mondayMidnight).start).toBe("2026-08-24T00:00:00.000Z");
    expect(latestClosedActivityWindow("weekly", mondayMidnight).start).toBe(
      "2026-08-17T00:00:00.000Z",
    );
  });

  it("keeps an explicit --at window even when it has not closed", () => {
    const now = new Date("2026-09-10T00:00:00.000Z");
    const selected = trackerWindow("weekly", {
      at: new Date("2026-08-26T12:00:00.000Z"),
      explicitAt: true,
      now,
    });
    expect(selected.start).toBe("2026-08-24T00:00:00.000Z");
    expect(selected.end).toBe("2026-08-31T00:00:00.000Z");
  });
});

describe("tracker card", () => {
  it("never prints a zero for follow movement without a COMPLETE roster comparison", () => {
    const card = buildTrackerCard(baseInput());
    expect(card.kpis.new_followings.value).toBeNull();
    expect(card.kpis.new_followings.state).toBe("UNAVAILABLE");
    expect(card.kpis.new_followings.reason).toContain("No COMPLETE following roster");
    expect(card.kpis.un_follows.value).toBeNull();
    expect(card.new_followings.state).toBe("UNAVAILABLE");
    expect(card.new_followings.rows).toEqual([]);
    expect(card.period.state).toBe("EMPTY");
  });

  it("prints a measured zero only when a COMPLETE following roster was compared", () => {
    const card = buildTrackerCard(
      baseInput({
        followCoverage: {
          followers: { complete: 1, partial: 0, latestCompleteAt: GENERATED_AT },
          following: { complete: 1, partial: 0, latestCompleteAt: GENERATED_AT },
        },
      }),
    );
    expect(card.kpis.new_followings.value).toBe(0);
    expect(card.kpis.new_followings.state).toBe("DERIVED");
    expect(card.kpis.un_follows.value).toBe(0);
    expect(card.kpis.un_follows.state).toBe("DERIVED");
    expect(card.new_followings.state).toBe("DERIVED");
    expect(card.new_followings.rows).toEqual([]);
  });

  it("counts stored rows and keeps rosters newest-first with evidence ids", () => {
    const card = buildTrackerCard(
      baseInput({
        rows: {
          followDeltas: [
            {
              change: "NEW_FOLLOWING",
              username: "older.friend",
              at: "2026-08-25T08:00:00.000Z",
              evidenceId: "ev-new-1",
            },
            {
              change: "NEW_FOLLOWING",
              username: "newer.friend",
              at: "2026-08-26T08:00:00.000Z",
              evidenceId: "ev-new-2",
            },
            {
              change: "LOST_FOLLOWING",
              username: "gone.friend",
              at: "2026-08-24T08:00:00.000Z",
              evidenceId: "ev-lost-1",
            },
          ],
          posts: [
            {
              id: "post-1",
              takenAt: "2026-08-25T12:00:00.000Z",
              caption: "Fjord light #fjord #nordic",
              mediaType: "IMAGE",
              likeCount: 842,
              commentCount: 37,
              evidenceId: "ev-post-1",
            },
            {
              id: "post-2",
              takenAt: "2026-08-26T12:00:00.000Z",
              caption: "Behind the scenes #behind",
              mediaType: "IMAGE",
              likeCount: 610,
              commentCount: 12,
              evidenceId: "ev-post-2",
            },
          ],
          stories: [],
          comments: [
            {
              id: "comment-1",
              commentedAt: "2026-08-25T13:00:00.000Z",
              authorUsername: "noah.frames",
              postId: "post-1",
              body: "Beautiful light",
              likeCount: 4,
              evidenceId: "ev-comment-1",
            },
            {
              id: "comment-2",
              commentedAt: "2026-08-26T09:00:00.000Z",
              authorUsername: "mira.lens",
              postId: "post-2",
              body: "Love this\nframe",
              likeCount: null,
              evidenceId: "ev-comment-2",
            },
          ],
          mentions: [],
          tags: [
            {
              id: "tag-1",
              observedAt: "2026-08-25T18:00:00.000Z",
              ownerUsername: "saga.pixel",
              mediaId: "media-1",
              evidenceId: "ev-tag-1",
            },
          ],
        },
      }),
    );

    expect(card.kpis.new_followings.value).toBe(2);
    expect(card.kpis.new_followings.state).toBe("DERIVED");
    expect(card.kpis.new_followings.evidenceIds).toEqual(["ev-new-1", "ev-new-2"]);
    expect(card.new_followings.rows.map((row) => row.username)).toEqual([
      "newer.friend",
      "older.friend",
    ]);
    expect(card.kpis.un_follows.value).toBe(1);
    expect(card.un_follows.rows[0]).toEqual({
      username: "gone.friend",
      observed_at: "2026-08-24T08:00:00.000Z",
      evidence_id: "ev-lost-1",
    });
    expect(card.kpis.posts.value).toBe(2);
    expect(card.posts.rows.map((row) => row.id)).toEqual(["post-2", "post-1"]);
    expect(card.posts.rows[0]?.media_url).toBeNull();
    expect(card.posts.rows[0]?.media_url_state).toBe("UNAVAILABLE");
    expect(card.kpis.comments.value).toBe(2);
    expect(card.kpis.tags.value).toBe(1);
    expect(card.recent_comments.rows.map((row) => row.id)).toEqual(["comment-2", "comment-1"]);
    expect(card.recent_comments.rows[0]?.like_count).toBeNull();
    expect(card.recent_comments.like_count_note).toContain("not that it had zero likes");
    expect(card.top_commenters.rows).toEqual([
      { username: "mira.lens", count: 1 },
      { username: "noah.frames", count: 1 },
    ]);
    expect(card.hashtags.state).toBe("DERIVED");
    expect(card.hashtags.rows).toEqual([
      { term: "behind", count: 1 },
      { term: "fjord", count: 1 },
      { term: "nordic", count: 1 },
    ]);
    expect(card.period.state).toBe("DELIVERED");
    expect(card.period.has_data).toBe(true);
    expect(card.period.provisional).toBe(false);
  });

  it("keeps an unreadable family UNAVAILABLE with its reason instead of empty", () => {
    const card = buildTrackerCard(
      baseInput({
        readable: {
          follows: { readable: false, reason: "No follow roster edge." },
          posts: { readable: false, reason: "No media listing edge." },
          stories: { readable: false, reason: "No story tray edge." },
          comments: { readable: false, reason: "No comment listing edge." },
          tags: { readable: false, reason: "No tags edge." },
        },
      }),
    );
    expect(card.kpis.posts.value).toBeNull();
    expect(card.kpis.posts.state).toBe("UNAVAILABLE");
    expect(card.kpis.posts.reason).toBe("No media listing edge.");
    expect(card.kpis.stories.value).toBeNull();
    expect(card.kpis.comments.value).toBeNull();
    expect(card.kpis.tags.value).toBeNull();
    expect(card.kpis.mentions.value).toBeNull();
    expect(card.kpis.new_followings.value).toBeNull();
    expect(card.period.state).toBe("UNAVAILABLE");
    expect(card.hashtags.state).toBe("UNAVAILABLE");
  });

  it("refuses likes, highlights, verified followings, AI insights, platforms, places and email", () => {
    const card = buildTrackerCard(baseInput());
    expect(card.kpis.accounts_liked.value).toBeNull();
    expect(card.kpis.accounts_liked.state).toBe("UNAVAILABLE");
    expect(card.kpis.accounts_liked.reason).toBe(ACTIVITY_ABSENCE_REASONS.likes);
    expect(card.kpis.highlights.value).toBeNull();
    expect(card.kpis.highlights.reason).toBe(ACTIVITY_ABSENCE_REASONS.highlights);
    expect(card.kpis.verified_follows.value).toBeNull();
    expect(card.kpis.verified_follows.reason).toBe(ACTIVITY_ABSENCE_REASONS.verified);
    expect(card.ai_insights).toEqual({
      has_insights: false,
      state: "UNAVAILABLE",
      reason: ACTIVITY_ABSENCE_REASONS.aiInsights,
      sub_type: "NOT_APPLICABLE",
    });
    expect(card.refusals.map((refusal) => refusal.capability)).toEqual([
      "ACCOUNTS_LIKED",
      "HIGHLIGHTS",
      "VERIFIED_FOLLOWS",
      "AI_INSIGHTS",
      "EXTERNAL_PLATFORMS",
      "PLACES",
      "EMAIL_DELIVERY",
    ]);
    expect(card.refusals.at(-1)?.reason).toBe(TRACKER_EMAIL_ABSENCE_REASON);
    expect(card.delivery.email).toBeNull();
    expect(card.delivery.email_state).toBe("UNAVAILABLE");
  });

  it("marks an open window IN_PROGRESS and does not present partial zeros as final", () => {
    const openWindow = activityWindow("weekly", new Date("2026-08-26T12:00:00.000Z"));
    const card = buildTrackerCard(
      baseInput({
        window: openWindow,
        generatedAt: "2026-08-26T13:00:00.000Z",
      }),
    );
    expect(card.period.state).toBe("IN_PROGRESS");
    expect(card.period.provisional).toBe(true);
    expect(card.period.has_data).toBe(false);
    expect(card.note).toContain("has not closed");
  });

  it("uses the same data ids and commands as the activity report", () => {
    const card = buildTrackerCard(baseInput());
    expect(card.period.data_type).toBe(ACTIVITY_DATA_TYPES.weekly);
    expect(card.period.data_id).toBe(
      "igtrack:target-1:weekly:2026-08-24T00:00:00.000Z",
    );
    expect(card.period.report_id).toBe(
      "igtrack-report:target-1:weekly:2026-08-24T00:00:00.000Z",
    );
    expect(card.commands.activity_report).toBe(
      "igtrack activity-report @aurora.wilde --period weekly --at 2026-08-24",
    );
    expect(card.commands.tracker).toBe(
      "igtrack tracker @aurora.wilde --period weekly --at 2026-08-24",
    );
    expect(card.delivery.digest_command).toBe(
      "igtrack digest @aurora.wilde --since 2026-08-24",
    );
  });

  it("derives next_scan only from a pending job and refuses to invent one", () => {
    expect(
      trackerNextScan({
        status: "queued",
        outcome: null,
        completedAt: null,
        availableAt: "2026-09-02T13:00:00.000Z",
      }),
    ).toMatchObject({ state: "SCHEDULED", at: "2026-09-02T13:00:00.000Z" });

    const noJob = trackerNextScan({
      status: null,
      outcome: null,
      completedAt: null,
      availableAt: null,
    });
    expect(noJob.state).toBe("UNAVAILABLE");
    expect(noJob.at).toBeNull();
    expect(noJob.reason).toContain("No scan job");

    const finished = trackerNextScan({
      status: "succeeded",
      outcome: "OK",
      completedAt: "2026-08-27T09:15:00.000Z",
      availableAt: null,
    });
    expect(finished.state).toBe("UNAVAILABLE");
    expect(finished.reason).toContain("scheduler enqueues the next scan");
  });

  it("renders every refusal in Markdown and never presents an unavailable value as zero", () => {
    const card = buildTrackerCard(baseInput());
    const markdown = renderTrackerCardMarkdown(card);
    expect(markdown).toContain("@aurora.wilde");
    expect(markdown).toContain("| Accounts liked | UNAVAILABLE | UNAVAILABLE |");
    expect(markdown).toContain("ACCOUNTS_LIKED");
    expect(markdown).toContain("AI Insights");
    expect(markdown).toContain(card.ai_insights.reason);
    expect(markdown).toContain("Local only.");
    expect(markdown).toContain(card.commands.activity_report);
  });
});

describe("tracker overview", () => {
  it("projects list cards from full cards so the list and detail cannot disagree", () => {
    const card = buildTrackerCard(
      baseInput({
        rows: {
          followDeltas: [
            {
              change: "NEW_FOLLOWING",
              username: "newer.friend",
              at: "2026-08-26T08:00:00.000Z",
              evidenceId: "ev-new-1",
            },
          ],
          posts: [
            {
              id: "post-1",
              takenAt: "2026-08-25T12:00:00.000Z",
              caption: "Fjord light",
              mediaType: "IMAGE",
              likeCount: 842,
              commentCount: 37,
              evidenceId: "ev-post-1",
            },
          ],
          stories: [],
          comments: [],
          mentions: [],
          tags: [],
        },
      }),
    );
    const overview = buildTrackerOverview({
      period: card.period.period,
      window: WINDOW,
      generatedAt: GENERATED_AT,
      totals: { tracked: 2, active: 1, paused: 1, stopped: 0, displayed: 1 },
      cards: [card],
      evidence: card.evidence,
      refusals: card.refusals,
      note: "Watchlist note.",
    });

    expect(overview.mode).toBe("overview");
    expect(overview.cards).toHaveLength(1);
    const listCard = overview.cards[0]!;
    expect(listCard.kpis.new_followings).toEqual(card.kpis.new_followings);
    expect(listCard.kpis.posts).toEqual(card.kpis.posts);
    expect(listCard.period).toEqual(card.period);
    expect(listCard.commands.tracker).toBe(card.commands.tracker);
    expect(listCard.commands.activity_report).toBe(card.commands.activity_report);
    expect(listCard.target.status).toBe("ACTIVE");
    expect(overview.totals).toEqual({ tracked: 2, active: 1, paused: 1, stopped: 0, displayed: 1 });

    const markdown = renderTrackerOverviewMarkdown(overview);
    expect(markdown).toContain("Activity Tracker");
    expect(markdown).toContain("@aurora.wilde — DELIVERED");
    expect(markdown).toContain("new followings 1");
    expect(markdown).toContain("Unavailable by design");
    expect(markdown).toContain(card.commands.tracker);
    expect(markdown).not.toContain("accounts_liked 0");
  });
});
