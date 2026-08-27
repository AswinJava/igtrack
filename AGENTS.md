# IGTrack — Agent Instructions

IGTrack is an evidence-driven **public** Instagram monitoring and relationship
intelligence platform. Read `docs/architecture.md` before structural changes and
`docs/platform-limitations.md` before touching ingestion.

## Commands

```bash
pnpm install          # install workspace deps
pnpm test             # run all tests (vitest)
pnpm typecheck        # tsc across all packages
pnpm lint             # lint (when configured)
pnpm build            # build all packages
```

## Non-negotiable product principles

1. **OBSERVATION ≠ FACT ≠ INFERENCE.** Every data point is typed as
   `OBSERVED | DERIVED | INFERRED | UNAVAILABLE`. Never blur these in code, UI
   copy, or AI output.
2. **Evidence first.** Every important observation carries provenance
   (source, timestamps, confidence, hashes). No orphan facts.
3. **Capability honesty.** Ingestion methods return `CapabilityResult` with
   `AVAILABLE | PARTIAL | UNAVAILABLE | ERROR`. Never fabricate data to make a
   feature appear to work. Prefer an honest "unavailable" over fake completeness.
4. **Append-only history.** Observations are never overwritten; current state is
   derived. Historical truth must survive current-state changes.
5. **Fixture-driven tests.** Tests never hit live Instagram. Use versioned
   fixtures under `packages/ingestion/fixtures/`.

## Legal / platform safety (hard rules)

Do NOT implement, scaffold, or suggest:

- credential harvesting, session/cookie theft, account takeover
- bypassing authentication, CAPTCHA, challenges, or access controls
- private-account access without authorization
- detection-evasion or anti-forensics techniques
- covert surveillance mechanics

Only public, user-authorized, or permitted-integration data sources. When a
capability requires violating these rules, mark it `UNAVAILABLE` and document it
in `docs/platform-limitations.md`.

## Code conventions

- TypeScript strict mode everywhere; no `any` without a written justification.
- ESM (`"type": "module"`), NodeNext resolution.
- pnpm workspaces monorepo: `apps/web`, `packages/*`, `workers/monitoring`.
- Modular monolith. No microservices. Clear package boundaries:
  `core` (types/contracts, zero deps) → `ingestion` → `database` → app/workers.
- Zod at every external boundary (raw source payloads, API input).
- Errors are typed and named; no silent catch-and-continue.
- No comments unless the why is non-obvious; never narrate the obvious.
- Secrets only via env vars; never commit `.env`, keys, cookies, or tokens.

## UI language

Use: "Public monitoring", "Observed interaction", "Evidence", "Confidence",
"Last observed", "Strongest observed connections".
Never: "100% complete", "everything they liked", "secretly interacts with",
"stalking", "undetectable".

## Definition of done

A feature is done only when: implemented, typed, persisted, tested, error
handled, observable, documented, reachable in UI, with empty/loading/failure
states, mobile responsive, security reviewed.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill
tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Security audit → invoke /cso
- Author a backlog-ready spec/issue → invoke /spec
