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

  // Presence-gated fields, shared by both write paths: only write a field when
  // the observation explicitly knows it — UNKNOWN never becomes false.
  const observed = {
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.isPrivate !== undefined ? { isPrivate: input.isPrivate } : {}),
    ...(input.isVerified !== undefined ? { isVerified: input.isVerified } : {}),
    ...(input.accountType !== undefined ? { accountType: input.accountType } : {}),
    ...(input.profilePicUrl !== undefined
      ? { profilePicUrl: input.profilePicUrl }
      : {}),
    ...(input.bio !== undefined ? { bio: input.bio } : {}),
    ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
  };

  const write = async (): Promise<AccountRecord | undefined> => {
    // The platform id is the identity; the username is a mutable label (D52).
    // If we already know this account's id, the row it names is updated — a
    // rename rewrites username on that row instead of forking a second account
    // that silently splits its history. The id stays an output of an
    // observation, and this is the one place it is used to MATCH a row we
    // already hold.
    if (input.igId !== undefined) {
      const updated = await db
        .update(igAccounts)
        .set({
          ...observed,
          username,
          usernameLower,
          lastSeenAt: sql`greatest(${igAccounts.lastSeenAt}, ${seenAt.toISOString()})`,
        })
        // Rename only while the target handle is free or already ours. Another
        // row holding it means the handle was reassigned on the platform (or
        // the observation carried a stale id): renaming anyway would violate
        // the username_lower unique index and surface as a raw driver error,
        // so the setWhere refuses quietly and the conflict path below raises
        // the descriptive identity-conflict error instead.
        .where(
          sql`${igAccounts.igId} = ${input.igId}
            AND NOT EXISTS (
              SELECT 1 FROM ${igAccounts} AS rename_blocker
              WHERE rename_blocker.username_lower = ${usernameLower}
                AND rename_blocker.ig_id IS DISTINCT FROM ${input.igId}
            )`,
        )
        .returning();
      if (updated[0] !== undefined) return updated[0];
    }

    const rows = await db
      .insert(igAccounts)
      .values({
        username,
        usernameLower,
        ...(input.igId !== undefined ? { igId: input.igId } : {}),
        ...observed,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      })
      .onConflictDoUpdate({
        target: igAccounts.usernameLower,
        set: {
          ...(input.igId !== undefined ? { igId: input.igId } : {}),
          ...observed,
          lastSeenAt: sql`greatest(${igAccounts.lastSeenAt}, ${seenAt.toISOString()})`,
        },
        // A username row already bound to a DIFFERENT platform id is a real
        // collision (a handle was reused after a rename, or a provider returned
        // the wrong id). Overwriting the id would silently merge two identities
        // and misattribute their history, so the conditional update refuses and
        // the conflict path below names the reason.
        ...(input.igId !== undefined
          ? {
              setWhere: sql`(${igAccounts.igId} is null or ${igAccounts.igId} = ${input.igId})
                AND NOT EXISTS (
                  SELECT 1 FROM ${igAccounts} AS id_blocker
                  WHERE id_blocker.ig_id = ${input.igId}
                    AND id_blocker.id <> ${igAccounts.id}
                )`,
            }
          : {}),
      })
      .returning();
    return rows[0];
  };

  try {
    const row = await write();
    // A defined row means one of the guarded paths accepted the write.
    if (row !== undefined) return row;
    // No row and no error: a guard refused, for a reason named below.
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Both statements evaluate their NOT EXISTS guards against a snapshot taken
    // before a concurrent write commits, so two racing observations can each
    // pass a guard and then collide on a unique index — a shared platform id
    // under two different handles, or one new handle reached by two renames.
    // That is the same identity conflict and must not escape as a driver-level
    // 23505 that reads as an opaque "Failed query: insert into ig_accounts…".
  }
  throw await identityConflict(db, username, input.igId);
}

// The database reports a unique-index violation, but the repository's contract
// is a described identity conflict. Same predicate as the two other private
// copies in this package (jobs/queue.ts, repositories/claims.ts): the driver
// surfaces PostgresError on DrizzleQueryError.cause.
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const direct = (err as { code?: unknown }).code;
  if (direct === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505"
  );
}

// Names why an account write was refused — reached when a guard declined the
// write, and when a concurrent writer won a race the guards could not see.
// Either way the operator needs the collision spelled out: "failed to upsert"
// cannot tell a reused handle from a duplicated id, and the remedies differ.
async function identityConflict(
  db: DbLike,
  username: string,
  igId: string | undefined,
): Promise<Error> {
  const conflicting = await getAccountByUsername(db, username);
  if (
    conflicting !== null &&
    conflicting.igId !== null &&
    igId !== undefined &&
    conflicting.igId !== igId
  ) {
    return new Error(
      `igtrack: account identity conflict for @${username}: the username is already bound to ` +
        `platform id ${conflicting.igId}, so the observation carrying id ${igId} was not written. ` +
        "Refusing to overwrite one platform identity with another.",
    );
  }
  const idHolder = igId !== undefined ? await getAccountByIgId(db, igId) : null;
  if (igId !== undefined && idHolder !== null && (conflicting === null || idHolder.id !== conflicting.id)) {
    return new Error(
      `igtrack: account identity conflict for @${username}: platform id ${igId} is already ` +
        `bound to @${idHolder.username}, so it could not also bind @${username}. ` +
        "Refusing to attach one platform identity to two accounts.",
    );
  }
  return new Error(`igtrack: failed to upsert account @${username}`);
}

// Reverse lookup by platform id, used only to explain an identity conflict in
// the error above. Not a matching route: D52 keeps the id an output of an
// observation everywhere else.
//
// Exported so a caller can CHECK the binding BEFORE it writes: an
// observation carrying an id that already belongs to a different username is
// a different account, and merging the two would merge two histories.
export async function getAccountByIgId(db: DbLike, igId: string): Promise<AccountRecord | null> {
  const rows = await db
    .select()
    .from(igAccounts)
    .where(sql`${igAccounts.igId} = ${igId}`)
    .limit(1);
  return rows[0] ?? null;
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
