import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `--model auto` — route the reviewer fleet to the cheapest of the user's
 * favorite models (TUI ★ list, `~/.local/state/opencode/model.json`), with
 * the rest as cost-ordered fallbacks for model-shaped failures (quota,
 * credits, rate limits).
 *
 * Pricing comes from the opencode server's own catalog (`GET
 * /config/providers` on the session's serverUrl — connected providers only,
 * so the ladder never pins a model the user cannot call). Two pricing rules:
 *
 *   - Plan-pot entries (`$0` in the catalog) are NOT free — they draw down a
 *     metered quota. They inherit the cheapest *cash* price of the same
 *     model across connected providers, so they still sort first without
 *     pretending to cost nothing.
 *   - Favorites absent from the catalog are stale (renamed/deprecated) and
 *     are dropped: they would only burn a doomed fallback attempt.
 *
 * Blended price weights input 3:1 — review workloads read a diff into
 * context and write short findings back out.
 */

export interface ModelRoute {
  providerID: string;
  modelID: string;
}

export interface CatalogPrice {
  input: number;
  output: number;
}

/** `providerID/modelID` → catalog price, connected providers only. */
export type Catalog = Map<string, CatalogPrice>;

/** Ladder entries beyond the primary; keeps the injected agent list sane. */
export const AUTO_LADDER_MAX = 4;

/** Review workload reads far more than it writes. */
export const INPUT_WEIGHT = 0.75;
export const OUTPUT_WEIGHT = 0.25;

const FAVORITES_FILE = join(homedir(), ".local/state/opencode/model.json");

// --- favorites ---------------------------------------------------------------

/** The user's TUI-starred models, file order, duplicates collapsed. */
export function readFavorites(path: string = FAVORITES_FILE): ModelRoute[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: { favorite?: { providerID?: unknown; modelID?: unknown }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: ModelRoute[] = [];
  const seen = new Set<string>();
  for (const f of parsed.favorite ?? []) {
    if (typeof f?.providerID !== "string" || typeof f?.modelID !== "string") continue;
    const key = `${f.providerID}/${f.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerID: f.providerID, modelID: f.modelID });
  }
  return out;
}

// --- catalog -----------------------------------------------------------------

/**
 * The catalog serves cost either as an object or as a one-entry array
 * depending on endpoint; accept both, drop everything else.
 */
export function normalizeCost(raw: unknown): CatalogPrice | undefined {
  const c = Array.isArray(raw) ? raw[0] : raw;
  if (typeof c !== "object" || c === null) return undefined;
  const { input, output } = c as { input?: unknown; output?: unknown };
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return { input, output };
}

/**
 * Fetch the connected-provider catalog from the session's opencode server.
 * The response contains raw API keys; only normalized prices leave this
 * function — never log or persist the response.
 */
export async function fetchCatalog(serverUrl: URL | string): Promise<Catalog | undefined> {
  let res: Response;
  try {
    res = await fetch(new URL("/config/providers", serverUrl), {
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  let body: {
    providers?: { id?: unknown; models?: Record<string, { cost?: unknown }> }[];
  };
  try {
    body = await res.json();
  } catch {
    return undefined;
  }
  const catalog: Catalog = new Map();
  for (const p of body.providers ?? []) {
    if (typeof p?.id !== "string" || typeof p?.models !== "object" || p.models === null) continue;
    for (const [modelID, m] of Object.entries(p.models)) {
      const price = normalizeCost(m?.cost);
      if (price) catalog.set(`${p.id}/${modelID}`, price);
    }
  }
  return catalog;
}

// --- pricing -----------------------------------------------------------------

export const blended = (p: CatalogPrice): number =>
  INPUT_WEIGHT * p.input + OUTPUT_WEIGHT * p.output;

/** Cheapest cash price for the same model on any connected provider. */
function cheapestCashSibling(modelID: string, catalog: Catalog): number | undefined {
  let best: number | undefined;
  for (const [key, price] of catalog) {
    if (!key.endsWith(`/${modelID}`)) continue;
    const b = blended(price);
    if (b > 0 && (best === undefined || b < best)) best = b;
  }
  return best;
}

/**
 * Effective cost of a route: catalog price, except plan pots ($0) price at
 * their cheapest cash sibling. `undefined` = not in the catalog (stale).
 */
export function effectiveCost(route: ModelRoute, catalog: Catalog): number | undefined {
  const price = normalizeCost(catalog.get(`${route.providerID}/${route.modelID}`));
  if (!price) return undefined;
  const b = blended(price);
  return b > 0 ? b : cheapestCashSibling(route.modelID, catalog);
}

// --- ladder ------------------------------------------------------------------

export interface LadderEntry {
  route: ModelRoute;
  /** Blended $/Mtok used for the ordering (pots priced at cash sibling). */
  effective: number;
  /** True when the catalog lists $0 — quota-metered, not free. */
  pot: boolean;
}

/**
 * Cost-ordered ladder over the favorites. Stable: equal effective costs keep
 * favorites-file order. Unpriced (stale) favorites are dropped.
 */
export function buildLadder(
  favorites: ModelRoute[],
  catalog: Catalog,
  cap: number = AUTO_LADDER_MAX,
): LadderEntry[] {
  const entries: (LadderEntry & { index: number })[] = [];
  const seen = new Set<string>();
  favorites.forEach((route, index) => {
    const key = routeRef(route);
    if (seen.has(key)) return;
    const effective = effectiveCost(route, catalog);
    if (effective === undefined) return;
    seen.add(key);
    entries.push({ route, effective, pot: blended(catalog.get(key)!) === 0, index });
  });
  entries.sort((a, b) => a.effective - b.effective || a.index - b.index);
  return entries.slice(0, cap).map(({ route, effective, pot }) => ({ route, effective, pot }));
}

export const routeRef = (r: ModelRoute): string => `${r.providerID}/${r.modelID}`;

// --- active route (plugin startup decides; the compiler consumes) ------------

let active: LadderEntry[] | undefined;

/** Called once at plugin startup; also by tests to seed a fixture ladder. */
export function setActiveLadder(ladder: LadderEntry[] | undefined): void {
  active = ladder;
}

/** Ladder resolved at plugin startup, or undefined when auto is off/unusable. */
export function activeLadder(): LadderEntry[] | undefined {
  return active;
}

/**
 * Resolve the auto ladder from the session's server. Returns undefined when
 * the catalog is unreachable (auto then degrades to the session model).
 */
export async function resolveAutoLadder(
  serverUrl: URL | string,
  favoritesPath?: string,
): Promise<LadderEntry[] | undefined> {
  const catalog = await fetchCatalog(serverUrl);
  if (!catalog || catalog.size === 0) return undefined;
  const ladder = buildLadder(readFavorites(favoritesPath), catalog);
  return ladder.length > 0 ? ladder : undefined;
}
