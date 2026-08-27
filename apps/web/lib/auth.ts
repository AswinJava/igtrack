import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppError, AppErrorCode } from "@igtrack/core";
import {
  issueSession,
  resolveSession,
  revokeSession,
  SESSION_TTL_MS,
  findUserByEmail,
  verifyPassword,
} from "@igtrack/database";
import { getDatabase } from "./db.js";

const COOKIE_NAME = "igtrack_session";

export interface AuthSession {
  userId: string;
  email: string;
}

// Dev login exists to make local development frictionless. It must never be
// reachable in a production deployment: production is decided by NODE_ENV, and
// it can additionally be force-disabled with IGTRACK_ALLOW_DEV_LOGIN=false.
export function isDevLoginEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.IGTRACK_ALLOW_DEV_LOGIN !== "false";
}

export async function getSession(): Promise<AuthSession | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const resolved = await resolveSession(getDatabase(), token);
    if (!resolved) return null;
    return { userId: resolved.userId, email: resolved.email };
  } catch {
    // Database failure during auth is not an authentication success.
    return null;
  }
}

// For route handlers: throws a typed error the API layer maps to UNAUTHORIZED.
export async function requireApiSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, "Authentication required");
  }
  return session;
}

// For server components: redirects to login instead of erroring.
export async function requirePageUser(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function startSessionForUser(userId: string): Promise<void> {
  const { token } = await issueSession(getDatabase(), userId, SESSION_TTL_MS);
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function endCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) {
    try {
      await revokeSession(getDatabase(), token);
    } catch {
      // Cookie deletion below still ends the client-side session.
    }
  }
  store.delete(COOKIE_NAME);
}

export interface VerifiedUser {
  id: string;
  email: string;
}

// Returns null for unknown users, wrong passwords, and accounts without
// credentials, one response shape, no account-existence oracle.
export async function verifyCredentials(email: string, password: string): Promise<VerifiedUser | null> {
  const user = await findUserByEmail(getDatabase(), email);
  if (user === null || user.passwordHash === null) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  return { id: user.id, email: user.email };
}

// Existence probe for the local dev seed account only. Always paired with
// isDevLoginEnabled() at the call site.
export async function getDevUser(): Promise<VerifiedUser | null> {
  const user = await findUserByEmail(getDatabase(), "dev@igtrack.local");
  return user === null ? null : { id: user.id, email: user.email };
}
