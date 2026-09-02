import { CAPABILITY_REGISTRY, type CapabilityRegistryEntry } from "./capabilities.js";

// ---------------------------------------------------------------------------
// The capability matrix, rendered from the registry.
//
// Why generate documentation from code: the whole product promise is "we never
// claim more than we can observe". A hand-written matrix drifts the moment
// someone adds a provider method or a table, and the drift always errs in the
// flattering direction. Generating it means docs and product cannot disagree —
// and a test fails if the committed file is stale.
//
// No dependencies, no I/O: this is a pure function over CAPABILITY_REGISTRY.
// ---------------------------------------------------------------------------

export interface CapabilityMatrixSummary {
  total: number;
  available: number;
  unavailable: number;
  documentedAbsent: number;
}

/**
 * True when a lawful source actually supplies this capability today: a
 * provider method, or — for operator-supplied capabilities such as the claims
 * ledger — the operator themselves, or — for
 * engine-supplied capabilities such as the bounded research run — the
 * in-process engine's own fetch path.
 */
export function isCapabilityAvailable(entry: CapabilityRegistryEntry): boolean {
  return (
    entry.whyUnavailable === null &&
    (entry.providerMethods.length > 0 ||
      entry.operatorSupplied === true ||
      entry.engineSupplied === true)
  );
}

/** Human-readable "Supplied by" cell: provider methods, operator submissions, or the engine. */
function suppliedBy(entry: CapabilityRegistryEntry): string {
  if (entry.providerMethods.length === 0 && entry.operatorSupplied === true) {
    return "operator submissions (no platform route exists)";
  }
  if (entry.providerMethods.length === 0 && entry.engineSupplied === true) {
    return "bounded engine acquisition of operator-named public sources (no platform route exists)";
  }
  return list(entry.providerMethods);
}

export function capabilityMatrixSummary(): CapabilityMatrixSummary {
  const entries = CAPABILITY_REGISTRY;
  const available = entries.filter(isCapabilityAvailable).length;
  return {
    total: entries.length,
    available,
    unavailable: entries.length - available,
    documentedAbsent: entries.filter((e) => e.liveState === "DOCUMENTED_ABSENT").length,
  };
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.map((v) => `\`${v}\``).join(", ");
}

export function renderCapabilityMatrixDocument(): string {
  const summary = capabilityMatrixSummary();
  const lines: string[] = [];

  lines.push("# Capability matrix");
  lines.push("");
  lines.push(
    "> **Generated file — do not edit by hand.** `pnpm docs:capabilities` rewrites it",
  );
  lines.push(
    "> from `CAPABILITY_REGISTRY` (`packages/core/src/capabilities.ts`); a test fails if it",
  );
  lines.push("> is stale. Prose cannot drift from the product because there is no prose.");
  lines.push("");
  lines.push(
    `${summary.available} of ${summary.total} capabilities are obtainable from a lawful source; ` +
      `${summary.unavailable} have no source at all (no provider method exists, and no operator-supplied ` +
      "rows can stand in). Separately, " +
      `${summary.documentedAbsent} capabilities are \`DOCUMENTED_ABSENT\`: the exhaustive platform ` +
      "reference lists no such field or edge, so their absence is a finding, not an assumption.",
  );
  lines.push("");
  lines.push(
    "A capability can be available **and** documented-absent at the same time, and saying so is " +
      "the point of this table: follower and following rosters are `DOCUMENTED_ABSENT` for any " +
      "live interface — no roster edge exists — while the synthetic fixture provider exposes " +
      "rosters so the pipeline can be built and tested end to end, and the operator's own " +
      "Instagram export (`import:v1`) supplies the real roster lawfully.",
  );
  lines.push("");
  lines.push("## How to read this");
  lines.push("");
  lines.push("| State | Means |");
  lines.push("|---|---|");
  lines.push(
    "| `available` | At least one provider method supplies it — or, for the claims ledger, the operator does (the platform exposes no route and none can exist); or, for the bounded research run, the in-process engine does — and its pipeline is wired end to end. |",
  );
  lines.push("| `UNAVAILABLE` | No provider method exists. The product reports it as unavailable **with the reason below** — never as zero, never as empty data. |");
  lines.push("| `LIVE_VERIFIED` | Observed against the real provider during a live check. |");
  lines.push("| `NOT_VERIFIED` | Implemented against documented fields; a live check under your credentials is still outstanding. |");
  lines.push("| `DOCUMENTED_ABSENT` | The platform does not expose it. This is a finding, not a gap in the work. |");
  lines.push("");
  lines.push("## Matrix");
  lines.push("");
  lines.push("| Capability | State | Supplied by | Persists to |");
  lines.push("|---|---|---|---|");
  for (const entry of CAPABILITY_REGISTRY) {
    const available = isCapabilityAvailable(entry);
    lines.push(
      `| **${cell(entry.label)}** | ${available ? "available" : "`UNAVAILABLE`"} · \`${entry.liveState}\` | ${suppliedBy(entry)} | ${list(entry.persistence)} |`,
    );
  }
  lines.push("");
  lines.push("## The detail");
  lines.push("");
  for (const entry of CAPABILITY_REGISTRY) {
    const available = isCapabilityAvailable(entry);
    lines.push(`### ${entry.label} — \`${available ? "available" : "UNAVAILABLE"}\``);
    lines.push("");
    lines.push(`- **Registry id:** \`${entry.id}\``);
    lines.push(`- **Live state:** \`${entry.liveState}\` — ${cell(entry.liveEvidence)}`);
    lines.push(`- **Permissions:** ${cell(entry.permissions)}`);
    lines.push(
      entry.operatorSupplied === true
        ? `- **Supplied by:** operator/agent submissions — no provider method exists, and none can (the platform exposes no route)`
        : entry.engineSupplied === true
          ? `- **Supplied by:** the bounded research engine — operator-named or search-provider-named public pages, fetched through the SSRF gate; no platform route exists, and none can`
          : `- **Provider methods:** ${list(entry.providerMethods)}`,
    );
    lines.push(`- **Persists to:** ${list(entry.persistence)}`);
    lines.push(`- **Surfaced in:** ${list(entry.ui)}`);
    if (entry.whyUnavailable !== null) {
      lines.push("");
      lines.push(`**Why it is unavailable.** ${cell(entry.whyUnavailable)}`);
    }
    if (entry.unlock !== null) {
      lines.push("");
      lines.push(`**What would unlock it.** ${cell(entry.unlock)}`);
    }
    lines.push("");
    lines.push(`**Pipeline.** ${cell(entry.howItWorks)}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
