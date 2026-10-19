// ---------------------------------------------------------------------------
// Local configuration readiness for the graph provider.
//
// Why this exists: presence is not validity. `igtrack doctor` used to answer
// "are the graph credentials set?" — and a fresh checkout ships
// `PASTE_IG_USER_ID_HERE` and friends, so three literal template markers read
// as a ready deployment. That is the same class of lie as drawing absence as
// zero: the check answered an easy question and the operator heard the
// important one. A configuration that cannot authenticate must never be
// reported as configured.
//
// Hard rules, each pinned by tests:
//   * no variable VALUE ever appears in anything returned here — the
//     assessment names the variable and the corrective action, never contents;
//   * no network request is made: readiness is decided from the environment
//     alone, so `doctor` stays safe to run with a bad token;
//   * a value that clears every local check is NOT_VERIFIED, never "valid" —
//     only an accepted API call proves a credential works.
//
// Detection is shape-based, not length-based: a short real value and a long
// placeholder both exist, so heuristics key on template syntax
// (`PASTE_..._HERE`, `<TOKEN>`, filler runs) that a real credential never
// contains.
// ---------------------------------------------------------------------------

export const ConfigState = {
  /** Unset, or empty after trimming. */
  MISSING: "MISSING",
  /** Set, but the value is the template marker the example file ships with. */
  PLACEHOLDER: "PLACEHOLDER",
  /** Set, but structurally impossible for this variable. */
  INVALID_CONFIGURATION: "INVALID_CONFIGURATION",
  /** Clears every local check. Still says nothing about the API accepting it. */
  NOT_VERIFIED: "NOT_VERIFIED",
} as const;

export type ConfigState = (typeof ConfigState)[keyof typeof ConfigState];

/** Worst-state reporting: NOT_APPLICABLE when no required variable applies. */
export type ReadinessStatus = ConfigState | "NOT_APPLICABLE";

export interface VariableReadiness {
  /** Environment variable name. Never its value. */
  name: string;
  /** Whether the selected provider cannot start without it. */
  required: boolean;
  state: ConfigState;
  /** What the operator must do. Never quotes the value. */
  action: string;
}

export interface Readiness {
  /** The provider the environment asks for, or "(unset)" for the fixture default. */
  provider: string;
  /** True only when IGTRACK_PROVIDER=graph, i.e. the credentials are consumed. */
  graphCredentialsRequired: boolean;
  /** Every audited variable in a fixed order — JSON and human render this list. */
  variables: VariableReadiness[];
  /** Worst state across the variables the selected provider requires. */
  status: ReadinessStatus;
  /** Value-free corrective messages, one per variable worth acting on. */
  problems: string[];
  /** Always false. Readiness is a local check; no API request was made. */
  networkCallMade: false;
}

export const KNOWN_PROVIDERS = ["fixture", "graph", "import"] as const;

/** The three variables `IGTRACK_PROVIDER=graph` cannot start without. */
export const GRAPH_CREDENTIAL_VARS = [
  "IGTRACK_GRAPH_ACCESS_TOKEN",
  "IGTRACK_GRAPH_IG_USER_ID",
  "IGTRACK_GRAPH_USERNAME",
] as const;

/**
 * Instagram username charset — the exact guard the graph provider applies
 * before a username reaches a fields expression (nothing else can exist).
 * Exported so config validation and the request builder cannot drift.
 */
export const IG_USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;

/**
 * Lead-in an unmistakable template verb with a separator after it. `paste` +
 * separator catches `PASTE_IG_USER_ID_HERE` while leaving `pastel` alone,
 * because a brandable handle never starts `paste_`.
 */
const TEMPLATE_LEAD =
  /^(?:paste|your|put|enter|insert|replace|change(?:_?me)?|placeholder|sample|dummy|todo|fixme|redacted)[\s_-]/i;

/** `..._HERE` / `... HERE` — the tail half of the canonical stub. */
const TEMPLATE_HERE_TAIL = /(?:^|[\s_-])here$/i;

/** Count of the separators that make a value read as a sentence, not a token. */
function separatorCount(value: string): number {
  return (value.match(/[\s_\-.]/g) ?? []).length;
}

/**
 * True when a value is plainly a template marker rather than a credential.
 *
 * Deliberately conservative: every rule keys on syntax a real credential has
 * no reason to carry, so a short real value is never mistaken for a stub.
 */
export function looksLikePlaceholder(raw: string): boolean {
  const value = raw.trim();
  if (value === "") return false;
  // Bracket-wrapped markers: <TOKEN>, {YOUR_TOKEN_HERE}, [PASTE_ME].
  if (value.length > 2 && /^[<{\[(][\s\S]*[>\])}]$/.test(value)) return true;
  // Filler runs: xxxx, 000000, aaaaa — always a stub, never a credential.
  if (value.length >= 4 && /^(.)\1+$/.test(value)) return true;
  // The canonical `PASTE_..._HERE` / `SET_..._HERE` shape.
  if (TEMPLATE_HERE_TAIL.test(value) && TEMPLATE_LEAD.test(value)) return true;
  // Sentence-shaped stubs with no tail: `PASTE_ACCESS_TOKEN`, `YOUR LONG-LIVED TOKEN`.
  if (TEMPLATE_LEAD.test(value) && separatorCount(value) >= 2) return true;
  // RFC 2606 reserved TLD — documentation addresses, not live hosts.
  if (/\.invalid$/i.test(value)) return true;
  return false;
}

interface VariableRule {
  name: string;
  /** Required by the graph provider itself (not by the selected provider). */
  graphRequired: boolean;
  assess(value: string): ConfigState | null;
  present: string;
  absent: string;
}

/**
 * Per-variable structural rules. Each returns INVALID_CONFIGURATION when the
 * value cannot be what the variable demands, or null when nothing structural
 * is wrong (state then falls through to PLACEHOLDER / NOT_VERIFIED).
 *
 * Placeholder detection runs BEFORE these, so `PASTE_OWNED_USERNAME_HERE`
 * reports PLACEHOLDER rather than INVALID_CONFIGURATION — the corrective
 * action is the same, and PLACEHOLDER tells the operator the value never left
 * the example file.
 */
const RULES: VariableRule[] = [
  {
    name: "IGTRACK_PROVIDER",
    graphRequired: false,
    // Not required: unset means the fixture default, which is a legitimate,
    // documented choice — never reported as a gap.
    assess: (value) =>
      (KNOWN_PROVIDERS as readonly string[]).includes(value) ? null : ConfigState.INVALID_CONFIGURATION,
    present: "one of fixture | graph | import",
    absent: `unset to default to the synthetic fixture provider (valid: ${KNOWN_PROVIDERS.join(" | ")})`,
  },
  {
    name: "IGTRACK_GRAPH_ACCESS_TOKEN",
    graphRequired: true,
    // Whitespace or quoting would corrupt the Authorization header; anything
    // else is left alone — the API is the only thing that can judge a token.
    assess: (value) =>
      /[\s<>"'`]/.test(value) ? ConfigState.INVALID_CONFIGURATION : null,
    present: "a long-lived token from your Meta app (env/secret store only, never committed)",
    absent: "set it to a long-lived token, or keep IGTRACK_PROVIDER=fixture",
  },
  {
    name: "IGTRACK_GRAPH_IG_USER_ID",
    graphRequired: true,
    // Instagram Graph IG User ids are numeric strings; a non-numeric value
    // cannot identify an account. Reported, not thrown: the structural rule
    // exists to be fixed before a call, and the API remains the final judge.
    assess: (value) => (/^[0-9]{5,30}$/.test(value) ? null : ConfigState.INVALID_CONFIGURATION),
    present:
      "the numeric Instagram Business/Creator account id from your Meta app (ids look like 17841400000000002)",
    absent: "set it to your owned account's numeric Instagram user id",
  },
  {
    name: "IGTRACK_GRAPH_USERNAME",
    graphRequired: true,
    assess: (value) =>
      IG_USERNAME_PATTERN.test(value.toLowerCase()) ? null : ConfigState.INVALID_CONFIGURATION,
    present: "the owned account's handle (letters, digits, periods, underscores; at most 30 characters)",
    absent: "set it to the owned account's Instagram username, for resolve matching",
  },
  {
    name: "IGTRACK_GRAPH_BUSINESS_DISCOVERY",
    graphRequired: false,
    // Only the literal "1" enables the route; "true" would read as enabled to
    // an operator while leaving the route switched off. 0/false are an
    // explicit off and are fine. Anything else is a value that would not do
    // what it looks like it does — reported, never silently accepted.
    assess: (value) => (/^(1|0|false)$/i.test(value) ? null : ConfigState.INVALID_CONFIGURATION),
    present: "the literal 1 to enable the documented Business Discovery probe (only that)",
    absent: "unset, or set exactly 1 to opt into the Business Discovery probe",
  },
];

const SEVERITY: Record<ConfigState, number> = {
  [ConfigState.NOT_VERIFIED]: 0,
  [ConfigState.INVALID_CONFIGURATION]: 1,
  [ConfigState.PLACEHOLDER]: 2,
  [ConfigState.MISSING]: 3,
};

function valueOf(env: Record<string, string | undefined>, name: string): string {
  return (env[name] ?? "").trim();
}

function actionFor(rule: VariableRule, state: ConfigState): string {
  switch (state) {
    case ConfigState.MISSING:
      return rule.absent;
    case ConfigState.PLACEHOLDER:
      return `still the example placeholder — replace it with ${rule.present}`;
    case ConfigState.INVALID_CONFIGURATION:
      return `is set but unusable — it must be ${rule.present}`;
    case ConfigState.NOT_VERIFIED:
      return "passes local checks; only an accepted API call can prove it";
    default:
      return rule.present;
  }
}

/**
 * Assess every variable this deployment's configuration depends on.
 * Pure: reads only the passed environment, contacts nothing, returns no values.
 */
export function assessReadiness(
  env: Record<string, string | undefined> = process.env,
): Readiness {
  const providerRaw = valueOf(env, "IGTRACK_PROVIDER");
  const provider = providerRaw === "" ? "(unset)" : providerRaw;
  const graphRequired = providerRaw === "graph";

  const variables: VariableReadiness[] = RULES.map((rule) => {
    const value = valueOf(env, rule.name);
    // "Required" = the selected provider cannot run correctly without a valid
    // value here. The provider name counts as soon as it is set (an unknown
    // name is then a defect); unset it has a documented default, so the default
    // fixture deployment reports no required configuration at all.
    const required =
      rule.name === "IGTRACK_PROVIDER"
        ? providerRaw !== ""
        : rule.name === "IGTRACK_GRAPH_BUSINESS_DISCOVERY"
          ? false
          : graphRequired;
    if (value === "") {
      // Unset is only a defect when the variable is required; an optional
      // variable that was never touched is not a problem to report.
      const state = required ? ConfigState.MISSING : ConfigState.NOT_VERIFIED;
      return {
        name: rule.name,
        required,
        state,
        action: required ? actionFor(rule, ConfigState.MISSING) : `not set — ${rule.absent}`,
      };
    }
    const placeholder = looksLikePlaceholder(value);
    const structural = rule.assess(value);
    // Placeholder wins: `PASTE_IG_USER_ID_HERE` is unmistakably the text the
    // example file shipped, and "replace the template" is a more useful action
    // than "this is not a numeric id" — though both are true.
    const state = placeholder
      ? ConfigState.PLACEHOLDER
      : structural ?? ConfigState.NOT_VERIFIED;
    return { name: rule.name, required, state, action: actionFor(rule, state) };
  });

  const requiredVars = variables.filter((v) => v.required);
  const status: ReadinessStatus =
    requiredVars.length === 0
      ? "NOT_APPLICABLE"
      : requiredVars.reduce<ConfigState>(
          (worst, v) => (SEVERITY[v.state] > SEVERITY[worst] ? v.state : worst),
          ConfigState.NOT_VERIFIED,
        );

  // Report a variable when it is required and not ready, OR when it is set
  // but wrong — a placeholder sitting in `.env` while fixture is selected is
  // inert today and blocking the moment the provider is switched, so it is
  // worth saying out loud. A variable simply never configured is not noise.
  const problems = variables
    .filter((v) => v.state !== ConfigState.NOT_VERIFIED && (v.required || isSet(env, v.name)))
    .map((v) => `${v.name} is ${v.state} — ${v.action}`);

  return {
    provider,
    graphCredentialsRequired: graphRequired,
    variables,
    status,
    problems,
    networkCallMade: false,
  };
}

function isSet(env: Record<string, string | undefined>, name: string): boolean {
  return valueOf(env, name) !== "";
}

/** True when the configuration cannot be acted on as written. */
export function isBlocking(status: ReadinessStatus): boolean {
  return status === ConfigState.MISSING
    || status === ConfigState.PLACEHOLDER
    || status === ConfigState.INVALID_CONFIGURATION;
}

/**
 * The failure `graphConfigFromEnv` raises, or null when the graph credentials
 * are locally usable. Names variables and corrective actions; never a value.
 *
 * Only MISSING and PLACEHOLDER block construction: both mean "there is no
 * credential here", so proceeding would turn a configuration defect into an
 * API error that looks like an access problem. INVALID_CONFIGURATION is
 * deliberately not thrown — the structural rule is a local expectation, and
 * the API stays the final judge rather than a heuristic refusing a value it
 * may simply not have anticipated.
 */
export function graphConfigBlocker(
  env: Record<string, string | undefined> = process.env,
): string | null {
  // Assessed in the graph scope on purpose. `graphConfigFromEnv` builds a
  // graph provider whoever asked for it — a caller, a test, or an env that
  // never mentions IGTRACK_PROVIDER — so the three credentials are required
  // here whatever the rest of the environment says. Assessing in the ambient
  // scope would let a missing token read as "not required" and fall through
  // into the provider as `undefined`.
  const readiness = assessReadiness({ ...env, IGTRACK_PROVIDER: "graph" });
  const blocking = readiness.variables.filter(
    (v) =>
      (GRAPH_CREDENTIAL_VARS as readonly string[]).includes(v.name) &&
      (v.state === ConfigState.MISSING || v.state === ConfigState.PLACEHOLDER),
  );
  if (blocking.length === 0) return null;
  return (
    blocking.map((v) => `${v.name} is ${v.state} — ${v.action}`).join("; ") +
    ". Checked locally against the environment; no API request was made. " +
    "Provision an owned Business/Creator account + Meta app + long-lived token, " +
    "or select the fixture provider with IGTRACK_PROVIDER=fixture. " +
    "Never commit token values."
  );
}
