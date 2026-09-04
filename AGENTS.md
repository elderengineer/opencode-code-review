# AGENTS.md

opencode plugin (TypeScript, run by Bun) that injects `/code-review` +
`/code-review:create-lens` commands, a `code_review_prompt` tool, and four
hidden `reviewer-<level>` subagents into opencode. All workflow logic is
compiled deterministically in `compiler/`; the model only executes the
compiled prompt.

## Verify your changes

```bash
bun test/verify.ts              # 87-assertion behavioral suite (hand-rolled check(); exits non-zero on failure)
bun compiler/cli.ts --cells     # dump the 4 level cells as JSON — byte-stable snapshot reference
bun compiler/cli.ts high --fix  # inspect a composed prompt (add --worktree <dir> to compose against a repo)
```

`bun test` also works (`npm test` / `npm run cells` are wired up). Run verify
after **any** compiler change — tests assert exact substrings of the composed
prompts (e.g. `8 independent finders`, `≤8 findings`,
`Phase 3 — Sweep for gaps`), so rewording fragments breaks them. The sticky-level
test reads/writes the real `~/.local/state/opencode/code-review-level` file and
restores it; don't "fix" that.

## Two-copy deployment

opencode does **not** load this folder. It loads the installed copy at
`~/.config/opencode/opencode-code-review`, registered via
`"plugin": ["./opencode-code-review/plugin.ts"]` in `~/.config/opencode/opencode.json`.

After changing source: copy the changed files over the installed copy, then
restart opencode (plugins/commands load at startup only). Never edit only the
installed copy — it gets overwritten by the next sync. The installed copy also
needs `package.json`: the plugin reads its own version from it.

## Commit messages

Conventional Commits, one line: `type: description` — types `feat`, `fix`,
`docs`, `perf`, `refactor`, `test`, `chore`; scope optional (`feat(lenses): …`).
Write the description for **users**: the first line is extracted verbatim into
release notes by `release.yml` at tag time. With squash merges the PR title is
the commit subject, and the `Semantic PR` workflow rejects non-conforming
titles. Non-conforming subjects still render, under "Other changes".

Releases: release-please watches master and opens a
`chore(master): release vX.Y.Z` PR with the version bump pre-computed from
the conventional commits (feat → minor, fix → patch). Merging it tags the
version and creates the GitHub release; the tag then triggers `release.yml`
(tests → npm publish → install footer appended to the release notes). This
chain needs the `RELEASE_PAT` secret (classic PAT, repo scope) — tags pushed
with the default `GITHUB_TOKEN` do not trigger `release.yml`. Manual tags
still work but must match `package.json` (guarded in `release.yml`).

## Layout

- `plugin.ts` — plugin entry; this opencode version requires module shape
  `{ id, server }` (+ default export). Injects commands/agents via the `config`
  hook, the tool via `tool:`. Merge is user-wins: a project's existing
  `command`/`agent` entry of the same name overrides injected defaults.
  Prompt prose lives in `prompts/*.md` (loaded at startup; minimal fallbacks
  keep the plugin alive if a file is missing) — keep structure (models,
  variants, tools) in TS and prose in the .md files.
- `compiler/prompt.ts` — `composeReview()`, the single compile entry:
  parse args → sticky level → one sandboxed `git diff --numstat`
  (`budget.ts`, feeds both fleet hint and lens gating) → lenses → cell →
  `--comment`/`--fix` appendices.
- `compiler/fragments.ts` — the phase/output prompt text lives here as exported
  constants (built-in lens text lives in `prompts/lenses/<name>.md`, loaded at
  import). Keep the `PHASE_0_GATHER_DIFF` / `PHASE_2_VERIFY_*` /
  `PHASE_3_SWEEP` names; fragment texts must stay byte-stable (probed via
  `--cells` output).
- `compiler/update.ts` — daily npm/GitHub update check; caches the result under
  `~/.local/state/opencode` and surfaces a once-per-version update notice in
  the review preamble.
- `compiler/lenses.ts` — project lenses: `<repo>/.opencode/code-review/lenses/<name>.md`,
  frontmatter `paths:` gating + `model:`/`variant:` pins (the plugin injects a
  `reviewer-lens-<name>` agent per project lens at startup). Naming rule: a
  lens named after a built-in lens replaces it; any other name adds a project
  perspective + specialist finder. Vocabulary is "lens" everywhere — never
  "angle" or "slug".

## Hard constraints

- Zero-dependency compiler: node builtins + `Bun.Glob` only. Plugin deps are
  only `@opencode-ai/plugin` + `zod` (resolved from `~/.config/opencode/node_modules`).
- Never write `~/.config/opencode` from the plugin at runtime; runtime state
  belongs in `~/.local/state/opencode/`.
- Licensing: never use the words "port", "reconstruction", or "claude" in
  code, comments, or README.
- opencode-native vocabulary only in prompts (task tool, subagent, variant,
  worktree, command) — not the vocabulary of other agents/tools.
