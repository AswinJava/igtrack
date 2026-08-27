"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Phase = "idle" | "loading" | "error" | "duplicate";

export function CreateTargetForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [localName, setLocalName] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");

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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[10vh]">
      <div role="dialog" aria-modal="true" aria-labelledby="create-target-title" className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-6">
        <h2 id="create-target-title" className="text-sm font-semibold text-zinc-100">Track a public account</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">Public monitoring only. IGTrack queues an initial observation; what becomes visible depends on provider capability, and gaps are always shown as unavailable rather than zero.</p>
        <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
          <label className="block">
            <span className="text-xs font-medium text-zinc-400">Instagram username</span>
            <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@handle" required maxLength={40} aria-describedby="create-target-hint" className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500" />
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
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-300">Active provider in this environment is the synthetic fixture source. Everything observed here is marked SYNTHETIC — it is not live Instagram data.</div>
          {phase === "error" && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">{message || "Something went wrong."}</div>}
          {phase === "duplicate" && <div role="status" className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-sky-300">{message}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={phase === "loading"}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={phase === "loading" || username.trim().length === 0}>{phase === "loading" ? "Creating…" : "Create & queue observation"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
