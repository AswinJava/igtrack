import {
  Confidence,
  MediaType,
  ObservationCategory,
  type NormalizedStory,
} from "@igtrack/core";
import type { RawStoryV1 } from "../raw-schemas/v1.js";
import { normalizeMention } from "./mention.js";

export function normalizeStory(
  raw: RawStoryV1,
  canvas: { width: number; height: number } | undefined,
  observedAt: string,
): NormalizedStory {
  const mediaType =
    raw.media_type === "image"
      ? MediaType.IMAGE
      : raw.media_type === "video"
        ? MediaType.VIDEO
        : MediaType.UNKNOWN;

  return {
    storyId: raw.id,
    mediaType,
    takenAt: raw.taken_at,
    ...(raw.expires_at !== undefined ? { expiresAt: raw.expires_at } : {}),
    ...(raw.duration_ms !== undefined ? { durationMs: raw.duration_ms } : {}),
    ...(raw.caption !== undefined ? { caption: raw.caption } : {}),
    hasLink: raw.link_url !== undefined,
    stickerKinds: raw.stickers ?? [],
    ...(raw.poll !== undefined
      ? {
          poll: {
            ...(raw.poll.question !== undefined ? { question: raw.poll.question } : {}),
            ...(raw.poll.options !== undefined ? { options: raw.poll.options } : {}),
          },
        }
      : {}),
    ...(raw.question !== undefined
      ? {
          question: {
            ...(raw.question.question !== undefined
              ? { question: raw.question.question }
              : {}),
          },
        }
      : {}),
    ...(raw.location !== undefined
      ? {
          location: {
            ...(raw.location.name !== undefined ? { name: raw.location.name } : {}),
            ...(raw.location.lat !== undefined ? { lat: raw.location.lat } : {}),
            ...(raw.location.lng !== undefined ? { lng: raw.location.lng } : {}),
          },
        }
      : {}),
    ...(raw.music !== undefined
      ? {
          music: {
            ...(raw.music.title !== undefined ? { title: raw.music.title } : {}),
            ...(raw.music.artist !== undefined ? { artist: raw.music.artist } : {}),
          },
        }
      : {}),
    mentions: (raw.mentions ?? []).map((m) => normalizeMention(m, canvas, observedAt)),
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt,
    },
  };
}
