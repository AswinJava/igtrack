import {
  MentionVisibilityClass,
  type NormalizedStory,
} from "./models.js";

// ---------------------------------------------------------------------------
// Hidden-mention intelligence (§matches STORY_MENTIONS / MENTION_INTELLIGENCE):
// a pure reading aid over mentions the provider ALREADY exposed. It performs no
// fetching, holds no provider, and adds no new access path — it only groups
// stored observations so a reader can see which accounts a story named without
// the source establishing that the name was rendered on the canvas.
//
// Epistemic rules baked in here:
//   • A mention is "not established visible" when its visibility class is
//     POSSIBLY_HIDDEN, OFF_CANVAS or METADATA_ONLY. Those classes mean the
//     source supplied a name but did not establish on-canvas rendering.
//   • UNKNOWN is deliberately NOT in that set: unknown means "no signal was
//     supplied", and treating it as hidden would convert absence of evidence
//     into a finding.
//   • Nothing here is proof of intent to hide. The UI must keep saying so.
// ---------------------------------------------------------------------------

/**
 * Visibility classes where the source named an account without establishing
 * that the mention was rendered on the story canvas. Ordered as declared in
 * MentionVisibilityClass for stable downstream rendering.
 */
export const HIDDEN_MENTION_CLASSES: readonly MentionVisibilityClass[] = [
  MentionVisibilityClass.POSSIBLY_HIDDEN,
  MentionVisibilityClass.OFF_CANVAS,
  MentionVisibilityClass.METADATA_ONLY,
];

export function isHiddenMentionVisibility(
  visibilityClass: MentionVisibilityClass,
): boolean {
  return HIDDEN_MENTION_CLASSES.includes(visibilityClass);
}

export type MentionVisibilityCounts = Record<MentionVisibilityClass, number>;

export function emptyMentionVisibilityCounts(): MentionVisibilityCounts {
  return {
    VISIBLE: 0,
    POSSIBLY_HIDDEN: 0,
    OFF_CANVAS: 0,
    METADATA_ONLY: 0,
    UNKNOWN: 0,
  };
}

/** One mention of one account inside one story, as stored. */
export interface StoryMentionObservation {
  username: string;
  visibilityClass: MentionVisibilityClass;
  igId?: string;
}

export interface StoryMentionSummary {
  storyId: string;
  /** Stored mention rows for this story (pre-dedupe, as observed). */
  total: number;
  /** Rows whose visibility class is a hidden class. */
  hidden: number;
  byVisibility: MentionVisibilityCounts;
  /** Usernames of hidden-class mentions, in stored order, deduplicated by username. */
  hiddenUsernames: string[];
}

export function summarizeStoryMentions(
  story: NormalizedStory,
): StoryMentionSummary {
  const byVisibility = emptyMentionVisibilityCounts();
  const hiddenUsernames: string[] = [];
  const seenHidden = new Set<string>();
  let hidden = 0;

  for (const mention of story.mentions) {
    byVisibility[mention.visibilityClass] += 1;
    if (!isHiddenMentionVisibility(mention.visibilityClass)) continue;
    hidden += 1;
    const key = mention.account.username.toLowerCase();
    if (seenHidden.has(key)) continue;
    seenHidden.add(key);
    hiddenUsernames.push(mention.account.username);
  }

  return {
    storyId: story.storyId,
    total: story.mentions.length,
    hidden,
    byVisibility,
    hiddenUsernames,
  };
}

/** Story-shaped mention input for the roll-up, usable for any stored story. */
export interface MentionObservation {
  storyId: string;
  mentions: readonly StoryMentionObservation[];
}

/**
 * Project normalized stories (active stories, highlight items, or any other
 * lawfully obtained story-shaped observation) into roll-up input. No filtering
 * happens here — class interpretation stays in the aggregator.
 */
export function mentionObservationsFromStories(
  stories: readonly NormalizedStory[],
): MentionObservation[] {
  return stories.map((story) => ({
    storyId: story.storyId,
    mentions: story.mentions.map((mention) => ({
      username: mention.account.username,
      visibilityClass: mention.visibilityClass,
      ...(mention.account.igId !== undefined ? { igId: mention.account.igId } : {}),
    })),
  }));
}

export interface MentionIntelligenceEntry {
  /** Username as first observed; usernames are case-insensitive on Instagram. */
  username: string;
  igId?: string;
  /** Distinct stories that named this account. */
  stories: number;
  /**
   * Of those stories, how many named the account through a hidden-class
   * mention (merged case-insensitively per story: any hidden-class row makes
   * that story count once).
   */
  hiddenMentions: number;
  /** Distinct visibility classes observed for this account, declared order. */
  visibilityClasses: MentionVisibilityClass[];
  /** Story ids behind `hiddenMentions`, in first-seen order. */
  hiddenStoryIds: string[];
}

/**
 * Roll stored mention observations up per mentioned account. Deterministic:
 * hidden-mention count desc, then story count desc, then username asc.
 */
export function aggregateMentionIntelligence(
  observations: readonly MentionObservation[],
): MentionIntelligenceEntry[] {
  interface Accumulated {
    username: string;
    igId?: string;
    stories: number;
    hiddenMentions: number;
    classes: Set<MentionVisibilityClass>;
    hiddenStoryIds: string[];
  }

  interface MergedStoryMention {
    username: string;
    igId?: string;
    hidden: boolean;
  }

  const byUsername = new Map<string, Accumulated>();

  for (const observation of observations) {
    // Per-story dedupe: one story naming the same account twice is one
    // story-level mention, hidden if ANY of its rows was hidden-class.
    const perStory = new Map<string, MergedStoryMention>();
    for (const mention of observation.mentions) {
      const key = mention.username.toLowerCase();
      const existing = perStory.get(key);
      const hidden = isHiddenMentionVisibility(mention.visibilityClass);
      if (existing === undefined) {
        perStory.set(key, {
          hidden,
          username: mention.username,
          ...(mention.igId !== undefined ? { igId: mention.igId } : {}),
        });
        continue;
      }
      existing.hidden = existing.hidden || hidden;
      // exactOptionalPropertyTypes: only ever assign a defined id, and never
      // overwrite one that was already observed.
      if (existing.igId === undefined && mention.igId !== undefined) {
        existing.igId = mention.igId;
      }
    }

    for (const [key, merged] of perStory) {
      const entry = byUsername.get(key);
      const accumulated: Accumulated =
        entry ?? {
          username: merged.username,
          ...(merged.igId !== undefined ? { igId: merged.igId } : {}),
          stories: 0,
          hiddenMentions: 0,
          classes: new Set<MentionVisibilityClass>(),
          hiddenStoryIds: [],
        };
      accumulated.stories += 1;
      if (accumulated.igId === undefined && merged.igId !== undefined) {
        accumulated.igId = merged.igId;
      }
      if (merged.hidden) {
        accumulated.hiddenMentions += 1;
        accumulated.hiddenStoryIds.push(observation.storyId);
      }
      for (const mention of observation.mentions) {
        if (mention.username.toLowerCase() === key) {
          accumulated.classes.add(mention.visibilityClass);
        }
      }
      byUsername.set(key, accumulated);
    }
  }

  const declaredOrder = new Map<MentionVisibilityClass, number>(
    Object.values(MentionVisibilityClass).map((value, index) => [value, index]),
  );

  return [...byUsername.values()]
    .map((entry) => ({
      username: entry.username,
      ...(entry.igId !== undefined ? { igId: entry.igId } : {}),
      stories: entry.stories,
      hiddenMentions: entry.hiddenMentions,
      visibilityClasses: [...entry.classes].sort(
        (a, b) => (declaredOrder.get(a) ?? 0) - (declaredOrder.get(b) ?? 0),
      ),
      hiddenStoryIds: entry.hiddenStoryIds,
    }))
    .sort(
      (a, b) =>
        b.hiddenMentions - a.hiddenMentions ||
        b.stories - a.stories ||
        a.username.localeCompare(b.username),
    );
}
