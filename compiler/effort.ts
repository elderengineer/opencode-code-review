import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Level } from "./fragments.ts";
import { LEVELS } from "./fragments.ts";
import { MODEL_REF_RE } from "./args.ts";

/**
 * Sticky state — remembers the effort level and fleet model pin the user
 * typed, so a bare `/code-review` reuses them. Stored in small state files
 * under ~/.local/state/opencode (plugins must not write opencode's config).
 */

const STATE_FILE = join(homedir(), ".local/state/opencode/code-review-level");
const MODEL_FILE = join(homedir(), ".local/state/opencode/code-review-model");

export function rememberedLevel(): Level | undefined {
  try {
    const stored = readFileSync(STATE_FILE, "utf8").trim();
    return (LEVELS as readonly string[]).includes(stored) ? (stored as Level) : undefined;
  } catch {
    return undefined;
  }
}

export function rememberLevel(level: Level): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, level + "\n");
  } catch {
    // best-effort; the sticky level is a convenience, never a failure
  }
}

/**
 * Sticky fleet model pin from `using <provider/model>` (`using default`
 * clears it). The pin binds when the plugin next loads — agents are injected
 * at startup, so a fresh pin needs an opencode restart to take effect.
 */
export function rememberedModel(): string | undefined {
  try {
    const stored = readFileSync(MODEL_FILE, "utf8").trim();
    return MODEL_REF_RE.test(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function rememberModel(model: string | undefined): void {
  try {
    if (model === undefined) {
      rmSync(MODEL_FILE, { force: true });
      return;
    }
    mkdirSync(dirname(MODEL_FILE), { recursive: true });
    writeFileSync(MODEL_FILE, model + "\n");
  } catch {
    // best-effort; the pin is a convenience, never a failure
  }
}
