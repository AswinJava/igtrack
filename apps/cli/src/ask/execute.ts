import type { CliContext } from "../context.js";
import { CliError, errorHint } from "../output.js";
import {
  opActivity,
  opAudit,
  opAudience,
  opCapabilities,
  opDigest,
  opDossier,
  opEvidence,
  opExport,
  opInsights,
  opInvestigate,
  opLookup,
  opPlan,
  opRecent,
  opRelationships,
  opReport,
  opReports,
  opResearch,
  opScanRun,
  opStatus,
  opTaggedMedia,
  opTargetAdd,
  opTargetList,
  opWork,
} from "../tools.js";
import { ASK_EXAMPLES, describePlan, planAsk, type AskIntent, type AskPlan } from "./parse.js";

// ---------------------------------------------------------------------------
// Turning a plan into work.
//
// This is a router over the SAME operations the CLI commands and MCP tools use:
// no intent re-implements a read, and a bug fixed in one
// surface is fixed here. What the router adds is the plain-language answer and
// the honesty notes; the underlying result travels intact in `steps[].result`.
// ---------------------------------------------------------------------------

export type AskStepStatus = "OK" | "FAILED" | "SUGGESTED" | "SKIPPED";
export type AskStatus = "ANSWERED" | "NEEDS_INPUT" | "PARTIAL" | "FAILED";

export interface AskStep {
  intent: AskIntent;
  status: AskStepStatus;
  summary: string;
  suggestion?: string;
  error?: { code: string; message: string };
  result?: unknown;
}

export interface AskResult {
  prompt: string;
  understanding: {
    summary: string;
    intents: AskIntent[];
    username: string | null;
    since: string | null;
    limit: number | null;
    assumptions: string[];
    confidence: AskPlan["confidence"];
  };
  status: AskStatus;
  steps: AskStep[];
  answer: string[];
  next: string[];
  examples: string[];
}

export interface AskOptions {
  /** Human progress, written to stderr by the CLI; never part of the answer. */
  onProgress?: (message: string) => void;
}

type Targets = Awaited<ReturnType<typeof opTargetList>>;

const ADVISORY = new Set<AskIntent>(["untrack", "stories", "public", "post"]);

function isoDate(value: Date | string | null): string {
  if (value === null) return "never";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace(".000Z", "Z") : String(value);
}

/**
 * Which steps answered from synthetic fixture rows. Read from each result's
 * own provenance markers, never from the configured provider: a live target
 * read while the fixture provider runs is still a live answer, and saying
 * otherwise contradicts the rows. Unknown shapes report nothing.
 */
function syntheticStepIntents(steps: AskStep[]): AskIntent[] {
  const intents: AskIntent[] = [];
  for (const step of steps) {
    if (step.result === undefined || step.result === null) continue;
    const result = step.result as {
      evidence?: { evidenceClass?: string };
      report?: { evidence?: { evidenceClass?: string } };
      route?: { evidenceClass?: string };
      provider?: { synthetic?: boolean };
      investigation?: { evidenceClasses?: Array<{ class: string; items: number }> };
    };
    const syntheticInvestigation = (result.investigation?.evidenceClasses ?? []).some(
      (row) => row.class === "SYNTHETIC_FIXTURE" && row.items > 0,
    );
    if (
      result.evidence?.evidenceClass === "SYNTHETIC" ||
      result.report?.evidence?.evidenceClass === "SYNTHETIC" ||
      result.route?.evidenceClass === "SYNTHETIC" ||
      result.provider?.synthetic === true ||
      syntheticInvestigation
    ) {
      intents.push(step.intent);
    }
  }
  return [...new Set(intents)];
}

function requireUsername(plan: AskPlan): string {
  if (plan.username !== null) return plan.username;
  throw new CliError(
    "USAGE",
    "This request needs an account, but none was named. Try: igtrack ask \"investigate @yourhandle\".",
    2,
  );
}

function stepResult(
  intent: AskIntent,
  summary: string,
  result: unknown,
): AskStep {
  return { intent, status: "OK", summary, result };
}

function failedStep(intent: AskIntent, err: unknown): AskStep {
  const code = err instanceof CliError ? err.code : "INTERNAL";
  const message = err instanceof Error ? err.message : String(err);
  return { intent, status: "FAILED", summary: `${intent} failed.`, error: { code, message } };
}

function suggestionStep(intent: AskIntent, suggestion: string, summary: string): AskStep {
  return { intent, status: "SUGGESTED", summary, suggestion };
}

function progressText(intent: AskIntent, plan: AskPlan): string {
  const handle = plan.username === null ? "" : ` @${plan.username}`;
  switch (intent) {
    case "investigate":
      return `Investigating${handle} — resolving the account, running every supported stage, and writing the dossier. This can take a minute.`;
    case "scan":
      return `Queueing scans${handle} and draining the queue.`;
    case "work":
      return "Running the scheduler once and draining the job queue.";
    case "audit":
      return `Auditing${handle} — config, probe, stored record and public web.`;
    default:
      return `Reading ${intent}${handle}…`;
  }
}

/** The account-ranked suggestions shown at the end of every answer. */
function nextFor(plan: AskPlan): string[] {
  const handle = plan.username;
  if (handle !== null) {
    return [
      `igtrack dossier ${handle}`,
      `igtrack research ${handle}`,
      `igtrack ask "what changed on ${handle} in the last 7 days?"`,
      `igtrack ask "who does ${handle} interact with most?"`,
    ];
  }
  return [
    "igtrack targets list",
    'igtrack ask "investigate <username>"',
    'igtrack ask "what can you do?"',
    "igtrack guide",
  ];
}

/** The plan speaks in MCP tool ids; a prompt answer should say what to do next. */
function plainNext(tool: string, username: string | null): { label: string; say: string } | null {
  const handle = username ?? "<username>";
  switch (tool) {
    case "igtrack_work":
      return { label: "run the worker so queued jobs execute", say: 'igtrack ask "run the worker"' };
    case "igtrack_scans_run":
      return { label: `queue a scan for @${handle}`, say: `igtrack ask "scan ${handle}"` };
    case "igtrack_research":
      return { label: `read the research report for @${handle}`, say: `igtrack research ${handle}` };
    case "igtrack_dossier":
      return { label: `read the dossier for @${handle}`, say: `igtrack dossier ${handle}` };
    case "igtrack_investigate":
      return { label: `run a full investigation of @${handle}`, say: `igtrack ask "investigate ${handle}"` };
    case "igtrack_claim_add":
      return { label: "record a sourced claim", say: "igtrack claim add --help" };
    default:
      return null;
  }
}

function planGoal(prompt: string): string | undefined {
  const lower = prompt.toLowerCase();
  if (/\bposts?\b|\bmedia\b/.test(lower)) return "POSTS";
  if (/\bstories\b|\bstory\b/.test(lower)) return "STORIES";
  if (/\btags?\b|\btagged\b/.test(lower)) return "TAGS";
  if (/\binsights?\b/.test(lower)) return "INSIGHTS";
  if (/\brelationships?\b|\bconnections?\b/.test(lower)) return "CONNECTIONS";
  if (/\bresearch\b|\bclaims?\b|\bsources?\b/.test(lower)) return "RESEARCH";
  if (/\bprofile\b/.test(lower)) return "PROFILE";
  return undefined;
}

async function runIntent(
  ctx: CliContext,
  intent: AskIntent,
  plan: AskPlan,
  answer: string[],
): Promise<AskStep> {
  switch (intent) {
    case "track": {
      const username = requireUsername(plan);
      const result = await opTargetAdd(ctx, { username });
      const summary = result.created
        ? `Now tracking @${result.username} in ${result.observationMode} mode.`
        : `@${result.username} was already tracked in ${result.observationMode} mode.`;
      answer.push(summary);
      if (result.unobservable !== undefined) {
        answer.push(`Heads up: ${result.unobservable}`);
      }
      return stepResult(intent, summary, result);
    }

    case "scan": {
      const username = plan.username;
      const force = /\b(force|now|right now|immediately|again)\b/i.test(plan.prompt);
      const scan = await opScanRun(ctx, {
        ...(username === null ? {} : { target: username }),
        force,
      });
      const handle = username === null ? "every tracked account" : `@${username}`;
      let summary = `Queued ${scan.enqueued.length} scan(s) for ${handle}`;
      if (scan.skipped.length > 0) summary += `, skipped ${scan.skipped.length}`;
      summary += ".";
      for (const skip of scan.skipped.slice(0, 3)) {
        answer.push(`Skipped ${skip.kind} for @${skip.username}: ${skip.reason}`);
      }
      if (scan.enqueued.length > 0 && !plan.intents.includes("work")) {
        const work = await opWork(ctx, { max: 25 });
        const succeeded = work.outcomes.filter((outcome) => outcome.state === "succeeded").length;
        const worked = work.outcomes.filter((outcome) => outcome.state !== "none");
        summary += ` Ran the worker: ${succeeded}/${worked.length} job(s) succeeded; queue ${work.stopped}.`;
        answer.push(summary);
        return stepResult(intent, summary, { scan, work });
      }
      answer.push(summary);
      return stepResult(intent, summary, scan);
    }

    case "work": {
      const max = Math.min(plan.limit ?? 25, 100);
      const result = await opWork(ctx, { max });
      const succeeded = result.outcomes.filter((outcome) => outcome.state === "succeeded").length;
      const worked = result.outcomes.filter((outcome) => outcome.state !== "none");
      const summary = `Ran the worker: ${succeeded}/${worked.length} job(s) succeeded; queue ${result.stopped}.`;
      answer.push(summary);
      return stepResult(intent, summary, result);
    }

    case "investigate": {
      const username = requireUsername(plan);
      const result = await opInvestigate(ctx, {
        username,
        ...(plan.prompt.includes("?") ? { question: plan.prompt } : {}),
        ...(plan.urls.length > 0 ? { urls: plan.urls } : {}),
      });
      const completed = result.investigation.stages.filter((stage) => stage.status === "COMPLETED").length;
      const summary =
        `Investigated @${result.investigation.username}: retrieved ${result.investigation.retrievedItems} item(s); ` +
        `${completed}/${result.investigation.stages.length} stage(s) completed.`;
      answer.push(summary);
      for (const gap of result.gaps.slice(0, 4)) {
        answer.push(`Not retrieved — ${gap.subject}: ${gap.reason}`);
      }
      if (result.nextSteps.length > 0) {
        answer.push(`Suggested next: ${result.nextSteps[0]?.action ?? ""} (${result.nextSteps[0]?.because ?? ""})`);
      }
      return stepResult(intent, summary, result);
    }

    case "changes": {
      const since = plan.since ?? "7d";
      const result = await opActivity(ctx, {
        since,
        limit: plan.limit ?? 20,
        ...(plan.username === null ? {} : { target: plan.username }),
      });
      const summary = result.truncated
        ? `${result.items.length} change event(s) shown in the last ${since} (${result.scope}); more exist beyond the limit.`
        : `${result.items.length} change event(s) in the last ${since} (${result.scope}).`;
      answer.push(summary);
      for (const item of result.items.slice(0, 8)) {
        const evidence = item.evidenceId === null ? "" : ` [${item.evidenceId}]`;
        answer.push(`${isoDate(item.timestamp)} — ${item.summary}${evidence}`);
      }
      if (result.items.length === 0) {
        answer.push(
          "No stored change events match this window. That is a fact about the record, not proof that nothing happened.",
        );
      }
      if (result.truncated) {
        answer.push("This is a bounded read; more events may exist beyond the limit.");
      }
      return stepResult(intent, summary, result);
    }

    case "report": {
      const username = requireUsername(plan);
      const at = plan.since !== null && /^\d{4}-\d{2}-\d{2}/.test(plan.since) ? plan.since : undefined;
      const result = await opReport(ctx, {
        target: username,
        ...(plan.period === null ? {} : { period: plan.period }),
        ...(at === undefined ? {} : { at }),
      });
      const factCount = result.report.sections.reduce((n, section) => n + section.facts.length, 0);
      const summary =
        `Composed the ${result.window.label} ${result.period} report for @${result.target.username}: ` +
        `${result.report.sections.length} section(s), ${factCount} fact(s), ${result.report.gaps.length} gap(s).`;
      answer.push(summary);
      for (const section of result.report.sections.slice(0, 8)) {
        answer.push(`${section.state} — ${section.title}: ${section.summary}`);
      }
      for (const gap of result.report.gaps.slice(0, 3)) {
        answer.push(`Gap — ${gap.section}: ${gap.reason}`);
      }
      answer.push("Run `igtrack report <target> --period ... --out report.md` to keep the full Markdown.");
      return stepResult(intent, summary, result);
    }

    case "reports": {
      const username = requireUsername(plan);
      const result = await opReports(ctx, {
        target: username,
        ...(plan.period === null ? {} : { period: plan.period }),
        ...(plan.limit === null ? {} : { limit: plan.limit }),
      });
      const summary =
        result.windows.length === 0
          ? `No ${result.period} window exists for @${result.target.username} yet.`
          : `${result.windows.length} ${result.period} window(s) for @${result.target.username}, newest first.`;
      answer.push(summary);
      for (const entry of result.windows.slice(0, 8)) {
        answer.push(`${entry.window.label} — ${entry.state}, ${entry.eventCount} stored event(s)`);
      }
      answer.push(result.note);
      return stepResult(intent, summary, result);
    }

    case "audience": {
      const username = requireUsername(plan);
      const result = await opAudience(ctx, {
        target: username,
        ...(plan.since === null ? {} : { since: plan.since }),
        ...(plan.limit === null ? {} : { limit: plan.limit }),
      });
      const summary = result.sets.complete
        ? `Audience sets for @${result.target.username}: ${result.sets.followerCount ?? "unavailable"} follower(s), ${result.sets.followingCount ?? "unavailable"} followed, ${result.sets.mutualCount ?? "unavailable"} mutual, ${result.sets.notFollowingBack.length} not following back, ${result.sets.notFollowedBack.length} not followed back.`
        : `Audience sets for @${result.target.username} are incomplete: ${result.notes[0] ?? "a COMPLETE roster is missing."}`;
      answer.push(summary);
      if (result.sets.mutuals.length > 0) answer.push(`Mutuals: ${result.sets.mutuals.slice(0, 10).map((n) => `@${n}`).join(", ")}`);
      if (result.sets.notFollowingBack.length > 0) {
        answer.push(`Not following back: ${result.sets.notFollowingBack.slice(0, 10).map((n) => `@${n}`).join(", ")}`);
      }
      for (const note of result.notes.slice(0, 2)) answer.push(note);
      return stepResult(intent, summary, result);
    }

    case "recent": {
      const username = requireUsername(plan);
      const prompt = plan.prompt.toLowerCase();
      const direction = /\bunfollowers?\b|\blost followers?\b/.test(prompt) ? "followers" : "following";
      const result = await opRecent(ctx, {
        target: username,
        direction,
        ...(plan.since === null ? {} : { since: plan.since }),
        ...(plan.limit === null ? {} : { limit: plan.limit }),
      });
      let summary: string;
      if (result.state === "UNAVAILABLE") {
        summary =
          `Recent follow activity for @${result.target.username} is unavailable: ` +
          `no COMPLETE ${direction === "followers" ? "follower" : "following"} roster is on record, so there is no baseline to diff.`;
      } else if (result.state === "EMPTY") {
        summary =
          `No ${direction === "followers" ? "follower" : "follow"} change was recorded for @${result.target.username} ` +
          `since ${result.since.toISOString()} — the baseline exists and nothing moved.`;
      } else {
        summary =
          `Recent activity for @${result.target.username} since ${result.since.toISOString()}: ` +
          `${result.counts.newFollowing ?? 0} new follow(s), ${result.counts.lostFollowing ?? 0} lost follow(s)` +
          (result.counts.newFollowers === null
            ? ""
            : `, ${result.counts.newFollowers} new follower(s), ${result.counts.lostFollowers} lost follower(s)`) +
          ".";
      }
      answer.push(summary);
      for (const row of result.rows.slice(0, 10)) {
        answer.push(
          `${row.firstSeenAt} — ${row.change.replace(/_/g, " ").toLowerCase()} @${row.username}` +
            (row.mutualNow === true ? " (mutual now)" : ""),
        );
      }
      if (result.truncated) answer.push(`Showing the newest ${result.limit} row(s); raise the limit for the rest.`);
      for (const note of result.notes.slice(0, 3)) answer.push(note);
      return stepResult(intent, summary, result);
    }

    case "export": {
      const username = requireUsername(plan);
      const result = await opExport(ctx, {
        target: username,
        kind: plan.exportKind ?? "activity",
        format: "csv",
        ...(plan.since === null ? {} : { since: plan.since }),
        ...(plan.limit === null ? {} : { limit: plan.limit }),
        ...(plan.period === null ? {} : { period: plan.period }),
      });
      const summary = `Exported ${result.rowCount} ${result.kind} row(s) for @${result.target.username} as ${result.format}.`;
      answer.push(summary);
      if (result.truncated) answer.push("The export hit its row bound; raise --limit for more.");
      answer.push(result.note);
      answer.push("The full content is in this step's result; `igtrack export ... --out file.csv` writes it to disk.");
      return stepResult(intent, summary, result);
    }

    case "digest": {
      const result = await opDigest(ctx, {
        ...(plan.username === null ? {} : { target: plan.username }),
        since: plan.since ?? "7d",
        ...(plan.limit === null ? {} : { limit: plan.limit }),
      });
      const countText = Object.entries(result.counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([type, count]) => `${type} ${count}`)
        .join(", ");
      const summary = `Digest for ${result.scope}: ${result.total} event(s)${countText === "" ? "" : ` (${countText})`}.`;
      answer.push(summary);
      for (const [label, names] of [
        ["New followers", result.named.newFollowers],
        ["Lost followers", result.named.lostFollowers],
        ["Now following", result.named.newFollowing],
        ["No longer following", result.named.lostFollowing],
      ] as const) {
        if (names.length > 0) answer.push(`${label}: ${names.slice(0, 10).join(", ")}`);
      }
      for (const item of result.items.slice(0, 5)) {
        const evidence = item.evidenceId === null ? "" : ` [${item.evidenceId}]`;
        answer.push(`${isoDate(item.timestamp)} — ${item.summary}${evidence}`);
      }
      if (result.total === 0) answer.push("No stored event falls in this window. That is a fact about the record, not proof the account was quiet.");
      return stepResult(intent, summary, result);
    }

    case "relationships": {
      const username = requireUsername(plan);
      const result = await opRelationships(ctx, {
        target: username,
        ...(plan.limit === null ? {} : { limit: plan.limit }),
      });
      const summary = `${result.ranks.length} ranked account(s) from observed evidence for @${result.target.username}.`;
      answer.push(summary);
      for (const rank of result.ranks.slice(0, 8)) {
        answer.push(
          `@${rank.username} — score ${rank.score} (mentions ${rank.signals.mentions}, comments ${rank.signals.comments}, follow changes ${rank.signals.deltas})`,
        );
      }
      if (result.syntheticRanks.length > 0) {
        answer.push(
          `A separate synthetic ranking has ${result.syntheticRanks.length} row(s); synthetic and live evidence are never blended.`,
        );
      }
      if (result.ranks.length === 0) {
        answer.push("No live relationship signal is stored yet. An empty ranking means no observation, not no interaction.");
      }
      return stepResult(intent, summary, result);
    }

    case "insights": {
      const username = requireUsername(plan);
      const result = await opInsights(ctx, {
        target: username,
        ...(plan.limit === null ? {} : { limit: plan.limit }),
      });
      const summary =
        `${result.state.points} recorded metric point(s), ${result.state.absences} recorded absence(s) ` +
        `(latest observation ${isoDate(result.state.latestObservedAt)}).`;
      answer.push(summary);
      if (result.state.points === 0) {
        answer.push(
          result.source.reason === null
            ? "No insight point is stored yet. That means none was observed and recorded — not that the metrics are zero."
            : `No insight point is stored, and the configured source cannot observe insights at all: ${result.source.reason}`,
        );
      }
      for (const row of result.latest.rows.slice(0, 8)) {
        answer.push(`${row.metric} (${row.period}) = ${row.value}, observed ${isoDate(row.observedAt)}`);
      }
      for (const absence of result.state.latestAbsences.slice(0, 4)) {
        answer.push(`${absence.metric} was reported unavailable: ${absence.reason}`);
      }
      return stepResult(intent, summary, result);
    }

    case "tags": {
      const username = requireUsername(plan);
      const result = await opTaggedMedia(ctx, {
        target: username,
        ...(plan.limit === null ? {} : { limit: plan.limit }),
      });
      let summary = `${result.rowCount} tagged-media row(s) for @${result.target.username}.`;
      if (result.listing !== null && result.listing.completion !== null) {
        summary += ` The latest listing read completed ${result.listing.completion}.`;
      }
      answer.push(summary);
      if (result.rowCount === 0) {
        answer.push(
          "No tagged-media row is stored. The platform excludes media from private accounts, and an empty list is not proof that no tag exists.",
        );
      }
      for (const row of result.rows.slice(0, 8)) {
        answer.push(
          `@${row.ownerUsername}${row.caption === null ? "" : ` — ${row.caption.replace(/\s+/g, " ").slice(0, 90)}`}`,
        );
      }
      return stepResult(intent, summary, result);
    }

    case "dossier": {
      const username = requireUsername(plan);
      const result = await opDossier(ctx, { target: username });
      const observed = result.coverage.filter((row) => row.state === "OBSERVED").length;
      const unavailable = result.coverage.filter((row) => row.state === "UNAVAILABLE").length;
      const notObserved = result.coverage.filter((row) => row.state === "NOT_OBSERVED").length;
      const summary =
        `Stored record for @${result.target.username}: ${observed} observed capabilit(ies), ` +
        `${unavailable} unavailable, ${notObserved} not yet observed (${result.route.evidenceClass} evidence).`;
      answer.push(summary);
      const latest = result.profile.latest;
      if (latest === null) {
        answer.push(
          "No profile snapshot is stored yet. Stored-with-no-rows means not observed — not an empty profile.",
        );
      } else {
        answer.push(
          `Latest profile: followers ${latest.followerCount ?? "unavailable"}, following ${latest.followingCount ?? "unavailable"}, posts ${latest.postCount ?? "unavailable"} — observed ${latest.observedAt}.`,
        );
      }
      for (const row of result.coverage.filter((entry) => entry.state === "UNAVAILABLE").slice(0, 3)) {
        answer.push(`${row.label} is unavailable: ${row.reason ?? "no reason recorded"}`);
      }
      return stepResult(intent, summary, result);
    }

    case "research": {
      const username = requireUsername(plan);
      const result = await opResearch(ctx, {
        target: username,
        ...(plan.since === null ? {} : { since: plan.since }),
      });
      const summary =
        `Research report for @${result.target.username}: ${result.claims.groups.length} claim group(s), ` +
        `${result.contradictions.length} contradiction(s); themes ${result.themes.state.toLowerCase()}, ` +
        `changes ${result.changes.state.toLowerCase()}.`;
      answer.push(summary);
      if (result.claims.groups.length === 0) {
        answer.push(
          "No claim is recorded yet. An empty ledger means nobody submitted research — it is not a statement that the account has no public footprint.",
        );
      }
      for (const group of result.claims.groups.slice(0, 6)) {
        const first = group.claims[0];
        if (first !== undefined) {
          answer.push(`${group.predicate} = ${first.value} (${group.relation})`);
        }
      }
      for (const contradiction of result.contradictions.slice(0, 3)) {
        answer.push(
          `Sources disagree on ${contradiction.predicate}: ${contradiction.values.map((value) => value.value).join(" vs ")}`,
        );
      }
      return stepResult(intent, summary, result);
    }

    case "plan": {
      const username = requireUsername(plan);
      const goal = planGoal(plan.prompt);
      const result = await opPlan(ctx, {
        target: username,
        ...(goal === undefined ? {} : { goal }),
      });
      const nextAction = result.nextAction;
      const plain = nextAction === null ? null : plainNext(nextAction.tool, result.target.username);
      let summary: string;
      if (nextAction === null) {
        summary = `Plan for @${result.target.username}: no open step remains for goal ${result.goal}.`;
      } else if (plain === null) {
        summary = `Plan for @${result.target.username}: next is ${nextAction.tool} — ${nextAction.because}`;
      } else {
        summary = `Plan for @${result.target.username}: the next move is to ${plain.label}.`;
      }
      answer.push(summary);
      if (nextAction !== null) {
        answer.push(nextAction.because);
        if (plain !== null) answer.push(`Say: ${plain.say}`);
      }
      return stepResult(intent, summary, result);
    }

    case "evidence": {
      const result = await opEvidence(ctx, {
        ...(plan.evidenceId === null ? {} : { id: plan.evidenceId }),
        ...(plan.limit === null ? {} : { limit: plan.limit }),
      });
      if (result.mode === "chain") {
        const chain = result.chain;
        if (chain === null) {
          throw new CliError("EVIDENCE_NOT_FOUND", `No evidence row ${plan.evidenceId ?? ""} is visible.`, 2);
        }
        const summary = `Evidence ${plan.evidenceId ?? ""}: ${chain.claim} (${chain.lineage.length} lineage row(s)).`;
        answer.push(summary);
        for (const row of chain.lineage.slice(0, 8)) {
          answer.push(`${row.label}: ${row.value}`);
        }
        return stepResult(intent, summary, result);
      }
      const summary = `${result.rows.length} recent evidence row(s).`;
      answer.push(summary);
      for (const row of result.rows.slice(0, 8)) {
        answer.push(
          `${isoDate(row.observed_at)} — ${row.observation_kind} from ${row.source_id} [${row.id}]`,
        );
      }
      if (result.rows.length === 0) {
        answer.push("No evidence row is stored yet. Nothing recorded means nothing observed — not that nothing exists.");
      }
      return stepResult(intent, summary, result);
    }

    case "audit": {
      const username = requireUsername(plan);
      const result = await opAudit(ctx, {
        username,
        ...(plan.urls.length > 0 ? { urls: plan.urls } : {}),
      });
      const summary = result.summary.headline;
      answer.push(summary);
      answer.push(result.observation.statement);
      for (const error of result.errors.slice(0, 3)) {
        answer.push(`${error.step} failed (${error.code}): ${error.message}`);
      }
      for (const nextStep of result.nextSteps.slice(0, 2)) {
        answer.push(`Suggested next: ${nextStep.action} (${nextStep.because})`);
      }
      return stepResult(intent, summary, result);
    }

    case "lookup": {
      const username = requireUsername(plan);
      const result = await opLookup(ctx, { username });
      answer.push(result.why);
      return stepResult(intent, result.why, result);
    }

    case "targets": {
      const targets = await opTargetList(ctx);
      const summary = `${targets.length} tracked account(s).`;
      answer.push(summary);
      if (targets.length === 0) {
        answer.push('Nothing is tracked. Add an account with: igtrack ask "track @yourhandle".');
      }
      for (const target of targets.slice(0, 12)) {
        answer.push(
          `@${target.username} — ${target.observationMode}, ${target.status}, last observed ${isoDate(target.lastObserved)}`,
        );
      }
      return stepResult(intent, summary, targets);
    }

    case "status": {
      const result = await opStatus(ctx);
      const provider = result.provider;
      const summary =
        `Provider "${provider.name}" is ${provider.usable ? "usable" : "NOT usable"}${provider.synthetic ? " (synthetic)" : ""}; ` +
        `${result.targets.total} target(s), ${result.targets.active} active; ` +
        `${result.scans.total} scan job(s) recorded (last completed ${isoDate(result.scans.lastCompletedAt)}).`;
      answer.push(summary);
      if (provider.error !== null) {
        answer.push(`Provider error: ${provider.error}`);
      }
      for (const health of result.sourceHealth.filter((row) => row.status !== "OK").slice(0, 3)) {
        answer.push(
          `${health.sourceId} / ${health.capability} is ${health.status}${health.lastFailureReason === null ? "" : `: ${health.lastFailureReason}`}`,
        );
      }
      return stepResult(intent, summary, result);
    }

    default:
      throw new CliError("USAGE", `Unknown intent "${intent}".`, 2);
  }
}

function advisoryStep(intent: AskIntent, plan: AskPlan): AskStep {
  const handle = plan.username ?? "<username>";
  if (intent === "untrack") {
    return suggestionStep(
      intent,
      `igtrack targets rm ${handle} --yes`,
      "Removing an account deletes its stored observations and cannot be undone, so I will not run it from a prompt. Use the command when you are sure.",
    );
  }
  if (intent === "stories") {
    return suggestionStep(
      intent,
      `igtrack anonstories ${handle}`,
      "Stories and highlight contents are read by a separate command through a local browser (third-party relay, PUBLIC_AGGREGATOR evidence).",
    );
  }
  if (intent === "post") {
    const permalink = plan.urls.find((url) =>
      /\binstagram\.com\/(?:[a-z0-9._]+\/)?(?:p|reel|tv)\//i.test(url),
    );
    if (permalink !== undefined) {
      return suggestionStep(
        intent,
        `igtrack post ${permalink}`,
        "A single post is read by its own database-free command: it names the post, its owner and caption, and the exact evidence it observed — nothing is stored.",
      );
    }
    return suggestionStep(
      intent,
      "igtrack post <permalink>",
      "Give me an Instagram permalink (instagram.com/p/…, /reel/… or /tv/…) and `igtrack post <permalink>` reads that one post without touching the database.",
    );
  }
  return suggestionStep(
    intent,
    `igtrack public ${handle}`,
    "Logged-out public pages are read by a separate command through a local browser (PUBLIC_WEB evidence).",
  );
}

/** The guide is database-free, so it must also read well as raw JSON (agents). */
function guideStep(answer: string[]): AskStep {
  const report = opCapabilities();
  answer.push(
    "IGTrack turns a plain-English request into evidence-backed Instagram operations — and reports what it could not observe.",
    "You can ask things like:",
    ...ASK_EXAMPLES.slice(0, 6).map((example) => `  "${example}"`),
    `${report.summary.available} of ${report.summary.total} capabilities are obtainable with this configuration; ask "what are the limitations?" for the rest and the reason.`,
    "Every stored row carries an evidence id. null means not observable — never zero.",
  );
  return {
    intent: "guide",
    status: "OK",
    summary: `IGTrack turns a plain-English request into evidence-backed operations. ${report.summary.available} of ${report.summary.total} capabilities are obtainable with this configuration.`,
  };
}

/** Capabilities are pure configuration data: they answer with no database. */
function capabilitiesStep(answer: string[]): AskStep {
  const result = opCapabilities();
  const summary = `${result.summary.available} of ${result.summary.total} capabilities are obtainable with this configuration.`;
  answer.push(summary);
  for (const capability of result.capabilities.filter((entry) => !entry.available).slice(0, 5)) {
    answer.push(`${capability.label} — ${capability.why ?? "not exposed"}`);
  }
  return stepResult("capabilities", summary, result);
}

function needsInput(
  plan: AskPlan,
  assumptions: string[],
  targets: Targets,
): AskResult {
  const names = targets.map((target) => target.username);
  const answer: string[] = [];
  if (targets.length === 0) {
    answer.push(
      "I need an account to work on, and nothing is tracked yet. Try: igtrack ask \"investigate @yourhandle\" — it records the account and produces a dossier.",
    );
  } else if (names.length === 1) {
    const only = names[0] ?? "<username>";
    answer.push(`You track one account. Say @${only} and I will run it, or ask "investigate @${only}".`);
  } else {
    answer.push(`Which account do you mean? You track: ${names.slice(0, 12).map((name) => `@${name}`).join(", ")}.`);
  }
  return {
    prompt: plan.prompt,
    understanding: {
      summary: describePlan(plan),
      intents: plan.intents,
      username: plan.username,
      since: plan.since,
      limit: plan.limit,
      assumptions,
      confidence: plan.confidence,
    },
    status: "NEEDS_INPUT",
    steps: [
      {
        intent: plan.primary,
        status: "SKIPPED",
        summary: "Waiting for an account.",
      },
    ],
    answer,
    next: nextFor(plan),
    examples: plan.examples,
  };
}

export async function opAsk(
  ctx: CliContext | null,
  plan: AskPlan,
  options: AskOptions = {},
): Promise<AskResult> {
  const answer: string[] = [];
  const assumptions = [...plan.assumptions];
  let active = plan;
  let targets: Targets = [];

  if (ctx !== null) {
    targets = await opTargetList(ctx);
    if (targets.length > 0) {
      const names = targets.map((target) => target.username);
      const replanned = planAsk(plan.prompt, { knownTargets: names });
      if (replanned.username !== null && replanned.username !== plan.username) {
        assumptions.push(`I read the account in your prompt as your tracked account @${replanned.username}.`);
      }
      active = { ...replanned, assumptions };
    }
  }

  if (active.username === null && active.needsUsername && targets.length === 1) {
    const only = targets[0];
    if (only !== undefined && active.primary !== "track" && active.primary !== "untrack") {
      active = {
        ...active,
        username: only.username,
        needsUsername: false,
        assumptions,
      };
      assumptions.push(`No account was named, so I used your only tracked account @${only.username}.`);
    }
  }

  if (active.needsUsername) {
    return needsInput(active, assumptions, targets);
  }
  if (active.needsDb && ctx === null) {
    throw new CliError(
      "DB_UNAVAILABLE",
      "This request needs the database, but no connection was available.",
      3,
    );
  }

  const steps: AskStep[] = [];
  for (const intent of active.intents) {
    if (intent === "guide") {
      steps.push(guideStep(answer));
      continue;
    }
    if (intent === "capabilities") {
      steps.push(capabilitiesStep(answer));
      continue;
    }
    if (ADVISORY.has(intent)) {
      steps.push(advisoryStep(intent, active));
      continue;
    }
    if (ctx === null) continue;
    options.onProgress?.(progressText(intent, active));
    try {
      steps.push(await runIntent(ctx, intent, active, answer));
    } catch (err) {
      const failed = failedStep(intent, err);
      steps.push(failed);
      const hint = failed.error === undefined ? null : errorHint(failed.error.code, failed.error.message);
      answer.push(`${intent} could not complete: ${failed.error?.message ?? "unknown error"}`);
      if (hint !== null) answer.push(hint);
    }
  }

  if (ctx !== null) {
    if (ctx.meta.synthetic) {
      answer.unshift(
        "Configured source: the synthetic fixture. Scans and lookups this deployment runs through it write generated demo rows, not Instagram observations; stored rows keep their own provenance (each step's evidence ids say what its rows are).",
      );
    }
    const syntheticIntents = syntheticStepIntents(steps);
    if (syntheticIntents.length > 0) {
      answer.unshift(
        `Synthetic fixture rows: ${syntheticIntents.join(", ")} answered from generated demo data, not from a real account. Nothing in those steps describes a person.`,
      );
    }
    if (ctx.provider.error !== null) {
      answer.unshift(`The provider "${ctx.provider.name}" is not usable: ${ctx.provider.error}`);
    }
  }

  const failedCount = steps.filter((step) => step.status === "FAILED").length;
  const okCount = steps.filter((step) => step.status === "OK").length;
  const status: AskStatus =
    failedCount === 0 ? "ANSWERED" : okCount === 0 ? "FAILED" : "PARTIAL";

  return {
    prompt: active.prompt,
    understanding: {
      summary: active.primary === "guide" ? "what I can do, and how to ask" : describePlan(active),
      intents: active.intents,
      username: active.username,
      since: active.since,
      limit: active.limit,
      assumptions,
      confidence: active.confidence,
    },
    status,
    steps,
    answer,
    next: nextFor(active),
    examples: active.examples,
  };
}
