"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Explicit track step for the /lookup preview: the ONLY writer on this page.
// Posts the already-previewed username, then navigates to the new target.
export function TrackButton({ username }: { username: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function track() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const json = (await res.json()) as {
        target?: { id: string };
        error?: { message?: string };
      };
      if ((res.status === 201 || res.status === 200) && json.target) {
        router.push(`/targets/${json.target.id}`);
        router.refresh();
        return;
      }
      setError(json.error?.message ?? "Could not track this account.");
    } catch {
      setError("Network error — the request never reached IGTrack.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button variant="primary" onClick={track} disabled={busy}>
        {busy ? "Tracking…" : `Track @${username}`}
      </Button>
      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>
      )}
    </div>
  );
}
