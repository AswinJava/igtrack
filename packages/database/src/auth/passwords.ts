import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const COST = 16384; // N
const BLOCK_SIZE = 8; // r
const PARALLELIZATION = 1; // p

interface ScryptOptions {
  N: number;
  r: number;
  p: number;
}

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLength, options, (err, derivedKey) => {
      if (err !== null) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
  });
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (stored === null || stored === undefined) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const costRaw = parts[1];
  const blockRaw = parts[2];
  const parallelRaw = parts[3];
  const saltHex = parts[4];
  const hashHex = parts[5];

  const N = Number(costRaw);
  if (!Number.isInteger(N) || N <= 0 || N > 2 ** 21) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex ?? "", "hex");
    expected = Buffer.from(hashHex ?? "", "hex");
  } catch {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) return false;

  try {
    const derived = await scrypt(password, salt, expected.length, {
      N,
      r: Number(blockRaw),
      p: Number(parallelRaw),
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
