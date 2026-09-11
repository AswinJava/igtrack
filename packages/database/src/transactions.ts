import type { Database } from "./client/client.js";

type TransactionCallback = Parameters<Database["transaction"]>[0];
export type DatabaseTx = Parameters<TransactionCallback>[0];
export type DbLike = Database | DatabaseTx;

export async function withTransaction<T>(
  db: Database,
  fn: (tx: DatabaseTx) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}
