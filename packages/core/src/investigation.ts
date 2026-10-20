// ---------------------------------------------------------------------------
// The investigation vocabulary.
//
// A username-first investigation fans out across several sources, and the
// sources answer in different ways: one returns platform fields, one returns
// cited web statements, one returns the operator's own export, one returns
// nothing at all. The report has to keep those apart, because a "dossier" that
// blends a live follower count with a demo fixture row and a search snippet
// is exactly the unlabelled soup this project exists to refuse.
//
// So the vocabulary is deliberately small and closed:
//
//   * EVIDENCE_CLASS — what a piece of information is evidence OF.
//   * INVESTIGATION_STAGE — the steps one investigation is made of, and the
//     status each one ended in.
//   * InvestigationGap — one thing we could not get, why, and what would
//     change that.
//
// Nothing here interprets or merges: a stage reports what its source
// returned, and the caller renders the classes apart.
// ---------------------------------------------------------------------------

/**
 * The classes of evidence an investigation can draw on.
 *
 * These are NOT interchangeable and are never merged into one result:
 *
 *   PLATFORM_OBSERVATION — a documented official API answered. Only the
 *     account the deployment is authorized for.
 *   PUBLIC_WEB — a public page stated something, with its URL and retrieval
 *     time. A statement ABOUT an account, never an observation OF it.
 *   USER_EXPORT — the operator's own Instagram data export. Real data, and a
 *     record of an export, never a live observation.
 *   USER_PROVIDED — the operator or their agent submitted it (the claims
 *     ledger). A finding with a citation, not an observation.
 *   DERIVED — computed from the rows above (themes, cadence, a relationship
 *     score). The derivation is always stated with the rows behind it.
 *   SYNTHETIC_FIXTURE — generated test data. Never evidence about anyone.
 */
export const EVIDENCE_CLASS = {
  PLATFORM: "PLATFORM_OBSERVATION",
  WEB: "PUBLIC_WEB",
  EXPORT: "USER_EXPORT",
  OPERATOR: "USER_PROVIDED",
  DERIVED: "DERIVED",
  SYNTHETIC: "SYNTHETIC_FIXTURE",
} as const;

export type EvidenceClass = (typeof EVIDENCE_CLASS)[keyof typeof EVIDENCE_CLASS];

/** One human line per class: what a reader is allowed to conclude from it. */
export const EVIDENCE_CLASS_LABELS: Record<EvidenceClass, string> = {
  [EVIDENCE_CLASS.PLATFORM]: "Official API observation — a documented route answered",
  [EVIDENCE_CLASS.WEB]: "Public-web statement — a public page said this, with its URL and retrieval time",
  [EVIDENCE_CLASS.EXPORT]: "Operator's own export — real data, recorded from a download, not a live observation",
  [EVIDENCE_CLASS.OPERATOR]: "Operator/agent finding — submitted with a citation, never observed here",
  [EVIDENCE_CLASS.DERIVED]: "Derived from the rows above — a computation, always stated with its inputs",
  [EVIDENCE_CLASS.SYNTHETIC]: "Synthetic fixture data — generated, never evidence about anyone",
};

/**
 * The steps one investigation is made of.
 *
 * They run in order and each one is reported separately, so a reader can see
 * exactly which part of the picture was retrieved and which part was not.
 */
export const INVESTIGATION_STAGE = {
  /** A. Normalize the reference, B. resolve the account. */
  IDENTITY: "IDENTITY",
  /** C. The fields the selected source exposes for the account. */
  PLATFORM: "PLATFORM",
  /** D/E. Accessible content: posts, captions, comments, mentions, tags. */
  CONTENT: "CONTENT",
  /** Rosters, mutual follows, interactions, and their changes over time. */
  RELATIONSHIPS: "RELATIONSHIPS",
  /** F/G. Public-web discovery, retrieval and extraction. */
  WEB: "WEB",
  /** Correlation across the classes above: themes, cadence, contradictions. */
  CORRELATE: "CORRELATE",
  /** I. The dossier itself: what is known, and what is still unknown. */
  DOSSIER: "DOSSIER",
} as const;

export type InvestigationStageId =
  (typeof INVESTIGATION_STAGE)[keyof typeof INVESTIGATION_STAGE];

/** How one stage ended. */
export const INVESTIGATION_STAGE_STATUS = {
  /** The stage ran and returned what it could. */
  COMPLETED: "COMPLETED",
  /** The stage ran, but some of it was unavailable (and says so). */
  PARTIAL: "PARTIAL",
  /** The stage did not run because the operator or the policy said so. */
  SKIPPED: "SKIPPED",
  /** The stage could not run: a missing credential, a permission, an account class. */
  BLOCKED: "BLOCKED",
  /** The stage ran and failed. The failure is reported, never smoothed over. */
  FAILED: "FAILED",
} as const;

export type InvestigationStageStatus =
  (typeof INVESTIGATION_STAGE_STATUS)[keyof typeof INVESTIGATION_STAGE_STATUS];

export interface InvestigationStage {
  id: InvestigationStageId;
  /** What this stage was for, in one line. */
  objective: string;
  status: InvestigationStageStatus;
  /** Which source answered it ("graph:owned:v1", "freeserp", "operator export"). */
  source: string | null;
  /** Why it ended this way, or what it found. Never empty when the status is not COMPLETED. */
  reason: string | null;
  /**
   * What the stage did, counted. The key names what: `queued`/`skipped` are
   * attempts, `media`/`comments`/`facts` are retrievals, `gaps` is what
   * remains unknown. A stage that refused everything has counts, and the
   * status says so.
   */
  retrieved: Record<string, number>;
  /** The evidence classes this stage produced. Empty means it produced nothing. */
  evidenceClasses: EvidenceClass[];
}

/**
 * One thing the investigation could not get.
 *
 * A gap is a finding, not a failure: it names the subject, the reason (with
 * the source's own words where the source gave them), and the configuration
 * that would close it. An investigation report that lists no gaps is either
 * complete or lying.
 */
export interface InvestigationGap {
  /** What could not be retrieved, in the operator's language. */
  subject: string;
  /**
   * Why it could not be retrieved.
   *
   * "investigation" — a gap in THIS run (the source does not observe the
   * account, no search provider, a failed scan).
   * "capability" — a gap in the product itself for this deployment (the
   * platform exposes no such edge; a policy refuses it).
   */
  kind: "investigation" | "capability";
  /** Why it could not be retrieved. */
  reason: string;
  /** The configuration or route that would change the answer, or null. */
  howToImprove: string | null;
}

/**
 * One source the investigation consulted, and what it returned.
 *
 * `queried: false` with a reason is a first-class answer: a source that was
 * configured but not consulted is reported, never silently dropped.
 */
export interface InvestigationSource {
  /** The source id, as the provider names it ("graph:owned:v1", "freeserp"). */
  id: string;
  /** The class of evidence it would produce. */
  evidenceClass: EvidenceClass;
  /** Whether a request actually reached it during this investigation. */
  queried: boolean;
  /** Why it was not consulted, or what it answered. */
  reason: string | null;
  /** The number of items it contributed, when it was consulted. */
  items: number | null;
}
