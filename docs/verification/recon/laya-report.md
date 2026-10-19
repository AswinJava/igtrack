# Laya recon — read-only assessment for IGTrack

Scope: static reading of the clone at `C:\Users\aswin\Desktop\serpaix\.laya-ref`. No installs, no
tests, no code executed. Every claim is a file citation or is labelled *inference*. Shallow clone
(`.git/shallow`) → no git history or blame was available; conclusions come from the working tree.

## 1. Identity

- Remote `https://github.com/NandhaKishorM/laya.git`; HEAD `a4a8921afebfd852bba0000475cfb6ab737a124c`
  ("release: 0.3.28"). Clone is depth-1.
- License Apache-2.0 (`LICENSE`); `pyproject.toml`: name `laya`, version `0.3.28`, author Convai
  Innovations, description "Fast, non-autoregressive System 1 decision engine with calibrated
  probabilities".
- What Laya *is*: an inference engine over fine-tuned checkpoints that answer **fixed-option
  questions** (choice / score / noul) in one forward pass. It is not a generative LLM, and says so
  in its own tool copy — "No text generation, so no hallucination. Do NOT use for open Q&A,
  summarization, rewriting, code, or multi-hop reasoning" (`laya/mcp/server.py` L81–87). The
  TypeScript port restates the same boundary (`laya-ts/README.md` L3, L74–78).
- Two shipped surfaces: a Python package (`laya/`, ~150 modules) and a full TypeScript port
  (`laya-ts/`, ONNX split encoder+head, Node CPU/CUDA and browser WebGPU→WASM). A thin HTTP client
  SDK also exists (`sdk/typescript/src/`).
- The repository already uses `ponytail:` deferral comments (e.g. `laya-ts/README.md` L231) — the
  same convention as this workspace, so the style of deferral notes is directly familiar.

## 2. Architecture map

**MCP tool contract** — 8 tools (`laya_predict`, `laya_predict_batch`, `laya_route`,
`laya_route_batch`, `laya_shortlist`, `laya_preset`, `laya_status`, `laya_decide`), all read-only;
no write or destructive tool exists (grep of `laya/mcp/tools.py`). Tool descriptions spell out the
*negative* contract: what the tool must not be used for and above what size
(`server.py` L81–87). Free-string arguments get their contract written out as prose *next to the
code that validates them*, explicitly so the accepting registry is not duplicated
(`server.py` L89–109): a client that pins `model` and also sets `task` is **rejected**, because
otherwise the task would be silently ignored (L102–105).

**Error contract** — every failure becomes `McpToolError` carrying JSON
`{"error": <slug>, "message": ...}` (`server.py` L215–231). Observed slugs: `invalid_*` (per field),
`models_not_ready`, `internal_error`, `unsupported_remote`, plus remote-side `unauthorized`, `busy`,
`upstream_error`, `timeout`, `unreachable`. A failure is never returned as a successful empty
result. The TS SDK mirrors the split at the class level: local validation (`LayaValidationError`,
"rejected locally, before any network traffic"), API (`LayaAPIError` with `status`, `code`,
`details`), and transport (`LayaConnectionError` / `LayaTimeoutError` / `LayaAbortError`) —
`sdk/typescript/src/errors.ts` L1–26.

**Router / backends / fallback** — one precedence rule stated once (`laya/router.py` L1141–1142,
`_route` L1130); an LRU keeps at most 2 checkpoints resident (`router.py` L510–519). GPU→CPU
fallback is *aware of itself*: the reported device distinguishes preferred from actual
(`laya/mcp/device.py` L149+). Routed results always carry the canonical `routing.model`
(`server.py` L96).

**Batching** — `Router.predict_batch` groups requests by routed checkpoint, then re-splits by
order-sensitive question-schema JSON signature, per-request token-budget overrides, and language;
results are restored to input order (`router.py` L1514+, L1577–1664). The single-item path
(`system_one`) delegates to the batch path so the two cannot drift numerically
(`tests/test_batch.py` L56–63).

**Confidence / calibration** — `answer_confidence` = max(p) (`laya/confidence.py` L10+). The gate is
the interesting part: with `min_confidence` unset it **writes nothing at all**; when set it writes
`abstention` ∈ {`passed`, `abstained`, `unevaluated`} plus the `abstention_threshold` actually used,
and `unevaluated` exists specifically to distinguish "the gate ran but no usable confidence existed"
from a pass or a fail (`confidence.py` L166–232). Calibration itself: LBFGS temperature fit
(`laya/calibrate.py` L101–138), held-out ECE split (L196–231), abstention cut (L307–335), versioned
payload (L604+); clamp `[0.5, 5.0]` with fallback 1.0 (`laya/common.py` L818–819).

**Hooks** — `PredictContext` with `skip()` (`laya/hooks.py` L22–70); dispatch enforces raise policy,
a lock, and a timeout (L510–545); registry + scoped install (L374+). TS port: `hooksRaise: false`
for "telemetry must not fail a request", `withHooks([...])` scoped install, process-wide defaults via
`setDefaultHooks` (`laya-ts/README.md` L44–69).

**Revisions** — pinned checkpoint revisions (`laya/revisions.py` L27–31), resolution (L57+) and
digest verification (L98–141); routing stays local even in remote mode, and hook overrides are
refused remotely as `unsupported_remote` rather than silently ignored (`docs/cli-mcp.md` L267).

**Budget honesty in the response** — `usage` reports `truncated`, `state_tokens`,
`state_tokens_dropped`, `truncated_questions` (`laya-ts/README.md` L101–113, `laya-ts/src/agent.ts`
L89–94), and collapsed options report `{total, distinct, tokens_per_option}` where "total is what
the question defines, not the markers that reached the sequence" — so a report cannot read "43 of
43" about a question whose options never entered the input (`laya-ts/README.md` L118–133).

## 3. Transferable techniques

| Technique | Evidence | IGTrack? |
|---|---|---|
| Tri-state outcome: unset → write nothing; set → `passed`/`abstained`/`unevaluated` + the threshold used | `confidence.py` L166–232 | **Adopt.** Names the case IGTrack has no word for: "this check was never applied". Distinguishes it from `UNAVAILABLE` and from empty. |
| Cap disclosed where the claim lives, per response and per row; "total defined" ≠ "what entered the input" | `laya-ts/README.md` L118–133 | **Adopt (shape).** Independent evidence for the existing bounded-listing rule (D48). Copy the disclosure shape, not the code. |
| Batch grouping key includes *everything* that changes the numbers; order restored; single path delegates to batch | `router.py` L1514+, L1577–1664; `tests/test_batch.py` L56–63 | **Adopt** if IGTrack ever bulk-reads several targets in one job; also a review checklist for caches. |
| Error taxonomy split local-validation vs transport vs upstream, with a stable slug per case | `server.py` L215–231; `sdk/typescript/src/errors.ts` L1–26 | **Adopt (cheap).** A closed, published code list. |
| Mode-absent capability refused as its own code (`unsupported_remote`) rather than degraded | `docs/cli-mcp.md` L267; `remote.py` L98–118 | **Adopt.** Same shape as IGTrack's structural-unavailable rule; gives it a wire vocabulary. |
| Device/degradation reports actual, not preferred | `device.py` L149+ | **Adopt (concept).** "What actually happened" in evidence metadata. |
| Tool copy states the negative contract and the size ceiling | `server.py` L81–87 | **Adopt (cheap).** Good model for IGTrack tool descriptions. |
| Hook lifecycle with `skip()`, scoped install, and a raise policy for non-critical hooks | `hooks.py` L22–70, L374+, L510–545; `laya-ts/README.md` L44–69 | **Not now.** No plugin surface in IGTrack; revisit only if one appears. |
| Non-relevant subsystems: GPU kernels / CUDA graphs / TileLang (`fast.py`), training + LoRA finetune (`docs/finetune.md`), ONNX export and ~1.3 GB browser weights (`laya-ts/README.md` L224), 51-language detection (`laya-ts/src/lang.ts`), tokenizer/BPE, shortlist embeddings, per-language temperature tables | as listed | **No.** All engine-side; IGTrack is not an NLU router. |

## 4. Benchmarks as published

`docs/benchmarks.md` states the methodology caveats and a section literally titled "Limits to check
on your own data" (L35–60). `BENCHMARKS.md` L13–35 flags that the calibration columns **predate the
confidence clamp**, i.e. some published ECE numbers were produced by a configuration that no longer
ships. Headline figures: typed-decisions 0.766, but that checkpoint was fine-tuned on that
benchmark's own training split; 51-language macro accuracy 0.2269 (laya) vs 0.4008 (multilingual);
refitting temperatures moves mean ECE 0.466→0.081 (laya) and 0.314→0.106 (multilingual) — both
checkpoints are over-confident as shipped and `laya-multilingual` ships with **no fitted
temperatures** (`README.md` L1584–1596). Jev comparisons are third-party numbers the repo never
re-measured. The docs are unusually candid about all of this, which is a point in the project's
favour — but none of these numbers transfer to IGTrack; they describe a classifier.

## 5. Limits / caveats of this recon

- Read-only static read; nothing was installed or executed, so every "works" claim here is "the code
  and its tests say so", not observed behaviour. Disk (~0.3 GB free) and the read-only constraint
  both forbade running anything.
- Shallow clone: no history, so issue-tracker references in comments (#174, #181, #280, #538) could
  not be verified, only cited as the source's own claims.
- Abstention thresholds are explicitly "a policy you choose from measured accuracy at that coverage
  on your data, not a property of the model" (`calibrate.py` L358–360) — the same warning IGTrack
  gives for its own confidence values.
- Nothing in this report should be read as a performance comparison against IGTrack; the two systems
  do different jobs and no shared benchmark exists.
- One deliberate divergence worth noting rather than copying: Laya defers a bad model name to a
  *tool error on the next call* because "a stdio server has no startup to refuse"
  (`docs/cli-mcp.md` L231). IGTrack's fail-fast rule is the better fit for a database-backed system
  and should stay.

## 6. Verdict

1. **ADOPT the tri-state gate vocabulary** (`passed` / `abstained` / `unevaluated`, write nothing
   when unset, record the threshold used). It is the closest thing Laya has to IGTrack's own
   honesty rule, and it closes a real gap: "never applied" is currently indistinguishable from
   "unavailable" in IGTrack.
2. **ADOPT the bounded-claim disclosure shape** — cap stated per response and per row, total defined
   vs distinct-things-actually-scored, so no surface can round a truncation up into a claim.
3. **ADOPT the batch-correctness discipline** (grouping key covers every numerically relevant input;
   ordering restored; single path delegates to batch) — cheap, and it is the exact bug class that
   would produce a false follower delta.
4. **ADOPT the published error-code list and the mode-absent refusal code**, splitting local
   validation from transport failure.
5. **DO NOT ADOPT the engine itself** (checkpoints, torch/ONNX runtime, GPU kernels, 1.3 GB weights,
   language detection, tokenizer, shortlist embeddings) and do not copy its deferred-config-failure
   semantics. Nothing there helps observe Instagram, and it would import a large non-official
   runtime into a project whose whole value is that it stays small and honest.
