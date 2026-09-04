import { spawn } from "node:child_process";

/**
 * Diff sizing: added+deleted line total and the changed-file list, from one
 * sandboxed `git diff --numstat`. Both the subagent fleet hint and the lens
 * `paths:` gating consume the same digest — one git call per review.
 *
 * Only a literal `a..b` / `a...b` range (never a PR number or path) is
 * accepted, and git runs fully sandboxed: no hooks, no fsmonitor, no askpass,
 * no network protocols, no lazy fetch, no terminal prompt.
 */

export interface DiffDigest {
  lines: number;
  files: string[];
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

function gitNumstat(range: string, worktree: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn(
      "git",
      [
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=",
        "-c", "core.askPass=",
        "diff", "--no-ext-diff", "--no-textconv", "--numstat",
        "--end-of-options", range, "--",
      ],
      {
        cwd: worktree,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_ALLOW_PROTOCOL: "none",
          GIT_NO_LAZY_FETCH: "1",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
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
  });
}

export async function diffDigest(target: string, worktree: string): Promise<DiffDigest | undefined> {
  for (const range of rangeFor(target)) {
    const digest = await digestForRange(range, worktree);
    if (digest !== undefined) return digest;
  }
  return undefined;
}

async function digestForRange(range: string, worktree: string): Promise<DiffDigest | undefined> {
  const stdout = await gitNumstat(range, worktree);
  if (stdout === undefined) return undefined;

  let lines = 0;
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    // numstat reports binary files as `-\t-\tpath` — keep the file (lens
    // gating uses it) but count no lines.
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) {
      lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
      files.push(decodeGitPath(m[3]));
    }
  }
  return files.length > 0 ? { lines, files } : undefined;
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
