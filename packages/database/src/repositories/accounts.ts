import { z } from "zod";
import { sql } from "drizzle-orm";
import { igAccounts } from "../schema/index.js";
import type { DbLike } from "../transactions.js";

const usernameSchema = z
  .string()
  .min(1)
  .max(30)
  .regex(/^[a-z0-9._]+$/i, "invalid Instagram username");

export interface UpsertAccountInput {
  username: string;
  igId?: string;
  displayName?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  accountType?: string;
  profilePicUrl?: string;
  bio?: string;
  externalUrl?: string;
  seenAt?: Date;
}

export type AccountRecord = typeof igAccounts.$inferSelect;

export async function upsertAccount(
  db: DbLike,
  input: UpsertAccountInput,
): Promise<AccountRecord> {
  const username = usernameSchema.parse(input.username);
  const usernameLower = username.toLowerCase();
  const seenAt = input.seenAt ?? new Date();

  const rows = await db
    .insert(igAccounts)
    .values({
      username,
      usernameLower,
      ...(input.igId !== undefined ? { igId: input.igId } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      isPrivate: input.isPrivate ?? false,
      isVerified: input.isVerified ?? false,
      ...(input.accountType !== undefined ? { accountType: input.accountType } : {}),
      ...(input.profilePicUrl !== undefined
        ? { profilePicUrl: input.profilePicUrl }
        : {}),
      ...(input.bio !== undefined ? { bio: input.bio } : {}),
      ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })
    .onConflictDoUpdate({
      target: igAccounts.usernameLower,
      set: {
        ...(input.igId !== undefined ? { igId: input.igId } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        isPrivate: input.isPrivate ?? false,
        isVerified: input.isVerified ?? false,
        ...(input.profilePicUrl !== undefined
          ? { profilePicUrl: input.profilePicUrl }
          : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
        lastSeenAt: sql`greatest(${igAccounts.lastSeenAt}, ${seenAt.toISOString()})`,
      },
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`igtrack: failed to upsert account @${username}`);
  }
  return row;
}

export async function getAccountByUsername(
  db: DbLike,
  username: string,
): Promise<AccountRecord | null> {
  const rows = await db
    .select()
    .from(igAccounts)
    .where(sql`${igAccounts.usernameLower} = ${username.toLowerCase()}`)
    .limit(1);
  return rows[0] ?? null;
}

export async function getAccountById(
  db: DbLike,
  id: string,
): Promise<AccountRecord | null> {
  const rows = await db
    .select()
    .from(igAccounts)
    .where(sql`${igAccounts.id} = ${id}`)
    .limit(1);
  return rows[0] ?? null;
}
