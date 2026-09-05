import { getDiagnostics } from "@/lib/data";
import { requirePageUser } from "@/lib/auth";
import { getCapabilityDiagnostic } from "@/lib/capability-diagnostic";
import { CAPABILITY_REGISTRY } from "@igtrack/core";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelative } from "@/lib/format";
import { JobList } from "./_jobs";

export const dynamic = "force-dynamic";

const CAPABILITY_LABELS: Record<string, string> = {
  resolveAccount: "Resolve account",
  getProfile: "Profile",
  getStories: "Stories",
  getFollowers: "Follower list",
  getFollowing: "Following list",
  getPublicPosts: "Posts",
  getPublicComments: "Comments",
};

export default async function DiagnosticsPage() {
  await requirePageUser();
  const [data, caps] = await Promise.all([getDiagnostics(), getCapabilityDiagnostic()]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Diagnostics</h1>
      <p className="mt-1 text-sm text-zinc-500">Internal operational surface — database, queue, workers, and source health. No payloads, no credentials.</p>

      {caps.fixtureInProduction && (
        <div role="alert" className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-relaxed text-amber-200">
          Production is running on the synthetic fixture source. Every observation on this deployment is
          synthetic data, not live Instagram — switch IGTRACK_PROVIDER to graph with provisioned credentials
          for live monitoring.
        </div>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Capability self-diagnostic</CardTitle>
          <CardDescription>
            What this deployment can observe and why. Provider {caps.provider}
            {caps.sourceId ? ` · source ${caps.sourceId}` : ""} ·{" "}
            {caps.production ? "production" : "non-production"} · no secrets on this surface.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-xs">
          {caps.providerError !== null && (
            <p role="alert" className="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-red-300">
              Provider misconfigured: {caps.providerError}
            </p>
          )}
          {caps.capabilities !== null ? (
            <ul className="grid gap-2 sm:grid-cols-2">
              {Object.entries(caps.capabilities).map(([name, on]) => (
                <li key={name} className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2">
                  <span className="text-zinc-300">{CAPABILITY_LABELS[name] ?? name}</span>
                  <Badge tone={on ? "success" : "muted"}>{on ? "AVAILABLE" : "UNAVAILABLE"}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-zinc-500">Capability declarations unavailable — see the provider error above.</p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
              <p className="text-zinc-500">Graph provider</p>
              <p className="mt-1 font-medium text-zinc-200">
                {caps.graph.configured
                  ? `configured · ${caps.graph.username ?? "unknown account"} · API ${caps.graph.apiVersion}`
                  : "not configured (fixture mode)"}
              </p>
            </div>
            <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
              <p className="text-zinc-500">Scan cadence</p>
              <p className="mt-1 font-medium text-zinc-200">
                story every {Math.round(caps.scheduler.intervalsMs.STORY_SCAN / 60000)}m · profile/follows/posts every{" "}
                {Math.round(caps.scheduler.intervalsMs.PROFILE_SCAN / 3600000)}h · tick {Math.round(caps.scheduler.tickMs / 1000)}s · batch {caps.scheduler.batchLimit}
              </p>
            </div>
            <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
              <p className="text-zinc-500">Worker bounds</p>
              <p className="mt-1 font-medium text-zinc-200">
                poll {caps.worker.pollMs}ms · lease {Math.round(caps.worker.leaseMs / 1000)}s with per-page heartbeat · provider timeout {Math.round(caps.worker.providerTimeoutMs / 1000)}s
              </p>
            </div>
            <div className="rounded-lg bg-zinc-800/50 px-3 py-2">
              <p className="text-zinc-500">Fixture set</p>
              <p className="mt-1 font-medium text-zinc-200">{caps.fixture ? `synthetic ${caps.fixture.version}` : "n/a (graph mode)"}</p>
            </div>
          </div>
          {caps.metrics.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-zinc-400">Provider call metrics</p>
              <ul className="space-y-1">
                {caps.metrics.map((m) => (
                  <li key={`${m.sourceId}:${m.capability}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-zinc-800/50 px-3 py-1.5 text-zinc-400">
                    <span className="font-mono">{m.capability} · {m.sourceId}</span>
                    <span>
                      {m.totalRequests} calls · {m.totalOk} ok · {m.totalErrors} errors
                      {m.totalTimeouts > 0 && ` · ${m.totalTimeouts} timeouts`}
                      {m.totalRateLimited > 0 && ` · ${m.totalRateLimited} rate-limited`}
                      {m.lastLatencyMs !== null && ` · last ${m.lastLatencyMs}ms`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>How each capability works</CardTitle>
          <CardDescription>
            Developer reference: provider method → persistence → UI for every product capability,
            with the exact reason when something is unavailable and what would unlock it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {CAPABILITY_REGISTRY.map((entry) => {
            const flags =
              caps.capabilities === null
                ? null
                : entry.providerMethods.map((m) => caps.capabilities?.[m] ?? false);
            const state =
              entry.providerMethods.length === 0
                ? ("STRUCTURAL" as const)
                : flags === null
                  ? ("UNKNOWN" as const)
                  : flags.every(Boolean)
                    ? ("AVAILABLE" as const)
                    : flags.some(Boolean)
                      ? ("PARTIAL" as const)
                      : ("UNAVAILABLE" as const);
            return (
              <details key={entry.id} className="rounded-lg border border-zinc-800 px-3 py-2">
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-zinc-200">{entry.label}</span>
                  <Badge
                    tone={
                      state === "AVAILABLE"
                        ? "success"
                        : state === "PARTIAL"
                          ? "warning"
                          : "muted"
                    }
                  >
                    {state === "STRUCTURAL" ? "UNAVAILABLE" : state}
                  </Badge>
                </summary>
                <div className="mt-2 space-y-1.5 text-zinc-400">
                  <p>{entry.howItWorks}</p>
                  <p>
                    <span className="font-medium text-zinc-300">Provider: </span>
                    {entry.providerMethods.length > 0 ? (
                      <span className="font-mono">{entry.providerMethods.join(", ")}</span>
                    ) : (
                      "no provider method exists"
                    )}{" "}
                    <span className="text-zinc-500">· {entry.permissions}</span>
                  </p>
                  {entry.persistence.length > 0 && (
                    <p>
                      <span className="font-medium text-zinc-300">Stored in: </span>
                      <span className="font-mono">{entry.persistence.join(", ")}</span>
                    </p>
                  )}
                  {entry.ui.length > 0 && <p><span className="font-medium text-zinc-300">Shown in: </span>{entry.ui.join(" · ")}</p>}
                  {entry.whyUnavailable !== null && (
                    <p className="rounded bg-amber-500/10 px-2 py-1.5 text-amber-200/90">
                      Unavailable because: {entry.whyUnavailable}
                    </p>
                  )}
                  {entry.unlock !== null && (
                    <p className="text-zinc-500">To unlock: {entry.unlock}</p>
                  )}
                  <p className="text-zinc-500">
                    <span className="font-medium text-zinc-300">Live verification: </span>
                    {entry.liveState === "LIVE_VERIFIED" ? "verified against the real provider" : entry.liveState === "NOT_VERIFIED" ? "not yet verified live" : "absent by provider design (documented)"}
                    {` — ${entry.liveEvidence}`}
                  </p>
                </div>
              </details>
            );
          })}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Database</CardTitle>
            <CardDescription>Connection, migrations, row counts.</CardDescription>
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
            {"error" in data && data.error && <p className="mt-3 break-words text-xs text-red-400">{String(data.error)}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Queue</CardTitle>
            <CardDescription>monitoring_jobs — FOR UPDATE SKIP LOCKED.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              {["Queued", data.queue.queued, "Running", data.queue.running, "Retry wait", data.queue.retryWait, "Failed", data.queue.failed, "Succeeded", data.queue.succeeded, "Cancelled", data.queue.cancelled].reduce<React.ReactNode[]>((acc, _, i, arr) => {
                if (i % 2 === 0) {
                  acc.push(
                    <div key={i} className="rounded-lg bg-zinc-800/50 px-3 py-2">
                      <dt className="text-zinc-500">{String(arr[i])}</dt>
                      <dd className="mt-1 text-lg font-semibold">{Number(arr[i + 1])}</dd>
                    </div>,
                  );
                }
                return acc;
              }, [])}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workers</CardTitle>
            <CardDescription>Derived from claim activity on monitoring_jobs.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2">
              <span className="text-zinc-500">Last claimed job start</span>
              <span className="font-medium text-zinc-200">{data.workers.lastClaimStartedAt ? formatRelative(data.workers.lastClaimStartedAt) : "never"}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2">
              <span className="text-zinc-500">Currently running</span>
              <span className="font-medium text-zinc-200">{data.workers.runningCount}</span>
            </div>
            <p className="leading-relaxed text-zinc-500">
              Paged scans heartbeat their job lease after every page; this signal is an honest derivation of recent queue claims ({data.workers.lastClaimStartedAt ? `last ${formatDateTime(data.workers.lastClaimStartedAt)}` : "none observed"}).
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Scheduler</CardTitle>
            <CardDescription>Deterministic scan tick — orchestration only, no provider logic.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2">
              <span className="text-zinc-500">Enabled</span>
              <Badge tone={data.scheduler.enabled ? "success" : "muted"}>
                {data.scheduler.enabled ? "enabled" : "disabled"}
              </Badge>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2">
              <span className="text-zinc-500">Last tick</span>
              <span className="font-medium text-zinc-200">{data.scheduler.lastTickAt ? formatRelative(data.scheduler.lastTickAt) : "never"}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2">
              <span className="text-zinc-500">Last successful tick</span>
              <span className="font-medium text-zinc-200">{data.scheduler.lastSuccessAt ? formatRelative(data.scheduler.lastSuccessAt) : "never"}</span>
            </div>
            {data.scheduler.lastError && (
              <div className="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2">
                <p className="font-medium text-red-400">Last tick failed</p>
                <p className="mt-1 break-words text-zinc-300">{data.scheduler.lastError}</p>
              </div>
            )}
            {Object.keys(data.scheduler.outcomes).length > 0 && (
              <div>
                <p className="mb-1 text-zinc-500">Job outcomes</p>
                <dl className="grid grid-cols-2 gap-2">
                  {Object.entries(data.scheduler.outcomes).map(([kind, n]) => (
                    <div key={kind} className="rounded-lg bg-zinc-800/50 px-3 py-2">
                      <dt className="text-zinc-500">{kind}</dt>
                      <dd className="mt-1 text-lg font-semibold text-zinc-200">{n}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </CardContent>
        </Card>

      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <JobList title="Running now" description="Jobs holding a claim." jobs={data.runningJobs} empty="No jobs running." />
        <JobList title="Waiting to retry" description="Backoff applied after failure." jobs={data.retryWaitJobs} empty="No jobs in retry_wait." />
        <JobList title="Terminal failures" description="Attempts exhausted or non-retryable." jobs={data.failedJobs} empty="No failed jobs." />
      </div>

      <Card className="mt-6">
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
                    <Badge tone={s.status === "HEALTHY" ? "success" : s.status === "DEGRADED" ? "warning" : s.status === "UNAVAILABLE" ? "muted" : "danger"}>{s.status}</Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-500">{s.sourceId} · {s.consecutiveFailures} consecutive failures{s.latencyMs !== null && ` · ${s.latencyMs}ms`}</p>
                  {s.lastFailureReason && <p className="mt-1 text-xs text-red-400">{s.lastFailureReason}</p>}
                  {s.coverageNote && <p className="mt-1 text-xs text-zinc-400">{s.coverageNote}</p>}
                  <p className="mt-1 text-[11px] text-zinc-600">Last success {s.lastSuccessAt ? formatRelative(s.lastSuccessAt) : "—"} · Last failure {s.lastFailureAt ? formatRelative(s.lastFailureAt) : "—"}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
