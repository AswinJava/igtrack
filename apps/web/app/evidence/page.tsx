import { getEvidenceList } from "@/lib/data";
import { requirePageUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, ConfidenceBadge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function EvidencePage() {
  await requirePageUser();
  const rows = await getEvidenceList(30);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Evidence</h1>
      <p className="mt-1 text-sm text-zinc-500">Provenance for every important observation — hashes, timestamps, source. No raw payloads, no secrets.</p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Evidence ledger</CardTitle>
          <CardDescription>Append-only provenance. Historical truth survives current-state changes.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">No evidence yet.</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((e) => (
                <li key={e.id} className="rounded-lg border border-zinc-800 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="muted">{e.observation_kind}</Badge>
                    <span className="font-mono text-xs text-zinc-400">{e.raw_hash.slice(0, 12)}…</span>
                    <ConfidenceBadge confidence={e.confidence} />
                    <span className="text-xs text-zinc-500">{e.source_id}</span>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    Observed {formatDateTime(e.observed_at)} · Captured {formatDateTime(e.captured_at)}
                    {e.normalized_hash && <span> · Norm {e.normalized_hash.slice(0, 12)}…</span>}
                  </p>
                  <p className="mt-1 break-all font-mono text-[11px] text-zinc-600">raw:{e.raw_hash}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
