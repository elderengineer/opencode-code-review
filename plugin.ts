import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { tool, type PluginModule } from "@opencode-ai/plugin";

import { LEVELS, type Level } from "./compiler/fragments.ts";
import { composeReview, reviewerFor } from "./compiler/prompt.ts";
import { rememberedModel } from "./compiler/effort.ts";
import { readLensPins, type LensPins } from "./compiler/lenses.ts";
import { resolveAutoLadder, setActiveLadder, routeRef, type LadderEntry } from "./compiler/route.ts";
import { currentVersion, refreshUpdateCache } from "./compiler/update.ts";

/**
 * opencode plugin entry. On startup the config hook injects:
 *   - /code-review and /code-review:create-lens commands (thin templates the
 *     model executes)
 *   - reviewer-<level> subagents, one per effort level (the subagent fleet):
 *     by default they inherit the session model and variant; `max` pins
 *     variant "max"; a sticky `using <model>`/`--model` pin (state file)
 *     overrides the model for all of them until the plugin next loads;
 *     `--model auto` resolves the cost-ordered favorite ladder at startup,
 *     pins the primary to its cheapest entry and injects hidden
 *     reviewer-<level>-alt<i> alternates the prompt falls back to on
 *     model-shaped failures (quota, credits, rate limits)
 *   - reviewer-lens-<name> subagents, one per project lens in the session's
 *     worktree, carrying the lens's optional model/variant pins
 *
 * Everything merges user-wins: if the project config already defines a
 * command or agent of the same name, the project's definition is kept and
 * only missing fields are filled from the defaults.
 *
 * The `code_review_prompt` tool compiles the full instruction prompt for the
 * review command (see compiler/prompt.ts).
 *
 * Prompt prose lives in prompts/*.md, loaded at startup; the TS keeps only
 * structure (models, variants, tools, permissions). A missing file degrades
 * to a minimal fallback with a warning rather than failing the plugin.
 */

const PROMPTS_DIR = join(import.meta.dir, "prompts");

async function loadPrompt(file: string, fallback: string): Promise<string> {
  try {
    return await readFile(join(PROMPTS_DIR, file), "utf8");
  } catch {
    console.warn(`[opencode-code-review] prompts/${file} missing — using fallback`);
    return fallback;
  }
}

const REVIEWER_BODY_FALLBACK =
  "You are a reviewer subagent for the code-review command. Your prompt assigns one role and the review scope; return only the findings or verdict it asks for.";

const CREATE_LENS_FALLBACK =
  "Guide the user to create a project lens file at .opencode/code-review/lenses/<name>.md (ask for its goal, name, optional model/variant pins and path globs, then write it).";

const CODE_REVIEW_FALLBACK =
  'Call the `code_review_prompt` tool with the user arguments below as `arguments`, then follow its output exactly.\n\n<user_arguments>\n$ARGUMENTS\n</user_arguments>';

interface FleetSpec {
  /** Pinned variant, if any. "max" is the only universally supported one. */
  variant?: string;
  color: string;
}

/** Level → variant pin. Low/medium/high inherit the session variant. */
const FLEET: Record<Level, FleetSpec> = {
  low: { color: "#22D3EE" },
  medium: { color: "#34D399" },
  high: { color: "#F59E0B" },
  max: { variant: "max", color: "#EF4444" },
};

function mergeAgentDefaults(def: Record<string, unknown>, user: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...def, ...user };
  for (const key of ["tools", "permission"]) {
    merged[key] = { ...((def[key] as object) ?? {}), ...((user[key] as object) ?? {}) };
  }
  return merged;
}

function reviewerAgent(level: Level, body: string, modelRef: string | undefined, altNote = "") {
  const { variant, color } = FLEET[level];
  return {
    description: `Finder/verifier subagent for the code-review command at ${level} effort.${altNote}`,
    mode: "subagent",
    hidden: true,
    ...(modelRef ? { model: modelRef } : {}),
    ...(variant ? { variant } : {}),
    temperature: 0.1,
    color,
    tools: { "*": false, read: true, grep: true, glob: true, list: true },
    permission: { edit: "deny", bash: "deny", webfetch: "deny" },
    prompt: body,
  };
}

/** A project lens's dedicated finder subagent, with its optional pins. */
function lensAgent(pin: LensPins, body: string) {
  return {
    description: `Finder subagent for the "${pin.name}" project lens.`,
    mode: "subagent",
    hidden: true,
    ...(pin.model ? { model: pin.model } : {}),
    ...(pin.variant ? { variant: pin.variant } : {}),
    temperature: 0.1,
    color: "#A78BFA",
    tools: { "*": false, read: true, grep: true, glob: true, list: true },
    permission: { edit: "deny", bash: "deny", webfetch: "deny" },
    prompt: body,
  };
}

const COMMAND_DESCRIPTION =
  "Review the current diff or a PR for bugs and cleanups. " +
  "Usage: [low|medium|high|max] [--fix] [--comment] [--model auto|<provider/model>] [<pr#>|<branch>|<path>]";

const CREATE_LENS_DESCRIPTION =
  "Create a project lens for code-review (interactive): goal, name, model, " +
  "effort, path gating → .opencode/code-review/lenses/<name>.md";

export const CodeReviewPlugin: PluginModule = {
  id: "opencode-code-review",
  server: async (input) => {
    const [reviewerBody, codeReviewTemplate, createLensTemplate] = await Promise.all([
      loadPrompt("reviewer-subagent.md", REVIEWER_BODY_FALLBACK),
      loadPrompt("code-review.md", CODE_REVIEW_FALLBACK),
      loadPrompt("create-lens.md", CREATE_LENS_FALLBACK),
    ]);
    const lensPins = await readLensPins(input.worktree || input.directory || process.cwd());
    const pinnedModel = rememberedModel();

    // Daily update check (npm + GitHub releases): fire-and-forget so it never
    // delays startup; the result lands in the state cache for the next
    // composed review to announce once.
    void refreshUpdateCache(currentVersion());

    // `--model auto`: resolve the cost-ordered favorite ladder now — the
    // agents injected below pin to it, so a mid-session pin change still
    // waits for the next plugin load, like any explicit pin.
    let autoLadder: LadderEntry[] | undefined;
    if (pinnedModel === "auto") {
      try {
        autoLadder = await resolveAutoLadder(input.serverUrl);
      } catch (err) {
        console.warn(`[opencode-code-review] auto ladder resolution failed: ${err}`);
      }
      setActiveLadder(autoLadder);
      if (autoLadder === undefined) {
        console.warn("[opencode-code-review] --model auto active but no usable favorite ladder; reviewers inherit the session model");
      }
    }
    const fleetPin = pinnedModel === "auto" ? autoLadder?.[0] : undefined;
    const primaryModel = fleetPin ? routeRef(fleetPin.route) : pinnedModel === "auto" ? undefined : pinnedModel;
    return {
      config: (cfg) => {
        cfg.command ??= {};
        cfg.command["code-review"] ??= {
          template: codeReviewTemplate,
          description: COMMAND_DESCRIPTION,
        };
        cfg.command["code-review:create-lens"] ??= {
          template: createLensTemplate,
          description: CREATE_LENS_DESCRIPTION,
        };

        cfg.agent ??= {};
        for (const level of LEVELS) {
          const name = reviewerFor(level);
          cfg.agent[name] = mergeAgentDefaults(reviewerAgent(level, reviewerBody, primaryModel), cfg.agent[name] ?? {});
          // Auto-ladder alternates: cost-ordered fallback subagents the
          // composed prompt names for model-shaped spawn failures.
          autoLadder?.slice(1).forEach((entry, i) => {
            const altName = `${name}-alt${i + 1}`;
            cfg.agent![altName] = mergeAgentDefaults(
              reviewerAgent(level, reviewerBody, routeRef(entry.route), ` (auto-ladder alternate ${i + 1}: ${routeRef(entry.route)})`),
              cfg.agent![altName] ?? {},
            );
          });
        }
        for (const pin of lensPins) {
          const name = `reviewer-lens-${pin.name}`;
          cfg.agent[name] = mergeAgentDefaults(lensAgent(pin, reviewerBody), cfg.agent[name] ?? {});
        }
      },

      tool: {
        code_review_prompt: tool({
          description:
            "Compile the code-review instruction prompt. Pass the user's raw " +
            "command arguments verbatim; follow the returned prompt exactly.",
          args: {
            arguments: tool.schema
              .string()
              .describe("Raw arguments after /code-review, e.g. 'high --fix' or '123 --comment'"),
          },
          execute: async (args, context) => {
            const result = await composeReview(args.arguments, {
              worktree: context.worktree || context.directory,
            });
            return result.prompt;
          },
        }),
      },
    };
  },
};

export default CodeReviewPlugin;
