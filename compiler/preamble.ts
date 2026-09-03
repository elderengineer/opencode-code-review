import type { Level } from "./fragments.ts";
import { LEVELS } from "./fragments.ts";
import { MODEL_REF_RE, type CommandInvocation } from "./args.ts";

/**
 * The preamble: the parenthetical that opens the composed prompt and explains
 * level fallbacks, model pins, and ignored flags to the user.
 *
 * Delta from the reference behavior: `--post` (which only ever applied to a
 * cloud review that doesn't exist here) is always reported ignored.
 */

export interface PreambleInput {
  args: CommandInvocation;
  remembered: Level | undefined;
  level: Level;
  /** Active fleet model pin (state read after the `using` write). */
  pinnedModel: string | undefined;
}

const VALID_LEVELS = LEVELS.join(", ");
const HOW_TO_CHANGE = "typing a level (for example `/code-review high`) changes it";

const POST_IGNORED = `(The typed \`--post\` applies only to a cloud review, which doesn't exist here, and was ignored — this local review does not post anywhere; \`--comment\` is the flag that posts findings to a forge.

)

`;

/** Parenthetical for the `using` pin — typed this run, or active from state. */
export function modelPinNote({ args, pinnedModel }: PreambleInput): string {
  if (args.modelPin === "default") {
    return `(\`using default\` cleared the fleet model pin — reviewers inherit the session model once the plugin next loads; restart opencode to apply.)

`;
  }
  if (args.modelPin !== undefined) {
    if (MODEL_REF_RE.test(args.modelPin)) {
      return `(The fleet model is pinned to \`${args.modelPin}\` — it binds when the plugin next loads; restart opencode to apply. \`using default\` clears it.)

`;
    }
    return `(Ignoring unrecognized model pin "${args.modelPin}"; expected \`provider/model\` or \`default\`.)

`;
  }
  if (pinnedModel !== undefined) {
    return `(The fleet model is pinned to \`${pinnedModel}\` from a previous \`using\`; \`using default\` clears it.)

`;
  }
  return "";
}

export function buildPreamble(input: PreambleInput): string {
  const { args, remembered, level } = input;
  let body = "";

  if (args.mistypedLevel !== undefined) {
    const msg = `Ignoring unrecognized effort "${args.mistypedLevel}"; valid: ${VALID_LEVELS}. Using ${level}${remembered === level ? ", the level the user typed last time" : ""}.`;
    body = remembered !== undefined
      ? `(${msg} Tell the user this in one short line as you begin, including that ${HOW_TO_CHANGE}.)

`
      : `(${msg})

`;
  } else if (remembered !== undefined) {
    const msg = `No effort level given — reusing ${remembered}, the level the user typed last time${level !== remembered ? `; running at ${level} here` : ""}.`;
    body = `(${msg} Tell the user this in one short line as you begin, including that ${HOW_TO_CHANGE}.)

`;
  }

  return body + (args.post ? POST_IGNORED : "") + modelPinNote(input);
}
