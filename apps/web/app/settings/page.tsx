import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requirePageUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requirePageUser();
  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-zinc-500">Workspace, privacy, and authentication boundary.</p>

      <div className="mt-6 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Authentication</CardTitle>
            <CardDescription>Credentials, sessions, and ownership.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-zinc-400">
            <p>Signed in as <span className="font-mono text-zinc-200">{session.email}</span>.</p>
            <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed">
              <li>Passwords are stored as scrypt hashes with per-user salts; plaintext never persists.</li>
              <li>Sessions are opaque server-side tokens (SHA-256 hashed at rest) with a 7-day expiry and real logout revocation.</li>
              <li>Every target operation verifies server-side ownership; cross-user access returns not-found semantics.</li>
              <li>Dev login exists only outside production (<code className="font-mono">NODE_ENV != production</code>) and can be force-disabled via IGTRACK_ALLOW_DEV_LOGIN=false.</li>
            </ul>
            <div className="flex gap-2">
              <a href="/login" className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700">Open login</a>
              <form action="/api/auth/logout" method="post"><button className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 hover:bg-zinc-800">Sign out</button></form>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Privacy &amp; retention</CardTitle>
            <CardDescription>Built from day one.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-zinc-400">
            <p>Deleting a tracked account cascades its observations, snapshots, deltas, stories, interactions, and related evidence through the retention boundary (<code className="font-mono">deleteOwnedTarget</code>). Shared registry rows under ig_accounts intentionally survive deletion.</p>
            <p>Raw payloads are not stored — only hashes. No secrets are persisted in evidence.</p>
            <p className="flex gap-2"><Badge tone="muted">Synthetic data</Badge><Badge tone="info">Evidence-first</Badge><Badge tone="warning">Append-only</Badge></p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Platform</CardTitle>
            <CardDescription>What IGTrack can and cannot know.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-zinc-400">
            <p>Honest capability map: public profile metadata, story existence while live, mention metadata where exposed, and follower/following lists where the configured provider exposes them. Public comments are recorded where the provider exposes them — a post with no exposed comment source stays comment-less. No DMs, no private likes history, no private-account access without authorization. Anything the source cannot answer is shown as unavailable, never zero.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
