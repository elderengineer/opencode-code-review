import type { Level } from "./fragments.ts";
import { LEVELS } from "./fragments.ts";

/**
 * Command invocation parsing (the opencode command receives everything the
 * user typed after the command name as $ARGUMENTS — this module makes sense
 * of it).
 *
 * Leading flags: --comment, --fix, --post, --no-post. `using <provider/model>`
 * pins the fleet model (`using default` clears the pin). The first remaining
 * token may be an effort level. Everything after the level is the review
 * target.
 */

export interface CommandInvocation {
  /** Level the user typed explicitly, if any. */
  level: Level | undefined;
  /** PR number / branch / path, normalized. */
  target: string;
  comment: boolean;
  fix: boolean;
  post: boolean;
  /** Raw `using` argument: a `provider/model` ref, or `default` to clear. */
  modelPin: string | undefined;
  /** They typed something level-shaped that isn't a level (e.g. "hihg"). */
  mistypedLevel: string | undefined;
}

const KNOWN_FLAGS = new Set(["comment", "fix", "post", "no_post"]);

/** `provider/model` — the shape opencode expects in agent `model` fields. */
export const MODEL_REF_RE = /^[a-z0-9][\w.-]*\/[\w.-]+$/i;

/**
 * Collect known `--flag` tokens wherever they appear (levels come first in
 * the usage string, so flags may sit before or after the level/target).
 */
function scanFlags(tokens: string[]): { flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const tok of tokens) {
    const m = tok.match(/^--([A-Za-z-]+)$/);
    const name = m?.[1].replaceAll("-", "_").toLowerCase();
    if (m && name !== undefined && KNOWN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    rest.push(tok);
  }
  return { flags, rest };
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
  const { flags, rest } = scanFlags(tokens);

  // `using <provider/model>` (or `using default`) — wherever it appears.
  let modelPin: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].toLowerCase() === "using" && rest[i + 1] !== undefined) {
      modelPin = rest[i + 1].replaceAll("`", "").replaceAll("'", "").replaceAll('"', "");
      i++;
      continue;
    }
    positional.push(rest[i]);
  }

  const comment = flags.has("comment");
  const fix = flags.has("fix");
  const post = flags.has("post") && !flags.has("no_post");

  const head = positional[0] ?? "";

  const level = asLevel(head);
  if (level !== undefined) {
    return {
      level,
      target: cleanTarget(positional.slice(1)),
      comment, fix, post, modelPin,
      mistypedLevel: undefined,
    };
  }

  const typo = isLevelTypo(head);
  return {
    level: undefined,
    target: cleanTarget(typo ? positional.slice(1) : positional),
    comment, fix, post, modelPin,
    mistypedLevel: typo || LEVEL_PREFIX_RE.test(head) ? head : undefined,
  };
}

/** typed level → remembered → "medium". */
export function pickLevel(args: Pick<CommandInvocation, "level">, remembered?: Level): Level {
  return args.level ?? remembered ?? "medium";
}
