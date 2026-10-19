// ---------------------------------------------------------------------------
// The research engine's network layer (FOUNDING §19, D69).
//
// Three responsibilities, each with hard limits:
//   fetcher.ts  — SSRF-guarded public page retrieval (robots, redirects,
//                 content types, byte caps, timeouts, DNS pinning).
//   extract.ts  — deterministic HTML → candidate claims (JSON-LD, meta,
//                 mailto). No prose interpretation, no LLM, no guessing.
//   search.ts   — optional search provider (env-gated) that returns
//                 CANDIDATE urls only; nothing is evidence until fetched.
//   queries.ts  — deterministic query strategy for one handle (D74): which
//                 questions to ask, never what the answers mean.
//
// This package owns sockets. Nothing here writes to the database; the
// engine one layer up feeds candidates through the claims validation gate.
// ---------------------------------------------------------------------------

export * from "./fetcher.js";
export * from "./extract.js";
export * from "./search.js";
export * from "./queries.js";
