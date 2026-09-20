import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CapabilityStatus, Confidence } from "@igtrack/core";
import { PublicWebProvider } from "../src/public/public-provider.js";
import {
  parsePostPage,
  parseProfilePage,
  parseReelsPage,
  reelsPageComplete,
} from "../src/public/ssr.js";

// ---------------------------------------------------------------------------
// Logged-out public pages, pinned from a real observation of @sel_win_ on
// 2026-10-28. The fixtures are the exact server-rendered objects (profile
// preloader, reels connection, media wrappers), trimmed of unrelated relay
// plumbing. They exercise the parts that break silently: split preloaders,
// the media wrapper, and fields only one listing carries.
// ---------------------------------------------------------------------------

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/public-web/${name}`, import.meta.url)), "utf8");

const PROFILE_HTML = fixture("profile.html");
const REELS_HTML = fixture("reels.html");
const POSTS = {
  DeORjjQO2hH: fixture("reel-DeORjjQO2hH.html"),
  DdyEBj3OmPG: fixture("reel-DdyEBj3OmPG.html"),
  Ddmh9ZxupCC: fixture("reel-Ddmh9ZxupCC.html"),
} as const;

const FIXED_NOW = new Date("2026-10-28T12:00:00.000Z");

function dossierProvider(): PublicWebProvider {
  const pages = new Map<string, string>([
    ["https://www.instagram.com/sel_win_/", PROFILE_HTML],
    ["https://www.instagram.com/sel_win_/reels/", REELS_HTML],
    ...Object.entries(POSTS).map(
      ([code, html]) =>
        [`https://www.instagram.com/reel/${code}/`, html] as [string, string],
    ),
  ]);
  return new PublicWebProvider({
    fetchHtml: async (url) => {
      const html = pages.get(url);
      if (html === undefined) throw new Error(`unexpected public URL: ${url}`);
      return html;
    },
    now: () => FIXED_NOW,
    maxPosts: 10,
  });
}

describe("public SSR parsers", () => {
  it("reads the profile preloader and merges a separately embedded timeline", () => {
    const parsed = parseProfilePage(PROFILE_HTML, "sel_win_");
    expect(parsed.gated).toBe(false);
    expect(parsed.notFound).toBe(false);
    expect(parsed.profile?.username).toBe("sel_win_");
    expect(parsed.profile?.pk).toBe("67606942730");
    expect(parsed.profile?.igId).toBe("17841467641920867");
    expect(parsed.profile?.fullName).toBe("Aswin S");
    expect(parsed.profile?.followerCount).toBe(361);
    expect(parsed.profile?.followingCount).toBe(515);
    // all_media_count was null on this page; the count comes from og:description
    // and the dossier names that source instead of pretending it was a field.
    expect(parsed.profile?.postCount).toBe(3);
    expect(parsed.profile?.postCountSource).toBe("og_description");
    // JSON escapes decode to the actual Khmer text and emoji, not mojibake:
    // the raw payload matters as evidence, so this pins the encoding too.
    expect(parsed.profile?.biography).toBe("ប៉ា..🤍\n@serpaix.ai");
    expect(parsed.profile?.bioLinks.map((b) => b.url)).toEqual([
      "https://www.linkedin.com/in/aswin-s-cwt",
      "https://serpaix.xyz/",
    ]);
    expect(parsed.profile?.highlights.map((h) => h.title)).toHaveLength(2);
    // The profile node carried no timeline connection; it lives in a separate
    // preloader. Dropping it would silently lose every discovered item.
    expect(parsed.timeline.map((p) => p.code)).toEqual([
      "DeORjjQO2hH",
      "DdyEBj3OmPG",
      "Ddmh9ZxupCC",
    ]);
    expect(parsed.timelineComplete).toBe(true);
  });

  it("reads the reels tab with the counts only that listing publishes", () => {
    const reels = parseReelsPage(REELS_HTML);
    expect(reels.map((p) => p.code)).toEqual([
      "DeORjjQO2hH",
      "DdyEBj3OmPG",
      "Ddmh9ZxupCC",
    ]);
    expect(reels.map((p) => p.playCount)).toEqual([501, 529, 742]);
    expect(reels.map((p) => p.likeCount)).toEqual([8, 3, 3]);
    expect(reels.every((p) => p.mediaProductType === "clips")).toBe(true);
    expect(reelsPageComplete(REELS_HTML)).toBe(true);
  });

  it("unwraps the media page and reads the nested media node", () => {
    const parsed = parsePostPage(POSTS.DeORjjQO2hH, "DeORjjQO2hH");
    expect(parsed.media?.code).toBe("DeORjjQO2hH");
    expect(parsed.media?.postId).toBe("4003214328604616775");
    expect(parsed.media?.takenAt).toBe("2026-10-08T06:21:02.000Z");
    expect(parsed.media?.likeCount).toBe(8);
    expect(parsed.media?.commentCount).toBe(0);
    // The media page has no play_count; it must stay absent here so the
    // dossier can attribute the listing fallback by name.
    expect(parsed.media?.playCount).toBeUndefined();
    expect(parsed.media?.mediaType).toBe("VIDEO");
    expect(parsed.media?.mediaProductType).toBe("clips");
    expect(parsed.media?.owner?.username).toBe("serpaix.ai");
    expect(parsed.media?.coauthors.map((c) => c.username)).toEqual(["sel_win_"]);
    expect(parsed.media?.location?.name).toBe("Bangalore, India");
    expect(parsed.media?.taggedUsers.map((t) => t.user.username)).toEqual(["sel_win_"]);
    expect(parsed.media?.music?.kind).toBe("licensed");
    expect(parsed.meta.url).toBe(
      "https://www.instagram.com/serpaix.ai/reel/DeORjjQO2hH/",
    );
  });
});

describe("PublicWebProvider dossier", () => {
  it("assembles every public item and names the fields the listing had to fill", async () => {
    const result = await dossierProvider().getDossier("sel_win_");
    expect(result.status).toBe(CapabilityStatus.PARTIAL);
    const dossier = result.dossier!;
    expect(dossier.username).toBe("sel_win_");
    expect(dossier.source.sourceId).toBe("public:web:v1");
    expect(dossier.source.retrieval).toBe("injected-transport");
    expect(dossier.profile.followerCount).toBe(361);
    expect(dossier.profile.followingCount).toBe(515);
    expect(dossier.profile.postCount).toBe(3);
    expect(dossier.profile.biographyMentions).toEqual(["serpaix.ai"]);
    expect(dossier.counts).toEqual({
      postsDeclared: 3,
      postsDiscovered: 3,
      postsEnriched: 3,
      postsListingOnly: 0,
    });

    expect(dossier.posts.map((p) => p.shortcode)).toEqual([
      "DeORjjQO2hH",
      "DdyEBj3OmPG",
      "Ddmh9ZxupCC",
    ]);
    expect(dossier.posts.map((p) => p.playCount)).toEqual([501, 529, 742]);
    for (const post of dossier.posts) {
      expect(post.detailStatus).toBe("ENRICHED");
      expect(post.mediaType).toBe("VIDEO");
      // Both listings exposed every item; the merge must not lose either.
      expect(post.discoveredFrom.sort()).toEqual(["profile_timeline", "reels_tab"]);
      // The detail page does not publish play_count, so its provenance travels
      // with the value instead of passing it off as page metadata.
      expect(post.listingFallbackFields).toEqual(["playCount"]);
      expect(post.sourceUrl).toBe(`https://www.instagram.com/reel/${post.shortcode}/`);
      expect(post.permalink).toBe(
        `https://www.instagram.com/serpaix.ai/reel/${post.shortcode}/`,
      );
    }
  });

  it("reports gated surfaces as UNAVAILABLE with a reason, never as empty data", async () => {
    const result = await dossierProvider().getDossier("sel_win_");
    const dossier = result.dossier!;
    const bySubject = new Map(dossier.coverage.map((row) => [row.subject, row]));
    for (const subject of [
      "Comment lists",
      "Likers",
      "Follower / following rosters",
      "Tagged media",
      "Stories",
      "Insights",
      "Highlight contents",
    ]) {
      expect(bySubject.get(subject)?.status).toBe("UNAVAILABLE");
      expect(bySubject.get(subject)?.reason).toBeTruthy();
    }
    expect(dossier.gaps.map((g) => g.subject)).toContain("comment lists");
  });

  it("refuses impossible usernames before building a URL", async () => {
    const provider = new PublicWebProvider({ fetchHtml: async () => {
      throw new Error("transport must not run");
    } });
    const result = await provider.resolveAccount("not a username!!");
    expect(result.status).toBe("ERROR");
    expect(result.error?.kind).toBe("ACCOUNT_NOT_FOUND");
    expect(result.error?.retryable).toBe(false);
  });
});

describe("PublicWebProvider media ownership", () => {
  // The fixtures are a collaboration: the media is owned by @serpaix.ai and
  // @sel_win_ is a credited coauthor. Instagram's logged-out timeline also
  // returns media owned by other accounts (seen on @nasa), so ownership is
  // decided from evidence, never assumed from the fact that an item appeared
  // in the target's listing.
  const foreignPage = POSTS.DdyEBj3OmPG.replaceAll(
    '"username":"sel_win_"',
    '"username":"someone.else"',
  );

  function pages(): Map<string, string> {
    return new Map<string, string>([
      ["https://www.instagram.com/sel_win_/", PROFILE_HTML],
      ["https://www.instagram.com/sel_win_/reels/", REELS_HTML],
      ...Object.entries(POSTS).map(
        ([code, html]) =>
          [`https://www.instagram.com/reel/${code}/`, html] as [string, string],
      ),
    ]);
  }

  function provider(map: Map<string, string>): PublicWebProvider {
    return new PublicWebProvider({
      fetchHtml: async (url) => {
        const html = map.get(url);
        if (html === undefined) throw new Error(`unexpected public URL: ${url}`);
        return html;
      },
      now: () => FIXED_NOW,
      maxPosts: 10,
    });
  }

  it("keeps co-authored media the target appears on, even when another account owns it", async () => {
    const result = await provider(pages()).getPublicPosts({ username: "sel_win_" });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    expect(result.data?.map((post) => post.shortcode)).toEqual([
      "DeORjjQO2hH",
      "DdyEBj3OmPG",
      "Ddmh9ZxupCC",
    ]);
  });

  it("never records media owned by another account as the target's posts", async () => {
    const map = pages();
    map.set("https://www.instagram.com/reel/DdyEBj3OmPG/", foreignPage);
    const result = await provider(map).getPublicPosts({ username: "sel_win_" });
    expect(result.status).toBe(CapabilityStatus.PARTIAL);
    expect(result.data?.map((post) => post.shortcode)).toEqual([
      "DeORjjQO2hH",
      "Ddmh9ZxupCC",
    ]);
    expect(result.note).toContain("owned by other accounts");
    expect(result.note).not.toContain("failed to enrich");
  });

  it("declares excluded other-account media in the dossier instead of listing it", async () => {
    const map = pages();
    map.set("https://www.instagram.com/reel/DdyEBj3OmPG/", foreignPage);
    const result = await provider(map).getDossier("sel_win_");
    const dossier = result.dossier!;
    expect(dossier.posts.map((post) => post.shortcode)).toEqual([
      "DeORjjQO2hH",
      "Ddmh9ZxupCC",
    ]);
    expect(dossier.counts.postsDiscovered).toBe(2);
    expect(dossier.counts.postsSkippedForeign).toBe(1);
    expect(dossier.counts.postsSkippedUnverified).toBeUndefined();
    expect(dossier.gaps.map((gap) => gap.subject)).toContain(
      "media owned by other accounts",
    );
    expect(
      dossier.coverage.find((row) => row.subject === "Posts")?.value,
    ).toContain("not this account's");
  });

  it("drops listing-only items whose ownership cannot be established", async () => {
    const map = pages();
    // The reels tab omits the owner and the profile timeline is stripped of
    // its user objects here; with the media page unreadable nothing proves
    // ownership, so the item is excluded and named rather than attributed.
    map.set(
      "https://www.instagram.com/sel_win_/",
      PROFILE_HTML.replaceAll(
        '"user":{"username":"serpaix.ai","id":"17841423838852076"}',
        "",
      ),
    );
    map.delete("https://www.instagram.com/reel/Ddmh9ZxupCC/");
    const result = await provider(map).getDossier("sel_win_");
    const dossier = result.dossier!;
    expect(dossier.posts.map((post) => post.shortcode)).toEqual([
      "DeORjjQO2hH",
      "DdyEBj3OmPG",
    ]);
    expect(dossier.counts.postsSkippedUnverified).toBe(1);
    expect(dossier.gaps.map((gap) => gap.subject)).toContain(
      "media with an unobservable owner",
    );
  });
});

describe("PublicWebProvider enrichment budget", () => {
  it("records listing-only rows when the budget ends instead of losing the batch", async () => {
    // The fixture listings were trimmed of user and timestamp objects; inject
    // both so ownership and publication time are provable from the listing
    // alone — exactly the case the budget fallback serves.
    const reelsWithOwner = Object.keys(POSTS).reduce(
      (html, code) =>
        html.replace(
          `"code":"${code}"`,
          `"taken_at":1759818062,"user":{"username":"sel_win_"},"code":"${code}"`,
        ),
      REELS_HTML,
    );
    let detailFetches = 0;
    const provider = new PublicWebProvider({
      fetchHtml: async (url) => {
        if (url === "https://www.instagram.com/sel_win_/") return PROFILE_HTML;
        if (url === "https://www.instagram.com/sel_win_/reels/") return reelsWithOwner;
        detailFetches += 1;
        throw new Error(`media pages must not be read once the budget ended: ${url}`);
      },
      now: () => FIXED_NOW,
      maxPosts: 10,
      enrichBudgetMs: 0,
    });
    const result = await provider.getPublicPosts({ username: "sel_win_" });
    expect(detailFetches).toBe(0);
    expect(result.status).toBe(CapabilityStatus.PARTIAL);
    expect(result.data?.map((post) => post.shortcode).sort()).toEqual([
      "Ddmh9ZxupCC",
      "DdyEBj3OmPG",
      "DeORjjQO2hH",
    ]);
    expect(result.data?.every((post) => post.meta.confidence === Confidence.MEDIUM)).toBe(
      true,
    );
    expect(result.note).toContain("enrichment budget");
  });
});

describe("PublicWebProvider single post", () => {
  it("reads a post from its own permalink, with the comment count observed and the list refused", async () => {
    const result = await dossierProvider().getPublicPost({
      shortcode: "DeORjjQO2hH",
      kind: "reel",
      form: "POST_URL",
    });
    expect(result.status).toBe(CapabilityStatus.AVAILABLE);
    const single = result.data!;
    expect(single.shortcode).toBe("DeORjjQO2hH");
    expect(single.kind).toBe("reel");
    expect(single.source).toEqual({
      sourceId: "public:web:v1",
      kind: "PUBLIC_WEB",
      postUrl: "https://www.instagram.com/reel/DeORjjQO2hH/",
      retrieval: "injected-transport",
    });
    // A direct permalink read is not a listing merge: nothing was filled from
    // a grid row, and the dossier must not claim a fallback it never used.
    expect(single.post.detailStatus).toBe("ENRICHED");
    expect(single.post.discoveredFrom).toEqual([]);
    expect(single.post.listingFallbackFields).toEqual([]);
    expect(single.post.owner?.username).toBe("serpaix.ai");
    expect(single.post.coauthors.map((c) => c.username)).toEqual(["sel_win_"]);
    expect(single.post.mediaType).toBe("VIDEO");
    expect(single.post.likeCount).toBe(8);
    // The page published 0 comments — that observed count must not be turned
    // into an empty comment list, and the page did not declare commenting
    // disabled, so that flag stays absent rather than being inferred from 0.
    expect(single.post.commentCount).toBe(0);
    expect(single.post.commentsDisabled).toBeUndefined();
    expect(single.comments.status).toBe("UNAVAILABLE");
    expect(single.comments.reason).toContain("comment COUNT but not the comment list");
    expect(single.notes.some((n) => n.includes("comment count is what the media page published"))).toBe(true);
    expect(result.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rawReference).toBe("https://www.instagram.com/reel/DeORjjQO2hH/");
  });

  it("reports a removed post as SOURCE_NOT_FOUND without inventing fields", async () => {
    const provider = new PublicWebProvider({
      fetchHtml: async () => "<html><body>Sorry, this page isn't available.</body></html>",
      now: () => FIXED_NOW,
    });
    const result = await provider.getPublicPost({
      shortcode: "CxYz123AbCd",
      kind: "p",
      form: "POST_URL",
    });
    expect(result.status).toBe(CapabilityStatus.ERROR);
    expect(result.data).toBeUndefined();
    expect(result.error?.kind).toBe("SOURCE_NOT_FOUND");
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toContain("not available");
  });
});
