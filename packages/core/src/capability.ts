import type { Confidence } from "./epistemics.js";

export const CapabilityStatus = {
  AVAILABLE: "AVAILABLE",
  PARTIAL: "PARTIAL",
  UNAVAILABLE: "UNAVAILABLE",
  ERROR: "ERROR",
} as const;

export type CapabilityStatus =
  (typeof CapabilityStatus)[keyof typeof CapabilityStatus];

export const CapabilityErrorKind = {
  SOURCE_NOT_FOUND: "SOURCE_NOT_FOUND",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  ACCOUNT_PRIVATE: "ACCOUNT_PRIVATE",
  RATE_LIMITED: "RATE_LIMITED",
  SCHEMA_MISMATCH: "SCHEMA_MISMATCH",
  NETWORK: "NETWORK",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  INTERNAL: "INTERNAL",
} as const;

export type CapabilityErrorKind =
  (typeof CapabilityErrorKind)[keyof typeof CapabilityErrorKind];

export interface CapabilityError {
  kind: CapabilityErrorKind;
  message: string;
  retryable: boolean;
}

export interface SourceRef {
  sourceId: string;
  kind: SourceKind;
  reference?: string;
}

export const SourceKind = {
  FIXTURE: "FIXTURE",
  IMPORT: "IMPORT",
  GRAPH_API: "GRAPH_API",
  USER_PROVIDED: "USER_PROVIDED",
} as const;

export type SourceKind = (typeof SourceKind)[keyof typeof SourceKind];

export interface CapabilityResult<T> {
  status: CapabilityStatus;
  data?: T;
  observedAt: string;
  source: SourceRef;
  confidence: Confidence;
  note?: string;
  error?: CapabilityError;
  // Genuine hash of the RAW source payload the provider consumed, when the
  // provider can transport it. Never derived from normalized data.
  rawPayloadHash?: string;
  // Reference to the raw payload's location (fixture file, API URL, ...).
  rawReference?: string;
}

export function available<T>(
  data: T,
  meta: {
    observedAt: string;
    source: SourceRef;
    confidence: Confidence;
    rawPayloadHash?: string;
    rawReference?: string;
  },
): CapabilityResult<T> {
  return { status: CapabilityStatus.AVAILABLE, data, ...meta };
}

export function partial<T>(
  data: T,
  meta: {
    observedAt: string;
    source: SourceRef;
    confidence: Confidence;
    note: string;
    rawPayloadHash?: string;
    rawReference?: string;
  },
): CapabilityResult<T> {
  return { status: CapabilityStatus.PARTIAL, data, ...meta };
}

export function unavailable(
  meta: { observedAt: string; source: SourceRef },
  note: string,
): CapabilityResult<never> {
  return {
    status: CapabilityStatus.UNAVAILABLE,
    observedAt: meta.observedAt,
    source: meta.source,
    confidence: "UNKNOWN",
    note,
  };
}

export function errored(
  meta: { observedAt: string; source: SourceRef },
  error: CapabilityError,
): CapabilityResult<never> {
  return {
    status: CapabilityStatus.ERROR,
    observedAt: meta.observedAt,
    source: meta.source,
    confidence: "UNKNOWN",
    error,
  };
}

export function isUsable<T>(result: CapabilityResult<T>): result is CapabilityResult<T> & { data: T } {
  return (
    (result.status === CapabilityStatus.AVAILABLE ||
      result.status === CapabilityStatus.PARTIAL) &&
    result.data !== undefined
  );
}
