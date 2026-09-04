// Evidence-band labels for the relationship heuristic (Phase 15).
// The underlying score (mentions × 12 + follow signals × 8) is computed in
// packages/database (getRelationshipsForUser) and stays untouched here. This
// module only maps observed-signal counts to honest display bands so the UI
// never implies psychological knowledge ("favourite people") from a handful
// of synthetic observations. No recency decay, reciprocity, sentiment, or
// behavioral modeling is claimed — none is implemented.

export type RelationshipBandTone = "info" | "muted";

export interface RelationshipBand {
  label: string;
  tone: RelationshipBandTone;
}

// Bands are deliberately coarse: with so few signals, any finer grading
// would overstate what the system knows.
export function relationshipBand(totalSignals: number): RelationshipBand {
  if (totalSignals >= 3) {
    return { label: "Higher observed activity", tone: "info" };
  }
  if (totalSignals >= 1) {
    return { label: "Limited evidence", tone: "muted" };
  }
  return { label: "Insufficient evidence", tone: "muted" };
}

export function describeRelationshipSignals(signals: {
  mentions: number;
  deltas: number;
}): string {
  return `Mentions ${signals.mentions} · Follow signals ${signals.deltas}`;
}
