import { getActivityFeed } from "@/lib/data";
import { requirePageUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, CategoryBadge, ConfidenceBadge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  await requirePageUser();
  const feed = await getActivityFeed(30);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
      <p className="mt-1 text-sm text-zinc-500">Unified chronological feed — every event links to evidence and is typed as observed, derived, or inferred.</p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>Profile changes · Follow deltas · Stories · Mentions — ordered by occurrence time.</CardDescription>
        </CardHeader>
        <CardContent>
          {feed.length === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">No activity yet. Seed data should populate this after `db:seed`.</p>
          ) : (
            <ol className="relative space-y-3 border-l border-zinc-800 pl-6">
              {feed.map((item) => (
                <li key={item.id} className="relative">
                  <span className="absolute -left-[25px] top-1 h-2 w-2 rounded-full bg-sky-500" />
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-200">
                      {item.summary}
                      <Badge tone="muted" className="text-[11px]">
                        {item.type}
                      </Badge>
                      {item.category !== null ? (
                        <CategoryBadge category={item.category as "OBSERVED" | "DERIVED" | "INFERRED" | "UNAVAILABLE"} />
                      ) : null}
                      {item.confidence !== null ? (
                        <ConfidenceBadge confidence={item.confidence as "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"} />
                      ) : null}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {item.targetUsername} · {formatDateTime(item.timestamp)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
