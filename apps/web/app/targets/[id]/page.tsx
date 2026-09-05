import Link from "next/link";
import { notFound } from "next/navigation";
import { getTargetById, type JobQueueSummary } from "@/lib/data";
import { resolveScanIntervals, upcomingScansForTarget } from "@igtrack/database";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, ConfidenceBadge, CategoryBadge } from "@/components/ui/badge";
import { formatDateTime, formatRelative } from "@/lib/format";
import { TargetControls } from "@/components/targets/target-controls";
import { sourceBadgeForSources } from "@/lib/source-badge";
import { targetSyncState, syncTone } from "@/lib/sync-state";
import { isSafeExternalUrl } from "@/lib/external-url";

export const dynamic = "force-dynamic";

const TABS = ["overview", "activity", "stories", "highlights", "content", "followers", "following", "relationships", "evidence"] as const;
type Tab = (typeof TABS)[number];

// Visibility classifications describe synthetic fixture geometry and flags —
// never proof that anyone intentionally hid a mention.
const VISIBILITY_LABELS: Record<string, string> = {
  VISIBLE: "Visible",
  POSSIBLY_HIDDEN: "Possibly hidden",
  OFF_CANVAS: "Off canvas",
  METADATA_ONLY: "Metadata only",
  UNKNOWN: "Unknown",
};

const FOLLOW_CHANGE_LABELS: Record<string, string> = {
  NEW_FOLLOWER: "Newly observed follower",
  LOST_FOLLOWER: "No longer observed follower",
  NEW_FOLLOWING: "Newly observed following",
  LOST_FOLLOWING: "No longer observed following",
};

// Latest job per scan kind, for honest scan-state banners (partial listings,
// unavailable capabilities, queued scans).
function latestJobForKind(jobs: JobQueueSummary[], kind: string): JobQueueSummary | null {
  const ranked = jobs
    .filter((j) => j.kind === kind)
    .sort(
      (a, b) =>
        (b.completedAt?.getTime() ?? b.startedAt?.getTime() ?? b.availableAt?.getTime() ?? 0) -
        (a.completedAt?.getTime() ?? a.startedAt?.getTime() ?? a.availableAt?.getTime() ?? 0),
    );
  return ranked[0] ?? null;
}

function ScanStateBanner({ job, noun }: { job: JobQueueSummary | null; noun: string }) {
  if (job === null) {
    return (
      <p className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
        {noun} not yet scanned — the observation is queued and will appear here.
      </p>
    );
  }
  if (job.outcome === "COMPLETED_PARTIAL") {
    return (
      <p className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
        Partial {noun.toLowerCase()} listing — the provider holds more pages. The next scan resumes from the
        checkpoint; what is shown is complete for the pages observed so far.
      </p>
    );
  }
  if (job.outcome === "UNAVAILABLE") {
    return (
      <p className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
        {noun} unavailable from this source — shown as unavailable, never zero. What remains available is shown on
        the other tabs; per-capability health is under Observation loop.
      </p>
    );
  }
  return null;
}

function storyJson(value: unknown): Record<string, unknown> | null {
  // Drizzle surfaces jsonb columns as unknown: narrow at render time instead
  // of casting blindly, so malformed stored JSON renders nothing, never junk.
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function storyJsonString(value: unknown, key: string): string | null {
  const record = storyJson(value);
  const v = record?.[key];
  return typeof v === "string" ? v : null;
}

function storyJsonStringArray(value: unknown, key: string): string[] {
  const record = storyJson(value);
  const v = record?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function storyJsonNumber(value: unknown, key: string): number | null {
  const record = storyJson(value);
  const v = record?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function postTypeLabel(p: { mediaType?: string | null; mediaProductType?: string | null }): string {
  // Provider-declared typing only. REELS product type means Reel even when
  // the base media type is VIDEO; absent typing renders as untyped Post.
  if (p.mediaProductType === "REELS") return "Reel";
  if (p.mediaType === "CAROUSEL") return "Carousel";
  if (p.mediaType === "VIDEO") return "Video";
  if (p.mediaType === "IMAGE") return "Image";
  return "Post";
}

function commentStateCopy(state: string | null, count: number): string {
  if (state === "OBSERVED") {
    return count > 0
      ? `${count} publicly exposed comment${count === 1 ? "" : "s"} observed.`
      : "Comment source read — no comments exposed on this post.";
  }
  if (state === "UNAVAILABLE") return "Comments not available for this post — no exposed comment source.";
  if (state === "NOT_SCANNED") return "Comments not yet scanned for this post.";
  return "Comment state unknown — recorded before per-post comment tracking.";
}

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
                  {j.outcome !== null && ` · outcome ${j.outcome}`}
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

  const { target, account, snapshots, changes, health, stories, storyMentions, storySightings, posts, postComments, postChildren, deltas, followFollowers, followFollowing, followFollowerRoster, followFollowingRoster, jobs } = data;

  const mentionsByStory = new Map(storyMentions.map((sm) => [sm.storyId, sm.mentions]));
  const commentsByPost = new Map(postComments.map((pc) => [pc.postId, pc.comments]));
  const childrenByPost = new Map(postChildren.map((pc) => [pc.postId, pc.children]));
  const followerDeltas = deltas.filter((d) => d.direction === "FOLLOWERS");
  const followingDeltas = deltas.filter((d) => d.direction === "FOLLOWING");
  const mentionCount = storyMentions.reduce((n, sm) => n + sm.mentions.length, 0);
  const mentionedUsers = new Set(storyMentions.flatMap((sm) => sm.mentions.map((m) => m.username))).size;

  // Source badge is derived from actually observed source ids — never
  // hardcoded. Fixture ids look like "fixture:v1", graph ids like "graph:v1".
  const observedSources = new Set<string>();
  for (const s of snapshots) if (s.sourceId) observedSources.add(s.sourceId);
  for (const s of stories) if (s.sourceId) observedSources.add(s.sourceId);
  for (const p of posts) if (p.sourceId) observedSources.add(p.sourceId);
  for (const h of health) if (h.sourceId) observedSources.add(h.sourceId);
  if (followFollowers?.sourceId) observedSources.add(followFollowers.sourceId);
  if (followFollowing?.sourceId) observedSources.add(followFollowing.sourceId);
  const sourceBadge = sourceBadgeForSources(observedSources);
  const latestJob = jobs[0] ?? null;
  const sync = targetSyncState({
    status: target.status,
    latestJobStatus: latestJob?.status ?? null,
    latestJobOutcome: latestJob?.outcome ?? null,
    latestJobCompletedAt: latestJob?.completedAt ?? null,
    lastObserved: snapshots[0]?.observedAt ?? null,
  });
  // Forecast with the exact inputs the scheduler tick uses, so "next scans"
  // always agree with what the worker will enqueue. Paused targets show no
  // forecast — nothing will be scheduled until resume.
  const upcomingScans =
    target.status === "ACTIVE"
      ? upcomingScansForTarget(
          target.id,
          { scanCadenceMult: target.scanCadenceMult, scanKinds: target.scanKinds },
          Date.now(),
          resolveScanIntervals(process.env),
        )
      : [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <Link href="/targets" className="text-xs text-zinc-500 hover:text-zinc-300">← Tracked Accounts</Link>

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800 text-lg font-semibold text-zinc-300">{account.username[0]?.toUpperCase()}</div>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">@{account.username}{account.isVerified && <span className="text-sm text-sky-400">✓ Verified</span>}<Badge tone={target.status === "ACTIVE" ? "success" : target.status === "PAUSED" ? "warning" : "muted"}>{target.status}</Badge>{sourceBadge !== null && <Badge tone="muted">{sourceBadge}</Badge>}</h1>
          <p className="mt-1 text-sm text-zinc-400">{account.displayName ?? target.localName ?? "—"} · {account.bio ?? "No bio"}</p>
          {account.externalUrl && isSafeExternalUrl(account.externalUrl) && (
            <p className="mt-1 text-xs text-zinc-500">
              Provider link:{" "}
              <a href={account.externalUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-sky-400 hover:underline">
                {account.externalUrl}
              </a>{" "}
              <span className="text-zinc-600">(opens externally)</span>
            </p>
          )}
          {account.profilePicUrl && isSafeExternalUrl(account.profilePicUrl) && (
            <p className="mt-1 text-xs text-zinc-500">
              Provider avatar:{" "}
              <a href={account.profilePicUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-sky-400 hover:underline">
                open image
              </a>{" "}
              <span className="text-zinc-600">(opens externally — never auto-loaded)</span>
            </p>
          )}
          <p className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
            <span>{account.isPrivate ? "Private" : "Public"} account</span>
            <span>·</span>
            <span>Last observed {formatRelative(snapshots[0]?.observedAt ?? null)}</span>
            <span>·</span>
            <span title={sync.detail}>
              <Badge tone={syncTone(sync.state)}>{sync.state}</Badge>
            </span>
            {target.tags.length > 0 && (<><span>·</span>{target.tags.map((t) => (<span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]">{t}</span>))}</>)}
          </p>
          <div className="mt-3"><TargetControls targetId={target.id} status={target.status} localName={target.localName} notes={target.notes} tags={target.tags} scanCadenceMult={target.scanCadenceMult} scanKinds={target.scanKinds} upcomingScans={upcomingScans} /></div>
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
                      <p className="text-[11px] text-zinc-600">Showing first {Math.min(8, snapshots.length)} of {snapshots.length} recent snapshots.</p>
                      {snapshots.slice(0, 8).map((snap) => (
                        <div key={snap.id} className="rounded-lg border border-zinc-800 px-3 py-2 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-zinc-400">{formatDateTime(snap.observedAt)}</span>
                            <CategoryBadge category={snap.category} />
                            <ConfidenceBadge confidence={snap.confidence} />
                          </div>
                          <p className="mt-1 text-zinc-500">
                            followers {snap.followerCount ?? "unavailable"} · following {snap.followingCount ?? "unavailable"} · posts {snap.postCount ?? "unavailable"}
                            {snap.evidenceId !== null && (
                              <>{` · `}<Link href={`/evidence/${snap.evidenceId}`} className="font-medium text-sky-400 hover:underline">Evidence →</Link></>
                            )}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                  {changes.length > 0 && (
                    <div className="mt-4">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Derived changes · first {Math.min(6, changes.length)} of {changes.length} — full history on the Activity tab</p>
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
              <CardHeader><CardTitle>Stories</CardTitle><CardDescription>Observed story existence and mention metadata · first {Math.min(10, stories.length)} of up to 10 recent.</CardDescription></CardHeader>
            <CardContent>
              <p className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">Viewing here reads IGTrack&apos;s stored observations — it does not place a view under your identity on Instagram. Anonymity against Instagram itself cannot be guaranteed for any live provider; the active fixture source makes no network calls.</p>
              <ScanStateBanner job={latestJobForKind(jobs, "STORY_SCAN")} noun="Stories" />
              {stories.length === 0 ? (
                latestJobForKind(jobs, "STORY_SCAN")?.status === "succeeded" ? (
                  <p className="py-6 text-center text-sm text-zinc-500">No active stories right now — previously observed stories have expired (24h lifetime) or none are live. Past observations stay in history and evidence.</p>
                ) : (
                  <p className="py-6 text-center text-sm text-zinc-500">No stories observed yet — the STORY_SCAN observation is queued. Stories are ephemeral (24h) and depend on provider capability.</p>
                )
              ) : (
                <ul className="space-y-2">
                  {stories.map((s) => {
                    const mentions = mentionsByStory.get(s.storyId) ?? [];
                    const sighting = storySightings[s.id];
                    return (
                      <li key={s.id} className="rounded-lg border border-zinc-800 px-3 py-2 text-xs">
                        <p className="text-zinc-300">{s.storyId} <span className="text-zinc-500">· {formatDateTime(s.takenAt)}{s.expiresAt ? ` · expires ${formatDateTime(s.expiresAt)}` : ""}</span>{" "}
                          {s.expiresAt ? (
                            s.expiresAt.getTime() < Date.now() ? (
                              <Badge tone="muted">EXPIRED</Badge>
                            ) : (
                              <Badge tone="success">ACTIVE</Badge>
                            )
                          ) : null}
                          {s.evidenceId !== null && (
                            <Link href={`/evidence/${s.evidenceId}`} className="ml-1 font-medium text-sky-400 hover:underline">Evidence →</Link>
                          )}
                        </p>
                        {sighting !== undefined && sighting.count > 1 && (
                          <p className="mt-1 text-zinc-600">
                            Observed {sighting.count}× · first seen {sighting.firstSeenAt ? formatDateTime(sighting.firstSeenAt) : "—"} · last seen {sighting.lastSeenAt ? formatDateTime(sighting.lastSeenAt) : "—"}
                          </p>
                        )}
                        <p className="mt-1 text-zinc-500">
                          Type {s.mediaType}{s.durationMs ? ` · ${Math.round(s.durationMs / 1000)}s` : ""} · Stickers: {s.stickerKinds.length > 0 ? s.stickerKinds.join(", ") : "none"}{s.hasLink ? " · has link" : ""}
                        </p>
                        {s.caption && <p className="mt-1 text-zinc-400">{s.caption}</p>}
                        {s.linkUrl && isSafeExternalUrl(s.linkUrl) && (
                          <p className="mt-1 text-zinc-500">
                            Link:{" "}
                            <a href={s.linkUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-sky-400 hover:underline">
                              {s.linkUrl}
                            </a>{" "}
                            <span className="text-zinc-600">(provider-supplied URL, opens externally)</span>
                          </p>
                        )}
                        {storyJsonString(s.location, "name") && (
                          <p className="mt-1 text-zinc-500">
                            Location: {storyJsonString(s.location, "name")}
                            {storyJsonNumber(s.location, "lat") !== null && storyJsonNumber(s.location, "lng") !== null
                              ? ` (${storyJsonNumber(s.location, "lat")}, ${storyJsonNumber(s.location, "lng")})`
                              : ""}
                          </p>
                        )}
                        {storyJson(s.music) && (
                          <p className="mt-1 text-zinc-500">
                            Music: {storyJsonString(s.music, "title") ?? "untitled"}
                            {storyJsonString(s.music, "artist") ? ` — ${storyJsonString(s.music, "artist")}` : ""}
                          </p>
                        )}
                        {storyJson(s.poll) && (
                          <p className="mt-1 text-zinc-500">
                            Poll: {storyJsonString(s.poll, "question") ?? "untitled"}
                            {storyJsonStringArray(s.poll, "options").length > 0 ? ` (${storyJsonStringArray(s.poll, "options").join(" / ")})` : ""}
                          </p>
                        )}
                        {storyJsonString(s.question, "question") && <p className="mt-1 text-zinc-500">Question: {storyJsonString(s.question, "question")}</p>}
                        {mentions.length === 0 ? (
                          <p className="mt-1 text-zinc-600">No mentions observed in this story.</p>
                        ) : (
                          <ul className="mt-2 space-y-1">
                            {mentions.map((m) => {
                              const geometry =
                                m.positionX !== null && m.positionY !== null
                                  ? `position (${m.positionX}, ${m.positionY})` +
                                    (m.width !== null && m.height !== null ? ` size ${m.width}×${m.height}` : "") +
                                    (m.mentionedIgId ? ` · platform id ${m.mentionedIgId}` : "")
                                  : (m.mentionedIgId ? `platform id ${m.mentionedIgId}` : null);
                              return (
                              <li key={m.id} className="flex flex-wrap items-center gap-1.5 rounded bg-zinc-800/50 px-2 py-1.5 text-zinc-400">
                                <span
                                  className="font-medium text-zinc-200"
                                  title={geometry ?? "no positional metadata exposed by provider"}
                                >@{m.username}</span>
                                <span className="text-zinc-500">· Visibility classification: {VISIBILITY_LABELS[m.visibilityClass] ?? m.visibilityClass}</span>
                                <ConfidenceBadge confidence={m.confidence} />
                                <span className="text-zinc-600">{formatDateTime(m.observedAt)}</span>
                                {m.evidenceId !== null && (
                                  <Link href={`/evidence/${m.evidenceId}`} className="font-medium text-sky-400 hover:underline">Evidence →</Link>
                                )}
                              </li>
                              );
                            })}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">Visibility classifications describe synthetic fixture geometry and flags — not proof that anyone intentionally hid a mention.</p>
            </CardContent>
          </Card>
        )}

        {tab === "highlights" && (
          <Card>
            <CardHeader><CardTitle>Highlights</CardTitle><CardDescription>Public story highlights for this account.</CardDescription></CardHeader>
            <CardContent>
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-amber-200">Highlights are unavailable — the configured provider exposes no highlight capability, so IGTrack shows UNAVAILABLE instead of an empty list.</div>
              <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">UNAVAILABLE is not the same as “no highlights”. It means the data source cannot answer the question.</p>
            </CardContent>
          </Card>
        )}

        {tab === "content" && (
          <Card>
              <CardHeader><CardTitle>Posts · Reels · Reposts</CardTitle><CardDescription>Observed public posts and their publicly exposed comments · first {Math.min(10, posts.length)} of up to 10 recent.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <ScanStateBanner job={latestJobForKind(jobs, "POSTS_SCAN")} noun="Posts" />
              {posts.length > postComments.length && (
                <p className="mb-3 text-[11px] leading-relaxed text-zinc-600">Comments shown for the {postComments.length} most recent posts; older posts keep their own comment state on their rows.</p>
              )}
              {posts.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-500">No posts observed yet — the POSTS_SCAN observation will populate this. A post with no exposed comment source stays comment-less; that gap is reported, never filled.</p>
              ) : (
                <ul className="space-y-2">
                  {posts.map((p) => {
                    const comments = commentsByPost.get(p.postId) ?? [];
                    const children = childrenByPost.get(p.postId) ?? [];
                    return (
                      <li key={p.id} className="rounded-lg border border-zinc-800 px-3 py-2 text-xs">
                        <p className="text-zinc-300">{postTypeLabel(p)} · {p.postId}{p.shortcode ? ` · /p/${p.shortcode}/` : ""}{p.permalink && isSafeExternalUrl(p.permalink) ? (<>{` · `}<a href={p.permalink} target="_blank" rel="noreferrer noopener" className="font-medium text-sky-400 hover:underline">Open on Instagram</a></>) : null} <span className="text-zinc-500">· {formatDateTime(p.takenAt)}</span></p>
                        {p.caption && <p className="mt-1 text-zinc-400">{p.caption}</p>}
                        {children.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {children.map((ch) => (
                              <li key={ch.id} className="rounded bg-zinc-800/50 px-2 py-1 text-zinc-400">
                                <span className="font-medium text-zinc-200">{ch.mediaType ?? "Untyped"} item · {ch.childMediaId}</span>
                                {ch.shortcode ? <span className="text-zinc-500">{` · /p/${ch.shortcode}/`}</span> : null}
                                {ch.permalink && isSafeExternalUrl(ch.permalink) ? (<>{` · `}<a href={ch.permalink} target="_blank" rel="noreferrer noopener" className="font-medium text-sky-400 hover:underline">Open item</a></>) : null}
                                {ch.takenAt !== null && <span className="text-zinc-500"> · {formatDateTime(ch.takenAt)}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="mt-1 text-zinc-500">
                          likes {p.likeCount ?? "unavailable"} · comments {p.commentCount ?? comments.length} · observed {formatRelative(p.observedAt)}
                          {p.evidenceId !== null && (
                            <>{` · `}<Link href={`/evidence/${p.evidenceId}`} className="font-medium text-sky-400 hover:underline">Evidence →</Link></>
                          )}
                        </p>
                        <p className="mt-1 text-zinc-600">{commentStateCopy(p.commentsState, comments.length)}</p>
                        {comments.length === 0 ? null : (
                          <ul className="mt-2 space-y-1">
                            {comments.map((c) => (
                              <li key={c.id} className="rounded bg-zinc-800/50 px-2 py-1.5 text-zinc-400">
                                {c.username === "unknown" ? (
                                  <span className="text-zinc-500">unknown author (provider exposed no username)</span>
                                ) : (
                                  <span className="font-medium text-zinc-200">@{c.username}</span>
                                )}
                                {c.replyToUsername ? (
                                  <span className="text-zinc-500"> replies to @{c.replyToUsername}</span>
                                ) : c.inReplyToCommentId ? (
                                  <span className="text-zinc-500"> · reply</span>
                                ) : null}
                                <span className="text-zinc-500"> · {formatDateTime(c.commentedAt)}</span>
                                {c.likeCount !== null && (
                                  <span className="text-zinc-500"> · {c.likeCount} like{c.likeCount === 1 ? "" : "s"} (provider metadata)</span>
                                )}
                                {c.evidenceId !== null && (
                                  <>{` · `}<Link href={`/evidence/${c.evidenceId}`} className="font-medium text-sky-400 hover:underline">Evidence →</Link></>
                                )}
                                <p className="mt-0.5 text-zinc-300">{c.body === "" ? "(text not exposed by provider)" : c.body}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-[11px] leading-relaxed text-zinc-600">Reels and carousels carry a type label only when the provider declares it — untyped items render as Post, never inferred from appearance. Reposts appear only where the source explicitly identifies them. Instagram exposes no public likes feed — like counts shown are provider-supplied post metadata, never observed like activity.</p>
            </CardContent>
          </Card>
        )}

        {tab === "followers" && (
          <Card>
            <CardHeader><CardTitle>Followers</CardTitle><CardDescription>Follower snapshots and derived deltas — partial states are honest.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {followFollowers === null ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">Follower history is unavailable from this source yet — when the provider cannot observe followers, IGTrack says so instead of showing zero. Follower counts (when observed) remain on Overview; per-capability health is in the observation loop.</div>
              ) : (
                <div className="rounded-lg border border-zinc-800 px-4 py-3 text-xs">
                  <p className="text-zinc-300">Snapshot {formatDateTime(followFollowers.takenAt)}</p>
                  <p className="mt-1 text-zinc-500">Completeness {followFollowers.completeness} · {followFollowers.totalObserved} observed · source {followFollowers.sourceId} · Last observed {formatRelative(followFollowers.takenAt)}</p>
                  {followFollowerRoster !== null && followFollowerRoster.usernames.length > 0 && (
                    <p className="mt-2 leading-relaxed text-zinc-400">
                      Observed members:{" "}
                      {followFollowerRoster.usernames.map((u, i) => (
                        <span key={u}>
                          {i > 0 && ", "}
                          <Link href={`/lookup?username=${encodeURIComponent(u)}`} className="font-medium text-sky-400 hover:underline" title={`Preview @${u} without tracking`}>
                            @{u}
                          </Link>
                        </span>
                      ))}
                      {followFollowerRoster.totalObserved > followFollowerRoster.usernames.length &&
                        ` (+${followFollowerRoster.totalObserved - followFollowerRoster.usernames.length} more — see deltas and evidence for the full change record)`}
                    </p>
                  )}
                </div>
              )}
              {followFollowers !== null && (
                followerDeltas.length === 0 ? (
                  <p className="py-3 text-center text-xs text-zinc-500">No follower changes derived yet — changes need two COMPLETE snapshots; partial scans are recorded but never diffed.</p>
                ) : (
                  <ul className="space-y-2">
                    {followerDeltas.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400">
                        <span className="font-medium text-zinc-200">{FOLLOW_CHANGE_LABELS[d.change] ?? d.change}</span>
                        <span>@{d.username}</span>
                        <CategoryBadge category="DERIVED" />
                        <span className="text-zinc-600">first observed {formatDateTime(d.firstSeenAt)}</span>
                        {d.toEvidenceId !== null && (
                          <Link href={`/evidence/${d.toEvidenceId}`} className="font-medium text-sky-400 hover:underline">Evidence →</Link>
                        )}
                      </li>
                    ))}
                  </ul>
                )
              )}
            </CardContent>
          </Card>
        )}

        {tab === "following" && (
          <Card>
            <CardHeader><CardTitle>Following</CardTitle><CardDescription>Following snapshots and derived deltas.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {followFollowing === null ? (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">Following history is unavailable from this source yet — the provider exposes no following list, so IGTrack shows unavailable instead of zero. Following counts (when observed) remain on Overview.</div>
              ) : (
                <div className="rounded-lg border border-zinc-800 px-4 py-3 text-xs">
                  <p className="text-zinc-300">Snapshot: {formatDateTime(followFollowing.takenAt)}</p>
                  <p className="mt-1 text-zinc-500">Completeness {followFollowing.completeness} · {followFollowing.totalObserved} observed · Last observed {formatRelative(followFollowing.takenAt)}</p>
                  {followFollowingRoster !== null && followFollowingRoster.usernames.length > 0 && (
                    <p className="mt-2 leading-relaxed text-zinc-400">
                      Observed members:{" "}
                      {followFollowingRoster.usernames.map((u, i) => (
                        <span key={u}>
                          {i > 0 && ", "}
                          <Link href={`/lookup?username=${encodeURIComponent(u)}`} className="font-medium text-sky-400 hover:underline" title={`Preview @${u} without tracking`}>
                            @{u}
                          </Link>
                        </span>
                      ))}
                      {followFollowingRoster.totalObserved > followFollowingRoster.usernames.length &&
                        ` (+${followFollowingRoster.totalObserved - followFollowingRoster.usernames.length} more — see deltas and evidence for the full change record)`}
                    </p>
                  )}
                </div>
              )}
              {followFollowing !== null && (
                followingDeltas.length === 0 ? (
                  <p className="py-3 text-center text-xs text-zinc-500">No following changes derived yet — changes need two COMPLETE snapshots; partial scans are recorded but never diffed.</p>
                ) : (
                  <ul className="space-y-2">
                    {followingDeltas.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400">
                        <span className="font-medium text-zinc-200">{FOLLOW_CHANGE_LABELS[d.change] ?? d.change}</span>
                        <span>@{d.username}</span>
                        <CategoryBadge category="DERIVED" />
                        <span className="text-zinc-600">first observed {formatDateTime(d.firstSeenAt)}</span>
                        {d.toEvidenceId !== null && (
                          <Link href={`/evidence/${d.toEvidenceId}`} className="font-medium text-sky-400 hover:underline">Evidence →</Link>
                        )}
                      </li>
                    ))}
                  </ul>
                )
              )}
            </CardContent>
          </Card>
        )}

        {tab === "relationships" && (
          <Card>
            <CardHeader><CardTitle>Relationship signals</CardTitle><CardDescription>Observed signals for this target — mention observations and follow changes.</CardDescription></CardHeader>
            <CardContent>
              {mentionCount === 0 && deltas.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-500">Not enough signals yet — story mentions and follow changes will appear here once observed.</p>
              ) : (
                <div className="space-y-2 text-xs">
                    <p className="rounded-lg border border-zinc-800 px-3 py-2 text-zinc-400">
                      <span className="font-medium text-zinc-200">{mentionCount}</span> mention observations across <span className="font-medium text-zinc-200">{storyMentions.length}</span> stor{storyMentions.length === 1 ? "y" : "ies"} (first {storyMentions.length} recent) · <span className="font-medium text-zinc-200">{mentionedUsers}</span> distinct mentioned accounts · <span className="font-medium text-zinc-200">{deltas.length}</span> follow changes
                    </p>
                  <p className="rounded-lg bg-zinc-800/50 px-3 py-2 text-zinc-500">These are raw observed counts, not a ranking. The ranked heuristic view lives on the Relationships page.</p>
                  <Link href="/relationships" className="inline-block text-sm font-medium text-sky-400 hover:underline">Open Relationships →</Link>
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
