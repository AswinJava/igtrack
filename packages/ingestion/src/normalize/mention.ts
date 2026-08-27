import {
  Confidence,
  MentionVisibilityClass,
  ObservationCategory,
  type MentionGeometry,
  type NormalizedMention,
} from "@igtrack/core";
import type { RawMentionV1 } from "../raw-schemas/v1.js";

export interface MentionSignal {
  isHidden?: boolean;
  geometry?: MentionGeometry;
}

export function classifyMentionVisibility(
  signal: MentionSignal,
): MentionVisibilityClass {
  if (signal.isHidden === true) {
    return MentionVisibilityClass.POSSIBLY_HIDDEN;
  }

  const g = signal.geometry;
  if (
    g !== undefined &&
    typeof g.x === "number" &&
    typeof g.y === "number" &&
    typeof g.width === "number" &&
    typeof g.height === "number"
  ) {
    if (typeof g.canvasWidth === "number" && typeof g.canvasHeight === "number") {
      const fullyOutside =
        g.x + g.width <= 0 ||
        g.y + g.height <= 0 ||
        g.x >= g.canvasWidth ||
        g.y >= g.canvasHeight;
      if (fullyOutside) return MentionVisibilityClass.OFF_CANVAS;
      return MentionVisibilityClass.VISIBLE;
    }
    return MentionVisibilityClass.UNKNOWN;
  }

  if (signal.isHidden === false) {
    return MentionVisibilityClass.VISIBLE;
  }

  return MentionVisibilityClass.METADATA_ONLY;
}

export function normalizeMention(
  raw: RawMentionV1,
  canvas: { width: number; height: number } | undefined,
  observedAt: string,
): NormalizedMention {
  const hasGeometry =
    raw.x !== undefined ||
    raw.y !== undefined ||
    raw.width !== undefined ||
    raw.height !== undefined;

  const geometry: MentionGeometry | undefined = hasGeometry
    ? {
        ...(raw.x !== undefined ? { x: raw.x } : {}),
        ...(raw.y !== undefined ? { y: raw.y } : {}),
        ...(raw.width !== undefined ? { width: raw.width } : {}),
        ...(raw.height !== undefined ? { height: raw.height } : {}),
        ...(canvas ? { canvasWidth: canvas.width, canvasHeight: canvas.height } : {}),
      }
    : undefined;

  const signal: MentionSignal = {
    ...(raw.is_hidden !== undefined ? { isHidden: raw.is_hidden } : {}),
    ...(geometry ? { geometry } : {}),
  };

  const visibilityClass = classifyMentionVisibility(signal);
  const hasAnyVisibilitySignal =
    raw.is_hidden !== undefined || visibilityClass !== MentionVisibilityClass.METADATA_ONLY;

  return {
    account: {
      username: raw.username,
      ...(raw.id !== undefined ? { igId: raw.id } : {}),
      isPrivate: false,
    },
    ...(geometry ? { geometry } : {}),
    ...(raw.is_hidden !== undefined ? { rawVisibilityFlag: raw.is_hidden } : {}),
    visibilityClass,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: hasAnyVisibilitySignal ? Confidence.HIGH : Confidence.LOW,
      observedAt,
    },
  };
}
