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
  FORBIDDEN: "FORBIDDEN",
  TIMEOUT: "TIMEOUT",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  INTERNAL: "INTERNAL",
  UNKNOWN: "UNKNOWN",
} as const;

export type CapabilityErrorKind =
  (typeof CapabilityErrorKind)[keyof typeof CapabilityErrorKind];

// Provider-neutral retryability contract (STEP 9). A provider may override a
// retryable kind with retryable:false, never the reverse: a non-retryable kind
// is permanently non-retryable regardless of what the provider claims.
const RETRYABLE_KINDS: ReadonlySet<CapabilityErrorKind> = new Set([
  CapabilityErrorKind.RATE_LIMITED,
  CapabilityErrorKind.NETWORK,
  CapabilityErrorKind.TIMEOUT,
  CapabilityErrorKind.PROVIDER_ERROR,
  CapabilityErrorKind.INTERNAL,
]);

export function isRetryableCapabilityKind(kind: CapabilityErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}

// Effective retryability for a provider error: the provider's explicit
// `retryable` override wins; otherwise the taxonomy decides. A non-retryable
// kind is permanently non-retryable regardless of override.
export function effectiveRetryability(
  kind: CapabilityErrorKind,
  override?: boolean,
): boolean {
  if (override !== undefined && override === false) return false;
  return isRetryableCapabilityKind(kind);
}

export interface CapabilityError {
  kind: CapabilityErrorKind;
  message: string;
  retryable: boolean;
  // Provider-supplied retry delay (e.g. HTTP Retry-After / rate-limit reset).
  // Honored verbatim by the worker as the job's next availability time; never
  // combined with exponential backoff. Absent → default backoff applies.
  retryAfterMs?: number;
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
  // Opaque continuation token when the provider holds more pages. Present
  // only when the caller must pass it back as Cursor{value} to continue the
  // listing; absent means the listing is complete (or the provider cannot
  // paginate this capability). Executors use it for resumable multi-page
  // scans instead of silently truncating at the first page.
  nextCursor?: string;
}

export function available<T>(
  data: T,
  meta: {
    observedAt: string;
    source: SourceRef;
    confidence: Confidence;
    rawPayloadHash?: string;
    rawReference?: string;
    nextCursor?: string;
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
    nextCursor?: string;
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
