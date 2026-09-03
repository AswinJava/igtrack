import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { sessions, users } from "../schema/index.js";
import type { Database } from "../client/client.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  userId: string;
  email: string;
  displayName: string | null;
  expiresAt: Date;
}

export async function issueSession(
  db: Database,
  userId: string,
  ttlMs: number = SESSION_TTL_MS,
): Promise<IssuedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(sessions).values({
    id: tokenHash(token),
    userId,
    expiresAt,
  });
  return { token, expiresAt };
}

// Returns null for unknown tokens and expired sessions alike — callers cannot
// distinguish them and neither can an attacker.
export async function resolveSession(
  db: Database,
  token: string,
): Promise<ResolvedSession | null> {
  if (token.length === 0 || token.length > 512) return null;
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, sql`${users.id} = ${sessions.userId}`)
    .where(
      sql`${sessions.id} = ${tokenHash(token)} AND ${sessions.expiresAt} > now()`,
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(sql`${sessions.id} = ${tokenHash(token)}`);
  return row;
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(sql`${sessions.id} = ${tokenHash(token)}`);
}

export async function purgeExpiredSessions(db: Database): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} <= now()`)
    .returning({ id: sessions.id });
  return rows.length;
}
