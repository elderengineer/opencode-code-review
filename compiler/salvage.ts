import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Salvage findings from failed or interrupted review sessions.
 *
 * When a review dies (wall-clock timeout, crash), the coordinator's last
 * message is orchestration chatter — the actual candidate lists and verdicts
 * live in the child subagent sessions inside opencode's local SQLite store.
 * This walker recovers them read-only: for every `reviewer-*` child of the
 * given parent session it collects all assistant text parts chronologically,
 * extracts fenced JSON findings when present, and reports text-only blobs for
 * the harness's interpreter instead of failing.
 *
 * Deliberately NOT done here: merging, deduping, and level capping (the
 * caller's job), and any interpretation of prose output.
 *
 * Zero npm dependencies: `bun:sqlite` is a Bun builtin.
 */

const DEFAULT_DB = join(homedir(), ".local/share/opencode/opencode.db");
const REVIEWER_PREFIX = "reviewer-";
const MAX_TEXT_CHARS = 40_000;

export interface SalvageFinding {
  [key: string]: unknown;
}

export interface SalvageChild {
  id: string;
  agent: string;
  title: string;
  timeCreated: number;
  tokensOutput: number;
  /** Assistant text parts, chronological. */
  text: string;
  textTruncated: boolean;
  /** Parsed ```json findings when the child emitted a fenced array. */
  findings?: SalvageFinding[];
}

export interface SalvageSkipped {
  id: string;
  agent: string;
  title: string;
  reason: string;
}

export interface SalvageReport {
  parent: { id: string; agent: string | null; title: string | null };
  database: string;
  generatedAt: string;
  totals: { children: number; withFindings: number; textOnly: number; skipped: number };
  children: SalvageChild[];
  skipped: SalvageSkipped[];
}

/** Extract fenced ```json findings from assistant text — last valid block wins. */
export function extractJsonFindings(text: string): SalvageFinding[] | undefined {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g)) {
    candidates.push(m[1]);
  }
  const bare = text.trim();
  if (bare.startsWith("[")) candidates.push(bare);

  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "object" && item !== null)) {
        return parsed as SalvageFinding[];
      }
    } catch {
      // not JSON — try the next candidate
    }
  }
  return undefined;
}

/**
 * Walk the child sessions of `parentId` and recover what each reviewer
 * produced. Read-only: the database is opened `mode=ro` (never `immutable`,
 * which would ignore the WAL and miss the most recent writes).
 */
export function salvageSession(parentId: string, options: { dbPath?: string } = {}): SalvageReport {
  const dbPath = options.dbPath ?? join(homedir(), ".local/share/opencode/opencode.db");
  const generatedAt = new Date().toISOString();

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    throw new Error(`cannot open opencode database at ${dbPath}: ${err}`);
  }

  try {
    const parentRow = db
      .query<Record<string, unknown>, [string]>("SELECT id, agent, title FROM session WHERE id = ?")
      .get(parentId);
    if (!parentRow) throw new Error(`session ${parentId} not found in ${dbPath}`);

    const children = db
      .query<Record<string, unknown>, [string]>(
        "SELECT id, agent, title, time_created, tokens_output FROM session WHERE parent_id = ? ORDER BY time_created",
      )
      .all(parentId);

    const parts = db.query<Record<string, unknown>, [string]>(
      "SELECT json_extract(m.data,'$.role') AS role, json_extract(p.data,'$.type') AS type, json_extract(p.data,'$.text') AS text FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? ORDER BY m.time_created, p.id",
    );

    const salvaged: SalvageChild[] = [];
    const skipped: SalvageSkipped[] = [];
    let withFindings = 0;
    let textOnly = 0;

    for (const child of children) {
      const agent = typeof child.agent === "string" ? child.agent : "";
      if (!agent.startsWith(REVIEWER_PREFIX)) {
        skipped.push({
          id: String(child.id),
          agent,
          title: typeof child.title === "string" ? child.title : "",
          reason: `agent "${agent}" is not a reviewer`,
        });
        continue;
      }

      let text = "";
      for (const row of parts.all(String(child.id)) as { role?: unknown; type?: unknown; text?: unknown }[]) {
        if (row.role !== "assistant" || row.type !== "text" || typeof row.text !== "string") continue;
        text += (text ? "\n" : "") + row.text;
      }

      if (!text.trim()) {
        skipped.push({
          id: String(child.id),
          agent,
          title: typeof child.title === "string" ? child.title : "",
          reason: "no assistant text (interrupted before any output)",
        });
        continue;
      }

      const textTruncated = text.length > MAX_TEXT_CHARS;
      const childOut: SalvageChild = {
        id: String(child.id),
        agent,
        title: typeof child.title === "string" ? child.title : "",
        timeCreated: typeof child.time_created === "number" ? child.time_created : 0,
        tokensOutput: typeof child.tokens_output === "number" ? child.tokens_output : 0,
        text: textTruncated ? text.slice(0, MAX_TEXT_CHARS) : text,
        textTruncated,
      };
      const findings = extractJsonFindings(text);
      if (findings) {
        childOut.findings = findings;
        withFindings++;
      } else {
        textOnly++;
      }
      salvaged.push(childOut);
    }

    return {
      parent: {
        id: String(parentRow.id),
        agent: typeof parentRow.agent === "string" ? parentRow.agent : null,
        title: typeof parentRow.title === "string" ? parentRow.title : null,
      },
      database: dbPath,
      generatedAt,
      totals: {
        children: salvaged.length,
        withFindings,
        textOnly,
        skipped: skipped.length,
      },
      children: salvaged,
      skipped,
    };
  } finally {
    db.close();
  }
}

/** CLI entry: `bun compiler/salvage.ts <parentSessionId> [--db <path>] [--out <file>]` */
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let dbPath: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") dbPath = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else positional.push(argv[i]);
  }

  const parentId = positional[0];
  if (!parentId) {
    console.error("usage: bun compiler/salvage.ts <parentSessionId> [--db <path>] [--out <file>]");
    process.exit(1);
  }

  try {
    const report = salvageSession(parentId, { dbPath });
    const json = JSON.stringify(report, null, 2);
    if (out) {
      await Bun.write(out, json + "\n");
      console.error(`salvage report written to ${out} (${report.totals.children} children, ${report.totals.withFindings} with fenced findings, ${report.totals.skipped} skipped)`);
    } else {
      console.log(json);
    }
  } catch (err) {
    console.error(`salvage failed: ${err}`);
    process.exit(1);
  }
}
