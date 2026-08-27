"use client";

import { useState } from "react";

export interface EvidenceData {
  id: string;
  observationKind: string;
  observationId: string;
  sourceId: string;
  sourceReference?: string | null;
  observedAt: Date | string;
  capturedAt: Date | string;
  confidence: string;
  rawHash: string;
  normalizedHash?: string | null;
  providerVersion?: string | null;
  schemaVersion?: string | null;
}

function fmt(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });
}

export function EvidenceDrawer({ evidence }: { evidence: EvidenceData }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-sky-400 hover:text-sky-300 hover:underline"
      >
        View evidence
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h3 className="text-sm font-semibold text-zinc-100">Evidence</h3>
              <button onClick={() => setOpen(false)} className="rounded-lg px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800">
                ✕
              </button>
            </div>
            <p className="mt-1 text-xs text-zinc-500">Why do we know this? Every observation links to provenance.</p>

            <dl className="mt-4 space-y-3 text-xs">
              <div className="flex justify-between gap-4 border-b border-zinc-800 pb-2">
                <dt className="text-zinc-500">Observation</dt>
                <dd className="font-mono text-zinc-300">{evidence.observationKind} · {evidence.observationId.slice(0, 8)}…</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-zinc-800 pb-2">
                <dt className="text-zinc-500">Source</dt>
                <dd className="text-zinc-300">{evidence.sourceId}</dd>
              </div>
              {evidence.sourceReference && (
                <div className="flex justify-between gap-4 border-b border-zinc-800 pb-2">
                  <dt className="text-zinc-500">Source ref</dt>
                  <dd className="font-mono text-zinc-300">{evidence.sourceReference}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4 border-b border-zinc-800 pb-2">
                <dt className="text-zinc-500">Observed at</dt>
                <dd className="text-zinc-300">{fmt(evidence.observedAt)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-zinc-800 pb-2">
                <dt className="text-zinc-500">Captured at</dt>
                <dd className="text-zinc-300">{fmt(evidence.capturedAt)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-zinc-800 pb-2">
                <dt className="text-zinc-500">Confidence</dt>
                <dd className="text-zinc-300">{evidence.confidence}</dd>
              </div>
              <div className="border-b border-zinc-800 pb-2">
                <dt className="text-zinc-500">Raw hash (sha256)</dt>
                <dd className="mt-1 break-all font-mono text-[11px] text-zinc-400">{evidence.rawHash}</dd>
              </div>
              {evidence.normalizedHash && (
                <div className="border-b border-zinc-800 pb-2">
                  <dt className="text-zinc-500">Normalized hash</dt>
                  <dd className="mt-1 break-all font-mono text-[11px] text-zinc-400">{evidence.normalizedHash}</dd>
                </div>
              )}
              {evidence.providerVersion && (
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">Provider version</dt>
                  <dd className="text-zinc-300">{evidence.providerVersion}</dd>
                </div>
              )}
              {evidence.schemaVersion && (
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">Schema version</dt>
                  <dd className="text-zinc-300">{evidence.schemaVersion}</dd>
                </div>
              )}
            </dl>

            <p className="mt-4 rounded-lg bg-zinc-800/50 px-3 py-2 text-xs text-zinc-500">
              Raw payloads are not stored. Evidence shows provenance via hashes. No secrets are exposed.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

export function EvidenceInline({ evidence }: { evidence: EvidenceData | null }) {
  if (!evidence) return <span className="text-xs text-zinc-500">No evidence yet</span>;
  return <EvidenceDrawer evidence={evidence} />;
}
