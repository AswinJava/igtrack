import Link from "next/link";
import { requirePageUser } from "@/lib/auth";
import { usernameQuerySchema } from "@/lib/username";
import { previewAccount } from "@/lib/account-preview";
import { isSafeExternalUrl } from "@/lib/external-url";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { TrackButton } from "./track-button";

export const dynamic = "force-dynamic";

// GET /lookup?username= — read-only public-account preview WITHOUT creating
// a tracked target. This is the drill-down surface for roster members and
// ad-hoc search: SEARCH → PREVIEW → (explicit TRACK). Nothing here writes.
export default async function LookupPage({
  searchParams,
}: {
  searchParams: Promise<{ username?: string }>;
}) {
  await requirePageUser();
  const params = await searchParams;
  const raw = (params.username ?? "").trim();

  let preview: Awaited<ReturnType<typeof previewAccount>> | null = null;
  let invalid: string | null = null;
  if (raw.length > 0) {
    try {
      const { username } = usernameQuerySchema.parse({ username: raw });
      preview = await previewAccount(username);
    } catch {
      invalid = "Invalid username — letters, digits, dots and underscores, max 30 characters.";
    }
  }

  const body = preview?.body;
  const failed = preview !== null && preview.status !== 200;

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Look up a public account</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Live provider preview only — looking something up never starts tracking it. Tracking happens
        solely through the explicit Track button.
      </p>

      <form method="get" className="mt-4 flex gap-2">
        <input
          name="username"
          defaultValue={raw}
          placeholder="@handle"
          maxLength={30}
          autoComplete="off"
          aria-label="Instagram username"
          className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-sky-500"
        />
        <button type="submit" className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700">
          Look up
        </button>
      </form>

      {invalid !== null && (
        <div role="alert" className="mt-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {invalid}
        </div>
      )}

      {preview !== null && failed && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Preview unavailable</CardTitle>
            <CardDescription>Live provider answer, not a stored state.</CardDescription>
          </CardHeader>
          <CardContent>
            <div role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
              {body?.error?.message ?? "Provider lookup failed."}{" "}
              <span className="text-amber-200/70">(code {body?.error?.code ?? preview.status})</span>
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              What remains available: tracked accounts on{" "}
              <Link href="/targets" className="font-medium text-sky-400 hover:underline">Tracked Accounts</Link>,
              and per-capability health on{" "}
              <Link href="/diagnostics" className="font-medium text-sky-400 hover:underline">Diagnostics</Link>.
            </p>
          </CardContent>
        </Card>
      )}

      {preview !== null && !failed && body?.account && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>@{body.account.username}</CardTitle>
            <CardDescription>
              Live preview from {body.sourceId ?? "unknown source"}
              {body.observedAt ? ` · observed ${formatDateTime(new Date(body.observedAt))}` : ""} ·
              not yet tracked.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {body.private === true || body.account.isPrivate === true ? (
              <div role="alert" className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-amber-200">
                Private account — public monitoring is unavailable, so this account cannot be tracked.
              </div>
            ) : (
              <>
                <p className="text-zinc-300">
                  {body.account.displayName ?? "—"}
                  {body.profile?.isVerified === true && <span className="ml-2 text-sm text-sky-400">✓ Verified</span>}
                </p>
                <p className="text-zinc-400">{body.profile?.bio ?? "No bio"}</p>
                <p className="text-xs text-zinc-500">
                  followers {body.profile?.followerCount ?? "unavailable"} · following{" "}
                  {body.profile?.followingCount ?? "unavailable"} · posts{" "}
                  {body.profile?.postCount ?? "unavailable"}
                </p>
                {body.profile?.externalUrl && isSafeExternalUrl(body.profile.externalUrl) && (
                  <p className="text-xs text-zinc-500">
                    Provider link:{" "}
                    <a href={body.profile.externalUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-sky-400 hover:underline">
                      {body.profile.externalUrl}
                    </a>
                  </p>
                )}
                <TrackButton username={body.account.username} />
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
