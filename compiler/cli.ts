#!/usr/bin/env bun
/**
 * CLI for the code-review compiler.
 *
 *   bun compiler/cli.ts [raw arguments...]             compose a prompt
 *   bun compiler/cli.ts --worktree <dir> [args...]     compose against a repo
 *   bun compiler/cli.ts --cells                        dump the four cells (snapshot)
 */

import { composeReview, reviewerFor } from "./prompt.ts";
import { composeCell } from "./cells.ts";
import { LEVELS } from "./fragments.ts";
import { EMPTY_BUNDLE } from "./lenses.ts";

const argv = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (argv.includes("--cells")) {
  const cells = Object.fromEntries(
    LEVELS.map((level) => [
      level,
      composeCell({ level, reviewer: reviewerFor(level), lenses: EMPTY_BUNDLE }),
    ]),
  );
  console.log(JSON.stringify(cells, null, 2));
  process.exit(0);
}

const worktree = argValue("--worktree");
const positional = argv.filter((a, i) => a !== "--worktree" && argv[i - 1] !== "--worktree");

const result = await composeReview(positional.join(" "), worktree ? { worktree } : {});
process.stdout.write(result.prompt);
