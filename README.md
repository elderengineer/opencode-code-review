# opencode-code-review

`/code-review max --fix` for [opencode](https://opencode.ai) — parallel finder
lenses, 1-vote verification, project lenses, effort from low to max.
Type `/code-review` and the plugin compiles a review workflow — parallel finder
subagents, a 1-vote verification pass, an optional gap sweep, project lenses —
as a deterministic prompt. The model only executes the compiled instructions.

```
/code-review medium --fix
```

## Install

**From npm** (recommended):

```bash
bun add @elderengineer/opencode-code-review
```

Register the package in `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["@elderengineer/opencode-code-review"] }
```

**From source** — clone or copy this folder:

```bash
cp -r . ~/.config/opencode/opencode-code-review
```

Register the local path in `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["./opencode-code-review/plugin.ts"] }
```

**Project-scoped** works the same with `.opencode/` instead.

Restart opencode after any install, config, or plugin change — plugins,
commands, and agents load at startup only.

## Quick start

```
/code-review            # medium effort (or the level you typed last time)
/code-review high       # explicit level
/code-review low        # quick single-pass scan, no subagents
/code-review max --fix
/code-review high --model auto   # cheapest favorite model, auto-fallback
```

## Usage reference

```
/code-review [low|medium|high|max] [--fix] [--comment] [--model auto|<model>] [<target>] [using <model>]
```

| piece | meaning |
|---|---|
| level | effort; omitted → reuses the last level you typed (sticky), first run defaults to `medium` |
| `--fix` | apply surviving findings to the working tree, not just report |
| `--comment` | post findings to the PR (`gh`) or MR (`glab mr note`) |
| `<target>` | PR number, branch, `a..b` range, or path — narrows the diff under review |
| `--model` | `auto` (cheapest favorite, see below) or a `provider/model` pin — same as `using` |
| `using <model>` | pin the fleet model, e.g. `using opencode-go/deepseek-v4-flash` (see [Models & effort](#models--effort)) |

Mistype a level (`hihg`) and the preamble says so and falls back; `--post` is
accepted but always reported ignored.

## Effort levels

| level | finders | verify | sweep | cap |
|---|---|---|---|---|
| low | none — single diff pass | – | – | 4 |
| medium | 8 lenses × 6 candidates | 1-vote, precision rubric | – | 8 |
| high | 8 lenses × 6 candidates | 1-vote, recall rubric | – | 10 |
| max | 10 lenses × 8 candidates | 1-vote + carry | yes | 15 |

- **low** reviews the hunk view only; test/fixture hunks are skipped.
- **precision rubric** (medium): keep CONFIRMED/PLAUSIBLE, refute aggressively.
- **recall rubric** (high+): PLAUSIBLE by default; REFUTED only when provable
  from the code.
- Findings are a JSON array, ranked most-severe first, `[]` when clean.

## Models & effort

By default the reviewer subagents **inherit your session's model**. The only
default pin is variant on the top rungs:

| level | model | variant |
|---|---|---|
| low / medium / high | session model | session variant |
| max | session model | `max` (all models support max effort) |

Two override mechanisms:

1. **`using <model>` / `--model <model>`** in the command — pins the fleet
   model for your reviews and sticks until changed. Example:
   `/code-review medium using opencode-go/deepseek-v4-flash`.
   `using default` clears the pin.

2. **`--model auto`** — routes the fleet to the **cheapest of your favorite
   models** (your TUI ★ list) instead of one fixed model:

   - Prices come from opencode's own catalog, filtered to your connected
     providers, blended `0.75·input + 0.25·output` (review reads far more
     than it writes).
   - Plan-pot models (`$0` in the catalog) are **not** treated as free —
     they draw down metered quota — so they're priced at the cheapest cash
     rate of the same model. They still sort first, honestly.
   - Favorites missing from the catalog (renamed/deprecated) are dropped.
   - The top 4 form a ladder: the cheapest runs the fleet, and the composed
     prompt instructs a fallback to the next reviewer on model-shaped
     failures (quota, credits, 402/429, rate limits, overloaded).
     Confinement/contract failures still fail closed; no ever re-routes to a
     general-purpose agent. Ladder exhausted → the review aborts with the
     list of models tried.
   - Ladder order at a glance: `bun compiler/cli.ts high --model auto --server http://127.0.0.1:4096`

3. **`model:` in a lens file** — a project lens can pin a model for its own
   specialist finder (see [Project lenses](#project-lenses)). Example: a
   `security.md` lens running on a different model than the general fleet.

**Mechanic, honestly:** opencode binds a subagent's model from its agent
definition at startup — the task tool has no per-call model parameter. So all
overrides are read when the plugin loads: `using`/`--model` persists to a
sticky state file and pins the `reviewer-*` agents (with `auto`, it also
resolves the ladder and injects hidden `reviewer-<level>-alt<N>` alternates),
lens `model:` pins spawn per-lens agents (`reviewer-lens-<name>`). Either
way, **restart opencode after changing them** for the new model to take
effect.

## How a review runs

1. `/code-review` calls the `code_review_prompt` tool with your raw arguments.
2. The tool compiles the full instruction prompt: preamble (level fallbacks) →
   target clause → fleet hint → level cell → flag appendices.
3. The model follows it: gathers the diff (**Phase 0**), spawns
   `reviewer-<level>` finder subagents — one per lens (**Phase 1**), runs one
   verifier per candidate (**Phase 2**), optionally sweeps for gaps
   (**Phase 3**, max), emits ranked JSON findings.
4. `--fix` applies them; `--comment` posts them.

**Scope:** the diff under review is `git diff @{upstream}...HEAD` (or
`main...HEAD` / `HEAD~1`) **plus working-tree changes** (`git diff HEAD`).
Untracked files that were never `git add`ed are invisible to every diff —
stage them first. A single sandboxed `git diff --numstat` sizes the fleet hint
(high+: `clamp(ceil(lines/150), 2, 8)` finders) and gates path-scoped lenses.

## Fleet lenses

**Basic set (medium/high):**

| lens | hunts |
|---|---|
| line-scan | per-line bugs: inverted conditions, off-by-one, null deref, missing `await`, falsy-zero, swallowed errors |
| removed-behavior | deleted guards/invariants with no replacement |
| cross-file | callers/callees broken by the change |
| reuse | re-implementations of existing helpers |
| simplification | redundant state, copy-paste, dead code |
| efficiency | wasted work, sequential I/O, closure-retained scopes |
| altitude | bandaids where the mechanism should generalize |
| conventions | violations of AGENTS.md / CLAUDE.md rules (quoted, not vibes) |

**Extended set (max)** adds: `language-pitfalls` and `wrapper-proxy`.

Every finding needs a concrete failure scenario; correctness outranks cleanup
when the cap forces a cut.

## Project lenses

Drop markdown files in the reviewed repo:

```
.opencode/code-review/lenses/<name>.md
```

One rule, by name:

| name | effect |
|---|---|
| `code` | replaces the built-in code lens (prepended to every spawned agent; default empty) |
| a built-in lens name (`line-scan`, `language-pitfalls`, `reuse`, …) | replaces that built-in lens's text (no effect at levels that don't run it; `language-pitfalls`/`wrapper-proxy` are max only) |
| anything else | project perspective: prepended to every spawned agent **and** given a dedicated specialist finder at medium+ |

Optional frontmatter:

```markdown
---
paths:            # lens only activates when the diff touches a matching path
  - "mobile/**"
model: opencode/kimi-k3   # pin THIS lens's specialist finder to a model
variant: max              # pin its variant (max works on every model)
---
You are reviewing the Android app (Kotlin, Compose, coroutines)…
```

- Gated lenses that don't match the diff fall back to built-in text.
- Fleet math: medium/high run 8 + N finders, max runs 10 + N (N = active
  new-name project lenses); `low` never spawns.
- Every new-name project lens (not a built-in replacement) gets its own
  `reviewer-lens-<name>` finder agent, registered at plugin load with its
  `model:`/`variant:` pins (restart after adding one; lens text and `paths:`
  need no restart).
- Project review *rules* need no lens — put them in `AGENTS.md`, which the
  conventions lens discovers per-directory.

### Scaffolding: `/code-review:create-lens`

Writing a lens by hand is optional — the command interviews you and writes
the file:

```
/code-review:create-lens                      # fully interactive
/code-review:create-lens security review of our public API   # goal prefilled
```

It asks for (skipping anything already answered): the **goal**, a **name**
(must not collide with a built-in lens name), an optional **model** pin, an
optional **effort** pin (recommends `max`), and optional **path gating** —
then writes `.opencode/code-review/lenses/<name>.md`. It never overwrites
without confirmation, and explains what needs a restart.

## Reviewer subagents

The plugin injects four hidden subagents, `reviewer-low` … `reviewer-max` —
read-only (read/grep/glob/list; edit/bash/webfetch denied), one per effort
rung, used for finders, verifiers, and the sweep. Plus one
`reviewer-lens-<name>` per project lens (its `model:`/`variant:` pins bind at
startup). With `--model auto`, hidden `reviewer-<level>-alt<N>` alternates
carry the rest of the cost ladder.

Projects override any of them field-by-field in `.opencode/opencode.json` —
user config always wins:

```json
{ "agent": { "reviewer-high": { "prompt": "You are a Scala 3 reviewer…" } } }
```

## Flags in depth

**Findings output** — JSON array of `{file, line, summary, failure_scenario}`,
ranked, capped per level, `[]` when clean.

**`--fix`** — applies findings to the working tree: correctness and cleanup
alike. Skips (and notes) findings that would change intended behavior, need
changes well outside the diff, or look like false positives.

**`--comment`** — GitHub: one inline PR comment per finding via `gh`.
GitLab (`!7` or `gitlab` in the target): one general MR note via
`glab mr note`. No forge target → prints findings and says the flag was
ignored.

## Files & state

| path | what |
|---|---|
| this folder | source of truth |
| `~/.config/opencode/opencode-code-review/` | installed copy opencode loads — sync after changes |
| `~/.config/opencode/opencode.json` | plugin registration |
| `~/.local/state/opencode/code-review-level` | sticky effort level |
| `~/.local/state/opencode/code-review-model` | sticky model pin (`auto` or `provider/model`) |
| `~/.local/state/opencode/model.json` | your TUI favorite/recent models — read (never written) to build the `--model auto` ladder |
| `<repo>/.opencode/code-review/lenses/` | project lenses |

## Development

```bash
bun test/verify.ts              # behavioral checks
bun compiler/cli.ts --cells     # dump the four level cells (snapshot)
bun compiler/cli.ts high --fix  # inspect a composed prompt
bun compiler/cli.ts --worktree <dir> low
bun compiler/cli.ts high --model auto --server http://127.0.0.1:4096  # inspect the auto ladder
```

Prompt composition is deterministic code in `compiler/` (zero runtime deps:
node builtins + `Bun.Glob`); fragment texts are stable and probed by the
verify suite. After changing source: run the suite, copy changed files over
the installed copy, restart opencode. See `AGENTS.md` for conventions.

## Troubleshooting / FAQ

- **`code_review_prompt` tool missing** — that session predates the plugin
  load; toolsets snapshot at session creation. New session, or restart.
- **`using <model>` had no effect** — it pins at next opencode start by
  design; check `~/.local/state/opencode/code-review-model`.
- **`--model auto` runs the session model** — no usable ladder was resolved:
  favorites empty, none of their providers connected, or the catalog was
  unreachable at startup. Star models in the TUI picker and restart.
- **Auto ladder skipped a favorite** — it's absent from the connected
  catalog (renamed/deprecated) or an unpriced pot with no cash sibling; the
  ladder only contains models you can actually call.
- **Lens specialist didn't spawn / model didn't apply** — lens agents
  register at plugin load; restart after adding the lens file.
- **Review found nothing but I have changes** — untracked files are invisible
  to git diffs; `git add` them first.
- **Level didn't apply** — an unrecognized level falls back with a notice;
  the sticky level changes only when you type a valid one.
