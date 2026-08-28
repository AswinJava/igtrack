# Phase 9 — Failure Matrix

Columns: Operation | Failure | Expected | Actual | Recovery | Evidence impact.
Severity: P0 corruption/cross-user/fabrication · P1 production blocker ·
P2 scaling/maintainability. Inherited Phase 5–8 invariants remain in force.

| Operation | Failure | Expected | Actual | Recovery | Evidence impact |
|---|---|---|---|---|---|
| Remote CI | Workflow file unparseable (`STEP 20:` colon in unquoted step name) | Job runs all gates | `419`-class: zero jobs, run failed at 0s | **FIXED**: quoted the step name; run `33189015158` SUCCESS (2m9s) | None |
| Session config | `IGTRACK_SESSION_SECRET` dead config | Resolved (used or removed) | Removed; sessions rely on opaque hashed tokens | n/a | None |
| Backup/RPO | No backups exist | Policy defined; not deployed | 24h RPO policy documented; explicit "NOT DEPLOYED" | deployment-platform decision | Unreconstructible if volume lost — documented |
| Deleted target | `ig_accounts` registry retained | Retention semantics defined | Policy: retained, identity-strip future work | n/a | Second-party PII retained — documented |
| Provider (all CPs) | Timeout / rate-limit / forbidden / malformed / partial / unavailable | Typed per taxonomy; zero never absent | All exercised in Phase 8 PC-T1/T2 + conformance suites; no new gaps | worker backoff/retry-after/reclaim | none fabricated |
| Worker | Crash mid/post acquisition | Staged entries survive; idempotent re-execute | Phase 8 staging + F1–F10 verified still green | lease/reclaim + staging | no duplicate evidence |
| Evidence | Raw hash truthfulness | genuine-or-NULL | re-verified clean in STEP 11 | n/a | none fabricated |
| Security | Provider credentials in logs/evidence | never | re-verified clean (STEP 10 sweep) | n/a | none |

## Verdict

No P0, no P1 introduced in Phase 9. The only Phase-9 defects (CI YAML parse +
dead config) are **fixed**. All Phase 5–8 reliability/epistemic/security invariants
re-verified green at baseline and preserved. Remaining findings are the known P2
list (documented in the forensic audit §8) — none are provider-contract blockers.