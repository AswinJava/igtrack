import { describe, expect, it } from "vitest";
import {
  HIDDEN_MENTION_CLASSES,
  MediaType,
  MentionVisibilityClass,
  ObservationCategory,
  Confidence,
  aggregateMentionIntelligence,
  emptyMentionVisibilityCounts,
  isHiddenMentionVisibility,
  mentionObservationsFromStories,
  summarizeStoryMentions,
  type ObservationMeta,
  type NormalizedMention,
  type NormalizedStory,
} from "../src/index.js";

const meta: ObservationMeta = {
  category: ObservationCategory.OBSERVED,
  confidence: Confidence.HIGH,
  observedAt: "2026-01-01T00:00:00.000Z",
};

function mention(
  username: string,
  visibilityClass: MentionVisibilityClass,
  igId?: string,
): NormalizedMention {
  return {
    account: { username, ...(igId !== undefined ? { igId } : {}) },
    visibilityClass,
    meta,
  };
}

function story(storyId: string, mentions: NormalizedMention[]): NormalizedStory {
  return {
    storyId,
    mediaType: MediaType.IMAGE,
    takenAt: "2026-01-01T00:00:00.000Z",
    hasLink: false,
    stickerKinds: [],
    mentions,
    meta,
  };
}

describe("hidden-mention visibility classification", () => {
  it("treats POSSIBLY_HIDDEN, OFF_CANVAS and METADATA_ONLY as not-established-visible", () => {
    expect(HIDDEN_MENTION_CLASSES).toEqual([
      MentionVisibilityClass.POSSIBLY_HIDDEN,
      MentionVisibilityClass.OFF_CANVAS,
      MentionVisibilityClass.METADATA_ONLY,
    ]);
    expect(isHiddenMentionVisibility(MentionVisibilityClass.POSSIBLY_HIDDEN)).toBe(true);
    expect(isHiddenMentionVisibility(MentionVisibilityClass.OFF_CANVAS)).toBe(true);
    expect(isHiddenMentionVisibility(MentionVisibilityClass.METADATA_ONLY)).toBe(true);
  });

  it("never reclassifies VISIBLE or UNKNOWN as hidden", () => {
    // UNKNOWN means "no signal supplied". Counting it as hidden would turn
    // absence of evidence into a finding.
    expect(isHiddenMentionVisibility(MentionVisibilityClass.VISIBLE)).toBe(false);
    expect(isHiddenMentionVisibility(MentionVisibilityClass.UNKNOWN)).toBe(false);
  });
});

describe("summarizeStoryMentions", () => {
  it("counts every class and lists hidden-class usernames once, in stored order", () => {
    const summary = summarizeStoryMentions(
      story("s1", [
        mention("hidden_one", MentionVisibilityClass.POSSIBLY_HIDDEN),
        mention("visible_one", MentionVisibilityClass.VISIBLE),
        mention("Hidden_One", MentionVisibilityClass.METADATA_ONLY),
        mention("unknown_one", MentionVisibilityClass.UNKNOWN),
        mention("offscreen", MentionVisibilityClass.OFF_CANVAS),
      ]),
    );

    expect(summary.storyId).toBe("s1");
    expect(summary.total).toBe(5);
    expect(summary.hidden).toBe(3);
    expect(summary.byVisibility).toEqual({
      ...emptyMentionVisibilityCounts(),
      VISIBLE: 1,
      POSSIBLY_HIDDEN: 1,
      OFF_CANVAS: 1,
      METADATA_ONLY: 1,
      UNKNOWN: 1,
    });
    // Case-insensitive dedupe: "Hidden_One" repeats "hidden_one".
    expect(summary.hiddenUsernames).toEqual(["hidden_one", "offscreen"]);
  });

  it("returns zeroed counts for a story with no mentions", () => {
    const summary = summarizeStoryMentions(story("s-empty", []));
    expect(summary.total).toBe(0);
    expect(summary.hidden).toBe(0);
    expect(summary.hiddenUsernames).toEqual([]);
    expect(summary.byVisibility).toEqual(emptyMentionVisibilityCounts());
  });
});

describe("aggregateMentionIntelligence", () => {
  it("rolls observations up per account with hidden stories in first-seen order", () => {
    const entries = aggregateMentionIntelligence([
      {
        storyId: "s1",
        mentions: [
          { username: "target", visibilityClass: MentionVisibilityClass.POSSIBLY_HIDDEN },
          { username: "other", visibilityClass: MentionVisibilityClass.VISIBLE },
        ],
      },
      {
        storyId: "s2",
        mentions: [
          { username: "TARGET", visibilityClass: MentionVisibilityClass.METADATA_ONLY, igId: "ig-9" },
          { username: "third", visibilityClass: MentionVisibilityClass.OFF_CANVAS },
        ],
      },
    ]);

    // Ordering: hidden-mention count desc, then story count desc, then username asc.
    expect(entries.map((e) => e.username)).toEqual(["target", "third", "other"]);

    const target = entries[0]!;
    expect(target.stories).toBe(2);
    expect(target.hiddenMentions).toBe(2);
    expect(target.hiddenStoryIds).toEqual(["s1", "s2"]);
    expect(target.igId).toBe("ig-9");
    expect(target.visibilityClasses).toEqual([
      MentionVisibilityClass.POSSIBLY_HIDDEN,
      MentionVisibilityClass.METADATA_ONLY,
    ]);

    const other = entries[2]!;
    expect(other.stories).toBe(1);
    expect(other.hiddenMentions).toBe(0);
    expect(other.hiddenStoryIds).toEqual([]);
  });

  it("counts one story once per account even when it names the account twice", () => {
    const entries = aggregateMentionIntelligence([
      {
        storyId: "s1",
        mentions: [
          { username: "dup", visibilityClass: MentionVisibilityClass.VISIBLE },
          { username: "dup", visibilityClass: MentionVisibilityClass.OFF_CANVAS },
        ],
      },
    ]);

    expect(entries).toHaveLength(1);
    const dup = entries[0]!;
    expect(dup.stories).toBe(1);
    // Any hidden-class row makes that one story-level mention hidden.
    expect(dup.hiddenMentions).toBe(1);
    expect(dup.hiddenStoryIds).toEqual(["s1"]);
  });

  it("keeps the first observed igId and never invents one", () => {
    const entries = aggregateMentionIntelligence([
      { storyId: "s1", mentions: [{ username: "a", visibilityClass: MentionVisibilityClass.VISIBLE }] },
      {
        storyId: "s2",
        mentions: [{ username: "a", visibilityClass: MentionVisibilityClass.VISIBLE, igId: "ig-1" }],
      },
      {
        storyId: "s3",
        mentions: [{ username: "a", visibilityClass: MentionVisibilityClass.VISIBLE, igId: "ig-2" }],
      },
    ]);

    const a = entries[0]!;
    expect(a.igId).toBe("ig-1");
    expect("igId" in entries[0]!).toBe(true);
  });

  it("returns an empty roll-up for no observations", () => {
    expect(aggregateMentionIntelligence([])).toEqual([]);
  });
});

describe("mentionObservationsFromStories", () => {
  it("projects normalized stories without reinterpreting visibility classes", () => {
    const observations = mentionObservationsFromStories([
      story("s1", [
        mention("a", MentionVisibilityClass.POSSIBLY_HIDDEN),
        mention("b", MentionVisibilityClass.UNKNOWN, "ig-b"),
      ]),
    ]);

    expect(observations).toEqual([
      {
        storyId: "s1",
        mentions: [
          { username: "a", visibilityClass: MentionVisibilityClass.POSSIBLY_HIDDEN },
          { username: "b", visibilityClass: MentionVisibilityClass.UNKNOWN, igId: "ig-b" },
        ],
      },
    ]);

    // Round trip: UNKNOWN stays uncounted as hidden end-to-end.
    const entries = aggregateMentionIntelligence(observations);
    expect(entries.find((e) => e.username === "b")!.hiddenMentions).toBe(0);
  });
});
