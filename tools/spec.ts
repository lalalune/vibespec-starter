#!/usr/bin/env node
// The whole pipeline: spec/*.md -> Quint model -> TypeScript -> proofs. This file runs the stages in order and is the
// command line; each stage lives in a module of its own (README, "What lives where").
//
//   spec check [--json]    run every check and print what is out of step (see README)
//   spec gen               only tangle the specs and generate gen/<name>.ts
//   spec accept            check afresh and, if all else passes, record that the prose
//                          and model of every rule, the text of every story and the
//                          //@ contracts in src/ have been reconciled
//   spec accept unproved   check afresh and record the obligations that hold in
//                          simulation but that Dafny cannot prove on its own
//   spec watch             check, then check again on every change to spec/, src/ or test/
//   spec new <name>        write spec/<name>.md, a small spec that passes every check
//   spec init              set a project up: the sync skill, a section of AGENTS.md, scripts
//
// From this repository the same commands are `node tools/spec.ts …` or `npm run …`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { remembered } from "./cache.ts";
import type { Model } from "./gen.ts";
import { badSpecName, gen, importOrder, readSpecs, ruleOf, type Spec } from "./parse.ts";
import { acceptContracts, acceptReviews, contracts, pending, pendingContracts, showItems } from "./review.ts";
import { budget, budgetKey, simulateSpec } from "./simulate.ts";
import { proofStage } from "./units.ts";
import { fail, filesUnder, indent, runAsync, show, type Accept, type Report, type Result } from "./util.ts";

// --- check -------------------------------------------------------------------------

/** The one most useful thing to do after a check, given what it found. */
export function nextStep(results: Result[]): string {
  const first = results.find((r) => !r.ok && r.stage !== "review");
  const about = first?.where ? ` (${first.where})` : "";
  if (first) {
    const what: Record<string, string> = {
      model: "fix the spec where the model stage points",
      always: "read the trace: fix the model, or add the rule that forbids it",
      sometimes: "make the goal reachable: loosen the guard, add the transition, or define <param>Values",
      replay: "the generated TypeScript disagrees with Quint, a bug in the tools: report it",
      types: "update src/ and test/ to the generated contract",
      proof: "prove what is listed in the unit's proof file, or fix what Dafny could not check",
      tests: "fix the application or its tests",
    };
    return `${first.stage}${about} is the first ✗: ${what[first.stage]}, then run \`npm run check\` again`;
  }
  const reviews = results.filter((r) => !r.ok);
  if (!reviews.length) return "all green";
  if (reviews.some((r) => /story has no rules|not formalized/.test(r.detail))) return "write the rules and Quint the review items ask for, then run `npm run check` again";
  return "read each review item above; when prose and Quint agree, the user runs `npm run accept`";
}

/** Take the project's lock for one check or accept at a time; returns what releases it. A lock left by a process that has ended is taken over. */
function lockProject(root: string): () => void {
  const file = path.join(root, ".spec-cache", "lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const alive = (pid: number) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let holder = NaN;
    try { holder = parseInt(fs.readFileSync(file, "utf8"), 10); } catch { /* removed in the meantime */ }
    if (alive(holder) || attempt) throw new Error(`another check or accept is running in this project (process ${holder}); wait for it to finish. If no such process is running, delete ${path.relative(root, file)}`);
    fs.rmSync(file, { force: true });
  }
}

/**
 * Run every check, cheapest first, and return what each found and the next
 * thing to do; `log` hears of each result as it arrives. Stages after a broken
 * model are skipped, and said to be, because their failures would only restate
 * the first one. `accept` is "reviews" to record reconciled stories, rules and
 * contracts, or "unproved" to record the obligations that are simulated but not
 * proved; either way nothing remembered from an earlier run is used. Only one
 * check or accept runs in a project at a time; another is refused.
 */
export async function check(root: string, accept: Accept = false, log: (result: Result) => void = () => {}): Promise<{ ok: boolean; results: Result[]; next: string }> {
  const release = lockProject(root);
  try {
    const results: Result[] = [];
    const ok = await checkLocked(root, accept, (r) => { results.push(r); log(r); });
    return { ok, results, next: nextStep(results) };
  } finally {
    release();
  }
}

async function checkLocked(root: string, accept: Accept, log: (result: Result) => void): Promise<boolean> {
  const b = budget(!accept && !!process.env.SPEC_QUICK && process.env.SPEC_QUICK !== "0");
  let allOk = true;
  const report: Report = (ok, stage, summary, detail = "", where, keepDetail = false) => {
    allOk &&= ok;
    log({ ok, stage, summary, detail: ok && !keepDetail ? "" : detail, ...(where ? { where } : {}) });
  };
  const skip = (stages: string, why: string) => report(true, "skipped", `${stages}: ${why}`);
  /** The cache entries this run read or wrote; after a run in which every stage ran, the others are deleted. */
  const used = new Set<string>();
  let specs: Spec[];
  try {
    specs = readSpecs(root);
  } catch (e) {
    report(false, "model", (e as Error).message);
    return false;
  }
  fs.rmSync(path.join(root, "gen"), { recursive: true, force: true }); // nothing stale survives a rename
  const valid: Spec[] = [];
  const models = new Map<string, Model>();
  // Node caches imported modules by path, so each run loads its generated code from a directory of its own.
  const loaded = path.join(root, "gen", `run-${Date.now()}`);

  for (const spec of specs) {
    const cite = (def: string) => {
      const rule = ruleOf(spec, def);
      return rule ? `"${rule.key}" (${spec.file}:${rule.line})` : def;
    };
    let model: Model;
    let domain: any;
    try {
      const missing = spec.imports.find((i) => !models.has(i));
      if (missing) throw new Error(`it imports ${missing}, which is not a valid model`);
      model = gen(root, spec, models);
      fs.mkdirSync(loaded, { recursive: true });
      fs.copyFileSync(path.join(root, `gen/${spec.name}.ts`), path.join(loaded, `${spec.name}.ts`));
      domain = await import(pathToFileURL(path.join(loaded, `${spec.name}.ts`)).href);
    } catch (e) {
      report(false, "model", `${spec.file} is not a valid model`, indent((e as Error).message.trim()), spec.file);
      skip(`always, sometimes and replay of ${spec.file}`, "it is not a valid model");
      continue;
    }
    valid.push(spec);
    const parts = [[model.transitions.length, "transitions"], [model.always.length, "always"], [model.steps.length, "step"], [model.sometimes.length, "sometimes"], [model.laws.length, "laws"]];
    report(true, "model", `${spec.file}: ${parts.filter(([n]) => n).map((p) => p.join(" ")).join(", ") || "definitions only"}`, "", spec.file);
    if (!model.stateType && !model.laws.length && !model.evals.length) continue;

    // A spec whose model and harness are unchanged, and that passed, is not simulated again.
    const imported = importOrder(spec.imports, (n) => specs.find((x) => x.name === n)!.imports).map((n) => specs.find((x) => x.name === n)!.meaning).join("");
    const found = await remembered(root, !!accept, used, ["simulate", imported, spec.meaning, model.harness, budgetKey(b), process.env.SPEC_SEED ?? ""],
      () => simulateSpec(root, model, domain, cite, b), (said) => said.every((r) => r.ok));
    for (const r of found) report(r.ok, r.stage, r.summary, r.detail, spec.file);
    const ran = new Set(found.map((r) => r.stage));
    const notRun = (["sometimes", "replay"] as const).filter((s) => !ran.has(s) && (s !== "sometimes" || model.sometimes.length));
    if (notRun.length && found.some((r) => !r.ok)) skip(`${notRun.join(" and ")} of ${spec.file}`, "simulation stopped at the failure above");
  }

  const complete = allOk;
  if (!allOk) skip("types, proof and tests", "a stage above failed, and their failures would only restate it");
  if (allOk) {
    // The typecheck runs while the proofs do; it is reported first.
    const typecheck = fs.existsSync(path.join(root, "tsconfig.json")) ? runAsync("tsc", ["--noEmit", "-p", "."], root) : undefined;
    const proofs = proofStage(root, [...models.values()], accept, used, report);
    if (typecheck) {
      const tsc = await typecheck;
      report(tsc.ok, "types", tsc.ok ? "application typechecks against the generated contract" : "application does not fit the generated contract", indent(tsc.out.trim()), "src/ and test/");
    } else {
      const code = ["src", "test"].filter((d) => fs.existsSync(path.join(root, d)));
      report(!code.length, "types", code.length ? `${code.join(" and ")} exist but there is no tsconfig.json, so nothing checks them against the generated contract; run \`spec init\` to add one` : "skipped: there is no tsconfig.json and no src/ or test/");
    }
    const { found, ran: proofsRan } = await proofs;
    for (const r of found) report(...r);
    const tests = filesUnder(path.join(root, "test"), /\.test\.ts$/);
    if (tests.length) {
      // Inside another test run (NODE_TEST_CONTEXT set), `node --test` would report to that run and always exit 0.
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      const t = spawnSync(process.execPath, ["--test", ...tests.map((f) => `test/${f}`)], { cwd: root, encoding: "utf8", env, maxBuffer: 1 << 28, timeout: 60 * 60 * 1000 });
      const stopped = t.error ? `\nthe tests were stopped: ${t.error.message}` : "";
      const failures = (t.stdout ?? "").slice(Math.max(0, (t.stdout ?? "").indexOf("✖ failing tests:")));
      report(t.status === 0, "tests", t.status === 0 ? "application tests pass" : "application tests fail", indent((failures + (t.stderr ?? "") + stopped).trim()), "test/");
    }
    // Every stage ran, so every cache entry still worth having was used; the rest are deleted.
    if (complete && proofsRan)
      for (const f of fs.readdirSync(path.join(root, ".spec-cache"))) if (f !== "lock" && !used.has(f)) fs.rmSync(path.join(root, ".spec-cache", f), { recursive: true, force: true });
  }
  fs.rmSync(loaded, { recursive: true, force: true });

  // A spec that is not a valid model has nothing to reconcile yet. Everything is recorded at once, or nothing is.
  const todos = valid.map((spec) => ({ spec, todo: pending(root, spec, specs) }));
  const contractsToDo = pendingContracts(root);
  const formal = todos.every(({ todo }) => !todo.some((t) => t.status === "story has no rules" || t.status === "not formalized"));
  const record = accept === "reviews" && allOk && formal;
  const why = accept !== "reviews" ? "then run `npm run accept`" : !allOk ? "nothing was accepted: fix the stages above first" : "every story needs rules and every rule a quint block before anything can be accepted";
  for (const { spec, todo } of todos) {
    if (record && todo.length) {
      acceptReviews(root, spec, specs);
      report(true, "review", `${spec.file}: recorded as reconciled: ${todo.map((t) => t.rule?.key ?? t.story?.title ?? t.where.slice(t.where.indexOf("  ") + 2)).join("; ")}`, "", spec.file);
    } else report(!todo.length, "review", todo.length ? `${spec.file}: ${todo.length} item(s) to reconcile, ${why}` : `${spec.file}: prose and model reconciled for all ${spec.rules.length} rules and ${spec.stories.length} stories`,
      showItems(todo, "What moved, in full"), spec.file);
  }
  const proved = contracts(root).size;
  if (record && contractsToDo.length) {
    acceptContracts(root);
    report(true, "review", `src/: recorded as reconciled: ${contractsToDo.map((t) => t.where).join("; ")}`, "", "src/");
  } else if (contractsToDo.length) report(false, "review", `src/: ${contractsToDo.length} contract(s) to reconcile, ${why}`, showItems(contractsToDo, "The contracts, in full"), "src/");
  else if (proved) report(true, "review", `src/: the //@ contracts of all ${proved} proved files reconciled`, "", "src/");
  return allOk;
}

// --- init ----------------------------------------------------------------------------

const AGENTS_START = "<!-- onespec:start";
const AGENTS_END = "<!-- onespec:end -->";

/**
 * Give a project what it needs to use the package. Nothing that is already there is replaced, except the marked
 * section of AGENTS.md, which is the package's own and is brought up to date.
 */
export function init(root: string): string[] {
  const pkg = path.join(import.meta.dirname, "..");
  const done: string[] = [];
  const add = (file: string, content: () => string) => {
    if (fs.existsSync(path.join(root, file))) return;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content());
    done.push(file);
  };
  for (const doc of [".claude/skills/sync/SKILL.md", ".claude/skills/design/SKILL.md", "CONTRIBUTING.md"]) add(doc, () => fs.readFileSync(path.join(pkg, doc), "utf8"));
  // AGENTS.md is read by Claude Code, Codex and others, so a project often has one already. Its section on specs is
  // added to it, or brought up to date, between markers; everything else in the file is the project's own.
  const section = fs.readFileSync(path.join(pkg, "AGENTS.md"), "utf8").match(new RegExp(`${AGENTS_START}[\\s\\S]*?${AGENTS_END}`))?.[0]
    ?? fail(`${path.join(pkg, "AGENTS.md")} has no section between ${AGENTS_START} and ${AGENTS_END}`);
  const agents = path.join(root, "AGENTS.md");
  const existing = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : undefined;
  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  const ours = section.replace(/\r?\n/g, eol);
  const starts = existing?.split(AGENTS_START).length ?? 1;
  const ends = existing?.split(AGENTS_END).length ?? 1;
  if (existing !== undefined && !(starts === 1 && ends === 1) && !(starts === 2 && ends === 2 && existing.indexOf(AGENTS_START) < existing.indexOf(AGENTS_END)))
    fail(`AGENTS.md: its section on specs should be one ${AGENTS_START} … ${AGENTS_END} pair; fix the markers by hand, then run spec init again`);
  // A copy installed whole by an earlier version, without markers, would otherwise end up in the file twice.
  if (existing !== undefined && starts === 1 && /npm run accept/.test(existing))
    fail("AGENTS.md already holds a copy of the procedure without markers (from an earlier `spec init`); delete that copy, keep what is your own, then run spec init again");
  const merged = existing === undefined ? `# Operating procedure for agents\n\n${section}\n`
    : starts === 2 ? existing.replace(new RegExp(`${AGENTS_START}[\\s\\S]*?${AGENTS_END}`), () => ours)
    : `${existing.trimEnd()}${eol}${eol}${ours}${eol}`;
  if (merged !== existing) {
    fs.writeFileSync(agents, merged);
    done.push(existing === undefined ? "AGENTS.md" : "AGENTS.md (its section on specs)");
  }
  // Claude Code reads AGENTS.md only when there is no CLAUDE.md (and only from v2.1.277), so CLAUDE.md imports it:
  // then it loads once, in every version, whether or not the project had a CLAUDE.md of its own.
  const claude = path.join(root, "CLAUDE.md");
  const own = fs.existsSync(claude) ? fs.readFileSync(claude, "utf8") : undefined;
  if (own === undefined || !/^@AGENTS\.md\s*$/m.test(own)) {
    const ceol = own?.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(claude, own === undefined ? "@AGENTS.md\n" : `${own.trimEnd()}${ceol}${ceol}@AGENTS.md${ceol}`);
    done.push(own === undefined ? "CLAUDE.md (imports AGENTS.md)" : "CLAUDE.md (an import of AGENTS.md)");
  }
  add("tsconfig.json", () => JSON.stringify({ compilerOptions: { target: "es2023", module: "nodenext", strict: true, noEmit: true, allowImportingTsExtensions: true, erasableSyntaxOnly: true, skipLibCheck: true, types: ["node"] }, include: ["src", "test", "gen/*.ts"] }, null, 2) + "\n");
  if (!fs.existsSync(path.join(root, "spec"))) { fs.mkdirSync(path.join(root, "spec")); done.push("spec/"); }
  const ignore = path.join(root, ".gitignore");
  const ignored = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  const missing = ["gen/", ".spec-cache/"].filter((l) => !ignored.split("\n").includes(l));
  if (missing.length) { fs.writeFileSync(ignore, ignored + (ignored && !ignored.endsWith("\n") ? "\n" : "") + missing.join("\n") + "\n"); done.push(".gitignore"); }
  const manifest = path.join(root, "package.json");
  if (fs.existsSync(manifest)) {
    const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const scripts = { check: "spec check", gen: "spec gen", accept: "spec accept" };
    const added = Object.entries(scripts).filter(([name]) => !json.scripts?.[name]);
    if (added.length) {
      json.scripts = { ...json.scripts, ...Object.fromEntries(added) };
      fs.writeFileSync(manifest, JSON.stringify(json, null, 2) + "\n");
      done.push(`package.json scripts: ${added.map(([n]) => n).join(", ")}`);
    }
  }
  return done;
}

// --- new -----------------------------------------------------------------------------

/** A spec that passes every check as it is: one story, the state, one guarded transition, an `always` and a `sometimes` rule. */
const starter = (name: string, fence = "`".repeat(3)) => `# ${name}

What the application is for, in a sentence or two. Replace the story and its
rules with your own; CONTRIBUTING.md says how to write them.

## Story: Keep a tally

> As a user, I want to add to a tally, never past its limit, so that I can
> count things up to a known number.

### A new tally is empty

${fence}quint
type Tally = { count: int }
pure val initial: Tally = { count: 0 }
${fence}

### Only a positive amount that keeps the tally within its limit can be added

The limit is ten, and the tally never passes it.

${fence}quint
pure val limit = 10
pure def canAdd(t: Tally, n: int): bool = n > 0 and t.count + n <= limit
pure def add(t: Tally, n: int): Tally = { count: t.count + n }
pure def alwaysWithinLimit(t: Tally): bool = 0 <= t.count and t.count <= limit
${fence}

### A tally can reach its limit

${fence}quint
pure def sometimesFull(t: Tally): bool = t.count == limit
${fence}
`;

/** Write spec/<name>.md, a starter spec; returns its path. Nothing is overwritten. */
export function newSpec(root: string, name: string): string {
  const bad = badSpecName(name);
  if (bad) throw new Error(`spec new ${name}: ${bad}`);
  const file = `spec/${name}.md`;
  fs.mkdirSync(path.join(root, "spec"), { recursive: true });
  try {
    fs.writeFileSync(path.join(root, file), starter(name), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${file} already exists; nothing was written`);
    throw e;
  }
  return file;
}

// --- CLI -----------------------------------------------------------------------------

/** Run as a command, not imported? `import.meta.main` says so from Node 24.2; before that, compare the paths. */
const isMain = (): boolean => {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

const USAGE = "usage: spec check [--json] | watch | gen | accept | accept unproved | new <name> | init";

/**
 * Check, then check again whenever spec/, src/, test/ or tsconfig.json changes. One process stays warm between runs
 * (the compiler, the toolchain's fingerprint and the cache are already loaded), edits that arrive during a run start
 * one more run after it, and what is unchanged comes from the cache as in any check.
 */
async function watch(root: string) {
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const once = async () => {
    if (running) { again = true; return; }
    running = true;
    do {
      again = false;
      const started = Date.now();
      console.log(`\n--- ${new Date().toLocaleTimeString()} ---`);
      try {
        const { next } = await check(root, false, (r) => console.log(show(r)));
        console.log(`\nnext: ${next}\n(${((Date.now() - started) / 1000).toFixed(1)}s; watching spec/, src/, test/ and tsconfig.json; Ctrl-C to stop)`);
      } catch (e) {
        console.error((e as Error).message);
      }
    } while (again);
    running = false;
  };
  const changed = (file?: string | null) => {
    // Editors write temporary files beside the real one; only sources matter.
    if (file && !/\.(md|ts|dfy|json)$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(once, 200);
  };
  for (const dir of ["spec", "src", "test"]) if (fs.existsSync(path.join(root, dir))) fs.watch(path.join(root, dir), { recursive: true }, (_, f) => changed(f));
  if (fs.existsSync(path.join(root, "tsconfig.json"))) fs.watch(path.join(root, "tsconfig.json"), () => changed());
  await once();
}

if (isMain()) {
  const root = process.cwd();
  const [command, ...args] = process.argv.slice(2);
  const takes = (...allowed: string[][]) => allowed.some((a) => a.length === args.length && a.every((x, i) => x === "*" || x === args[i]));
  try {
    if (Number(process.versions.node.split(".")[0]) < 24) throw new Error(`spec needs Node 24 or later; this is Node ${process.versions.node}`);
    if (command === "gen" && takes([], ["--if-valid"])) {
      // --if-valid is for `npm install`: a spec in the middle of an edit must not make installing fail.
      try {
        const models = new Map<string, Model>();
        for (const s of readSpecs(root)) gen(root, s, models);
      } catch (e) {
        if (!args.length) throw e;
        console.log(`note: gen/ was not generated, because a spec is not valid yet (${(e as Error).message.split("\n")[0]}); \`npm run check\` says why`);
      }
    } else if ((command === "check" && takes([], ["--json"])) || (command === "accept" && takes([], ["unproved"]))) {
      const json = args[0] === "--json";
      const accept = command === "check" ? false : args[0] === "unproved" ? "unproved" : "reviews";
      const { ok, results, next } = await check(root, accept, json ? undefined : (r) => console.log(show(r)));
      console.log(json ? JSON.stringify({ ok, results, next }, null, 2) : `\nnext: ${next}`);
      process.exitCode = ok ? 0 : 1;
    } else if (command === "init" && takes([])) {
      const done = init(root);
      console.log(done.length ? `added: ${done.join(", ")}` : "nothing to add: everything is already there");
    } else if (command === "watch" && takes([])) {
      await watch(root);
    } else if (command === "new" && takes(["*"])) {
      console.log(`wrote ${newSpec(root, args[0])}; run \`npm run check\``);
    } else {
      console.error(command === "accept" ? `accept takes no argument, or \`unproved\`; not ${args.join(" ")}\n${USAGE}` : USAGE);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
