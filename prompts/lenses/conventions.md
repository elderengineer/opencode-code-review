### Conventions (AGENTS.md / CLAUDE.md)

Find the convention files that govern the changed code: the repo-root
AGENTS.md or CLAUDE.md, plus any AGENTS.md or CLAUDE.md in a directory that
is an ancestor of a changed file (a directory's file only applies to files
at or below it). Read each one that exists, then check the diff for clear
violations of the rules they state.

Only flag a violation when you can quote the exact rule and the exact line
that breaks it — no style preferences, no vague "spirit of the doc"
inferences. In the finding, name the file path and quote the rule so the
report can cite it. If no convention file applies, return nothing for this
lens.
