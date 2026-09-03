import type { Level } from "./fragments.ts";

/**
 * Flag appendices, appended after the cell when the matching flag was passed.
 */

export function githubCommentAppendix(): string {
  return `

## Posting to GitHub (--comment)

The \`--comment\` flag was passed. After producing the findings list, if the
review target is a GitHub PR, post each finding as an inline PR comment via
\`gh api repos/{owner}/{repo}/pulls/{pr}/comments\` (one call per finding;
include a suggestion block only when it fully fixes the issue). If \`gh\` is
not available in this session, use the configured GitHub MCP tools if present,
or print the findings instead. If the target is not a PR, print the findings
to the terminal and note that \`--comment\` was ignored.
`;
}

export function gitlabCommentAppendix(targetHead: string): string {
  // Append the MR ref when the target names one: `!7` (canonical) or a
  // branch. A bare number stays ambiguous with GitHub PR numbers → omitted.
  const mrFlag = /^(!?\d+|[a-z0-9][\w./-]*)$/i.test(targetHead) && !/^\d+$/.test(targetHead)
    ? ` ${targetHead}`
    : "";
  const cmd = `glab mr note${mrFlag} -m "<body>"`;
  return `

## Posting to GitLab (--comment)

The \`--comment\` flag was passed. After producing the findings list, if the
review target is a GitLab merge request, post the findings as one general MR
note via \`${cmd}\` from inside that project's checkout
(every finding with its file:line, the issue, and the suggested fix). glab has
no single verb for line-anchored comments; those require
\`glab api projects/:id/merge_requests/:iid/discussions\`, so post the general
note unless the user asks for inline threads. If glab is not available in this
session, print the findings instead. If the target is not an MR, print the
findings to the terminal and note that \`--comment\` was ignored.
`;
}

export function fixAppendix(): string {
  return `

## Applying fixes (--fix)

The \`--fix\` flag was passed. After producing the findings list, apply the
findings to the working tree instead of stopping at the report: fix each one
directly — correctness bugs and reuse/simplification/efficiency cleanups alike.
Skip any finding whose fix would change intended behavior, require changes well
outside the reviewed diff, or that you judge to be a false positive — note the
skip rather than arguing with it. Finish with a brief summary of what was fixed
and what was skipped.
`;
}
