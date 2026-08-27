import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { JobQueueSummary } from "@igtrack/database";

export const dynamic = "force-dynamic";

function JobRow({ j }: { j: JobQueueSummary }) {
  return (
    <li className="rounded-lg border border-zinc-800 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-zinc-300">{j.kind}{j.targetUsername ? ` · @${j.targetUsername}` : " · system"}</span>
        <Badge tone={j.status === "running" ? "info" : j.status === "retry_wait" ? "warning" : "danger"}>{j.status}</Badge>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">
        attempt {j.attempts}/{j.maxAttempts}
        {j.startedAt ? ` · started ${formatRelative(j.startedAt)}` : ""}
        {j.availableAt ? ` · next attempt ${formatDateTime(j.availableAt)}` : ""}
      </p>
      {j.errorMessage !== null && <p className="mt-1 break-words font-mono text-[11px] text-red-400">{j.errorMessage}</p>}
    </li>
  );
}

export function JobList({ title, description, jobs, empty }: { title: string; description: string; jobs: JobQueueSummary[]; empty: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {jobs.length === 0 ? <p className="py-2 text-center text-sm text-zinc-500">{empty}</p> : <ul className="space-y-2">{jobs.map((j) => <JobRow key={j.id} j={j} />)}</ul>}
      </CardContent>
    </Card>
  );
}
