import { VERSION } from "./version.js";
import {
  CONFIG_HELP,
  DOCTOR_HELP,
  SETUP_HELP,
  STATUS_HELP,
} from "./commands/setup.js";
import { AUDIT_HELP } from "./commands/audit.js";
import { INVESTIGATE_HELP } from "./commands/investigate.js";
import { PUBLIC_HELP } from "./commands/public.js";
import { POST_HELP } from "./commands/post.js";
import { ANONSTORIES_HELP } from "./commands/anonstories.js";
import { VIEWER_HELP } from "./commands/viewer.js";
import { TARGETS_HELP } from "./commands/targets.js";
import { SCANS_HELP, WORK_HELP } from "./commands/scans.js";
import {
  ACTIVITY_HELP,
  CAPABILITIES_HELP,
  DOSSIER_HELP,
  EVIDENCE_HELP,
  INSIGHTS_HELP,
  LOOKUP_HELP,
  MENTION_HELP,
  RELATIONSHIPS_HELP,
  TAGS_HELP,
} from "./commands/read.js";
import { MCP_HELP } from "./mcp/server.js";
import { ASK_HELP } from "./commands/ask.js";
import {
  ALERTS_HELP,
  AUDIENCE_HELP,
  DIGEST_HELP,
  EXPORT_HELP,
  RECENT_HELP,
  REPORT_HELP,
  REPORTS_HELP,
} from "./commands/report.js";
import { ACTIVITY_REPORT_HELP } from "./commands/activity-report.js";
import { TRACKER_HELP } from "./commands/tracker.js";
import { CLAIMS_HELP, PLAN_HELP, RESEARCH_HELP } from "./commands/intel.js";

// ---------------------------------------------------------------------------
// The help registry.
//
// Every command has exactly one contract, and both entry points — `igtrack
// help <command>` and `igtrack <command> --help` — read it from here. Keeping
// the map in its own module (rather than in main.ts, which runs on import) is
// what lets a test assert that the documented command list and the help
// surface cannot drift apart.
// ---------------------------------------------------------------------------

export const HELP = `igtrack ${VERSION} — evidence-first Instagram observation engine (self-hosted)

Usage: igtrack <command> [options]

Getting started
  setup                 Prepare this checkout: .env, Postgres, migrations, demo data
  status                Owner, provider, targets, queue, source health
  doctor                Diagnostic: provider usability, DB, scheduler, findings
  config                Effective configuration with credentials redacted

Ask anything (plain English)
  ask "..."             One sentence in, one honest answer out
  guide                 A plain-language tour with examples and limits
  <anything else>       Treated as a prompt: igtrack "who is @aurora.wilde?"

Track
  targets <sub>         list | add | pause | resume | rm        (targets --help)
  scans <sub>           run | list                              (scans --help)

Observe
  investigate <username>  One username in, one dossier out: every supported
                           stage, what was retrieved, and what is still unknown
  public <username>     Full logged-out public-page dossier: profile, links,
                           highlights, every exposed post, and the gaps
  post <post URL>       One post from its own permalink: caption, owner,
                           counts, media, and what the page does not expose
  anonstories <username>  Login-free stories, highlight contents and story
                           mentions via a third-party aggregator; rows are
                           PUBLIC_AGGREGATOR, never a platform observation
  viewer <input>        Six-tab viewer report: stories, posts, reels,
                           highlights, reposts, tagged — with every refusal
  audit <username>      One evidence-honest report: config, probe, stored record
                           --full collects first (archive history + every stage)
  work                  Run the worker now: one scheduler tick + drain the queue
  activity              What changed, newest first, with evidence ids
  relationships <t>     Accounts ranked by observed signal, with provenance
  dossier <target>      Everything recorded about one account, with its gaps
  evidence              Evidence rows (audit trail) and --id chains
  lookup <username>     Ask the source what it can observe, persisting nothing
  insights <target>     Account metrics this deployment recorded, with absences
  tags <target>         Media by other accounts this account is tagged in
  mention <commentId>   Read one mentioned comment by id, persisting nothing

Reports and exports
  tracker [target]      Watchlist with each account's latest closed-period card
  activity-report <target>  Four-tab Activity Report over stored rows
  report <target>       One period composed from stored rows (Markdown; --out)
  reports <target>      Recent periods and whether stored rows exist
  audience <target>     Mutuals and one-way follows over COMPLETE rosters
  recent <target>       New/lost follows since the stored baseline (first-seen)
  export <target>       Stored rows as CSV/JSON (--kind; --out)
  digest [target]       Short local change digest (--since; --out)
  alerts [target]       Digest events as an idempotent local outbox (--out <dir>)

Know the limits
  capabilities          What can and cannot be observed, and exactly why

Research (claims ledger; IGTrack stores, never generates)
  claims <sub>          list | add | retract                       (claims --help)
  research <target>     The full report: observations, claims, contradictions
  plan <target>         The stateless next step for a goal, from stored state

Agent surface
  mcp                   stdio MCP server exposing every operation above as a tool

Metadata
  version               CLI version. Static: no provider, no database, no source
  help <command>        The contract of one command — the same text as \`igtrack
                        <command> --help\`

Every command accepts --json and prints { ok, data, _meta }. \`_meta\` names the
active provider and whether the data is synthetic — fixture data is never
mistakable for a real observation.

Run \`igtrack help <command>\` or \`igtrack <command> --help\` for the contract of
one command; both print the same text.`;

export const GUIDE_HELP = `igtrack guide [--json]

Print the plain-language tour: what IGTrack observes, what it refuses to claim,
and how to ask for work. With --json the same tour is answered through the ask
surface, so an agent gets it inside a { ok, data, _meta } envelope.`;

export const VERSION_HELP = `igtrack version [--json]

Print the CLI version. This is static metadata: no provider is constructed and
no source or database is contacted.`;

/**
 * One entry per documented command. A command listed here but not dispatched
 * is a documentation lie; a dispatched command missing here is a command nobody
 * can read about — both are asserted against the dispatch table in tests.
 */
export const COMMAND_HELP: Record<string, string> = {
  ask: ASK_HELP,
  guide: GUIDE_HELP,
  setup: SETUP_HELP,
  config: CONFIG_HELP,
  status: STATUS_HELP,
  doctor: DOCTOR_HELP,
  capabilities: CAPABILITIES_HELP,
  targets: TARGETS_HELP,
  scans: SCANS_HELP,
  work: WORK_HELP,
  activity: ACTIVITY_HELP,
  relationships: RELATIONSHIPS_HELP,
  dossier: DOSSIER_HELP,
  evidence: EVIDENCE_HELP,
  lookup: LOOKUP_HELP,
  tags: TAGS_HELP,
  mention: MENTION_HELP,
  insights: INSIGHTS_HELP,
  tracker: TRACKER_HELP,
  "activity-report": ACTIVITY_REPORT_HELP,
  report: REPORT_HELP,
  reports: REPORTS_HELP,
  audience: AUDIENCE_HELP,
  recent: RECENT_HELP,
  export: EXPORT_HELP,
  digest: DIGEST_HELP,
  alerts: ALERTS_HELP,
  claims: CLAIMS_HELP,
  research: RESEARCH_HELP,
  plan: PLAN_HELP,
  investigate: INVESTIGATE_HELP,
  audit: AUDIT_HELP,
  public: PUBLIC_HELP,
  post: POST_HELP,
  anonstories: ANONSTORIES_HELP,
  viewer: VIEWER_HELP,
  mcp: MCP_HELP,
  version: VERSION_HELP,
  help: HELP,
};
