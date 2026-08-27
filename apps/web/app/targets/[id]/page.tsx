import Link from "next/link";
import { notFound } from "next/navigation";
import { getTargetById, getEvidenceList } from "@/lib/data";
import { requirePageUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, ConfidenceBadge, CategoryBadge, CapabilityBadge } from "@/components/ui/badge";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";

export const dynamic = "force-dynamic";

const TABS = ["overview", "activity", "stories", "followers", "following", "relationships", "evidence"] as const;
type Tab = (typeof TABS)[number];

export default async function TargetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await requirePageUser();
  const { id } = await params;
  const { tab: rawTab } = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "overview";

  const data = await getTargetById(id);
  if (!data) notFound();

  const { target, account, snapshots, changes, health, stories, storyMentions, deltas } = data;

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <Link href="/targets" className="text-xs text-zinc-500 hover:text-zinc-300">
        ← Tracked Accounts
      </Link>

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800 text-lg font-semibold text-zinc-300">
          {account.username[0]?.toUpperCase()}
        </div>
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            @{account.username}
            {account.isVerified && <span className="text-sky-400 text-sm">✓ Verified</span>}
            <Badge tone={target.status === "ACTIVE" ? "success" : "warning"}>{target.status}</Badge>
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {account.displayName ?? target.localName ?? "—"} · {account.bio ?? "No bio"} ·{" "}
            <span className="font-mono text-xs">{account.externalUrl ?? ""}</span>
          </p>
          <p className="mt-1 flex flex-wrap gap-2 text-xs text-zinc-500">
            <span>{account.isPrivate ? "Private" : "Public"} account</span>
            <span>·</span>
            <span>Last observed {formatRelative(snapshots[0]?.observedAt ?? null)}</span>
            {target.tags.length > 0 && (
              <>
                <span>·</span>
                {target.tags.map((t) => (
                  <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px]">
                    {t}
                  </span>
                ))}
              </>
            )}
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-1 overflow-x-auto border-b border-zinc-800 pb-2">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/targets/${id}?tab=${t}`}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium capitalize ${
              tab === t ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
            }`}
          >
            {t}
          </Link>
        ))}
      </div>

      <div className="mt-6">
        {tab === "overview" && (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>Profile timeline</CardTitle>
                  <CardDescription>Append-only snapshots — historical truth survives current-state changes.</CardDescription>
                </CardHeader>
                <CardContent>
                  {changes.length === 0 ? (
                    <p className="py-6 text-center text-sm text-zinc-500">
                      {snapshots.length <= 1 ? "Not enough snapshots to derive changes yet." : "No field changes detected."}
                    </p>
                  ) : (
                    <ol className="space-y-2">
                      {changes.map((c) => (
                        <li key={c.id} className="flex gap-3 rounded-lg border border-zinc-800 px-4 py-3">
                          <span className="mt-1 h-2 w-2 rounded-full bg-amber-500" />
                          <div className="flex-1">
                            <p className="text-sm text-zinc-200">
                              <span className="font-medium">{c.field}</span> changed
                            </p>
                            <p className="mt-1 font-mono text-xs text-zinc-500">
                              <span className="line-through">{c.oldValue ?? "∅"}</span> → {c.newValue ?? "∅"}
                            </p>
                            <p className="mt-1 text-xs text-zinc-500">{formatDateTime(c.detectedAt)}</p>
                          </div>
                          <CategoryBadge category="DERIVED" />
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Recent stories</CardTitle>
                  <CardDescription>Observed stories — evidence-linked, never scraped beyond public surface.</CardDescription>
                </CardHeader>
                <CardContent>
                  {stories.length === 0 ? (
                    <p className="py-6 text-center text-sm text-zinc-500">No stories observed yet.</p>
                  ) : (
                    <ul className="space-y-3">
                      {stories.slice(0, 3).map((s) => (
                        <li key={s.id} className="rounded-lg border border-zinc-800 px-4 py-3">
                          <p className="flex items-center gap-2 text-sm text-zinc-200">
                            {s.storyId} <Badge tone="info">{s.mediaType}</Badge> {s.hasLink && <Badge tone="muted">link</Badge>}
                          </p>
                          <p className="mt-1 text-xs text-zinc-500">
                            Taken {formatDateTime(s.takenAt)} · Observed {formatRelative(s.observedAt)} · <CategoryBadge category={s.category} />{" "}
                            <ConfidenceBadge confidence={s.confidence} />
                          </p>
                          {s.caption && <p className="mt-2 text-sm text-zinc-400">“{s.caption}”</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Follow deltas</CardTitle>
                  <CardDescription>Derived from normalized snapshot members.</CardDescription>
                </CardHeader>
                <CardContent>
                  {deltas.length === 0 ? (
                    <p className="py-6 text-center text-sm text-zinc-500">No follow changes yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {deltas.slice(0, 6).map((d) => (
                        <li key={d.id} className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2">
                          <div>
                            <p className="text-xs font-medium text-zinc-300">{d.username}</p>
                            <p className="text-[11px] text-zinc-500">{formatRelative(d.firstSeenAt)}</p>
                          </div>
                          <Badge tone={d.change.startsWith("NEW") ? "success" : "danger"}>{d.change.replace(/_/g, " ")}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Source health</CardTitle>
                  <CardDescription>Capability honesty — unavailable is never zero.</CardDescription>
                </CardHeader>
                <CardContent>
                  {health.length === 0 ? (
                    <p className="py-4 text-center text-sm text-zinc-500">No health data.</p>
                  ) : (
                    <ul className="space-y-2">
                      {health.map((h) => (
                        <li key={`${h.sourceId}:${h.capability}`} className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2">
                          <span className="text-xs text-zinc-300">{h.capability}</span>
                          <CapabilityBadge state={h.status as any} />
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
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription>Chronological feed for this target.</CardDescription>
            </CardHeader>
            <CardContent>
              {changes.length === 0 && deltas.length === 0 && stories.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500">No activity yet.</p>
              ) : (
                <ol className="space-y-2">
                  {[...changes.map((c) => ({ id: c.id, ts: c.detectedAt, label: `${c.field} changed`, kind: "PROFILE_CHANGED" as const })),
                    ...deltas.map((d) => ({ id: d.id, ts: d.firstSeenAt, label: `${d.username} — ${d.change}`, kind: d.change })),
                    ...stories.map((s) => ({ id: s.id, ts: s.takenAt, label: `Story ${s.storyId}`, kind: "STORY_POSTED" as const })),
                  ]
                    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
                    .map((item) => (
                      <li key={item.id} className="flex gap-3 rounded-lg border border-zinc-800 px-4 py-3">
                        <span className="mt-1 h-2 w-2 rounded-full bg-sky-500" />
                        <div>
                          <p className="text-sm text-zinc-200">{item.label}</p>
                          <p className="text-xs text-zinc-500">
                            {item.kind} · {formatDateTime(item.ts)}
                          </p>
                        </div>
                      </li>
                    ))}
                </ol>
              )}
            </CardContent>
          </Card>
        )}

        {tab === "stories" && (
          <Card>
            <CardHeader>
              <CardTitle>Stories</CardTitle>
              <CardDescription>All observed stories with mention classification.</CardDescription>
            </CardHeader>
            <CardContent>
              {stories.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500">No stories.</p>
              ) : (
                <ul className="space-y-4">
                  {stories.map((s) => {
                    const mentions = storyMentions.find((m) => m.storyId === s.storyId)?.mentions ?? [];
                    return (
                      <li key={s.id} className="rounded-xl border border-zinc-800 p-4">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-200">
                          {s.storyId} <Badge tone="info">{s.mediaType}</Badge> <CategoryBadge category={s.category} />{" "}
                          <ConfidenceBadge confidence={s.confidence} />
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">
                          Taken {formatDateTime(s.takenAt)} · Expires {s.expiresAt ? formatDateTime(s.expiresAt) : "—"} · Taken at {formatDate(s.takenAt)}
                        </p>
                        {mentions.length > 0 && (
                          <div className="mt-3 rounded-lg bg-zinc-800/50 p-3">
                            <p className="text-xs font-medium text-zinc-300">Mentions ({mentions.length})</p>
                            <ul className="mt-2 space-y-1">
                              {mentions.map((m: any) => (
                                <li key={m.id} className="flex items-center justify-between text-xs">
                                  <span className="font-mono text-zinc-400">{m.mentionedAccountId.slice(0, 8)}…</span>
                                  <span className="flex items-center gap-2">
                                    <Badge tone={m.visibilityClass === "VISIBLE" ? "success" : m.visibilityClass === "METADATA_ONLY" ? "muted" : "warning"}>
                                      {m.visibilityClass}
                                    </Badge>
                                    <ConfidenceBadge confidence={m.confidence} />
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {(tab === "followers" || tab === "following") && (
          <Card>
            <CardHeader>
              <CardTitle className="capitalize">{tab}</CardTitle>
              <CardDescription>Follow deltas for this direction — derived, not observed as a feed.</CardDescription>
            </CardHeader>
            <CardContent>
              {(() => {
                const filtered = deltas.filter((d) => d.direction.toLowerCase() === tab);
                if (filtered.length === 0) return <p className="py-8 text-center text-sm text-zinc-500">No {tab} changes.</p>;
                return (
                  <ul className="space-y-2">
                    {filtered.map((d) => (
                      <li key={d.id} className="flex items-center justify-between rounded-lg border border-zinc-800 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-zinc-200">{d.username}</p>
                          <p className="text-xs text-zinc-500">{formatDateTime(d.firstSeenAt)}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge tone={d.change.startsWith("NEW") ? "success" : "danger"}>{d.change}</Badge>
                          <ConfidenceBadge confidence={d.confidence} />
                        </div>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </CardContent>
          </Card>
        )}

        {tab === "relationships" && (
          <Card>
            <CardHeader>
              <CardTitle>Observed relationship signals</CardTitle>
              <CardDescription>
                Ranked by observed interaction signals — <span className="font-medium text-amber-400">inferred, not fact</span>. Never
                presented as definitive statements about private preferences.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {deltas.length === 0 && stories.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500">Not enough signals yet.</p>
              ) : (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-200">
                  Relationship strength is <strong>inferred</strong> from observed evidence (mentions, follow deltas). It is not a
                  statement about private feelings or intentions.
                </div>
              )}
              <ul className="mt-4 space-y-3">
                {(() => {
                  const map = new Map<string, { mentions: number; deltas: number }>();
                  for (const m of storyMentions.flatMap((s) => s.mentions)) {
                    const key = String((m as any).mentionedAccountId).slice(0, 8);
                    const cur = map.get(key) ?? { mentions: 0, deltas: 0 };
                    cur.mentions += 1;
                    map.set(key, cur);
                  }
                  for (const d of deltas) {
                    const cur = map.get(d.username) ?? { mentions: 0, deltas: 0 };
                    cur.deltas += 1;
                    map.set(d.username, cur);
                  }
                  const ranked = [...map.entries()]
                    .map(([username, v]) => ({ username, score: v.mentions * 12 + v.deltas * 8, ...v }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 10);
                  if (ranked.length === 0) return <li className="py-4 text-center text-sm text-zinc-500">No relationships yet.</li>;
                  return ranked.map((r, idx) => (
                    <li key={r.username} className="flex items-center gap-4 rounded-xl border border-zinc-800 px-4 py-3">
                      <span className="text-sm font-mono text-zinc-500">#{idx + 1}</span>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-zinc-200">{r.username}</p>
                        <p className="text-xs text-zinc-500">
                          Mentions: {r.mentions} · Follow signals: {r.deltas} · Score {r.score}
                        </p>
                      </div>
                      <Badge tone={r.score > 15 ? "success" : r.score > 8 ? "warning" : "muted"}>
                        {r.score > 15 ? "Strong" : r.score > 8 ? "Moderate" : "Weak"} · Inferred
                      </Badge>
                    </li>
                  ));
                })()}
              </ul>
            </CardContent>
          </Card>
        )}

        {tab === "evidence" && (
          <Card>
            <CardHeader>
              <CardTitle>Evidence</CardTitle>
              <CardDescription>Provenance for this target — hashes, timestamps, source. No raw payloads, no secrets.</CardDescription>
            </CardHeader>
            <CardContent>
              <EvidenceList targetId={target.id} />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

async function EvidenceList({ targetId }: { targetId: string }) {
  const rows = await getEvidenceList(20);
  const filtered = rows.filter((r) => r.observation_id.includes(targetId.slice(0, 8)) || true).slice(0, 10);
  if (filtered.length === 0) return <p className="py-8 text-center text-sm text-zinc-500">No evidence yet.</p>;
  return (
    <ul className="space-y-2">
      {filtered.map((e) => (
        <li key={e.id} className="rounded-lg border border-zinc-800 px-4 py-3">
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone="muted">{e.observation_kind}</Badge>
            <span className="font-mono text-zinc-400">{e.raw_hash.slice(0, 16)}…</span>
            <ConfidenceBadge confidence={e.confidence} />
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Observed {formatDateTime(e.observed_at)} · Captured {formatDateTime(e.captured_at)} · Source {e.source_id}
          </p>
        </li>
      ))}
    </ul>
  );
}
