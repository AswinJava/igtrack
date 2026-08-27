export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  icon?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 px-8 py-12 text-center">
      {icon && <div className="mb-3 text-2xl text-zinc-600">{icon}</div>}
      <h3 className="text-sm font-semibold text-zinc-300">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-zinc-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-sky-500" aria-hidden />
      <span className="ml-3 text-sm text-zinc-500">{label}…</span>
    </div>
  );
}

export function ErrorState({ message, retryHref }: { message: string; retryHref?: string }) {
  return (
    <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-6 py-8 text-center">
      <p className="text-sm font-medium text-red-400">Something went wrong</p>
      <p className="mt-1 text-sm text-zinc-400">{message}</p>
      {retryHref && (
        <a href={retryHref} className="mt-4 inline-block text-sm text-sky-400 hover:underline">
          Try again
        </a>
      )}
    </div>
  );
}
