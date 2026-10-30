## What changed

<!-- The reason, not a file list. What was wrong or missing before this PR? -->

## How it was verified

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (or the environment limitation is stated below)
- [ ] `pnpm docs:capabilities` run if the capability registry changed
- [ ] New behavior has a test that fails without the change

## Invariants

- [ ] No `null`-to-zero coercion; absence is still `null` with a reason
- [ ] `PARTIAL` reads are still stored but never diffed
- [ ] Evidence classes are still distinguishable end to end
- [ ] No secrets, tokens or captured personal data in output, tests or fixtures

## Notes for the reviewer

<!-- Anything subtle: ordering, migrations, defaults, refusals. -->
