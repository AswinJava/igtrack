import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-zinc-500">The page you’re looking for doesn’t exist or the target was removed.</p>
      <Link href="/" className="mt-6 inline-flex rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700">
        Back to dashboard
      </Link>
    </div>
  );
}
