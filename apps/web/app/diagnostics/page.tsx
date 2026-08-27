import { getDiagnostics } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DiagnosticsPage() {
  const data = await getDiagnostics();

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Diagnostics</h1>
      <p className="mt-1 text-sm text-zinc-500">Operator view — database, queue, and source health.</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Database</CardTitle>
            <CardDescription>Connection and migration state.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${data.database.connected ? "bg-emerald-500" : "bg-red-500"}`} />
              <span className="text-sm font-medium">{data.database.connected ? "Connected" : "Unavailable"}</span>
              <Badge tone={data.database.migrationsApplied ? "success" : "danger"}>
                {data.database.migrationsApplied ? "Migrations applied" : "Migrations missing"}
              </Badge>
            </div>
            {data.database.tables.length > 0 && (
              <ul className="mt-4 space-y-1">
                {data.database.tables.map((t) => (
                  <li key={t.table} className="flex justify-between rounded-lg bg-zinc-800/50 px-3 py-1.5 text-xs">
                    <span className="font-mono text-zinc-400">{t.table}</span>
                    <span className="font-medium text-zinc-200">{t.count}</span>
                  </li>
                ))}
              </ul>
            )}
            {"error" in data && data.error && <p className="mt-3 text-xs text-red-400">{String(data.error)}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Queue</CardTitle>
            <CardDescription>monitoring_jobs — FOR UPDATE SKIP LOCKED.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
                <dt className="text-zinc-500">Queued</dt>
                <dd className="mt-1 text-lg font-semibold">{data.queue.queued}</dd>
              </div>
              <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
                <dt className="text-zinc-500">Running</dt>
                <dd className="mt-1 text-lg font-semibold">{data.queue.running}</dd>
              </div>
              <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
                <dt className="text-zinc-500">Retry wait</dt>
                <dd className="mt-1 text-lg font-semibold">{data.queue.retryWait}</dd>
              </div>
              <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
                <dt className="text-zinc-500">Failed</dt>
                <dd className="mt-1 text-lg font-semibold">{data.queue.failed}</dd>
              </div>
              <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
                <dt className="text-zinc-500">Succeeded</dt>
                <dd className="mt-1 text-lg font-semibold">{data.queue.succeeded}</dd>
              </div>
              <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
                <dt className="text-zinc-500">Cancelled</dt>
                <dd className="mt-1 text-lg font-semibold">{data.queue.cancelled}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sources</CardTitle>
            <CardDescription>Per-capability health — unavailable is never zero.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.sources.length === 0 ? (
              <p className="py-4 text-center text-sm text-zinc-500">No source health yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.sources.map((s) => (
                  <li key={`${s.sourceId}:${s.capability}`} className="rounded-lg border border-zinc-800 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-zinc-300">{s.capability}</span>
                      <Badge
                        tone={s.status === "HEALTHY" ? "success" : s.status === "DEGRADED" ? "warning" : s.status === "UNAVAILABLE" ? "muted" : "danger"}
                      >
                        {s.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-500">
                      {s.sourceId} · {s.consecutiveFailures} consecutive failures
                      {s.latencyMs !== null && ` · ${s.latencyMs}ms`}
                    </p>
                    {s.lastFailureReason && <p className="mt-1 text-xs text-red-400">{s.lastFailureReason}</p>}
                    {s.coverageNote && <p className="mt-1 text-xs text-zinc-400">{s.coverageNote}</p>}
                    <p className="mt-1 text-[11px] text-zinc-600">
                      Last success {s.lastSuccessAt ? formatRelative(s.lastSuccessAt) : "—"} · Last failure{" "}
                      {s.lastFailureAt ? formatRelative(s.lastFailureAt) : "—"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
