# AGENTS.md

opencode plugin (TypeScript, run by Bun) that injects `/code-review` + `/review`
commands, a `code_review_prompt` tool, and five hidden `reviewer-<level>`
subagents into opencode. All workflow logic is compiled deterministically in
`compiler/`; the model only executes the compiled prompt.

## Verify your changes

```bash
bun test/verify.ts              # 62-assertion behavioral suite (hand-rolled check(); exits non-zero on failure)
bun compiler/cli.ts --cells     # dump the 5 level cells as JSON — byte-stable snapshot reference
bun compiler/cli.ts high --fix  # inspect a composed prompt (add --worktree <dir> to compose against a repo)
```

`bun test` also works (`npm test` / `npm run cells` are wired up). Run verify
after **any** compiler change — tests assert exact substrings of the composed
prompts (e.g. `8 independent finder angles`, `≤8 findings`,
`Phase 3 — Sweep for gaps`), so rewording fragments breaks them. The sticky-level
test reads/writes the real `~/.local/state/opencode/code-review-level` file and
restores it; don't "fix" that.

## Two-copy deployment

opencode does **not** load this folder. It loads the installed copy at
`~/.config/opencode/opencode-code-review`, registered via
`"plugin": ["./opencode-code-review/plugin.ts"]` in `~/.config/opencode/opencode.json`.

After changing source: copy the changed files over the installed copy, then
restart opencode (plugins/commands load at startup only). Never edit only the
installed copy — it gets overwritten by the next sync.

## Layout

- `plugin.ts` — plugin entry; this opencode version requires module shape
  `{ id, server }` (+ default export). Injects commands/agents via the `config`
  hook, the tool via `tool:`. Merge is user-wins: a project's existing
  `command`/`agent` entry of the same name overrides injected defaults.
- `compiler/prompt.ts` — `composeReview()`, the single compile entry:
  parse args → sticky level → one sandboxed `git diff --numstat`
  (`budget.ts`, feeds both fleet hint and lens gating) → lenses → cell →
  `--comment`/`--fix` appendices.
- `compiler/fragments.ts` — all prompt text lives here as exported constants.
  Keep the `PHASE_0_GATHER_DIFF` / `PHASE_2_VERIFY_*` / `PHASE_3_SWEEP` names;
  fragment texts must stay byte-stable (probed via `--cells` output).
- `compiler/lenses.ts` — project lenses: `<repo>/.opencode/code-review/lenses/<slug>.md`,
  frontmatter `paths:` gating. Slug semantics (replace code lens / replace an
  angle / prepend everywhere + specialist finder) are documented in README.

## Hard constraints

- Zero-dependency compiler: node builtins + `Bun.Glob` only. Plugin deps are
  only `@opencode-ai/plugin` + `zod` (resolved from `~/.config/opencode/node_modules`).
- Never write `~/.config/opencode` from the plugin at runtime; runtime state
  belongs in `~/.local/state/opencode/`.
- Licensing: never use the words "port", "reconstruction", or "claude" in
  code, comments, or README.
- opencode-native vocabulary only in prompts (task tool, subagent, variant,
  worktree, command) — not the vocabulary of other agents/tools.
