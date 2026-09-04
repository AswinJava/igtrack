export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-6" aria-busy="true" aria-live="polite">
      <div className="mb-6">
        <div className="h-6 w-40 animate-pulse rounded bg-zinc-800" />
        <div className="mt-2 h-4 w-64 animate-pulse rounded bg-zinc-800/60" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-zinc-800 px-4 py-5">
            <div className="h-3 w-24 animate-pulse rounded bg-zinc-800" />
            <div className="mt-3 h-7 w-16 animate-pulse rounded bg-zinc-800" />
          </div>
        ))}
      </div>
      <p className="mt-6 text-center text-xs text-zinc-600">Loading observations from the database…</p>
    </div>
  );
}
