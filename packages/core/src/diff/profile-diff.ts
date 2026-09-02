export interface ProfileFieldSet {
  username?: string | undefined;
  displayName?: string | undefined;
  bio?: string | undefined;
  profilePicUrl?: string | undefined;
  externalUrl?: string | undefined;
  followerCount?: number | undefined;
  followingCount?: number | undefined;
  postCount?: number | undefined;
  isVerified?: boolean | undefined;
  isPrivate?: boolean | undefined;
}

export type ProfileField = keyof ProfileFieldSet;

export type ProfileFieldValue = string | number | boolean | null;

export interface ProfileFieldChange {
  field: ProfileField;
  oldValue: ProfileFieldValue;
  newValue: ProfileFieldValue;
}

const FIELD_ORDER: ProfileField[] = [
  "username",
  "displayName",
  "bio",
  "profilePicUrl",
  "externalUrl",
  "followerCount",
  "followingCount",
  "postCount",
  "isVerified",
  "isPrivate",
];

/**
 * Instagram CDN URLs rotate their host and query string (signature tokens,
 * `_nc_oc`, `oh`, `_nc_gid`) while the image itself is unchanged. Comparing
 * raw URLs therefore records a "profile picture change" every few hours. The
 * path is the stable identity of the image: a real new photo gets a new path.
 */
export function profilePicUrlIdentity(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    const cut = value.search(/[?#]/);
    return cut === -1 ? value : value.slice(0, cut);
  }
}

/**
 * Read-side twin of the diff rule: a stored profilePicUrl change that differs
 * only in CDN host/query is an artifact of URL rotation, not a profile edit.
 * Historical rows that predate the normalization stay in the ledger; views
 * that ask "what changed" must not surface them as changes.
 */
export function isMaterialProfileFieldChange(
  field: string,
  from: string | null,
  to: string | null,
): boolean {
  if (field !== "profilePicUrl" || from === null || to === null) return true;
  return profilePicUrlIdentity(from) !== profilePicUrlIdentity(to);
}

function comparableFieldValue(field: ProfileField, value: ProfileFieldValue): ProfileFieldValue {
  return field === "profilePicUrl" && typeof value === "string"
    ? profilePicUrlIdentity(value)
    : value;
}

export function diffProfileFields(
  previous: ProfileFieldSet,
  next: ProfileFieldSet,
): ProfileFieldChange[] {
  const changes: ProfileFieldChange[] = [];
  for (const field of FIELD_ORDER) {
    const oldValue: ProfileFieldValue = previous[field] ?? null;
    const newValue: ProfileFieldValue = next[field] ?? null;
    if (comparableFieldValue(field, oldValue) !== comparableFieldValue(field, newValue)) {
      changes.push({ field, oldValue, newValue });
    }
  }
  return changes;
}
