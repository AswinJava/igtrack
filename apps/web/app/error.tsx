"use client";

import Link from "next/link";

// Root page-level failure state (Phase 15). Intentionally generic: API and
// data layers never expose stacks or secrets, and this boundary does not
// either. Digest (when present) is an opaque Next.js error id, safe to show.
export default function Error({
  reset,
}: {
  error?: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-zinc-500">
        This page failed to load its observations. No data was changed. Try again, or return to the dashboard.
      </p>
      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          onClick={() => reset()}
          className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-sky-400"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
