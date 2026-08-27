import { isDevLoginEnabled } from "@/lib/auth";
import { LoginForm } from "@/components/auth/login-form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const devEnabled = isDevLoginEnabled();

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-6 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Credential access — sessions are stored server-side and expire after 7 days.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <LoginForm />
          <p className="text-center text-[11px] leading-relaxed text-zinc-600">
            No public registration: accounts are provisioned by the operator via{" "}
            <code className="font-mono">pnpm --filter @igtrack/database db:create-user -- --email you@example.com --password …</code>
          </p>
          {devEnabled && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
              <p className="text-xs text-zinc-500">Local development only</p>
              <form action="/api/auth/dev-login" method="post" className="mt-2">
                <button className="w-full rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800">
                  Continue as seeded dev user
                </button>
              </form>
              <p className="mt-2 text-[11px] text-zinc-600">Disabled automatically when NODE_ENV=production or IGTRACK_ALLOW_DEV_LOGIN=false.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
