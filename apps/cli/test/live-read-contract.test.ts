import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CapabilityStatus, Confidence, SourceKind, type PostReference } from "@igtrack/core";
import { AnonStoriesProvider, PublicWebProvider } from "@igtrack/ingestion";
import {
  liveReadMeta,
  opAnonstoriesDossier,
  opPublicDossier,
  opPublicPost,
  opViewer,
  viewerMeta,
} from "../src/tools.js";
import { buildServer } from "../src/mcp/server.js";
import { CliError } from "../src/output.js";
import {
  NO_BROWSER,
  OBSERVED,
  anonDossier,
  fakeAnon,
  fakePublic,
  publicDossier,
  publicSinglePost,
} from "./live-read-fakes.js";

// ---------------------------------------------------------------------------
// The login-free reads (public page, one post, the aggregator, the viewer) are
// the four operations the CLI and MCP used to implement twice. One contract,
// asserted from both surfaces: the same refusal, the same exit code, the same
// evidence label, and only one place that constructs a provider.
// ---------------------------------------------------------------------------

describe("opPublicDossier", () => {
  it("returns the provider's dossier as observed, with the username it was given", async () => {
    const seen: string[] = [];
    const dossier = publicDossier();
    const provider: Pick<PublicWebProvider, "getDossier" | "getPublicPost"> = {
      getDossier: async (username) => {
        seen.push(username);
        return { status: CapabilityStatus.AVAILABLE, observedAt: OBSERVED, dossier };
      },
      getPublicPost: fakePublic().getPublicPost,
    };
    const read = await opPublicDossier({ username: "@aurora.wilde" }, { publicProvider: provider });
    expect(seen).toEqual(["@aurora.wilde"]);
    // The operations layer passes the observation through: no field added, no
    // count rewritten on the way to the terminal.
    expect(read).toBe(dossier);
    expect(read.counts.postsDeclared).toBe(12);
    expect(read.profile.username).toBe("aurora.wilde");
  });

  it("carries the provider's own typed refusal instead of an empty dossier", async () => {
    const provider: Pick<PublicWebProvider, "getDossier" | "getPublicPost"> = {
      getDossier: async () => ({
        status: CapabilityStatus.ERROR,
        observedAt: OBSERVED,
        error: { kind: "AUTH_REQUIRED", message: "Instagram served a login page.", retryable: false },
      }),
      getPublicPost: fakePublic().getPublicPost,
    };
    await expect(opPublicDossier({ username: "aurora.wilde" }, { publicProvider: provider })).rejects.toMatchObject(
      {
        name: "CliError",
        code: "AUTH_REQUIRED",
        message: "Instagram served a login page.",
        exitCode: 1,
      },
    );
  });

  it("refuses before requesting anything when no browser can be found", async () => {
    const err = await opPublicDossier({ username: "aurora.wilde", chromePath: NO_BROWSER }).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((err as CliError).exitCode).toBe(3);
    // The two halves of the honest sentence: the provider's own reason (which
    // states no request was made) and the operations layer's confirmation.
    expect((err as CliError).message).toContain("No request was made.");
    expect((err as CliError).message).toContain("Nothing was requested.");
  });
});

describe("opPublicPost", () => {
  it("refuses a URL that is not a post before the provider is reached", async () => {
    let calls = 0;
    const provider: Pick<PublicWebProvider, "getDossier" | "getPublicPost"> = {
      getDossier: fakePublic().getDossier,
      getPublicPost: async () => {
        calls += 1;
        return {
          status: CapabilityStatus.AVAILABLE,
          observedAt: OBSERVED,
          source: { sourceId: "public:web:v1", kind: SourceKind.PUBLIC_WEB },
          confidence: Confidence.HIGH,
        };
      },
    };
    await expect(
      opPublicPost({ url: "https://www.instagram.com/aurora.wilde/" }, { publicProvider: provider }),
    ).rejects.toMatchObject({ code: "USAGE", exitCode: 2 });
    expect(calls).toBe(0);
  });

  it("reads the permalink the URL names and returns its data", async () => {
    const references: PostReference[] = [];
    const single = publicSinglePost({ shortcode: "BBB222", kind: "reel" });
    const provider: Pick<PublicWebProvider, "getDossier" | "getPublicPost"> = {
      getDossier: fakePublic().getDossier,
      getPublicPost: async (reference) => {
        references.push(reference);
        return {
          status: CapabilityStatus.AVAILABLE,
          observedAt: OBSERVED,
          source: { sourceId: "public:web:v1", kind: SourceKind.PUBLIC_WEB },
          confidence: Confidence.HIGH,
          data: single,
        };
      },
    };
    const post = await opPublicPost(
      { url: "https://www.instagram.com/reel/BBB222/" },
      { publicProvider: provider },
    );
    expect(references).toEqual([{ shortcode: "BBB222", kind: "reel", form: "POST_URL" }]);
    expect(post.shortcode).toBe("BBB222");
  });

  it("keeps an unavailable post a refusal, with the unavailable exit code", async () => {
    const provider: Pick<PublicWebProvider, "getDossier" | "getPublicPost"> = {
      getDossier: fakePublic().getDossier,
      getPublicPost: async () => ({
        status: CapabilityStatus.UNAVAILABLE,
        observedAt: OBSERVED,
        source: { sourceId: "public:web:v1", kind: SourceKind.PUBLIC_WEB },
        confidence: Confidence.UNKNOWN,
        note: "The permalink served no media payload.",
      }),
    };
    const err = await opPublicPost(
      { url: "https://www.instagram.com/p/AAA111/" },
      { publicProvider: provider },
    ).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("PUBLIC_WEB_FAILED");
    expect((err as CliError).message).toBe("The permalink served no media payload.");
    expect((err as CliError).exitCode).toBe(3);
  });

  it("reports a rate limit as the platform answer it is, not an empty post", async () => {
    const provider: Pick<PublicWebProvider, "getDossier" | "getPublicPost"> = {
      getDossier: fakePublic().getDossier,
      getPublicPost: async () => ({
        status: CapabilityStatus.ERROR,
        observedAt: OBSERVED,
        source: { sourceId: "public:web:v1", kind: SourceKind.PUBLIC_WEB },
        confidence: Confidence.UNKNOWN,
        error: { kind: "RATE_LIMITED", message: "Instagram rate-limited this read.", retryable: true },
      }),
    };
    await expect(
      opPublicPost({ url: "https://www.instagram.com/p/AAA111/" }, { publicProvider: provider }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", exitCode: 1 });
  });
});

describe("opAnonstoriesDossier", () => {
  it("forwards the highlight bound and returns the aggregator dossier", async () => {
    const options: { maxHighlights?: number }[] = [];
    const dossier = anonDossier();
    const provider: Pick<AnonStoriesProvider, "getDossier"> = {
      getDossier: async (_username, passed) => {
        options.push(passed ?? {});
        return { status: CapabilityStatus.AVAILABLE, observedAt: OBSERVED, dossier };
      },
    };
    const result = await opAnonstoriesDossier(
      { username: "aurora.wilde", maxHighlights: 2 },
      { anonProvider: provider },
    );
    expect(options).toEqual([{ maxHighlights: 2 }]);
    expect(result).toBe(dossier);
  });

  it("carries the aggregator's refusal and never invents an empty story list", async () => {
    const provider: Pick<AnonStoriesProvider, "getDossier"> = {
      getDossier: async () => ({
        status: CapabilityStatus.ERROR,
        observedAt: OBSERVED,
        error: { kind: "ACCOUNT_PRIVATE", message: "The account is private.", retryable: false },
      }),
    };
    await expect(
      opAnonstoriesDossier({ username: "aurora.wilde" }, { anonProvider: provider }),
    ).rejects.toMatchObject({ code: "ACCOUNT_PRIVATE", message: "The account is private.", exitCode: 1 });
  });
});

describe("live-read evidence labels", () => {
  it("states one label per read, with the studio as the only difference", () => {
    const cli = liveReadMeta("public-page", "cli");
    const mcp = liveReadMeta("public-page", "mcp");
    // generatedAt is when this answer was stamped, so it is allowed to differ by
    // milliseconds; every other field is the contract.
    expect({ ...cli, studio: "?", generatedAt: "?" }).toEqual({
      ...mcp,
      studio: "?",
      generatedAt: "?",
    });
    expect(cli.studio).toBe("cli");
    expect(mcp.studio).toBe("mcp");
    expect(cli.synthetic).toBe(false);
    expect(cli.sourceId).toBe("public:web:v1");
    expect(cli.provider).toBe("public");
    expect(cli.note).toContain("Not an official Graph API response.");
  });

  it("labels the aggregator as a relay and the post read as a media page", () => {
    expect(liveReadMeta("anonstories", "cli").sourceId).toBe("anonstories:v1");
    expect(liveReadMeta("anonstories", "cli").note).toContain("PUBLIC_AGGREGATOR");
    expect(liveReadMeta("public-post", "cli").note).toContain("media page");
  });

  it("labels a live read with the source id the bytes carry", () => {
    // The payload is the observation and it names its own source; the envelope
    // restates that. A remembered constant would be a second source of truth, so
    // a provider that moved to a new id would print provenance its own data
    // contradicts — and evidence rows are keyed by the id the provider recorded.
    expect(liveReadMeta("public-page", "cli", undefined, "public:web:v2").sourceId).toBe(
      "public:web:v2",
    );
    // A blank observation is not a new id: the label's own value still answers.
    expect(liveReadMeta("public-page", "cli", undefined, "   ").sourceId).toBe("public:web:v1");
  });

  it("keeps the fallback equal to the id the shipped provider stamps", () => {
    // Built through the provider's own test seam, so the id is read without a
    // browser and the two packages cannot drift apart unnoticed.
    expect(liveReadMeta("public-page", "cli").sourceId).toBe(
      new PublicWebProvider({ fetchHtml: async () => "" }).sourceId,
    );
    expect(liveReadMeta("anonstories", "cli").sourceId).toBe(
      new AnonStoriesProvider({
        transportFactory: async () => {
          throw new Error("never opened: this test reads a label, not a page");
        },
      }).sourceId,
    );
  });

  it("names the sources a viewer report actually read", async () => {
    const read = await opViewer(
      { input: "aurora.wilde" },
      { publicProvider: fakePublic(), anonProvider: fakeAnon() },
    );
    // The sourceId carries the source ids that answered, not the source names a
    // caller might hope for: a reader can tell a both-source composition from a
    // public-only one straight from the label.
    expect(viewerMeta(read, "cli").sourceId).toBe("viewer:public:web:v1+anonstories:v1");
    expect(viewerMeta(read, "mcp").sourceId).toBe("viewer:public:web:v1+anonstories:v1");
    expect(viewerMeta(read, "cli").generatedAt).toBe(read.generatedAt);
    expect(viewerMeta(read, "cli").studio).toBe("cli");
    expect(viewerMeta(read, "mcp").studio).toBe("mcp");

    const publicOnly = await opViewer(
      { input: "aurora.wilde", source: "public" },
      { publicProvider: fakePublic(), anonProvider: fakeAnon() },
    );
    expect(viewerMeta(publicOnly, "mcp").sourceId).toBe("viewer:public:web:v1");

    // Neither source could be constructed, so the report states what it read:
    // nothing. A label naming any source here would be a false claim.
    const unread = await opViewer({ input: "aurora.wilde", chromePath: NO_BROWSER });
    expect(viewerMeta(unread, "cli").sourceId).toBe("viewer:v1");
    expect(unread.tabs.map((tab) => tab.status)).toEqual([
      "UNAVAILABLE",
      "UNAVAILABLE",
      "UNAVAILABLE",
      "UNAVAILABLE",
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
  });
});

describe("igtrack mcp answers the live reads through the operations layer", () => {
  async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "live-read-test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return { client, close: () => client.close() };
  }

  function payload(result: unknown): Record<string, unknown> {
    const content = (result as { content?: unknown }).content;
    const first = Array.isArray(content) ? content[0] : undefined;
    const text =
      typeof first === "object" && first !== null && "text" in first
        ? String((first as { text?: unknown }).text ?? "")
        : "";
    return JSON.parse(text) as Record<string, unknown>;
  }

  it("refuses the same login-free reads with the same sentence on both surfaces", async () => {
    const { client, close } = await connect();
    try {
      const direct = await opPublicDossier({ username: "aurora.wilde", chromePath: NO_BROWSER }).catch(
        (caught: unknown) => caught as CliError,
      );
      const publicTool = payload(
        await client.callTool({
          name: "igtrack_public",
          arguments: { username: "aurora.wilde", chromePath: NO_BROWSER },
        }),
      );
      expect(publicTool.ok).toBe(false);
      // Code and sentence are identical on both surfaces. The transport adds the
      // number the terminal would have exited with, because a tool result has no
      // exit status of its own and the severity is part of the refusal.
      expect(publicTool.error).toEqual({
        code: "PROVIDER_UNAVAILABLE",
        message: (direct as CliError).message,
        exitCode: (direct as CliError).exitCode,
      });

      const stories = payload(
        await client.callTool({
          name: "igtrack_anonstories",
          arguments: { username: "aurora.wilde", chromePath: NO_BROWSER },
        }),
      );
      expect(stories.ok).toBe(false);
      expect(stories.error).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(JSON.stringify(stories.error)).toContain("Nothing was requested.");

      const badUrl = payload(
        await client.callTool({ name: "igtrack_post", arguments: { url: "https://www.instagram.com/aurora.wilde/" } }),
      );
      expect(badUrl.error).toMatchObject({ code: "USAGE" });
    } finally {
      await close();
    }
  });

  it("returns the six-tab viewer with live-read meta over MCP", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "igtrack_viewer",
        arguments: { input: "aurora.wilde", chromePath: NO_BROWSER },
      });
      expect(result.isError).toBeFalsy();
      const body = payload(result) as {
        ok: boolean;
        data: { tabs: { key: string; status: string }[]; requestedSources: string[] };
        _meta: Record<string, unknown>;
      };
      expect(body.ok).toBe(true);
      expect(body.data.tabs.map((tab) => tab.key)).toEqual([
        "story",
        "post",
        "reels",
        "highlights",
        "repost",
        "tagged",
      ]);
      expect(body._meta).toMatchObject({
        provider: "viewer",
        sourceId: "viewer:v1",
        studio: "mcp",
        synthetic: false,
      });
    } finally {
      await close();
    }
  });
});

describe("one operations layer", () => {
  it("constructs the login-free providers in tools.ts only", () => {
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) sources.push(path);
      }
    };
    walk(fileURLToPath(new URL("../src", import.meta.url)));
    const constructors = sources
      .filter((path) => /new (PublicWebProvider|AnonStoriesProvider)\(/.test(readFileSync(path, "utf8")))
      .map((path) => path.replace(/\\/g, "/").split("/src/")[1] ?? path);
    // AGENTS.md: CLI and MCP call the same functions in tools.ts; a second file
    // constructing a provider is a second data path, and the two drift.
    expect(constructors.sort()).toEqual(["tools.ts"]);
  });
});
