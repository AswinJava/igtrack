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
} as const;

export type ObservationKind =
  (typeof ObservationKind)[keyof typeof ObservationKind];
