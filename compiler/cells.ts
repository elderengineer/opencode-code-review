import type { Level } from "./fragments.ts";
import {
  PHASE_0_GATHER_DIFF,
  TASK_TOOL,
  SPAWN_FALLBACK_NOTE,
  MODEL_FALLBACK_CLAUSE,
  LENS_SET_BY_LEVEL,
  CLEANUP_FINDING_CONTRACT,
  PHASE_2_VERIFY_3STATE,
  PHASE_2_VERIFY_RECALL,
  PHASE_3_SWEEP,
  findingsJsonContract,
} from "./fragments.ts";
import { swapLensTexts, specialistBrief, type LensBundle } from "./lenses.ts";

/**
 * The four prompt cells. Level → cell is the identity map; the level also
 * pins the reviewer-<level> subagent used for finders, verifiers and the
 * sweep, and (via the injected agents) their model variant.
 *
 * Structure follows the reference design: phase ordering, per-lens candidate
 * caps, verify rubrics, sweep, and finding caps (4/8/10/15). Project
 * lenses extend the fleet (one specialist per active lens) and prepend to
 * every stage.
 */

export const FINDINGS_CAP: Record<Level, number> = {
  low: 4,
  medium: 8,
  high: 10,
  max: 15,
};

export interface CellInput {
  level: Level;
  /** reviewer-<level> subagent name, spawned for finders/verifiers/sweep. */
  reviewer: string;
  lenses: LensBundle;
  /**
   * Alternate reviewer subagent names (cost order) when the fleet is
   * auto-routed — empty/undefined when a model is pinned or inherited.
   */
  fallbacks?: string[];
}

// --- lead-ins ---------------------------------------------------------------

const LEAD_IN: Record<Level, string> = {
  low: "",
  medium: `You are reviewing for **precision** at medium effort: every finding you surface
should be one a maintainer would act on.`,
  high: `You are reviewing for **recall** at high effort: catch every real bug a careful
reviewer would catch in one sitting. At this level, catching real bugs matters
more than avoiding false positives. Err on the side of surfacing.`,
  max: `You are reviewing for **recall** at maximum effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives — a
missed bug ships. Err on the side of surfacing.`,
};

// --- low: single diff pass, no fleet ----------------------------------------

function lensBlock(lenses: LensBundle): string {
  return lenses.prepend === "" ? "" : lenses.prepend + "\n";
}

function lowCell({ level, lenses }: CellInput): string {
  return `\`low effort → 1 diff pass → no verify → ≤${FINDINGS_CAP.low} findings\`

${lensBlock(lenses)}
## Turn 1 — read

One tool call: read the unified diff (\`git diff @{upstream}...HEAD; git diff HEAD\`
to cover both committed and uncommitted changes, or \`git diff main...HEAD\` /
the target passed as an argument). Skip test/fixture
hunks (\`test/\`, \`spec/\`, \`__tests__/\`, \`*_test.*\`, \`*.test.*\`,
\`fixtures/\`, \`testdata/\`) — test-file changes are not reviewed at this level.
No subagents, no full-file reads.

## Turn 2 — findings

Flag runtime-correctness bugs visible from the hunk alone: inverted/wrong
condition, off-by-one, null/undefined deref where adjacent lines show the value
can be absent, removed guard, falsy-zero check, missing \`await\`,
wrong-variable copy-paste, error swallowed in a catch that should propagate.
Also flag — still from the hunk alone — new code that duplicates an existing
helper visible in the diff context, and dead code the diff leaves behind.

Do **not** flag style, naming, perf, missing tests, or anything outside the
hunk.

Output at most **${FINDINGS_CAP.low} findings**, most-severe first, one line each:
\`path/to/file.ext:123 — what's wrong and the concrete failure\`. If nothing
qualifies, output exactly \`(none)\`.`;
}

// --- medium / high / max: finder fleet + verify (+ sweep at max) -------------

function fleetCell({ level, reviewer, lenses, fallbacks }: CellInput): string {
  const wide = level === "max";
  const builtIns = wide ? 10 : 8;
  const perLensCap = wide ? 8 : 6;
  const cap = FINDINGS_CAP[level];
  const total = builtIns + lenses.specialists.length;
  const lensNote = lenses.specialists.length > 0
    ? ` + ${lenses.specialists.length} project lens${lenses.specialists.length > 1 ? "es" : ""}`
    : "";

  const lensTexts = [
    swapLensTexts(LENS_SET_BY_LEVEL[level as "medium" | "high" | "max"], lenses.lensReplacements),
    ...lenses.specialists.map(specialistBrief),
  ].join("\n");

  const tag = wide
    ? `${level} effort → ${total} lenses × ${perLensCap} candidates → 1-vote verify → sweep → ≤${cap} findings`
    : level === "high"
      ? `high effort → ${total} lenses × ${perLensCap} candidates → 1-vote verify (recall-biased) → ≤${cap} findings`
      : `medium effort → ${total} lenses × ${perLensCap} candidates → 1-vote verify → ≤${cap} findings`;

  const heading = wide
    ? `## Phase 1 — Find candidates (5 correctness lenses + 3 cleanup lenses + 1 altitude lens + 1 conventions lens${lensNote}, up to ${perLensCap} each)`
    : `## Phase 1 — Find candidates (3 correctness lenses + 3 cleanup lenses + 1 altitude lens + 1 conventions lens${lensNote}, up to ${perLensCap} each)`;

  const batchNote = `Spawn finders in waves of at most 5 concurrent ${TASK_TOOL} calls; start the next wave only when the previous wave returns.`;
  const finderBrief = wide
    ? `Run **${total} independent finders** via the ${TASK_TOOL} tool
(subagent_type: \`${reviewer}\`). Each
surfaces **up to ${perLensCap} candidate findings**. Do NOT let one lens's conclusions
suppress another's — if two lenses flag the same line for different reasons,
record both. ${batchNote} ${SPAWN_FALLBACK_NOTE}`
    : `Run **${total} independent finders** via the ${TASK_TOOL} tool
(subagent_type: \`${reviewer}\`). Each
surfaces **up to ${perLensCap} candidate findings** with \`file\`, \`line\`, a one-line
\`summary\`, and a concrete \`failure_scenario\`. ${batchNote} ${SPAWN_FALLBACK_NOTE}`;

  const fallbackBlock = fallbacks && fallbacks.length > 0
    ? MODEL_FALLBACK_CLAUSE(reviewer, fallbacks) + "\n"
    : "";

  const verify = level === "medium"
    ? PHASE_2_VERIFY_3STATE(reviewer)
    : PHASE_2_VERIFY_RECALL(reviewer);

  const recallCarry = wide
    ? `This is recall mode — a single non-REFUTED vote carries the finding. Do NOT
drop on uncertainty.

`
    : "";

  const passThrough = wide
    ? ""
    : `Pass every candidate with a nameable failure scenario through — finders that
silently drop half-believed candidates bypass the verify step and are the
dominant cause of misses.

`;

  return `${tag}

${LEAD_IN[level]}

${lensBlock(lenses)}
${PHASE_0_GATHER_DIFF}
${heading}

${finderBrief}

${fallbackBlock}${lensTexts}
${CLEANUP_FINDING_CONTRACT}
${passThrough}${verify}
${recallCarry}${wide ? PHASE_3_SWEEP(reviewer) : ""}
${findingsJsonContract(cap)}`;
}

// --- entry ------------------------------------------------------------------

export function composeCell(input: CellInput): string {
  return input.level === "low" ? lowCell(input) : fleetCell(input);
}
