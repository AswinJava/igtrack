# phone-photo-verdict.md
Verification date: 2026-10-16. Scope: (A) does a "Serlac Games" / phone→photo project exist on this machine; (B) does the "phone number → Internet photos" tool class exist at all. All web sources fetched live this session.

## (a) Part A — machine sweep

Commands run, with output, empty included:

1. `rg -i --no-messages -l serlac C:\Users\aswin\Desktop` → 1 hit: `Desktop\reference-repos\cognee\cognee-frontend\public\images\backgrounds\build-smarter-agents-your-way-background.svg`. Match context: `...r4FxqKQSOP6WSWm0YBhRKILiA73mgMusIWb8cPIHSERlaCkAIAUfQnpOAlJz/UiAg+OEmTmjwvoqSY0HIB2v6h` — a substring inside base64 image data (coincidence). Command hit its 120 s timeout on the large tree after printing this hit.
2. `rg -i -l --max-depth 3 serlac C:\Users\aswin\Desktop` → exit 1, no output.
3. `rg -i --no-messages -l serlac C:\Users\aswin\Documents` → exit 1, no output.
4. `rg -i --no-messages -l serlac C:\Users\aswin\Downloads` → exit 1, no output.
5. `rg -i --no-messages -l serlac C:\Users\aswin\.agent-reach` → exit 1, no output.
6. `Get-ChildItem C:\Users\aswin\AppData\Roaming -Recurse -Depth 1 -Force | Where-Object Name -match serlac` → no output.
7. Depth-1 listing `C:\Users\aswin` → no serlac*; closest names: `serpaix`, `serpaix-qa`, `.serpaix-study` (plus `com.serpaix.desktop*` in Roaming).
8. Contents of `C:\Users\aswin\serpaix` and `.serpaix-study` → `plan-posts`, `post-2-serpaix`, `post-5-ai-habits`, `recruitment-2026-10-09` → a content/social-posting project, not a photo lookup.
9. Depth-1 listing `C:\` → inetpub, OEM, PerfLogs, Program Files, Program Files (x86), tmp, Users, Windows → no alternative dev root (no C:\dev, no C:\src).

**Verdict A: NOT PRESENT.** No "Serlac Games", no serlac-named or serlac-containing project, and no phone→photo tool exists on this machine. The only text hit is a base64 coincidence inside a third-party asset in a reference repo; the similar-sounding `serpaix` folders are an unrelated content project. Nothing was deleted or modified.

## (b) Part B — candidates, verified against live repo/site

| candidate | input | output | method | license | status (2026-10-16) | does "phone→photos" describe it? |
|---|---|---|---|---|---|---|
| PimEyes (pimeyes.com) | a face photo (upload/camera) | web pages where that face appears; site states open web only, excluding social media and video platforms | commercial face-recognition index (10B+ images claimed), paid subscriptions | proprietary | live commercial, 500k+ users claimed | No — direction is photo→web, no phone input anywhere |
| FaceCheck.ID | a face photo | matches in indexed faces (social media, mugshots, offenders, news, video) with match-confidence tiers | proprietary index, paid credits, "Face Search API" | proprietary (entity: Tech Solutions, Belize) | live commercial | No — no phone input |
| GHunt (github.com/mxrch/GHunt) | Google account email or Gaia ID; requires the operator's own Google cookies | Google account data — recent commits reference cover-photo and photos fields; modules include email, gaia, drive, geolocate, spiderdal | undocumented Google endpoints via authenticated session | AGPL-3.0 | 19.7k stars; active, last commit 2026-04-10 | No — email/Google ID in, no phone; cookie-authenticated scraping is unlawful for an official-API-only toolkit |
| PhoneInfoga (sundowndev/phoneinfoga) | international phone number | country, carrier, line type; footprint scanners (web dorks, external APIs). README anti-features: no real-time tracking, no precise location, no verified data | local parsing + external APIs/search engines | GPL-3.0 | 18.2k stars; README: "stable but unmaintained ... could be archived at any time"; last commits 2026-08 (tests) | No — no photos, by design |
| Ignorant (megadose/ignorant) | phone number (country code + number) | JSON per service (Amazon, Instagram, Snapchat): exists true/false | probes those services' registration/login flows — account enumeration | GPL-3.0 | 2.1k stars, 8 commits total, stale | No |
| Epieos (epieos.com) | email **or phone** | "all social media profiles" linked to the input; exact fields not verifiable without a paid account | closed proprietary service; claims no target notification, no query logging | proprietary | live commercial (free tier + paid) | Closest in shape (phone in, linked profiles out) but not a photo search, and the lookups are not official APIs — not adoptable |
| Whapi-Cloud/whatsapp-get-profile-pictures | phone numbers (CSV) | WhatsApp profile picture(s) | paid Whapi.Cloud **unofficial** WhatsApp API; repo topics include "scraper"; README advises pauses "to reduce the risk of getting blocked by WhatsApp" | none stated | 13 stars, 4 commits, created 2024-09-30 | The only literal "phone→photo" repo found — one platform, one profile picture, unofficial access |
| any other repo claiming "find photos by phone number" | — | — | web search found none; "photo search" repos found (rclip, semantic-photo-search) are local/semantic image search, unrelated to phone numbers | — | — | No |
| "Serlac Games" | — | — | web search returned no such project. Only near-names: Selak Entertainment (LA event company), S.E.R Games (Dhaka), Serp Games (browser games) — and phone-lookup SEO spam domains | — | — | Not a real known project; the name matches nothing |

Marketing note: the "photos by phone" phrasing circulating on the web comes from data-broker pages (e.g. zabasearch: "a phone number search can find names, photos, locations, and social media profiles") — vendor marketing for paid PII databases, not a lawful tool contract.

## (c) Bottom line

- "Phone number → Internet photos" is real as **marketing** and as a **paid data-broker promise**, not as a lawful, reproducible tool. Verified candidates split into three groups, none of which is that: face search (photo in, no phone), phone OSINT (phone in, no photos), platform profile-pic fetchers (unofficial access). The single literal repo match (Whapi) is one platform, one picture, and violates the official-API boundary.
- **No capability in this class is honest for IGTrack to adopt.** Official Instagram APIs offer no phone→account route at all, so for a phone number the only true answer is UNAVAILABLE with reason "no official route exists" — the same shape as the refusals already recorded in FOUNDING §14. Building or scaffolding it would be a founding decision requiring evidence, and the evidence above (a paid scrapers-only ecosystem) argues against.
- The one transferable idea is rhetorical, not technical: honest tools in this class state anti-features explicitly (PhoneInfoga: "does not allow to 'track' a phone or its owner"). IGTrack already has the stronger, machine-checked equivalent in its capability registry and `whyUnavailable` reasons. **Adopt nothing; keep this file as the citation when the claim resurfaces.**
