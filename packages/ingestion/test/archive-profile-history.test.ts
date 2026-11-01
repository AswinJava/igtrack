import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_PROFILE_SOURCE_ID,
  fetchArchivedProfileHistory,
  type ArchiveHttpResponse,
} from "../src/public/archive-profile-history.js";

// ---------------------------------------------------------------------------
// Reading a public archive's captures of one profile page.
//
// These pin the three things that quietly go wrong in archive reading:
//   * a capture that cannot be read is a FAILURE TO LOOK — it must never be
//     folded into "no history";
//   * a rounded "12.3K followers" in prose is not a count — only exact
//     integers from the embedded payload are recorded;
//   * a login wall that happens to be listed as a profile capture must not
//     become a point about the account.
// The transport is injected, so no test touches the network.
// ---------------------------------------------------------------------------

const USERNAME = "small.account";
const NOW = new Date("2026-10-30T00:00:00.000Z");

function response(
  body: string | Uint8Array,
  init: { status?: number; contentLength?: string | null } = {},
): ArchiveHttpResponse {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  return streaming([bytes], init);
}

/**
 * A response that hands out one chunk per pull. The cap has to bite in the
 * middle of a stream, so a test that wants to prove it counts the pulls rather
 * than trusting the body was never measured.
 */
function streaming(
  chunks: Uint8Array[],
  init: { status?: number; contentLength?: string | null } = {},
  hooks: { pull?: () => void } = {},
): ArchiveHttpResponse {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  let next = 0;
  return {
    status: init.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length"
          ? (init.contentLength ?? String(size))
          : null,
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next >= chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[next];
        next += 1;
        if (chunk !== undefined) {
          hooks.pull?.();
          controller.enqueue(chunk);
        }
      },
    }),
  };
}

function page(username: string, counts: { followers: number; following: number; posts: number }): string {
  return (
    `<html><head><script>window.__data={"username":"${username}",` +
    `"follower_count":${counts.followers},"following_count":${counts.following},` +
    `"media_count":${counts.posts}}</script></head></html>`
  );
}

const CDX_URL_MARKER = "web.archive.org/cdx/search/cdx";

function transport(plan: {
  cdx: string | ArchiveHttpResponse;
  captures: Record<string, ArchiveHttpResponse | Error>;
}): {
  fetchImpl: (url: string, init: { signal: AbortSignal; redirect: "manual" }) => Promise<ArchiveHttpResponse>;
  seen: string[];
  inits: Array<{ signal: AbortSignal; redirect: string }>;
} {
  const seen: string[] = [];
  const inits: Array<{ signal: AbortSignal; redirect: string }> = [];
  return {
    seen,
    inits,
    fetchImpl: async (url, init) => {
      seen.push(url);
      inits.push(init);
      if (url.includes(CDX_URL_MARKER))
        return typeof plan.cdx === "string" ? response(plan.cdx) : plan.cdx;
      const match = plan.captures[url];
      if (match === undefined) throw new Error(`unexpected URL: ${url}`);
      if (match instanceof Error) throw match;
      return match;
    },
  };
}

function cdx(rows: Array<[string, string]>): string {
  return JSON.stringify([["timestamp", "original"], ...rows]);
}

describe("archived profile count history", () => {
  it("reads exact counts from captures and returns them oldest-first", async () => {
    const later = "https://web.archive.org/web/20261020120000id_/https://www.instagram.com/small.account/";
    const earlier = "https://web.archive.org/web/20261001120000id_/https://www.instagram.com/small.account/";
    const plan = transport({
      cdx: cdx([
        ["20261020120000", "https://www.instagram.com/small.account/"],
        ["20261001120000", "https://www.instagram.com/small.account/"],
      ]),
      captures: {
        [later]: response(page(USERNAME, { followers: 280, following: 310, posts: 41 })),
        [earlier]: response(page(USERNAME, { followers: 265, following: 300, posts: 38 })),
      },
    });

    const result = await fetchArchivedProfileHistory(USERNAME, {
      now: NOW,
      windowDays: 40,
      fetchImpl: plan.fetchImpl,
    });

    expect(result.state).toBe("OBSERVED");
    expect(result.capturesFound).toBe(2);
    expect(result.capturesWithCounts).toBe(2);
    expect(result.points.map((p) => p.capturedAt.toISOString())).toEqual([
      "2026-10-01T12:00:00.000Z",
      "2026-10-20T12:00:00.000Z",
    ]);
    expect(result.points.map((p) => p.followerCount)).toEqual([265, 280]);
    expect(result.points.map((p) => p.followingCount)).toEqual([300, 310]);
    expect(result.points.map((p) => p.postCount)).toEqual([38, 41]);
    // Every point carries the hash of the decoded page for its evidence row.
    for (const point of result.points) expect(point.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    // The index query is bounded by the requested window and asks only the
    // archive host for a JSON listing of exact capture rows.
    expect(plan.seen[0]).toContain("from=20260920");
    expect(plan.seen[0]).toContain("to=20261030");
    expect(result.reason).toBeNull();
  });

  it("decodes a gzip-compressed capture body", async () => {
    const capture = "https://web.archive.org/web/20261010120000id_/https://www.instagram.com/small.account/";
    const compressed = new Uint8Array(
      gzipSync(Buffer.from(page(USERNAME, { followers: 270, following: 305, posts: 40 }))),
    );
    const plan = transport({
      cdx: cdx([["20261010120000", "https://www.instagram.com/small.account/"]]),
      captures: { [capture]: response(compressed, { contentLength: String(compressed.byteLength) }) },
    });

    const result = await fetchArchivedProfileHistory(USERNAME, { now: NOW, fetchImpl: plan.fetchImpl });
    expect(result.state).toBe("OBSERVED");
    expect(result.points[0]?.followerCount).toBe(270);
  });

  it("reports a capture without exact counts as skipped, never as a point", async () => {
    const capture = "https://web.archive.org/web/20261010120000id_/https://www.instagram.com/small.account/";
    const rounded =
      `<html><head><link rel="canonical" href="https://www.instagram.com/small.account/"></head>` +
      `<body>small.account — 12.3K followers, 1,204 following</body></html>`;
    const plan = transport({
      cdx: cdx([["20261010120000", "https://www.instagram.com/small.account/"]]),
      captures: { [capture]: response(rounded) },
    });

    const result = await fetchArchivedProfileHistory(USERNAME, { now: NOW, fetchImpl: plan.fetchImpl });

    expect(result.state).toBe("EMPTY");
    expect(result.points).toEqual([]);
    expect(result.capturesWithoutCounts).toBe(1);
    expect(result.capturesWithCounts).toBe(0);
    // The rounded prose is refused by name, so a reader knows why.
    expect(result.reason).toContain("none carried an exact count");
    expect(result.notes.join(" ")).toContain("rounded prose");
  });

  it("treats a login wall as an unreadable capture, not as evidence about the account", async () => {
    const capture = "https://web.archive.org/web/20261010120000id_/https://www.instagram.com/small.account/";
    const walled = `<html><body>Log in to Instagram to see this profile</body></html>`;
    const plan = transport({
      cdx: cdx([["20261010120000", "https://www.instagram.com/small.account/"]]),
      captures: { [capture]: response(walled) },
    });

    const result = await fetchArchivedProfileHistory(USERNAME, { now: NOW, fetchImpl: plan.fetchImpl });

    expect(result.state).toBe("UNAVAILABLE");
    expect(result.capturesFailed).toBe(1);
    expect(result.points).toEqual([]);
    expect(result.reason).toContain("none could be read");
    expect(result.notes.join(" ")).toContain("login wall");
  });

  it("counts one unreadable capture as a failure to look, not an empty history", async () => {
    // The all-failed case is easy to get right. The one that lies is a mix:
    // most captures read fine but carried no count, while one hit a login
    // wall. "Nothing was recorded" is true either way, but only the unreadable
    // capture makes "there was nothing to record" unprovable.
    const walled =
      "https://web.archive.org/web/20261010120000id_/https://www.instagram.com/small.account/";
    const rounded =
      "https://web.archive.org/web/20261011120000id_/https://www.instagram.com/small.account/";
    const plan = transport({
      cdx: cdx([
        ["20261010120000", "https://www.instagram.com/small.account/"],
        ["20261011120000", "https://www.instagram.com/small.account/"],
      ]),
      captures: {
        [walled]: response(`<html><body>Log in to Instagram to see this profile</body></html>`),
        [rounded]: response(
          `<html><head><link rel="canonical" href="https://www.instagram.com/small.account/"></head>` +
            `<body>small.account — 12.3K followers, 1,204 following</body></html>`,
        ),
      },
    });

    const result = await fetchArchivedProfileHistory(USERNAME, { now: NOW, fetchImpl: plan.fetchImpl });

    expect(result.capturesFailed).toBe(1);
    expect(result.capturesWithoutCounts).toBe(1);
    expect(result.points).toEqual([]);
    expect(result.state).toBe("UNAVAILABLE");
    expect(result.reason).toContain("failure to look");
    expect(result.reason).not.toContain("none carried an exact count");
  });

  it("refuses an index redirect instead of reading another host's listing", async () => {
    // Following a redirect is how "the archive said this" quietly becomes
    // "whatever server answered last said this". The refusal has to be visible
    // in the reason and real in the request.
    const plan = transport({ cdx: response("", { status: 302 }), captures: {} });

    const result = await fetchArchivedProfileHistory(USERNAME, { now: NOW, fetchImpl: plan.fetchImpl });

    expect(result.state).toBe("UNAVAILABLE");
    expect(result.reason).toContain("redirect off the archive host");
    expect(result.reason).toContain("failure to look");
    expect(result.points).toEqual([]);
    for (const init of plan.inits) expect(init.redirect).toBe("manual");
  });

  it("skips a capture that redirects off the archive host", async () => {
    const capture = "https://web.archive.org/web/20261010120000id_/https://www.instagram.com/small.account/";
    const plan = transport({
      cdx: cdx([["20261010120000", "https://www.instagram.com/small.account/"]]),
      captures: { [capture]: response(`<html><body>not the archive</body></html>`, { status: 301 }) },
    });

    const result = await fetchArchivedProfileHistory(USERNAME, { now: NOW, fetchImpl: plan.fetchImpl });

    expect(result.capturesFailed).toBe(1);
    expect(result.points).toEqual([]);
    expect(result.state).toBe("UNAVAILABLE");
    expect(result.notes.join(" ")).toContain("redirect");
    for (const init of plan.inits) expect(init.redirect).toBe("manual");
  });

  it("skips a capture above the byte cap and says so", async () => {
    const capture = "https://web.archive.org/web/20261010120000id_/https://www.instagram.com/small.account/";
    const plan = transport({
      cdx: cdx([["20261010120000", "https://www.instagram.com/small.account/"]]),
      captures: { [capture]: response("x", { contentLength: "104857600" }) },
    });

    const result = await fetchArchivedProfileHistory(USERNAME, {
      now: NOW,
      fetchImpl: plan.fetchImpl,
      maxBytes: 1024,
    });

    expect(result.state).toBe("UNAVAILABLE");
    expect(result.capturesFailed).toBe(1);
    expect(result.notes.join(" ")).toContain("passed the 1024-byte cap");
  });

  it("an unreachable index is UNAVAILABLE, never EMPTY", async () => {
    const plan = transport({ cdx: "", captures: {} });
    const failing = async () => {
      throw new Error("getaddrinfo ENOTFOUND web.archive.org");
    };

    const result = await fetchArchivedProfileHistory(USERNAME, {
      now: NOW,
      fetchImpl: (url, init) => (url.includes(CDX_URL_MARKER) ? failing() : plan.fetchImpl(url, init)),
    });

    expect(result.state).toBe("UNAVAILABLE");
    expect(result.reason).toContain("failure to look");
    expect(result.points).toEqual([]);
  });

  it("refuses an index body that is not JSON without quoting it", async () => {
    // An archive error page is HTML, and the JSON SyntaxError text quotes a
    // slice of whatever it choked on. Response bytes are not operator output:
    // the reason names the shape of the answer, never its content.
    const body = `<html>Unexpected {"token":"SECRET"} at position 0</html>`;
    const plan = transport({ cdx: response(body), captures: {} });

    const result = await fetchArchivedProfileHistory(USERNAME, { now: NOW, fetchImpl: plan.fetchImpl });

    expect(result.state).toBe("UNAVAILABLE");
    expect(result.reason).toContain("not the JSON list it documents");
    expect(result.reason).toContain("failure to look");
    expect(result.reason).not.toContain("SECRET");
    expect(result.reason).not.toContain("<html>");
    expect(result.points).toEqual([]);
  });

  it("an index with no captures is EMPTY with an archive-coverage reason", async () => {
    const plan = transport({ cdx: "[]", captures: {} });
    const result = await fetchArchivedProfileHistory(USERNAME, { now: NOW, fetchImpl: plan.fetchImpl });

    expect(result.state).toBe("EMPTY");
    expect(result.capturesFound).toBe(0);
    expect(result.reason).toContain("absence of archive coverage");
    expect(result.reason).not.toContain("inactive");
  });

  it("filters captures that are not the profile page", async () => {
    const plan = transport({
      cdx: cdx([
        ["20261001120000", "https://www.instagram.com/small.account/reels/"],
        ["20261002120000", "https://www.instagram.com/someone.else/"],
      ]),
      captures: {},
    });

    const result = await fetchArchivedProfileHistory(USERNAME, { now: NOW, fetchImpl: plan.fetchImpl });

    expect(result.state).toBe("EMPTY");
    expect(result.capturesFound).toBe(0);
    expect(plan.seen).toHaveLength(1); // the index query only — no capture was read
  });

  it("rejects an invalid username before any request is made", async () => {
    let called = false;
    const result = await fetchArchivedProfileHistory("not a username", {
      now: NOW,
      fetchImpl: async () => {
        called = true;
        return response("[]");
      },
    });

    expect(result.state).toBe("UNAVAILABLE");
    expect(called).toBe(false);
    expect(result.points).toEqual([]);
    expect(result.reason).toContain("not a valid Instagram username");
  });

  it("refuses to buffer an oversized archive index", async () => {
    // The index is read under the same cap as a capture. A lying Content-Length
    // must not turn "bounded read" into "buffer the whole response and check
    // afterwards": the stream is refused in the middle, and the refusal says so.
    const big = cdx(
      Array.from({ length: 200 }, (_, i): [string, string] => [
        `202601010000${String(i).padStart(2, "0")}`,
        "https://www.instagram.com/small.account/",
      ]),
    );
    const bytes = new TextEncoder().encode(big);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 16) {
      chunks.push(bytes.slice(offset, offset + 16));
    }
    let pulls = 0;
    const result = await fetchArchivedProfileHistory(USERNAME, {
      now: NOW,
      maxBytes: 64,
      fetchImpl: async () =>
        // Content-Length claims eight bytes; the stream keeps coming.
        streaming(chunks, { contentLength: "8" }, { pull: () => (pulls += 1) }),
    });

    expect(chunks.length).toBeGreaterThan(10);
    expect(result.state).toBe("UNAVAILABLE");
    expect(result.reason).toContain("index was not read");
    expect(result.reason).toContain("passed the 64-byte cap");
    expect(result.reason).toContain("failure to look");
    expect(result.consultedUrls).toHaveLength(1);
    // The read stopped where the cap bit instead of draining the stream: the
    // bytes past it were never handed over, so they were never buffered.
    expect(pulls).toBeLessThanOrEqual(8);
  });

  it("refuses a capture that unpacks past the cap rather than decompressing it whole", async () => {
    // A few hundred stored bytes can expand far past the cap. The size check on
    // the compressed body cannot see that, so the cap is applied to the
    // decompressed output too — and the capture is skipped, never guessed at.
    const capture =
      "https://web.archive.org/web/20261010120000id_/https://www.instagram.com/small.account/";
    const packed = new Uint8Array(
      gzipSync(Buffer.from(page(USERNAME, { followers: 270, following: 305, posts: 40 }).repeat(4000))),
    );
    const plan = transport({
      cdx: cdx([["20261010120000", "https://www.instagram.com/small.account/"]]),
      captures: { [capture]: response(packed, { contentLength: String(packed.byteLength) }) },
    });

    const result = await fetchArchivedProfileHistory(USERNAME, {
      now: NOW,
      maxBytes: 4096,
      fetchImpl: plan.fetchImpl,
    });

    // Under the cap stored, far past it unpacked: only the output limit sees this.
    expect(packed.byteLength).toBeLessThan(4096);
    expect(result.capturesFound).toBe(1);
    expect(result.capturesRead).toBe(1);
    expect(result.capturesFailed).toBe(1);
    expect(result.points).toEqual([]);
    expect(result.notes.join(" ")).toContain("unpacked past the 4096-byte cap");
  });

  it("names its source id so evidence rows stay distinguishable", () => {
    expect(ARCHIVE_PROFILE_SOURCE_ID).toBe("archive:wayback:v1");
  });
});
