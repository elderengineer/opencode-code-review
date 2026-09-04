import type { Level } from "./fragments.ts";
import { LEVELS } from "./fragments.ts";
import { MODEL_REF_RE, type CommandInvocation } from "./args.ts";
import { MODEL_AUTO } from "./effort.ts";
import { routeRef, type LadderEntry } from "./route.ts";
import type { UpdateNotice } from "./update.ts";

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
  /** Resolved auto ladder when the active pin is `auto`. */
  autoLadder?: LadderEntry[];
  /** Pending plugin update, when npm has a newer version not yet announced. */
  updateNotice?: UpdateNotice;
}

const VALID_LEVELS = LEVELS.join(", ");
const HOW_TO_CHANGE = "typing a level (for example `/code-review high`) changes it";

const POST_IGNORED = `(The typed \`--post\` applies only to a cloud review, which doesn't exist here, and was ignored — this local review does not post anywhere; \`--comment\` is the flag that posts findings to a forge.

)

`;

/** Parenthetical for the `using`/`--model` pin — typed this run, or active from state. */
export function modelPinNote({ args, pinnedModel, autoLadder }: PreambleInput): string {
  const autoActiveNote = () => {
    if (autoLadder !== undefined && autoLadder.length > 0) {
      const [primary, ...alts] = autoLadder;
      const chain = alts.length > 0
        ? ` On model-shaped failures (quota, credits, rate limits) the reviewers fall back to ${alts.map((e) => `\`${routeRef(e.route)}\``).join(", ")}, in that order.`
        : "";
      return `(Fleet model: auto — reviewers run on \`${routeRef(primary.route)}\`, the cheapest of the user's favorite models${primary.pot ? " (plan pot, priced at its cheapest cash rate)" : ""}.${chain} \`using default\` clears it.)\n\n`;
    }
    return `(Fleet model: auto, but no usable favorite ladder was resolved — reviewers inherit the session model. Check that favorites exist in the TUI model picker and that their providers are connected.)\n\n`;
  };

  if (args.modelPin === "default") {
    return `(\`using default\` cleared the fleet model pin — reviewers inherit the session model once the plugin next loads; restart opencode to apply.)

`;
  }
  // Typed this run and already live (pin survived a previous invocation):
  // report the active route rather than "queued for restart".
  if (args.modelPin === MODEL_AUTO && pinnedModel === MODEL_AUTO) {
    return autoActiveNote();
  }
  if (args.modelPin === MODEL_AUTO) {
    return `(Auto routing queued — the fleet will run on the cheapest of the user's favorite models, with the rest as cost-ordered fallbacks. It binds when the plugin next loads; restart opencode to apply. \`using default\` clears it.)

`;
  }
  if (args.modelPin !== undefined) {
    if (MODEL_REF_RE.test(args.modelPin)) {
      return `(The fleet model is pinned to \`${args.modelPin}\` — it binds when the plugin next loads; restart opencode to apply. \`using default\` clears it.)

`;
    }
    return `(Ignoring unrecognized model pin "${args.modelPin}"; expected \`provider/model\`, \`auto\`, or \`default\`.)

`;
  }
  if (pinnedModel === MODEL_AUTO) {
    return autoActiveNote();
  }
  if (pinnedModel !== undefined) {
    return `(The fleet model is pinned to \`${pinnedModel}\` from a previous \`using\`; \`using default\` clears it.)

`;
  }
  return "";
}

/** Parenthetical for a pending plugin update — surfaced once per version. */
const updateNote = ({ version, notes }: UpdateNotice): string => {
  const detail = notes ? ` — ${notes}` : "";
  return `(A newer version of this plugin is available: opencode-code-review v${version}${detail}. Tell the user in one short line as you begin, including how to update: \`npm install @elderengineer/opencode-code-review@latest\`, then restart opencode. Do not interrupt the review for this.)\n\n`;
};

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
  } else if (args.level === undefined && remembered !== undefined) {
    // Reachable only when nothing was typed; pickLevel then guarantees
    // level === remembered, so the message cannot name a level other than
    // the one actually being run.
    const msg = `No effort level given — reusing ${remembered}, the level the user typed last time.`;
    body = `(${msg} Tell the user this in one short line as you begin, including that ${HOW_TO_CHANGE}.)

`;
  }

  return body + (args.post ? POST_IGNORED : "") + modelPinNote(input) +
    (input.updateNotice ? updateNote(input.updateNotice) : "");
}
