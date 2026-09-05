// Outbound-link guard for provider-supplied URLs (story link stickers,
// profile external URLs, post permalinks). Only http(s) may render as a
// clickable link: a compromised or malformed provider payload must never
// become a javascript:/data: href (XSS) or a server-fetched resource (SSRF —
// the app never fetches these URLs itself; rendering is user-initiated
// navigation only, with rel=noreferrer+noopener so no referrer leaks).
export function isSafeExternalUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // Credential-bearing URLs (user:pass@host) must never render as links:
  // navigation would send the embedded secret to the destination.
  if (url.username !== "" || url.password !== "") return false;
  return true;
}
