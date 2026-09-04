import { getActivityFeed } from "@/lib/data";
import { requirePageUser } from "@/lib/auth";
import { ACTIVITY_TYPES } from "@igtrack/database";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, CategoryBadge, ConfidenceBadge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const TYPE_LABELS: Record<string, string> = {
  PROFILE_CHANGED: "Profile changed",
  NEW_FOLLOWER: "New follower",
  LOST_FOLLOWER: "Lost follower",
  NEW_FOLLOWING: "New following",
  LOST_FOLLOWING: "Lost following",
  STORY_POSTED: "Story posted",
};

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string | string[]; q?: string }>;
}) {
  await requirePageUser();
  const params = await searchParams;
  const rawTypes = Array.isArray(params.type) ? params.type : params.type !== undefined ? [params.type] : [];
  const allowed = new Set<string>(ACTIVITY_TYPES);
  const activeTypes = rawTypes.flatMap((t) => t.split(",")).filter((t) => allowed.has(t));
  const query = (params.q ?? "").trim().slice(0, 100);
  const filtersActive = activeTypes.length > 0 || query.length > 0;
  const feed = await getActivityFeed(30, {
    ...(activeTypes.length > 0 ? { types: activeTypes } : {}),
    ...(query.length > 0 ? { query } : {}),
  });

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
      <p className="mt-1 text-sm text-zinc-500">Unified chronological feed — every event links to evidence and is typed as observed, derived, or inferred.</p>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
        <div>
          <label htmlFor="activity-type" className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">Event type</label>
          <select id="activity-type" name="type" defaultValue={activeTypes[0] ?? ""} className="mt-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-500">
            <option value="">All types</option>
            {ACTIVITY_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1">
          <label htmlFor="activity-q" className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">Account or text</label>
          <input id="activity-q" name="q" defaultValue={query} maxLength={100} placeholder="username…" autoComplete="off" className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-500" />
        </div>
        <button type="submit" className="rounded-lg bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-100 hover:bg-zinc-700">Filter</button>
        {filtersActive && (
          <a href="/activity" className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-300">Clear</a>
        )}
      </form>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>Profile changes · Follow deltas · Stories · Mentions — ordered by occurrence time.</CardDescription>
        </CardHeader>
        <CardContent>
          {feed.length === 0 ? (
            filtersActive ? (
              <p className="py-8 text-center text-sm text-zinc-500">No events match the current filters. <a href="/activity" className="font-medium text-sky-400 hover:underline">Clear filters</a> to see the full timeline.</p>
            ) : (
              <p className="py-8 text-center text-sm text-zinc-500">No activity yet. Seed data should populate this after `db:seed`.</p>
            )
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
