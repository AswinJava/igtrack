import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getDatabase } from "./db.js";
import { users } from "@igtrack/database";
import { eq } from "drizzle-orm";

const COOKIE_NAME = "igtrack_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export interface AuthSession {
  userId: string;
  email: string;
}

function getSecret(): string {
  return (
    process.env.IGTRACK_SESSION_SECRET ??
    process.env.AUTH_SECRET ??
    "dev-insecure-secret-do-not-use-in-production"
  );
}

function sign(value: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(value).digest("hex");
  return `${value}.${sig}`;
}

function verify(signed: string, secret: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = createHmac("sha256", secret).update(value).digest("hex");
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return value;
}

export async function getSession(): Promise<AuthSession | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  const payload = verify(raw, getSecret());
  if (!payload) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthSession;
    if (typeof data.userId !== "string" || typeof data.email !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) throw new Error("UNAUTHENTICATED");
  return session;
}

export async function createSession(userId: string, email: string): Promise<void> {
  const payload = Buffer.from(JSON.stringify({ userId, email })).toString("base64url");
  const signed = sign(payload, getSecret());
  const store = await cookies();
  store.set(COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getDevUser(): Promise<{ id: string; email: string } | null> {
  try {
    const db = getDatabase();
    const rows = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, "dev@igtrack.local")).limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
