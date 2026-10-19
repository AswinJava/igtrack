# Competitive research — reverse-engineered verdicts and adopted techniques

**Date:** 2026-10-16 · **Mission:** reverse-engineer the relevant open-source
projects from their actual code and commits (never their READMEs), build a
feature matrix, adopt only what is justified and licensed, and record what was
refused and why. Every claim below cites a pinned revision; nothing was adopted
on documentation alone.

**Method limits, stated first.** All three targets were read statically. Laya
was a depth-1 shallow clone (no history); Agent Reach was read AND its
`doctor` run (read-only, no repo modification); the phone-photo class was
verified against live web sources. No competitor test-suite was executed, so
"the code says so" is the strongest claim made here. **No comparative
performance claim is made anywhere in this document**: the three systems do
different jobs, and no shared benchmark exists.

---

## 1. Verdicts

### 1.1 Laya — `github.com/NandhaKishorM/laya` @ `a4a8921` (0.3.28), Apache-2.0

A fixed-option decision engine (fine-tuned checkpoints, one forward pass,
choice/score/noul) with a Python package, a full TypeScript port, and 8
read-only MCP tools. Not a generative LLM, and its own tool copy says so.

**Verdict: ideas only; adopt no code.** The transferable honesty patterns are
recorded in §3; the engine (checkpoints, torch/ONNX runtime, GPU kernels,
1.3 GB browser weights, language detection, tokenizer, shortlist embeddings) is
irrelevant to Instagram observation and would import a large non-official
runtime into a project whose value is staying small and honest. Its
deferred-config-failure semantics (bad model name → error on next call) were
deliberately **not** copied; IGTrack's fail-fast rule fits a database-backed
system better.

### 1.2 Agent Reach — `C:\Users\aswin\Agent-Reach` @ `df539ff` (v1.5.0), MIT

An installer/router/doctor: it selects and health-checks an access method and
then tells agents to call the upstream tool directly — it is not a data layer,
has no result envelope, no source URL/hash/capture time, and no cache. Its
Instagram route is OpenCLI: a Chrome-extension bridge reusing the operator's
logged-in `instagram.com` session, with a documented fallback that renders
profile pages through the logged-in browser to route around the platform's own
429 on the anonymous `web_profile_info` endpoint.

**Verdict: pattern confirmations only; adopt no code.** The Instagram channel is
the session-reuse/browser-automation line IGTrack exists to refuse
(AGENTS.md invariant 3, FOUNDING §14), and its retry/fallback chains route
around platform controls. The honesty culture at the availability layer
(never promote an unverified backend to ok; record "no zero-config path
exists" instead of failing silently; side-effect-free probes) matches rules
IGTrack already enforces, and its live doctor run (7/16 channels ok, social
channels gated on a live browser session) is confirmatory evidence that the
"zero-config Instagram" story does not exist.

### 1.3 The "phone number → photos" project — does not exist

A machine sweep (Desktop, Documents, Downloads, AppData, full `C:\` depth-1)
found no such project and no "Serlac Games"; the only text hit was a base64
coincidence inside a third-party asset. The live class of tools splits into
face-search (photo in, no phone — PimEyes, FaceCheck.ID), phone OSINT (phone
in, no photos — PhoneInfoga, Ignorant), and one literal unofficial
profile-picture fetcher (Whapi-Cloud, 13 stars, paid unofficial API). The
"photos by phone" phrasing is data-broker marketing for paid PII databases.

**Verdict: nothing adoptable; keep as the citation when the claim resurfaces.**
For a phone number the only true answer is `UNAVAILABLE` with reason "no
official route exists" — the shape FOUNDING §14 already records. The one
transferable idea is rhetorical (state anti-features explicitly), and IGTrack
already has the machine-checked equivalent in its capability registry.

---

## 2. Feature-gap matrix (P0 = blocking the product's stated purpose)

| # | Gap found in the recon | Prio | Disposition | Where it landed |
|---|---|---|---|---|
| 1 | No table or payload could hold "a source states X about this account"; the operator's agent's findings evaporated in chat | **P0** | **Shipped** | `claims` table (migration 0020), predicate registry + refusals, `claims add/list/retract`, FOUNDING §18 D67 |
| 2 | No deterministic read joining platform facts with cited external claims, in separated sections | **P0** | **Shipped** | `igtrack research` / `igtrack_research` (D68); acceptance A18–A20 pin separation and determinism |
| 3 | An agent had no way to ask "what is left to do for this account" without holding state in its head | **P0** | **Shipped** | `igtrack plan` / `igtrack_plan` — stateless recomputation from jobs/targets/claims (D68); acceptance A21–A25 |
| 4 | No end-to-end acceptance suite mapping the mission's scenarios to executable checks | **P0** | **Shipped** | `apps/cli/test/acceptance.test.ts` A01–A26 |
| 5 | Research content could not answer "what does it post about / how often" from stored rows | P1 | **Shipped** (Phase-2 items pulled forward) | `packages/core/src/synthesis.ts` themes/cadence; research sections state their corpus |
| 6 | No hand-off format for a human researcher | P1 | **Shipped** | `research --format md`; `--since` filters claims only and counts omissions |
| 7 | Stale research had no display-state; nothing distinguished "checked long ago" from "current" | P1 | **Shipped** | `dueForReview` at a 180-day horizon on `retrieved_at ?? recorded_at`; flag only, never hidden |
| 8 | "This check was never applied" had no distinct vocabulary from `UNAVAILABLE` (Laya's tri-state gate read as a real gap) | P2 | **Proposal** — `plan`'s `NOT_APPLICABLE` and the due-for-review flag cover the observed cases; a full audit tri-state has no current consumer | Not built (YAGNI until a consumer exists) |
| 9 | Batch-correctness discipline (grouping key covers every numerically relevant input; order restored; single path delegates to batch) | P2 | **Checklist only** — IGTrack's reads are single-target; the existing scan-batching code predates this and already pins ordering | No code change; kept as a review checklist |
| 10 | Published error-slug list as a closed contract (Laya) | P2 | **Partial** — IGTrack's `CliError` codes are typed and stable (`CLAIM_*`, `TARGET_*`, `CONFIRMATION_REQUIRED`, …); a single published table does not exist | Remaining, low priority |
| 11 | Liker lists, follower rosters of others, third-party comments, repost identities, hidden highlights | — | **Refused** (all three projects either sell/browser-fetch these or don't claim them) | FOUNDING §14; capability registry `DOCUMENTED_ABSENT` |
| 12 | Instagram via session reuse / browser automation / proxy readers (Agent Reach's actual IG route) | — | **Refused at the boundary** | AGENTS.md invariant 3; reconnaissance evidence recorded here |

---

## 3. Adopted techniques (idea-level; no code copied)

Licenses: Laya Apache-2.0, Agent Reach MIT. **No source code was copied from
either project** — the items below are behavioral patterns, adopted by
independent implementation. Attribution is recorded here and at the
implementation sites.

| Technique | Source | Where it landed in IGTrack |
|---|---|---|
| A bounded/derived figure must disclose its cap *where the claim lives*, and "total defined" ≠ "what entered the input" | Laya (`laya-ts/README.md` L118–133) | Confirms and strengthens D48: the research report repeats the discovery-preview cap in every derived section (`boundedNote`), not just in the media listing. Acceptance A18; `research` themes/cadence notes name their corpus |
| A mode-absent capability is refused as its own typed outcome, never degraded into an empty result | Laya (`unsupported_remote`) | Already IGTrack's structural-unavailable rule; now also rendered in the planner as `NOT_APPLICABLE` with its reason (D68) and refused at scan enqueue (D47) — A08/A09, A22 |
| Error taxonomy split by class with stable codes (local validation vs transport vs upstream) | Laya (`McpToolError` slugs; TS SDK error classes) | Extended the existing typed-code discipline: the claims surface adds a closed set (`CLAIM_PREDICATE_REFUSED/UNKNOWN`, `CLAIM_VALUE_INVALID`, `CLAIM_SOURCE_URL_INVALID`, `CLAIM_EXCERPT_INVALID`, `CLAIM_DUPLICATE`, `CLAIM_NOT_FOUND`, `CLAIM_ALREADY_RETRACTED`, `CONFIRMATION_REQUIRED`), all asserted in tests |
| Tool copy states the *negative* contract next to what the tool does | Laya (`server.py` L81–87) | The new MCP tools' descriptions and the server INSTRUCTIONS state that claims are operator-supplied, that IGTrack never generates or fetches them, and that source text is data, not instructions |
| Claim only what was verified; an unverified backend is never promoted to "available" | Agent Reach (`_opencli_site.py` L41–46) | Already the availability formula (`whyUnavailable === null` AND a writer exists); `ACCOUNT_RESEARCH` is available *because operator claims are a real writer*, with zero provider methods — pinned in acceptance A04 |
| Record "no lawful route exists" in the registry instead of failing silently | Agent Reach (`reddit.py` docstring) | Existing `DOCUMENTED_ABSENT` entries; the recon added no new refusal and changed none |
| Side-effect-free diagnostics (probes that neither start daemons nor read credentials) | Agent Reach (`probe.py`, doctor refusals) | Existing doctor discipline (prints presence, never values) — no change needed; recon confirmed the rule is load-bearing |

**Kept as proposals (not built):** Laya's full audit tri-state
(`passed`/`abstained`/`unevaluated`), the batch-grouping checklist as code, and
a published error-code table.

---

## 4. Deliberately not adopted

| Rejected | Source | Why |
|---|---|---|
| The Laya engine/runtime (checkpoints, torch/ONNX, GPU kernels, browser weights) | Laya | Irrelevant to observation; a large non-official runtime in a project valued for staying small |
| Deferred config-failure semantics | Laya | IGTrack's fail-fast rule is the better fit for a DB-backed system (AGENTS.md invariant 7) |
| Plugin/hook lifecycle | Laya | No plugin surface exists in IGTrack; YAGNI |
| Instagram via Chrome session reuse; 429 workaround via logged-in page rendering | Agent Reach | The session-cookie/headless-scraping line — invariant 3, FOUNDING §14 |
| Cookie extraction/import, Jina-Reader proxying, retry chains around platform controls | Agent Reach | Proxying/re-serving and control-circumvention; refused |
| "Agents call upstream tools directly" (no result envelope) | Agent Reach | Loses provenance — the exact opposite of this project's product property |
| Any phone→photo capability (face search, phone OSINT, unofficial profile-pic fetch) | phone-photo class | No lawful route exists; adopting one would be a founding decision and the evidence argues against |

---

## 5. Performance

No cross-project performance comparison is made or implied — the systems are
not comparable and no shared benchmark exists. IGTrack's own measured numbers
for the new agent-facing reads (synthetic fixture workload, 64 claims, local
Postgres, `scripts/bench-research.ts`): claims list p50 6.7 ms / p95 19.8 ms;
research p50 42.5 ms / p95 60.0 ms; plan p50 7.0 ms / p95 9.5 ms — all far
below the pre-established 1500 ms research threshold. Dev-mode CLI process
startup via tsx is p50 ≈ 3.0 s, paid once per MCP session rather than per call.

## 6. Evidence locations

- [recon/laya-report.md](recon/laya-report.md) — full Laya recon (file:line citations).
- [recon/agent-reach-report.md](recon/agent-reach-report.md) — full Agent Reach recon + verbatim doctor output.
- [recon/phone-photo-verdict.md](recon/phone-photo-verdict.md) — machine sweep + candidate table.
- FOUNDING §18 (D67/D68) — the binding decision record for what shipped.
- `apps/cli/test/acceptance.test.ts`, `apps/cli/test/research-benchmark.test.ts` — the executable pins.
