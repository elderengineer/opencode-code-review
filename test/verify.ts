/**
 * Behavioral checks for the compiler. Run: bun test/verify.ts
 */
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCommand, pickLevel, LEVEL_PREFIX_RE, isLevelTypo } from "../compiler/args.ts";
import { rememberedLevel, rememberLevel, rememberedModel, rememberModel } from "../compiler/effort.ts";
import { composeCell } from "../compiler/cells.ts";
import { collectLenses, readLensPins, swapLensTexts, EMPTY_BUNDLE } from "../compiler/lenses.ts";
import { composeReview, reviewerFor } from "../compiler/prompt.ts";
import { buildPreamble } from "../compiler/preamble.ts";
import { diffDigest, decodeGitPath, heavyShapeNote } from "../compiler/budget.ts";
import { gitlabCommentAppendix } from "../compiler/appendices.ts";
import { LEVELS, EXTENDED_LENS_SET, LENS_HEADINGS, LENS_TEXT, LENS_NAMES } from "../compiler/fragments.ts";
import {
  buildLadder,
  readFavorites,
  normalizeCost,
  effectiveCost,
  setActiveLadder,
  activeLadder,
  routeRef,
  type Catalog,
  type ModelRoute,
} from "../compiler/route.ts";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${name}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}

// --- invocation parsing ------------------------------------------------------

{
  console.log("parseCommand");
  const a = parseCommand("high --fix 123");
  check("level parsed", a.level === "high");
  check("fix flag", a.fix === true);
  check("target extracted", a.target === "123");
  check("comment unset", a.comment === false);

  const b = parseCommand("--comment 42");
  check("flags before target", b.comment === true && b.level === undefined && b.target === "42");

  const c = parseCommand("ultra");
  check("unknown level becomes target", c.target === "ultra" && c.level === undefined);

  const d = parseCommand("maxxx");
  check("mistyped level detected", d.mistypedLevel === "maxxx");
  check("prefix regex is level-shaped", LEVEL_PREFIX_RE.test("maxxx") && !LEVEL_PREFIX_RE.test("web"));

  const e = parseCommand("`main..HEAD`");
  check("backticks stripped from target", e.target === "main..HEAD");

  const g = parseCommand("medium using opencode-go/deepseek-v4-flash");
  check("model pin parsed", g.modelPin === "opencode-go/deepseek-v4-flash" && g.level === "medium" && g.target === "");
  const h = parseCommand("using default high --fix");
  check("using default + flags", h.modelPin === "default" && h.level === "high" && h.fix === true);
  check("no using → no pin", parseCommand("high --fix").modelPin === undefined);

  const np = parseCommand("--post --no-post");
  check("--no-post clears --post", np.post === false && parseCommand("--post").post === true);

  const f = parseCommand("");
  check("empty invocation", f.level === undefined && f.target === "" && !f.fix && !f.comment && !f.post);

  const t = parseCommand("hihg");
  check("transposed typo detected", t.mistypedLevel === "hihg" && isLevelTypo("hihg"));
  check("typo head not kept as target", t.target === "");
  check("branch near level name stays target", parseCommand("media").target === "media");
}

{
  console.log("pickLevel");
  check("explicit wins", pickLevel({ level: "low" }, "max") === "low");
  check("remembered second", pickLevel({ level: undefined }, "max") === "max");
  check("default medium", pickLevel({ level: undefined }) === "medium");
}

// --- sticky level -------------------------------------------------------------

{
  console.log("sticky level");
  const before = rememberedLevel();
  rememberLevel("high");
  check("level persisted", rememberedLevel() === "high");
  rememberLevel("low");
  check("level updated", rememberedLevel() === "low");
  // restore
  if (before === undefined) {
    rmSync(join(process.env.HOME!, ".local/state/opencode/code-review-level"), { force: true });
  } else {
    rememberLevel(before);
  }
}

// --- sticky model pin -----------------------------------------------------------

{
  console.log("sticky model");
  const before = rememberedModel();
  rememberModel("opencode-go/deepseek-v4-flash");
  check("model persisted", rememberedModel() === "opencode-go/deepseek-v4-flash");
  rememberModel("not-a-ref");
  check("invalid ref reads as unset", rememberedModel() === undefined);
  rememberModel("auto");
  check("auto persisted", rememberedModel() === "auto");
  rememberModel(before);
}

// --- auto route (--model auto) ----------------------------------------------------

{
  console.log("auto route");

  // catalog: object and array cost shapes, a $0 plan pot, a stale provider
  const catalog: Catalog = new Map(Object.entries({
    "zai-coding-plan/glm-flash": { input: 0, output: 0 },
    "opencode-go/glm-flash": { input: 0.075, output: 0.25 },
    "opencode-go/ds-flash": [{ input: 0.22, output: 0.66 }],
    "deepseek/ds-pro": { input: 0.435, output: 0.87 },
    "opencode-go/ds-pro": { input: 0.66, output: 1.98 },
    "prov-x/only-cash": { input: 3, output: 9 },
  }));
  check("array cost shape normalized", normalizeCost([{ input: 1, output: 2 }])?.input === 1);

  const favs: ModelRoute[] = [
    { providerID: "zai-coding-plan", modelID: "glm-flash" },
    { providerID: "opencode-go", modelID: "ds-flash" },
    { providerID: "zai-coding-plan", modelID: "glm-flash" }, // duplicate
    { providerID: "deepseek", modelID: "ds-pro" },
    { providerID: "stale-prov", modelID: "gone" }, // not in catalog → dropped
    { providerID: "opencode-go", modelID: "ds-pro" },
    { providerID: "prov-x", modelID: "only-cash" },
  ];

  // pot priced via cash sibling (0.1188 < 0.33) → first; stale dropped;
  // ties (none here) would keep file order; cap 4 applies
  const ladder = buildLadder(favs, catalog);
  check("ladder capped at 4", ladder.length === 4);
  check("pot routes to cheapest first", routeRef(ladder[0].route) === "zai-coding-plan/glm-flash" && ladder[0].pot);
  check("pot effective price is cash sibling", Math.abs(ladder[0].effective - 0.11875) < 1e-9);
  check("cash sorted by blended price", routeRef(ladder[1].route) === "opencode-go/ds-flash");
  check("pricier cash next", routeRef(ladder[2].route) === "deepseek/ds-pro");
  check("stale favorite dropped", ladder.every((e) => routeRef(e.route) !== "stale-prov/gone"));

  // cap lift shows full order; expensive cash last
  const full = buildLadder(favs, catalog, 10);
  check("full ladder keeps cheapest-cash-last", routeRef(full[full.length - 1].route) === "prov-x/only-cash");
  check("full ladder drops stale only", full.length === 5);

  // unpriced pot with no cash sibling is unusable → dropped
  const lonely = buildLadder(
    [{ providerID: "zai-coding-plan", modelID: "glm-flash" }, { providerID: "orphan", modelID: "pot" }],
    new Map([["orphan/pot", { input: 0, output: 0 }]]),
  );
  check("orphan pot dropped", lonely.length === 0);
  check("effectiveCost of unknown route is undefined", effectiveCost(favs[4], catalog) === undefined);

  // favorites file: tolerant parse, order and dedup
  const dir = mkdtempSync(join(tmpdir(), "ocr-route-"));
  const favFile = join(dir, "model.json");
  writeFileSync(favFile, JSON.stringify({ favorite: [{ providerID: "a", modelID: "x" }, { providerID: "a", modelID: "x" }, { providerID: "b", modelID: "y" }] }));
  const read = readFavorites(favFile);
  check("favorites read + deduped in order", read.length === 2 && read[0].modelID === "x" && read[1].modelID === "y");
  check("missing favorites file tolerated", readFavorites(join(dir, "nope.json")).length === 0);
  writeFileSync(favFile, "{not json");
  check("corrupt favorites tolerated", readFavorites(favFile).length === 0);
  rmSync(dir, { recursive: true, force: true });

  // arg parsing
  check("--model auto parsed", parseCommand("--model auto high").modelPin === "auto");
  check("using auto parsed", parseCommand("high using auto").modelPin === "auto");
  check("--model ref parsed", parseCommand("--model opencode/kimi-k3 high").modelPin === "opencode/kimi-k3");
  check("--model default parsed", parseCommand("--model default").modelPin === "default");
  check("--model outranks using", parseCommand("--model auto using opencode/kimi-k3").modelPin === "auto");
  check("--model value not a target", parseCommand("--model auto").target === "");

  // cell: fallback clause names alternates; low cell stays fleet-free
  const cellWithFallback = composeCell({
    level: "high",
    reviewer: reviewerFor("high"),
    lenses: EMPTY_BUNDLE,
    fallbacks: ["reviewer-high-alt1", "reviewer-high-alt2"],
  });
  check("fallback clause lists alternates", cellWithFallback.includes("reviewer-high-alt1") && cellWithFallback.includes("reviewer-high-alt2"));
  check("fallback clause names model-shaped errors", cellWithFallback.includes("usage") && cellWithFallback.includes("quota") && cellWithFallback.includes("402/429"));
  check("fallback clause fails closed", cellWithFallback.includes("NOT fallbacks") && cellWithFallback.includes("general-purpose"));
  check("no clause without fallbacks", !composeCell({ level: "high", reviewer: reviewerFor("high"), lenses: EMPTY_BUNDLE }).includes("Model fallback"));
  check("no clause at low", !composeCell({ level: "low", reviewer: reviewerFor("low"), lenses: EMPTY_BUNDLE, fallbacks: ["reviewer-low-alt1"] }).includes("Model fallback"));

  // preamble notes: typed, active, degraded
  const autoTyped = buildPreamble({ args: parseCommand("using auto"), remembered: undefined, level: "high" });
  check("typed auto note", autoTyped.includes("Auto routing queued") && autoTyped.includes("restart opencode"));
  const ladderFixture: Parameters<typeof setActiveLadder>[0] = [
    { route: { providerID: "zai-coding-plan", modelID: "glm-flash" }, effective: 0.11875, pot: true },
    { route: { providerID: "opencode-go", modelID: "ds-flash" }, effective: 0.33, pot: false },
  ];
  const autoActive = buildPreamble({
    args: parseCommand("high"),
    remembered: undefined,
    level: "high",
    pinnedModel: "auto",
    autoLadder: ladderFixture!,
  });
  check("active auto note names primary", autoActive.includes("zai-coding-plan/glm-flash") && autoActive.includes("cheapest of the user's favorite models"));
  check("active auto note names fallback", autoActive.includes("opencode-go/ds-flash"));
  check("active auto note marks pot", autoActive.includes("plan pot"));
  const autoDegraded = buildPreamble({ args: parseCommand("high"), remembered: undefined, level: "high", pinnedModel: "auto", autoLadder: undefined });
  check("degraded auto note", autoDegraded.includes("no usable favorite ladder"));
  const badAuto = buildPreamble({ args: parseCommand("using autos"), remembered: undefined, level: "high" });
  check("near-miss auto pin reported", badAuto.includes("Ignoring unrecognized model pin"));

  // full assembly with a seeded ladder. The active-pin path requires the
  // sticky state to hold `auto` (as it would after the invocation that typed
  // it) — composeReview runs with remember:false to leave no trace.
  const modelBefore = rememberedModel();
  const composeDir = mkdtempSync(join(tmpdir(), "ocr-compose-auto-"));
  rememberModel("auto");
  setActiveLadder(ladderFixture);
  check("activeLadder roundtrip", activeLadder()?.[0].route.providerID === "zai-coding-plan");
  const autoRun = await composeReview("high using auto", { worktree: composeDir, remember: false });
  check("auto pin announcement", autoRun.prompt.includes("zai-coding-plan/glm-flash"));
  check("auto run names alternate agents", autoRun.prompt.includes("reviewer-high-alt1"));
  check("auto run keeps primary agent", autoRun.prompt.includes("reviewer-high"));
  check("autoLadder in result", autoRun.autoLadder?.length === 2);
  setActiveLadder(undefined);
  const noLadder = await composeReview("high using auto", { worktree: composeDir, remember: false });
  check("no ladder → no alternate agents", !noLadder.prompt.includes("reviewer-high-alt1"));
  check("no ladder → degraded note", noLadder.prompt.includes("no usable favorite ladder"));
  const nonAuto = await composeReview("high", { worktree: composeDir, remember: false });
  check("non-auto run has no fallback machinery", !nonAuto.prompt.includes("Model fallback") && !nonAuto.prompt.includes("reviewer-high-alt1"));
  if (modelBefore === undefined) {
    rmSync(join(process.env.HOME!, ".local/state/opencode/code-review-model"), { force: true });
  } else {
    rememberModel(modelBefore);
  }
  rmSync(composeDir, { recursive: true, force: true });
}

// --- digest (binary-safe numstat) -------------------------------------------------

{
  console.log("diffDigest");
  const dir = mkdtempSync(join(tmpdir(), "ocr-digest-"));
  const git = (args: string[]) =>
    spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  git(["init", "-q"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(["add", "."]);
  git(["commit", "-qm", "one"]);
  writeFileSync(join(dir, "a.txt"), "two\n");
  writeFileSync(join(dir, "img.bin"), Buffer.from([0, 1, 2, 0]));
  git(["add", "."]);
  git(["commit", "-qm", "two"]);
  const d = await diffDigest("HEAD~1..HEAD", dir);
  check("binary file kept in digest", d?.files.includes("img.bin") === true);
  check("binary rows add no lines", d?.lines === 2);
  rmSync(dir, { recursive: true, force: true });
  check("git C-quoted path decoded", decodeGitPath('"mobile/\\346\\226\\207\\346\\241\\243.kt"') === "mobile/文档.kt");
  check("rename collapsed to new path", decodeGitPath("old/{a => b}/c.txt") === "old/b/c.txt" && decodeGitPath("a.txt => b.txt") === "b.txt");
}

// --- heavy shape note --------------------------------------------------------------

{
  console.log("heavy shape note");
  const big = { lines: 1344, files: ["docs/plan/tla.md", "src/x.ts"] };
  check("silent at low", heavyShapeNote("low", big, 4, "") === "");
  check("silent without digest", heavyShapeNote("medium", undefined, 4, "") === "");
  check("silent on small diff", heavyShapeNote("medium", { lines: 300, files: ["a.ts"] }, 4, "") === "");
  check("silent with one lens on mid diff", heavyShapeNote("medium", { lines: 900, files: ["a.ts"] }, 1, "") === "");
  const fired = heavyShapeNote("medium", big, 4, "");
  check("fires on many lenses + large diff", fired.includes("Heavy review shape") && fired.includes("4 project lenses"));
  check("fires on very large diff alone", heavyShapeNote("high", { lines: 3000, files: ["a.ts"] }, 0, "").includes("Heavy review shape"));
  check("unscoped target advises narrower target", fired.includes("narrower target"));
  check("path target drops the advice", !heavyShapeNote("medium", big, 4, "src/main").includes("narrower target"));
  check("range target keeps the advice", heavyShapeNote("medium", big, 4, "main...HEAD").includes("narrower target"));

  // End-to-end: a >2500-line committed diff trips the note through composeReview.
  const dir = mkdtempSync(join(tmpdir(), "ocr-heavy-"));
  const git = (args: string[]) =>
    spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
  git(["init", "-q"]);
  writeFileSync(join(dir, "big.txt"), Array.from({ length: 2600 }, (_, i) => `line ${i}`).join("\n") + "\n");
  git(["add", "."]);
  git(["commit", "-qm", "one"]);
  writeFileSync(join(dir, "big.txt"), "changed\n");
  git(["add", "."]);
  git(["commit", "-qm", "two"]);
  const result = await composeReview("medium", { worktree: dir, remember: false });
  check("composeReview includes the note", result.prompt.includes("Heavy review shape"));
  rmSync(dir, { recursive: true, force: true });
}

// --- gitlab MR ref in --comment appendix -------------------------------------------

{
  console.log("gitlab appendix");
  check("!7 keeps the MR ref", gitlabCommentAppendix("!7").includes("glab mr note !7"));
  check("bare number omitted", gitlabCommentAppendix("7").includes("glab mr note -m"));
  check("branch target kept", gitlabCommentAppendix("feature-x").includes("glab mr note feature-x"));
}

// --- cells ---------------------------------------------------------------------

{
  console.log("cells");
  const cell = (level: (typeof LEVELS)[number]) =>
    composeCell({ level, reviewer: reviewerFor(level), lenses: EMPTY_BUNDLE });

  const low = cell("low");
  check("low: single pass, no fleet", low.includes("No subagents, no full-file reads"));
  check("low: cap 4 and (none) marker", low.includes("≤4 findings") && low.includes("(none)"));
  check("low: no verify phase", !low.includes("Phase 2"));

  const medium = cell("medium");
  check("medium: 8 built-in finders", medium.includes("8 independent finders"));
  check("medium: names reviewer subagent", medium.includes("reviewer-medium"));
  check("medium: precise rubric", medium.includes("CONFIRMED") && medium.includes("PLAUSIBLE by default") === false);
  check("medium: cap 8", medium.includes("≤8 findings"));
  check("medium: no sweep", !medium.includes("Phase 3"));
  check("medium: unthrottled spawn protocol", medium.includes("no concurrency cap"));
  check("medium: halve in-flight on congestion", medium.includes("half as many spawns in flight") && medium.includes("429"));
  check("medium: inline fallback on repeated congestion", medium.includes("run that lens or verification") && medium.includes("sequentially"));
  check("medium: no spawn wave cap", !medium.includes("waves of at most"));

  const high = cell("high");
  check("high: recall rubric", high.includes("PLAUSIBLE by default"));
  check("high: cap 10", high.includes("≤10 findings"));
  check("high: halve in-flight on congestion", high.includes("half as many spawns in flight") && high.includes("429"));

  const max = cell("max");
  check("max: extended set (language-pitfalls)", max.includes("Language-pitfall specialist"));
  check("max: sweep phase", max.includes("Phase 3 — Sweep for gaps"));
  check("max: 10 finders", max.includes("10 independent finders"));
  check("max: cap 15", max.includes("≤15 findings"));
  check("max: names reviewer subagent", max.includes("reviewer-max"));
  check("max: maximum lead-in", max.includes("maximum effort"));
  check("max: sweep congestion protocol", max.includes("half as many spawns in flight"));
  check("max: no spawn wave cap", !max.includes("waves of at most"));
}

// --- lenses --------------------------------------------------------------------

{
  console.log("lenses");
  const dir = mkdtempSync(join(tmpdir(), "ocr-lenses-"));
  const lensDir = join(dir, ".opencode/code-review/lenses");
  mkdirSync(lensDir, { recursive: true });
  writeFileSync(join(lensDir, "code.md"), "---\npaths:\n  - \"web/**\"\n---\nWeb frontend perspective.");
  writeFileSync(join(lensDir, "fp.md"), "Functional programming discipline.");
  writeFileSync(
    join(lensDir, "language-pitfalls.md"),
    "---\npaths:\n  - \"mobile/**\"\n---\n\n### Language-pitfall specialist\n\nAndroid pitfalls only.",
  );
  writeFileSync(
    join(lensDir, "pinned.md"),
    "---\npaths:\n  - \"infra/**\"\nmodel: opencode/kimi-k3\nvariant: max\n---\nPinned lens body.",
  );

  // digest: only backend changed → gated lenses inactive, fp specialist active
  const backendOnly = await collectLenses(dir, { lines: 100, files: ["backend/x.py"] });
  check("gated code lens inactive on non-matching diff", backendOnly.codeOverride === undefined);
  check("gated lens replacement inactive on non-matching diff", backendOnly.lensReplacements.size === 0);
  check("ungated specialist active", backendOnly.specialists.length === 1 && backendOnly.specialists[0].name === "fp");
  check("prepend block built", backendOnly.prepend.includes("## Project lenses") && backendOnly.prepend.includes("Functional programming discipline."));
  check("prepend excludes inactive code lens", !backendOnly.prepend.includes("Web frontend perspective."));

  // digest: web changed → code lens active
  const webOnly = await collectLenses(dir, { lines: 100, files: ["web/a.ts"] });
  check("gated code lens active on matching diff", webOnly.codeOverride === "Web frontend perspective.");

  // digest: web + mobile → code active, language-pitfalls replacement active
  const mixed = await collectLenses(dir, { lines: 100, files: ["web/a.ts", "mobile/b.kt"] });
  check("lens replacement collected", mixed.lensReplacements.get("language-pitfalls")?.includes("Android pitfalls only") === true);

  // digest: mobile only → language-pitfalls replacement active, code lens inactive
  const mobileOnly = await collectLenses(dir, { lines: 100, files: ["mobile/b.kt"] });
  check("lens replacement gated to its paths", mobileOnly.lensReplacements.has("language-pitfalls") && mobileOnly.codeOverride === undefined);

  const swapped = swapLensTexts(EXTENDED_LENS_SET, mixed.lensReplacements);
  check("swap replaces lens body", swapped.includes("Android pitfalls only") && !swapped.includes("JS falsy-zero"));
  check("swap keeps other lenses", swapped.includes(LENS_HEADINGS["reuse"]));
  check("specialist count", mixed.specialists.length === 1);

  const poisoned = new Map([
    ["reuse", "### Reuse\n\nQuotes the line:\n### Efficiency\n\nbody"],
    ["efficiency", "### Efficiency\n\nEfficiency replacement."],
  ]);
  const poisonedOut = swapLensTexts(EXTENDED_LENS_SET, poisoned);
  check("swap immune to quoted headings in replacements",
    poisonedOut.indexOf("Efficiency replacement.") > poisonedOut.indexOf(LENS_HEADINGS["simplification"]));
  check("lens texts resolve or fall back", LENS_NAMES.every((n) => LENS_TEXT[n].startsWith("### ")));

  // lens pins: readLensPins lists every project lens with its model/variant
  const pins = await readLensPins(dir);
  const pinned = pins.find((p) => p.name === "pinned");
  check("pins read model+variant", pinned?.model === "opencode/kimi-k3" && pinned?.variant === "max");
  check("pins list all project lenses", pins.length === 2 && pins.some((p) => p.name === "fp"));

  // no lens dir → empty bundle
  const bare = mkdtempSync(join(tmpdir(), "ocr-bare-"));
  check("no lens dir → empty bundle", (await collectLenses(bare, undefined)) !== undefined &&
    (await collectLenses(bare, undefined)).specialists.length === 0);

  // medium cell with one specialist: fleet grows, lens prepended
  const mediumWithLens = composeCell({
    level: "medium",
    reviewer: reviewerFor("medium"),
    lenses: webOnly,
  });
  check("specialist extends fleet count", mediumWithLens.includes("9 independent finders"));
  check("specialist brief present", mediumWithLens.includes("### fp (project lens)"));
  check("prepend inside cell", mediumWithLens.includes("## Project lenses"));

  rmSync(dir, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
}

// --- preamble -------------------------------------------------------------------

{
  console.log("preamble");
  const mistyped = parseCommand("maxxx");
  const p1 = buildPreamble({ args: mistyped, remembered: undefined, level: "medium" });
  check("mistyped level explained", p1.includes("Ignoring unrecognized effort") && p1.includes("medium"));

  const plain = parseCommand("");
  const p2 = buildPreamble({ args: plain, remembered: "high", level: "high" });
  check("sticky level announced", p2.includes("reusing high"));

  const post = parseCommand("--post");
  const p3 = buildPreamble({ args: post, remembered: undefined, level: "medium" });
  check("--post reported ignored", p3.includes("--post"));

  const quiet = parseCommand("high");
  check("no noise for explicit level", buildPreamble({ args: quiet, remembered: undefined, level: "high" }) === "");
}

// --- full assembly ----------------------------------------------------------------

{
  console.log("composeReview");
  const dir = mkdtempSync(join(tmpdir(), "ocr-compose-"));
  const stateFile = join(process.env.HOME!, ".local/state/opencode/code-review-level");
  const beforeState = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : undefined;
  const out = await composeReview("medium --fix", { worktree: dir });
  check("cell included", out.prompt.includes("## Phase 0 — Gather the diff"));
  check("reviewer named", out.prompt.includes("reviewer-medium"));
  check("fix appendix", out.prompt.includes("Applying fixes (--fix)"));
  check("no comment appendix", !out.prompt.includes("Posting to GitHub"));

  const commented = await composeReview("--comment 42", { worktree: dir, remember: false });
  check("comment appendix", commented.prompt.includes("Posting to GitHub (--comment)"));

  const gitlab = await composeReview("--comment !7", { worktree: dir, remember: false });
  check("gitlab appendix on MR target", gitlab.prompt.includes("glab mr note"));

  const modelBefore = rememberedModel();
  const pinned = await composeReview("high using opencode/kimi-k3", { worktree: dir, remember: false });
  check("pin announcement", pinned.prompt.includes("pinned to `opencode/kimi-k3`"));
  check("pin not written when remember=false", rememberedModel() === modelBefore);
  const badpin = await composeReview("high using kimi", { worktree: dir, remember: false });
  check("invalid pin reported", badpin.prompt.includes("Ignoring unrecognized model pin"));

  writeFileSync(stateFile, "high\n");
  await composeReview("medium", { worktree: dir, remember: false });
  check("sticky not written when remember=false", readFileSync(stateFile, "utf8") === "high\n");

  // and with remember on (default), an explicit level does persist
  await composeReview("max", { worktree: dir });
  check("explicit level persisted", rememberedLevel() === "max");
  if (beforeState === undefined) {
    rmSync(stateFile, { force: true });
  } else {
    writeFileSync(stateFile, beforeState);
  }

  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
