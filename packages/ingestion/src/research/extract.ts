// ---------------------------------------------------------------------------
// Deterministic HTML → candidate claims.
//
// The extractor reads FOUR fixed field families and nothing else:
//   1. JSON-LD (schema.org Person/Organization blocks)
//   2. <meta> tags (og:site_name, description phrases)
//   3. mailto: links (public contact channels)
//   4. anchor hrefs to other public profiles (related-account assertions)
//
// It never parses page prose into values. That is the prompt-injection
// boundary: a page can write "IGNORE ALL PREVIOUS INSTRUCTIONS" all it
// likes — no code path reads that text into a predicate or a value, so the
// worst an adversarial page can do is fail to produce candidates. Anything
// the page does produce still passes the claims validation gate upstream
// (predicate registry, value/excerpt caps, refusals) before storage.
//
// Regex-on-HTML is a deliberate trade-off: the fields above are so
// conventionally formatted that patterns are stable, the inputs are bounded
// (512KB cap upstream), and a full DOM parser would be a new dependency for
// no honest gain. A malformed page yields ZERO candidates, never a wrong
// one — the failure mode is silence.
// ---------------------------------------------------------------------------

import {
  type ClaimPredicate,
  type ResearchCandidate,
  type ResearchExtractionMethod,
} from "@igtrack/core";

/** Strip tags and collapse whitespace for excerpt use. */
// The handful of entities HTML actually uses in text and attribute values.
// An excerpt is QUOTED EVIDENCE an operator reads and a claim value can be an
// organization's name — both must be faithful, so `Smith &amp; Wesson` is
// stored as `Smith & Wesson`, never as its entity form. Deliberately not a
// general HTML entity decoder: this file parses with regexes on purpose, and a
// half-parser that resolves unknown entities would be worse than none.
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|#39|#x27|nbsp);/gi,
    (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity,
  );
}

// Exported for the Phase-3 benchmark's support checks (apps/cli/src/bench.ts):
// an external verifier must decode EXACTLY what extraction decoded, or a
// faithful `Smith &amp; Wesson` source would look unsupported to the checker.
export { decodeEntities };

function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

interface RawCandidate {
  predicate: ClaimPredicate;
  value: string;
  excerpt: string;
  field: string;
  method: ResearchExtractionMethod;
  uncertainty?: string;
}

// --- JSON-LD -----------------------------------------------------------------

interface JsonLdNode {
  "@type"?: string | string[];
  name?: unknown;
  email?: unknown;
  sameAs?: unknown;
  address?: unknown;
  knowsAbout?: unknown;
}

function jsonLdTypes(node: JsonLdNode): string[] {
  const raw = node["@type"];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  if (typeof raw === "string") return [raw];
  return [];
}

function asString(value: unknown): string | null {
  // Decode here too, not only in textOf: a JSON-LD string is still HTML
  // embedded in a page, and `{"name":"Smith &amp; Wesson"}` is a real thing
  // real sites emit. A claim value is stored and compared normalized, so the
  // entity form would become a permanently misspelled organization name.
  return typeof value === "string" && value.trim() !== ""
    ? decodeEntities(value.trim())
    : null;
}

function addressLocality(node: JsonLdNode): { value: string; excerpt: string } | null {
  const address = node.address;
  if (typeof address !== "object" || address === null) return null;
  const record = address as Record<string, unknown>;
  const locality = asString(record.addressLocality) ?? asString(record.addressRegion);
  if (locality === null) return null;
  const parts = [
    asString(record.streetAddress),
    locality,
    asString(record.addressCountry),
  ].filter((p): p is string => p !== null);
  return { value: locality, excerpt: `address: ${parts.join(", ")}` };
}

function extractJsonLd(html: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  const scriptRe = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const block = match[1];
    if (block === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue; // malformed JSON-LD is common; skip, never guess
    }
    const nodes: unknown[] = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])
        ? (parsed as { "@graph": unknown[] })["@graph"]
        : [parsed];
    for (const raw of nodes) {
      if (typeof raw !== "object" || raw === null) continue;
      const node = raw as JsonLdNode;
      const types = jsonLdTypes(node).map((t) => t.toLowerCase());
      const isOrg = types.some(
        (t) => t.includes("organization") || t === "localbusiness" || t.includes("corporation"),
      );
      const isPerson = types.some((t) => t.includes("person"));
      if (!isOrg && !isPerson) continue;

      if (isOrg) {
        const name = asString(node.name);
        if (name !== null) {
          out.push({
            predicate: "ORGANIZATION_NAME",
            value: clamp(name, 200),
            excerpt: `ld+json name: ${clamp(name, 200)}`,
            field: "ld+json Organization.name",
            method: "JSONLD",
          });
        }
        const kind = types.find((t) => t !== "organization" && t !== "person");
        if (kind !== undefined) {
          out.push({
            predicate: "ORGANIZATION_KIND",
            value: clamp(kind, 100),
            excerpt: `ld+json @type: ${kind}`,
            field: "ld+json Organization.@type",
            method: "JSONLD",
          });
        }
        const located = addressLocality(node);
        if (located !== null) {
          out.push({
            predicate: "LOCATION_STATED",
            value: clamp(located.value, 200),
            excerpt: clamp(located.excerpt, 400),
            field: "ld+json Organization.address.addressLocality",
            method: "JSONLD",
          });
        }
        const knowsAbout = asString(node.knowsAbout);
        if (knowsAbout !== null) {
          out.push({
            predicate: "INDUSTRY_OR_FIELD",
            value: clamp(knowsAbout, 200),
            excerpt: `ld+json knowsAbout: ${clamp(knowsAbout, 200)}`,
            field: "ld+json Organization.knowsAbout",
            method: "JSONLD",
          });
        }
      }

      if (isPerson) {
        // A person's jobTitle would be an EMPLOYMENT claim — the predicate
        // registry refuses that from every source, so the extractor records
        // the refusal-shaped silence rather than smuggling it through under
        // a synonym. Nothing is proposed; nothing is stored.
        const email = asString(node.email);
        if (email !== null && email.includes("@")) {
          out.push({
            predicate: "CONTACT_CHANNEL",
            value: clamp(email, 200),
            excerpt: `ld+json email: ${clamp(email, 200)}`,
            field: "ld+json Person.email",
            method: "JSONLD",
          });
        }
      }

      // sameAs profile links (org or person): related-account assertions.
      const sameAs = node.sameAs;
      const sameAsList = Array.isArray(sameAs) ? sameAs : sameAs !== undefined ? [sameAs] : [];
      for (const entry of sameAsList) {
        const url = asString(entry);
        if (url === null || !/^https?:\/\//i.test(url)) continue;
        // Same profile-only policy as anchor links:
        // the JSON-LD path used to bypass both checks.
        if (!isProfileAssertionHref(url)) continue;
        out.push({
          predicate: "RELATED_ACCOUNT_ASSERTED",
          value: clamp(url, 300),
          excerpt: `ld+json sameAs: ${clamp(url, 300)}`,
          field: "ld+json sameAs[]",
          method: "JSONLD",
        });
      }
    }
  }
  return out;
}

// --- Meta tags ----------------------------------------------------------------

function extractMeta(html: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  const tagRe = /<meta\s[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    const name = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (name === undefined || content === undefined || content.trim() === "") continue;
    if (name === "og:site_name") {
      out.push({
        predicate: "ORGANIZATION_NAME",
        value: clamp(content.trim(), 200),
        excerpt: `meta og:site_name: ${clamp(content.trim(), 200)}`,
        field: "meta og:site_name",
        method: "META_TAG",
        uncertainty:
          "og:site_name is the site's own label; it may be a personal site name rather than a legal organization name.",
      });
    }
    // No `description` mining here, on purpose. A previous version regexed a
    // "specialization phrase" out of marketing prose and it produced values
    // like `that&` from the sentence "…a company that's working to build…":
    // phrase-mining prose is prose interpretation, which this module's
    // contract forbids, and a junk value in the ledger is worse than an
    // absent one. INDUSTRY_OR_FIELD arrives from structured data instead —
    // JSON-LD `knowsAbout`/`industry`/`category` above — where the page
    // states it as a field rather than implying it in a sentence.
  }
  return out;
}

// --- Links ---------------------------------------------------------------------

const SOCIAL_HOST_PATTERNS: readonly string[] = [
  "instagram.com",
  "youtube.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "linkedin.com",
  "github.com",
  "mastodon.",
  "bsky.app",
];

// Share/compose endpoints on social hosts are NOT profile assertions: a
// "share this article" button (`x.com/intent/post?text=…`,
// `linkedin/shareArticle?…`, `twitter.com/share?text=…`) names no profile —
// Measured on live pages: such URLs were stored
// as RELATED_ACCOUNT_ASSERTED purely because they live on social hosts. The
// Instagram-family refusal also applies to EVERY extraction path: the
// anchor walk enforced it, the ld+json sameAs[] branch did not, and a
// facebook.com sameAs link was stored because of that asymmetry.
function isProfileAssertionHref(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host.includes("instagram.com") || host.includes("facebook.com")) return false;
  const segments = url.pathname
    .toLowerCase()
    .split("/")
    .filter((part) => part !== "");
  return !segments.some((part) =>
    ["intent", "share", "sharearticle", "sharer", "sharer.php", "share.php", "compose"].includes(part),
  );
}

function extractLinks(html: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  const hrefRe = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  const seenValues = new Set<string>();
  while ((match = hrefRe.exec(html)) !== null) {
    const href = match[1]?.trim() ?? "";
    const anchorText = clamp(textOf(match[2] ?? ""), 120);
    if (href.toLowerCase().startsWith("mailto:")) {
      const email = href.slice("mailto:".length).split("?")[0]?.trim() ?? "";
      if (email.includes("@") && !seenValues.has(email.toLowerCase())) {
        seenValues.add(email.toLowerCase());
        out.push({
          predicate: "CONTACT_CHANNEL",
          value: clamp(email, 200),
          excerpt:
            anchorText !== ""
              ? `link "${anchorText}" → ${clamp(email, 200)}`
              : `mailto: ${clamp(email, 200)}`,
          field: "a[href^=mailto:]",
          method: "MAILTO",
        });
      }
      continue;
    }
    if (!/^https?:\/\//i.test(href)) continue;
    let host: string;
    try {
      host = new URL(href).hostname.toLowerCase();
    } catch {
      continue;
    }
    const isSocial = SOCIAL_HOST_PATTERNS.some((pattern) => host.includes(pattern));
    if (!isSocial) continue;
    // Profile-only policy: Instagram-family URLs are platform data and
    // share/intent endpoints name no profile — neither may become a
    // related-account claim from a third-party page.
    if (!isProfileAssertionHref(href)) continue;
    if (!seenValues.has(href)) {
      seenValues.add(href);
      out.push({
        predicate: "RELATED_ACCOUNT_ASSERTED",
        value: clamp(href, 300),
        excerpt:
          anchorText !== ""
            ? `link "${anchorText}" → ${clamp(href, 300)}`
            : `link → ${clamp(href, 300)}`,
        field: "a[href] (public profile host)",
        method: "LINK_HREF",
        uncertainty:
          "A link asserts the page's author points at this profile; it does not prove account ownership.",
      });
    }
  }
  return out;
}

// --- Public entry point ------------------------------------------------------------

export interface ExtractedPage {
  title: string | null;
  candidates: ResearchCandidate[];
}

/** Page title for the document record (not a claim — pages are not sources of names). */
export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match?.[1] === undefined) return null;
  const title = textOf(match[1]);
  return title === "" ? null : clamp(title, 300);
}

/**
 * Extract candidates from one fetched page. Deduplicated on
 * (predicate, value); first occurrence wins (JSON-LD before meta before
 * links, in that call order) because structured data beats annotation.
 */
export function extractCandidates(html: string): ExtractedPage {
  const all = [...extractJsonLd(html), ...extractMeta(html), ...extractLinks(html)];
  const seen = new Set<string>();
  const candidates: RawCandidate[] = [];
  for (const candidate of all) {
    const key = `${candidate.predicate} ${candidate.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return {
    title: extractTitle(html),
    candidates: candidates.map(
      (candidate): ResearchCandidate => ({
        predicate: candidate.predicate,
        value: candidate.value,
        excerpt: candidate.excerpt,
        field: candidate.field,
        method: candidate.method,
        directlyDocumented: true,
        ...(candidate.uncertainty !== undefined ? { uncertainty: candidate.uncertainty } : {}),
      }),
    ),
  };
}
