import { describe, expect, it } from "vitest";
import { CapabilityStatus } from "@igtrack/core";
import type { PublicWebProvider } from "@igtrack/ingestion";
import { opViewer } from "../src/tools.js";
import { renderViewerHuman } from "../src/commands/viewer.js";
import {
  OBSERVED,
  fakeAnon,
  fakePublic,
  publicDossier,
  publicSinglePost,
} from "./live-read-fakes.js";

// Behavior tests for the viewer operation and its human surface, with the two
// providers injected: no browser and no network.

describe("opViewer", () => {
  it("composes the six tabs from both sources and keeps declared counts separate", async () => {
    const report = await opViewer(
      { input: "aurora.wilde" },
      { publicProvider: fakePublic(), anonProvider: fakeAnon() },
    );
    expect(report.tabs.map((tab) => tab.key)).toEqual([
      "story",
      "post",
      "reels",
      "highlights",
      "repost",
      "tagged",
    ]);
    expect(report.tabs.find((tab) => tab.key === "story")).toMatchObject({
      status: "OBSERVED",
      count: 1,
      evidenceClasses: ["PUBLIC_AGGREGATOR"],
    });
    expect(report.tabs.find((tab) => tab.key === "post")).toMatchObject({
      status: "OBSERVED",
      count: 1,
      declaredCount: 12,
    });
    expect(report.tabs.find((tab) => tab.key === "highlights")).toMatchObject({
      status: "OBSERVED",
      count: 1,
    });
    expect(report.tabs.find((tab) => tab.key === "repost")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "STRUCTURAL",
    });
    expect(report.mentions.count).toBe(0);
    expect(report.notes).toEqual(
      expect.arrayContaining(["public note", "anon note"]),
    );
  });

  it("reads only the requested source and marks the others NOT_REQUESTED", async () => {
    let publicCalls = 0;
    const publicProvider = fakePublic();
    const spyPublic: Pick<PublicWebProvider, "getDossier" | "getPublicPost"> = {
      getDossier: async (...args) => {
        publicCalls += 1;
        return publicProvider.getDossier(...args);
      },
      getPublicPost: publicProvider.getPublicPost,
    };
    const report = await opViewer(
      { input: "aurora.wilde", source: "anonstories" },
      { publicProvider: spyPublic, anonProvider: fakeAnon() },
    );
    expect(publicCalls).toBe(0);
    expect(report.requestedSources).toEqual(["anonstories"]);
    expect(report.tabs.find((tab) => tab.key === "post")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "NOT_REQUESTED",
      count: null,
    });
  });

  it("keeps a provider refusal as a typed source error, not an empty tab", async () => {
    const report = await opViewer(
      { input: "aurora.wilde", source: "public" },
      {
        publicProvider: {
          getDossier: async () => ({
            status: CapabilityStatus.ERROR,
            observedAt: OBSERVED,
            error: {
              kind: "AUTH_REQUIRED",
              message: "Instagram served a login page.",
              retryable: false,
            },
          }),
          getPublicPost: fakePublic().getPublicPost,
        },
      },
    );
    expect(report.tabs.find((tab) => tab.key === "post")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "SOURCE_ERROR",
      reason: "Instagram served a login page.",
      count: null,
    });
  });

  it("refuses read tabs for a private account while keeping the public shell", async () => {
    const dossier = publicDossier({
      profile: {
        ...publicDossier().profile,
        isPrivate: true,
        highlights: [],
      },
      posts: [],
    });
    const report = await opViewer(
      { input: "aurora.wilde", source: "public" },
      { publicProvider: fakePublic(dossier) },
    );
    expect(report.profile).toMatchObject({ username: "aurora.wilde", isPrivate: true });
    expect(report.tabs.find((tab) => tab.key === "post")).toMatchObject({
      status: "UNAVAILABLE",
      reasonKind: "PRIVATE",
    });
  });

  it("resolves a post URL to its owner through one media-page read", async () => {
    const single = publicSinglePost({
      post: { ...publicDossier().posts[0]!, owner: { username: "aurora.wilde" } },
    });
    const report = await opViewer(
      { input: "https://www.instagram.com/p/AAA111/", source: "public" },
      { publicProvider: fakePublic(publicDossier(), single) },
    );
    expect(report.username).toBe("aurora.wilde");
    expect(report.input.postCode).toBe("AAA111");
    expect(report.focus.tab).toBe("post");
    expect(report.notes.join(" ")).toContain("resolved from the post URL's owner");
  });

  it("renders the tab strip, refusals and the observed/declared split", async () => {
    const report = await opViewer(
      { input: "aurora.wilde" },
      { publicProvider: fakePublic(), anonProvider: fakeAnon() },
    );
    const human = renderViewerHuman(report, { tab: "all" });
    expect(human).toContain("Stories 1");
    expect(human).toContain("Posts 1 observed / 12 declared");
    expect(human).toContain("Reposts — UNAVAILABLE");
    expect(human).toContain("Refused by design");
    expect(human).toContain("RESHARES");
    expect(human).toContain("SOURCE_URL_ONLY");
  });
});
