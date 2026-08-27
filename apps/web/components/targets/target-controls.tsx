"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface Props {
  targetId: string;
  status: string;
  localName: string | null;
  notes: string | null;
  tags: string[];
}

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method,
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (res.ok) return { ok: true };
  let message = `Request failed (${res.status})`;
  try {
    const json = (await res.json()) as { error?: { code: string; message?: string } };
    if (json.error?.message) message = json.error.message;
  } catch { /* keep default */ }
  return { ok: false, error: message };
}
export function TargetControls(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [localName, setLocalName] = useState(props.localName ?? "");
  const [notes, setNotes] = useState(props.notes ?? "");
  const [tagsInput, setTagsInput] = useState(props.tags.join(", "));

  async function lifecycle(action: "pause" | "resume") {
    setBusy(true);
    setError("");
    const res = await call("POST", `/api/targets/${props.targetId}/${action}`);
    if (!res.ok) setError(res.error ?? "Action failed.");
    setBusy(false);
    router.refresh();
  }

  async function saveMeta() {
    setBusy(true);
    setError("");
    const tags = tagsInput.split(",").map((t) => t.trim()).filter(Boolean);
    const res = await call("PATCH", `/api/targets/${props.targetId}`, {
      localName: localName.trim() === "" ? null : localName.trim(),
      notes: notes.trim() === "" ? null : notes.trim(),
      tags,
    });
    if (!res.ok) setError(res.error ?? "Update failed.");
    setBusy(false);
    if (res.ok) setEditing(false);
    router.refresh();
  }

  async function doDelete() {
    setBusy(true);
    const res = await call("DELETE", `/api/targets/${props.targetId}`);
    if (!res.ok) {
      setError(res.error ?? "Deletion failed.");
      setBusy(false);
      setConfirmDelete(false);
      return;
    }
    router.push("/targets");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.status === "ACTIVE" && (
        <Button size="sm" onClick={() => lifecycle("pause")} disabled={busy}>Pause monitoring</Button>
      )}
      {props.status === "PAUSED" && (
        <Button size="sm" variant="primary" onClick={() => lifecycle("resume")} disabled={busy}>Resume</Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)} disabled={busy}>
        {editing ? "Close editor" : "Edit metadata"}
      </Button>
      <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete…</Button>

      {editing && (
        <form onSubmit={(e) => { e.preventDefault(); void saveMeta(); }} className="mt-3 w-full space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4" aria-label="Edit target metadata">
          <label className="block">
            <span className="text-xs font-medium text-zinc-400">Local name</span>
            <input value={localName} onChange={(e) => setLocalName(e.target.value)} maxLength={200} className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-sky-500" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-400">Tags (comma separated)</span>
            <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-sky-500" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-zinc-400">Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={5000} className="mt-1 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-sky-500" />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" size="sm" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button>
          </div>
        </form>
      )}

      {error !== "" && <p role="alert" className="mt-2 w-full text-xs text-red-400">{error}</p>}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this target permanently?"
        description="Deletes the tracked account together with its snapshots, deltas, stories and evidence through the retention boundary. This cannot be undone. The shared Instagram account registry row may be kept."
        confirmLabel="Delete everything"
        danger
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
