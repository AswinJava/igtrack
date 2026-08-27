"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        router.push("/");
        router.refresh();
        return;
      }
      if (res.status === 401) {
        setError("Invalid email or password.");
        return;
      }
      const json = (await res.json()) as { error?: { message?: string } };
      setError(json.error?.message ?? "Sign-in failed.");
    } catch {
      setError("Network error — sign-in request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <label className="block">
        <span className="text-xs font-medium text-zinc-400">Email</span>
        <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500" />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-zinc-400">Password</span>
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500" />
      </label>
      {error !== "" && (
        <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
      <Button type="submit" variant="primary" disabled={busy || email.length === 0 || password.length === 0} className="w-full">{busy ? "Signing in…" : "Sign in"}</Button>
    </form>
  );
}
