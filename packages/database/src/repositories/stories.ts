import { randomUUID } from "node:crypto";
import { and, desc, sql } from "drizzle-orm";
import type { NormalizedAccountRef, NormalizedStory } from "@igtrack/core";
import { igAccounts, stories, storyMentions, storySightings } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { withTransaction } from "../transactions.js";
import { upsertAccount } from "./accounts.js";
import { ensureSource } from "./sources.js";
import { ObservationKind, type EvidenceRecordInput } from "./types.js";
import { upsertEvidence } from "./evidence.js";

export type StoryRecord = typeof stories.$inferSelect;
export type StoryMentionRecord = typeof storyMentions.$inferSelect;

export interface RecordStoryInput {
  owner: NormalizedAccountRef;
  story: NormalizedStory;
  sourceId: string;
  evidence: EvidenceRecordInput;
  mentionEvidence?: Record<string, EvidenceRecordInput>;
}

export interface RecordStoryResult {
  story: StoryRecord;
  mentions: StoryMentionRecord[];
  deduplicated: boolean;
}

export async function recordStory(
  db: Database,
  input: RecordStoryInput,
): Promise<RecordStoryResult> {
  const { story } = input;

  return withTransaction(db, async (tx) => {
    await ensureSource(tx, input.evidence.source);

    const owner = await upsertAccount(tx, {
      username: input.owner.username,
      ...(input.owner.igId !== undefined ? { igId: input.owner.igId } : {}),
      ...(input.owner.displayName !== undefined
        ? { displayName: input.owner.displayName }
        : {}),
      ...(input.owner.isPrivate !== undefined
        ? { isPrivate: input.owner.isPrivate }
        : {}),
      seenAt: new Date(story.meta.observedAt),
    });

    const existing = await tx
      .select()
      .from(stories)
      .where(
        and(
          sql`${stories.igAccountId} = ${owner.id}`,
          sql`${stories.storyId} = ${story.storyId}`,
          sql`${stories.sourceId} = ${input.sourceId}`,
        ),
      )
      .limit(1);
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      const existingMentions = await tx
        .select()
        .from(storyMentions)
        .where(sql`${storyMentions.storyDbId} = ${existingRow.id}`);
      return { story: existingRow, mentions: existingMentions, deduplicated: true };
    }

    const storyDbId = randomUUID();
    const evidenceId = await upsertEvidence(tx, storyDbId, {
      ...input.evidence,
      observationKind: ObservationKind.STORY,
    });

    const storyRows = await tx
      .insert(stories)
      .values({
        id: storyDbId,
        igAccountId: owner.id,
        storyId: story.storyId,
        sourceId: input.sourceId,
        observedAt: new Date(story.meta.observedAt),
        takenAt: new Date(story.takenAt),
        ...(story.expiresAt !== undefined
          ? { expiresAt: new Date(story.expiresAt) }
          : {}),
        mediaType: story.mediaType,
        ...(story.durationMs !== undefined ? { durationMs: story.durationMs } : {}),
        ...(story.caption !== undefined ? { caption: story.caption } : {}),
        hasLink: story.hasLink,
        ...(story.linkUrl !== undefined ? { linkUrl: story.linkUrl } : {}),
        stickerKinds: story.stickerKinds,
        ...(story.poll !== undefined ? { poll: story.poll } : {}),
        ...(story.question !== undefined ? { question: story.question } : {}),
        ...(story.location !== undefined ? { location: story.location } : {}),
        ...(story.music !== undefined ? { music: story.music } : {}),
        category: story.meta.category,
        confidence: story.meta.confidence,
        ...(evidenceId !== undefined ? { evidenceId } : {}),
      })
      .onConflictDoNothing({
        target: [stories.igAccountId, stories.storyId, stories.sourceId],
      })
      .returning();
    const storyRow = storyRows[0];
    if (storyRow === undefined) {
      // Lost the insert race after the pre-select missed: re-read the winner
      // with its mentions instead of failing the scan.
      const raced = await tx
        .select()
        .from(stories)
        .where(
          and(
            sql`${stories.igAccountId} = ${owner.id}`,
            sql`${stories.storyId} = ${story.storyId}`,
            sql`${stories.sourceId} = ${input.sourceId}`,
          ),
        )
        .limit(1);
      const racedRow = raced[0];
      if (racedRow === undefined) {
        throw new Error("igtrack: failed to insert story");
      }
      const racedMentions = await tx
        .select()
        .from(storyMentions)
        .where(sql`${storyMentions.storyDbId} = ${racedRow.id}`);
      return { story: racedRow, mentions: racedMentions, deduplicated: true };
    }

    const mentions: StoryMentionRecord[] = [];
    for (const mention of story.mentions) {
      const mentioned = await upsertAccount(tx, {
        username: mention.account.username,
        ...(mention.account.igId !== undefined
          ? { igId: mention.account.igId }
          : {}),
        ...(mention.account.isPrivate !== undefined
          ? { isPrivate: mention.account.isPrivate }
          : {}),
        seenAt: new Date(mention.meta.observedAt),
      });

      const mentionDbId = randomUUID();
      const mentionInput = input.mentionEvidence?.[mention.account.username.toLowerCase()];
      const mentionEvidenceId =
        mentionInput !== undefined
          ? await upsertEvidence(tx, mentionDbId, {
              ...mentionInput,
              observationKind: ObservationKind.STORY_MENTION,
            })
          : undefined;

      const g = mention.geometry;
      const mentionRows = await tx
        .insert(storyMentions)
        .values({
          id: mentionDbId,
          storyDbId: storyRow.id,
          mentionedAccountId: mentioned.id,
          ...(g?.x !== undefined ? { positionX: g.x } : {}),
          ...(g?.y !== undefined ? { positionY: g.y } : {}),
          ...(g?.width !== undefined ? { width: g.width } : {}),
          ...(g?.height !== undefined ? { height: g.height } : {}),
          ...(mention.rawVisibilityFlag !== undefined
            ? { rawVisibilityFlag: mention.rawVisibilityFlag }
            : {}),
          visibilityClass: mention.visibilityClass,
          observedAt: new Date(mention.meta.observedAt),
          confidence: mention.meta.confidence,
          ...(mentionEvidenceId !== undefined ? { evidenceId: mentionEvidenceId } : {}),
        })
        .onConflictDoNothing({
          target: [storyMentions.storyDbId, storyMentions.mentionedAccountId],
        })
        .returning();
      const mentionRow = mentionRows[0];
      if (mentionRow !== undefined) mentions.push(mentionRow);
    }

    return { story: storyRow, mentions, deduplicated: false };
  });
}

export async function listStories(
  db: Database,
  igAccountId: string,
  options: { limit?: number } = {},
): Promise<StoryRecord[]> {
  return db
    .select()
    .from(stories)
    .where(sql`${stories.igAccountId} = ${igAccountId}`)
    .orderBy(desc(stories.takenAt))
    .limit(options.limit ?? 50);
}

export async function listMentionsForStory(
  db: Database,
  storyDbId: string,
): Promise<StoryMentionRecord[]> {
  return db
    .select()
    .from(storyMentions)
    .where(sql`${storyMentions.storyDbId} = ${storyDbId}`);
}

export interface StoryMentionWithAccount extends StoryMentionRecord {
  username: string;
  displayName: string | null;
  // Provider-supplied platform id of the mentioned account, when the source
  // exposes it. Rendered as hover detail, never as identity proof alone.
  mentionedIgId: string | null;
}

// Username-enriched variant for ownership-scoped UI surfaces. Callers must
// only pass story IDs that already passed an ownership check (e.g. stories
// listed for an owned target); the join itself adds no new scope.
export async function listMentionsForStoryWithAccount(
  db: Database,
  storyDbId: string,
): Promise<StoryMentionWithAccount[]> {
  return db
    .select({
      id: storyMentions.id,
      storyDbId: storyMentions.storyDbId,
      mentionedAccountId: storyMentions.mentionedAccountId,
      positionX: storyMentions.positionX,
      positionY: storyMentions.positionY,
      width: storyMentions.width,
      height: storyMentions.height,
      rawVisibilityFlag: storyMentions.rawVisibilityFlag,
      visibilityClass: storyMentions.visibilityClass,
      observedAt: storyMentions.observedAt,
      confidence: storyMentions.confidence,
      evidenceId: storyMentions.evidenceId,
      createdAt: storyMentions.createdAt,
      username: igAccounts.username,
      displayName: igAccounts.displayName,
      mentionedIgId: igAccounts.igId,
    })
    .from(storyMentions)
    .innerJoin(igAccounts, sql`${igAccounts.id} = ${storyMentions.mentionedAccountId}`)
    .where(sql`${storyMentions.storyDbId} = ${storyDbId}`);
}

export interface StorySightingRecord {
  id: string;
  observedAt: Date;
  jobId: string | null;
}

// Append-only re-observation mark. Called for EVERY story a scan observes,
// including deduplicated re-hits — that is the entire point: the stories row
// stays immutable (first observation), sightings record the ongoing presence.
// Idempotent per (story, observed_at): retried or reclaimed scans collapse.
export async function recordStorySighting(
  db: Database,
  input: { storyDbId: string; observedAt: Date; jobId?: string },
): Promise<void> {
  await db
    .insert(storySightings)
    .values({
      id: randomUUID(),
      storyDbId: input.storyDbId,
      observedAt: input.observedAt,
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    })
    .onConflictDoNothing({
      target: [storySightings.storyDbId, storySightings.observedAt],
    });
}

export interface StorySightingsSummary {
  count: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}

// Bounded per-story observation history for UI. One aggregate query over the
// account's stories — no per-story round trips.
export async function sightingSummariesForAccount(
  db: Database,
  igAccountId: string,
): Promise<Record<string, StorySightingsSummary>> {
  const rows = await db.execute(sql`
    SELECT sg.story_db_id AS "storyDbId",
           count(*)::int AS "count",
           min(sg.observed_at) AS "firstSeenAt",
           max(sg.observed_at) AS "lastSeenAt"
    FROM story_sightings sg
    JOIN stories s ON s.id = sg.story_db_id
    WHERE s.ig_account_id = ${igAccountId}
    GROUP BY sg.story_db_id
  `);
  const out: Record<string, StorySightingsSummary> = {};
  for (const row of rows as unknown as Array<{
    storyDbId: string;
    count: number;
    firstSeenAt: Date | string | null;
    lastSeenAt: Date | string | null;
  }>) {
    out[row.storyDbId] = {
      count: Number(row.count),
      firstSeenAt: row.firstSeenAt === null ? null : new Date(row.firstSeenAt),
      lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt),
    };
  }
  return out;
}
