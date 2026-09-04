import type { Level } from "./fragments.ts";
import { parseCommand, pickLevel, MODEL_REF_RE, type CommandInvocation } from "./args.ts";
import { rememberedLevel, rememberLevel, rememberedModel, rememberModel, MODEL_AUTO } from "./effort.ts";
import { diffDigest, fleetHint, heavyShapeNote } from "./budget.ts";
import { collectLenses } from "./lenses.ts";
import { activeLadder, type LadderEntry } from "./route.ts";
import { composeCell } from "./cells.ts";
import { buildPreamble } from "./preamble.ts";
import { githubCommentAppendix, gitlabCommentAppendix, fixAppendix } from "./appendices.ts";

/**
 * Prompt assembly — the compiler entry point. Order:
 *
 *   preamble → target clause → heavy-shape note → fleet hint → cell →
 *   comment appendix → fix appendix
 */

/** The injected subagent that runs finders/verifiers/sweep at this level. */
export const reviewerFor = (level: Level): string => `reviewer-${level}`;

/** Alternate subagent names injected for the auto ladder, in cost order. */
export const fallbackReviewers = (level: Level, ladder: LadderEntry[] | undefined): string[] =>
  ladder !== undefined && ladder.length > 1
    ? ladder.slice(1).map((_, i) => `${reviewerFor(level)}-alt${i + 1}`)
    : [];

export interface CompileResult {
  prompt: string;
  invocation: CommandInvocation;
  level: Level;
  fleetBudget: number | undefined;
  /** Resolved auto ladder when the active pin is `auto`, else undefined. */
  autoLadder: LadderEntry[] | undefined;
}

function isGitLabTarget(targetHead: string): boolean {
  return /(^!|\bgitlab\b)/i.test(targetHead);
}

export interface CompileOptions {
  /** Session worktree root (defaults to the process cwd — CLI use). */
  worktree?: string;
  /** Persist an explicitly typed level as the sticky default (default true). */
  remember?: boolean;
}

export async function composeReview(rawArguments: string, options: CompileOptions = {}): Promise<CompileResult> {
  const worktree = options.worktree ?? process.cwd();
  const args = parseCommand(rawArguments);

  const remembered = rememberedLevel();
  const level = pickLevel(args, remembered);
  if (options.remember !== false && args.level !== undefined) {
    rememberLevel(args.level);
  }

  // `using`/`--model` pin: persist valid refs (`default` clears, `auto`
  // routes), then read back the active pin for the preamble.
  if (options.remember !== false && args.modelPin !== undefined) {
    if (args.modelPin === "default" || args.modelPin === MODEL_AUTO || MODEL_REF_RE.test(args.modelPin)) {
      rememberModel(args.modelPin === "default" ? undefined : args.modelPin);
    }
  }
  const pinnedModel = rememberedModel();
  const autoLadder = pinnedModel === MODEL_AUTO ? activeLadder() : undefined;
  const fallbacks = fallbackReviewers(level, autoLadder);

  // One sandboxed git call feeds both the fleet hint and lens gating.
  const digest = await diffDigest(args.target, worktree);
  const [lenses, hint] = [await collectLenses(worktree, digest), fleetHint(level, args.target, digest)];

  const preamble = buildPreamble({ args, remembered, level, pinnedModel, autoLadder });
  const targetClause = args.target ? `Review target: \`${args.target}\`\n\n` : "";
  const shapeNote = heavyShapeNote(level, digest, lenses.specialists.length);
  const cell = composeCell({ level, reviewer: reviewerFor(level), lenses, fallbacks });

  const targetHead = args.target.split(/\s+/)[0] ?? "";
  const commentAppendix = !args.comment
    ? ""
    : isGitLabTarget(targetHead)
      ? gitlabCommentAppendix(targetHead)
      : githubCommentAppendix();
  const fixAppendixText = args.fix ? fixAppendix() : "";

  return {
    prompt:
      preamble +
      targetClause +
      shapeNote +
      hint.text +
      cell +
      commentAppendix +
      fixAppendixText,
    invocation: args,
    level,
    fleetBudget: hint.budget,
    autoLadder,
  };
}
