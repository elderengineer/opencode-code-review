import type { Level } from "./fragments.ts";
import { parseCommand, pickLevel, MODEL_REF_RE, type CommandInvocation } from "./args.ts";
import { rememberedLevel, rememberLevel, rememberedModel, rememberModel } from "./effort.ts";
import { diffDigest, fleetHint } from "./budget.ts";
import { collectLenses } from "./lenses.ts";
import { composeCell } from "./cells.ts";
import { buildPreamble } from "./preamble.ts";
import { githubCommentAppendix, gitlabCommentAppendix, fixAppendix } from "./appendices.ts";

/**
 * Prompt assembly — the compiler entry point. Order:
 *
 *   preamble → target clause → fleet hint → cell → comment appendix → fix appendix
 */

/** The injected subagent that runs finders/verifiers/sweep at this level. */
export const reviewerFor = (level: Level): string => `reviewer-${level}`;

export interface CompileResult {
  prompt: string;
  invocation: CommandInvocation;
  level: Level;
  fleetBudget: number | undefined;
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

  // `using` pin: persist valid refs (or clear on `default`), then read back
  // the active pin for the preamble.
  if (options.remember !== false && args.modelPin !== undefined) {
    if (args.modelPin === "default" || MODEL_REF_RE.test(args.modelPin)) {
      rememberModel(args.modelPin === "default" ? undefined : args.modelPin);
    }
  }
  const pinnedModel = rememberedModel();

  // One sandboxed git call feeds both the fleet hint and lens gating.
  const digest = await diffDigest(args.target, worktree);
  const [lenses, hint] = [await collectLenses(worktree, digest), fleetHint(level, args.target, digest)];

  const preamble = buildPreamble({ args, remembered, level, pinnedModel });
  const targetClause = args.target ? `Review target: \`${args.target}\`\n\n` : "";
  const cell = composeCell({ level, reviewer: reviewerFor(level), lenses });

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
      hint.text +
      cell +
      commentAppendix +
      fixAppendixText,
    invocation: args,
    level,
    fleetBudget: hint.budget,
  };
}
