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

// ---------------------------------------------------------------------------
// Post references — a post link is the other input beside a profile.
//
// A post link identifies one media item by shortcode, not an account: the
// shortcode carries no owner, so callers must not try to derive a username
// from it. The parser accepts the three canonical URL kinds Instagram uses
// (/p/, /reel/, /tv/) plus the legacy profile-prefixed form, and refuses
// story, tag and explore links with a message that names the right surface.
// ---------------------------------------------------------------------------

export type PostReferenceKind = "p" | "reel" | "tv";

export interface PostReference {
  shortcode: string;
  kind: PostReferenceKind;
  /** Present so a caller can echo how the reference was expressed. */
  form: "POST_URL";
}

export type PostReferenceParse =
  | { ok: true; reference: PostReference }
  | { ok: false; message: string };

/** Instagram shortcodes are URL-safe base64-ish; 5–64 bounds every observed form. */
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,64}$/;
const POST_KINDS: ReadonlySet<string> = new Set(["p", "reel", "tv"]);

const POST_URL_EXPECTED =
  "expected https://www.instagram.com/p/<shortcode>/, " +
  "https://www.instagram.com/reel/<shortcode>/ or " +
  "https://www.instagram.com/tv/<shortcode>/";

export function parsePostReference(raw: string): PostReferenceParse {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, message: "A post URL is required." };
  }

  const hasScheme = /^https?:\/\//i.test(trimmed);
  const looksLikeUrl =
    hasScheme || /^(www\.|m\.)?instagram\.com(\/|$)/i.test(trimmed.toLowerCase());
  if (!looksLikeUrl) {
    return {
      ok: false,
      message:
        `"${trimmed}" is not an Instagram post URL — ${POST_URL_EXPECTED}. ` +
        "A bare shortcode cannot identify its owner; paste the full link, or use " +
        "`igtrack public <username>` for a profile.",
    };
  }

  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, message: `"${trimmed}" is not a parseable post URL.` };
  }
  const host = url.hostname.toLowerCase();
  if (!INSTAGRAM_HOSTS.has(host)) {
    return {
      ok: false,
      message: `"${trimmed}" points at ${host}, not instagram.com — a post URL must be on instagram.com.`,
    };
  }

  const segments = url.pathname.split("/").filter((s) => s !== "");
  // Canonical: /p/<code>, /reel/<code>, /tv/<code>.
  // Legacy profile-prefixed: /<username>/p/<code> (the same media item).
  let kind: string | undefined;
  let shortcode: string | undefined;
  if (segments.length === 2 && POST_KINDS.has(segments[0] as string)) {
    kind = segments[0];
    shortcode = segments[1];
  } else if (
    segments.length === 3 &&
    USERNAME_RE.test(segments[0] as string) &&
    POST_KINDS.has(segments[1] as string)
  ) {
    kind = segments[1];
    shortcode = segments[2];
  } else if (segments.length === 1) {
    return {
      ok: false,
      message:
        `"${trimmed}" is a profile URL, not a post URL — use "igtrack public <username>" ` +
        "for a profile, or paste the link to one of its posts.",
    };
  } else if (segments[0] === "stories") {
    return {
      ok: false,
      message:
        `"${trimmed}" is a story link, not a post link. Story observation is ` +
        '`igtrack anonstories <username>` (public aggregator) or `igtrack public <username>`.',
    };
  } else {
    return { ok: false, message: `"${trimmed}" is not an Instagram post URL — ${POST_URL_EXPECTED}.` };
  }

  const reference = { shortcode: shortcode as string, kind: kind as PostReferenceKind, form: "POST_URL" as const };
  if (!SHORTCODE_RE.test(reference.shortcode)) {
    return {
      ok: false,
      message: `"${trimmed}" carries "${reference.shortcode}", which is not a possible Instagram shortcode (5–64 URL-safe characters).`,
    };
  }
  return { ok: true, reference };
}
