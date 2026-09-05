"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Phase = "idle" | "loading" | "error" | "duplicate" | "preview-loading" | "preview";

interface LookupPreview {
  username: string;
  displayName: string | null;
  isPrivate: boolean | null;
  bio: string | null;
  followerCount: number | null;
  followingCount: number | null;
  postCount: number | null;
  isVerified: boolean | null;
  // Null when the provider response carries no timestamp: rendered as
  // "observation time unavailable", never filled with client wall-clock.
  observedAt: string | null;
  sourceId: string;
}

export function CreateTargetForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [localName, setLocalName] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");
  const [provider, setProvider] = useState<string | null>(null);
  const [preview, setPreview] = useState<LookupPreview | null>(null);

  // Active provider comes from the live /api/healthz probe — never hardcoded,
  // so a graph deployment stops claiming synthetic data.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/healthz", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: unknown) => {
        if (cancelled) return;
        const name =
          typeof json === "object" && json !== null && "provider" in json
            ? String((json as { provider: unknown }).provider)
            : null;
        setProvider(name);
      })
      .catch(() => {
        if (!cancelled) setProvider(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open ]);

  async function runPreview() {
    // Search → Preview: resolve through the provider WITHOUT creating
    // anything. A failed preview never creates a target.
    setPhase("preview-loading");
    setMessage("");
    setPreview(null);
    try {
      const res = await fetch(`/api/targets/lookup?username=${encodeURIComponent(username.trim())}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        error?: { code: string; message?: string };
        account?: {
          username: string;
          displayName?: string | null;
          isPrivate?: boolean | null;
        };
        profile?: {
          bio?: string | null;
          followerCount?: number | null;
          followingCount?: number | null;
          postCount?: number | null;
          isVerified?: boolean | null;
        } | null;
        private?: boolean;
        observedAt?: string;
        sourceId?: string;
      };
      if (!res.ok || json.error) {
        setPhase("error");
        setMessage(json.error?.message ?? "Could not preview this account.");
        return;
      }
      if (!json.account) {
        setPhase("error");
        setMessage("Could not preview this account.");
        return;
      }
      setPreview({
        username: json.account.username,
        displayName: json.account.displayName ?? null,
        isPrivate: json.private === true ? true : (json.account.isPrivate ?? null),
        bio: json.profile?.bio ?? null,
        followerCount: json.profile?.followerCount ?? null,
        followingCount: json.profile?.followingCount ?? null,
        postCount: json.profile?.postCount ?? null,
        isVerified: json.profile?.isVerified ?? null,
        observedAt: typeof json.observedAt === "string" ? json.observedAt : null,
        sourceId: json.sourceId ?? "unknown",
      });
      setPhase("preview");
    } catch {
      setPhase("error");
      setMessage("Network error — the request never reached IGTrack.");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPhase("loading");
    setMessage("");
    try {
      const res = await fetch("/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          ...(localName.trim() ? { localName: localName.trim() } : {}),
          ...(tags.trim() ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        }),
      });
      if (res.status === 201) {
        setOpen(false); setPhase("idle");
        setUsername(""); setLocalName(""); setTags(""); setNotes("");
        router.refresh();
        return;
      }
      if (res.status === 200) {
        setPhase("duplicate");
        setMessage("Already tracked — opening the existing target.");
        setTimeout(() => { setOpen(false); setPhase("idle"); router.refresh(); }, 1200);
        return;
      }
      const json = (await res.json()) as { error?: { code: string; message?: string; details?: Record<string, string[]> } };
      if (json.error?.code === "VALIDATION_ERROR") {
        const first = Object.values(json.error.details ?? {}).flat()[0];
        setPhase("error");
        setMessage(first ?? "Invalid username — letters, digits, dots, underscores only.");
        return;
      }
      if (res.status === 401) {
        setPhase("error");
        setMessage("Session expired — reload and sign in again.");
        return;
      }
      setPhase("error");
      setMessage(json.error?.message ?? "Could not create the target.");
    } catch {
      setPhase("error");
      setMessage("Network error — the request never reached IGTrack.");
    }
  }

  if (!open) {
    return (
      <Button variant="primary" onClick={() => { setPhase("idle"); setMessage(""); setOpen(true); }}>+ New target</Button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-[5vh]">
      <div role="dialog" aria-modal="true" aria-labelledby="create-target-title" className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6">
        <h2 id="create-target-title" className="text-sm font-semibold text-zinc-100">Track a public account</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">Public monitoring only. IGTrack queues an initial observation; what becomes visible depends on provider capability, and gaps are always shown as unavailable rather than zero.</p>
        <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
          <label className="block">
            <span className="text-xs font-medium text-zinc-400">Instagram username</span>
            <input autoFocus value={username} onChange={(e) => { setUsername(e.target.value); setPreview(null); if (phase === "preview" || phase === "error") { setPhase("idle"); setMessage(""); } }} placeholder="@handle" required maxLength={30} aria-describedby="create-target-hint" className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500" />
            <span id="create-target-hint" className="mt-1 block text-[11px] text-zinc-600">Letters, digits, dots and underscores.</span>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-400">Local name (optional)</span>
            <input value={localName} onChange={(e) => setLocalName(e.target.value)} maxLength={200} className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-400">Tags (optional, comma separated)</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-400">Notes (optional)</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={5000} className="mt-1 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500" />
          </label>
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-300">{provider === null ? "Observations are marked with their source — every claim links to evidence." : provider === "graph" ? "Active provider in this environment is the live Graph source (owned account only). Everything observed here is marked LIVE GRAPH SOURCE." : "Active provider in this environment is the synthetic fixture source. Everything observed here is marked SYNTHETIC — it is not live Instagram data."}</div>
          {(() => {
            const showPreview =
              preview !== null &&
              phase !== "preview-loading" &&
              phase !== "error" &&
              phase !== "duplicate" &&
              phase !== "idle";
            return showPreview ? (
            <div role="status" className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs leading-relaxed text-sky-200">
              <p className="font-medium text-sky-100">
                @{preview.username}
                {preview.isVerified === true && " ✓"}
                {preview.displayName ? ` · ${preview.displayName}` : ""}
              </p>
              <p className="mt-1 text-sky-300/80">
                {preview.isPrivate === true
                  ? "Private account — public monitoring is unavailable."
                  : [
                      preview.bio ?? "No bio",
                      `followers ${preview.followerCount ?? "unavailable"}`,
                      `following ${preview.followingCount ?? "unavailable"}`,
                      `posts ${preview.postCount ?? "unavailable"}`,
                    ].join(" · ")}
              </p>
              <p className="mt-1 text-[11px] text-sky-300/60">
                Live provider preview from {preview.sourceId}{preview.observedAt ? ` · observed ${preview.observedAt}` : " · observation time unavailable"} — not yet tracked. Creating queues the first observation.
              </p>
            </div>
            ) : null;
          })()}
          {phase === "error" && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">{message || "Something went wrong."}</div>}
          {phase === "duplicate" && <div role="status" className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-sky-300">{message}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={phase === "loading" || phase === "preview-loading"}>Cancel</Button>
            {preview !== null && phase !== "idle" && phase !== "error" ? (
              <Button type="submit" variant="primary" disabled={phase === "loading" || phase === "preview-loading" || preview?.isPrivate === true}>
                {phase === "loading" ? "Creating…" : "Create & queue observation"}
              </Button>
            ) : (
              <Button type="button" variant="primary" onClick={runPreview} disabled={phase === "preview-loading" || phase === "loading" || username.trim().length === 0}>
                {phase === "preview-loading" ? "Previewing…" : "Preview"}
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
