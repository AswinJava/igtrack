// ---------------------------------------------------------------------------
// The prompt layer's brain: turn one free-form sentence into an explicit plan.
//
// Deterministic on purpose. IGTrack has no in-process model, so "understand the
// user" here means: score the words against a closed intent registry, pull the
// entities a request is made of (handle, time window, limit, evidence id), and
// say out loud which assumptions were made. When nothing matches, the plan says
// so and offers the operations that exist — it never invents one.
//
// This file is pure (no database, no network, no clock), so every rule below is
// pinned by unit tests.
// ---------------------------------------------------------------------------

export const ASK_INTENTS = [
  "guide",
  "capabilities",
  "status",
  "targets",
  "track",
  "untrack",
  "scan",
  "work",
  "investigate",
  "changes",
  "relationships",
  "insights",
  "tags",
  "dossier",
  "research",
  "plan",
  "evidence",
  "audit",
  "lookup",
  "stories",
  "public",
  "post",
  "report",
  "reports",
  "recent",
  "audience",
  "export",
  "digest",
] as const;

export type AskIntent = (typeof ASK_INTENTS)[number];

export interface AskPlan {
  /** Exactly what the user typed. */
  prompt: string;
  /** Every operation this request asks for, in execution order. */
  intents: AskIntent[];
  primary: AskIntent;
  username: string | null;
  evidenceId: string | null;
  /** A duration (7d, 24h) or an ISO date, in the form the operations accept. */
  since: string | null;
  limit: number | null;
  /** Report calendar period when the question names one (weekly, monthly...). */
  period: "weekly" | "monthly" | "quarterly" | "yearly" | null;
  /** Export kind when the question names the rows it wants exported. */
  exportKind: string | null;
  urls: string[];
  assumptions: string[];
  /** True when at least one step needs the database. */
  needsDb: boolean;
  /** True when a required handle is still missing. */
  needsUsername: boolean;
  /** False for intents that only explain the command to run (stories, public, post, untrack). */
  executable: boolean;
  confidence: "high" | "medium" | "low";
  examples: string[];
}

export interface ParseOptions {
  /** Usernames this deployment already tracks, so "the account" can resolve. */
  knownTargets?: readonly string[];
}

export const ASK_EXAMPLES = [
  "investigate @aurora.wilde",
  "what changed on @aurora.wilde in the last 7 days?",
  "who does @aurora.wilde interact with most?",
  "who did @aurora.wilde recently follow?",
  "give me the weekly report for @aurora.wilde",
  "who doesn't follow @aurora.wilde back?",
  "export @aurora.wilde's posts as csv",
  "show me the insights for @aurora.wilde",
  "what do we know about @aurora.wilde?",
  "which posts is @aurora.wilde tagged in?",
  "track @somehandle and run the first scan",
  "what can I ask you?",
  "what's the status of this deployment?",
  "what should I do next for @aurora.wilde?",
];

// ---------------------------------------------------------------------------
// Intent registry. A phrase match is worth more than a single word, and any
// intent can add keywords so plurals, gerunds and typos still resolve.
// ---------------------------------------------------------------------------

interface IntentSpec {
  intent: AskIntent;
  phrases: Array<{ re: RegExp; weight: number }>;
  keywords: Array<{ word: string; weight: number }>;
}

/** Tie-break order when two intents score the same: the more specific action wins. */
const PRIORITY: readonly AskIntent[] = [
  "untrack",
  "track",
  "work",
  "scan",
  "investigate",
  "reports",
  "report",
  "recent",
  "export",
  "audience",
  "digest",
  "changes",
  "relationships",
  "insights",
  "tags",
  "dossier",
  "research",
  "plan",
  "evidence",
  "audit",
  "lookup",
  "targets",
  "status",
  "capabilities",
  "post",
  "stories",
  "public",
  "guide",
];

const SPECS: readonly IntentSpec[] = [
  {
    intent: "untrack",
    phrases: [
      { re: /\b(?:remove|delete|untrack|unwatch|stop (?:tracking|watching|monitoring))\b/, weight: 4 },
    ],
    keywords: [
      { word: "remove", weight: 1 },
      { word: "delete", weight: 1 },
      { word: "untrack", weight: 3 },
    ],
  },
  {
    intent: "track",
    phrases: [
      { re: /\btrack (?:this |the )?(?:account|profile|user|handle|target)?\b/, weight: 4 },
      { re: /\b(?:start|begin) (?:tracking|watching|monitoring)\b/, weight: 4 },
      { re: /\badd (?:this |the )?(?:account|profile|user|handle|target)\b/, weight: 3 },
      { re: /\bwatch (?:this |the )?(?:account|profile|user|handle)\b/, weight: 3 },
      { re: /\bmonitor (?:this |the )?(?:account|profile|user|handle)\b/, weight: 3 },
    ],
    keywords: [
      { word: "track", weight: 3 },
      { word: "tracking", weight: 3 },
      { word: "watch", weight: 2 },
      { word: "monitor", weight: 2 },
    ],
  },
  {
    intent: "work",
    phrases: [
      { re: /\b(?:run|drain|process) (?:the )?(?:worker|queue|jobs?)\b/, weight: 4 },
      { re: /\bworker\b/, weight: 2 },
    ],
    keywords: [
      { word: "worker", weight: 3 },
      { word: "queue", weight: 2 },
      { word: "jobs", weight: 2 },
    ],
  },
  {
    intent: "scan",
    phrases: [
      { re: /\b(?:scan|refresh|sync|re-?scan) (?:it|this|the account|@?\w+)? ?(?:now|again)?\b/, weight: 4 },
      { re: /\bcheck (?:it )?now\b/, weight: 4 },
      { re: /\bupdate (?:the )?(?:data|record|observations)\b/, weight: 4 },
      { re: /\brun (?:a |the )?(?:scan|first scan)\b/, weight: 4 },
    ],
    keywords: [
      { word: "scan", weight: 3 },
      { word: "refresh", weight: 3 },
      { word: "recheck", weight: 3 },
      { word: "rescan", weight: 3 },
      { word: "sync", weight: 2 },
    ],
  },
  {
    intent: "investigate",
    phrases: [
      { re: /\binvestigat(?:e|ion|ing)\b/, weight: 4 },
      { re: /\blook (?:in)?to\b/, weight: 4 },
      { re: /\bdig into\b/, weight: 4 },
      { re: /\bfind out (?:about|on)\b/, weight: 4 },
      { re: /\bdeep dive\b/, weight: 4 },
      { re: /\b(?:full|complete) (?:report|dossier|profile|investigation)\b/, weight: 4 },
      { re: /\bwho (?:is|are) (?:this|the account)\b/, weight: 3 },
      { re: /\btell me (?:everything )?about\b/, weight: 3 },
      { re: /\bwhat do (?:we|you) know about\b/, weight: 3 },
      { re: /\beverything (?:about|on)\b/, weight: 3 },
      { re: /\bbackground (?:check|on)\b/, weight: 3 },
    ],
    keywords: [
      { word: "investigate", weight: 3 },
      { word: "investigation", weight: 3 },
      { word: "analyze", weight: 2 },
      { word: "analyse", weight: 2 },
      { word: "profile", weight: 1 },
    ],
  },
  {
    intent: "changes",
    phrases: [
      { re: /\bwhat(?:'s| is| has)? (?:new|changed|happened)\b/, weight: 5 },
      { re: /\bwhat changed\b/, weight: 5 },
      { re: /\bchanges?\b/, weight: 3 },
      { re: /\bdiff(?:erence)?\b/, weight: 3 },
      { re: /\bnew (?:posts?|followers?|stories?|media)\b/, weight: 3 },
      { re: /\b(?:gained|lost) (?:followers?|posts?)\b/, weight: 4 },
      { re: /\bactivity\b/, weight: 3 },
      { re: /\breadily?\s+recent\b/, weight: 2 },
    ],
    keywords: [
      { word: "changed", weight: 3 },
      { word: "changes", weight: 3 },
      { word: "change", weight: 2 },
      { word: "activity", weight: 2 },
      { word: "updates", weight: 1 },
      { word: "happened", weight: 2 },
      { word: "gained", weight: 2 },
      { word: "lost", weight: 2 },
      { word: "new", weight: 1 },
    ],
  },
  {
    intent: "relationships",
    phrases: [
      { re: /\brelationships?\b/, weight: 4 },
      { re: /\bconnections?\b/, weight: 3 },
      { re: /\binteract(?:s|ions?)?\b/, weight: 3 },
      { re: /\bwho (?:do(?:es)? (?:they|she|he|it) )?(?:talk|interact|engage)\b/, weight: 4 },
      { re: /\bclose to\b/, weight: 3 },
      { re: /\bwho (?:tags|mentions) (?:them|this account)\b/, weight: 3 },
      { re: /\b(?:top|closest|strongest) (?:accounts|people|connections|relationships)\b/, weight: 4 },
      { re: /\bmutuals?\b/, weight: 3 },
      { re: /\bnetwork\b/, weight: 2 },
    ],
    keywords: [
      { word: "relationships", weight: 3 },
      { word: "relationship", weight: 2 },
      { word: "connections", weight: 2 },
      { word: "interactions", weight: 2 },
      { word: "affiliated", weight: 2 },
    ],
  },
  {
    intent: "insights",
    phrases: [
      { re: /\binsights?\b/, weight: 4 },
      { re: /\b(?:reach|impressions|engagement|views)\b/, weight: 3 },
      { re: /\b(?:analytics|metrics|stats|demographics)\b/, weight: 3 },
      { re: /\bfollowers? count\b/, weight: 3 },
      { re: /\b(?:audience|growth)\b/, weight: 2 },
    ],
    keywords: [
      { word: "insights", weight: 3 },
      { word: "insight", weight: 2 },
      { word: "reach", weight: 2 },
      { word: "impressions", weight: 2 },
      { word: "engagement", weight: 2 },
      { word: "analytics", weight: 2 },
      { word: "metrics", weight: 2 },
      { word: "demographics", weight: 2 },
      { word: "growth", weight: 1 },
    ],
  },
  {
    intent: "tags",
    phrases: [
      { re: /\btagged (?:in|by|media|posts?)\b/, weight: 4 },
      { re: /\bwho (?:tags|tagged)\b/, weight: 4 },
      { re: /\btags?\b/, weight: 2 },
    ],
    keywords: [
      { word: "tagged", weight: 3 },
      { word: "tags", weight: 2 },
      { word: "tag", weight: 1 },
    ],
  },
  {
    intent: "dossier",
    phrases: [
      { re: /\bdossier\b/, weight: 4 },
      { re: /\b(?:stored|saved|recorded) (?:data|record|profile)\b/, weight: 4 },
      { re: /\bwhat (?:is )?on record\b/, weight: 3 },
      // A count question is answered from the latest stored observation,
      // not by launching a fresh investigation.
      { re: /\bhow many (?:followers?|following|posts?) (?:does|do) @?[a-z0-9._]{2,30} have\b/, weight: 6 },
      { re: /\b(?:follower|following|post) counts?\b/, weight: 4 },
    ],
    keywords: [
      { word: "dossier", weight: 3 },
      { word: "stored", weight: 1 },
      { word: "recorded", weight: 1 },
    ],
  },
  {
    intent: "research",
    phrases: [
      { re: /\bclaims?\b/, weight: 4 },
      { re: /\bsources?\b/, weight: 3 },
      { re: /\bcitations?\b/, weight: 4 },
      { re: /\bcited\b/, weight: 3 },
      { re: /\b(?:web|online) (?:says|found|research)\b/, weight: 4 },
      { re: /\bpublic[- ]web\b/, weight: 3 },
      { re: /\bcontradictions?\b/, weight: 3 },
    ],
    keywords: [
      { word: "claims", weight: 3 },
      { word: "claim", weight: 2 },
      { word: "sources", weight: 2 },
      { word: "citations", weight: 2 },
      { word: "contradictions", weight: 2 },
    ],
  },
  {
    intent: "plan",
    phrases: [
      { re: /\bnext steps?\b/, weight: 4 },
      { re: /\bwhat should i do (?:next|now)\b/, weight: 4 },
      { re: /\bwhat'?s next\b/, weight: 4 },
      { re: /\bwhere do i (?:go|start) (?:next|now)\b/, weight: 3 },
    ],
    keywords: [
      { word: "plan", weight: 3 },
      { word: "roadmap", weight: 2 },
    ],
  },
  {
    intent: "evidence",
    phrases: [
      { re: /\bevidence\b/, weight: 4 },
      { re: /\bprovenance\b/, weight: 4 },
      { re: /\baudit trail\b/, weight: 4 },
      { re: /\bwhere did (?:this|that|it) come from\b/, weight: 4 },
      { re: /\bhow do you know\b/, weight: 3 },
      { re: /\blineage\b/, weight: 3 },
    ],
    keywords: [
      { word: "evidence", weight: 3 },
      { word: "provenance", weight: 3 },
      { word: "lineage", weight: 2 },
      { word: "proof", weight: 2 },
    ],
  },
  {
    intent: "audit",
    phrases: [
      { re: /\baudit\b/, weight: 4 },
      { re: /\b(?:fact[- ]?check|double[- ]check)\b/, weight: 4 },
      { re: /\bis (?:this|the data|it) (?:real|accurate|true)\b/, weight: 4 },
      { re: /\bverify\b/, weight: 3 },
    ],
    keywords: [
      { word: "audit", weight: 3 },
      { word: "verify", weight: 2 },
    ],
  },
  {
    intent: "lookup",
    phrases: [
      { re: /\blook ?up\b/, weight: 4 },
      { re: /\bdoes (?:this|the) account exist\b/, weight: 4 },
      { re: /\bprobe\b/, weight: 3 },
      { re: /\bcheck (?:the )?account\b/, weight: 3 },
    ],
    keywords: [
      { word: "lookup", weight: 3 },
      { word: "probe", weight: 2 },
    ],
  },
  {
    intent: "targets",
    phrases: [
      { re: /\btracked (?:accounts?|profiles?|targets?)\b/, weight: 5 },
      { re: /\bwho am i (?:tracking|watching)\b/, weight: 5 },
      { re: /\blist (?:the )?(?:targets?|accounts|profiles)\b/, weight: 4 },
      { re: /\b(?:my )?watchlist\b/, weight: 4 },
      { re: /\btargets?\b/, weight: 2 },
    ],
    keywords: [
      { word: "targets", weight: 3 },
      { word: "watchlist", weight: 3 },
      { word: "tracked", weight: 2 },
    ],
  },
  {
    intent: "status",
    phrases: [
      { re: /\bis (?:it|this|the system) (?:working|up|healthy)\b/, weight: 4 },
      { re: /\b(?:system )?health\b/, weight: 3 },
      { re: /\b(?:check|show) (?:the )?status\b/, weight: 4 },
      { re: /\bhow is (?:this|it) (?:configured|set up)\b/, weight: 4 },
    ],
    keywords: [
      { word: "status", weight: 3 },
      { word: "health", weight: 2 },
      { word: "doctor", weight: 3 },
      { word: "diagnose", weight: 3 },
      { word: "provider", weight: 1 },
      { word: "configured", weight: 2 },
    ],
  },
  {
    intent: "capabilities",
    phrases: [
      { re: /\bwhat (?:can'?t|cannot|can not) (?:you|igtrack) do\b/, weight: 4 },
      { re: /\bcapabilit(?:y|ies)\b/, weight: 4 },
      { re: /\blimitations?\b/, weight: 3 },
      { re: /\bis (?:this|it) legal\b/, weight: 4 },
      { re: /\bwhat data (?:can|do) (?:you|igtrack)\b/, weight: 4 },
    ],
    keywords: [
      { word: "capabilities", weight: 3 },
      { word: "limitations", weight: 2 },
      { word: "legal", weight: 1 },
    ],
  },
  {
    intent: "stories",
    phrases: [
      { re: /\bstories\b/, weight: 4 },
      { re: /\bstory mentions?\b/, weight: 4 },
      { re: /\bhighlights?\b/, weight: 3 },
    ],
    keywords: [
      { word: "stories", weight: 3 },
      { word: "story", weight: 2 },
      { word: "highlights", weight: 2 },
      { word: "highlight", weight: 2 },
    ],
  },
  {
    intent: "public",
    phrases: [
      { re: /\bpublic (?:page|profile|data)\b/, weight: 4 },
      { re: /\bwithout (?:a )?login\b/, weight: 4 },
      { re: /\blogged[- ]out\b/, weight: 4 },
      { re: /\banonymous(?:ly)?\b/, weight: 3 },
    ],
    keywords: [{ word: "public", weight: 1 }],
  },
  {
    intent: "post",
    phrases: [
      // A permalink is unambiguous: /p/, /reel/ or /tv/ followed by a shortcode.
      { re: /\binstagram\.com\/(?:[a-z0-9._]+\/)?(?:p|reel|tv)\/[a-z0-9_-]+/, weight: 7 },
      { re: /\b(?:read|open|show|fetch|inspect|look at|check) (?:me )?(?:this|the|that) (?:post|reel|video)\b/, weight: 5 },
    ],
    keywords: [],
  },
  {
    intent: "report",
    phrases: [
      { re: /\b(?:weekly|monthly|quarterly|yearly|annual|periodic|period) (?:report|summary|recap)\b/, weight: 5 },
      { re: /\breport (?:for|on|about)\b/, weight: 4 },
      { re: /\b(?:make|create|compose|generate|give me|show me) (?:a |the )?(?:weekly|monthly|quarterly|yearly|periodic|period)? ?report\b/, weight: 4 },
      { re: /\b(?:summar(?:y|ize|ise)|recap)\b/, weight: 3 },
    ],
    keywords: [
      { word: "report", weight: 3 },
      { word: "summary", weight: 2 },
      { word: "summarize", weight: 2 },
      { word: "summarise", weight: 2 },
      { word: "recap", weight: 2 },
    ],
  },
  {
    intent: "reports",
    phrases: [
      { re: /\b(?:list|show|which|what) (?:the )?(?:reports|periods|windows)\b/, weight: 5 },
      { re: /\b(?:available|stored|past) (?:reports|periods)\b/, weight: 4 },
      { re: /\breports\b/, weight: 4 },
    ],
    keywords: [
      { word: "reports", weight: 3 },
      { word: "periods", weight: 2 },
    ],
  },
  {
    intent: "recent",
    phrases: [
      // A recency adverb is required: "who does @x follow" is a roster
      // question (audience), "who did @x recently follow" is an activity one.
      { re: /\b(?:who|what) (?:did|does|do|has|have) @?[a-z0-9._]{2,30} (?:recently|just|lately|newly) (?:follow|start(?:ed)? following|unfollow|stop(?:ped)? following)\b/, weight: 6 },
      { re: /\b(?:who|what) (?:did|does|do|has|have) @?[a-z0-9._]{2,30} (?:follow|start(?:ed)? following|unfollow|stop(?:ped)? following) (?:recently|just|lately|newly|today|this week)\b/, weight: 6 },
      { re: /\b(?:recently|just|newly) (?:followed|follows?|started following|unfollowed|unfollows?)\b/, weight: 5 },
      { re: /\brecent (?:follows?|followers?|following|unfollows?|unfollowers?)\b/, weight: 5 },
      { re: /\bnew (?:follows?|followers?|following|unfollows?|unfollowers?)\b/, weight: 5 },
      { re: /\b(?:following|follower) updates?\b/, weight: 5 },
      { re: /\bunfollow(?:ed|ers?)\b/, weight: 3 },
    ],
    keywords: [
      { word: "unfollowed", weight: 3 },
      { word: "unfollowers", weight: 3 },
      { word: "unfollows", weight: 2 },
    ],
  },
  {
    intent: "audience",
    phrases: [
      { re: /\b(?:don['’]?t|do not|doesn['’]?t|not) follow(?:ing)? (?:@?[a-z0-9._]{2,30} )?back\b/, weight: 5 },
      { re: /\bfollow(?:s|ing)? (?:@?[a-z0-9._]{2,30} )?back\b/, weight: 4 },
      { re: /\bmutual (?:followers?|follows?|accounts?|connections?)\b/, weight: 5 },
      { re: /\bmutuals?\b/, weight: 4 },
      { re: /\baudience\b/, weight: 3 },
      { re: /\bwho (?:follows|unfollows) (?:me|you|them|us|@?[a-z0-9._]{2,30})\b/, weight: 5 },
      { re: /\bwho (?:did|does|do) @?[a-z0-9._]{2,30} follow\b/, weight: 5 },
      { re: /\bwho (?:are|r) (?:my |the )?followers\b/, weight: 4 },
      { re: /\bfollower (?:list|roster)\b/, weight: 4 },
    ],
    keywords: [
      { word: "audience", weight: 3 },
      { word: "mutuals", weight: 3 },
      { word: "mutual", weight: 2 },
    ],
  },
  {
    intent: "export",
    phrases: [
      { re: /\bexport(?:s|ed|ing)?\b/, weight: 5 },
      { re: /\b(?:download|csv|spreadsheet)\b/, weight: 4 },
      { re: /\b(?:save|write) (?:it |them |the rows )?(?:to|as) (?:a )?(?:file|csv|json)\b/, weight: 4 },
    ],
    keywords: [
      { word: "export", weight: 3 },
      { word: "csv", weight: 3 },
      { word: "download", weight: 2 },
      { word: "spreadsheet", weight: 2 },
    ],
  },
  {
    intent: "digest",
    phrases: [
      { re: /\bdigest\b/, weight: 5 },
      { re: /\b(?:daily|weekly) (?:brief|digest)\b/, weight: 5 },
      { re: /\bbrief(?:ing)?\b/, weight: 3 },
    ],
    keywords: [
      { word: "digest", weight: 3 },
      { word: "brief", weight: 2 },
    ],
  },
  {
    intent: "guide",
    phrases: [
      { re: /\bwhat can (?:you|igtrack|i ask|this do)\b/, weight: 5 },
      { re: /\bhow (?:do|does|can) (?:i|you|it) (?:use|work|start|begin|connect|install)\b/, weight: 5 },
      { re: /\bgetting started\b/, weight: 4 },
      { re: /\bwhat is igtrack\b/, weight: 4 },
      { re: /\b(?:show me )?examples?\b/, weight: 3 },
      { re: /\btutorial\b/, weight: 3 },
      { re: /\bguide\b/, weight: 3 },
      { re: /\bhelp\b/, weight: 3 },
    ],
    keywords: [
      { word: "help", weight: 2 },
      { word: "guide", weight: 2 },
      { word: "tutorial", weight: 2 },
    ],
  },
];

/** Words that are never a handle, however they are cased or punctuated. */
const STOP_WORDS = new Set<string>([
  "a", "an", "the", "this", "that", "these", "those", "here", "there",
  "my", "your", "our", "their", "his", "her", "its", "them", "they", "it",
  "me", "us", "we", "i", "you", "he", "she", "him", "who", "whom", "whose",
  "account", "accounts", "profile", "profiles", "user", "users", "username",
  "handle", "handles", "target", "targets", "page", "pages", "person",
  "please", "now", "today", "tonight", "yesterday", "tomorrow", "recently",
  "lately", "last", "past", "previous", "next", "this", "week", "weeks",
  "month", "months", "year", "years", "day", "days", "hour", "hours",
  "minute", "minutes", "time", "times", "since", "between", "from", "to",
  "top", "first", "latest", "only", "all", "any", "some", "more", "most",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "show", "tell", "give", "get", "list", "find", "search", "look", "see",
  "know", "want", "need", "help", "work", "works", "working", "data", "info",
  "information", "details", "understand", "explain", "run", "runs", "use",
  "using", "make", "made", "do", "does", "did", "done", "can", "could",
  "should", "would", "will", "shall", "may", "might", "must", "is", "are",
  "was", "were", "be", "been", "being", "have", "has", "had", "and", "or",
  "but", "not", "no", "yes", "if", "then", "than", "so", "such", "very",
  "just", "also", "about", "on", "of", "for", "in", "into", "with", "by",
  "at", "as", "up", "out", "over", "under", "again", "once", "both", "each",
  "few", "many", "much", "other", "same", "own", "say", "says", "said",
  "new", "old", "real", "true", "false", "public", "private", "anonymous",
  "everything", "something", "anything", "nothing", "record", "records",
  "stored", "saved", "recorded", "followers", "following", "posts", "post",
  "activity", "changes", "change", "changed", "insights", "relationships",
  "connections", "tags", "tagged", "stories", "story", "highlights",
  "highlight", "claims", "claim", "sources", "source", "evidence", "status",
  "health", "scan", "scans", "refresh", "track", "tracking", "watch",
  "watching", "monitor", "monitoring", "investigate", "investigation",
  "lookup", "audit", "dossier", "research", "plan", "capabilities",
  "analysis", "report", "reports", "summary", "overview", "handle", "url", "link",
  "export", "exports", "digest", "audience", "mutuals", "csv", "spreadsheet",
  "brief", "recap", "summarize", "summarise", "weekly", "monthly", "quarterly",
  "yearly", "annual", "period", "periods", "reporting",
  "https", "http", "www", "com", "org", "net", "instagram", "ig",
  "hello", "hi", "hey", "thanks", "thank", "cheers", "morning", "evening",
]);

const RESERVED = new Set<string>(STOP_WORDS);
for (const spec of SPECS) {
  for (const keyword of spec.keywords) RESERVED.add(keyword.word);
}

function words(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** Levenshtein distance <= 1, without building the full matrix. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

function keywordScore(token: string, keyword: string): number {
  if (token === keyword) return 1;
  if (keyword.length >= 4 && token.startsWith(keyword)) return 0.75;
  if (token.length >= 4 && keyword.startsWith(token)) return 0.6;
  if (keyword.length >= 5 && token.length >= 5 && withinOneEdit(token, keyword)) return 0.5;
  if (
    keyword.length >= 6 &&
    token.length >= 6 &&
    commonPrefixLength(token, keyword) >= keyword.length - 2
  ) {
    return 0.35;
  }
  return 0;
}

interface Scored {
  intent: AskIntent;
  score: number;
  explicit: boolean;
}

function scoreIntents(prompt: string): Scored[] {
  const lower = prompt.toLowerCase();
  const tokens = words(prompt);
  const scored: Scored[] = [];
  for (const spec of SPECS) {
    let score = 0;
    let explicit = false;
    for (const phrase of spec.phrases) {
      if (phrase.re.test(lower)) {
        score += phrase.weight;
        explicit = true;
      }
    }
    for (const keyword of spec.keywords) {
      for (const token of tokens) {
        score += keywordScore(token, keyword.word) * keyword.weight;
      }
    }
    if (score > 0) scored.push({ intent: spec.intent, score, explicit });
  }
  return scored;
}

function priorityOf(intent: AskIntent): number {
  const index = PRIORITY.indexOf(intent);
  return index === -1 ? PRIORITY.length : index;
}

function sortScored(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  return priorityOf(a.intent) - priorityOf(b.intent);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

function cleanHandle(raw: string): string | null {
  let value = raw.trim().toLowerCase().replace(/^@/, "");
  value = value.replace(/[.,;:!?)\]}>'"]+$/, "");
  // "vishnu_vichuz_'s posts" names the account, not a different handle.
  value = value.replace(/['’]s$/, "");
  if (value.length < 2 || value.length > 30) return null;
  if (!/^[a-z0-9][a-z0-9._]*$/.test(value)) return null;
  if (!/[a-z]/.test(value)) return null;
  if (RESERVED.has(value)) return null;
  // An evidence id is not an account, however handle-shaped it looks.
  if (/^ev_[0-9a-f]{8,}$/.test(value)) return null;
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractKnownTarget(prompt: string, knownTargets: readonly string[]): string | null {
  const lower = prompt.toLowerCase();
  const sorted = [...knownTargets]
    .map((name) => name.toLowerCase())
    .filter((name) => name.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (new RegExp(`(?<![a-z0-9._])${escapeRegExp(name)}(?![a-z0-9._])`).test(lower)) {
      return name;
    }
  }
  // "aurora" can name the tracked account "aurora.wilde" when that prefix is
  // unambiguous among the operator's targets.
  const bases = new Map<string, string[]>();
  for (const name of sorted) {
    const base = name.split(/[._]/)[0] ?? "";
    if (base.length < 3) continue;
    const list = bases.get(base);
    if (list === undefined) bases.set(base, [name]);
    else list.push(name);
  }
  for (const [base, names] of bases) {
    if (names.length !== 1) continue;
    const name = names[0];
    if (
      name !== undefined &&
      new RegExp(`(?<![a-z0-9._])${escapeRegExp(base)}(?![a-z0-9._])`).test(lower)
    ) {
      return name;
    }
  }
  return null;
}

const CUE_WORDS =
  /(?<![a-z0-9])(about|of|for|on|into|handle|username|account|called|named|profile|target|user|investigate|investigating|track|tracking|watch|watching|monitor|monitoring|lookup|audit|scan|research|dossier|analyze|analyse|check)\b/gi;

function extractHandle(prompt: string, knownTargets: readonly string[]): string | null {
  // An explicit @handle or profile URL always wins; a tracked name elsewhere in
  // the sentence must never override the account the user actually typed.
  const at = /(?<![a-z0-9._-])@([a-z0-9._]{2,30})/i.exec(prompt);
  if (at?.[1] !== undefined) {
    const cleaned = cleanHandle(at[1]);
    if (cleaned !== null) return cleaned;
  }

  const profileUrl = /instagram\.com\/([a-z0-9._]{2,30})/i.exec(prompt);
  if (profileUrl?.[1] !== undefined) {
    const cleaned = cleanHandle(profileUrl[1]);
    if (cleaned !== null) return cleaned;
  }

  const fromKnown = extractKnownTarget(prompt, knownTargets);
  if (fromKnown !== null) return fromKnown;

  const lower = prompt.toLowerCase();
  CUE_WORDS.lastIndex = 0;
  for (let cue = CUE_WORDS.exec(lower); cue !== null; cue = CUE_WORDS.exec(lower)) {
    const after = lower.slice(cue.index + cue[0].length);
    const candidates = after.split(/[^a-z0-9._@]+/).filter((token) => token.length > 0);
    for (let i = 0; i < Math.min(candidates.length, 4); i += 1) {
      const token = candidates[i] ?? "";
      const stripped = token.replace(/^@/, "");
      if (stripped.length === 0) continue;
      if (RESERVED.has(stripped)) continue;
      const cleaned = cleanHandle(stripped);
      if (cleaned !== null) return cleaned;
    }
  }

  const rawTokens = prompt.split(/\s+/).filter((token) => token.length > 0);
  for (const token of rawTokens) {
    if (token.includes("@") || token.toLowerCase().startsWith("http")) continue;
    const stripped = token.replace(/^[("']+|[)"',.;:!?]+$/g, "");
    if (!stripped.includes(".") && !stripped.includes("_")) continue;
    const cleaned = cleanHandle(stripped);
    if (cleaned !== null) return cleaned;
  }

  // A one- or two-word prompt is allowed to be a bare handle ("aurora"), but a
  // longer sentence is not: in "hello there" every plain word would otherwise
  // look like a username, and guessing an account is worse than asking.
  const plain = words(prompt);
  if (plain.length <= 2) {
    for (const token of plain) {
      if (token.length < 3) continue;
      if (RESERVED.has(token)) continue;
      const cleaned = cleanHandle(token);
      if (cleaned !== null) return cleaned;
    }
  }

  return null;
}

function extractSince(prompt: string): { since: string | null; assumption: string | null } {
  const lower = prompt.toLowerCase();

  const numeric = /\b(?:last|past|previous)\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|s|m|h|d|w|mo|y)\b/.exec(lower);
  if (numeric?.[1] !== undefined) {
    const amount = Number(numeric[1]);
    const unit = numeric[2] ?? "days";
    const suffix = unit.startsWith("sec") || unit === "s"
      ? "s"
      : unit.startsWith("min")
        ? "m"
        : unit.startsWith("h")
          ? "h"
          : unit.startsWith("d")
            ? "d"
            : unit.startsWith("w")
              ? "d"
              : unit.startsWith("mo")
                ? "d"
                : "d";
    const multiplier = unit.startsWith("w") ? 7 : unit.startsWith("mo") ? 30 : unit.startsWith("y") ? 365 : 1;
    if (Number.isFinite(amount) && amount > 0) {
      return { since: `${amount * multiplier}${suffix}`, assumption: null };
    }
  }

  const single = /\b(?:last|past|previous)\s+(second|minute|hour|day|week|month|year)\b/.exec(lower);
  if (single?.[1] !== undefined) {
    const unit = single[1];
    const map: Record<string, string> = {
      second: "1s",
      minute: "1m",
      hour: "1h",
      day: "1d",
      week: "7d",
      month: "30d",
      year: "365d",
    };
    return { since: map[unit] ?? "7d", assumption: null };
  }

  if (/\btoday\b|\btonight\b/.test(lower)) return { since: "1d", assumption: null };
  if (/\byesterday\b/.test(lower)) return { since: "2d", assumption: "yesterday read as the previous 48 hours" };
  if (/\bthis week\b/.test(lower)) return { since: "7d", assumption: null };
  if (/\blast week\b/.test(lower)) return { since: "14d", assumption: "last week read as the previous 14 days" };
  if (/\bthis month\b/.test(lower)) return { since: "30d", assumption: null };
  if (/\blast month\b/.test(lower)) return { since: "60d", assumption: "last month read as the previous 60 days" };
  if (/\bthis year\b/.test(lower)) return { since: "365d", assumption: null };
  if (/\blast year\b/.test(lower)) return { since: "730d", assumption: "last year read as the previous 730 days" };

  const iso = /\bsince\s+(\d{4}-\d{2}-\d{2})\b/.exec(lower);
  if (iso?.[1] !== undefined) return { since: iso[1], assumption: null };

  if (/\brecently\b|\blately\b|\brecent\b/.test(lower)) {
    return { since: "7d", assumption: "recently read as the last 7 days" };
  }
  return { since: null, assumption: null };
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, fifty: 50,
};

const TIME_UNIT_AFTER = String.raw`(?!\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b)`;

function extractLimit(prompt: string): number | null {
  const lower = prompt.toLowerCase();
  // "last 7 days" is a window, not a row limit; the time-unit lookahead keeps
  // the two apart before the window is even parsed.
  const numbered = new RegExp(String.raw`\b(?:top|first|latest|last|limit(?:ed)?(?: to)?|only|show(?: me)?)\s+(\d{1,3})\b${TIME_UNIT_AFTER}`).exec(lower);
  if (numbered?.[1] !== undefined) {
    const value = Number(numbered[1]);
    if (value >= 1) return Math.min(value, 200);
  }
  const counted = /\b(\d{1,3})\s+(?:results?|rows?|items?|accounts?|people|posts?|changes?|events?|comments?|mentions?)\b/.exec(lower);
  if (counted?.[1] !== undefined) {
    const value = Number(counted[1]);
    if (value >= 1) return Math.min(value, 200);
  }
  const worded = new RegExp(String.raw`\b(?:top|first|latest|last)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|fifty)\b${TIME_UNIT_AFTER}`).exec(lower);
  if (worded?.[1] !== undefined) {
    return Math.min(WORD_NUMBERS[worded[1]] ?? 10, 200);
  }
  return null;
}

function extractEvidenceId(prompt: string): string | null {
  const match = /\b(ev_[0-9a-f]{8,})\b/i.exec(prompt);
  return match?.[1]?.toLowerCase() ?? null;
}

/** The calendar period a report question names, if any. */
function extractPeriod(prompt: string): AskPlan["period"] {
  const lower = prompt.toLowerCase();
  if (/\bquarter(?:ly)?\b|\bq[1-4]\b/.test(lower)) return "quarterly";
  if (/\byear(?:ly)?\b|\bannual(?:ly)?\b/.test(lower)) return "yearly";
  if (/\bmonth(?:ly)?\b/.test(lower)) return "monthly";
  if (/\bweek(?:ly)?\b/.test(lower)) return "weekly";
  return null;
}

const EXPORT_KIND_MATCHERS: ReadonlyArray<{ re: RegExp; kind: string }> = [
  { re: /\baudience\b|\bmutuals?\b/, kind: "audience" },
  { re: /\bfollowers?\b/, kind: "followers" },
  { re: /\bfollowing\b/, kind: "following" },
  { re: /\bcomments?\b/, kind: "comments" },
  { re: /\bstories\b|\bstory\b/, kind: "stories" },
  { re: /\bmentions?\b/, kind: "mentions" },
  { re: /\btags?\b|\btagged\b/, kind: "tagged" },
  { re: /\binsights?\b|\bmetrics?\b/, kind: "insights" },
  { re: /\bposts?\b|\bmedia\b/, kind: "posts" },
  { re: /\breport\b/, kind: "report" },
  { re: /\bactivity\b|\bchanges?\b|\bevents?\b/, kind: "activity" },
];

/** Which stored surface an export question names. Null means "the default". */
function extractExportKind(prompt: string): string | null {
  const lower = prompt.toLowerCase();
  for (const matcher of EXPORT_KIND_MATCHERS) {
    if (matcher.re.test(lower)) return matcher.kind;
  }
  return null;
}

function extractUrls(prompt: string): string[] {
  const matches = prompt.match(/\bhttps?:\/\/[^\s"'<>]+/gi) ?? [];
  return matches
    .map((url) => url.replace(/[),.;:!?]+$/, ""))
    .filter((url) => url.length > 0);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const DB_FREE = new Set<AskIntent>(["guide", "capabilities", "untrack", "stories", "public", "post"]);
const ADVISORY = new Set<AskIntent>(["untrack", "stories", "public", "post"]);
const NEEDS_HANDLE = new Set<AskIntent>([
  "track", "untrack", "investigate", "relationships", "insights", "tags",
  "dossier", "research", "plan", "audit", "lookup", "stories", "public",
  "report", "reports", "recent", "audience", "export",
]);
const WRITE_INTENTS = new Set<AskIntent>(["track", "untrack", "scan", "work"]);
const READ_ORDER: readonly AskIntent[] = [
  "investigate", "report", "reports", "recent", "audience", "export", "digest", "changes",
  "relationships", "insights", "tags", "dossier", "research", "plan", "evidence",
  "audit", "lookup", "targets", "status",
];

function canonicalOrder(intents: AskIntent[]): AskIntent[] {
  return [...intents].sort((a, b) => {
    const aWrite = WRITE_INTENTS.has(a) ? 0 : 1;
    const bWrite = WRITE_INTENTS.has(b) ? 0 : 1;
    if (aWrite !== bWrite) return aWrite - bWrite;
    if (aWrite === 0) return PRIORITY.indexOf(a) - PRIORITY.indexOf(b);
    return READ_ORDER.indexOf(a) - READ_ORDER.indexOf(b);
  });
}

function guidePlan(prompt: string, assumptions: string[], confidence: AskPlan["confidence"]): AskPlan {
  return {
    prompt,
    intents: ["guide"],
    primary: "guide",
    username: null,
    evidenceId: null,
    since: null,
    limit: null,
    period: null,
    exportKind: null,
    urls: [],
    assumptions,
    needsDb: false,
    needsUsername: false,
    executable: true,
    confidence,
    examples: ASK_EXAMPLES,
  };
}

export function planAsk(prompt: string, options: ParseOptions = {}): AskPlan {
  const trimmed = prompt.trim();
  if (trimmed === "") {
    return guidePlan(trimmed, ["The prompt was empty, so I am showing what I can do."], "low");
  }

  const knownTargets = options.knownTargets ?? [];
  const scored = scoreIntents(trimmed).sort(sortScored);
  const username = extractHandle(trimmed, knownTargets);
  const evidence = extractEvidenceId(trimmed);
  const time = extractSince(trimmed);
  const limit = extractLimit(trimmed);
  const urls = extractUrls(trimmed);
  const period = extractPeriod(trimmed);
  const exportKind = extractExportKind(trimmed);
  const assumptions: string[] = [];
  if (time.assumption !== null) assumptions.push(time.assumption);

  let primary: AskIntent;
  let confidence: AskPlan["confidence"];
  if (scored.length === 0) {
    if (username !== null) {
      primary = "investigate";
      confidence = "medium";
      assumptions.push(
        "No specific operation matched, so I ran the full investigation — the primary workflow — and reported what it found.",
      );
    } else {
      return guidePlan(trimmed, assumptions, "low");
    }
  } else {
    const first = scored[0];
    primary = first?.intent ?? "guide";
    confidence = first?.explicit === true ? "high" : "medium";
  }

  if (primary === "changes" && time.since === null) {
    assumptions.push("No time window was given, so changes are read from the last 7 days.");
  }
  if (primary === "changes" && username === null && knownTargets.length > 0) {
    assumptions.push("No account was named, so this covers every tracked account.");
  }
  if (primary === "investigate" && username === null && knownTargets.length === 1) {
    const only = knownTargets[0];
    if (only !== undefined) {
      assumptions.push(`No account was named, so I used your only tracked account, @${only}.`);
    }
  }
  if (primary === "recent") {
    if (username === null && knownTargets.length === 1) {
      const only = knownTargets[0];
      if (only !== undefined) {
        assumptions.push(`No account was named, so I used your only tracked account, @${only}.`);
      }
    }
    if (time.since === null) {
      assumptions.push(
        "No window was given, so recent activity is read from the stored roster baseline forward.",
      );
    }
    assumptions.push(
      "Recent follows are a baseline-then-diff: times are when this ledger first saw the account, not the Instagram follow time.",
    );
  }
  if (primary === "report" && period === null) {
    assumptions.push("No period was named, so the current week is reported.");
  }
  if (primary === "export" && exportKind === null) {
    assumptions.push("No row kind was named, so the activity feed is exported.");
  }
  if (primary === "digest" && time.since === null) {
    assumptions.push("No window was given, so the digest covers the last 7 days.");
  }

  const chosen = new Set<AskIntent>();
  const add = (intent: AskIntent): void => {
    chosen.add(intent);
  };

  // Writes requested in the same sentence ("track @x and scan it") run first.
  for (const item of scored) {
    if (WRITE_INTENTS.has(item.intent) && item.score >= 2.5) add(item.intent);
  }
  add(primary);
  if (!WRITE_INTENTS.has(primary)) {
    // A second, explicitly phrased read ("what changed and who do they talk
    // to") is kept: the user asked for both, so both run. Keyword-only noise
    // is not.
    let extras = 0;
    for (const item of scored) {
      if (extras >= 2) break;
      if (item.intent === primary) continue;
      if (WRITE_INTENTS.has(item.intent)) continue;
      if (!item.explicit || item.score < 3.5) continue;
      if (ADVISORY.has(item.intent)) continue;
      add(item.intent);
      extras += 1;
    }
  }

  // An investigation already produces the stored dossier, the research report
  // and the next-step plan. Keeping them would run the same read twice.
  if (chosen.has("investigate") && primary !== "dossier" && primary !== "research" && primary !== "plan") {
    chosen.delete("dossier");
    chosen.delete("research");
    chosen.delete("plan");
  }
  if (chosen.size === 0) add(primary);

  const intents = canonicalOrder([...chosen]);
  const effectivePrimary = intents.includes(primary) ? primary : (intents[0] ?? "guide");
  const needsDb = intents.some((intent) => !DB_FREE.has(intent));
  const needsUsername = username === null && intents.some((intent) => NEEDS_HANDLE.has(intent));

  return {
    prompt: trimmed,
    intents,
    primary: effectivePrimary,
    username,
    evidenceId: evidence,
    since: time.since,
    limit,
    period: intents.some((intent) => intent === "report" || intent === "reports") ? period : null,
    exportKind: intents.includes("export") ? exportKind : null,
    urls,
    assumptions,
    needsDb,
    needsUsername,
    executable: !intents.every((intent) => ADVISORY.has(intent)),
    confidence,
    examples: ASK_EXAMPLES,
  };
}

/** The one-line restatement shown to the user before any work runs. */
export function describePlan(plan: AskPlan): string {
  const intents = plan.intents.join(" + ");
  const handle = plan.username === null ? "" : ` @${plan.username}`;
  const window = plan.since === null ? "" : ` · last ${plan.since}`;
  const period = plan.period === null ? "" : ` · ${plan.period}`;
  return `${intents}${handle}${period}${window}`;
}
