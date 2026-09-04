import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/**
 * Update notification — checks npm once a day for a newer published
 * version, pulls that version's GitHub release notes, and caches the result
 * under ~/.local/state/opencode so the next compiled review can mention the
 * update once. Talks only to registry.npmjs.org and api.github.com and sends
 * nothing beyond standard request headers. Every failure is swallowed — the
 * check is a convenience, never a failure.
 */

const PACKAGE = "@elderengineer/opencode-code-review";
const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE}/latest`;
const RELEASE_TAG_API = "https://api.github.com/repos/elderengineer/opencode-code-review/releases/tags/v";
export const UPDATE_FILE = join(homedir(), ".local/state/opencode/code-review-update.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  checkedAt?: number;
  latestVersion?: string;
  notes?: string;
  notifiedVersion?: string;
}

export interface UpdateNotice {
  version: string;
  notes?: string;
}

/** Numeric dotted-version compare; prerelease suffixes stripped. */
export function cmpVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v.replace(/^[vV]/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const delta = (pa[i] || 0) - (pb[i] || 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

let memoVersion: string | undefined | null = null;

/** The plugin's own version from package.json; undefined disables the feature. */
export function currentVersion(): string | undefined {
  if (memoVersion !== null) return memoVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version?: unknown };
    memoVersion = typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    memoVersion = undefined;
  }
  return memoVersion;
}

function readCache(file = UPDATE_FILE): UpdateCache | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as UpdateCache;
    if (typeof raw !== "object" || raw === null) return undefined;
    // Keep only well-typed fields — a hand-edited or externally written
    // cache must never reach cmpVersions with a truthy non-string version.
    const cache: UpdateCache = {};
    if (typeof raw.checkedAt === "number") cache.checkedAt = raw.checkedAt;
    if (typeof raw.latestVersion === "string") cache.latestVersion = raw.latestVersion;
    if (typeof raw.notes === "string") cache.notes = raw.notes;
    if (typeof raw.notifiedVersion === "string") cache.notifiedVersion = raw.notifiedVersion;
    return cache;
  } catch {
    return undefined;
  }
}

function writeCache(cache: UpdateCache, file = UPDATE_FILE): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache));
  } catch {
    // best-effort; the cache is a convenience, never a failure
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: {
      accept: "application/json",
      "user-agent": "opencode-code-review-update-check",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Check npm for a newer release (at most once per CHECK_INTERVAL_MS) and
 * cache the result, including that version's GitHub release notes when one
 * exists. Fails soft: any error leaves the cache untouched and retries on
 * the next plugin load.
 */
export async function refreshUpdateCache(current: string | undefined, file = UPDATE_FILE): Promise<void> {
  try {
    if (process.env.CODE_REVIEW_NO_UPDATE_CHECK || !current) return;
    // Merge into the existing cache: a compile racing this refresh (the
    // refresh is unawaited at startup) may have just written notifiedVersion,
    // and wholesale replacement would re-announce the same version.
    const cached = readCache(file);
    if (cached?.checkedAt && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) return;

    const latest = await fetchJson(REGISTRY_LATEST) as { version?: unknown };
    if (typeof latest?.version !== "string") return;
    if (cmpVersions(latest.version, current) <= 0) {
      writeCache({ ...readCache(file), checkedAt: Date.now() }, file);
      return;
    }

    const update: UpdateCache = { ...readCache(file), checkedAt: Date.now(), latestVersion: latest.version };
    try {
      const release = await fetchJson(`${RELEASE_TAG_API}${latest.version}`) as { body?: unknown };
      if (typeof release?.body === "string" && release.body.trim()) {
        update.notes = release.body.replace(/\s+/g, " ").trim().slice(0, 300);
      }
    } catch {
      // notes are optional; the version-only notice still fires
    }
    writeCache(update, file);
  } catch {
    // best-effort; the check is a convenience, never a failure
  }
}

/**
 * The pending update notice, if a newer version is cached and hasn't been
 * announced yet. Reads state only — no network.
 */
export function readUpdateNotice(current: string | undefined, file = UPDATE_FILE): UpdateNotice | undefined {
  if (process.env.CODE_REVIEW_NO_UPDATE_CHECK || !current) return undefined;
  const cache = readCache(file);
  if (!cache?.latestVersion) return undefined;
  if (cmpVersions(cache.latestVersion, current) <= 0) return undefined;
  if (cache.notifiedVersion === cache.latestVersion) return undefined;
  return { version: cache.latestVersion, notes: cache.notes };
}

/** Record that a version has been announced, so it is prompted only once. */
export function markNotified(version: string, file = UPDATE_FILE): void {
  const cache = readCache(file) ?? {};
  writeCache({ ...cache, notifiedVersion: version }, file);
}
