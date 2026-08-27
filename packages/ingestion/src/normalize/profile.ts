import {
  Confidence,
  ObservationCategory,
  type NormalizedProfile,
} from "@igtrack/core";
import type { RawProfileV1 } from "../raw-schemas/v1.js";

export function normalizeProfile(raw: RawProfileV1): NormalizedProfile {
  const p = raw.profile;
  return {
    account: {
      username: p.username,
      ...(p.id !== undefined ? { igId: p.id } : {}),
      ...(p.full_name !== undefined ? { displayName: p.full_name } : {}),
      isPrivate: p.is_private ?? false,
    },
    ...(p.biography !== undefined ? { bio: p.biography } : {}),
    ...(p.external_url !== undefined ? { externalUrl: p.external_url } : {}),
    ...(p.profile_pic_url !== undefined ? { profilePicUrl: p.profile_pic_url } : {}),
    ...(p.follower_count !== undefined ? { followerCount: p.follower_count } : {}),
    ...(p.following_count !== undefined ? { followingCount: p.following_count } : {}),
    ...(p.media_count !== undefined ? { postCount: p.media_count } : {}),
    isVerified: p.is_verified ?? false,
    meta: {
      category: ObservationCategory.OBSERVED,
      confidence: Confidence.HIGH,
      observedAt: raw.captured_at,
    },
  };
}
