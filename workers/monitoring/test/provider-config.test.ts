import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SourceKind } from "@igtrack/core";
import { providerFromEnv } from "../src/provider.js";

const sampleExportDir = fileURLToPath(
  new URL("../../../packages/ingestion/fixtures/import-sample", import.meta.url),
);

describe("provider credential safety (Phase 10 §7)", () => {
  it("fails fast with a configuration error for an unknown provider — never UNAVAILABLE", () => {
    const prev = process.env.IGTRACK_PROVIDER;
    process.env.IGTRACK_PROVIDER = "scraper";
    try {
      expect(() => providerFromEnv()).toThrow(/no provider implementation for "scraper"/);
      // Message must be actionable and must not claim UNAVAILABLE
      try {
        providerFromEnv();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toMatch(/UNAVAILABLE/i);
        expect(msg).toMatch(/IGTRACK_PROVIDER/i);
      }
    } finally {
      if (prev === undefined) delete process.env.IGTRACK_PROVIDER;
      else process.env.IGTRACK_PROVIDER = prev;
    }
  });

  it("fails fast when graph is selected without credentials — never UNAVAILABLE", () => {
    const prevProvider = process.env.IGTRACK_PROVIDER;
    const prevToken = process.env.IGTRACK_GRAPH_ACCESS_TOKEN;
    const prevId = process.env.IGTRACK_GRAPH_IG_USER_ID;
    const prevUser = process.env.IGTRACK_GRAPH_USERNAME;
    process.env.IGTRACK_PROVIDER = "graph";
    delete process.env.IGTRACK_GRAPH_ACCESS_TOKEN;
    delete process.env.IGTRACK_GRAPH_IG_USER_ID;
    delete process.env.IGTRACK_GRAPH_USERNAME;
    try {
      expect(() => providerFromEnv()).toThrow(/missing required env/);
    } finally {
      if (prevProvider === undefined) delete process.env.IGTRACK_PROVIDER;
      else process.env.IGTRACK_PROVIDER = prevProvider;
      if (prevToken !== undefined) process.env.IGTRACK_GRAPH_ACCESS_TOKEN = prevToken;
      if (prevId !== undefined) process.env.IGTRACK_GRAPH_IG_USER_ID = prevId;
      if (prevUser !== undefined) process.env.IGTRACK_GRAPH_USERNAME = prevUser;
    }
  });

  it("defaults to fixture when IGTRACK_PROVIDER is unset", () => {
    const prev = process.env.IGTRACK_PROVIDER;
    delete process.env.IGTRACK_PROVIDER;
    try {
      const src = providerFromEnv();
      expect(src.provider.sourceId).toBe("fixture:v1");
    } finally {
      if (prev !== undefined) process.env.IGTRACK_PROVIDER = prev;
    }
  });
});

describe("import provider configuration (Phase B)", () => {
  const KEYS = [
    "IGTRACK_PROVIDER",
    "IGTRACK_IMPORT_DIR",
    "IGTRACK_IMPORT_USERNAME",
  ] as const;

  function setEnv(
    vars: Record<(typeof KEYS)[number], string | undefined>,
  ): () => void {
    const prev = new Map(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) {
      const v = vars[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return () => {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
  }

  it("fails fast without IGTRACK_IMPORT_DIR — never UNAVAILABLE", () => {
    const restore = setEnv({
      IGTRACK_PROVIDER: "import",
      IGTRACK_IMPORT_DIR: undefined,
      IGTRACK_IMPORT_USERNAME: undefined,
    });
    try {
      expect(() => providerFromEnv()).toThrow(
        /missing required env IGTRACK_IMPORT_DIR/,
      );
      try {
        providerFromEnv();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toMatch(/UNAVAILABLE/i);
        expect(msg).toMatch(/IGTRACK_IMPORT_DIR/);
      }
    } finally {
      restore();
    }
  });

  it("fails fast without IGTRACK_IMPORT_USERNAME — never UNAVAILABLE", () => {
    const restore = setEnv({
      IGTRACK_PROVIDER: "import",
      IGTRACK_IMPORT_DIR: sampleExportDir,
      IGTRACK_IMPORT_USERNAME: undefined,
    });
    try {
      expect(() => providerFromEnv()).toThrow(
        /missing required env IGTRACK_IMPORT_USERNAME/,
      );
    } finally {
      restore();
    }
  });

  it("fails fast when the configured export directory does not exist", () => {
    const restore = setEnv({
      IGTRACK_PROVIDER: "import",
      IGTRACK_IMPORT_DIR: `${sampleExportDir}/does-not-exist`,
      IGTRACK_IMPORT_USERNAME: "sample.owner",
    });
    try {
      expect(() => providerFromEnv()).toThrow(/export directory not found/);
    } finally {
      restore();
    }
  });

  it("constructs an import execution source classified as IMPORT", () => {
    const restore = setEnv({
      IGTRACK_PROVIDER: "import",
      IGTRACK_IMPORT_DIR: sampleExportDir,
      IGTRACK_IMPORT_USERNAME: "sample.owner",
    });
    try {
      const src = providerFromEnv();
      expect(src.provider.sourceId).toBe("import:v1");
      expect(src.source.id).toBe("import:v1");
      expect(src.source.kind).toBe(SourceKind.IMPORT);
      expect(src.source.providerVersion).toBe("v1");
    } finally {
      restore();
    }
  });
});
