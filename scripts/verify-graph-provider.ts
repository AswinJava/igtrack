// Live Graph API verification harness — READ-ONLY, secret-safe.
//
// Run: pnpm exec tsx scripts/verify-graph-provider.ts [--json]
//
// Uses the configured credentials ONLY (env/secret store, never committed).
// Makes no mutation requests: it exercises only the GraphProvider's GET-only
// capability methods, one first-page call each, with a hard request cap.
// Never prints credentials: output carries key PRESENCE, field NAMES, value
// TYPES and string lengths — never values. Nothing is written to disk; the
// sanitized report goes to stdout (JSON with --json, human table otherwise).
//
// When credentials are absent the harness reports every capability as
// NOT_VERIFIED with reason CREDENTIALS_NOT_CONFIGURED and exits 0 — the
// honest state, not a failure. Distinguish LIVE / MOCK / FIXTURE / CODE /
// DOCUMENTATION / NOT_VERIFIED per row (see `provenance`).

import { CapabilityStatus, type CapabilityResult } from "../packages/core/src/index.js";
import {
  GraphProvider,
  graphConfigFromEnv,
} from "../packages/ingestion/src/graph/graph-provider.js";
import {
  COVERAGE_AREA_BY_CAPABILITY,
  findUnmappedFields,
} from "../packages/ingestion/src/graph/field-coverage.js";

const MAX_REQUESTS = 10;

// Normalizer envelope keys: pipeline shape, not provider fields — excluded
// from new-field detection.
const ENVELOPE_KEYS = ["meta", "account"];

interface CapabilityProbe {
  capability: string;
  provenance: "LIVE" | "NOT_VERIFIED";
  status: string;
  errorKind?: string;
  retryable?: boolean;
  // Sanitized shape evidence: field NAMES and value kinds only.
  fieldNames?: string[];
  itemCount?: number;
  hasNextCursor?: boolean;
  // Phase 17: normalized keys the audit does not know —
  // NEW_PROVIDER_FIELD_NOT_MAPPED signal (normalizer drift today; raw
  // provider keys once raw envelopes are echoed to diagnostics).
  newFieldsNotMapped?: string[];
  note?: string;
}

function summarize<T>(name: string, result: CapabilityResult<T>): CapabilityProbe {
  const base: CapabilityProbe = {
    capability: name,
    provenance: "LIVE",
    status: result.status,
    ...(result.error !== undefined
      ? { errorKind: result.error.kind, retryable: result.error.retryable }
      : {}),
    ...(result.note !== undefined ? { note: result.note.slice(0, 160) } : {}),
  };
  const data = (result as { data?: unknown }).data;
  if (Array.isArray(data)) {
    base.itemCount = data.length;
    const first = data[0] as Record<string, unknown> | undefined;
    if (first !== undefined && typeof first === "object" && first !== null) {
      base.fieldNames = Object.keys(first).sort();
    }
  } else if (data !== undefined && data !== null && typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>).sort();
    base.fieldNames = keys;
  }
  const next = (result as { nextCursor?: unknown }).nextCursor;
  if (next !== undefined) base.hasNextCursor = true;
  const area = COVERAGE_AREA_BY_CAPABILITY[name];
  if (area !== undefined && base.fieldNames !== undefined) {
    const unmapped = findUnmappedFields(area, base.fieldNames, "normalized", ENVELOPE_KEYS);
    if (unmapped.length > 0) base.newFieldsNotMapped = unmapped;
  }
  return base;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const present = {
    token: Boolean(process.env.IGTRACK_GRAPH_ACCESS_TOKEN),
    igUserId: Boolean(process.env.IGTRACK_GRAPH_IG_USER_ID),
    username: Boolean(process.env.IGTRACK_GRAPH_USERNAME),
  };
  const apiVersion = process.env.IGTRACK_GRAPH_API_VERSION ?? "v21.0";

  if (!present.token || !present.igUserId || !present.username) {
    const missing = Object.entries(present)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const report = {
      provenance: "NOT_VERIFIED",
      reason: "CREDENTIALS_NOT_CONFIGURED",
      missing,
      apiVersion,
      message:
        "Graph credentials are not configured in this environment. No live request was made. " +
        "Configure IGTRACK_GRAPH_ACCESS_TOKEN / IGTRACK_GRAPH_IG_USER_ID / IGTRACK_GRAPH_USERNAME " +
        "to enable LIVE verification. Capability states below reflect DOCUMENTATION + CODE evidence only.",
    };
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("IGTrack live provider verification: NOT_VERIFIED");
      console.log(`reason: ${report.reason} (missing: ${missing.join(", ")})`);
      console.log(`apiVersion: ${apiVersion}`);
      console.log("No live request was made. See the capability registry for per-capability evidence.");
    }
    return;
  }

  // Credentials present: presence acknowledged, values never touched again.
  // The provider reads them from env internally and only sends the token in
  // the Authorization header (never URL, never logs).
  const config = graphConfigFromEnv(process.env);
  const provider = new GraphProvider(config);
  const probes: CapabilityProbe[] = [];
  let requests = 0;
  const budget = (): boolean => requests < MAX_REQUESTS;

  const owned = (process.env.IGTRACK_GRAPH_USERNAME as string).toLowerCase();

  if (budget()) {
    requests += 1;
    probes.push(summarize("resolveAccount", await provider.resolveAccount(owned)));
  }
  const account = { username: owned, igId: process.env.IGTRACK_GRAPH_IG_USER_ID as string };
  if (budget()) {
    requests += 1;
    probes.push(summarize("getProfile", await provider.getProfile(account)));
  }
  let firstPostId: string | undefined;
  let firstCarouselId: string | undefined;
  if (budget()) {
    requests += 1;
    const posts = await provider.getPublicPosts(account);
    const probe = summarize("getPublicPosts", posts);
    probes.push(probe);
    if (posts.status === CapabilityStatus.AVAILABLE || posts.status === CapabilityStatus.PARTIAL) {
      const items = posts.data ?? [];
      firstPostId = items[0]?.postId;
      firstCarouselId = items.find((p) => p.mediaType === "CAROUSEL")?.postId;
    }
  }
  if (budget() && firstPostId !== undefined) {
    requests += 1;
    probes.push(
      summarize(
        "getPublicComments",
        await provider.getPublicComments({
          postId: firstPostId,
          takenAt: new Date().toISOString(),
          meta: { category: "OBSERVED", confidence: "MEDIUM", observedAt: new Date().toISOString() },
        } as never),
      ),
    );
  }
  if (budget() && firstCarouselId !== undefined) {
    requests += 1;
    probes.push(
      summarize(
        "getPostChildren",
        await provider.getPostChildren({
          postId: firstCarouselId,
          takenAt: new Date().toISOString(),
          mediaType: "CAROUSEL",
          meta: { category: "OBSERVED", confidence: "MEDIUM", observedAt: new Date().toISOString() },
        } as never),
      ),
    );
  }
  if (budget()) {
    requests += 1;
    probes.push(summarize("getStories", await provider.getStories(account)));
  }
  // Roster lists are declared unavailable by the provider contract: probing
  // them performs no network call and pins the honest state.
  probes.push(summarize("getFollowers", await provider.getFollowers(account)));
  probes.push(summarize("getFollowing", await provider.getFollowing(account)));

  const report = {
    provenance: "LIVE",
    requestsMade: requests,
    requestCap: MAX_REQUESTS,
    apiVersion,
    // Non-secret identity only: the owned username is public by definition.
    ownedUsername: owned,
    capabilities: probes,
  };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`IGTrack live provider verification: LIVE (${requests} read-only requests)`);
    for (const p of probes) {
      const fields = p.fieldNames !== undefined ? ` fields=[${p.fieldNames.join(",")}]` : "";
      const count = p.itemCount !== undefined ? ` items=${p.itemCount}` : "";
      const cursor = p.hasNextCursor === true ? " +cursor" : "";
      const err = p.errorKind !== undefined ? ` error=${p.errorKind} retryable=${p.retryable}` : "";
      const unmapped =
        p.newFieldsNotMapped !== undefined
          ? ` NEW_PROVIDER_FIELD_NOT_MAPPED=[${p.newFieldsNotMapped.join(",")}]`
          : "";
      console.log(`- ${p.capability}: ${p.status}${count}${fields}${cursor}${err}${unmapped}`);
    }
  }
}

await main();
