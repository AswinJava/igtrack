import { Confidence, SourceKind } from "@igtrack/core";

export interface SourceInput {
  id: string;
  kind: SourceKind;
  name: string;
  providerVersion?: string;
}

export interface EvidenceRecordInput {
  observationKind: string;
  source: SourceInput;
  sourceReference?: string;
  schemaVersion?: string;
  observedAt: Date;
  capturedAt: Date;
  confidence: Confidence;
  // Genuine raw-payload hash when the provider transports one; unset means the
  // raw representation is unavailable (never fabricated from normalized data).
  rawHash?: string;
  normalizedHash?: string;
  metadata?: Record<string, unknown>;
}

export const ObservationKind = {
  PROFILE_SNAPSHOT: "profile_snapshot",
  STORY: "story",
  STORY_MENTION: "story_mention",
  FOLLOW_SNAPSHOT: "follow_snapshot",
  INTERACTION: "interaction",
  POST: "post",
  POST_COMMENT: "post_comment",
  // one evidence row per logical scan covers the media change
  // claims that scan produced (caption edits, no-longer-observed events).
  POSTS_LISTING: "posts_listing",
  // one evidence row per logical tags scan covers that scan's
  // tagged-media rows — the artifact is the listing, not each row.
  TAGGED_MEDIA_LISTING: "tagged_media_listing",
  ACCOUNT_INSIGHTS: "account_insights",
} as const;

export type ObservationKind =
  (typeof ObservationKind)[keyof typeof ObservationKind];
