/**
 * Behavioral checks for the compiler. Run: bun test/verify.ts
 */
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCommand, pickLevel, LEVEL_PREFIX_RE, isLevelTypo } from "../compiler/args.ts";
import { rememberedLevel, rememberLevel, rememberedModel, rememberModel } from "../compiler/effort.ts";
import { composeCell } from "../compiler/cells.ts";
import { collectLenses, readLensPins, swapLensTexts, EMPTY_BUNDLE } from "../compiler/lenses.ts";
import { composeReview, reviewerFor } from "../compiler/prompt.ts";
import { buildPreamble } from "../compiler/preamble.ts";
import { diffDigest, decodeGitPath, heavyShapeNote, generatedExclusionNote, fleetHint } from "../compiler/budget.ts";
import { extractJsonFindings, salvageSession } from "../compiler/salvage.ts";
import { Database } from "bun:sqlite";
import { cmpVersions, UPDATE_FILE, markNotified, readUpdateNotice, writeCache } from "../compiler/update.ts";
import { gitlabCommentAppendix } from "../compiler/appendices.ts";
import { LEVELS, EXTENDED_LENS_SET, LENS_HEADINGS, LENS_TEXT, LENS_NAMES, SPAWN_FALLBACK_NOTE } from "../compiler/fragments.ts";
import {
  buildLadder,
  readFavorites,
  normalizeCost,
  effectiveCost,
  setActiveLadder,
  activeLadder,
  readLadderCache,
  writeLadderCache,
  refreshLadderCache,
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
  check("triage on by default", f.triage === true && parseCommand("medium").triage === true);
  check("--no-triage parsed", parseCommand("medium --no-triage").triage === false);
  check("--include-generated parsed", parseCommand("high --include-generated").includeGenerated === true);
  check("generated files excluded by default", f.includeGenerated === false);
  check("--include-generated value not a target", parseCommand("--include-generated").target === "");

  const lf = parseCommand("medium --lenses line-scan,cross-file,reuse");
  check("--lenses parsed in order", lf.lenses?.join(",") === "line-scan,cross-file,reuse" && lf.level === "medium" && lf.target === "");
  check("--lenses deduped", parseCommand("--lenses line-scan,line-scan").lenses?.join(",") === "line-scan");
  const lfBad = parseCommand("high --lenses line-scan,bogus");
  check("known lens kept, unknown reported", lfBad.lenses?.join(",") === "line-scan" && lfBad.ignoredLenses?.join(",") === "bogus");
  check("all-unknown lens flag leaves no pin", parseCommand("--lenses bogus").lenses === undefined && parseCommand("--lenses bogus").ignoredLenses?.join(",") === "bogus");
  check("empty --lenses is no pin", parseCommand("--lenses ,").lenses === undefined);
  check("--lenses value not a target", parseCommand("--lenses line-scan").target === "");
  check("no lenses flag means no pin", parseCommand("medium").lenses === undefined && parseCommand("medium").ignoredLenses === undefined);

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

  // ladder disk cache: startup reads it sync, first review refreshes it.
  // Uses a tmp path so the real ~/.local/state cache is never touched.
  const cacheDir = mkdtempSync(join(tmpdir(), "ocr-ladder-cache-"));
  const cacheFile = join(cacheDir, "code-review-ladder.json");
  check("missing ladder cache tolerated", readLadderCache(cacheFile) === undefined);
  writeFileSync(cacheFile, "{not json");
  check("corrupt ladder cache tolerated", readLadderCache(cacheFile) === undefined);
  writeFileSync(cacheFile, JSON.stringify({ ladder: [{ route: { providerID: "a" }, effective: "x", pot: false }] }));
  check("malformed ladder entries dropped", readLadderCache(cacheFile) === undefined);
  writeLadderCache(ladder.slice(0, 2), cacheFile);
  const cached = readLadderCache(cacheFile);
  check("ladder cache roundtrip", cached !== undefined && cached.length === 2 && routeRef(cached[0].route) === "zai-coding-plan/glm-flash" && cached[0].pot === true);
  // failed refresh never throws and never wipes a good cache (unreachable server)
  await refreshLadderCache("http://127.0.0.1:1", undefined, cacheFile);
  check("failed refresh keeps cache", readLadderCache(cacheFile)?.length === 2);
  rmSync(cacheDir, { recursive: true, force: true });

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
  const autoRun = await composeReview("high using auto", { worktree: composeDir, remember: false, updateCheck: false });
  check("auto pin announcement", autoRun.prompt.includes("zai-coding-plan/glm-flash"));
  check("auto run names alternate agents", autoRun.prompt.includes("reviewer-high-alt1"));
  check("auto run keeps primary agent", autoRun.prompt.includes("reviewer-high"));
  check("autoLadder in result", autoRun.autoLadder?.length === 2);
  setActiveLadder(undefined);
  const noLadder = await composeReview("high using auto", { worktree: composeDir, remember: false, updateCheck: false });
  check("no ladder → no alternate agents", !noLadder.prompt.includes("reviewer-high-alt1"));
  check("no ladder → degraded note", noLadder.prompt.includes("no usable favorite ladder"));
  const nonAuto = await composeReview("high", { worktree: composeDir, remember: false, updateCheck: false });
  check("non-auto run has no fallback machinery", !nonAuto.prompt.includes("Model fallback") && !nonAuto.prompt.includes("reviewer-high-alt1"));
  if (modelBefore === undefined) {
    rmSync(join(process.env.HOME!, ".local/state/opencode/code-review-model"), { force: true });
  } else {
    rememberModel(modelBefore);
  }
  rmSync(composeDir, { recursive: true, force: true });
}

// --- digest (binary-safe numstat) -------------------------------------------------

/** Sandbox git runner for temp-repo test fixtures (no hooks, fixed identity). */
const gitRunner = (dir: string) => (args: string[]) =>
  spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });

{
  console.log("diffDigest");
  const dir = mkdtempSync(join(tmpdir(), "ocr-digest-"));
  const git = gitRunner(dir);
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
  check("binary rows are not generated", d?.generated.length === 0);
  rmSync(dir, { recursive: true, force: true });
  check("git C-quoted path decoded", decodeGitPath('"mobile/\\346\\226\\207\\346\\241\\243.kt"') === "mobile/文档.kt");
  check("rename collapsed to new path", decodeGitPath("old/{a => b}/c.txt") === "old/b/c.txt" && decodeGitPath("a.txt => b.txt") === "b.txt");
}

// --- linguist-generated exclusion ---------------------------------------------------

{
  console.log("generated exclusion");
  const dir = mkdtempSync(join(tmpdir(), "ocr-gen-"));
  const git = gitRunner(dir);
  git(["init", "-q"]);
  mkdirSync(join(dir, "drizzle", "meta"), { recursive: true });
  writeFileSync(join(dir, ".gitattributes"), 'drizzle/meta/*_snapshot.json linguist-generated\npnpm-lock.yaml linguist-generated\nvalued.snap linguist-generated=true\n"ünï code.json" linguist-generated\n');
  writeFileSync(join(dir, "hand.ts"), "one\n");
  writeFileSync(join(dir, "drizzle", "meta", "0036_snapshot.json"), Array.from({ length: 3 }, (_, i) => `"k${i}": ${i}`).join("\n") + "\n");
  git(["add", "."]);
  git(["commit", "-qm", "one"]);
  writeFileSync(join(dir, "hand.ts"), "one changed\n");
  writeFileSync(join(dir, "drizzle", "meta", "0036_snapshot.json"), Array.from({ length: 33 }, (_, i) => `"k${i}": ${i}`).join("\n") + "\n");
  writeFileSync(join(dir, "pnpm-lock.yaml"), Array.from({ length: 20 }, (_, i) => `pkg${i}: hash`).join("\n") + "\n");
  writeFileSync(join(dir, "valued.snap"), "v1\n");
  writeFileSync(join(dir, "ünï code.json"), "ünï-marker\nline2\nline3\n");
  git(["add", "."]);
  git(["commit", "-qm", "two"]);

  const d = await diffDigest("HEAD~1..HEAD", dir);
  check("generated files kept in digest", d?.files.includes("drizzle/meta/0036_snapshot.json") === true && d?.files.includes("pnpm-lock.yaml") === true);
  check("generated files listed (unicode path round-trips)", d?.generated.join(",") === "drizzle/meta/0036_snapshot.json,pnpm-lock.yaml,valued.snap,ünï code.json");
  check("generated lines not counted", d?.lines === 2); // only the hand.ts change
  check("saved generated lines recorded", d?.generatedLines === 30 + 20 + 1 + 3);
  const full = await diffDigest("HEAD~1..HEAD", dir, { includeGenerated: true });
  check("--include-generated counts everything", full?.lines === 2 + 54 && full?.generated.length === 0);

  // note: names paths and saved lines, and carries a runnable exclude command
  const note = generatedExclusionNote(d, false);
  check("note names excluded paths and saved lines", note.includes("drizzle/meta/0036_snapshot.json") && note.includes("valued.snap") && note.includes("about 54 lines"));
  check("note says do not widen", note.includes("Do not widen the command back out"));
  check("note short-circuits an all-generated scope", note.includes("do not spawn the finders"));
  check("note quiet when opted in", generatedExclusionNote(d, true) === "");
  check("note quiet without digest", generatedExclusionNote(undefined, false) === "");
  check("note quiet with no generated files", generatedExclusionNote({ lines: 5, files: ["a.ts"], generated: [], generatedLines: 0 }, false) === "");
  const many = Array.from({ length: 15 }, (_, i) => `gen/${i}.json`);
  check("note folds long lists", generatedExclusionNote({ lines: 5, files: many, generated: many, generatedLines: 5 }, false).includes("and 3 more"));
  const recipe = generatedExclusionNote({ lines: 5, files: [], generated: Array.from({ length: 101 }, (_, i) => `g/${i}.json`), generatedLines: 5 }, false);
  check("huge generated sets fall back to the recipe", recipe.includes("check-attr -z --stdin") && !recipe.includes("```\ngit diff"));

  // count = command: the emitted diff command's scope is exactly digest.lines
  const cmd = note.match(/git diff [^\n]+/)?.[0] ?? "";
  check("note carries the exclude-pathspec command", cmd.startsWith("git diff HEAD~1..HEAD -- .") && cmd.includes("':(exclude,literal)drizzle/meta/0036_snapshot.json'") && cmd.includes("':(exclude,literal)ünï code.json'"));
  const cmdOut = spawnSync("bash", ["-c", cmd], { cwd: dir, encoding: "utf8" });
  check("emitted command runs and keeps hand-written hunks", cmdOut.status === 0 && cmdOut.stdout.includes("hand.ts"));
  check("emitted command drops every generated file", !cmdOut.stdout.includes("pkg0: hash") && !cmdOut.stdout.includes('"k29"') && !cmdOut.stdout.includes("ünï-marker"));
  const numstatOut = spawnSync("bash", ["-c", `${cmd} | git apply --numstat`], { cwd: dir, encoding: "utf8" });
  check("emitted command's numstat equals the digest", numstatOut.stdout.trim() === "1\t1\thand.ts");

  // end to end: the composed prompt carries the note; the flag removes it
  const run = await composeReview("high", { worktree: dir, remember: false, updateCheck: false });
  check("composeReview includes exclusion note", run.prompt.includes("## Generated files — out of scope") && run.prompt.includes("drizzle/meta/0036_snapshot.json"));
  check("fleet hint sizes to hand-written lines", run.prompt.includes("is about 2 lines"));
  const optedIn = await composeReview("high --include-generated", { worktree: dir, remember: false, updateCheck: false });
  check("--include-generated drops the note", !optedIn.prompt.includes("out of scope"));
  check("--include-generated announced in preamble", optedIn.prompt.includes("counted and reviewed"));
  check("--include-generated sizes the full diff", optedIn.prompt.includes("is about 56 lines"));

  // stdin detection: one call covers 100+ paths (no argv batching to lean on)
  const wide = mkdtempSync(join(tmpdir(), "ocr-gen-wide-"));
  const gitWide = gitRunner(wide);
  gitWide(["init", "-q"]);
  writeFileSync(join(wide, ".gitattributes"), "f0*.ts linguist-generated\n");
  for (let i = 0; i < 102; i++) writeFileSync(join(wide, `f${String(i).padStart(3, "0")}.ts`), "one\n");
  gitWide(["add", "."]);
  gitWide(["commit", "-qm", "one"]);
  for (let i = 0; i < 102; i++) writeFileSync(join(wide, `f${String(i).padStart(3, "0")}.ts`), "one changed\n");
  gitWide(["add", "."]);
  gitWide(["commit", "-qm", "two"]);
  const wideDigest = await diffDigest("HEAD~1..HEAD", wide);
  check("stdin check-attr covers 100+ paths", wideDigest?.files.length === 102 && wideDigest?.generated.length === 100 && wideDigest?.lines === 4 && wideDigest?.generatedLines === 200);

  // all-generated diff: the fleet hint must not say "about 0 lines"
  const onlyGen = mkdtempSync(join(tmpdir(), "ocr-gen-only-"));
  const gitOnly = gitRunner(onlyGen);
  gitOnly(["init", "-q"]);
  writeFileSync(join(onlyGen, ".gitattributes"), "gen.json linguist-generated\n");
  writeFileSync(join(onlyGen, "gen.json"), "a\n");
  gitOnly(["add", "."]);
  gitOnly(["commit", "-qm", "one"]);
  writeFileSync(join(onlyGen, "gen.json"), "a\nb\n");
  gitOnly(["add", "."]);
  gitOnly(["commit", "-qm", "two"]);
  const onlyDigest = await diffDigest("HEAD~1..HEAD", onlyGen);
  check("all-generated digest has zero lines", onlyDigest?.lines === 0 && onlyDigest?.generated.length === 1);
  check("range-target hint names generated exclusion", fleetHint("high", "HEAD~1..HEAD", onlyDigest!).text.includes("only generated paths"));
  const onlyRun = await composeReview("high", { worktree: onlyGen, remember: false, updateCheck: false });
  check("all-generated run: hint special-cased, note fires", onlyRun.prompt.includes("only generated paths") && !onlyRun.prompt.includes("about 0 lines") && onlyRun.prompt.includes("## Generated files — out of scope"));

  rmSync(dir, { recursive: true, force: true });
  rmSync(wide, { recursive: true, force: true });
  rmSync(onlyGen, { recursive: true, force: true });
}

// --- heavy shape note --------------------------------------------------------------

{
  console.log("heavy shape note");
  const big = { lines: 1344, files: ["docs/plan/tla.md", "src/x.ts"], generated: [], generatedLines: 0 };
  check("silent at low", heavyShapeNote("low", big, 4) === "");
  check("silent without digest", heavyShapeNote("medium", undefined, 4) === "");
  check("silent on small diff", heavyShapeNote("medium", { lines: 300, files: ["a.ts"], generated: [], generatedLines: 0 }, 4) === "");
  check("silent with one lens on mid diff", heavyShapeNote("medium", { lines: 900, files: ["a.ts"], generated: [], generatedLines: 0 }, 1) === "");
  const fired = heavyShapeNote("medium", big, 4);
  check("fires on many lenses + large diff", fired.includes("Heavy review shape") && fired.includes("4 project lenses"));
  check("fires on very large diff alone", heavyShapeNote("high", { lines: 3000, files: ["a.ts"] }, 0).includes("Heavy review shape"));
  check("advises a narrower target", fired.includes("narrower target"));

  // End-to-end: a >2500-line committed diff trips the note through composeReview.
  const dir = mkdtempSync(join(tmpdir(), "ocr-heavy-"));
  const git = gitRunner(dir);
  git(["init", "-q"]);
  writeFileSync(join(dir, "big.txt"), Array.from({ length: 2600 }, (_, i) => `line ${i}`).join("\n") + "\n");
  git(["add", "."]);
  git(["commit", "-qm", "one"]);
  writeFileSync(join(dir, "big.txt"), "changed\n");
  git(["add", "."]);
  git(["commit", "-qm", "two"]);
  const result = await composeReview("medium", { worktree: dir, remember: false, updateCheck: false });
  check("composeReview includes the note", result.prompt.includes("Heavy review shape"));
  rmSync(dir, { recursive: true, force: true });
}

// --- update notice -------------------------------------------------------------------

{
  console.log("update notice");
  check("version compare", cmpVersions("0.2.0", "0.1.1") === 1 && cmpVersions("0.1.1", "0.2.0") === -1 && cmpVersions("0.1.1", "0.1.1") === 0);
  check("prerelease stripped in compare", cmpVersions("0.3.0-beta.1", "0.2.9") === 1);

  const before = existsSync(UPDATE_FILE) ? readFileSync(UPDATE_FILE, "utf8") : undefined;
  // Force the kill-switch off for the announcement path, whatever the
  // operator's environment, and restore it afterward.
  const hadKillSwitch = process.env.CODE_REVIEW_NO_UPDATE_CHECK;
  delete process.env.CODE_REVIEW_NO_UPDATE_CHECK;
  try {
    writeFileSync(UPDATE_FILE, JSON.stringify({ checkedAt: Date.now(), latestVersion: "99.0.0", notes: "New: salvaging and heavy-shape warnings" }));
    const withNotice = await composeReview("medium", { remember: false });
    check("pending update announced", withNotice.prompt.includes("v99.0.0") && withNotice.prompt.includes("npm install @elderengineer/opencode-code-review@latest"));
    check("announcement marked as notified", readUpdateNotice("0.1.1") === undefined &&
      JSON.parse(readFileSync(UPDATE_FILE, "utf8")).notifiedVersion === "99.0.0");
    const again = await composeReview("medium", { remember: false });
    check("announced only once", !again.prompt.includes("v99.0.0"));
  } finally {
    if (before === undefined) rmSync(UPDATE_FILE, { force: true });
    else writeFileSync(UPDATE_FILE, before);
    if (hadKillSwitch !== undefined) process.env.CODE_REVIEW_NO_UPDATE_CHECK = hadKillSwitch;
  }

  process.env.CODE_REVIEW_NO_UPDATE_CHECK = "1";
  check("env var disables notices", readUpdateNotice("0.1.1") === undefined);
  delete process.env.CODE_REVIEW_NO_UPDATE_CHECK;

  // Injectable path: update-state logic is testable without touching the
  // real cache file (a mid-test kill would otherwise leave residue).
  const dir = mkdtempSync(join(tmpdir(), "ocr-update-"));
  const cacheFile = join(dir, "update.json");
  writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), latestVersion: "99.0.0", notes: "New: salvaging" }));
  check("hermetic: notice from injected path", readUpdateNotice("0.1.1", cacheFile)?.version === "99.0.0");
  markNotified("99.0.0", cacheFile);
  check("hermetic: marked version silent", readUpdateNotice("0.1.1", cacheFile) === undefined);
  writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), latestVersion: 2 }));
  check("hermetic: corrupt latestVersion ignored", readUpdateNotice("0.1.1", cacheFile) === undefined);

  // Merge-at-write semantics: a patch must not wholesale-replace the file,
  // and an explicit undefined deletes its stored counterpart.
  writeFileSync(cacheFile, JSON.stringify({ checkedAt: 1, latestVersion: "99.0.0", notes: "New: salvaging" }));
  markNotified("99.0.0", cacheFile);
  const merged = JSON.parse(readFileSync(cacheFile, "utf8"));
  check("hermetic: markNotified merges, not replaces", merged.checkedAt === 1 && merged.notes === "New: salvaging" && merged.notifiedVersion === "99.0.0");
  writeCache({ checkedAt: 2, latestVersion: undefined }, cacheFile);
  const cleaned = JSON.parse(readFileSync(cacheFile, "utf8"));
  check("hermetic: undefined patch field deletes stale state", cleaned.latestVersion === undefined && cleaned.notes === "New: salvaging" && cleaned.checkedAt === 2);
  check("hermetic: atomic write leaves no temp file", !readdirSync(dir).some((f) => f.includes(".tmp")));
  rmSync(dir, { recursive: true, force: true });
}

// --- salvage (findings from interrupted review sessions) ---------------------------

{
  console.log("salvage");
  const dir = mkdtempSync(join(tmpdir(), "ocr-salvage-"));
  const dbPath = join(dir, "opencode.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT, title TEXT, time_created INTEGER, tokens_output INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
  `);
  const insertSession = db.prepare("INSERT INTO session (id, parent_id, agent, title, time_created, tokens_output) VALUES (?, ?, ?, ?, ?, ?)");
  const insertMessage = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)");
  const insertPart = db.prepare("INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)");

  insertSession.run("ses_parent", null, "build", "review parent", 1, 0);
  // child 1: completed finder with fenced JSON findings
  insertSession.run("ses_c1", "ses_parent", "reviewer-medium", "Finder: line-scan", 2, 500);
  insertMessage.run("m1", "ses_c1", 10, JSON.stringify({ role: "user" }));
  insertMessage.run("m2", "ses_c1", 20, JSON.stringify({ role: "assistant" }));
  insertPart.run("p1", "m2", 21, JSON.stringify({ type: "text", text: "Candidates:\n```json\n[{\"file\":\"src/a.ts\",\"line\":12,\"summary\":\"off by one\"}]\n```" }));
  // child 2: prose-only finder (no JSON block)
  insertSession.run("ses_c2", "ses_parent", "reviewer-medium", "Finder: efficiency", 3, 400);
  insertMessage.run("m3", "ses_c2", 30, JSON.stringify({ role: "user" }));
  insertMessage.run("m4", "ses_c2", 40, JSON.stringify({ role: "assistant" }));
  insertPart.run("p2", "m4", 41, JSON.stringify({ type: "text", text: "Found a duplicated helper in src/b.ts line 5 that wastes memory." }));
  // child 3: interrupted verifier — assistant messages but zero text parts
  insertSession.run("ses_c3", "ses_parent", "reviewer-medium", "Verify candidate A", 4, 10);
  insertMessage.run("m5", "ses_c3", 50, JSON.stringify({ role: "user" }));
  insertMessage.run("m6", "ses_c3", 60, JSON.stringify({ role: "assistant" }));
  insertPart.run("p3", "m6", 61, JSON.stringify({ type: "tool", state: { status: "error" } }));
  // child 4: non-reviewer (excluded)
  insertSession.run("ses_c4", "ses_parent", "explore", "scout", 5, 100);
  insertMessage.run("m7", "ses_c4", 70, JSON.stringify({ role: "user" }));
  insertMessage.run("m8", "ses_c4", 80, JSON.stringify({ role: "assistant" }));
  insertPart.run("p4", "m8", 81, JSON.stringify({ type: "text", text: "scouting notes" }));

  const report = salvageSession("ses_parent", { dbPath });

  check("salvage: only reviewer children kept", report.children.length === 2);
  check("salvage: non-reviewer + empty children skipped", report.totals.skipped === 2 && report.skipped.some((s) => s.agent === "explore") && report.skipped.some((s) => s.id === "ses_c3"));
  const c1 = report.children.find((c) => c.id === "ses_c1");
  check("salvage: fenced JSON extracted", Array.isArray(c1?.findings) && c1!.findings!.length === 1 && (c1!.findings![0] as Record<string, unknown>).file === "src/a.ts");
  const c2 = report.children.find((c) => c.id === "ses_c2");
  check("salvage: prose child kept as text", c2 !== undefined && c2.findings === undefined && c2.text.includes("duplicated helper"));
  check("salvage: totals consistent", report.totals.withFindings === 1 && report.totals.textOnly === 1);
  check("salvage: parent recorded", report.parent.id === "ses_parent" && report.parent.agent === "build");
  check("salvage: bare JSON array extracted", (extractJsonFindings('[{"file":"x","line":1}]')?.length) === 1);
  let threw = "";
  try {
    salvageSession("ses_missing", { dbPath });
  } catch (err) {
    threw = String(err);
  }
  check("salvage: missing session throws with path", threw.includes("ses_missing") && threw.includes("not found"));
  db.close();
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
  const cell = (level: (typeof LEVELS)[number], opts?: { triage?: boolean; lensesOverride?: string[] }) =>
    composeCell({ level, reviewer: reviewerFor(level), lenses: EMPTY_BUNDLE, ...opts });
  const triageSection = (s: string) => s.slice(s.indexOf("## Triage —"), s.indexOf("## Phase 1 —"));

  const low = cell("low");
  check("low: single pass, no fleet", low.includes("No subagents, no full-file reads"));
  check("low: cap 4 and (none) marker", low.includes("≤4 findings") && low.includes("(none)"));
  check("low: no verify phase", !low.includes("Phase 2"));

  // full fleet (`--no-triage`): the pre-triage behavior and wording
  const medium = cell("medium", { triage: false });
  check("medium: 8 built-in finders", medium.includes("8 independent finders"));
  check("medium: names reviewer subagent", medium.includes("reviewer-medium"));
  check("medium: precise rubric", medium.includes("CONFIRMED") && medium.includes("PLAUSIBLE by default") === false);
  check("medium: cap 8", medium.includes("≤8 findings"));
  check("medium: no sweep", !medium.includes("Phase 3"));
  check("medium: unthrottled spawn protocol", medium.includes("no concurrency cap"));
  check("medium: halve in-flight on congestion", medium.includes("half as many spawns in flight") && medium.includes("429"));
  check("medium: wait has a mechanism", medium.includes("sleep 45"));
  check("medium: waits coalesce per round", medium.includes("wait once for the whole round"));
  check("medium: generic failure branch", medium.includes("any other error") && medium.includes("permission rejection"));
  check("medium: alternates pointer at embed site", medium.includes("model alternates are configured"));
  check("medium: inline fallback on repeated congestion", medium.includes("run that lens or verification") && medium.includes("sequentially"));
  check("medium: no spawn wave cap", !medium.includes("waves of at most"));
  check("medium: note embedded at both spawn sites", medium.split(SPAWN_FALLBACK_NOTE).length - 1 === 2);
  check("--no-triage: no triage step", !medium.includes("## Triage —"));

  const high = cell("high", { triage: false });
  check("high: recall rubric", high.includes("PLAUSIBLE by default"));
  check("high: cap 10", high.includes("≤10 findings"));
  check("high: halve in-flight on congestion", high.includes("half as many spawns in flight") && high.includes("429"));

  const max = cell("max", { triage: false });
  check("max: extended set (language-pitfalls)", max.includes("Language-pitfall specialist"));
  check("max: sweep phase", max.includes("Phase 3 — Sweep for gaps"));
  check("max: 10 finders", max.includes("10 independent finders"));
  check("max: cap 15", max.includes("≤15 findings"));
  check("max: names reviewer subagent", max.includes("reviewer-max"));
  check("max: maximum lead-in", max.includes("maximum effort"));
  check("max: sweep congestion protocol", max.includes("half as many spawns in flight"));
  check("max: no spawn wave cap", !max.includes("waves of at most"));
  check("max: note embedded at all three spawn sites", max.split(SPAWN_FALLBACK_NOTE).length - 1 === 3);

  // triage on by default: the agent chooses the lens set from the diff
  const mediumTriage = cell("medium");
  check("medium: triage by default", mediumTriage.includes("## Triage — choose the finder lenses") && mediumTriage.includes("up to 8 lenses"));
  check("medium: triage tag", mediumTriage.includes("medium effort → triage → up to 8 lenses × 6 candidates"));
  check("medium: triage finder brief", mediumTriage.includes("one finder per lens below that you kept in triage"));
  check("medium: triage biases toward keeping", mediumTriage.includes("this step lowers coverage") && mediumTriage.includes("if you cannot name something concrete, keep it"));
  const block = triageSection(mediumTriage);
  check("triage offers the perspective lenses", block.includes("- `efficiency`") && block.includes("- `conventions`") && block.includes("- `altitude`"));
  check("triage withholds the correctness core", !block.includes("- `line-scan`") && !block.includes("- `removed-behavior`") && !block.includes("- `cross-file`"));
  const maxTriage = triageSection(cell("max"));
  check("max triage offers the extended lenses", maxTriage.includes("- `language-pitfalls`") && maxTriage.includes("- `wrapper-proxy`"));

  // a project replacement says the project cares → triage cannot drop it
  const replaced = { ...EMPTY_BUNDLE, lensReplacements: new Map([["reuse", "### Reuse\n\nProject reuse text."]]) };
  const replacedBlock = triageSection(composeCell({ level: "medium", reviewer: reviewerFor("medium"), lenses: replaced }));
  check("replaced lens withheld from triage", !replacedBlock.includes("- `reuse`") && replacedBlock.includes("- `simplification`"));

  // --lenses override: the caller decided; no triage, only the named lenses
  const pinned = cell("medium", { lensesOverride: ["cross-file", "efficiency"] });
  check("override skips triage", !pinned.includes("## Triage —"));
  check("override runs only the named lenses", pinned.includes(LENS_HEADINGS["cross-file"]) && pinned.includes(LENS_HEADINGS["efficiency"]));
  check("override drops the rest", !pinned.includes(LENS_HEADINGS["line-scan"]) && !pinned.includes(LENS_HEADINGS["simplification"]));
  check("override tag counts the selection", pinned.includes("2 lenses × 6 candidates"));
  const oneLens = cell("low", { lensesOverride: ["line-scan"] });
  check("override ignored at low", !oneLens.includes(LENS_HEADINGS["line-scan"]));
  const allReplaced = {
    ...EMPTY_BUNDLE,
    lensReplacements: new Map(
      ["reuse", "simplification", "efficiency", "altitude", "conventions"].map((n) => [n, `### ${n}\n\nProject text.`] as [string, string]),
    ),
  };
  const noSkippable = composeCell({ level: "medium", reviewer: reviewerFor("medium"), lenses: allReplaced });
  check("nothing skippable → triage omitted", !noSkippable.includes("## Triage —") && noSkippable.includes("8 independent finders"));

  const unknownOverride = cell("medium", { lensesOverride: ["bogus"] });
  check("unknown override name falls back to triage", unknownOverride.includes("## Triage —"));
  const unknownOnly = cell("medium", { lensesOverride: ["bogus"], triage: false });
  check("all-unknown override falls back to the level set", unknownOnly.includes("8 lenses × 6 candidates"));
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
  const backendOnly = await collectLenses(dir, { lines: 100, files: ["backend/x.py"], generated: [], generatedLines: 0 });
  check("gated code lens inactive on non-matching diff", backendOnly.codeOverride === undefined);
  check("gated lens replacement inactive on non-matching diff", backendOnly.lensReplacements.size === 0);
  check("ungated specialist active", backendOnly.specialists.length === 1 && backendOnly.specialists[0].name === "fp");
  check("prepend block built", backendOnly.prepend.includes("## Project lenses") && backendOnly.prepend.includes("Functional programming discipline."));
  check("prepend excludes inactive code lens", !backendOnly.prepend.includes("Web frontend perspective."));

  // digest: web changed → code lens active
  const webOnly = await collectLenses(dir, { lines: 100, files: ["web/a.ts"], generated: [], generatedLines: 0 });
  check("gated code lens active on matching diff", webOnly.codeOverride === "Web frontend perspective.");

  // digest: web + mobile → code active, language-pitfalls replacement active
  const mixed = await collectLenses(dir, { lines: 100, files: ["web/a.ts", "mobile/b.kt"], generated: [], generatedLines: 0 });
  check("lens replacement collected", mixed.lensReplacements.get("language-pitfalls")?.includes("Android pitfalls only") === true);

  // digest: mobile only → language-pitfalls replacement active, code lens inactive
  const mobileOnly = await collectLenses(dir, { lines: 100, files: ["mobile/b.kt"], generated: [], generatedLines: 0 });
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
    triage: false,
  });
  check("specialist extends fleet count", mediumWithLens.includes("9 independent finders"));
  check("specialist brief present", mediumWithLens.includes("### fp (project lens)"));
  check("prepend inside cell", mediumWithLens.includes("## Project lenses"));
  const mediumWithLensTriage = composeCell({ level: "medium", reviewer: reviewerFor("medium"), lenses: webOnly });
  check("specialist still runs under triage", mediumWithLensTriage.includes("up to 9 lenses") && mediumWithLensTriage.includes("### fp (project lens)"));
  check("specialist is never skippable", !mediumWithLensTriage.includes("- `fp`"));

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

  const typed = parseCommand("medium");
  const p2b = buildPreamble({ args: typed, remembered: "high", level: "medium" });
  check("typed level: no sticky announcement", !p2b.includes("No effort level given"));
  check("mistyped level cites remembered", buildPreamble({ args: parseCommand("maxxx"), remembered: "medium", level: "medium" }).includes("typed last time"));

  const post = parseCommand("--post");
  const p3 = buildPreamble({ args: post, remembered: undefined, level: "medium" });
  check("--post reported ignored", p3.includes("--post"));

  const lensPin = buildPreamble({ args: parseCommand("medium --lenses line-scan,cross-file"), remembered: undefined, level: "medium" });
  check("lens pin announced", lensPin.includes("Finder lenses pinned") && lensPin.includes("triage is skipped"));
  const pinNoCore = buildPreamble({ args: parseCommand("medium --lenses efficiency"), remembered: undefined, level: "medium" });
  check("pin without a core lens warns", pinNoCore.includes("No correctness-core lens is included"));
  const pinCore = buildPreamble({ args: parseCommand("medium --lenses line-scan,efficiency"), remembered: undefined, level: "medium" });
  check("pin with a core lens does not warn", !pinCore.includes("No correctness-core lens"));
  const noTriage = buildPreamble({ args: parseCommand("medium --no-triage"), remembered: undefined, level: "medium" });
  check("triage-off announced", noTriage.includes("Triage off"));
  check("triage-on is quiet", buildPreamble({ args: parseCommand("medium"), remembered: undefined, level: "medium" }) === "");
  const badLens = buildPreamble({ args: parseCommand("medium --lenses bogus"), remembered: undefined, level: "medium" });
  check("unknown lens name reported", badLens.includes("Ignoring unrecognized lens name") && badLens.includes("bogus"));
  const lowLens = buildPreamble({ args: parseCommand("low --lenses line-scan"), remembered: undefined, level: "low" });
  check("--lenses ignored at low", lowLens.includes("low runs a single diff pass"));

  const quiet = parseCommand("high");
  check("no noise for explicit level", buildPreamble({ args: quiet, remembered: undefined, level: "high" }) === "");
}

// --- full assembly ----------------------------------------------------------------

{
  console.log("composeReview");
  const dir = mkdtempSync(join(tmpdir(), "ocr-compose-"));
  const stateFile = join(process.env.HOME!, ".local/state/opencode/code-review-level");
  const beforeState = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : undefined;
  const out = await composeReview("medium --fix", { worktree: dir, updateCheck: false });
  check("cell included", out.prompt.includes("## Phase 0 — Gather the diff"));
  check("reviewer named", out.prompt.includes("reviewer-medium"));
  check("fix appendix", out.prompt.includes("Applying fixes (--fix)"));
  check("no comment appendix", !out.prompt.includes("Posting to GitHub"));
  check("triage defaults on end to end", out.prompt.includes("## Triage — choose the finder lenses"));

  const noTriage = await composeReview("medium --no-triage", { worktree: dir, remember: false, updateCheck: false });
  check("--no-triage runs the full fleet", noTriage.prompt.includes("8 independent finders") && !noTriage.prompt.includes("## Triage —"));
  const pinnedLenses = await composeReview("medium --lenses line-scan", { worktree: dir, remember: false, updateCheck: false });
  check("--lenses pins the built-in fleet", pinnedLenses.prompt.includes("1 independent finder") && !pinnedLenses.prompt.includes("## Triage —"));
  check("--lenses text excludes unselected lenses", !pinnedLenses.prompt.includes(LENS_HEADINGS["efficiency"]));

  const commented = await composeReview("--comment 42", { worktree: dir, remember: false, updateCheck: false });
  check("comment appendix", commented.prompt.includes("Posting to GitHub (--comment)"));

  const gitlab = await composeReview("--comment !7", { worktree: dir, remember: false, updateCheck: false });
  check("gitlab appendix on MR target", gitlab.prompt.includes("glab mr note"));

  const modelBefore = rememberedModel();
  const pinned = await composeReview("high using opencode/kimi-k3", { worktree: dir, remember: false, updateCheck: false });
  check("pin announcement", pinned.prompt.includes("pinned to `opencode/kimi-k3`"));
  check("pin not written when remember=false", rememberedModel() === modelBefore);
  const badpin = await composeReview("high using kimi", { worktree: dir, remember: false, updateCheck: false });
  check("invalid pin reported", badpin.prompt.includes("Ignoring unrecognized model pin"));

  writeFileSync(stateFile, "high\n");
  await composeReview("medium", { worktree: dir, remember: false, updateCheck: false });
  check("sticky not written when remember=false", readFileSync(stateFile, "utf8") === "high\n");

  // and with remember on (default), an explicit level does persist
  await composeReview("max", { worktree: dir, updateCheck: false });
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
