import type { Confidence } from "./epistemics.js";
import type { SourceKind } from "./capability.js";

export interface Evidence {
  observationKind: string;
  observationId: string;
  sourceType: SourceKind;
  sourceReference?: string;
  observedAt: string;
  capturedAt: string;
  confidence: Confidence;
  rawHash: string;
  normalizedHash: string;
}

export interface EvidenceInput {
  observationKind: string;
  observationId: string;
  sourceType: SourceKind;
  sourceReference?: string;
  observedAt: string;
  capturedAt: string;
  confidence: Confidence;
  rawPayload: string;
  normalizedPayload: string;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}
