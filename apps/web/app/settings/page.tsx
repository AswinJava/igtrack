import { requirePageUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function SettingsPage() {
  await requirePageUser();
  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-zinc-500">Workspace, privacy, and authentication boundary.</p>

      <div className="mt-6 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Authentication boundary</CardTitle>
            <CardDescription>Phase 3 ships a minimal dev session; production auth is a documented deferral.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-zinc-400">
            <p>
              The <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-xs">users</code> table exists. Phase 3 implements a
              signed HTTP-only session cookie (<code className="font-mono text-xs">igtrack_session</code>) around it via{" "}
              <code className="font-mono text-xs">apps/web/lib/auth.ts</code>.
            </p>
            <p>
              Dev mode: <code className="font-mono text-xs">POST /api/auth/dev-login</code> creates a session for{" "}
              <code className="font-mono text-xs">dev@igtrack.local</code> (the synthetic seed user) without a password. No credentials are
              stored in the session — only <code className="font-mono text-xs">userId</code> + <code className="font-mono text-xs">email</code> signed with{" "}
              <code className="font-mono text-xs">IGTRACK_SESSION_SECRET</code>.
            </p>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-200">
              <strong>Deferred to Phase 4:</strong> password hashing, email verification, OAuth, CSRF double-submit, and rate limiting. The
              interface in <code className="font-mono text-xs">lib/auth.ts</code> is designed to be swapped without touching routes.
            </div>
            <div className="flex gap-2">
              <a href="/login" className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700">
                Open login
              </a>
              <form action="/api/auth/logout" method="post">
                <button className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:bg-zinc-800">Sign out</button>
              </form>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Privacy & retention</CardTitle>
            <CardDescription>Built from day one — see docs/platform-limitations.md.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-zinc-400">
            <p>
              Deleting a tracked account cascades its observations, snapshots, deltas, and related evidence (see{" "}
              <code className="font-mono text-xs">deleteTargetWithObservations</code> in{" "}
              <code className="font-mono text-xs">packages/database</code>). <code className="font-mono text-xs">ig_accounts</code> rows are
              retained as a shared registry.
            </p>
            <p>Raw payloads are not stored — only hashes. No secrets are persisted in evidence.</p>
            <p className="flex gap-2">
              <Badge tone="muted">Synthetic data</Badge>
              <Badge tone="info">Evidence-first</Badge>
              <Badge tone="warning">Append-only</Badge>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Platform</CardTitle>
            <CardDescription>What IGTrack can and cannot know.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-zinc-400">
            <p>See <code className="font-mono text-xs">docs/platform-limitations.md</code> for the honest capability map. In short: public profile metadata, story existence while live, mention metadata where the source exposes it, follower/following lists (paginated, rate-limited), comments. No DMs, no private likes history, no private accounts without authorization.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
