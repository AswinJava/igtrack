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

export function diffProfileFields(
  previous: ProfileFieldSet,
  next: ProfileFieldSet,
): ProfileFieldChange[] {
  const changes: ProfileFieldChange[] = [];
  for (const field of FIELD_ORDER) {
    const oldValue: ProfileFieldValue = previous[field] ?? null;
    const newValue: ProfileFieldValue = next[field] ?? null;
    if (oldValue !== newValue) {
      changes.push({ field, oldValue, newValue });
    }
  }
  return changes;
}
