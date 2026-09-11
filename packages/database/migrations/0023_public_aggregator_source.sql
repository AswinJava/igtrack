-- Third-party public aggregator source. Stories, highlight contents and story
-- mentions are reachable from anonstories.com without a login, but the answer
-- comes from a third-party relay, not from a page Instagram served and not from
-- the platform's API. The dedicated source kind keeps those rows apart from
-- PUBLIC_WEB and GRAPH_API so no surface can present aggregator data as a
-- platform observation.
ALTER TYPE "source_kind" ADD VALUE IF NOT EXISTS 'PUBLIC_AGGREGATOR';--> statement-breakpoint
