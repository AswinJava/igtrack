"use client";

import { useEffect, useRef } from "react";
import { Button } from "./button";

// Accessible two-step destructive confirmation built on the native <dialog>
// element — keyboard focus is trapped, Escape closes, no dependencies.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onCancel}
      aria-labelledby="confirm-title"
      className="rounded-xl border border-zinc-800 bg-zinc-950 p-6 text-zinc-100 backdrop:bg-black/60"
      style={{ maxWidth: "26rem" }}
    >
      <h2 id="confirm-title" className="text-sm font-semibold">
        {title}
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">{description}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={() => {
            onConfirm();
          }}
          disabled={busy}
        >
          {busy ? "Working…" : confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
