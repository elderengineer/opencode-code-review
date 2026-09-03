Help the user create a project lens for the code-review command in this repo.
A project lens is a markdown file at `.opencode/code-review/lenses/<name>.md`
that gives the review fleet a project-specific perspective: it is prepended to
every spawned reviewer, and gets its own dedicated finder at medium effort and
above.

Work interactively: ask short questions in one batch, wait for the answers,
never guess. The raw user input below is an optional head start.

<user_arguments>
$ARGUMENTS
</user_arguments>

Ask about (skip any the user's input above already answers):

1. **Goal** — the perspective the lens should encode, in a sentence or two
   (e.g. "security review of our public API", "Android app pitfalls").
2. **Name** — the filename stem, lowercase-dash (suggest one from the goal,
   e.g. `security`, `android`). It must NOT be `code` and must not collide
   with a built-in lens name (line-scan, removed-behavior, cross-file,
   language-pitfalls, wrapper-proxy, reuse, simplification, efficiency,
   altitude, conventions) — a collision would replace that built-in lens.
3. **Model pin** (optional) — pin this lens's dedicated finder to a model
   (`provider/model`, e.g. `opencode/kimi-k3`). Empty → inherits the
   session model.
4. **Effort pin** (optional) — pin the finder to a variant. Empty → inherits
   the session variant. When the user wants a pin, recommend `max`: other
   variants only work on models that support them.
5. **Path gating** (optional) — a list of globs (e.g. `mobile/**`) so the
   lens only activates when the diff touches a matching path. Empty → always
   active.

Then write `.opencode/code-review/lenses/<name>.md` (create parent
directories). NEVER overwrite an existing file: if it exists, show its path,
ask whether to replace it, and stop until the user confirms. File format —
frontmatter only for options the user actually set:

---
paths:
  - "<glob>"
model: <provider/model>
variant: <variant>
---

<2-4 sentences in the second person: what to weigh when reviewing through
this lens>

- <5-8 concrete checklist bullets: defect classes this perspective hunts,
  each specific enough to act on>

<one closing rule: every finding must name the state or input that triggers
it — a finding without a concrete failure scenario is an impression, drop it.>

Finish with a short summary that tells the user:
- the lens joins every review at medium+ as its own finder, and prepends to
  every spawned reviewer at every level;
- model/effort pins bind when the plugin loads — restart opencode to apply
  them (no restart needed for lens text or path gating);
- edit the file to tune it; delete it to remove the lens.