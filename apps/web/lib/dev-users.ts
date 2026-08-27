import { findUserByEmail } from "@igtrack/database";
import { getDatabase } from "@/lib/db";

export { isDevLoginEnabled, startSessionForUser, endCurrentSession } from "./auth.js";

// Never leaks whether the lookup failed because of auth or infrastructure.
export async function findUserByEmailSafe(email: string): Promise<{ id: string } | null> {
  try {
    const user = await findUserByEmail(getDatabase(), email);
    return user ? { id: user.id } : null;
  } catch {
    return null;
  }
}
