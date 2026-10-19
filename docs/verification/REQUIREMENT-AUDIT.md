# Requirement audit — the central use case mapped to code, source and evidence (2026-10-19)

**Question this document answers:** *an operator types an unknown Instagram
username — what can this product lawfully show them, what shows it, from which
source, under which credential, and what is missing?*

It is the part-1 deliverable of the deep-intelligence requirement: the mapping
from requirement → implementation → source → auth → legal constraint →
verification evidence. The refusals themselves are founding law and are not
re-decided here ([FOUNDING.md](../FOUNDING.md) §14.1, §15.1, §18, §19);
this document only reports where each clause stands in the tree today.

## Method and limits (read this first)

- **Read-only audit.** No code was changed to produce the mapping; every row
  below points at an existing file, function or test that can be opened and
  checked.
- **No live credentials exist in this environment.** Nothing marked
  `NOT_VERIFIED` below has been observed against a real Instagram endpoint or
  a real search provider. Those are reported as external blockers with their
  exact prerequisites — never as working, never as failing.
- **Fixture evidence is synthetic by definition.** Every "verified" row names
  the test or command that verifies it; a fixture pass proves the pipeline, not
  the platform.
- **The one live probe on record** is the public-web fetch of 2026-10-18
  (real internet, real fetcher) recorded in [FOUNDING.md](../FOUNDING.md) §19
  and [DEEP-ACCOUNT-INTELLIGENCE.md](../DEEP-ACCOUNT-INTELLIGENCE.md) §12.2.
  It is cited here as evidence for the web phase only.

---

## 1. The workflow as built, for one arbitrary handle

The product's central use case has a single entry point and a fixed
read-only-then-record shape. Every step names its code path:

| # | Step | Command / tool | Code path | Writes? |
|---|---|---|---|---|
| 1 | Is this configuration able to answer at all? | `igtrack audit <handle>` phase 1 (config), `igtrack doctor` | `opAudit` → `opDoctor` (`apps/cli/src/tools.ts`) | No — a blocked config is `CONFIGURATION_ERROR` (exit 3), never an empty report |
| 2 | Can the platform route see this handle right now? | `igtrack audit <handle>` phase 2 (probe) → `igtrack lookup` | `opAudit` probe phase, `opLookup` (`apps/cli/src/tools.ts:1613`) | **No.** A probe persists nothing (D53) |
| 3 | What does the public web state about this handle? | `igtrack audit <handle> --url … [--max-sources N]` | `opAuditWebProbe` (`apps/cli/src/tools.ts:3502`) | **No.** Takes no database handle, so storage is structurally impossible (D70) |
| 4 | What has this deployment already recorded? | `igtrack audit <handle>` phase 3 (record) | `opAudit` → `opResearch` (`:2187`) + `opPlan` (`:2607`), read-only | No |
| 5 | Watch this account (explicit act) | `igtrack targets add <handle> --observed` | `opTargetAdd` (`:318`), refuses on UNAVAILABLE (D49) | Yes — creates a `DISCOVERY` target |
| 6 | Record what the platform route returns | `igtrack scans run --kinds DISCOVERY_SCAN --target <handle>` | `workers/monitoring` executor + `packages/ingestion` graph provider | Yes — snapshots, bounded media rows, evidence |
| 7 | File the citations worth keeping | `igtrack claims add …` | `opClaimAdd` (`:1901`) → `packages/core/src/claims.ts` (closed predicate registry, sensitive refusals) | Yes — claims ledger (operator-authored) |
| 8 | Read the whole thing back | `igtrack research <handle>`, `igtrack dossier <handle>`, `igtrack relationships <handle>` | `opResearch`, `opDossier` (`:894`), `opRelationships` (`:711`) | No |
| 9 | The same surface for agents | MCP `igtrack_audit`, `igtrack_lookup`, `igtrack_dossier`, … (24 tools) | `apps/cli/src/mcp/server.ts`, semantics in `apps/cli/src/tools.ts` | `readOnlyHint` on every read |

Steps 1–4 are available for **any** handle with **no** registration and **no**
credential for the target account. Step 5 is where observation begins, and it
is refused (not silently degraded) when the route cannot answer.

---

## 2. Clause-by-clause requirement mapping

Status vocabulary: **Built** = implemented *and* covered by tests in this
tree; **Built, `NOT_VERIFIED` live** = implemented, docs-pinned, no credential
has exercised it; **Refused** = structurally unavailable or legally declined,
with the reason on record; **Partial** = the lawful sliver is built, the rest
refused.

| Clause (FOUNDING) | Ask | Lawful source | Implementation + code path | Auth needed | Target must be owned? | Verification evidence | Missing work / blocker |
|---|---|---|---|---|---|---|---|
| §14.1 **A1** | Any public username → details (counts, posts) | Business Discovery edge (`packages/ingestion/src/graph`) | `discoverAccount` → `opLookup`; recording via `opTargetAdd --observed` + `DISCOVERY_SCAN` (`workers/monitoring`) | Facebook Login product, `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement`, long-lived operator token, `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1` | No (query *from* an account you own) | **Built, `NOT_VERIFIED` live.** Fixture end-to-end in `apps/cli/test/audit.test.ts` (discovery probe AVAILABLE, bounded 2 media rows, "nothing was persisted") | Live call: `pnpm verify:graph` with a real token |
| §14.1 **A2** | Tags / tagged content | Own-account `tags` edge | `opTaggedMedia` (`apps/cli/src/tools.ts:1150`) + `TAGS_SCAN` | Same graph credential; owned account only | **Yes — own account only** | **Built, `NOT_VERIFIED` live.** `liveEvidence`: fixture v1 full pipeline, request shape docs-pinned (Meta tags reference, read 2026-10-16) | Live edge observation under this integration's credentials |
| §14.1 **A3** | Their stories | Own-account `stories` edge only | `STORIES` executor → `stories`/`storySightings` tables | Graph credential, owned account | **Yes** | **Built, `NOT_VERIFIED` live**; fixture pipeline green | No lawful route exists for another account's stories → stays refused for third parties |
| §14.1 **A4** | Highlights, story tags, highlight tags "even if hidden" | — | Registry entry `HIGHLIGHTS` renders `UNAVAILABLE` with `whyUnavailable`; no table, no method, no UI beyond the honest state | — | — | **Refused, `DOCUMENTED_ABSENT`** (exhaustive IG User edge list has no highlights edge) | Only an official highlights edge would unlock it; "hidden" means a session cookie = invariant 3 |
| §14.1 **A5** | All comments the account left elsewhere | — | `INTERACTIONS` registry entry: table exists as a typed landing zone with **no writer**; relationships derive from observed signals instead | — | — | **Refused, `DOCUMENTED_ABSENT`** (no interaction feed in the IG Platform reference) | Lawful sliver built: comment authorship on **owned** media (`post_comments`) as a relationship signal (D43) |
| §14.1 **A6** | All likes the account made | — | `LIKES` registry entry: `like_count` is provider metadata, rendered as such, never as activity | — | — | **Refused, `DOCUMENTED_ABSENT`** (no liker edge on IG Media/IG Comment) | None possible: no credential unlocks an edge that does not exist |
| §14.1 **A7** | Reposts | `reposts_count` scalar on owned media; identities: none | `REPOSTS` (parse-when-present, never zero-filled); `RESHARES` refused | Graph credential | For the scalar, **yes** | **Partial — scalar `NOT_VERIFIED` live** (not yet requested: an unknown field name fails the whole media call) | Add `reposts_count` to `GRAPH_MEDIA_FIELDS` **after** a live check (`pnpm verify:graph`); identities permanently refused |
| §14.1 **A8** | "If anyone takes the user id, it should show" | Discovery response carries `id` | D44 semantics: id is an **output**, matched for identity resolution (D52), never a lookup key | — | — | **Built** (`resolveTarget` id-first matching, `packages/database` account matching tests) | None |
| §14.1 **A9** | Who followed/unfollowed since last audit, by name | Operator's own Instagram export | `import:v1` provider → `followSnapshots` → `followDeltas` → activity feed | None (file the operator already owns) | **Yes — owned/exported account** | **Built and exercised end-to-end** (`import-provider` tests, demo `NEW_FOLLOWING`/`LOST_FOLLOWING` rows); COMPLETE-only diff gate tested ("never diffs a PARTIAL snapshot") | For a third party: no roster edge exists → `DOCUMENTED_ABSENT` (counts only) |
| §14.1 **A10** | Closest contacts through the whole follow graph, recursively | Observed signals on **owned** accounts only | `opRelationships`: story mentions (12) + comment authorship (10) + follow deltas (8), de-duplicated, evidence rows + method block (D43, D51) | Graph credential / export for the owned side | **Yes** | **Built** (`activity-relationships.test.ts`: signal counts, dedup, recency beside counts) | Recursive traversal: **refused permanently** — the input does not exist lawfully (§14.3, §15.1) |
| §15.1 (A4–A7, A9 restated) | Cross-account record instead of a probe | Business Discovery | `observation_mode = DISCOVERY`, `DISCOVERY_SCAN` → `COMPLETED_PARTIAL` with cap 12 in evidence (D47–D48) | Same as A1 + opt-in flag | No — but the operator must **name** the account | **Built, `NOT_VERIFIED` live**; `discovery-scan.test.ts` 10 cases green | Live Graph call |
| §18 | Cited claims about an account | Operator/agent research of the open web | `opClaimAdd`/`opClaimList`/`opClaimRetract` → `packages/core/src/claims.ts` (9-predicate closed registry, sensitive refusals, excerpt hashing, `DUE_FOR_REVIEW` at 180 days) | None | Claim is filed against a target the operator tracks | **Built, fully test-covered** (local pipeline: validate → hash → store → render) | None; platform exposes no edge for any predicate (`DOCUMENTED_ABSENT` by evidence) |
| §18 (engine) | The engine fetches bounded public web sources | Public pages the operator names, SSRF-gated | `opResearchRun` (`apps/cli/src/tools.ts:2963`) + `packages/ingestion/src/research/*` (gate, extractor, search adapters) | Search provider key (optional) | Target must exist for a **run** | **Built.** Pipeline verified by injected-transport tests; **live fetch VERIFIED 2026-10-18** (3 named pages, real digests); **live search VERIFIED 2026-10-19** (keyless: `auto` → FreeSerp index, no key, D73) | Keyed Brave leg only: `IGTRACK_RESEARCH_SEARCH_PROVIDER=brave` + `IGTRACK_RESEARCH_SEARCH_API_KEY` |
| §19 (D70) | Research a stranger's handle without registering it | Same gate, no database handle | `opAuditWebProbe` (`apps/cli/src/tools.ts:3502`), CLI `--url`/`--max-sources`, MCP `igtrack_audit` inputs | Search provider key (optional) | **No** | **Built.** 9-scenario matrix in `apps/cli/test/audit.test.ts`; **live VERIFIED 2026-10-18** (fetch) and **2026-10-19** (keyless search: `SEARCH_SUCCEEDED` via `auto`/FreeSerp, relevance-gated zero) | None for the default path; Brave key optional |
| §19 (D71) | Is any of this even lawful? | — | `docs/verification/SOURCE-AUDIT.md` (dated, URL-cited verdict table) | — | — | **Written and cited** | — |

**Refusal rows that must never be built** (restated so a future agent reads
them here, not as TODOs): likers, third-party outgoing comments/likes, repost
identities, other accounts' follower/following rosters, highlights (hidden or
not), story/highlight tags of others, recursive graph traversal, any
session-cookie or undocumented-endpoint path. Sources for each are in
FOUNDING §14.1/§15.1 and the `whyUnavailable` strings in
`packages/core/src/capabilities.ts`.

---

## 3. Capability registry cross-reference

`packages/core/src/capabilities.ts` is the single source of truth (AGENTS.md
§3 invariant 6). Its 25 entries, by `liveState`:

| `liveState` | Count | Entries |
|---|---|---|
| `LIVE_VERIFIED` | **0** | — (no live credential exists in this environment) |
| `NOT_VERIFIED` (implemented, docs-pinned) | 17 | PROFILE, COUNTS, ACCOUNT_INSIGHTS, OTHER_ACCOUNT_PUBLIC, STORIES, STORY_METADATA, STORY_MENTIONS, MENTION_INTELLIGENCE, TAGS, MENTIONED_COMMENTS, POSTS, REELS, CAROUSELS, COMMENTS, REPLIES, REPOSTS, WEB_RESEARCH |
| `DOCUMENTED_ABSENT` (evidence of absence) | 8 | HIGHLIGHTS, FOLLOWERS, FOLLOWING, LIKES, INTERACTIONS, RESHARES, MEDIA — plus ACCOUNT_RESEARCH, whose absence is the platform's and whose supply is the operator's (`operatorSupplied`) |

Two supply modes are rendered distinctly and must not be confused with
availability-by-provider: `operatorSupplied` (claims ledger) and
`engineSupplied` (bounded web acquisition).

`docs/CAPABILITIES.md` is generated (`pnpm docs:capabilities`); a drift test
pins registry ↔ provider methods ↔ schema tables.

---

## 4. Implemented vs verified — the honest split

**Verified in this environment (tests + one live probe):**

- Requirement mapping and refusals: every row above points at code that
  exists, with tests named.
- The read-only investigation path end-to-end on fixtures:
  `apps/cli/test/audit.test.ts` (23 tests, green 2026-10-19) — config gating,
  probe-not-record, coverage-behind-every-count, refusals travelling with the
  report, staleness surfaced as `DUE_FOR_REVIEW` (count + limitation + human
  line, never an expiry), `STALE` plan steps, ledger byte-identical after an
  audit, human screen == JSON envelope.
- Public-web acquisition against the real internet: **VERIFIED 2026-10-18**
  (named pages fetched, digests/timestamps recorded, 383 links counted and not
  followed, search provider reported `UNAVAILABLE` with its exact remedy).
- Claims ledger, diff gates, mention classification, relationship ranking,
  discovery-scan semantics: the full `pnpm test` suite (see
  [VERIFICATION.md](VERIFICATION.md)).

**Implemented but NOT verified live (external blocker, stated exactly):**

| Blocked item | Exact prerequisite |
|---|---|
| Graph provider (profile, counts, stories, posts, comments, tags, insights) | Real long-lived token + `IGTRACK_GRAPH_IG_USER_ID` + `pnpm verify:graph` |
| Business Discovery / `DISCOVERY_SCAN` (A1, §15 record path) | Above **plus** `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1` and a linked professional account |
| Search-provider candidates in `audit`/`research --run` | Nothing for the default path: `IGTRACK_RESEARCH_SEARCH_PROVIDER=auto` (shipped in `.env`) searches keylessly via the FreeSerp index. The keyed official API is `=brave` + `IGTRACK_RESEARCH_SEARCH_API_KEY`; `=none` keeps every search request on the machine |
| CI | Not runnable in this environment (no activation performed) |

Nothing above is reported as working. A missing credential is a
configuration fact, never an empty dataset (invariant 7).

---

## 5. What a real arbitrary-username investigation looks like today

```bash
# 1. read-only, no registration, any handle
pnpm igtrack audit <handle> --url "https://official-site/about"

# 2. if the platform route can see it, record it deliberately
pnpm igtrack targets add <handle> --observed
pnpm igtrack scans run --kinds DISCOVERY_SCAN --target <handle>
pnpm igtrack work

# 3. file the citations worth keeping, then read back
pnpm igtrack claims add <handle> --predicate ORGANIZATION_NAME --value "…" --source-url "…"
pnpm igtrack research <handle> --format md
pnpm igtrack dossier <handle>
```

Every step that needs a credential says which one, in the report itself.
Steps 1 and 3 need none.

## 6. Missing work (open, ordered)

1. **Live Graph verification** (`pnpm verify:graph`) — unblocks the 17
   `NOT_VERIFIED` entries in one pass; also the gate for requesting
   `reposts_count` (A7 scalar).
2. **Search provider key** — turns the audit's web phase from `NOT_ATTEMPTED`
   into real candidate planning.
3. **Own-account `mentions` edge** (D46) — the recorded lawful increment that
   is still not built. The `tags` edge *is* built (`TAGS_SCAN`,
   `workers/monitoring/src/executors.ts:1019`, owned targets only); the
   mentioned-comment read exists as a stateless probe
   (`opMentionedCommentProbe`) whose ids arrive only through Meta webhooks.
4. **Nothing in the refusal list is work.** A4/A5/A6/A7-identities/A9-for-others
   /A10-recursive stay refused until a dated founding entry changes them
   (AGENTS.md §8).
