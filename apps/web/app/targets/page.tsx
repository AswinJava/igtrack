import Link from "next/link";
import { getTargets } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { formatRelative } from "@/lib/format";
import { targetSyncState, syncTone } from "@/lib/sync-state";
import { sourceBadgeForSources } from "@/lib/source-badge";
import { CreateTargetForm } from "@/components/targets/create-target-form";

export const dynamic = "force-dynamic";

export default async function TargetsPage() {
  const targets = await getTargets();

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tracked Accounts</h1>
          <p className="mt-1 text-sm text-zinc-500">Public monitoring targets — open an account to inspect its observations, history, and evidence.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-400">{targets.length} target{targets.length !== 1 ? "s" : ""}</span>
          <CreateTargetForm />
        </div>
      </div>

      {targets.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon="◎"
            title="No tracked accounts yet"
            description="Use “New target” above to track your first public account. Creation queues an initial observation; seeded demo targets come from db:seed. All data is synthetic and clearly marked."
          />
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {targets.map((t) => (
            <Link key={t.id} href={`/targets/${t.id}`} className="group">
              <Card className="h-full transition-colors group-hover:border-zinc-700">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2">@{t.username}{t.isVerified && <span className="text-sky-400" title="Verified">✓</span>}</CardTitle>
                      <CardDescription>{t.displayName ?? t.localName ?? "—"} {t.isPrivate === true ? "· Private" : t.isPrivate === false ? "· Public" : ""}</CardDescription>
                    </div>
                    <Badge tone={t.status === "ACTIVE" ? "success" : t.status === "PAUSED" ? "warning" : "muted"}>{t.status}</Badge>
                  </div>
                  {(() => {
                    const badge =
                      t.snapshotSourceId === null || t.snapshotSourceId === undefined
                        ? null
                        : sourceBadgeForSources([t.snapshotSourceId]);
                    return badge === null ? null : (
                      <p className="mt-2 text-xs" title={`Latest snapshot source: ${t.snapshotSourceId}`}>
                        <Badge tone="muted">{badge}</Badge>
                      </p>
                    );
                  })()}
                </CardHeader>
                <CardContent>
                  {(() => {
                    const sync = targetSyncState({
                      status: t.status,
                      latestJobStatus: t.latestJobStatus,
                      latestJobOutcome: t.latestJobOutcome,
                      latestJobCompletedAt: t.latestJobCompletedAt,
                      lastObserved: t.lastObserved,
                    });
                    return (
                      <p className="mb-2 text-xs text-zinc-500" title={sync.detail}>
                        <Badge tone={syncTone(sync.state)}>{sync.state}</Badge>{" "}
                        <span>{sync.detail}</span>
                      </p>
                    );
                  })()}
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-zinc-400">{t.followerCount !== null ? `${t.followerCount.toLocaleString()} followers` : "followers unavailable"}</span>
                    <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-zinc-400">{t.followingCount !== null ? `${t.followingCount.toLocaleString()} following` : "following unavailable"}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>Last observed {formatRelative(t.lastObserved)}</span>
                    {t.tags.length > 0 && (<><span>·</span><span className="flex gap-1">{t.tags.map((tag) => (<span key={tag} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]">{tag}</span>))}</span></>)}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
