import { getDevUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const devUser = await getDevUser();

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Phase 3 ships a minimal dev session. Production auth is deferred — see Settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {devUser ? (
            <>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                <p className="text-xs text-zinc-500">Synthetic dev user</p>
                <p className="font-mono text-sm text-zinc-200">{devUser.email}</p>
                <p className="mt-1 font-mono text-xs text-zinc-600">{devUser.id.slice(0, 8)}…</p>
              </div>
              <form action="/api/auth/dev-login" method="post">
                <button className="w-full rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-sky-400">
                  Continue as dev user
                </button>
              </form>
              <p className="text-center text-xs text-zinc-500">No password — dev mode only. Evidence-first, no secrets in evidence.</p>
            </>
          ) : (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
              No dev user found. Run <code className="font-mono text-xs">pnpm --filter @igtrack/database db:seed</code> to create{" "}
              <code className="font-mono text-xs">dev@igtrack.local</code>, then refresh.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
