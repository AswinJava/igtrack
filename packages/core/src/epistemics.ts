export const ObservationCategory = {
  OBSERVED: "OBSERVED",
  DERIVED: "DERIVED",
  INFERRED: "INFERRED",
  UNAVAILABLE: "UNAVAILABLE",
} as const;

export type ObservationCategory =
  (typeof ObservationCategory)[keyof typeof ObservationCategory];

export const Confidence = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  UNKNOWN: "UNKNOWN",
} as const;

export type Confidence = (typeof Confidence)[keyof typeof Confidence];

export function confidenceRank(confidence: Confidence): number {
  switch (confidence) {
    case Confidence.HIGH:
      return 3;
    case Confidence.MEDIUM:
      return 2;
    case Confidence.LOW:
      return 1;
    case Confidence.UNKNOWN:
      return 0;
  }
}

export function higherConfidence(a: Confidence, b: Confidence): Confidence {
  return confidenceRank(a) >= confidenceRank(b) ? a : b;
}
