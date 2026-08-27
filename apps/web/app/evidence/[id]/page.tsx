import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvidenceDetail } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, ConfidenceBadge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function EvidenceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getEvidenceDetail(id);
  if (!detail) notFound();
  const { evidence: e, claim, lineage } = detail;

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <Link href="/evidence" className="text-xs text-zinc-500 hover:text-zinc-300">← Evidence ledger</Link>

      <h1 className="mt-3 text-xl font-semibold tracking-tight">Evidence chain</h1>
      <p className="mt-1 text-sm text-zinc-500">Claim → observation → source → hashes. Nothing is presented here that the underlying evidence does not support.</p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">The claim</CardTitle>
          <CardDescription>What this evidence supports.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-200">{claim}</p>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Provenance record</CardTitle>
          <CardDescription>Immutable row from the append-only evidence table.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="muted">{e.observation_kind}</Badge>
            <ConfidenceBadge confidence={e.confidence} />
            <span className="text-zinc-500">source</span><span className="font-mono text-xs text-zinc-300">{e.source_id}</span>
          </p>
          <dl className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg bg-zinc-800/50 px-3 py-2"><dt className="text-xs text-zinc-500">Observed at</dt><dd className="font-mono text-xs text-zinc-300">{formatDateTime(e.observed_at)}</dd></div>
            <div className="rounded-lg bg-zinc-800/50 px-3 py-2"><dt className="text-xs text-zinc-500">Captured at</dt><dd className="font-mono text-xs text-zinc-300">{formatDateTime(e.captured_at)}</dd></div>
          </dl>
          <p className="break-all font-mono text-[11px] text-zinc-500">raw_hash: {e.raw_hash}</p>
          {e.normalized_hash && <p className="break-all font-mono text-[11px] text-zinc-500">normalized_hash: {e.normalized_hash}</p>}
          {e.observation_id && <p className="break-all font-mono text-[11px] text-zinc-600">observation_id: {e.observation_id}</p>}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Lineage</CardTitle>
          <CardDescription>How this evidence connects to the derived claims that reference it.</CardDescription>
        </CardHeader>
        <CardContent>
          {lineage.length === 0 ? (
            <p className="py-4 text-center text-sm text-zinc-500">No additional lineage recorded for this evidence kind.</p>
          ) : (
            <ul className="space-y-2">
              {lineage.map((l, i) => (
                <li key={i} className="rounded-lg border border-zinc-800 px-4 py-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{l.label}</p>
                  <p className="mt-1 break-words font-mono text-xs text-zinc-200">{l.value}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-[11px] leading-relaxed text-amber-300">
            Hashes are content hashes of captured payload forms, not secrets. Synthetic sources are labelled as such; a claim sourced from the fixture provider describes fixture reality only.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
