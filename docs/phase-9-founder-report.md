# Phase 9 — Final Founder Report

## 1. Executive Verdict

**PROVIDER-INTEGRATION READY (unchanged, now with remote CI VERIFIED)** — with the
provider-selection decision explicitly documented: FixtureProvider is the only
lawful provider integrable now; Graph API and user-import are evaluation-ready but
require founder/legal prerequisites (Meta app review + token lifecycle) before any
live integration. **PROVIDER-INTEGRATED / READY FOR CONTROLLED TESTING** is NOT
claimed — no real provider has live-verified credentials or app review.

## 2. Commit

HEAD `9cf1904` on `master`, working tree clean. Phase 9 commits:
1. `af5990f` — fix CI workflow YAML (quoted step name; remote parse failure)
2. `bd6195a` — remove accidentally committed scratch artifacts
3. `b942dae` — remove dead `IGTRACK_SESSION_SECRET` config
4. `f661361` — founder decisions: backup/RPO policy + deleted-target retention
5. `560eafd` — provider evaluation document
6. `57de704` — forensic audit + failure matrix
7. `9cf1904` — worker-integration test robustness (order-independence)

## 3. Remote CI

- Run `33188157576` (Phase 8 HEAD): **FAILED at 0s** — workflow YAML unparseable
  (colon-space in unquoted step name) → zero jobs. Found by actually running it.
- Run `33189015158` (after fix): **SUCCESS** 2m9s — full chain green.
- Run `33193234489` (Phase 9 HEAD `9cf1904`): **SUCCESS** 2m18s — full chain green:
  install → Postgres guard → typecheck → 155 tests on real Postgres → worker boot
  smoke → production build → Playwright E2E.
- Known annotation: Node 20 deprecation warning on actions (cosmetic, future work).

## 4. Provider Selected

**FixtureProvider (T0)** — synthetic, ship-included, zero credentials. Why: the only
lawful provider integrable and exercisable now; canonical reference for the
conformance suite. Graph API (authorized-accounts-only, requires Meta app review)
and user-import (requires founder data-handling decision) are documented as
evaluation-ready, NOT integrated. Scraping/private-API candidates: rejected at the
legal boundary (see `docs/platform-limitations.md` — unchanged).

## 5. Capability Matrix

See `docs/phase-9-provider-evaluation.md` §4/§5 — every contract item has an
explicit AVAILABLE/PARTIAL/UNAVAILABLE/UNKNOWN answer with conformance evidence.
Notable honest limits: historical likes UNAVAILABLE; DMs UNAVAILABLE; private
accounts AUTHORIZED-ONLY; stories availability format-dependent for real providers.

## 6. Architecture Changes

None to the pipeline. Documentation-only + test-robustness changes. The Phase 8
architecture (core → ingestion → database → web/workers; append-only observations;
provider boundary; Postgres-only persistence) is preserved exactly.

## 7. Reliability

Re-verified at Phase 9 HEAD: PC-T1 timeout, retry-after honoring, lease/reclaim,
PC-T2 staging, idempotency, worker survival, scheduler windows — all green in the
155-test suite and remote CI. Test-suite robustness improved (integration tests no
longer coupled to cross-test queue state).

## 8. Evidence

Raw/normalized hash semantics re-verified clean (STEP 11 sweep): `raw_hash`
genuine-or-NULL, `normalized_hash` deterministic, provenance complete, ownership
user-scoped. No fabricated provenance path.

## 9. Security

STEP 10 sweep clean: no provider payload/credential logging; no credential-shaped
identifiers in app code; auth/ownership/diagnostics unchanged and sound.
`IGTRACK_SESSION_SECRET` removed as dead config (documented rationale: opaque
hashed tokens need no cookie signature).

## 10. Failure Injection

Covered by Phase 8 suites (PC-T1/T2 + taxonomy) re-run green at Phase 9 HEAD:
provider hangs → TIMEOUT retryable, no evidence; rate limit → retryAfterMs honored;
forbidden → non-retryable; malformed → SCHEMA_MISMATCH non-retryable, no raw dump;
partial → PARTIAL preserved; zero → honest COMPLETED_EMPTY; crash mid/post
acquisition → staging survives, idempotent; stale lease → reclaim idempotent.

## 11. Tests

- Vitest: **155 passed / 1 skipped (by-design) / 0 failed** — 26 files, real PostgreSQL.
- Playwright: **7 passed / 0 failed / 0 skipped**.
- Typecheck: **PASS** (all 4 packages).
- Production build: **PASS**.
- Remote CI: **PASS** (run `33193234489`).

## 12. Documentation

Changed/created: `docs/phase-9-forensic-audit.md`, `docs/phase-9-provider-evaluation.md`,
`docs/phase-9-failure-matrix.md`, `docs/deleted-target-retention.md`,
`docs/deployment.md` (§3A/§4a updates), `.env.example`, `.github/workflows/ci.yml`,
`workers/monitoring/test/worker-integration.test.ts`.

## 13. Remaining P0/P1

**0 P0, 0 P1.**

## 14. Remaining P2 (prioritized)

1. Login rate limiting (before any public exposure)
2. Backup job deployment (policy documented; needs platform)
3. Session purge scheduling (`purgeExpiredSessions` still unscheduled)
4. Snapshot-time account-upsert batching (large scans)
5. Lease heartbeat (scans longer than lease)
6. Pool timeout tuning
7. `ig_accounts` identity-strip reaper (policy decided, not implemented)
8. Dockerfiles / `/healthz` / scan-duration metrics

## 15. Deferred Work

Real provider integration (Graph API after Meta app review; user-import after
data-handling decision); container packaging; UI honesty depth (roadmap item 7).

## 16. Founder Decisions Required

1. Authorize Meta app creation + app review for Graph API evaluation (needs a
   business/creator account willing to authorize).
2. Choose deployment platform (unblocks Dockerfiles + backup cron).
3. Approve login rate-limiting approach before public exposure.
4. Confirm the 24h RPO / 14-day retention backup policy.

## 17. Final Recommendation

**Continue provider evaluation → enter controlled provider testing only after the
founder decisions above land.** IGTrack is truthful, reliable, lawful, reproducible,
evidence-backed, and operationally defensible at Phase 9 HEAD: remote CI is now a
real, passing gate; the contract is explicit and conformance-proven; the lawful
limits are documented and visible. FixtureProvider remains the only integrated
provider until a real one is legally authorizable — exactly as the platform
requires.