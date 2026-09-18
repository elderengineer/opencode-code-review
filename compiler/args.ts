import type { Level } from "./fragments.ts";
import { LEVELS, LENS_NAMES } from "./fragments.ts";

/**
 * Command invocation parsing (the opencode command receives everything the
 * user typed after the command name as $ARGUMENTS — this module makes sense
 * of it).
 *
 * Leading flags: --comment, --fix, --post, --no-post, --no-triage,
 * --include-generated. `using <provider/model>` or `--model <value>` pins the
 * fleet model (`default` clears the pin, `auto` routes to the cheapest
 * favorite); `--lenses a,b,c` pins the built-in finder lenses. The first
 * remaining token may be an effort level. Everything after the level is the
 * review target.
 */

export interface CommandInvocation {
  /** Level the user typed explicitly, if any. */
  level: Level | undefined;
  /** PR number / branch / path, normalized. */
  target: string;
  comment: boolean;
  fix: boolean;
  post: boolean;
  /** Triage the diff to select perspective lenses; `--no-triage` turns it off. */
  triage: boolean;
  /** `--include-generated`: count and review files git marks `linguist-generated`. */
  includeGenerated: boolean;
  /** `--lenses` built-in lens names to run, in order; `undefined` → triage or the level default. */
  lenses: string[] | undefined;
  /** `--lenses` entries that are not built-in lens names, reported and ignored. */
  ignoredLenses: string[] | undefined;
  /** Raw `using` argument: a `provider/model` ref, or `default` to clear. */
  modelPin: string | undefined;
  /** They typed something level-shaped that isn't a level (e.g. "hihg"). */
  mistypedLevel: string | undefined;
}

const KNOWN_FLAGS = new Set(["comment", "fix", "post", "no_post", "no_triage", "include_generated"]);

/** `--flag <value>` flags — the value is the next token, not a positional. */
const VALUE_FLAGS = new Set(["model", "lenses"]);

/** `provider/model` — the shape opencode expects in agent `model` fields. */
export const MODEL_REF_RE = /^[a-z0-9][\w.-]*\/[\w.-]+$/i;

/**
 * Collect known `--flag` tokens wherever they appear (levels come first in
 * the usage string, so flags may sit before or after the level/target).
 */
function scanFlags(tokens: string[]): {
  flags: Set<string>;
  rest: string[];
  modelFlag: string | undefined;
  lensFlag: string | undefined;
} {
  const flags = new Set<string>();
  const rest: string[] = [];
  let modelFlag: string | undefined;
  let lensFlag: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const m = tok.match(/^--([A-Za-z-]+)$/);
    const name = m?.[1].replaceAll("-", "_").toLowerCase();
    if (m && name !== undefined && VALUE_FLAGS.has(name) && tokens[i + 1] !== undefined) {
      const value = tokens[i + 1].replaceAll("`", "").replaceAll("'", "").replaceAll('"', "");
      if (name === "lenses") lensFlag = value;
      else modelFlag = value;
      i++;
      continue;
    }
    if (m && name !== undefined && KNOWN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    rest.push(tok);
  }
  return { flags, rest, modelFlag, lensFlag };
}

/** Split `--lenses` on commas, trim, drop empties; `undefined` when nothing remains. */
function parseLensFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return names.length > 0 ? names : undefined;
}

/** Matches a token that *looks* like a level (first 3 chars + any suffix). */
export const LEVEL_PREFIX_RE = new RegExp(
  `^(${LEVELS.map((l) => l.slice(0, 3)).join("|")})[a-z]*$`,
  "i",
);

/** True when the token is a near-miss of a level: one substitution or a transposition. */
export function isLevelTypo(token: string): boolean {
  const t = token.toLowerCase();
  if ((LEVELS as readonly string[]).includes(t)) return false;
  return LEVELS.some((l) => {
    if (l.length !== t.length) return false;
    const diffs = [...l].filter((c, i) => c !== t[i]).length;
    return diffs === 1 || (diffs === 2 && [...l].sort().join() === [...t].sort().join());
  });
}

/** Strip backticks and a leading `#` from the target, then rejoin. */
export function cleanTarget(tokens: string[]): string {
  const [first = "", ...rest] = tokens;
  return [first.replaceAll("`", "").replace(/^#/, ""), ...rest].filter(Boolean).join(" ");
}

function asLevel(token: string): Level | undefined {
  const t = token.toLowerCase();
  return (LEVELS as readonly string[]).includes(t) ? (t as Level) : undefined;
}

export function parseCommand(raw: string): CommandInvocation {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const { flags, rest, modelFlag, lensFlag } = scanFlags(tokens);

  // `using <provider/model>` (or `using default|auto`) — wherever it appears.
  let usingPin: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].toLowerCase() === "using" && rest[i + 1] !== undefined) {
      usingPin = rest[i + 1].replaceAll("`", "").replaceAll("'", "").replaceAll('"', "");
      i++;
      continue;
    }
    positional.push(rest[i]);
  }

  const comment = flags.has("comment");
  const fix = flags.has("fix");
  const post = flags.has("post") && !flags.has("no_post");
  const triage = !flags.has("no_triage");
  const includeGenerated = flags.has("include_generated");

  // `--lenses`: partition the requested names into built-in ones (honored, in
  // order, deduped) and unknown ones (reported, ignored).
  const requested = parseLensFlag(lensFlag);
  const known = requested?.filter((n) => (LENS_NAMES as readonly string[]).includes(n));
  const unknown = requested?.filter((n) => !(LENS_NAMES as readonly string[]).includes(n));
  const lenses = known !== undefined && known.length > 0 ? [...new Set(known)] : undefined;
  const ignoredLenses = unknown !== undefined && unknown.length > 0 ? [...new Set(unknown)] : undefined;

  // Explicit --model outranks `using` when both are typed.
  const modelPin = modelFlag ?? usingPin;

  const head = positional[0] ?? "";

  const base = { comment, fix, post, triage, includeGenerated, lenses, ignoredLenses, modelPin };

  const level = asLevel(head);
  if (level !== undefined) {
    return {
      level,
      target: cleanTarget(positional.slice(1)),
      ...base,
      mistypedLevel: undefined,
    };
  }

  const typo = isLevelTypo(head);
  return {
    level: undefined,
    target: cleanTarget(typo ? positional.slice(1) : positional),
    ...base,
    mistypedLevel: typo || LEVEL_PREFIX_RE.test(head) ? head : undefined,
  };
}

/** typed level → remembered → "medium". */
export function pickLevel(args: Pick<CommandInvocation, "level">, remembered?: Level): Level {
  return args.level ?? remembered ?? "medium";
}
