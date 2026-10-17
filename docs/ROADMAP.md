# Roadmap

IGTrack is deliberately small. The roadmap protects that: every item either
strengthens the evidence model or makes a lawful source easier to use. There are
no dates — items ship when they are correct and tested.

## Now

- **Live-verify the Graph provider end to end.** The request shapes are pinned to
  Meta's documentation and marked `NOT_VERIFIED`; the remaining work is a real
  account run with the outstanding fields recorded.
- **Expand the test matrix.** More parser fixtures for logged-out pages
  (localizations, empty states, rate-limit responses) and more worker crash
  scenarios.
- **Documentation polish.** Runnable examples for every command, and a
  contributor walkthrough for adding a provider.

## Next

- **Provider SDK.** A small, documented interface plus a conformance harness so a
  new lawful source can be added without touching the core.
- **More import formats.** Additional official export layouts and generic JSON
  captures, normalized into the same models.
- **Richer period exports.** More export kinds and stable schemas for downstream
  analysis.
- **Operational surfaces.** Better `doctor` diagnostics, structured worker logs,
  and a documented backup/restore drill.

## Later

- **Additional lawful platforms.** Any platform with a documented API and an
  honest absence model.
- **A read-only dashboard.** A local, single-user view over the same operations
  layer — no second data path, no hosted service.

## Not planned

These are product decisions, not missing features:

- Private-account access, session-cookie scraping, story/highlight proxies, or
  media download pipelines.
- Follower rosters for arbitrary accounts, liker lists, interaction feeds, or
  repost attribution — the platform does not expose them.
- Hosted multi-tenant SaaS, billing, seats, or a paid tier.
- AI inference that turns speculation into "findings".
- A browser extension or a network-facing HTTP API.

If you want to work on something here, open an issue first so the design can be
agreed before code is written. See [CONTRIBUTING.md](../CONTRIBUTING.md).
