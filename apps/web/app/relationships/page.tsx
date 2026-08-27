import { getTargets, getRelationships } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function RelationshipsPage() {
  const targets = await getTargets();
  const primary = targets[0];
  const relationships = primary ? await getRelationships(primary.id) : [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Relationships</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Strongest observed connections — <span className="font-medium text-amber-400">inferred intelligence</span>, never presented as fact about
        private feelings.
      </p>

      <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-amber-200">
        Relationships are ranked by observed signals (story mentions, follow deltas). A high score means “frequently observed interacting
        in public data” — not “favourite person.”
      </div>

      {!primary ? (
        <Card className="mt-6">
          <CardContent className="py-8 text-center text-sm text-zinc-500">No tracked accounts — seed data will create target_a.</CardContent>
        </Card>
      ) : (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Observed relationship signals for @{primary.username}</CardTitle>
            <CardDescription>Signals are counted from evidence-linked observations. Unavailable capabilities are shown as unavailable, not zero.</CardDescription>
          </CardHeader>
          <CardContent>
            {relationships.length === 0 ? (
              <p className="py-8 text-center text-sm text-zinc-500">Not enough signals yet.</p>
            ) : (
              <ol className="space-y-3">
                {relationships.map((r, idx) => (
                  <li key={r.username} className="flex items-center gap-4 rounded-xl border border-zinc-800 px-4 py-3">
                    <span className="font-mono text-sm text-zinc-500">#{idx + 1}</span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-zinc-200">{r.username}</p>
                      <p className="text-xs text-zinc-500">
                        Mentions {r.signals.mentions} · Follow signals {r.signals.deltas} · Score {r.score} · Confidence {r.confidence}
                      </p>
                    </div>
                    <Badge tone={r.score > 15 ? "success" : r.score > 8 ? "warning" : "muted"}>
                      {r.score > 15 ? "Strong" : r.score > 8 ? "Moderate" : "Weak"} · Inferred
                    </Badge>
                  </li>
                ))}
              </ol>
            )}
            <div className="mt-4 rounded-lg bg-zinc-800/50 px-4 py-3 text-xs text-zinc-500">
              <p className="font-medium text-zinc-400">How the score works</p>
              <p className="mt-1">Score = mentions × 12 + follow signals × 8. Weights are intentionally simple and transparent for Phase 3.</p>
              <p className="mt-1">Future phases will add recency decay, persistence, and reciprocal-signal weighting.</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
