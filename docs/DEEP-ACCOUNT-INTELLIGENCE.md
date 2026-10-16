# Deep Account Intelligence — opportunity, audit, design, and implementation plan

**Date:** 2026-10-16 · **Status:** proposal for review. Nothing in this document is implemented; no code or migration was changed by this work. It ends with an authorization request.
**Companion reading:** [FOUNDING.md](FOUNDING.md) §14–§17 (the refusals and discovery rules), [research/05-market-refresh-2026-10-16.md](research/05-market-refresh-2026-10-16.md) (the market/API/legal evidence base), [ARCHITECTURE.md](ARCHITECTURE.md) (the current system).
**Labels used:** `[V]` verified this pass (code read, test read, or primary source fetched 2026-10-16) · `[C]` third-party/vendor claim, not independently verified · `[I]` inference from verified facts · `NOT_VERIFIED` anything not directly checked in this environment.

---

## 1. Product opportunity

### 1.1 The gap, stated precisely

IGTrack today answers "what did the platform return, when, through which route" — with provenance — for the operator's own account (`OWNED` targets) and, narrowly, for other public professional accounts (`DISCOVERY` targets through the documented Business Discovery edge) `[V: apps/cli/src/tools.ts opDossier, packages/core/src/capabilities.ts]`.

What it cannot answer is the founder-requirement class of questions in [FOUNDING §14](FOUNDING.md): *who is this account, what is it tied to, what has it signalled over time* — the questions people actually open a "dossier" for. Today those questions are either refused (structural platform absence: likers, rosters, highlights, third-party comments; [FOUNDING §14.1](FOUNDING.md)) or left empty (identity, organisation, context — nothing in the data model can hold "a source says X about this account").

Market evidence that this gap is the product: research stream 05 ranks "numbers that can be audited and explained when tools disagree" and "agent-native operations with honest failure semantics" in the top three unmet needs, found **zero of ~78 surveyed Instagram MCP servers exposing a ledger, hashes, or UNAVAILABLE-with-reason**, and documented that the platform itself redefined `view_count` mid-flight on 2026-04-22 while no reviewed competitor stores source or hash `[V: research/05 §0, §3, §6]`.

### 1.2 What "deep intelligence" can honestly mean here

Not more data collection. The refusals are structural and stay: there is no lawful route to likers, other accounts' rosters, third-party comments/likes, repost identities, or hidden highlights, and platform terms prohibit eligibility determination, surveillance, and profile-building from Platform Data `[V: Meta Platform Terms §3.a(ii)(iii)(v)(viii), updated 2026-02-03, developers.facebook.com/terms, fetched 2026-10-16; FOUNDING §14.1]`.

Deep intelligence here means **holding and citing what sources say about an account, on the operator's own machine, without confusing it with what the platform returned** — and rendering both together with their provenance and their age. That is a claims layer, not a crawler.

### 1.3 Why nobody else has this

The commercial tools in this space sell the refused capabilities (scraped likers, private-profile viewers — one is listed in the official MCP registry; `[V: research/05 §0-§1]`) and none sells provenance (`[V: research/05 §6.3]`). The OSS/agent ecosystem has zero servers with an evidence ledger `[V: research/05 §0]`. "Claims ledger / evidence graph" patterns exist elsewhere (academic argumentation tooling, market-research agent skills) — the pattern is accepted, the Instagram-shaped honest instance is unclaimed `[I]`.

### 1.4 User jobs, ranked

| # | Job | Today | Honest route |
|---|---|---|---|
| 1 | "Tell me everything checkable about this account, with sources" | dossier = platform observations only | research report = observations + cited claims |
| 2 | "Who is behind this account / what is it tied to" | unanswerable | operator/agent-recorded `claims` with source URLs |
| 3 | "How do I answer this without lying or guessing" | refusals exist but are scattered | every report section carries its state + reason |
| 4 | "Keep research current" | nothing | claim age surfaced; `DUE_FOR_REVIEW` flag, never silent expiry |

---

## 2. Current-state audit

Source of truth: code, tests, migrations — not README claims `[V]`.

### 2.1 Surface inventory

| Surface | Count | Detail `[V]` |
|---|---|---|
| CLI commands | 19 router cases | `setup, config, status, doctor, targets, scans, work, activity, relationships, dossier, evidence, lookup, tags, mention, insights, capabilities, mcp, help, version` — `apps/cli/src/main.ts` |
| MCP tools | 19 | pinned in `apps/cli/test/mcp.test.ts` `EXPECTED_TOOLS` (incl. `igtrack_evidence_chain`) |
| Operation functions | 17 `opXxx` exports | `apps/cli/src/tools.ts` (Status…MentionedCommentProbe) |
| Capability registry entries | 23 ids | `packages/core/src/capabilities.ts` |
| DB tables | 28 | `packages/database/src/schema/tables.ts` |
| Migrations | 0000–0019 applied | next is **0020**; never edit an applied migration |
| Tests | root vitest discovery, all packages | `{packages,apps,workers}/*/test/**/*.test.ts` |

### 2.2 What the data model already supports

- **Append-only evidence ledger** with raw + normalized hashes, source id, observed vs captured time `[V: schema, `packages/core` evidence hashing]` — invariant 5 is live.
- **Profile snapshots and media rows** with `publishedAt` (platform) and `firstObservedAt` (ours) as distinct facts `[V: dossier output, FOUNDING §15.1]`.
- **Relationship evidence** — story mentions, mentioned-comment probes, follow deltas — with a documented signal-weight ranking (`RELATIONSHIP_SIGNAL_WEIGHTS` 12/10/8), explicitly "a count of stored rows, not an inferred affinity" `[V: packages/database/src/repositories/app-queries.ts:606, getRelationshipsForUser]`.
- **Insight points** (owned only) with ABSENCE rows for documented platform gaps `[V: capabilities ACCOUNT_INSIGHTS]`.
- **Ownership scoping** on every read/write via resolved user `[V: invariant 9; app-queries.ts]`.

### 2.3 The gap

There is **no table, column, or payload shape that can hold "an external source states X about this account."** Every stored claim today originates from a provider call. Consequences:

- The report surface (`opDossier`) can list coverage, but coverage of *what*, for the identity questions, is always `UNAVAILABLE` with the honest note "no provider surface writes this capability" — correct, but a dead end.
- The operator's agent, which *is* allowed to research the open web (the operator's own browsing, outside IGTrack's data-collection line), has nowhere to put what it finds. Its findings live in chat and evaporate.

### 2.4 Latent assets and honesty gaps

- The schema **reserves the values it needs and never writes them**: `ObservationCategory.INFERRED` `[V: packages/core/src/epistemics.ts:4]`, and source kind `USER_PROVIDED` `[V: packages/core/src/capability.ts:77, packages/database/src/schema/enums.ts:115]`. All current write paths default to `OBSERVED` `[V: tables.ts:195,271,385,755]`. A `USER_PROVIDED`-class row is pre-modeled conceptually but has no writer.
- The capability registry's honesty fields (`whyUnavailable`, `unlock`, `persistence`) are exactly the shape a new `ACCOUNT_RESEARCH` entry needs.
- No numeric confidence anywhere: relationship affinity is deliberately a count, not a score `[V: app-queries.ts:606]`. Any claims-confidence design must follow that precedent.

### 2.5 The refusals and where the lawful line is

FOUNDING §14.1 refusals are binding: refused is refused; "the user asked again" is not evidence; a new cross-account route needs a new dated founding entry, not a PR `[V: AGENTS.md §8, FOUNDING §14]`. This plan adds **no platform route** and **no traversal** — the claims layer stores what sources say, including sources about other accounts, but it fetches nothing and derives nothing about persons.

### 2.6 Baseline verification (this environment, 2026-10-16)

| Check | Result |
|---|---|
| `pnpm typecheck` | **clean** across all 5 workspaces `[V]` |
| `pnpm test` (needs Docker Postgres `igtrack-db`) | **green (exclusive re-run): 61/61 files passed; 448 passed, 1 skipped (449); 0 failed; ≈9.4 min** `[V]`. Note for future runs: two earlier attempts failed spuriously because they targeted the same `igtrack_test` database **concurrently** — every database-backed suite rebuilds that schema (`DROP SCHEMA public CASCADE` + migrate, `packages/database/test/helpers.ts createFreshTestDb`), so one run's teardown surfaces as the other's "relation … does not exist". `vitest.config.ts` sets `fileParallelism: false` for one run, not for two. |
| Live Graph credentials | absent — every Graph route stays `NOT_VERIFIED/CREDENTIALS_NOT_CONFIGURED` `[V: research/05 §5 notes + capabilities]` |
| Pre-existing uncommitted WIP | preserved untouched: `apps/cli/src/commands/setup.ts`, `docs/ARCHITECTURE.md`, `docs/FOUNDING.md`, `migrations/meta/_journal.json`, `packages/database/test/schema.test.ts`, `workers/monitoring/src/provider.ts`, `workers/monitoring/test/provider-config.test.ts`, new `apps/cli/test/config-keys.test.ts`, `docs/FEATURES.md`, `docs/verification/`, `migrations/0019_scan_cadence_real.sql` `[V: git status]` |

---

## 3. API / source feasibility matrix

Question-driven. "Today" = what IGTrack answers now; "Plan" = after this proposal. FOUNDING refusals are never reversed by this plan.

| Question | Lawful source | What the route returns | Today | Plan |
|---|---|---|---|---|
| Own-account counts/history | IG User edges (owned) | full history, append-only | ✅ (provider permitting) | unchanged |
| Another public professional account: profile + counts + bounded media preview | Business Discovery (FBL-only; `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement`; opt-in `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1`) | documented fields; consumer/private unreachable; age-gated returns nothing; preview capped (12) and cannot page | ✅ as `DISCOVERY` target, `COMPLETED_PARTIAL`, D48 | unchanged |
| Another account's posts *history*, comments, likers, rosters, reposts, highlights | — | platform-absent | ✅ refused with reasons | **unchanged refusal** |
| Account identity / organisation / industry / location / affiliation / products / related accounts / stated history | **Open public web, read by the operator's own agent** (not by IGTrack) | whatever the source says, quotable | nothing stored | **claims layer** (this plan): operator/agent submits a claim with URL + short excerpt; IGTrack stores and cites it |
| "Is this person employed/ill/religious/political/…" | — | — | refused | **refused predicate list** (hard-coded in `packages/core`) |
| Followers/likes "who" anywhere | — | platform-absent (likers, rosters) | refused | refused |

**Legal frame `[V]`:** Meta Platform Terms (updated 2026-02-03) §3.a prohibits (ii) eligibility determinations (housing, employment, insurance, education opportunities, credit, benefits, immigration), (iii) surveillance, (v) building/augmenting user profiles from Platform Data without valid user consent, (viii) processing beyond documented permitted purposes; the Developer Policy §6.2 bars using the Instagram Platform to "simply display User Content, import or backup content, or manage Instagram relationships" without prior permission. Meta lost its scraping case on logged-off public data (*Meta v. Bright Data*, 2024) but contract claims survive (*hiQ*: public scraping is not a crime; it can still be a contract breach) `[V: research/05 §5]`.

**The design consequence `[I]`, load-bearing for this plan:** profiling a third party *from Platform Data* is outside permitted purposes. So (a) IGTrack must not merge claims into any platform-derived profile narrative as if the platform supplied them, and (b) the claims feature is scoped to what the operator's own agent found on the open web and chose to record — the same act as keeping a research notebook, performed by the operator, not by IGTrack against the Platform. The report renders platform facts and external claims in **separate, labelled sections**, with platform facts taking the discovery route's D48 caveats verbatim.

**Export route:** `import:v1` remains the lawful automation path for owned-account data users already export manually `[V: docs, fixtures/import-sample]`. Nothing in this plan changes it.

**NOT_VERIFIED:** no live Business Discovery call was made this pass (no credentials); the field-coverage audit `scripts/verify-graph-provider.ts` remains the gate before any graph claim is upgraded.

---

## 4. Proposed architecture

### 4.1 The one principle

**IGTrack stores claims; it never generates them.** No LLM inside IGTrack, no fetching inside IGTrack, no inference engine. The operator's agent (Claude, Codex, whatever the operator runs) does web research under the operator's own authority and *submits* findings; IGTrack validates, stores, cites, and renders. This keeps the honesty boundary exactly where it already is: everything stored has a source; everything rendered says which source; anything else is `UNAVAILABLE` with a reason.

### 4.2 The claims model (new table, migration 0020)

Sketch (final column set to be locked in the PR; names align with repo conventions):

```
claims
  id            serial pk
  user_id       → users.id        -- ownership scoping, invariant 9
  target_id     → targets.id      -- cascade delete with the target (deleteOwnedTarget)
  predicate     text not null     -- validated against CLAIM_PREDICATES (core registry)
  value         text not null
  source_kind   text not null     -- OPERATOR | WEB (never PLATFORM — platform facts live in the observation tables, not here)
  source_url    text null         -- required when source_kind = WEB
  source_title  text null
  excerpt       text null         -- short quoted excerpt, length-capped
  excerpt_hash  text null         -- sha256; same evidence-hashing discipline as the ledger
  stated_at     timestamp null    -- when the source said it (source's own date)
  retrieved_at  timestamp null    -- when the operator's agent fetched it
  recorded_at   timestamp not null default now()
  status        text not null default 'ACTIVE'   -- ACTIVE | RETRACTED
  retracted_at  timestamp null
  retraction_reason text null
```

Design rules, each test-pinned:

- **Follows are leads, never claims.** Nothing auto-converts a follow edge, mention, or tag into a claim. A claim exists only because a source *states* it and a human/agent submitted it.
- **Append-only in spirit:** retraction sets `status=RETRACTED` + reason and the row stays visible (rendered as retracted) — the product's own history of what it used to assert. No hard delete except cascade with the target.
- **Corroboration/contradiction are derived, never stored:** same `(target, predicate)` with differing values → `CONFLICTED` (both shown, no winner, no ordering); equivalent values from ≥2 distinct source domains → `CORROBORATED`; one source → `SINGLE_SOURCE`; operator-asserted without URL → labelled as such. No numeric confidence — the repo's "count of stored rows, not an inferred affinity" precedent is followed exactly.
- **Dedup:** unique index on `(target_id, predicate, value, source_url)`; a re-run of the operator's research is idempotent. Different URLs for the same value are distinct claims (that is corroboration evidence).
- **Expiry is display, not deletion:** the report computes claim age and flags a claim whose `retrieved_at` is older than a documented horizon (proposed: 180 days) as `DUE_FOR_REVIEW`. Stale claims stay visible; hiding or deleting them would be the dishonest move.

**Predicate registry** (small, closed, in `packages/core`, dependency-free):

`ORGANIZATION_NAME, ORGANIZATION_KIND, LOCATION_STATED, INDUSTRY_OR_FIELD, CONTACT_CHANNEL, INSTITUTIONAL_AFFILIATION_STATED, PRODUCT_OR_SERVICE, RELATED_ACCOUNT_ASSERTED, HISTORICAL_CHANGE_STATED`

**Refused predicates** (rejected at `claim add` with the FOUNDING pointer): employment status, health, religion, political affiliation, sexuality, ethnicity, criminal/legal history about a person, home address, immigration status, education status (inferred), personal relationships. Institution-level facts are allowed (a company's stated industry is not sensitive personal data); person-level sensitive attributes are not, even if a source claims them — IGTrack declines to be the database for that. This is a founding decision and gets a dated entry (§18, next free decision number; D67 as of this writing `[V: max D66 in FOUNDING]`).

### 4.3 The `research` report (new op, deterministic read)

`opResearch(ctx, { target }) -> ResearchResult`, synchronous, **zero provider calls, zero network calls** — therefore no queue, no job kind, no rate limits, no timeouts, no long-running state in v1. Sections, each with a state + reason where empty:

1. **Identity and route** — reuses `resolveTarget` + the dossier's route block (OWNED vs DISCOVERY, observing sources, D48 bounded-preview caveat verbatim).
2. **Platform observations summary** — latest profile snapshot fields with `observedAt`, media preview with the bounded statement, counts. All per existing dossier semantics; `null` never zero-filled.
3. **Claims ledger** — active claims grouped by predicate, each with source, `stated_at`/`retrieved_at` age, corroboration label, and retracted claims listed separately as retracted.
4. **Contradictions** — derived view: predicates with active claims of differing values; both sides shown with their sources; no winner, no ordering by "trust".
5. **Leads (not claims)** — cited as such: follow/delta signals the operator may want to research next, rendered from stored rows only; explicitly labelled "leads, not claims".
6. **Closest connections** — the existing evidence-ranked relationship table for OWNED targets (weights 12/10/8). For DISCOVERY targets: an explicit `UNAVAILABLE` with reason ("connection evidence (mentions, comments, deltas) is only recordable for the account this deployment owns") **plus** any `RELATED_ACCOUNT_ASSERTED` claims separately, never merged into the evidence-ranked list.
7. **Coverage** — the dossier coverage projection + the new `ACCOUNT_RESEARCH` capability state.

### 4.4 Identity resolution

Reuse `resolveTarget` exactly: username or local name among **stored** targets, ownership-scoped. The platform id stays an output (D44) — never an input to `claim add` or `research`. Unrecorded account → refuse with the exact next command (`igtrack targets add <username> --observed`), preserving D53's two-intent split. Ambiguous input → existing resolve error semantics, unchanged.

### 4.5 Connected-account prioritization

Ranked strictly by stored evidence, per existing weights; the report never adds a "relevance" score. Claims about relations (`RELATED_ACCOUNT_ASSERTED`) appear as claims with sources, in the claims section — the ranking and the claims are never blended, because that blend is precisely how a tool starts laundering claims into observations.

### 4.6 Workflow comparison: deterministic vs LLM vs hybrid

| | Deterministic (IGTrack core) | LLM (inside IGTrack) | Hybrid (chosen) |
|---|---|---|---|
| Produces claims | no | yes, unverifiable | operator's agent, outside IGTrack |
| Storable evidence | platform rows | prompt text | URL + excerpt + hash per claim |
| Determinism | byte-identical reruns | drift | core is deterministic; inputs are explicit rows |
| Failure mode | UNAVAILABLE+reason | confident fabrication | empty claims → honest "none recorded" |
| Fits invariants | yes | violates 1/2/5 | yes |

Chosen: hybrid with the boundary at the repo wall. IGTrack's side is fully deterministic; the agent's side is budget-bounded by documentation (below) and evidenced by what it submits.

### 4.7 Bounds (documented protocol for the operator's agent; enforced where possible)

- **Depth:** 1 — the source page itself; no link-following cascades. No traversal of Instagram at all (that stays refused).
- **Budget:** ≤ 10 sources per research run per target; ≤ 1 claim per source per predicate (dedup index enforces).
- **Stopping condition:** the operator's agent stops when every registry predicate has either a claim or an explicit "not found in N sources checked" note in its own working record. The `research` report itself states "no claims recorded" plainly when the ledger is empty; effort spent is the operator's workflow, not stored product state.
- **Dedup:** the unique index above; re-runs are idempotent by construction.
- **Timeouts:** none needed in v1 — nothing in `research` calls out. If a future phase adds fetch-on-demand it must add timeouts, retries, and a job kind first; that is a new phase and a new founding entry, not a slipped-in feature.

### 4.8 CLI / MCP surface

| Surface | Shape | Notes |
|---|---|---|
| CLI `igtrack claims add <target> --predicate P --value V --source-url U [--excerpt E] [--stated-at T]` | write | additive; explicit flags only, no interactive prompts in agent context |
| CLI `igtrack claims list <target> [--predicate P] [--include-retracted]` | read | human table with `unavailable` for nulls (display rule) |
| CLI `igtrack claims retract <claimId> --reason R` | write | confirmation parameter required (AGENTS.md §4 rule for destructive ops) |
| CLI `igtrack research <target>` | read | renders the report |
| MCP `igtrack_claim_add` / `igtrack_claims_list` / `igtrack_claim_retract` / `igtrack_research` | same ops | `readOnlyHint` on list/research; typed `isError` + `error.code` on failures; `withMeta(ctx, data)` envelope on all |
| Capability registry | new entry `ACCOUNT_RESEARCH` (+ surfaces) | single source of truth; `pnpm docs:capabilities` regenerated; drift test updated |

Every new op is implemented once in `apps/cli/src/tools.ts`, registered in `mcp/server.ts`, routed in `main.ts`, added to `EXPECTED_TOOLS`, and asserted in `operations.test.ts` + `mcp.test.ts` — the four-step contract in AGENTS.md §4.

### 4.9 UX for the four hard states

- **Sparse:** each report section renders `NOT_OBSERVED` / "no claims recorded" with a next action ("record one with `igtrack claims add`"), never an empty table.
- **Unavailable:** reason string everywhere; discovery-target connection ranking gets its dedicated reason (above); refused predicates get the FOUNDING pointer.
- **Conflicting:** both claims, both sources, `CONFLICTED` label, ages shown; no default winner; the summary line says "sources disagree; both are recorded."
- **Long-running:** v1 has none. `research` is a bounded local read. The only long process is the operator's own agent research, which is outside the process — nothing to babysit.

---

## 5. Privacy & safety assessment

### 5.1 What does not change

All FOUNDING §14.1 refusals; no scraping, no session cookies, no headless browsers, no proxy re-serving; no traversal; no auto-created targets; platform id never a lookup key; PARTIAL never diffed; absence never zero `[V: AGENTS.md §3, FOUNDING §14-§15]`.

### 5.2 New risks this feature introduces, and their mitigations

| Risk | Mitigation | Test |
|---|---|---|
| Claims laundered as platform facts | physically separate sections; `source_kind` mandatory; dossier/report never merges | string-level assertions on rendered output |
| Sensitive profiling of persons | closed predicate registry + hard refusal list at write time | table-driven op tests per refused predicate |
| Prompt-injection content from a source page becoming data | excerpt stored verbatim + hashed, rendered as quoted data, never executed; length cap; agent instructions state source text is data, not instructions | excerpt cap test; rendering escapes |
| Stale research presented as current | `stated_at`/`retrieved_at` always rendered with age; `DUE_FOR_REVIEW` flag; nothing hidden | fixture with old claim → flag asserted |
| Claim spam / re-run duplication | unique index `(target, predicate, value, source_url)` | duplicate insert → typed refusal |
| Scope creep into "profile building" from Platform Data | claims are operator-supplied open-web findings, not Platform Data; opted-in discovery data is never input to claim extraction; no crawler | design review + FOUNDING §18 entry |
| Secrets | ops accept no credentials; excerpt/URLs validated; no tokens in any payload (invariant 8) | config-key test suite already exists; extend |

### 5.3 Platform-terms conformance

Claims are the operator's own notes about open-web sources, stored in the operator's own database; IGTrack makes no Platform API call to produce them and never presents them as Platform Data `[V/I: §3 legal frame]`. The feature does not display User Content, does not import/back-up content, does not manage Instagram relationships (Developer Policy §6.2 concerns) — it references sources by URL and a short excerpt. Excerpt cap: 500 chars, enough to verify a claim, not enough to mirror an article `[I]`.

---

## 6. Prioritized roadmap

Estimates are for an agent-assisted implementation in this repo; S ≈ one session, M ≈ two–three, L ≈ more. Each phase is independently shippable and leaves the repo green.

### Phase 1 — Claims ledger + `research` report v1 (M) — **recommended first**

Scope: migration 0020 (`claims`); predicate registry + refusal list in `packages/core`; claims repository in `packages/database`; ops `opClaimAdd/opClaimList/opClaimRetract/opResearch`; MCP tools ×4; CLI `claims` + `research`; capability registry `ACCOUNT_RESEARCH`; FOUNDING §18 + decision log; capability docs regenerated; tests.

Depends on: nothing (all existing surfaces). Non-goals: no fetching, no LLM, no themes analysis, no export.

Acceptance criteria:
- `igtrack research aurora.wilde` on the synthetic seed renders all 7 sections; every null carries a reason.
- Refused predicates (table) fail with typed errors citing FOUNDING.
- Duplicate claim → refused; retract → visible as retracted; contradiction fixture → `CONFLICTED` with both sources.
- `pnpm typecheck` clean; full suite green; `EXPECTED_TOOLS` updated; capability drift test updated.

### Phase 2 — Observation-derived depth (S–M)

Themes from stored captions (top hashtags/tokens, with corpus size stated; discovery preview caveat when applicable), posting-cadence summary from stored timestamps, owned-account audience summary from insight points (ABSENCE rows surfaced). All read-only over existing rows.

Acceptance: every derived figure states its corpus (`across N stored rows`) and is absent-with-reason when the corpus is empty.

### Phase 3 — Review workflow + human export (S)

`DUE_FOR_REVIEW` surfacing in `claims list`; `research --format md` for a hand-off document; optional `--since` filter. No new storage.

Non-goals for all phases: anything on the refusal list; anything requiring a new platform route; numeric confidence scores; background jobs; UI.

---

## 7. Evaluation plan

### 7.1 Fixtures

Extend the synthetic seed (`pnpm igtrack setup`) with a scripted claim set for `aurora.wilde` (2 corroborating OPERATOR/WEB claims, 1 contradiction pair, 1 refusable-predicate attempt, 1 retracted claim) and use `dune.harbor` (discovery.json) for the discovery-target states. No fixture may contain sensitive personal data, real URLs to private individuals, or credentials.

### 7.2 Benchmark questions (fixed set; run against the seeded DB)

| # | Question | Expected answer class |
|---|---|---|
| Q1 | follower count now | platform observation + timestamp, or UNAVAILABLE reason |
| Q2 | who runs the account | claims or "no claims recorded" |
| Q3 | where based | LOCATION_STATED claim or refuse with reason |
| Q4 | what it posts about | Phase 2 themes w/ corpus size, or reason |
| Q5 | closest contacts | evidence-ranked (OWNED) / dedicated reason (DISCOVERY) |
| Q6 | who liked the last post | REFUSED, FOUNDING pointer |
| Q7 | other accounts | RELATED_ACCOUNT_ASSERTED claims only; no inference |
| Q8 | is the person employed at X | REFUSED predicate |
| Q9 | follower count 30 days ago | stored history or "not enough history" reason |
| Q10 | join date | UNAVAILABLE unless HISTORICAL_CHANGE_STATED claim |
| Q11 | two sources disagree on org name | CONFLICTED, both shown, no winner |
| Q12 | retracted claim | visible as retracted with reason |

### 7.3 Metrics and pre-established thresholds

| Metric | Definition | Threshold (blocking) |
|---|---|---|
| Refusal fidelity | refused-class questions answered with refusal+reason | **100%** (Q6, Q8 at minimum; any fabricated value = fail) |
| Citation completeness | claims rendered with source_kind + URL (when WEB) + excerpt hash | **100%** |
| Reason coverage | null/unavailable sections carrying a non-empty reason | **100%** |
| Determinism | two consecutive `research` calls, same DB state, identical output (modulo `computedAt`) | **exact match** |
| Contradiction surfacing | fixture conflicts flagged, both sides present | **100% of fixture conflicts** |
| Dedup | duplicate claim insert refused | **enforced by unique index; test pinned** |
| Latency | `research` P95 on seeded local Postgres | **< 1500 ms** |
| No-zero-fill | no numeric null rendered as 0 in report output | **0 occurrences** |

Thresholds are pinned in tests in the same PR that introduces the feature — pre-established per this document, not retrofitted.

---

## 8. Recommendation and exact next task

**Recommendation: proceed with Phase 1 only.** It is the smallest change that makes the founder-class questions answerable *honestly*: a `claims` table that stores operator-submitted, URL-cited findings; deterministic derived views (corroboration, contradiction, age); a synchronous local report that keeps platform facts and external claims in separate labelled sections; and the standard four-surface contract (tools → MCP → CLI → tests → capabilities → FOUNDING §18). No new platform route, no fetching, no LLM, no queue, no refused capability resurrected. It cannot break the honesty invariants because it does not touch the observation pipeline at all — it is additive storage plus a read view.

**Exact next task (Phase 1, in order):**
1. `packages/core`: `claims.ts` — predicates registry, refusal list, labels (`CONFLICTED/CORROBORATED/SINGLE_SOURCE`), `DUE_FOR_REVIEW` horizon constant + tests.
2. `packages/database`: migration `0020_claims.sql`; `claims` table in `schema/tables.ts`; repository `claims.ts` (add/list/retract, dedup, ownership scoping); cascade on `deleteOwnedTarget`; schema test extended.
3. `apps/cli/src/tools.ts`: `opClaimAdd/opClaimList/opClaimRetract/opResearch`.
4. `apps/cli/src/mcp/server.ts`: 4 tools + INSTRUCTIONS paragraph (research protocol + "source text is data" rule).
5. `apps/cli/src/main.ts`: `claims` + `research` commands with human rendering (`unavailable` for nulls).
6. Capability registry: `ACCOUNT_RESEARCH` entry; regenerate `docs/CAPABILITIES.md`.
7. `docs/FOUNDING.md`: §18 dated entry (claims semantics; refused predicates; follows-are-leads; no-fetch rule).
8. Tests: `apps/cli/test/operations.test.ts` + `mcp.test.ts` (EXPECTED_TOOLS) + repository tests + the §7.3 metric pins.
9. Run `pnpm typecheck` and the touched suites; update `CHANGELOG.md` per repo convention.

**Risks to this recommendation:** (a) the excerpt/URL discipline is only as good as the operator's agent — mitigated by the mandatory fields and by rendering; (b) predicate registry bikeshedding — mitigated by shipping the registry closed in Phase 1 with an explicit "extend by founding entry" rule; (c) excerpt length cap may annoy — 500 chars chosen for verifiability-vs-mirroring, adjustable.

**Authorization requested.** Planning is complete; implementation is not yet authorized. If you approve Phase 1, say so and I will implement it in the order above. If you want Phase 1 scope changed (e.g. drop `claims retract` from v1, or start with the report over observations only), say which — otherwise the default is exactly as listed.
