// ---------------------------------------------------------------------------
// Account references — one parser for every surface form of "which account?".
//
// The agent surface accepts a target id, a username, an @handle, or a profile
// URL. Before this module every caller trimmed and stripped a leading "@", so
// "instagram.com/aurora", "@aurora.wilde/" or "aurora wilde" all collapsed
// into the same silent TARGET_NOT_FOUND — an agent could not tell "you typed
// it wrong" from "we do not track it", and acting on a misdiagnosis is how an
// autonomous run burns its budget. Invalid syntax is now a distinct, typed
// outcome from valid-but-untracked.
//
// Pure and dependency-free (core invariant): parsing only, no lookups.
// ---------------------------------------------------------------------------

/** Instagram's public username rule: letters, digits, dots, underscores, ≤ 30. */
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);

export type AccountReferenceForm = "USERNAME" | "HANDLE" | "PROFILE_URL";

export interface AccountReference {
  /** Normalized username: no leading "@", no URL parts. */
  username: string;
  /** How the caller expressed it — kept so surfaces can say what they parsed. */
  form: AccountReferenceForm;
}

export type AccountReferenceParse =
  | { ok: true; reference: AccountReference }
  | { ok: false; message: string };

function invalidUsername(raw: string): AccountReferenceParse {
  return {
    ok: false,
    message:
      `"${raw}" is not a valid Instagram username or profile URL ` +
      "(letters, digits, dots, underscores; max 30 characters).",
  };
}

export function parseAccountReference(raw: string): AccountReferenceParse {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, message: "A username or profile reference is required." };
  }

  const hasScheme = /^https?:\/\//i.test(trimmed);
  const looksLikeUrl =
    hasScheme || /^(www\.|m\.)?instagram\.com(\/|$)/i.test(trimmed.toLowerCase());

  if (looksLikeUrl) {
    let url: URL;
    try {
      url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    } catch {
      return { ok: false, message: `"${trimmed}" is not a parseable profile URL.` };
    }
    const host = url.hostname.toLowerCase();
    if (!INSTAGRAM_HOSTS.has(host)) {
      return {
        ok: false,
        message: `"${trimmed}" points at ${host}, not instagram.com — a profile URL must be on instagram.com.`,
      };
    }
    const segments = url.pathname.split("/").filter((s) => s !== "");
    if (segments.length !== 1) {
      return {
        ok: false,
        message:
          segments.length === 0
            ? `"${trimmed}" contains no username (expected https://www.instagram.com/<username>).`
            : `"${trimmed}" has ${segments.length} path segments; a profile URL is instagram.com/<username>. ` +
              "Pass just the username to avoid guessing which part identifies the account.",
      };
    }
    const username = segments[0] as string;
    if (!USERNAME_RE.test(username)) return invalidUsername(trimmed);
    return { ok: true, reference: { username, form: "PROFILE_URL" } };
  }

  const isHandle = trimmed.startsWith("@");
  const username = isHandle ? trimmed.slice(1) : trimmed;
  if (!USERNAME_RE.test(username)) return invalidUsername(trimmed);
  return { ok: true, reference: { username, form: isHandle ? "HANDLE" : "USERNAME" } };
}
