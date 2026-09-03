import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

import { LENS_NAMES, LENS_HEADINGS, TASK_TOOL } from "./fragments.ts";
import type { DiffDigest } from "./budget.ts";

/**
 * Project lenses — the plugin's lens convention, one directory:
 *
 *   <worktree>/.opencode/code-review/lenses/<name>.md
 *
 * Naming behavior (the ONE rule):
 *   - `code.md`                     → replaces the built-in `code` lens (the
 *                                     global perspective prepend; the built-in
 *                                     default is empty)
 *   - a built-in lens name
 *     (`language-pitfalls.md`,
 *      `reuse.md`, ...)             → replaces that built-in lens's text
 *                                     (pure replace; no effect at levels that
 *                                     don't run it)
 *   - any other name                → a project perspective: prepended to
 *                                     EVERY spawned reviewer AND given one
 *                                     dedicated specialist finder at medium+
 *
 * Optional frontmatter gates a lens by path and pins its specialist finder's
 * model/variant. `paths` is a list of globs matched against repo-relative
 * changed paths, e.g. "mobile/**":
 *
 *   ---
 *   paths:
 *     - "mobile/**"
 *   model: opencode/kimi-k3
 *   variant: max
 *   ---
 *
 * A lens with no `paths` is always active. A gated lens is active iff at
 * least one changed file matches any glob; inactive replacements fall back
 * to their built-in counterpart. Every other frontmatter key is ignored.
 */

const LENSES_DIR = ".opencode/code-review/lenses";

export interface Lens {
  name: string;
  body: string;
  paths: string[] | undefined;
}

export interface LensBundle {
  /** Replacement for the built-in (empty) code lens; undefined → built-in. */
  codeOverride: string | undefined;
  /** Active replacement texts for built-in lenses, by name. */
  lensReplacements: Map<string, string>;
  /** Active project lenses: prepended everywhere + one specialist finder. */
  specialists: Lens[];
  /** Block prepended to every finder/verifier/sweep prompt. */
  prepend: string;
}

export const EMPTY_BUNDLE: LensBundle = {
  codeOverride: undefined,
  lensReplacements: new Map(),
  specialists: [],
  prepend: "",
};

export interface LensPins {
  name: string;
  model: string | undefined;
  variant: string | undefined;
}

function parseFrontmatter(raw: string): { paths: string[] | undefined; model: string | undefined; variant: string | undefined; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { paths: undefined, model: undefined, variant: undefined, body: raw };
  const paths: string[] = [];
  let model: string | undefined;
  let variant: string | undefined;
  let inPaths = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const item = line.match(/^\s+-\s*(.+?)\s*$/);
      if (item) {
        paths.push(item[1].replace(/^["']|["']$/g, ""));
        continue;
      }
      inPaths = false;
    }
    const kv = line.match(/^(model|variant):\s*(.+?)\s*$/);
    if (kv) {
      const value = kv[2].replace(/^["']|["']$/g, "");
      if (kv[1] === "model") model = value;
      else variant = value;
    }
  }
  return { paths: paths.length > 0 ? paths : undefined, model, variant, body: raw.slice(m[0].length) };
}

function matchesAnyPath(paths: string[] | undefined, changedFiles: string[]): boolean {
  if (paths === undefined) return true;
  if (changedFiles.length === 0) return false; // no diff info → gated lenses stay off
  return changedFiles.some((f) => paths!.some((p) => new Bun.Glob(p).match(f)));
}

export async function collectLenses(worktree: string, digest: DiffDigest | undefined): Promise<LensBundle> {
  const dir = join(worktree, LENSES_DIR);
  if (!existsSync(dir)) return EMPTY_BUNDLE;

  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return EMPTY_BUNDLE;
  }
  names.sort();

  const changedFiles = digest?.files ?? [];
  const bundle: LensBundle = { ...EMPTY_BUNDLE, lensReplacements: new Map(), specialists: [] };

  for (const name of names) {
    const lensName = basename(name, ".md");
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const { paths, body } = parseFrontmatter(raw);
    const text = body.trim();
    if (text === "") continue;

    if (lensName === "code") {
      if (matchesAnyPath(paths, changedFiles)) bundle.codeOverride = text;
      continue;
    }

    if ((LENS_NAMES as readonly string[]).includes(lensName)) {
      if (matchesAnyPath(paths, changedFiles)) bundle.lensReplacements.set(lensName, text);
      continue;
    }

    if (matchesAnyPath(paths, changedFiles)) {
      bundle.specialists.push({ name: lensName, body: text, paths });
    }
  }

  const sections: string[] = [];
  if (bundle.codeOverride) sections.push(`#### Code lens\n\n${bundle.codeOverride}`);
  for (const s of bundle.specialists) sections.push(`#### ${s.name}\n\n${s.body}`);
  if (sections.length > 0) {
    bundle.prepend =
      `## Project lenses\n\nThe changed project defines the following review lenses — project-specific\nperspectives that apply to every lens and every verification below. Weigh\neach candidate against them before keeping it.\n\n${sections.join("\n\n")}\n`;
  }

  return bundle;
}

/**
 * All project lens files, with their optional model/variant pins, for the
 * plugin's startup agent injection (read without gating — gating is a
 * compile-time decision). Only new-name lenses get a specialist finder, so
 * only those are returned.
 */
export async function readLensPins(worktree: string): Promise<LensPins[]> {
  const dir = join(worktree, LENSES_DIR);
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const pins: LensPins[] = [];
  for (const name of names.sort()) {
    const lensName = basename(name, ".md");
    if (lensName === "code" || (LENS_NAMES as readonly string[]).includes(lensName)) continue;
    try {
      const { model, variant } = parseFrontmatter(await readFile(join(dir, name), "utf8"));
      pins.push({ name: lensName, model, variant });
    } catch {
      continue;
    }
  }
  return pins;
}

/** Built-in lens-set text with active project replacements swapped in, by name. */
export function swapLensTexts(lenses: string, swaps: Map<string, string>): string {
  if (swaps.size === 0) return lenses;
  if (!LENS_NAMES.some((n) => swaps.has(n) && LENS_HEADINGS[n] !== undefined)) return lenses;
  const parts: string[] = [];
  let cursor = 0;
  for (const name of LENS_NAMES) {
    const heading = LENS_HEADINGS[name];
    if (heading === undefined) continue;
    const start = lenses.indexOf(heading, cursor);
    if (start < 0) continue;
    const next = lenses.indexOf("\n### ", start + heading.length);
    const end = next >= 0 ? next + 1 : lenses.length;
    if (start > cursor) parts.push(lenses.slice(cursor, start));
    const swap = swaps.get(name);
    parts.push(swap !== undefined && swap.trim() !== "" ? swap.trim() + "\n" : lenses.slice(start, end));
    cursor = end;
  }
  parts.push(lenses.slice(cursor));
  return parts.join("");
}

/** Brief for a project lens's dedicated finder (its lens text is in the prepend). */
export function specialistBrief(lens: Lens): string {
  return `### ${lens.name} (project lens)

Your dedicated pass is the "${lens.name}" project lens above. Hunt ONLY for
defects that perspective reveals; treat the lens guidance as your sole focus
for this pass. Otherwise behave as any other finder: surface up to the cap of
candidate findings, each with \`file\`, \`line\`, a one-line \`summary\`, and
a concrete \`failure_scenario\`. Spawn this lens's finder via the ${TASK_TOOL}
tool (subagent_type: \`reviewer-lens-${lens.name}\`).
`;
}
