import Link from "next/link";
import { getDashboardData } from "@/lib/data";
import { requirePageUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatRelative, formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requirePageUser();
  const data = await getDashboardData();

  const hasData = data.trackedCount > 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500">What changed among the accounts you monitor — from real database observations.</p>
      </div>

      {!hasData ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 px-8 py-12 text-center">
          <h3 className="text-sm font-semibold text-zinc-300">No tracked accounts yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
            Synthetic seed data should be present. If this is empty, run <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs">pnpm --filter @igtrack/database db:seed</code> and refresh.
          </p>
          <Link href="/targets" className="mt-4 inline-flex rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-sky-400">
            Go to Tracked Accounts
          </Link>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="pt-5">
                <p className="text-xs font-medium tracking-widest text-zinc-500">TRACKED ACCOUNTS</p>
                <p className="mt-2 text-2xl font-semibold">{data.trackedCount}</p>
                <p className="mt-1 text-xs text-zinc-500">Active monitoring targets</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <p className="text-xs font-medium tracking-widest text-zinc-500">PROFILE SNAPSHOTS</p>
                <p className="mt-2 text-2xl font-semibold">{data.recentSnapshots}</p>
                <p className="mt-1 text-xs text-zinc-500">Append-only observations</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <p className="text-xs font-medium tracking-widest text-zinc-500">FOLLOW CHANGES</p>
                <p className="mt-2 text-2xl font-semibold">{data.followChanges}</p>
                <p className="mt-1 text-xs text-zinc-500">Derived deltas</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-5">
                <p className="text-xs font-medium tracking-widest text-zinc-500">STORIES OBSERVED</p>
                <p className="mt-2 text-2xl font-semibold">{data.storiesObserved}</p>
                <p className="mt-1 text-xs text-zinc-500">Observed, not scraped</p>
              </CardContent>
            </Card>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Recent activity</CardTitle>
                <CardDescription>Unified timeline — profile changes, follow deltas, stories. Every item links to evidence.</CardDescription>
              </CardHeader>
              <CardContent>
                {data.recentActivity.length === 0 ? (
                  <p className="py-8 text-center text-sm text-zinc-500">No activity yet.</p>
                ) : (
                  <ol className="space-y-3">
                    {data.recentActivity.map((item) => (
                      <li key={item.id} className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                        <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-zinc-200">{item.summary}</p>
                          <p className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
                            <span>{item.type}</span>
                            <span>·</span>
                            <span>{formatRelative(item.timestamp)}</span>
                            <span>·</span>
                            <span title={formatDateTime(item.timestamp)}>{formatDateTime(item.timestamp)}</span>
                          </p>
                        </div>
                        <Badge tone="muted" className="shrink-0">
                          Observed
                        </Badge>
                      </li>
                    ))}
                  </ol>
                )}
                <Link href="/activity" className="mt-4 inline-block text-sm font-medium text-sky-400 hover:underline">
                  View full activity →
                </Link>
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Source health</CardTitle>
                  <CardDescription>Capability honesty — unavailable is never shown as zero.</CardDescription>
                </CardHeader>
                <CardContent>
                  {data.sourceHealth.length === 0 ? (
                    <p className="py-4 text-center text-sm text-zinc-500">No source health yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {data.sourceHealth.slice(0, 6).map((s) => (
                        <li key={`${s.sourceId}:${s.capability}`} className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2">
                          <div>
                            <p className="text-xs font-medium text-zinc-300">{s.capability}</p>
                            <p className="text-[11px] text-zinc-500">{s.sourceId}</p>
                          </div>
                          <Badge
                            tone={
                              s.status === "HEALTHY" ? "success" : s.status === "DEGRADED" ? "warning" : s.status === "UNAVAILABLE" ? "muted" : "danger"
                            }
                          >
                            {s.status}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Link href="/diagnostics" className="mt-3 inline-block text-sm font-medium text-sky-400 hover:underline">
                    Open diagnostics →
                  </Link>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Queue</CardTitle>
                  <CardDescription>Postgres-backed jobs · FOR UPDATE SKIP LOCKED</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-3 text-xs">
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
                  </dl>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
