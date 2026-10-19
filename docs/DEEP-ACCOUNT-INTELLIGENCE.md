# Deep Account Intelligence — opportunity, audit, design, and implementation plan

**Date:** 2026-10-16 · **Status:** Phase 1 implemented, committed as `323a254`; the read-only Phase-2/3 items (themes, cadence, audience summary, `--since`, `--format md`) shipped with it, and the mission added the investigation planner (`opPlan`) this document did not cover. See the status block at the end for the exact deltas.
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

Extend the synthetic seed (`pnpm igtrack setup`) with a scripted claim set for the seeded owned target `target_a` (2 corroborating WEB claims, 1 contradiction pair, 1 operator-asserted claim, 1 retracted claim, 1 stale claim past the review horizon; the refusable-predicate attempt is test-pinned rather than seeded) and use `dune.harbor` (discovery.json) for the discovery-target states. No fixture may contain sensitive personal data, real URLs to private individuals, or credentials.

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

---

## 9. Status update — implemented (2026-10-16, commit `323a254`)

Authorization was granted and Phase 1 shipped in the order listed, together
with the items below. This block is the honest delta between the plan above
and the code.

**Implemented as specified:** migration `0020_claims.sql` with the `claims`
table and its partial unique index (dedup via `coalesce(source_url,'')`);
the closed predicate registry and refusal list in `packages/core/src/claims.ts`
(plus `references.ts` for `@handle`/profile-URL parsing); the claims
repository (add/list/get/retract, ownership-scoped, `hashClaimExcerpt` for
excerpt hashing); ops `opClaimAdd`/`opClaimList`/`opClaimRetract`/`opResearch`;
MCP tools ×4 (+1, below); CLI `claims add|list|retract` + `research`;
capability registry `ACCOUNT_RESEARCH` (`operatorSupplied: true`,
`providerMethods: []`) with `docs/CAPABILITIES.md` regenerated (19 of 24
obtainable); FOUNDING §18 (D67/D68); the seed's scripted claim set; and the
§7.3 metric pins in `apps/cli/test/research-benchmark.test.ts`.

**Shipped early (this document's Phase 2/3, read-only over stored rows):**
themes and cadence (`packages/core/src/synthesis.ts`, pure and totally
ordered; every figure states its corpus), the owned-account audience summary
from insight rows, the change window, `claims list` `dueForReview` surfacing,
`research --since` (claims section only, with the omitted-row count) and
`research --format md`.

**Beyond this document (mission scope):** the investigation planner —
`igtrack plan <target> [--goal]` / `igtrack_plan`, statelessly recomputed from
jobs, targets and claims on every call, with one named next action, D47
refusals as `NOT_APPLICABLE`, unusable providers as `BLOCKED`, and unknown
goals as `USAGE` errors. Recorded as part of D68.

**Not shipped, by design:** anything on the refusal list; any fetch inside
IGTrack; any LLM inside IGTrack; numeric confidence; background jobs; a UI.
The §4.7 agent-workflow bounds (≤10 sources, depth 1) remain a documented
protocol for the operator's agent, not machine-enforced state — the claims
layer cannot verify how many pages the agent read, and pretending otherwise
would be the fabrication this design exists to avoid.

**Verification:** FOUNDING §18.3 carries the full table (typecheck; the
suite's file/pass counts; the acceptance scenarios A01–A26; the §7.2
twelve-question benchmark; determinism pins; the latency numbers from
`scripts/bench-research.ts`). No live account was observed: every row in
evidence comes from the synthetic fixture provider or operator-submitted
claims.

---

## 10. Completion mission — audit and end-to-end verification (2026-10-17)

A completion mission re-audited this document against the working tree and
verified the whole feature end to end. The audit found **no missing
component**: the predicate registry, migration 0020 and its dedup index, the
claims repository, all five ops, all five MCP tools, the CLI commands, the
`ACCOUNT_RESEARCH` capability entry, the seeded claim set, and the §7.2/§7.3
benchmark pins are all present and test-pinned `[V]`. What the mission added
was verification depth and honesty fixes, not new surface:

- **Fixture-name drift fixed (§7.1):** the plan named the seed account
  `aurora.wilde`; the actual seeded owned target is `target_a` (its claims
  concern the fictional "Aurora Print Studio"), with `dune.harbor`
  (discovery.json) for discovery-target states — `dune.harbor` was correct and
  unchanged `[V: seed, fixtures/v1/discovery.json]`.
- **README:** now documents the claims ledger, `research`, and `plan` (it had
  no mention); the tool count (24) and capability count (19 of 24) were
  already reconciled `[V]`.
- **End-to-end CLI walkthrough on a scratch database** (`igtrack_smoke`,
  synthetic only): `setup` → `research target_a` (all sections render; empty
  themes/cadence/audience carry reasons; the 257-day-old claim flags
  `due for review`; the retracted claim renders as retracted) → `claims add`
  (excerpt hash stored) → duplicate add refused naming the existing claim
  (exit 2) → refused predicate (`EMPLOYMENT_STATUS`) refused with the FOUNDING
  pointer (exit 2) → `claims retract --reason --yes` → `claims list` →
  `plan target_a` (D47 kind renders `NOT_APPLICABLE`) → `research --format
  md` → the documented Node launcher (`node apps/cli/bin/igtrack.mjs research
  --json`) `[V]`.
- **Benchmarks (uncontended, 64-claim synthetic workload, local Postgres):**
  `research` p50 198.73 ms / **p95 411.23 ms** against the pre-established
  < 1500 ms pin; `claims list` p95 41.10 ms; `plan` p95 60.01 ms
  (`pnpm bench:research`, exit 0) `[V]`.
- **`pnpm docs:capabilities`:** regenerated — zero drift `[V]`.
- **Suite evidence:** `pnpm typecheck` clean (5/5 workspaces); the
  claims-focused suites 48/48; operations + research-benchmark + acceptance
  **83/83** on an isolated test database; the hardening suites
  (migration-safety, retention, queue-hardening, privacy, concurrency, both
  claims suites) green in every run. Full-suite runs this evening were
  repeatedly contaminated by a second, concurrent workstream in the same
  working tree running its own suites against the shared `igtrack_test`
  database (the §2.6 hazard, now with an external cause); pointing this
  mission's runs at a separate database via `IGTRACK_TEST_DATABASE_URL`
  removed the data races, and the residual load-induced hook timeouts
  re-passed in isolation (4 files, 27/27) `[V]`. The exact final full-suite
  count for the combined tree is recorded in
  [verification/VERIFICATION.md](verification/VERIFICATION.md) §11.
- **Concurrent-workstream note:** during this mission a separate session was
  editing config-readiness files (`packages/ingestion/src/config/`,
  `graph-provider.ts`, CLI doctor). Their work is uncommitted, was not touched
  by this mission, and one of their transient test failures (a
  `graphConfigFromEnv` crash on a fully-empty environment) was fixed on their
  side mid-mission `[V]`.

**Still `NOT_VERIFIED`, unchanged:** every live-Graph row (no credential
exists in this environment), and the §4.7 agent-workflow bounds — which remain
a documented protocol for the operator's agent, by design, as stated in §9.

## 11. Research acquisition layer — the engine fetches (2026-10-18, D69)

Phase 4 of the founder requirement: the product itself plans, fetches,
extracts, validates and stores source-backed evidence. This supersedes one
sentence of §10: the §4.7 bounds are no longer merely a documented protocol —
they are compile-time constants enforced in code and pinned by tests.

### 11.1 What was built

- **Engine:** `opResearchRun` (`apps/cli/src/tools.ts`) behind
  `igtrack research <target> --run --question "..."` and the
  `igtrack_research_run` MCP tool (`readOnlyHint: false`; destructive-free but
  DB-mutating). Question → `ResearchFocus` mapping, plan → fetch → extract →
  validate → store → run record.
- **Bounds in core** (`packages/core/src/research.ts`): 10 sources, depth 1,
  10s/document, 512KB, 3 redirects, 24h freshness — constants, not env vars,
  pinned by `packages/core/test/research.test.ts`.
- **Network layer** (`packages/ingestion/src/research/`): SSRF-gated fetcher
  (static gate + DNS check + robots + content-type allowlist + streamed byte
  cap + per-hop re-validation), four-family extractor (JSON-LD, meta, mailto,
  profile links — never prose), search providers (`none` | `fixture` for tests
  | `brave` behind env key).
- **Storage:** migration 0021 (`research_runs`, `research_documents`,
  `claims.research_run_id`); per-document outcomes with reasons; owner scoping;
  uniqueness `(run_id, url)`; freshness window per user.
- **Registry:** `WEB_RESEARCH` capability with a new `engineSupplied` supply
  mode (third honest answer to "who supplies this row": platform, operator, or
  bounded engine); dossier coverage reports it `UNAVAILABLE` with the D47
  reason on DISCOVERY targets, `OBSERVED` from stored run rows on OWNED ones.

### 11.2 Verification

- **Test matrix, 93 checks across 7 files**, all green on an isolated test
  database: core bounds (12), extraction + injection inertness (14), fetcher
  gate/robots/redirect/caps/timeout (19), search selection (12), migration +
  lifecycle + scoping + freshness + concurrency (10), ~19 engine scenarios
  (multi-source, sparse, injection, refusal silence, failures, dedup,
  determinism, CLI/MCP contracts, cross-user denial last), MCP schema bounds.
- **Typecheck:** 5/5 workspaces clean.
- **`pnpm docs:capabilities`:** regenerated — 20 of 25 obtainable.
- **What the tests prove about the boundary:** an Instagram-family URL and a
  credential-embedded URL are refused by the real fetcher's static gate; a
  private/loopback/metadata address is refused after DNS resolution; a
  robots-disallowed path is skipped; a redirect to an unsafe host is refused
  mid-flight; an over-budget `--url` list is capped; a prompt-injection
  payload in a page body produces zero candidates; a sensitive predicate
  extracted from a real-looking page is refused by the shared registry; a
  second user's run is invisible to the first.

### 11.3 Still `NOT_VERIFIED`, with the exact prerequisite

- **Live search:** the keyless leg is **VERIFIED 2026-10-19** (`igtrack audit
  sel_win_` with `IGTRACK_RESEARCH_SEARCH_PROVIDER=auto`, no key:
  `SEARCH_SUCCEEDED` via the FreeSerp index). **Live Brave search:** set
  `IGTRACK_RESEARCH_SEARCH_PROVIDER=brave` and
  `IGTRACK_RESEARCH_SEARCH_API_KEY` (any Brave-compatible key), then run a
  live `--run` against a real public page. Without a key, `auto` falls through
  to the keyless index; `=brave` without a key answers `UNAVAILABLE` with the
  reason — never invented sources.
- **Live public-web fetch end-to-end:** the fetcher's transport behaviour is
  pinned against injected doubles and one real-DNS loopback refusal; a live
  fetch against arbitrary third-party pages is a deployment act, not a test
  fixture, by decision.
- **Live Graph:** unchanged (`pnpm verify:graph`, needs a real token).

## 12. The arbitrary-username investigation workflow (2026-10-18, D70–D71)

The founder restated the CENTRAL use case: an operator supplies an unknown
username and wants the most comprehensive lawful, evidence-backed report the
product can produce — without the target's credentials or cooperation. The
audit of that requirement against the tree found **one structural gap**, and
it was not a missing provider:

> The engine could only research a target it already held. A stranger's handle
> — the very thing the product is for — could be probed through Business
> Discovery and read back if stored, but could not be researched at all until
> the operator first registered it as a target. The workflow began in the
> wrong place.

### 12.1 What shipped

- **`opAuditWebProbe`** (`apps/cli/src/tools.ts`): a read-only, bounded,
  target-free public-web phase inside `igtrack audit <username>`. Operator
  `--url` pages first, then search-provider candidates; ≤5 documents (ceiling
  10), depth 1, the same SSRF/DNS/robots/content-type/byte/timeout gate as a
  run, Instagram-family hosts refused by policy, the same four field-family
  extractor, the same closed predicate registry. It takes **no database
  handle**, so it cannot store, register or queue — the audit's "wrote no row"
  promise is structural.
- **Evidence separation in the report:** every fact is
  `PUBLIC_WEB_DOCUMENTED` with source URL, page title, field, method,
  retrieval time and the document's SHA-256; corroboration/contradiction are
  derived with the ledger's own `deriveClaimRelation` (conflicts show both
  values, pick no winner, carry no score); `summary` names the six evidence
  classes — platform observation, stored record, public-web statement, stored
  third-party claim, operator evidence, inference (`NONE`, always).
- **Honesty fixes to the audit itself:** a synthetic `ACCOUNT_NOT_FOUND` is
  now stated as a property of the fixture set rather than of Instagram; a
  broken `IGTRACK_RESEARCH_SEARCH_PROVIDER` is a `CONFIGURATION_ERROR`
  (exit 3), never an empty section; a failed document reads `FAILED`, never
  "nothing found"; and `NOT_ATTEMPTED` carries the exact env-var remedy.
- **Surface:** CLI `--url URL[,URL…]` / `--max-sources N`; MCP `igtrack_audit`
  gains optional `urls` (≤10) and `maxSources` (1–10), `readOnlyHint` kept.
  `EXPECTED_TOOLS` unchanged at 24.
- **Source audit:** [verification/SOURCE-AUDIT.md](verification/SOURCE-AUDIT.md)
  (dated, URL-cited) — what each lawful source can and cannot do, why oEmbed
  is refused on contract rather than capability, why the OSINT libraries are
  reference-only, and which search API is actually alive.

Decisions D70 (the phase) and D71 (the source audit) are recorded, with the
deliberate non-additions, in [FOUNDING.md](FOUNDING.md) §19.

### 12.2 Verification

`pnpm typecheck` clean; `apps/cli/test/audit.test.ts` grew a 9-scenario
public-web matrix (21 tests in the file, all green on 2026-10-18 against the
test database) covering: fact labelling + byte-identical ledger, cross-domain
corroboration and contradiction, a real-gate Instagram URL refusal, failed
document reporting, `NOT_ATTEMPTED` with the remedy, the enforced and reported
source cap, sensitive-predicate silence, the search-provider configuration
error, and human/JSON agreement.

**Live verification (2026-10-18, real internet, real fetcher).** The phase was
then exercised for real, and that probe is on record because it found three
defects no fixture reproduced (FOUNDING §19, D72):

- `--url "https://example.org,https://www.wikipedia.org"` → both `FETCHED`
  (HTTP 200, 577 B / 122197 B, real SHA-256 digests and retrieval times),
  **383 links counted and not followed** at depth 1, and an absent search
  provider reported as `UNAVAILABLE` with its exact remedy.
- `--url https://www.anthropic.com` → 201400 B fetched, **4 cited facts** with
  field, method, source URL, retrieval time and per-fact uncertainty.
- That run exposed: a `meta description` phrase-miner emitting the value
  `that&` (deleted — prose mining is prose interpretation), undecoded HTML
  entities inside values and quoted excerpts (`Smith &amp; Wesson` — now
  decoded at both extraction gates), and one page's three social links
  labelled `CONFLICTED` (a contradiction now requires two independent
  sources; same-domain disagreement reads `SINGLE_SOURCE` with its values
  still shown). All three are pinned by `research-extract.test.ts` (16/16)
  and the audit matrix.

### 12.3 Still `NOT_VERIFIED`, with the exact prerequisite

- ~~Live search~~ — **VERIFIED 2026-10-19** on the default path: with
  `IGTRACK_RESEARCH_SEARCH_PROVIDER=auto` and no key, `igtrack audit sel_win_`
  ran a real keyless search (FreeSerp: `SEARCH_SUCCEEDED`) and the web phase
  planned, fetched and relevance-gated real pages (0 facts — every retrieved
  page that never named the handle had its structured values discarded with the
  reason). The Phase-2 re-run (D74, same date) asked the fixed budget of **4
  distinct query forms** — 20 results → 15 canonical candidates (25% tracking
  duplicates removed), 4 fetched / 1 `TIMEOUT`, `outcomeClass
  PAGES_IRRELEVANT` with the weak-coverage next step — and the identical
  pipeline on a control handle (`nasa`) produced 4/4 pages naming the handle
  and **41 facts** (`EVIDENCE_EXTRACTED`), proving the extractor yields
  evidence when a page states it. Benchmark table: `docs/verification/SOURCE-AUDIT.md`
  §10. The keyed Brave leg still needs `IGTRACK_RESEARCH_SEARCH_PROVIDER=brave`
  + `IGTRACK_RESEARCH_SEARCH_API_KEY` and remains the one search item never
  observed live.
- ~~Live public-page fetch~~ — **VERIFIED 2026-10-18** (three named public pages
  fetched with the real fetcher; digests, byte counts, retrieval times and the
  383-links-not-followed bound on record in §12.2 and FOUNDING §19).
- **Live Graph / Business Discovery:** unchanged (`pnpm verify:graph`, needs a
  real long-lived token + `IGTRACK_GRAPH_BUSINESS_DISCOVERY=1`).
- **What a real investigation of an arbitrary username looks like today:**
  `igtrack audit <handle> --url "https://official-site/about"` → read the
  `summary`, `probe`, `web` and `Coverage` sections → if the platform route
  can see it, `igtrack targets add <handle> --observed` → `igtrack claims add`
  to file the citations worth keeping → `igtrack research <handle>` for the
  stored read-back. Every step that needs a credential says which one.

## 13. Requirement mapping and staleness honesty (2026-10-19)

The part-1 deliverable of this requirement — *audit the product against the
central use case, mapping every clause to implementation, source, auth,
ownership, legal constraint and verification* — is written as
[verification/REQUIREMENT-AUDIT.md](verification/REQUIREMENT-AUDIT.md). It
maps FOUNDING §14.1 A1–A10, §15, §18 and §19 to code paths, names the 25
registry entries by `liveState` (0 `LIVE_VERIFIED`, 17 `NOT_VERIFIED`,
8 `DOCUMENTED_ABSENT`), and lists the refusals as refusals rather than as
backlog.

Two honesty gaps the audit itself closed in the reporting surface:

- **Stale evidence is now named.** A stored claim past the 180-day review
  horizon is counted (`record.claims.dueForReview`), travels as a
  `Stale evidence:` limitation, marks the summary's third-party-claim row
  `DUE_FOR_REVIEW`, and prints a `STALE —` human line. A plan step whose
  stored observation is older than its cadence is prefixed `STALE —`. Nothing
  is expired, retracted, downgraded or dropped — staleness is a flag, never a
  verdict (§18).
- **The human screen shows each web fact's uncertainty**, so a per-fact
  caveat is no longer visible only in `--json`.

Verification is recorded in
[verification/VERIFICATION.md](verification/VERIFICATION.md) §14. The external
blockers are unchanged: a live Graph/Business Discovery credential and a
search-provider key.
