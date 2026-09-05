// Derives the target-page source badge from actually observed source ids.
// Never hardcoded: fixture ids look like "fixture:v1", graph ids like
// "graph:v1". Graph wins when both are present; null means no observations
// yet, so the page renders no badge instead of a false claim.
export type SourceBadge = "LIVE GRAPH SOURCE" | "SYNTHETIC SOURCE" | null;

export function sourceBadgeForSources(sourceIds: Iterable<string>): SourceBadge {
  let fixture = false;
  for (const s of sourceIds) {
    // Defensive: never throw on dirty input — unknown entries are ignored
    // and surface as no badge rather than a page-level crash.
    if (typeof s !== "string") continue;
    if (s.startsWith("graph:")) return "LIVE GRAPH SOURCE";
    if (s.startsWith("fixture:")) fixture = true;
  }
  return fixture ? "SYNTHETIC SOURCE" : null;
}
