"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRelative } from "@/lib/format";

interface UpcomingScan {
  kind: string;
  intervalMs: number;
  nextAvailableAt: Date;
}

const KIND_LABELS: Record<string, string> = {
  PROFILE_SCAN: "Profile",
  FOLLOWER_SCAN: "Followers",
  FOLLOWING_SCAN: "Following",
  STORY_SCAN: "Stories",
  POSTS_SCAN: "Posts",
};

const CADENCE_PRESETS: Array<{ label: string; value: number | null }> = [
  { label: "Standard cadence (deployment default)", value: null },
  { label: "Frequent (2× as often)", value: 0.5 },
  { label: "Quiet (half as often)", value: 2 },
  { label: "Rare (quarter as often)", value: 4 },
];

interface Props {
  targetId: string;
  status: string;
  localName: string | null;
  notes: string | null;
  tags: string[];
  scanCadenceMult: number | null;
  scanKinds: string[] | null;
  upcomingScans: UpcomingScan[];
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
  const [scanSettingsOpen, setScanSettingsOpen] = useState(false);
  const [cadence, setCadence] = useState<string>(
    props.scanCadenceMult === null || props.scanCadenceMult === undefined
      ? "default"
      : String(props.scanCadenceMult),
  );
  const [kinds, setKinds] = useState<Record<string, boolean>>(() => {
    const enabled = new Set(props.scanKinds ?? Object.keys(KIND_LABELS));
    return Object.fromEntries(Object.keys(KIND_LABELS).map((k) => [k, enabled.has(k)]));
  });
  const [syncMessage, setSyncMessage] = useState<string>("");

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

  async function syncNow() {
    setBusy(true);
    setError("");
    setSyncMessage("");
    const res = await fetch(`/api/targets/${props.targetId}/sync`, { method: "POST" });
    if (!res.ok) {
      let message = `Sync failed (${res.status})`;
      try {
        const json = (await res.json()) as { error?: { message?: string } };
        if (json.error?.message) message = json.error.message;
      } catch { /* keep default */ }
      setError(message);
    } else {
      const json = (await res.json()) as { queued?: string[]; deduplicated?: number };
      const queued = json.queued ?? [];
      setSyncMessage(
        queued.length > 0
          ? `Queued: ${queued.map((k) => KIND_LABELS[k] ?? k).join(", ")}.`
          : "Already queued — nothing new to schedule.",
      );
    }
    setBusy(false);
    router.refresh();
  }

  async function saveScanSettings() {
    setBusy(true);
    setError("");
    const enabledKinds = Object.keys(KIND_LABELS).filter((k) => kinds[k]);
    const res = await call("PATCH", `/api/targets/${props.targetId}`, {
      scanCadenceMult: cadence === "default" ? null : Number(cadence),
      scanKinds: enabledKinds.length === Object.keys(KIND_LABELS).length ? null : enabledKinds,
    });
    if (!res.ok) setError(res.error ?? "Update failed.");
    else setScanSettingsOpen(false);
    setBusy(false);
    router.refresh();
  }

  function toggleKind(kind: string) {
    setKinds((prev) => {
      const next = { ...prev, [kind]: !prev[kind] };
      // At least one kind must stay enabled — "nothing, ever" is PAUSED.
      if (Object.values(next).every((v) => !v)) return prev;
      return next;
    });
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
      <Button size="sm" variant="ghost" onClick={() => setScanSettingsOpen((v) => !v)} disabled={busy}>
        {scanSettingsOpen ? "Close scan settings" : "Scan settings"}
      </Button>
      {props.status === "ACTIVE" && (
        <Button size="sm" variant="primary" onClick={() => void syncNow()} disabled={busy}>
          {busy ? "Working…" : "Sync now"}
        </Button>
      )}
      <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete…</Button>

      {props.upcomingScans.length > 0 && props.status === "ACTIVE" && (
        <p className="w-full text-[11px] text-zinc-500" title="Forecast from the same deterministic schedule the worker uses">
          Next scans: {props.upcomingScans.slice(0, 5).map((s) => `${KIND_LABELS[s.kind] ?? s.kind} ${formatRelative(s.nextAvailableAt)}`).join(" · ")}
        </p>
      )}
      {syncMessage !== "" && (
        <p role="status" className="w-full text-xs text-emerald-400">{syncMessage}</p>
      )}

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

      {scanSettingsOpen && (
        <form
          onSubmit={(e) => { e.preventDefault(); void saveScanSettings(); }}
          className="mt-3 w-full space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4"
          aria-label="Edit scan settings"
        >
          <label className="block">
            <span className="text-xs font-medium text-zinc-400">Scan frequency</span>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
            >
              {CADENCE_PRESETS.map((p) => (
                <option key={p.label} value={p.value === null ? "default" : String(p.value)}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-zinc-600">
              Multiplier on the deployment scan intervals. Applies from the next scheduler window.
            </span>
          </label>
          <fieldset>
            <legend className="text-xs font-medium text-zinc-400">Scan categories</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {Object.entries(KIND_LABELS).map(([kind, label]) => (
                <label key={kind} className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={kinds[kind] ?? true}
                    onChange={() => toggleKind(kind)}
                    className="accent-sky-500"
                  />
                  {label}
                </label>
              ))}
            </div>
            <span className="mt-1 block text-[11px] text-zinc-600">
              Unchecked categories stop being scheduled. Pausing the target stops everything.
            </span>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setScanSettingsOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" size="sm" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save scan settings"}</Button>
          </div>
        </form>
      )}

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
