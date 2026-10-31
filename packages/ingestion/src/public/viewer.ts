import type {
  ViewerAnonSnapshot,
  ViewerHighlightRow,
  ViewerMentionRef,
  ViewerMentionRow,
  ViewerPostRow,
  ViewerPublicSnapshot,
  ViewerStoryRow,
} from "@igtrack/core";
import type { PublicWebDossier } from "./public-provider.js";
import type { AnonStoriesDossier, AnonStoryRow } from "./anonstories-provider.js";
import type { AnonMention } from "./anonstories.js";
import type { PublicHighlight } from "./ssr.js";

// Structural mapping only: dossiers keep their own shapes, the viewer receives
// explicit rows. Nothing is inferred and no missing value becomes 0.

function mentionRef(mention: AnonMention): ViewerMentionRef {
  return {
    username: mention.username,
    fullName: mention.fullName ?? null,
    isPrivate: mention.isPrivate ?? null,
    isVerified: mention.isVerified ?? null,
    isReshareAuthor: mention.isReshareAuthor === true,
  };
}

function storyRow(row: AnonStoryRow): ViewerStoryRow {
  return {
    id: row.storyId,
    publishedAt: row.publishedAt ?? null,
    age: row.age ?? null,
    mediaType: row.mediaType ?? null,
    mediaUrl: row.mediaUrl ?? null,
    thumbnailUrl: row.thumbnailUrl ?? null,
    linkUrl: row.linkUrl ?? null,
    mentions: row.mentions.map(mentionRef),
    reshareAuthor: row.reshareAuthor === undefined ? null : mentionRef(row.reshareAuthor),
  };
}

function highlightRow<S extends ViewerHighlightRow["contentsStatus"]>(
  id: string,
  title: string | null,
  coverUrl: string | null,
  contentsStatus: S,
  contentsReason: string | null,
  itemCount: number | null,
  droppedItems: number | null,
  items: ViewerStoryRow[],
  sources: string[],
  evidenceClasses: ViewerHighlightRow["evidenceClasses"],
): ViewerHighlightRow & { contentsStatus: S } {
  return {
    id,
    title,
    coverUrl,
    contentsStatus,
    contentsReason,
    itemCount,
    droppedItems,
    items,
    sources,
    evidenceClasses,
  };
}

export function publicViewerSnapshot(dossier: PublicWebDossier): ViewerPublicSnapshot {
  return {
    sourceId: dossier.source.sourceId,
    observedAt: dossier.observedAt,
    profileUrl: dossier.source.profileUrl,
    profile: {
      username: dossier.profile.username,
      fullName: dossier.profile.fullName ?? null,
      biography: dossier.profile.biography ?? null,
      profilePicUrl: dossier.profile.profilePicUrl ?? null,
      followerCount: dossier.profile.followerCount ?? null,
      followingCount: dossier.profile.followingCount ?? null,
      declaredPostCount:
        dossier.profile.postCount ?? dossier.counts.postsDeclared ?? null,
      isPrivate: dossier.profile.isPrivate ?? null,
      isVerified: dossier.profile.isVerified ?? null,
      highlights: dossier.profile.highlights.map((highlight: PublicHighlight) => ({
        id: highlight.id,
        title: highlight.title,
        coverUrl: highlight.coverUrl ?? null,
        ownerUsername: highlight.ownerUsername ?? null,
      })),
    },
    posts: dossier.posts.map(
      (post): ViewerPostRow => ({
        shortcode: post.shortcode,
        permalink: post.permalink ?? null,
        takenAt: post.takenAt ?? null,
        caption: post.caption ?? null,
        likeCount: post.likeCount ?? null,
        commentCount: post.commentCount ?? null,
        playCount: post.playCount ?? null,
        mediaType: post.mediaType ?? null,
        productType: post.mediaProductType ?? null,
        displayUrl: post.media.displayUrl ?? null,
        thumbnailUrl: post.media.thumbnailUrl ?? null,
        videoUrl: post.media.videoUrl ?? null,
        detailStatus: post.detailStatus,
        discoveredFrom: post.discoveredFrom,
        ownerUsername: post.owner?.username ?? null,
      }),
    ),
    counts: {
      postsDeclared: dossier.counts.postsDeclared ?? null,
      postsDiscovered: dossier.counts.postsDiscovered,
      postsEnriched: dossier.counts.postsEnriched,
      postsListingOnly: dossier.counts.postsListingOnly,
    },
    coverage: dossier.coverage.map((row) => ({
      subject: row.subject,
      status: row.status,
      value: row.value ?? null,
      reason: row.reason ?? null,
    })),
    gaps: dossier.gaps.map((gap) => ({
      subject: gap.subject,
      reason: gap.reason,
      howToImprove: gap.howToImprove,
    })),
    notes: [...dossier.notes],
  };
}

export function anonViewerSnapshot(dossier: AnonStoriesDossier): ViewerAnonSnapshot {
  return {
    sourceId: dossier.source.sourceId,
    observedAt: dossier.observedAt,
    account: {
      username: dossier.account.username,
      fullName: dossier.account.fullName ?? null,
      profilePicUrl: dossier.account.profilePicUrl ?? null,
      followerCount: dossier.account.followerCount ?? null,
      followingCount: dossier.account.followingCount ?? null,
      declaredPostCount: dossier.account.postCount ?? null,
      isPrivate: dossier.account.isPrivate ?? null,
      isVerified: dossier.account.isVerified ?? null,
    },
    stories: dossier.stories.map(storyRow),
    highlights: dossier.highlights.map((highlight) =>
      highlightRow(
        highlight.id,
        highlight.title ?? null,
        highlight.coverUrl ?? null,
        highlight.status,
        highlight.reason ?? null,
        highlight.itemCount,
        highlight.droppedItems,
        highlight.items.map(storyRow),
        [dossier.source.sourceId],
        ["PUBLIC_AGGREGATOR"],
      ),
    ),
    mentions: dossier.mentions.map(
      (mention): ViewerMentionRow => ({
        username: mention.username,
        fullName: mention.fullName ?? null,
        isPrivate: mention.isPrivate ?? null,
        isVerified: mention.isVerified ?? null,
        isReshareAuthor: mention.isReshareAuthor,
        seenIn: [...mention.seenIn],
        itemCount: mention.itemCount,
      }),
    ),
    counts: { ...dossier.counts },
    coverage: dossier.coverage.map((row) => ({
      subject: row.subject,
      status: row.status,
      value: row.value ?? null,
      reason: row.reason ?? null,
    })),
    gaps: dossier.gaps.map((gap) => ({
      subject: gap.subject,
      reason: gap.reason,
      howToImprove: gap.howToImprove,
    })),
    notes: [...dossier.notes],
  };
}
