import { spawn } from "node:child_process";

/**
 * Diff sizing: added+deleted line total and the changed-file list, from one
 * sandboxed `git diff --numstat`. Both the subagent fleet hint and the lens
 * `paths:` gating consume the same digest — one git call per review.
 *
 * Files the repo's git attributes mark `linguist-generated` (lockfiles, ORM
 * schema snapshots, build output) count zero lines — like binary files, they
 * stay in `files` (lens gating may need to know they changed) but are not the
 * review's subject; one `git check-attr --stdin` pass flags them, and
 * `--include-generated` opts the review back in.
 *
 * Only a literal `a..b` / `a...b` range (never a PR number or path) is
 * accepted, and git runs fully sandboxed: no hooks, no fsmonitor, no askpass,
 * no network protocols, no lazy fetch, no terminal prompt.
 */

export interface DiffDigest {
  lines: number;
  files: string[];
  /** Changed paths git marks `linguist-generated` — excluded from `lines`. */
  generated: string[];
  /** Added+deleted line total of the `generated` paths (what exclusion saved). */
  generatedLines: number;
  /** Range that produced this digest — the note's diff command replays it. */
  range?: string;
}

export interface DigestOptions {
  /** Count and review `linguist-generated` files instead of excluding them. */
  includeGenerated?: boolean;
}

function rangeFor(target: string): string[] {
  if (!target) return ["@{upstream}...HEAD", "main...HEAD", "master...HEAD", "HEAD~1"];
  if (target.length <= 256 && /^[@\w][@\w./~{}+-]*\.\.\.?[@\w][@\w./~{}+-]*$/.test(target)) {
    return [target];
  }
  return [];
}

/** Decode a git C-quoted numstat path (quotes + octal escapes) and collapse rename syntax to the new path. */
export function decodeGitPath(p: string): string {
  let decoded = p;
  if (decoded.startsWith('"') && decoded.endsWith('"') && decoded.length >= 2) {
    const raw = decoded.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === "\\" && i + 1 < raw.length) {
        const n = raw[i + 1];
        if (n >= "0" && n <= "7") {
          bytes.push(parseInt(raw.slice(i + 1, i + 4), 8));
          i += 3;
        } else {
          bytes.push(n.charCodeAt(0));
          i += 1;
        }
      } else {
        bytes.push(c.charCodeAt(0));
      }
    }
    decoded = Buffer.from(bytes).toString("utf8");
  }
  decoded = decoded.replace(/\{[^{}]* => ([^{}]*)\}/, "$1");
  const arrow = decoded.lastIndexOf(" => ");
  if (arrow >= 0) decoded = decoded.slice(arrow + 4);
  return decoded;
}

/** Shared git sandbox: no hooks, no fsmonitor, no askpass, no network. */
const GIT_SPAWN = {
  env: {
    ...process.env,
    GIT_ALLOW_PROTOCOL: "none",
    GIT_NO_LAZY_FETCH: "1",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    GIT_TERMINAL_PROMPT: "0",
  },
};

const GIT_QUIET = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "core.askPass="];

function runGit(args: string[], worktree: string, stdin?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn("git", [...GIT_QUIET, ...args], {
      cwd: worktree,
      stdio: stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      ...GIT_SPAWN,
    });
    let out = "";
    const timer = setTimeout(() => proc.kill(), 5000);
    proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : undefined);
    });
    if (stdin !== undefined) proc.stdin.end(stdin, (err: Error | undefined) => err && proc.kill());
  });
}

function gitNumstat(range: string, worktree: string): Promise<string | undefined> {
  return runGit(
    ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--end-of-options", range, "--"],
    worktree,
  );
}

/**
 * Which of the given paths git marks `linguist-generated`. One `--stdin` call
 * regardless of path count (NUL-separated decoded paths in, NUL-separated
 * path/attribute/value triplets out, paths unquoted); any failure fails open
 * to "none" (yesterday's behavior).
 */
async function generatedPathsIn(paths: string[], worktree: string): Promise<Set<string>> {
  const out = await runGit(["check-attr", "-z", "linguist-generated", "--stdin"], worktree, paths.join("\0") + "\0");
  const generated = new Set<string>();
  if (out === undefined) return generated;
  const fields = out.split("\0");
  for (let j = 0; j + 2 < fields.length; j += 3) {
    // `set` for the bare form, but any explicit value (`=true`, …) counts too.
    if (fields[j + 2] !== "unset" && fields[j + 2] !== "unspecified") generated.add(fields[j]);
  }
  return generated;
}

export async function diffDigest(
  target: string,
  worktree: string,
  options: DigestOptions = {},
): Promise<DiffDigest | undefined> {
  for (const range of rangeFor(target)) {
    const digest = await digestForRange(range, worktree, options.includeGenerated === true);
    if (digest !== undefined) return digest;
  }
  return undefined;
}

async function digestForRange(
  range: string,
  worktree: string,
  includeGenerated: boolean,
): Promise<DiffDigest | undefined> {
  const stdout = await gitNumstat(range, worktree);
  if (stdout === undefined) return undefined;

  // numstat reports binary files as `-\t-\tpath` — keep the file (lens
  // gating uses it) but count no lines.
  const rows: { path: string; lines: number; text: boolean }[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) {
      rows.push({
        path: decodeGitPath(m[3]),
        lines: (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2])),
        text: m[1] !== "-" || m[2] !== "-",
      });
    }
  }
  if (rows.length === 0) return undefined;

  const flagged = includeGenerated
    ? new Set<string>()
    : await generatedPathsIn(rows.filter((r) => r.text).map((r) => r.path), worktree);

  const flaggedRows = rows.filter((r) => flagged.has(r.path));

  return {
    lines: rows.reduce((n, r) => n + (flagged.has(r.path) ? 0 : r.lines), 0),
    files: rows.map((r) => r.path),
    generated: flaggedRows.map((r) => r.path),
    generatedLines: flaggedRows.reduce((n, r) => n + r.lines, 0),
    range,
  };
}

/**
 * Subagent fleet hint, sized to the diff — enabled at high and above. Project
 * lens specialists are additive and always run at medium+; this hint only
 * scales the built-in fan-out.
 */
export function fleetHint(level: string, target: string, digest: DiffDigest | undefined): { text: string; budget?: number } {
  if (level !== "high" && level !== "max") return { text: "" };
  if (digest === undefined) return { text: "" };

  const budget = Math.max(2, Math.min(8, Math.ceil(digest.lines / 150)));

  if (digest.lines === 0 && digest.generated.length > 0) {
    return {
      text: !target
        ? `The committed diff contains only generated paths, which are excluded from this review — treat hand-written scope as empty unless Phase 0 finds uncommitted hand-written changes.\n\n`
        : `This diff contains only generated paths, which are excluded from this review — hand-written scope is empty.\n\n`,
      budget,
    };
  }

  if (!target) {
    return {
      text: `The committed diff (@{upstream}...HEAD) is about ${digest.lines} lines. Uncommitted changes aren't counted here — treat this as a floor, and scale each finder's investigation depth up if Phase 0 finds additional working-tree scope.\n\n`,
      budget,
    };
  }

  return {
    text: `This diff is about ${digest.lines} lines — scale each finder's investigation depth to this size.\n\n`,
    budget,
  };
}

/**
 * Advisory heads-up for a heavy review shape — a diff of 2,500+ lines, or
 * 800+ lines multiplied by two or more project lenses (each specialist
 * re-reads the whole diff and adds candidates to verify), can run long
 * against the session's wall clock. Fires at every fleet level: the observed
 * timeout was a medium run. Purely informational — fleet size is fixed by
 * level.
 *
 * Only reached with an empty or range target: path targets produce no digest
 * at all, so a fired note always benefits from the narrowing advice.
 */

const HEAVY_LENS_LINES = 800;
const HEAVY_BARE_LINES = 2500;

export function heavyShapeNote(level: string, digest: DiffDigest | undefined, specialists: number): string {
  if (level === "low" || digest === undefined) return "";
  const heavy = (specialists >= 2 && digest.lines >= HEAVY_LENS_LINES) || digest.lines >= HEAVY_BARE_LINES;
  if (!heavy) return "";

  const lensNote = specialists > 0
    ? ` with ${specialists} project lens${specialists === 1 ? "" : "es"} active`
    : "";
  return `(Heavy review shape — tell the user in one short line as you begin: about ${digest.lines} changed lines${lensNote}, so this review may run long. If they want it faster, a narrower target — a shorter range or a path — shrinks the diff and changes which project lenses activate.)\n\n`;
}

/** How many excluded paths the note lists before folding the rest into one line. */
const NOTE_LIST_CAP = 12;

/** Above this many excluded paths the concrete command bloats; fall back to the recipe. */
const COMMAND_SPEC_CAP = 100;

/** One shell-safe single-quoted word (pathspecs go into a command the model copies). */
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Instruction block for generated files the digest excluded. Beyond naming
 * the paths, it carries a ready-to-run diff command with `:(exclude,literal)`
 * pathspecs baked in — so following the note IS physical exclusion, the
 * count and the command cannot drift, and the generated bulk never enters
 * any finder's context. Quiet when nothing was excluded or
 * `--include-generated` opted back in.
 */
export function generatedExclusionNote(digest: DiffDigest | undefined, includeGenerated: boolean): string {
  if (digest === undefined || includeGenerated || digest.generated.length === 0) return "";
  const n = digest.generated.length;
  const saved = digest.generatedLines;
  const paths = n === 1 ? "path" : "paths";
  const shown = digest.generated.slice(0, NOTE_LIST_CAP);
  const more = n - shown.length;
  const list = shown.map((p) => `- \`${p}\``).join("\n") + (more > 0 ? `\n- …and ${more} more` : "");
  const command = digest.range !== undefined && n <= COMMAND_SPEC_CAP
    ? `Gather the diff with them already excluded:

\`\`\`
git diff ${digest.range} -- . ${digest.generated.map((p) => shellQuote(`:(exclude,literal)${p}`)).join(" ")}
\`\`\`

Apply the same pathspecs to \`git diff HEAD\` when working-tree changes are in scope. `
    : `Exclude them from the diff you gather by piping the changed paths through \`git check-attr -z --stdin linguist-generated\` and adding one \`:(exclude,literal)<path>\` pathspec per flagged path — to \`git diff HEAD\` too, when working-tree changes are in scope. `;
  return `## Generated files — out of scope

The repo's git attributes mark ${n} changed ${paths} \`linguist-generated\` — about ${saved} lines of machine-written churn, excluded from this review's sizing:

${list}

${command}Do not widen the command back out: any other path git marks \`linguist-generated\` is equally out of scope, and no finding belongs inside these files — open one only as context for a kept finding that depends on it. If nothing hand-written remains once the diff is gathered, do not spawn the finders — return \`[]\` and tell the user the only changes are generated files. Otherwise, tell the user in one short line as you begin that generated files were excluded (${n} ${paths}, about ${saved} lines). Pass \`--include-generated\` to review them too.

`;
}
