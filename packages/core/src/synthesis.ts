// ---------------------------------------------------------------------------
// Deterministic derivation over stored text and timestamps (DEEP-ACCOUNT-
// INTELLIGENCE Phase 2: themes and cadence).
//
// These are pure functions: no clock, no I/O, no randomness. Two runs over the
// same rows produce byte-identical output, which is what lets the research
// report promise determinism. Every figure is scoped to the corpus it was
// computed from and the report states that corpus — a term frequency over 12
// stored captions describes those 12 captions and nothing more. An empty corpus
// yields an empty result; callers must say why, never present it as "silence".
// ---------------------------------------------------------------------------

/** Ordering is count-descending, then term-ascending, so output is total. */
export interface SynthesisTerm {
  term: string;
  count: number;
}

export interface ThemesResult {
  /** Captions that carried non-blank text — the corpus every count is over. */
  captionRows: number;
  terms: SynthesisTerm[];
  hashtags: SynthesisTerm[];
}

export interface CadenceResult {
  /** Distinct non-null publish timestamps the figures were computed from. */
  timestampRows: number;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  /**
   * Median of the gaps between consecutive distinct publish timestamps, in
   * days, rounded to one decimal. Null below two timestamps: a cadence needs
   * at least one interval, and inventing one from a single post would be a
   * guess. This is the provider's published time, not our first-observed time.
   */
  medianGapDays: number | null;
}

export const THEME_TERM_LIMIT = 10;
export const THEME_MIN_TOKEN_LENGTH = 3;

// Deliberately small: a large stopword list silently changes what counts as a
// theme between versions, and themes here are "what the stored text says", not
// an NLP pipeline. Words are reported with their counts so a reader can judge.
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "this", "that", "are", "was", "were", "you",
  "your", "our", "from", "have", "has", "had", "not", "but", "all", "any",
  "can", "out", "who", "what", "when", "where", "how", "why", "its", "into",
  "over", "just", "about", "after", "also", "they", "their", "them", "then",
  "than", "there", "here", "been", "will", "would", "could", "should", "one",
  "two", "new", "now", "get", "got", "day", "today", "tomorrow", "yesterday",
  "still", "more", "most", "some", "very", "much",
]);

// A token starts with a letter, so bare years and ordinals ("2026", "3rd"
// -> "rd") carry no theme signal and stay out.
const TOKEN_RE = /[\p{L}][\p{L}\p{N}']*/gu;
const HASHTAG_RE = /#([\p{L}\p{N}_]{2,})/gu;

function tally(counts: Map<string, number>, limit: number): SynthesisTerm[] {
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
    .slice(0, limit);
}

export function deriveThemes(
  captions: ReadonlyArray<string | null | undefined>,
  options: { limit?: number } = {},
): ThemesResult {
  const present = captions.filter(
    (caption): caption is string => typeof caption === "string" && caption.trim() !== "",
  );
  const terms = new Map<string, number>();
  const hashtags = new Map<string, number>();
  for (const caption of present) {
    for (const match of caption.matchAll(TOKEN_RE)) {
      const token = match[0].toLocaleLowerCase();
      if (token.length < THEME_MIN_TOKEN_LENGTH) continue;
      if (STOPWORDS.has(token)) continue;
      terms.set(token, (terms.get(token) ?? 0) + 1);
    }
    for (const match of caption.matchAll(HASHTAG_RE)) {
      const tag = match[1];
      if (tag === undefined) continue;
      const normalized = tag.toLocaleLowerCase();
      hashtags.set(normalized, (hashtags.get(normalized) ?? 0) + 1);
    }
  }
  const limit = options.limit ?? THEME_TERM_LIMIT;
  return { captionRows: present.length, terms: tally(terms, limit), hashtags: tally(hashtags, limit) };
}

export function deriveCadence(
  timestamps: ReadonlyArray<Date | null | undefined>,
): CadenceResult {
  const times = [
    ...new Set(
      timestamps
        .filter((t): t is Date => t instanceof Date && !Number.isNaN(t.getTime()))
        .map((t) => t.getTime()),
    ),
  ].sort((a, b) => a - b);
  if (times.length === 0) {
    return { timestampRows: 0, firstPublishedAt: null, lastPublishedAt: null, medianGapDays: null };
  }
  const first = new Date(times[0] as number);
  const last = new Date(times[times.length - 1] as number);
  if (times.length < 2) {
    return {
      timestampRows: 1,
      firstPublishedAt: first.toISOString(),
      lastPublishedAt: last.toISOString(),
      medianGapDays: null,
    };
  }
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    gaps.push(((times[i] as number) - (times[i - 1] as number)) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 1
      ? (gaps[mid] as number)
      : ((gaps[mid - 1] as number) + (gaps[mid] as number)) / 2;
  return {
    timestampRows: times.length,
    firstPublishedAt: first.toISOString(),
    lastPublishedAt: last.toISOString(),
    medianGapDays: Math.round(median * 10) / 10,
  };
}
