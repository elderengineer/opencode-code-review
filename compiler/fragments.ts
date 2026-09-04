/**
 * Shared prompt fragments for the code-review command.
 *
 * Conventions:
 *  - Fragment texts are stable and covered by the cell snapshot tests; edit
 *    them only with intent.
 *  - Host adaptations are documented per-fragment below (tool name `task`,
 *    reviewer-<level> subagent types, JSON-only findings, AGENTS.md in the
 *    conventions lens).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** opencode's subagent-spawning tool. */
export const TASK_TOOL = "task";

export const LEVELS = ["low", "medium", "high", "max"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Adapted: the reactive congestion protocol embedded at every spawn site
 * (finder brief, both verify rubrics, sweep). Spawning is unbounded — the
 * only throttle is the provider itself: on a congestion-shaped failure the
 * orchestrator waits, re-issues, and halves its in-flight spawns, falling
 * back to inline sequential work on a repeat failure.
 */
export const SPAWN_FALLBACK_NOTE = `Spawn every ${TASK_TOOL} call for this phase as soon as it is ready — do not
hold any back; there is no concurrency cap. If a spawn fails with a
congestion-shaped error (429, rate limit, overloaded, capacity, bad gateway /
5xx): wait 30–60 seconds, re-issue the identical task, and from then on keep
at most half as many spawns in flight as you did before (halving again each
time congestion recurs). After five consecutive successful spawns you may
raise the in-flight count back up one step. If the same spawn fails with
congestion a second time, run that lens or verification yourself in this
context, sequentially. Never skip a lens or verification because of
congestion. If the ${TASK_TOOL} tool is not available in your current tool set,
do not error — perform each lens (and each verification) yourself,
sequentially, in this context.`;

/**
 * Added for `--model auto`: the fleet runs a cost-ordered ladder of the
 * user's favorite models; model-shaped spawn failures advance to the next
 * alternate subagent instead of dying or degrading to a default agent.
 */
export const MODEL_FALLBACK_CLAUSE = (primary: string, alternates: string[]) => `### Model fallback

The reviewer fleet runs on the cheapest of the user's favorite models: the
primary reviewer subagent is \`${primary}\`, and the alternates
${alternates.map((a) => `\`${a}\``).join(", ")} run progressively pricier models.
If a spawn of \`${primary}\` fails with a model- or route-shaped error — usage
limit, quota exhausted, credits/insufficient balance, 402/429, rate limit,
overloaded, model unavailable or not found — do not retry it: re-issue the
identical task to the next alternate subagent in the order above. The same
applies when an alternate itself fails that way. Confinement and contract
failures are NOT fallbacks — a permission denial or malformed findings output
fails the review closed, exactly as it would without this clause. Never re-route
a reviewer task to a general-purpose or default agent. If every alternate fails
with a model-shaped error, stop and report the review as aborted, listing the
models that were tried. This clause takes precedence over the spawn-congestion
guidance: a model-shaped failure routes to the alternates instead of waiting
and halving.
`;

// ---------------------------------------------------------------------------
// Phase fragments
// ---------------------------------------------------------------------------

export const PHASE_0_GATHER_DIFF = `## Phase 0 — Gather the diff

Run \`git diff @{upstream}...HEAD\` (or \`git diff main...HEAD\` / \`git diff HEAD~1\`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run \`git diff HEAD\` and
include the working-tree changes in scope — the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope.
`;

export const CLEANUP_FINDING_CONTRACT = `Cleanup, altitude, and conventions candidates use the same
\`file\`/\`line\`/\`summary\` shape; in \`failure_scenario\`, state the concrete
cost (what is duplicated, wasted, harder to maintain, or which convention rule
is broken) instead of a crash. Correctness bugs always outrank cleanup,
altitude, and conventions findings when the output cap forces a cut.
`;

// --- verify rubrics ----------------------------------------------------------

export const PRECISION_RUBRIC = `- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.`;

export const RECALL_RUBRIC = `**PLAUSIBLE by default** — do not refute a candidate for being "speculative" or
"depends on runtime state" when the state is realistic: concurrency races,
nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
optional field), falsy-zero treated as missing, off-by-one on a boundary the
code does not exclude, retry storms / partial failures, regex/allowlist that
lost an anchor. These are PLAUSIBLE.

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant — show it); already
handled in this diff (cite the guard); or pure style with no observable effect.`;

/**
 * Adapted: verifiers spawn via the task tool as the level's reviewer subagent.
 */
export const PHASE_2_VERIFY_3STATE = (reviewer: string) => `## Phase 2 — Verify (1-vote, 3-state)

Dedup candidates that point at the same line/mechanism, keeping the one with
the most concrete failure scenario. For each remaining candidate, run **one
verifier** via the ${TASK_TOOL} tool (subagent_type: \`${reviewer}\`):
give it the diff, the relevant file(s), and the candidate, and have it return
exactly one of:

${PRECISION_RUBRIC}

Keep candidates where the vote is CONFIRMED or PLAUSIBLE.

${SPAWN_FALLBACK_NOTE}
`;

/** Adapted: same as above for the recall-biased rubric. */
export const PHASE_2_VERIFY_RECALL = (reviewer: string) => `## Phase 2 — Verify (1-vote, recall-biased)

Dedup near-duplicates (same defect, same location, same reason → keep one). For
each remaining candidate, run **one verifier** via the ${TASK_TOOL} tool
(subagent_type: \`${reviewer}\`): give it the diff, the relevant file(s), and
the candidate; it returns exactly one of **CONFIRMED / PLAUSIBLE / REFUTED**.

${RECALL_RUBRIC}

Keep **CONFIRMED and PLAUSIBLE**. Drop REFUTED.

${SPAWN_FALLBACK_NOTE}
`;

export const PHASE_3_FOCUS = `moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, \`hash()\`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.`;

/** Adapted: names the reviewer subagent for the sweep finder. */
export const PHASE_3_SWEEP = (reviewer: string) => `## Phase 3 — Sweep for gaps

Run **one more finder** via the ${TASK_TOOL} tool (subagent_type:
\`${reviewer}\`) as a fresh reviewer who has the verified list. Re-read
the diff and enclosing functions looking ONLY for defects not already listed.
Do not re-derive or re-confirm anything already there — the job is gaps. Focus
on what the first pass tends to miss: ${PHASE_3_FOCUS}

Surface **up to 8 additional candidates**, each naming a defect not already on
the list. If nothing new, return an empty sweep — do not pad.

${SPAWN_FALLBACK_NOTE}
`;

// ---------------------------------------------------------------------------
// Built-in lenses — the text lives in prompts/lenses/<name>.md, loaded once
// at module import and served from memory (no per-review I/O). Each file
// starts with its `### ` heading; a project lens file replaces a built-in by
// matching that heading. Edit the files, not this file.
// ---------------------------------------------------------------------------

/** Names of the built-in lenses — a project lens file of the same name replaces one. */
export const LENS_NAMES = [
  "line-scan",
  "removed-behavior",
  "cross-file",
  "language-pitfalls",
  "wrapper-proxy",
  "reuse",
  "simplification",
  "efficiency",
  "altitude",
  "conventions",
] as const;

const LENSES_DIR = join(import.meta.dir, "..", "prompts", "lenses");

const lensFallback = (name: string) =>
  `### ${name}\n\n(built-in lens text unavailable — review this perspective from first principles.)`;

/** Built-in lens name → full text (heading line first); a missing file degrades to a fallback. */
export const LENS_TEXT: Record<string, string> = Object.fromEntries(
  LENS_NAMES.map((name) => {
    try {
      return [name, readFileSync(join(LENSES_DIR, `${name}.md`), "utf8")];
    } catch {
      return [name, lensFallback(name)];
    }
  }),
);

/** Heading line each built-in lens starts with (first line of its file). */
export const LENS_HEADINGS: Record<string, string> = Object.fromEntries(
  LENS_NAMES.map((name) => [name, LENS_TEXT[name].split("\n", 1)[0]]),
);

const lensSet = (names: readonly string[]) => names.map((n) => LENS_TEXT[n]).join("\n");

/** The basic fleet set: line-scan/removed-behavior/cross-file + reuse/simplification/efficiency + altitude + conventions. */
export const BASIC_LENS_SET = lensSet([
  "line-scan",
  "removed-behavior",
  "cross-file",
  "reuse",
  "simplification",
  "efficiency",
  "altitude",
  "conventions",
]);

/** The extended fleet set: adds the language-pitfall and wrapper/proxy lenses. */
export const EXTENDED_LENS_SET = lensSet([
  "line-scan",
  "removed-behavior",
  "cross-file",
  "language-pitfalls",
  "wrapper-proxy",
  "reuse",
  "simplification",
  "efficiency",
  "altitude",
  "conventions",
]);

/** Which lens set a fleet level runs. */
export const LENS_SET_BY_LEVEL: Record<"medium" | "high" | "max", string> = {
  medium: BASIC_LENS_SET,
  high: BASIC_LENS_SET,
  max: EXTENDED_LENS_SET,
};

// ---------------------------------------------------------------------------
// Output contract — findings are returned as JSON
// (opencode has no host tool that renders findings)
// ---------------------------------------------------------------------------

export const findingsJsonContract = (cap: number) => `## Output

Return findings as a JSON array of at most ${cap} objects:

\`\`\`json
[
  {
    "file": "path/to/file.ext",
    "line": 123,
    "summary": "one-sentence statement of the bug",
    "failure_scenario": "concrete inputs/state → wrong output/crash"
  }
]
\`\`\`

Ranked most-severe first. If more than ${cap} survive, keep the ${cap} most
severe. If nothing survives verification, return \`[]\`.
`;
