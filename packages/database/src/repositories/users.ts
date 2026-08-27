import { z } from "zod";
import { sql } from "drizzle-orm";
import { users } from "../schema/index.js";
import type { Database } from "../client/client.js";
import { AppError, AppErrorCode } from "@igtrack/core";
import { hashPassword } from "../auth/passwords.js";

const createUserSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120).optional(),
});

export interface CreateUserInput {
  email: string;
  password: string;
  displayName?: string;
}

export type UserRecord = typeof users.$inferSelect;

export async function createUserWithPassword(
  db: Database,
  input: CreateUserInput,
): Promise<UserRecord> {
  const parsed = createUserSchema.parse(input);
  const passwordHash = await hashPassword(parsed.password);
  try {
    const rows = await db
      .insert(users)
      .values({
        email: parsed.email.toLowerCase(),
        ...(parsed.displayName !== undefined
          ? { displayName: parsed.displayName }
          : {}),
        passwordHash,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("igtrack: user insert returned no rows");
    return row;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      ((err as { code?: unknown }).code === "23505" ||
        (err as { cause?: { code?: unknown } }).cause?.code === "23505")
    ) {
      throw new AppError(AppErrorCode.CONFLICT, "An account with this email already exists", {
        cause: err,
      });
    }
    throw err;
  }
}

export async function findUserByEmail(db: Database, email: string): Promise<UserRecord | null> {
  const normalized = email.trim().toLowerCase();
  const rows = await db.select().from(users).where(sql`${users.email} = ${normalized}`).limit(1);
  return rows[0] ?? null;
}
