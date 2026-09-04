import { getTargets, getRelationships } from "@/lib/data";
import { requirePageUser } from "@/lib/auth";
import { relationshipBand, describeRelationshipSignals } from "@/lib/relationships";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function RelationshipsPage({
  searchParams,
}: {
  searchParams: Promise<{ targetId?: string }>;
}) {
  await requirePageUser();
  const targets = await getTargets();
  const { targetId } = await searchParams;
  const primary = targets.find((t) => t.id === targetId) ?? targets[0];
  const relationships = primary ? await getRelationships(primary.id) : [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Relationships</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Observed relationship signals — <span className="font-medium text-amber-400">simple heuristic counts</span> from
        synthetic fixture observations, never knowledge about real relationships.
      </p>

      <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-amber-200">
        Accounts are ordered by observed signals (story mentions, follow deltas). A higher count means “more observed
        activity in the collected data” — not “favourite person.” No recency decay, reciprocity, sentiment, or
        behavioral modeling is applied.
      </div>

      {targets.length > 1 && (
        <form method="get" className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
          <label htmlFor="rel-target">Account</label>
          <select id="rel-target" name="targetId" defaultValue={primary?.id ?? ""} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-500">
            {targets.map((t) => (
              <option key={t.id} value={t.id}>@{t.username}</option>
            ))}
          </select>
          <button type="submit" className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-100 hover:bg-zinc-700">Show</button>
        </form>
      )}

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
                {relationships.map((r, idx) => {
                  const band = relationshipBand(r.signals.mentions + r.signals.deltas);
                  return (
                    <li key={r.username} className="flex items-center gap-4 rounded-xl border border-zinc-800 px-4 py-3">
                      <span className="font-mono text-sm text-zinc-500">#{idx + 1}</span>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-zinc-200">{r.username}</p>
                        <p className="text-xs text-zinc-500">
                          {describeRelationshipSignals(r.signals)} · Heuristic score {r.score} · Confidence {r.confidence}
                        </p>
                      </div>
                      <Badge tone={band.tone}>
                        {band.label} · Inferred
                      </Badge>
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="mt-4 rounded-lg bg-zinc-800/50 px-4 py-3 text-xs text-zinc-500">
              <p className="font-medium text-zinc-400">How the score works</p>
              <p className="mt-1">Heuristic score = mentions × 12 + follow signals × 8. The weights are arbitrary and transparent — they order accounts by raw signal volume only.</p>
              <p className="mt-1">All underlying data is synthetic fixture data. No recency decay, persistence weighting, or reciprocal-signal analysis is implemented.</p>
              <p className="mt-1">Public likes are UNAVAILABLE — Instagram exposes no public likes feed, so they are never counted here. Frequently observed public associations are derived analytics, not “favourite people”.</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
