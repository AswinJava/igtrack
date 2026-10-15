# Security policy

## Reporting a vulnerability

Open a **private** security advisory on the repository (Security → Report a
vulnerability), or contact the maintainer directly if advisories are unavailable.

Please include: what you found, how to reproduce it, the impact you believe it
has, and the version/commit you tested. Do not open a public issue for a
credential leak, an access-control bypass, or cross-user data exposure.

There is no bug bounty and no SLA, but reports are read and acted on.

## What counts as a vulnerability here

- **Credential exposure** — a token, database URL or password reaching logs,
  CLI/MCP output, fixtures, error text, or evidence rows.
- **Cross-user data exposure** — reading or writing another user's targets,
  observations or evidence (ownership scoping bypass).
- **Access-control circumvention** — any path that observes data through an
  undocumented endpoint, session cookie, or proxy rather than a lawful,
  documented API. This is the project's founding line, not just a bug class.
- **Injection** — SQL, command, or template injection through any input,
  including scan-derived strings rendered by the CLI or MCP server.
- **Evidence forgery** — a stored claim without evidence, a hash that does not
  match its payload, or absence rendered as zero.

## What is *not* a vulnerability (by design)

These are documented product decisions, not defects:

- **Reads are restricted to what the official API exposes.** Follower rosters for
  arbitrary accounts, liker lists, interaction feeds, highlights and media bytes
  are unavailable. "I could not extract X" is the intended behaviour.
- **Fixture data in a non-`graph` deployment.** Synthetic data is labelled
  (`_meta.synthetic`, banners, source ids). It is not a real observation.
- **No network-facing service.** IGTrack exposes a stdio MCP server and a local
  CLI — there is no HTTP surface to rate-limit or authenticate against. Every
  network egress is a provider call to a lawful, documented API.

## Handling secrets

- Never commit `.env` (it is gitignored) or any credential.
- Live observation needs `IGTRACK_GRAPH_ACCESS_TOKEN` and friends, provided via
  the environment or your platform's secret store — never in a file that is
  packaged, served, or logged.
- `igtrack config` and `igtrack doctor` print presence and shape, never values.
- Rotate a token by replacing the environment variable and restarting; nothing
  persists credential values anywhere in the database.

## Supported versions

The `main` branch is the supported version. This is a self-hosted project: patch
by pulling and re-running `igtrack setup` (migrations are additive).
