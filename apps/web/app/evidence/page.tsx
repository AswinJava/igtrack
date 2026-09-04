import Link from "next/link";
import { getEvidenceList } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, ConfidenceBadge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<{ limit?: string }>;
}) {
  const params = await searchParams;
  const rawLimit = Number.parseInt(params.limit ?? "30", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 30;
  const rows = await getEvidenceList(limit);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Evidence</h1>
      <p className="mt-1 text-sm text-zinc-500">Provenance for every important observation — scoped to your own targets. Open any row to follow claim → observation → source.</p>

      <form method="get" className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
        <label htmlFor="ev-limit">Rows</label>
        <select id="ev-limit" name="limit" defaultValue={String(limit)} className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-sm text-zinc-200">
          {[10, 30, 50, 100].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <button type="submit" className="rounded-lg bg-zinc-800 px-3 py-1 text-sm text-zinc-100 hover:bg-zinc-700">Show</button>
        <span className="text-zinc-600">Showing {rows.length} of up to {limit} most recent rows.</span>
      </form>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Evidence ledger</CardTitle>
          <CardDescription>Append-only provenance. Historical truth survives current-state changes.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">No evidence yet — observations appear here once scans complete.</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((e) => (
                <li key={e.id} className="rounded-lg border border-zinc-800 px-4 py-3 hover:border-zinc-700 transition-colors">
                  <Link href={`/evidence/${e.id}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded-lg">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="muted">{e.observation_kind}</Badge>
                      <span className="font-mono text-xs text-zinc-400">{e.raw_hash ? `${e.raw_hash.slice(0, 12)}…` : "raw hash unavailable"}</span>
                      <ConfidenceBadge confidence={e.confidence} />
                      <span className="text-xs text-zinc-500">{e.source_id}</span>
                    </div>
                    <p className="mt-2 text-xs text-zinc-500">
                      Observed {formatDateTime(e.observed_at)} · Captured {formatDateTime(e.captured_at)}
                      {e.normalized_hash && <span> · Norm {e.normalized_hash.slice(0, 12)}…</span>}
                    </p>
                    <p className="mt-1 break-all font-mono text-[11px] text-zinc-600">raw:{e.raw_hash ?? "unavailable"}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
