import Link from "next/link";
import { getTargets } from "@/lib/data";
import { requirePageUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TargetsPage() {
  await requirePageUser();
  const targets = await getTargets();

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tracked Accounts</h1>
          <p className="mt-1 text-sm text-zinc-500">Public monitoring targets — every observation links to evidence.</p>
        </div>
        <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-400">{targets.length} target{targets.length !== 1 ? "s" : ""}</span>
      </div>

      {targets.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon="◎"
            title="No tracked accounts"
            description="Seed data should create target_a. Run pnpm --filter @igtrack/database db:seed and refresh. All data is synthetic and clearly marked."
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
                      <CardTitle className="flex items-center gap-2">
                        @{t.username}
                        {t.isVerified && <span className="text-sky-400" title="Verified">✓</span>}
                      </CardTitle>
                      <CardDescription>
                        {t.displayName ?? t.localName ?? "—"} {t.isPrivate ? "· Private" : "· Public"}
                      </CardDescription>
                    </div>
                    <Badge tone={t.status === "ACTIVE" ? "success" : t.status === "PAUSED" ? "warning" : "muted"}>{t.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-zinc-400">
                      {t.followerCount !== null ? `${t.followerCount.toLocaleString()} followers` : "followers —"}
                    </span>
                    <span className="rounded-full bg-zinc-800 px-2.5 py-1 text-zinc-400">
                      {t.followingCount !== null ? `${t.followingCount.toLocaleString()} following` : "following —"}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <span>Last observed {formatRelative(t.lastObserved)}</span>
                    {t.tags.length > 0 && (
                      <>
                        <span>·</span>
                        <span className="flex gap-1">
                          {t.tags.map((tag) => (
                            <span key={tag} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]">
                              {tag}
                            </span>
                          ))}
                        </span>
                      </>
                    )}
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
