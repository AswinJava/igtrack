import Link from "next/link";
import { notFound } from "next/navigation";
import { getTargetById, type JobQueueSummary } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, ConfidenceBadge, CategoryBadge } from "@/components/ui/badge";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { TargetControls } from "@/components/targets/target-controls";

export const dynamic = "force-dynamic";

const TABS = ["overview", "activity", "stories", "followers", "following", "relationships", "evidence"] as const;
type Tab = (typeof TABS)[number];

function JobsPanel({ jobs }: { jobs: JobQueueSummary[] }) {
  const queuedOrWait = jobs.filter((j) => j.status === "queued" || j.status === "retry_wait");
  const latestByKind = new Map<string, JobQueueSummary>();
  for (const j of [...jobs].sort((a, b) => (b.startedAt?.getTime() ?? b.availableAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? a.availableAt?.getTime() ?? 0))) {
    if (!latestByKind.has(j.kind)) latestByKind.set(j.kind, j);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Observation loop</CardTitle>
        <CardDescription>What IGTrack attempted, what it observed, and what happens next. Synthetic fixture results are marked as such.</CardDescription>
      </CardHeader>
      <CardContent>
        {jobs.length === 0 ? (
          <p className="py-3 text-center text-sm text-zinc-500">No observations queued yet.</p>
        ) : (
          <div className="space-y-4">
            {[...latestByKind.entries()].map(([kind, j]) => (
              <div key={kind} className="rounded-lg border border-zinc-800 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-zinc-200">{kind}</span>
                  <Badge tone={j.status === "succeeded" ? "success" : j.status === "failed" ? "danger" : j.status === "retry_wait" ? "warning" : "info"}>{j.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  attempt {j.attempts}/{j.maxAttempts}
                  {j.completedAt !== null && ` · finished ${formatDateTime(j.completedAt)}`}
                  {j.availableAt !== null && (j.status === "queued" || j.status === "retry_wait") && ` · next attempt ${formatDateTime(j.availableAt)}`}
                </p>
                {j.errorMessage !== null && <p className="mt-1 break-words font-mono text-[11px] text-red-400">{j.errorMessage}</p>}
              </div>
            ))}
            {queuedOrWait.length > 0 && (
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Next: IGTrack will attempt {queuedOrWait.map((j) => j.kind).join(", ")} — retry_wait entries follow their backoff schedule; unavailable capabilities are retried honestly rather than faked.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
export default async function TargetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "overview";

  const data = await getTargetById(id);
  if (!data) notFound();

  const { target, account, snapshots, changes, health, stories, storyMentions, deltas, followFollowers, followFollowing, jobs } = data;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <Link href="/targets" className="text-xs text-zinc-500 hover:text-zinc-300">← Tracked Accounts</Link>

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800 text-lg font-semibold text-zinc-300">{account.username[0]?.toUpperCase()}</div>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">@{account.username}{account.isVerified && <span className="text-sm text-sky-400">✓ Verified</span>}<Badge tone={target.status === "ACTIVE" ? "success" : target.status === "PAUSED" ? "warning" : "muted"}>{target.status}</Badge><Badge tone="muted">SYNTHETIC SOURCE</Badge></h1>
          <p className="mt-1 text-sm text-zinc-400">{account.displayName ?? target.localName ?? "—"} · {account.bio ?? "No bio"}</p>
          <p className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
            <span>{account.isPrivate ? "Private" : "Public"} account</span>
            <span>·</span>
            <span>Last observed {formatRelative(snapshots[0]?.observedAt ?? null)}</span>
            {target.tags.length > 0 && (<><span>·</span>{target.tags.map((t) => (<span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]">{t}</span>))}</>)}
          </p>
          <div className="mt-3"><TargetControls targetId={target.id} status={target.status} localName={target.localName} notes={target.notes} tags={target.tags} /></div>
        </div>
      </div>

      <div className="mt-4 flex gap-1 overflow-x-auto border-b border-zinc-800 pb-2">
        {TABS.map((t) => (
          <Link key={t} href={`/targets/${id}?tab=${t}`} className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium capitalize ${tab === t ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"}`}>{t}</Link>
        ))}
      </div>

      <div className="mt-6">
        {tab === "overview" && (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <JobsPanel jobs={jobs} />
              <Card>
                <CardHeader>
                  <CardTitle>Profile observations</CardTitle>
                  <CardDescription>Append-only snapshots. A missing count here means the provider could not observe it — never rendered as zero.</CardDescription>
                </CardHeader>
                <CardContent>
                  {snapshots.length === 0 ? (
                    <p className="py-3 text-center text-sm text-zinc-500">No profile snapshots yet — queued observation will populate this.</p>
                  ) : (
                    <div className="space-y-2">
                      {snapshots.slice(0, 8).map((snap) => (
                        <div key={snap.id} className="rounded-lg border border-zinc-800 px-3 py-2 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-zinc-400">{formatDateTime(snap.observedAt)}</span>
                            <CategoryBadge category={snap.category} />
                            <ConfidenceBadge confidence={snap.confidence} />
                          </div>
                          <p className="mt-1 text-zinc-500">
                            followers {snap.followerCount ?? "unavailable"} · following {snap.followingCount ?? "unavailable"} · posts {snap.postCount ?? "unavailable"}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                  {changes.length > 0 && (
                    <div className="mt-4">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Derived changes</p>
                      <ul className="space-y-1">
                        {changes.slice(0, 6).map((c) => (
                          <li key={c.id} className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
                            <span className="font-medium text-zinc-300">{c.field}</span>
                            <span>{c.oldValue ?? "—"} → {c.newValue ?? "—"}</span>
                            <CategoryBadge category="DERIVED" />
                            <span className="text-zinc-600">{formatRelative(c.detectedAt)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Capability source health</CardTitle>
                  <CardDescription>Per-source honesty.</CardDescription>
                </CardHeader>
                <CardContent>
                  {health.length === 0 ? (
                    <p className="py-3 text-center text-sm text-zinc-500">No source health recorded yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {health.map((s) => (
                        <li key={`${s.sourceId}:${s.capability}`} className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2">
                          <span className="text-xs text-zinc-300">{s.capability}</span>
                          <Badge tone={s.status === "HEALTHY" ? "success" : s.status === "DEGRADED" ? "warning" : s.status === "UNAVAILABLE" ? "muted" : "danger"}>{s.status}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {tab === "activity" && (
          <Card>
            <CardHeader><CardTitle>Derived changes</CardTitle><CardDescription>Append-only profile deltas.</CardDescription></CardHeader>
            <CardContent>
              {changes.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-500">No profile changes observed yet.</p>
              ) : (
                <ul className="space-y-2">
                  {changes.map((c) => (
                    <li key={c.id} className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400">
                      <span className="font-mono text-zinc-500">{formatDateTime(c.detectedAt)}</span> · <span className="font-medium text-zinc-200">{c.field}</span> changed {c.oldValue ?? "—"} → {c.newValue ?? "—"} <CategoryBadge category="DERIVED" />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {tab === "stories" && (
          <Card>
            <CardHeader><CardTitle>Stories</CardTitle><CardDescription>Observed story existence and mention metadata.</CardDescription></CardHeader>
            <CardContent>
              {stories.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-500">No stories observed — stories are ephemeral (24h) and depend on provider capability.</p>
              ) : (
                <ul className="space-y-2">
                  {stories.map((s) => (
                    <li key={s.id} className="rounded-lg border border-zinc-800 px-3 py-2 text-xs">
                      <p className="text-zinc-300">{s.storyId} <span className="text-zinc-500">· {formatDateTime(s.takenAt)}</span></p>
                      <p className="mt-1 text-zinc-500">Sticker kinds: {s.stickerKinds.length > 0 ? s.stickerKinds.join(", ") : "none"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {tab === "followers" && (
          <Card>
            <CardHeader><CardTitle>Followers</CardTitle><CardDescription>Follower snapshots and derived deltas — partial states are honest.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {followFollowers === null ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">Follower history is unavailable from this source yet — when the provider cannot observe followers, IGTrack says so instead of showing zero.</div>
              ) : (
                <div className="rounded-lg border border-zinc-800 px-4 py-3 text-xs">
                  <p className="text-zinc-300">Snapshot {formatDateTime(followFollowers.takenAt)}</p>
                  <p className="mt-1 text-zinc-500">Completeness {followFollowers.completeness} · {followFollowers.totalObserved} observed · source {followFollowers.sourceId}</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {tab === "following" && (
          <Card>
            <CardHeader><CardTitle>Following</CardTitle><CardDescription>Following snapshots and derived deltas.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {followFollowing === null ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">Following history unavailable from this source yet.</div>
              ) : (
                <div className="rounded-lg border border-zinc-800 px-4 py-3 text-xs">
                  <p className="text-zinc-300">Snapshot: {formatDateTime(followFollowing.takenAt)}</p>
                  <p className="mt-1 text-zinc-500">Completeness {followFollowing.completeness} · {followFollowing.totalObserved} observed</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {tab === "evidence" && (
          <Card>
            <CardHeader><CardTitle>Evidence</CardTitle><CardDescription>Provenance for this target — scoped, hashes, timestamps, source.</CardDescription></CardHeader>
            <CardContent>
              <p className="text-xs text-zinc-500">All evidence for this account is reachable from the Evidence ledger. Open any row to walk claim → observation → source.</p>
              <Link href="/evidence" className="mt-2 inline-block text-sm font-medium text-sky-400 hover:underline">Open evidence ledger →</Link>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
