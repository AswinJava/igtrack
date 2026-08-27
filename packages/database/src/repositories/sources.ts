import { sql } from "drizzle-orm";
import { sources } from "../schema/index.js";
import type { DbLike } from "../transactions.js";
import type { SourceInput } from "./types.js";

export async function ensureSource(
  db: DbLike,
  input: SourceInput,
): Promise<void> {
  await db
    .insert(sources)
    .values({
      id: input.id,
      kind: input.kind,
      name: input.name,
      ...(input.providerVersion !== undefined
        ? { providerVersion: input.providerVersion }
        : {}),
    })
    .onConflictDoNothing({ target: sources.id });
}

export async function getSource(db: DbLike, id: string) {
  const rows = await db.select().from(sources).where(sql`${sources.id} = ${id}`);
  return rows[0] ?? null;
}
