// Does each check catch the kind of mistake it exists for? Every case builds a
// scratch project, from this project's own spec or from the small specs in
// vibestack/fixtures/, breaks one thing, and asserts which stage of `check` fails.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { LIB_FILE, isolatedCopies, parseProofFile, readVerdict, splice } from "./prove.ts";
import { exec, run as tool } from "./run.ts";
import { migrateLocks, pendingSpecs, readLedger, writeLedger } from "./review.ts";
import { nodeRunsVibelang, packageScripts } from "./util.ts";
import { canonical, departure } from "./conformance.ts";
import { conformance as checkTraces, conformanceFound, writeConformance } from "./conform.ts";
import { acceptContracts, acceptReviews, check, checkVerifiedSource, danglingCitations, expandListHelpers, generated, init, parseSpec, pending, pendingContracts, readSpecs, replay, show, typecheckAll, type Result, type Spec } from "./spec.ts";

const project = path.join(import.meta.dirname, "..");
const EXAMPLE = path.join(project, "vibestack/examples/order");
const read = (file: string, from = project): string => fs.readFileSync(path.join(from, file), "utf8");
const F = "`".repeat(3);
/** What makes the order example a VibeLang package: its manifest, and what its compiler and test runner read. */
const PACKAGE = Object.fromEntries(["package.json", "tsconfig.json", "vitest.config.ts"].map((f) => [f, read(f, EXAMPLE)]));
const roots: string[] = [];
const nodeModules = (function find(dir: string): string {
  const here = path.join(dir, "node_modules");
  return fs.existsSync(here) ? here : dir === path.dirname(dir) ? assert.fail("no node_modules: run pnpm install") : find(path.dirname(dir));
})(project);
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

/** A scratch project holding the given files. */
function scratch(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  if (Object.keys(files).some((f) => /^(src|test)\//.test(f)) && !files["tsconfig.json"]) {
    fs.writeFileSync(path.join(root, "tsconfig.json"), PACKAGE["tsconfig.json"]);
    fs.symlinkSync(nodeModules, path.join(root, "node_modules"), "dir");
  }
  return root;
}
/** A scratch project whose specs are the named fixtures, with their proof files, each changed by `edit` if it is given. */
const fixtures = (names: string[], edit: (files: Record<string, string>) => void = () => {}) => {
  const files = Object.fromEntries(names.flatMap((n) => [`${n}.md`, `${n}.proof.dfy`]
    .filter((f) => f.endsWith(".md") || fs.existsSync(path.join(project, "vibestack/fixtures", f))).map((f) => [`spec/${f}`, read(`vibestack/fixtures/${f}`)])));
  edit(files);
  return scratch(files);
};
/** `root` with its own copy of the toolchain, and of node_modules only the packages and the executables `tools`. */
function toolchain(root: string, ...tools: string[]): string {
  fs.cpSync(path.join(project, "vibestack"), path.join(root, "vibestack"), { recursive: true, filter: (from) => from !== path.join(project, "vibestack/examples") });
  const modules = path.join(root, "node_modules");
  fs.mkdirSync(path.join(modules, ".bin"), { recursive: true });
  for (const entry of fs.readdirSync(nodeModules).filter((f) => f !== ".bin"))
    fs.symlinkSync(path.join(nodeModules, entry), path.join(modules, entry), fs.statSync(path.join(nodeModules, entry)).isDirectory() ? "dir" : "file");
  for (const tool of tools.map((t) => process.platform === "win32" ? `${t}.cmd` : t))
    fs.symlinkSync(path.join(nodeModules, ".bin", tool), path.join(modules, ".bin", tool), "file");
  return root;
}
/** A spec made of a single rule. */
const ruleSpec = (quint: string, heading = "A rule", title = "T", story = "Story") => `# ${title}\n\n## ${story}\n\n### ${heading}\n\n${F}quint\n${quint}\n${F}\n`;
/** A scratch project with one spec made of a single rule. */
const oneRule = (name: string, heading: string, quint: string) => scratch({ [`spec/${name}.md`]: ruleSpec(quint, heading) });
/** A scratch project with a spec `use` that imports a spec `lib`. */
const libAndUse = (lib: string, use: string) => scratch({ "spec/lib.md": lib, "spec/use.md": use });
/** Hand-written code with a one-line contract. */
const ONE = "//@ pure\nexport function one(): number {\n  //@ ensures \\result === 1\n  return 1;\n}\n";
/** Generated Dafny: one function and its obligation. */
const GENERATED_F = "function f(x: int): int\n{\n  x\n}\n\nlemma f_ensures(x: int)\n  ensures (f(x) >= x)\n{\n}\n";
/** Wait until `ready`, failing with `why` after two minutes. */
async function until(ready: () => boolean | Promise<boolean>, why: () => string = () => "timed out") {
  const end = Date.now() + 120_000;
  while (!(await ready())) {
    assert.ok(Date.now() < end, why());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The order example with whatever awaits sign-off here accepted, checked once
// so that every copy starts with its cache: an edit then re-runs only what it changes.
const pristine = scratch({});
for (const file of ["spec/index.md", "src", "test"]) fs.cpSync(path.join(EXAMPLE, file), path.join(pristine, file), { recursive: true });
for (const [file, text] of Object.entries(PACKAGE)) fs.writeFileSync(path.join(pristine, file), text);
fs.symlinkSync(nodeModules, path.join(pristine, "node_modules"), "dir");
for (const spec of readSpecs(pristine)) acceptReviews(pristine, spec);
acceptContracts(pristine);
const pristineCheck = await check(pristine);
assert.equal(pristineCheck.ok, true, pristineCheck.results.map(show).join("\n"));

/** A copy of the pristine project with `edit` applied to one file. */
function copyOfProject(file?: string, edit: (text: string) => string = (s) => s): string {
  const root = scratch({});
  fs.cpSync(pristine, root, { recursive: true });
  if (!file) return root;
  const target = path.join(root, file);
  const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const changed = edit(before);
  assert.notEqual(changed, before, "the edit must change the file");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, changed);
  return root;
}

/** Check a project: the stages that failed, and what a stage said that matches a pattern. */
async function run(root: string, accept: false | "reviews" | "unproved" = false) {
  const { results, next } = await check(root, accept);
  const text = results.map(show).join("\n");
  return {
    text,
    next,
    failed: [...new Set(results.filter((r) => !r.ok).map((r) => r.stage))],
    said: (stage: Result["stage"], pattern: RegExp) => results.find((r) => r.stage === stage && pattern.test(`${r.summary}\n${r.detail}`)),
  };
}
const failedStages = async (file: string, edit: (text: string) => string) => (await run(copyOfProject(file, edit))).failed;
const pendingItems = (root: string) => readSpecs(root).flatMap((spec) => pending(root, spec).map((p) => `${p.where.split("  ")[1]}: ${p.status}${p.note ?? ""}`));
/** gen/ for one spec, as `check` and `spec gen` generate it. */
const gen = async (root: string, spec: Spec) => generated(root, spec, await typecheckAll({ root, fresh: true, used: new Set() }, [spec]).get(spec.name)!, new Map());
/** gen/ for every spec of a project, in dependency order: the files it holds. */
async function genAll(root: string): Promise<string[]> {
  const specs = readSpecs(root);
  const typed = typecheckAll({ root, fresh: true, used: new Set() }, specs);
  const models = new Map();
  for (const spec of specs) generated(root, spec, await typed.get(spec.name)!, models);
  return fs.readdirSync(path.join(root, "gen")).sort();
}
/** Run a fresh CLI process so toolchain fingerprints cannot carry over from another invocation. */
const runCli = (script: string, root: string, ...args: string[]) => exec(process.execPath, [script, ...args], root);
const unguarded = (s: string) => s.replace("o.status == Draft and o.units > 0", "o.status == Draft");
const notInductive = (s: string) => s.replace(/### Drafts and cancelled orders hold no money[\s\S]*?```\n\n/, "");

describe("each check catches its own kind of mistake", { concurrency: true }, () => {
  test("collection operations preserve structural equality, total lookups and exact integer results", async () => {
    const forged = oneRule("forged", "Forged builtin", "pure def std_getOr_forged(m: int -> int, key: int, fallback: int): int = 42\npure def readMap(m: int -> int): int = std_getOr_forged(m, 1, 0)");
    await assert.rejects(gen(forged, parseSpec(forged, "spec/forged.md")), /reserved for generated collection operations/);
    const root = oneRule("collections", "Collections", `type Item = { n: int }
pure def same(a: Item, b: Item): bool = a == b
pure def itemAt(xs: List[int], i: int): int = xs.nthOr(i, 7)
pure def remove(xs: List[int], i: int): List[int] = xs.removeAt(i)
pure def lookup(m: int -> int, key: int): int = m.getOr(key, 9)
pure def add(a: int, b: int): int = a + b`);
    const model = await gen(root, parseSpec(root, "spec/collections.md"));
    const domain = await import(path.join(root, "gen/collections.ts"));
    assert.equal(domain.same({ n: 1 }, { n: 1 }), true);
    assert.equal(domain.same({ n: 1 }, { n: 2 }), false);
    assert.equal(domain.itemAt([3], -1), 7);
    assert.equal(domain.itemAt([3], 0), 3);
    assert.deepEqual(domain.remove([1, 2, 3], 1), [1, 3]);
    assert.deepEqual(domain.remove([1, 2, 3], 4), [1, 2, 3]);
    assert.equal(domain.lookup({ 1: 3 }, 1), 3);
    assert.equal(domain.lookup({ 1: 3 }, 2), 9);
    assert.throws(() => domain.add(Number.MAX_SAFE_INTEGER, 1), RangeError);
    assert.doesNotMatch(model.render(""), /Number\.isSafeInteger|function exact_/);
  });

  test("transitions return effects and step rules inspect their order", async () => {
    const lists = oneRule("lists", "State and effects share a type", `type State = List[int]
type Did = { state: State, out: List[int] }
pure val initial: State = List()
pure def push(s: State, n: int): Did = { state: s.append(n), out: List(n) }
pure def stepHasOneEffect(before: State, after: State, out: List[int]): bool = out.length() == 1`);
    const model = await gen(lists, parseSpec(lists, "spec/lists.md"));
    assert.equal(model.evals.find((e) => e.name === "stepHasOneEffect")?.params.at(-1)?.from, "emitted");
    const root = fixtures(["mailer"]);
    const result = await run(root);
    assert.deepEqual(result.failed, ["review"], result.text);
    const domain = await import(path.join(root, "gen/mailer.ts"));
    assert.deepEqual(domain.step(domain.initial, { type: "send", n: 4 }), {
      state: { sent: 1 }, out: [{ tag: "Saved", n: 4 }, { tag: "Sent", n: 4 }],
    });
    assert.deepEqual(domain.step(domain.initial, { type: "send", n: 0 }), { state: domain.initial, out: [] });
    const helper = await import(path.join(root, "gen/mailer.conformance.ts"));
    const emitted = domain.step(domain.initial, { type: "send", n: 4 });
    assert.equal(departure(domain, helper.found, [{ state: domain.initial }, { event: { type: "send", n: 4 }, state: emitted.state, out: emitted.out }]), undefined);
    assert.match(departure(domain, helper.found, [{ event: { type: "send", n: 4 }, state: emitted.state, out: emitted.out.toReversed() }])?.why ?? "", /effects differ/);
  });

  test("conformance observes scalar states, real program traces, and only demands behavior present in the oracle", async () => {
    const root = oneRule("counter", "Count", "pure val initial: int = 0\npure def canInc(n: int): bool = n < 2\npure def inc(n: int): int = n + 1\npure def alwaysValid(n: int): bool = 0 <= n and n <= 2");
    const spec = parseSpec(root, "spec/counter.md");
    const model = await gen(root, spec);
    const domain = await import(path.join(root, "gen/counter.ts"));
    const found = conformanceFound(model, spec, [[{ state: 0 }, { event: { type: "inc" }, state: 1 }, { event: { type: "inc" }, state: 2 }]], []);
    writeConformance(root, model, found);
    const helper = await import(path.join(root, "gen/counter.conformance.ts"));
    const states = new Map<string, number>();
    const counting = {
      reset: () => states.clear(),
      dispatch: (key: string) => { const n = states.get(key) ?? 0; if (n === 2) return "refused"; states.set(key, n + 1); return "accepted"; },
      observe: (key: string) => states.get(key) ?? 0,
    };
    await helper.conformance(counting, { walks: 3, steps: 6 });
    // One counter shared by every key: the failure carries its shrunk trace as data, which replays the same way.
    let shared = 0;
    const leaky = { reset: () => { shared = 0; }, dispatch: () => { shared++; return "accepted"; }, observe: () => shared };
    const failure = await helper.conformance(leaky, { walks: 1, steps: 1 }).catch((e: unknown) => e);
    assert.ok(failure instanceof helper.ConformanceError && failure.trace.length === 1 && /should be 0, but the application has 1/.test(failure.message), String(failure));
    await assert.rejects(helper.replay(leaky, failure.trace), helper.ConformanceError);
    await helper.replay(counting, failure.trace);
    assert.equal(departure(domain, found, [{ state: 0 }, { event: { type: "inc" }, state: 1 }]), undefined);
    assert.match(departure(domain, found, [{ event: { type: "inc" } }])?.why ?? "", /no observed state/);
    fs.mkdirSync(path.join(root, "test/traces"), { recursive: true });
    fs.writeFileSync(path.join(root, "test/traces/counter.jsonl"), '{"state":0}\n{"event":{"type":"inc"},"state":1}\n');
    fs.writeFileSync(path.join(root, "driver.json"), '{"offset":0,"limit":2}');
    fs.writeFileSync(path.join(root, "driver.mjs"), 'import fs from "node:fs"; import readline from "node:readline"; let n=0; for await (const line of readline.createInterface({input:process.stdin})) { const request=JSON.parse(line), {offset,limit}=JSON.parse(fs.readFileSync("driver.json","utf8")); if (!request.event) n=0; else if (n<limit) n++; console.log(JSON.stringify({state:n+offset})); }');
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({type:"module",scripts:{"driver:counter":`${JSON.stringify(process.execPath)} driver.mjs`}}));
    const machines = new Map([["counter", { domain, model, found }]]);
    const departs = async () => (await checkTraces(root, machines, packageScripts(root))).filter(([ok]) => !ok).map(([, , summary, detail]) => `${summary}\n${detail}`);
    assert.deepEqual(await departs(), []);
    // A driver that starts elsewhere, or takes the event the spec refuses in the last state of a trace, departs.
    fs.writeFileSync(path.join(root, "driver.json"), '{"offset":1,"limit":2}');
    assert.match((await departs()).join(), /^script driver:counter: the program departs[\s\S]*reset/);
    fs.writeFileSync(path.join(root, "driver.json"), '{"offset":0,"limit":3}');
    assert.match((await departs()).join(), /^script driver:counter: the program departs[\s\S]*line 4/);
    // So does a trace the program wrote, at the first line that differs.
    fs.writeFileSync(path.join(root, "driver.json"), '{"offset":0,"limit":2}');
    fs.writeFileSync(path.join(root, "test/traces/counter.jsonl"), '{"state":0}\n{"event":{"type":"inc"},"state":2}\n');
    assert.match((await departs()).join(), /^test\/traces\/counter\.jsonl: the program departs[\s\S]*line 2/);

    const quiet = oneRule("quiet", "Wait", "pure val initial: int = 0\npure def stay(n: int): int = n\npure def alwaysZero(n: int): bool = n == 0");
    const quietSpec = parseSpec(quiet, "spec/quiet.md"), quietModel = await gen(quiet, quietSpec);
    await import(path.join(quiet, "gen/quiet.ts"));
    writeConformance(quiet, quietModel, conformanceFound(quietModel, quietSpec, [[{ state: 0 }, { event: { type: "stay" }, state: 0 }]], []));
    const quietHelper = await import(path.join(quiet, "gen/quiet.conformance.ts"));
    await quietHelper.conformance({ reset() {}, dispatch: () => "accepted", observe: () => 0 }, { walks: 1, steps: 2 });
  });

  test("set canonicalization follows tagged variants and preserves list order", async () => {
    const root = oneRule("mixed", "Values", "type Values = A({ values: Set[int] }) | B({ values: List[int] })\npure val initial: Values = A({ values: Set(1, 2) })\npure def list(v: Values): Values = B({ values: List(1, 2) })");
    const model = await gen(root, parseSpec(root, "spec/mixed.md"));
    assert.equal(canonical({ tag: "A", values: [1, 2] }, model.shape!), canonical({ tag: "A", values: [2, 1] }, model.shape!));
    assert.notEqual(canonical({ tag: "B", values: [1, 2] }, model.shape!), canonical({ tag: "B", values: [2, 1] }, model.shape!));
  });

  test("a fresh spec with enum and bool parameters and an unguarded transition passes everything but review", async () => {
    const root = fixtures(["door"]);
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.match(fs.readFileSync(path.join(root, "gen/proof/door.log"), "utf8"), /Dafny auditor completed/);
  });

  test("a missing guard is found by simulation, as a trace that the same seed gives again, and the later stages say they were skipped", async () => {
    const root = copyOfProject("spec/index.md", unguarded);
    const [first, again] = [await run(root), await run(root)];
    const trace = first.said("always", /./);
    assert.equal(trace?.ok, false, first.text);
    assert.match(trace!.detail, /seed \d+; to simulate again: npx quint run gen\/index\.run\.qnt .* --seed \d+/);
    assert.equal(again.said("always", /./)?.detail, trace!.detail, "the same harness gives the same trace");
    assert.ok(first.said("skipped", /^types, proof, tests and traces: /), first.text);
    assert.match(first.next, /^always \(spec\/index\.md\) is the first ✗/);
  });

  test("a rule set that holds in simulation but is not inductive is caught by the proof, and the deleted rule awaits review", async () => {
    const { failed, said, text } = await run(copyOfProject("spec/index.md", notInductive));
    assert.deepEqual(failed, ["proof", "review"], text);
    assert.ok(said("review", /removed or renamed/), text);
  });

  test("rules too strict to ever reach a goal are caught by a `sometimes` rule", async () => {
    const failed = await failedStages("spec/index.md", (s) => s.replace("o.paid + amount <= o.due", "o.paid + amount < o.due"));
    assert.ok(failed.includes("sometimes"), failed.join());
  });

  test("a guard that never allows its event is caught, although every rule holds of the event trivially", async () => {
    // Cancelling refunds every payment, so a reopen that needs money paid can never happen.
    const { failed, text, said } = await run(copyOfProject("spec/index.md", (s) => s.replace("canReopen(o: Order): bool = o.status == Cancelled", "canReopen(o: Order): bool = o.status == Cancelled and o.paid > 0")));
    assert.ok(failed.includes("sometimes"), text);
    assert.ok(said("sometimes", /reopen in .* never happened: its guard canReopen refused it/), text);
  });

  test("a guard that needs values the simulator does not try says which to define", async () => {
    const { text, said } = await run(copyOfProject("spec/index.md", (s) => s.replace("o.status == Pending and amount > 0 and neverMoreThanPaid", "o.status == Pending and amount > 6 and neverMoreThanPaid")));
    assert.ok(said("sometimes", /takeBack in .* never happened: .*define amountValues/), text);
    assert.ok(!/\bpay in .* never happened/.test(text), text);
  });

  test("a guard that never refuses its event is reported without failing", async () => {
    // Every reachable lamp has counted its flips, so this guard restates a rule and restricts nothing.
    const { failed, text, said } = await run(fixtures(["lamp"], (f) => {
      f["spec/lamp.md"] = f["spec/lamp.md"].replace("pure def toggle(", "pure def canToggle(l: Lamp): bool = l.flips >= 0\npure def toggle(");
    }));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("sometimes", /never seen to refuse it .*: canToggle\b/), text);
  });

  test("prose edited without the model is flagged for review, and accept records it only while every other stage passes", async () => {
    const reworded = (s: string) => s.replace("Every unit costs the same", "Each unit has one price");
    const root = copyOfProject("spec/index.md", reworded);
    assert.deepEqual((await run(root)).failed, ["review"]);
    assert.deepEqual((await run(root, "reviews")).failed, []);
    assert.deepEqual((await run(copyOfProject("spec/index.md", (s) => unguarded(reworded(s))), "reviews")).failed, ["always", "review"]);
  });

  test("a rule with no formal half is flagged", async () => {
    const failed = await failedStages("spec/index.md", (s) => s + "\n### Refunds arrive within three days\n\nNot yet modelled.\n");
    assert.deepEqual(failed, ["review"]);
  });

  test("Quint outside the supported subset, or that the translator cannot render faithfully, is refused", async () => {
    const refused: [string, (s: string) => string][] = [
      ["an operator outside the subset", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5^1")],
      ["integer beyond 2^53", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 9007199254740993")],
      ["parameter named like a variant", (s) => s.replace("canCancel(o: Order): bool = o.status == Pending", "canCancel(o: Order): bool = o.status == Pending\npure def isIt(o: Order, Draft: Status): bool = o.status == Draft")],
      ["rule name with the wrong capital", (s) => s.replace(/alwaysPaidWithinDue/g, "alwayspaidWithinDue")],
      ["TypeScript keyword as a name", (s) => s.replace(/\bcancel\b/g, "delete").replace(/canCancel/g, "canDelete")],
      ["parameter that collides with the harness's state variable", (s) => s.replace(/\bamount\b/g, "state")],
      ["duplicate rule heading", (s) => s.replace("### An order can be cancelled", "### A pending order can be cancelled, refunding every payment")],
    ];
    for (const [what, edit] of refused) assert.deepEqual(await failedStages("spec/index.md", edit), ["model"], what);
  });

  test("names, constructs, sample sets and shapes that would be translated wrongly are refused, and a constant named like a rule is not", async () => {
    const sampled = "type S = { n: int }\npure val initial: S = { n: 0 }\npure def canAdd(s: S, amount: int): bool = amount > 0\npure def add(s: S, amount: int): S = { n: s.n + amount }";
    const refused: [string, string, RegExp][] = [
      ["a type named like a generated one", "type Event = { n: int }\npure val initial: Event = { n: 0 }", /cannot be used as a name/],
      ["a definition named like a JavaScript global", "pure val initial: int = 0\npure def Number(n: int): int = n", /cannot be used as a name/],
      ["a parameter named like Dafny's standard library", "pure val initial: int = 0\npure def f(Std: int): int = Std", /`Std` cannot be used as a name/],
      ["a set of two computed members", "pure val initial: int = 0\npure def pair(a: int, b: int): int = Set(a, b).size()", /could hold the same value twice/],
      ["a variant field called tag", "type P = A({ tag: int }) | B\npure val initial: int = 0\npure def tick(n: int): int = n", /cannot be called `tag`/],
      ["a match binder used as a whole value", "type N = { n: int }\ntype P = A(N) | B\npure val initial: int = 0\npure def g(r: N): int = r.n\npure def f(p: P): int = match p { | A(x) => g(x) | _ => 0 }\npure def tick(n: int): int = n", /is what a match arm carries/],
      ["state declared by hand", "pure val initial: int = 0\nvar n: int", /only types, imports, `pure val` and `pure def` belong in a spec/],
      ["a rule written as a `pure val`", "pure val initial: int = 0\npure val alwaysNever = false", /is a `pure def` with parameters/],
      ["a sample of the wrong type", 'pure val amountValues = Set("bad")\n' + sampled, /amountValues.*holds.*parameter amount/],
      ["an unused sample set", "pure val typoValues = Set(1)\n" + sampled, /no parameter is named typo/],
      ["a sample set used at runtime", "pure val amountValues = Set(1)\n" + sampled + "\npure def total(k: int): int = amountValues.size()", /amountValues.*(simulat|runtime|sample)/],
      ["identical record shapes", "type A = { n: int }\ntype B = { n: int }\npure def convert(a: A): B = { n: a.n }", /have the same fields/],
      ["a definition with no parameters", "pure def one(): int = 1", /parameter/],
      ["two declarations on one line", "pure val first = 1 pure val second = 2", /declaration|own line|rule/],
      ["an initial state without a transition", "pure val initial: int = 0", /transition/],
      ["a set of records", "type A = { n: int }\npure def count(xs: Set[A]): int = xs.size()", /set|Set/],
      ["a map into records", "pure def records(xs: Set[int]): Set[{ n: int }] = xs.map(x => { n: x })", /set|Set|record/],
      ["== on values that hold a set", "type A = { s: Set[int] }\npure def same(a: A, b: A): bool = a == b", /a set is a sequence/],
      ["a map keyed by booleans", "pure def flags(k: bool): bool -> int = Map(k -> 1)", /keys must be/],
      ...["fairOn", "fairEnabled", "arguments", "implements"].map((name): [string, string, RegExp] =>
        [`reserved generated name ${name}`, `pure def ${name}(n: int): int = n`, /cannot be used as a name/]),
    ];
    const [constant, ...results] = await Promise.all(["pure val stepLimit = 3\npure def lawPositive(k: int): bool = stepLimit > 0", ...refused.map(([, quint]) => quint)]
      .map((quint) => run(oneRule("t", "A rule", quint))));
    refused.forEach(([what, , message], i) => assert.equal(results[i].said("model", message)?.ok, false, `${what}\n${results[i].text}`));
    assert.ok(!constant.failed.includes("model"), constant.text);
  });

  test("a comment or string left open at the end of a quint block is refused, so prose can never become model", async () => {
    // Prose is tangled as `// …`; inside an open block comment, `// */ code` would be code that no review or cache key sees as such.
    const { said, text } = await run(copyOfProject("spec/index.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5\n/*")));
    assert.equal(said("model", /a comment is still open at the end of this quint block/)?.ok, false, text);
  });

  test("who sent an event travels beside it, a guard takes only what it uses, a step rule sees the event, and deep goals are found", async () => {
    const vault = (edit: (s: string) => string = (s) => s) => fixtures(["vault"], (f) => { f["spec/vault.md"] = edit(f["spec/vault.md"]); });
    const root = vault();
    const [ok, broken, stray] = await Promise.all([
      run(root),
      run(vault((s) => s.replace("{ ...v, open: false }", "{ ...v, open: true }"))),
      run(vault((s) => s.replace("canRelabel(v: Vault, by: Actor): bool = by", "canRelabel(v: Vault, who: Actor): bool = who"))),
    ]);
    assert.deepEqual(ok.failed, ["review"], ok.text);
    assert.ok(ok.said("sometimes", /sometimesLate is reachable/), ok.text); // thirty ticks: beyond a trace of 20 events
    const gen = await import(path.join(root, "gen/vault.ts"));
    assert.deepEqual(gen.parseEvent({ type: "open", by: "Owner" }), { type: "open" });
    assert.equal(gen.enabled(gen.initial, { type: "open" }, "Guest"), false);
    assert.equal(gen.parseSender("Owner"), "Owner");
    assert.equal(gen.parseSender("Mallory"), undefined);
    const helper = await import(path.join(root, "gen/vault.conformance.ts"));
    assert.match(departure(gen, helper.found, [{ event: { type: "open" }, by: "Mallory", state: gen.initial }])?.why ?? "", /valid sender/);
    assert.equal(gen.step(gen.initial, { type: "relabel", label: "a" }, "Owner").label, "a");
    // A counterexample shows each event with only what it changed.
    assert.ok(broken.said("always", /a step breaks[\s\S]*\n\s+close\s+-> open = true\n/), broken.text);
    assert.ok(stray.said("model", /canRelabel: `who` must be a parameter of relabel/), stray.text);
  });

  test("a rule broken only on the way to a `sometimes` goal is still reported", async () => {
    // Only the witness search goes deep enough: the goal is three steps away and the break is on the way.
    const quint = "pure val initial: int = 0\npure def up(n: int): int = n + 1\npure def canUp(n: int): bool = n < 5\npure def alwaysBelowThree(n: int): bool = n < 3\npure def sometimesFour(n: int): bool = n == 4";
    const { failed, text } = await run(oneRule("t", "Counting", quint));
    assert.ok(failed.includes("always"), text);
    assert.ok(!failed.includes("sometimes"), text);
  });

  test("hand-written code that changes what it is checked against is refused or flagged", async () => {
    const { said, text } = await run(copyOfProject("src/ledger.ts", (s) => s.replace(/(\/\/@ ensures)/, "//@ requires true\n$1")));
    assert.ok(said("proof", /^src-ledger\.ts: .*under 2 \/\/@ requires/), text);
  });

  test("the application's types and tests are checked, in VibeLang and in the TypeScript beside it, on a Node that loads both", async () => {
    const [mistyped, failing, plain] = await Promise.all([
      run(copyOfProject("src/app.vibe", (s) => s + "\nconst wrong: number = \"x\"\n")),
      run(copyOfProject("test/app.test.vibe", (s) => s + '\nit("never holds", () => { assert.strictEqual(1, 2) })\n')),
      // Without a test script Node runs test/**/*.test.ts, through VibeLang's loader.
      run(fixtures(["door"], (f) => Object.assign(f, {
        "src/wrong.ts": 'export const wrong: number = "x";\n',
        "test/never.test.ts": 'import { test } from "node:test";\ntest("never holds", () => { throw new Error("no"); });\n',
      }))),
    ]);
    const unfit = "application does not fit the generated contract";
    assert.equal(mistyped.said("types", /src\/app\.vibe\(\d+,\d+\): error TS2322/)?.summary, unfit, mistyped.text);
    assert.deepEqual(failing.failed, ["tests"], failing.text);
    assert.ok(failing.said("tests", /^fail\n[\s\S]*test\/app\.test\.vibe > never holds[\s\S]*expected 1 to equal 2/), failing.text);
    assert.deepEqual(plain.failed, ["types", "tests", "review"], plain.text);
    assert.equal(plain.said("types", /src\/wrong\.ts\(1,14\): error TS2322/)?.summary, unfit, plain.text);
    assert.ok(plain.said("tests", /^fail\n[\s\S]*never holds/), plain.text);
    const untyped = copyOfProject();
    fs.rmSync(path.join(untyped, "tsconfig.json"));
    assert.ok((await run(untyped)).failed.includes("types"));
    // The types stage also refuses a Node that cannot load `.vibe` sources: below either floor, or between the two lines.
    assert.deepEqual(["22.22.2", "22.22.3", "23.11.1", "24.5.0", "24.11.1", "26.0.0"].map((v) => nodeRunsVibelang(v)), [false, true, false, false, true, true]);
  });

  test("a shell written for a transition the spec has since renamed no longer fits the generated contract", async () => {
    const { said, next, text } = await run(copyOfProject("spec/index.md", (s) => s.replace(/\b(a|canA)ddItem\b/g, "$1ddItems")));
    assert.equal(said("types", /src\/demo\.vibe\(\d+,\d+\): error TS\d+: Type '"addItem"' is not assignable/)?.summary, "application does not fit the generated contract", text);
    assert.match(next, /^types \(src\/ and test\/\) is the first ✗: update src\/ and test\/ to the generated contract/);
  });

  test("every generated module has an Effect adapter, which the compiler accepts inside gen/ with a shell that uses it, for a library, a machine built on it, one built on a machine, one with a sender and one with effects", async () => {
    const names = ["lamp", "lib", "mailer", "room", "shop", "vault"];
    const root = scratch({ ...Object.fromEntries(names.map((n) => [`spec/${n}.md`, read(`vibestack/fixtures/${n}.md`)])), "src/desk.vibe": `import { total } from "../gen/lib.effect.vibe"
import { Machine as Mailer, machine as mailer } from "../gen/mailer.effect.vibe"
import { add, apply, initial } from "../gen/shop.effect.vibe"
import { type NotASender, type Rejected, Machine as Vault, decodeSender, machine as vault } from "../gen/vault.effect.vibe"

/** The owner opens the vault, and whoever \`input\` names relabels it. */
export effect function relabelled(input: unknown, label: string): string!(NotASender | Rejected) {
  provide vault() {
    const held = try Vault
    try held.send({ type: "open" }, "Owner")
    return (try held.send({ type: "relabel", label }, try decodeSender(input))).label
  }
}

/** What sending \`n\` asks of the program, and how many were sent. */
export effect function posted(n: number) {
  provide mailer() {
    const held = try Mailer
    const did = try held.receive({ type: "send", n })
    return [did.out.length, (try held.get()).sent] as const
  }
}

/** A cart with one line, by the rules and by the transition itself, and what a library makes of it. */
export effect function filled(sku: string, qty: number) {
  const cart = try apply(initial, { type: "add", sku, qty })
  return [cart.count, add(initial, sku, qty).count, total([qty])] as const
}
` });
    assert.deepEqual(await genAll(root), ["_conformance.ts", "package.json", ...names.flatMap((n) => [`${n}.qnt`, `${n}.run.qnt`, `${n}.ts`, `${n}.effect.vibe`, ...(n === "lib" ? [] : [`${n}.conformance.ts`])])].sort());
    // gen/package.json names no package, so the compiler has no key to derive for a service: the adapter states its own (EK0903).
    assert.deepEqual(JSON.parse(read("gen/package.json", root)), { type: "module" });
    assert.match(read("gen/vault.effect.vibe", root), /^export service Machine \{\n  static readonly key = "spec\/vault\.md#Machine"$/m);
    const compiled = await tool("vibelang", ["--noEmit", "-p", "."], root);
    assert.ok(compiled.ok, compiled.out);
  });

  test("a machine that binds a name of its Effect adapter is refused, and a library, which has no such names, may bind it", async () => {
    const { failed, said, text } = await run(oneRule("t", "A rule", "pure val initial: int = 0\npure def apply(n: int, k: int): int = n + k"));
    assert.deepEqual(failed, ["model"], text);
    assert.ok(said("model", /^spec\/t\.md is not a valid model\n\s+spec\/t\.md: `apply` is a name of the generated Effect adapter \(gen\/t\.effect\.vibe\); name the definition otherwise$/), text);
    const library = oneRule("t", "A rule", "pure def apply(n: int, k: int): int = n + k");
    await gen(library, parseSpec(library, "spec/t.md"));
    assert.match(read("gen/t.effect.vibe", library), /^export \{ apply \}$/m);
  });

  test("Markdown the tools would read differently from a viewer is refused or read as a viewer does", async () => {
    const cr = await failedStages("spec/index.md", (s) => s.replace("Every unit costs the same", "Every unit costs the same\rpure val sneaky = 1"));
    assert.deepEqual(cr, ["model"]);
    // A fence with an info string does not close a quint block, so what follows is still Quint (and here not valid Quint).
    const fence = await failedStages("spec/index.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5\n```text\nnot quint"));
    assert.ok(fence.includes("model"), fence.join());
  });

  test("duplicate story headings are rejected instead of sharing review state", async () => {
    const text = ruleSpec("pure val first = 1", "First", "Duplicate") + ruleSpec("pure val second = 2", "Second").replace(/^# T\n/, "");
    const { said, text: result } = await run(scratch({ "spec/duplicate.md": text }));
    assert.equal(said("model", /duplicate story/)?.ok, false, result);
  });

  test("a story whose title starts another story's title still needs rules of its own", async () => {
    const story = "\n## Story: Wrap\n\n> As a shopper, I want my order wrapped.\n\n## Story: Wrap / gifts\n\n### Gifts are wrapped\n\n```quint\npure def lawWrapped(n: int): bool = true\n```\n";
    const { failed, said, text } = await run(copyOfProject("spec/index.md", (s) => s + story));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("review", /  Story: Wrap\n\s+story has no rules/), text);
  });

  test("a machine whose state holds a library's type can be imported under a name", async () => {
    const root = scratch({
      "spec/lib.md": ruleSpec("type T = { n: int }\npure def lawZeroIsZero(k: int): bool = k * 0 == 0", "Library", "Library"),
      "spec/mach.md": ruleSpec('import lib.* from "./lib"\ntype St = { t: T }\npure val initial: St = { t: { n: 0 } }\npure def bump(s: St): St = { t: { n: s.t.n + 1 } }', "Machine", "Machine"),
      "spec/sys.md": ruleSpec('import mach as M from "./mach"\ntype Sys = { a: M::St }\npure val initial: Sys = { a: M::initial }\npure def go(s: Sys): Sys = { a: M::bump(s.a) }', "System", "System"),
    });
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^sys\.ts: all \d+ obligations proved/), text);
  });

  test("event weights, fairness and bounds name real events and rules and stay outside generated code; a weight repeats its event in the simulator's choice", async () => {
    const base = "type S = { n: int }\npure val initial: S = { n: 0 }\npure def add(s: S, k: int): S = { n: s.n + k }\npure def leadsToSome(s: S, later: S): bool = later.n >= s.n\n";
    const model = (quint: string) => { const root = oneRule("w", "Weights", base + quint); return gen(root, parseSpec(root, "spec/w.md")); };
    const cases: [string, RegExp][] = [
      ["pure val weight_nope = 2", /weight_nope .*no transition named nope/],
      ["pure val weight_add = 0", /weight_add .*a whole number from 1 to 100/],
      ['pure val fair_add = "always"', /fair_add .*"weak"/],
      ["pure val within_nope = 2", /within_nope .*no leadsTo rule named nope/],
      ["pure val within_leadsToSome = 0", /within_leadsToSome .*a whole number from 1 to 100/],
      ["pure val within_leadsToSome = 101", /within_leadsToSome .*a whole number from 1 to 100/],
      ["pure def leadsToOne(s: S): bool = true", /leadsToOne: a `leadsTo` rule takes a state and a later state/],
    ];
    for (const [quint, message] of cases) await assert.rejects(model(quint), message, quint);
    const weighted = await model('pure val weight_add = 3\npure val fair_add = "weak"\npure val within_leadsToSome = 2');
    assert.match(weighted.harness, /action step = any \{ add, add, add \}/);
    assert.deepEqual(weighted.within, new Map([["leadsToSome", 2]]));
    assert.doesNotMatch(weighted.ts + weighted.harness, /weight_|fair_|within_/);
    const lone = oneRule("f", "Fair", 'type S = { n: int }\npure val initial: S = { n: 0 }\npure def add(s: S): S = { n: s.n + 1 }\npure val fair_add = "weak"');
    await assert.rejects(gen(lone, parseSpec(lone, "spec/f.md")), /fairness matters only to `leadsTo` rules/);
  });

  test("a `leadsTo` rule is broken by a fair run that stops or loops, until the events it waits on are fair; std/net is imported, simulated and proved beside the spec", async () => {
    const ping = (edit: (s: string) => string = (s) => s) => fixtures(["ping"], (f) => { f["spec/ping.md"] = edit(f["spec/ping.md"]); });
    const [ok, weak, unfair] = await Promise.all([
      run(ping()),
      // A copy lost and sent again for ever is a fair loop unless delivery is strongly fair.
      run(ping((s) => s.replace('fair_deliver = "strong"', 'fair_deliver = "weak"'))),
      // With nothing fair, a run may stop as soon as the question is asked.
      run(ping((s) => s.replace(/pure val fair_\w+ = "\w+"\n/g, ""))),
    ]);
    assert.deepEqual(ok.failed, ["review"], ok.text);
    assert.ok(ok.said("always", /no fair run that stops or loops in \d+ of them breaks a `leadsTo` rule \([1-9]\d* loops found\)/), ok.text);
    assert.ok(ok.said("proof", /^net\.ts: all \d+ obligations proved/), ok.text);
    assert.ok(!ok.said("review", /^std\/net\.md:/), ok.text);
    assert.ok(weak.said("always", /a fair run breaks "Story: Ask until answered \/ A question asked is answered".*may repeat its loop for ever[\s\S]*the run goes round from here/), weak.text);
    assert.ok(unfair.said("always", /a fair run breaks .*may stop at the last state, since no fair event is possible there/), unfair.text);
  });

  test("a `leadsTo` rule with a bound is broken by a run that takes that many events without meeting it", async () => {
    const serve = (tick: string) => oneRule("serve", "Served at once", [
      "type S = { asked: bool, served: bool, n: int }",
      "pure val initial: S = { asked: false, served: false, n: 0 }",
      "pure def canAsk(s: S): bool = not(s.asked)",
      "pure def ask(s: S): S = { ...s, asked: true }",
      "pure def canServe(s: S): bool = s.asked and not(s.served)",
      "pure def serve(s: S): S = { ...s, served: true }",
      tick,
      "pure def tick(s: S): S = { ...s, n: s.n + 1 }",
      "pure def leadsToServed(s: S, later: S): bool = s.asked implies later.served",
      'pure val fair_serve = "weak"',
      "pure val within_leadsToServed = 1",
    ].join("\n"));
    // A clock that may tick between a question and its answer delays the answer past the bound.
    const [ok, late] = await Promise.all([run(serve("pure def canTick(s: S): bool = s.served or not(s.asked)")), run(serve(""))]);
    assert.equal(ok.said("always", /no rule broken/)?.ok, true, ok.text);
    assert.ok(late.said("always", /a run breaks "Story \/ Served at once" \(spec\/serve\.md:5\) within its bound \(`within_leadsToServed = 1`\)[\s\S]*ask .*<- leadsToServed is owed from here\n.*tick .*<- the bound runs out here/), late.text);
    const longer = (delay: number) => oneRule("longer", "A bounded wait", `pure val initial: int = 0\npure def tick(n: int): int = n + 1\npure def leadsToAhead(n: int, later: int): bool = later >= n + ${delay}\npure val fair_tick = "weak"\npure val within_leadsToAhead = 21`);
    const [onTime, tooLate] = await Promise.all([run(longer(21)), run(longer(22))]);
    assert.deepEqual(onTime.failed, ["review"], onTime.text);
    assert.ok(tooLate.said("always", /within its bound \(`within_leadsToAhead = 21`\)/), tooLate.text);
  });

  test("nested set samples stay bounded and an inner lambda may shadow a match binder", async () => {
    const root = oneRule("nested", "Nested values", "type P = A({ xs: List[int] }) | B\npure def sum(p: P): int = match p { | A(x) => x.xs.foldl(0, (n, x) => n + x) | _ => 0 }\npure def lawSum(k: int): bool = sum(A({ xs: List(1, 2) })) == 3\npure def lawCount(xs: List[Set[int]]): bool = xs.length() >= 0\npure def zeros(n: int): Set[int] = Set(n * 0)\npure def lawZeros(n: int): bool = zeros(n).contains(0)");
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
  });

  test("a locally chosen enum keeps its Quint type in the generated proof", async () => {
    const root = oneRule("choice", "Choose", "type Choice = Left | Right\npure def use(c: Choice): int = if (c == Left) 1 else 2\npure def chosen(b: bool): int =\n  val c = if (b) Left else Right\n  use(c)\npure def lawChosen(b: bool): bool = chosen(b) == (if (b) 1 else 2)");
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    const record = oneRule("recordLocal", "A local record keeps its value", "pure def value(n: int): int =\n  val box = { value: n }\n  box.value");
    await gen(record, parseSpec(record, "spec/recordLocal.md"));
    assert.equal((await import(path.join(record, "gen/recordLocal.ts"))).value(7), 7);
  });

  test("a transition and its guard bind a second state-shaped parameter identically during replay", async () => {
    const root = oneRule("copy", "Copy", "pure val initial: int = 0\npure def canCopy(n: int, source: int): bool = n <= source\npure def copy(n: int, source: int): int = source\npure def alwaysNonnegative(n: int): bool = n >= 0");
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
  });

  test("a law over a reachable state is checked beyond the initial state", async () => {
    const root = fixtures(["lamp"], (f) => { f["spec/lamp.md"] += `\n### No flips\n\n${F}quint\npure def lawZero(l: Lamp): bool = l.flips == 0\n${F}\n`; });
    const { said, text } = await run(root);
    assert.equal(said("always", /^the law .* is false/)?.ok, false, text);
    assert.ok(!text.includes("the simulator could not run"), text);
  });

  test("a quint block indented inside a list is still part of the model", async () => {
    const failed = await failedStages("spec/index.md", (s) => s + "\n### Nothing is ever fine\n\n- because:\n\n  ```quint\n  pure def alwaysBogus(o: Order): bool = false\n  ```\n");
    assert.ok(failed.includes("always"), failed.join());
  });

  test("lists, nested helpers, an imported library, laws, step rules and the proof ledger work together", async () => {
    const shop = (edit?: (files: Record<string, string>) => void) => fixtures(["lib", "shop"], edit);
    const recorded = shop((f) => { f["src/count.ts"] = 'import { type Cart } from "../gen/shop.ts";\n//@ pure\nexport function count(c: Cart): number {\n  //@ ensures \\result === c.count\n  return c.count;\n}\n'; });
    const [plain, recording, wrongStep, wrongLaw, importsMachine, circle] = await Promise.all([
      run(shop()),
      run(recorded, "unproved"),
      run(shop((f) => { f["spec/shop.md"] = f["spec/shop.md"].replace("count: c.count }", "count: c.count - 1 }"); })),
      run(shop((f) => { f["spec/lib.md"] = f["spec/lib.md"].replace("total(List(n)) == n", "total(List(n)) == n + 1"); })),
      run(shop((f) => { f["spec/other.md"] = ruleSpec('import shop.* from "./shop"\npure val two = 2', "Uses a machine", "Other", "Group"); })),
      run(shop((f) => { f["spec/lib.md"] = f["spec/lib.md"].replace("pure def total", 'import shop.* from "./shop"\npure def total'); })),
    ]);
    // The nested helpers (some inside some inside every) agree between Quint and TypeScript, and simulation passes.
    assert.deepEqual(plain.failed, ["proof", "review"], plain.text);
    assert.ok(plain.said("proof", /not proved/), plain.text);
    // Once the unproved obligations are recorded, only the review is left.
    // Hand-written code proved against the shop says that it rests on what is simulated only there.
    assert.match(recording.said("proof", /^spec\/lock\.json: [1-9]\d* added, 0 removed\n/)?.detail ?? "", /^    \+ shop\.ts: /m, recording.text);
    const accepted = await run(recorded);
    assert.deepEqual(accepted.failed, ["review"], accepted.text);
    assert.ok(accepted.said("proof", /^src-count\.ts: all 1 obligations proved for all states and inputs, assuming the obligations that are simulated only \([^)]*\d+ of shop\.ts\)/), accepted.text);
    // A proof line that relies on what is simulated only lists it.
    assert.match(accepted.said("proof", /^shop\.ts: \d+ obligations, of which \d+ are simulated only \(accepted\)/)?.detail ?? "", /simulated only, accepted in spec\/lock\.json:\n\s+\w+: /, accepted.text);
    assert.match(accepted.said("proof", /^src-count\.ts: /)?.detail ?? "", /assumed from the module it is proved against, simulated only there:\n\s+(lib|shop)\.ts: \w+: /, accepted.text);
    // What was recorded is tied to the text it was recorded for: once the unit's text changes, it no longer counts.
    fs.appendFileSync(path.join(recorded, "spec/lib.md"), `\n### Two\n\n${F}quint\npure val two = 2\n${F}\n`);
    const moved = await run(recorded);
    assert.equal(moved.said("proof", /^shop\.ts: \d+ of \d+ obligations not proved; the \d+ accepted earlier were accepted for another text/)?.ok, false, moved.text);
    assert.equal(wrongStep.said("always", /^a step breaks/)?.ok, false, wrongStep.text);
    assert.equal(wrongLaw.said("always", /^the law .* is false for \{"n":/)?.ok, false, wrongLaw.text);
    assert.ok(importsMachine.said("model", /is imported under a name/), importsMachine.text);
    assert.ok(circle.said("model", /import each other in a circle/), circle.text);
  });

  test("list helpers are expanded into built-in folds, innermost first, without moving a line or touching strings and comments", () => {
    const out = expandListHelpers("pure def f(xs: List[T]): bool =\n  xs.every(t => t.ps.some(p =>\n    p == t.id))\n// xs.some(note in prose)");
    assert.equal(out.split("\n").length, 4);
    assert.ok(!/\.(every|some)\(/.test(out.split("\n").slice(0, 3).join("\n")), out);
    assert.match(out, /std_every_\d+ and/);
    assert.match(out, /std_some_\d+ or/);
    assert.match(out, /\/\/ xs\.some\(note in prose\)$/);
    const kept = expandListHelpers('pure val note = "xs.some(y)" // xs.every(z)\npure def f(xs: List[int]): bool = xs.some(x => x > 0)');
    assert.ok(kept.includes('"xs.some(y)" // xs.every(z)'), kept);
    assert.match(kept, /xs\.foldl\(false, \(std_some_\d+, x\)/);
    assert.throws(() => expandListHelpers("pure def f(xs: List[int]): bool = xs.every(x => x > 0 // oops"), /no closing parenthesis/);
  });

  test("a state whose stages carry different data, with match and sets, is simulated, replayed, fully proved and parsed", async () => {
    const root = fixtures(["parcel"]);
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^parcel\.ts: all \d+ obligations proved/), text);
    assert.match(fs.readFileSync(path.join(root, "gen/parcel.ts"), "utf8"), /\| \{ tag: "Shipped"; weight: number; labels: string\[\]; hops: number \}/);
    const parcel = await import(path.join(root, "gen/parcel.ts"));
    assert.deepEqual(parcel.parseState({ tag: "Packed", weight: 1, labels: ["fragile"] }), { tag: "Packed", weight: 1, labels: ["fragile"] });
    for (const x of [{ tag: "Packed", weight: 1, labels: ["a", "a"] }, { tag: "Lost", weight: 1 }, { tag: "Shipped", weight: 1, labels: [], hops: -1 }, { tag: "Gone" }])
      assert.equal(parcel.parseState(x), undefined, JSON.stringify(x));
  });

  test("a machine built from a component states and proves a rule that spans two of them", async () => {
    const { failed, said, text } = await run(fixtures(["account", "bank"]));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("model", /^spec\/bank\.md: 2 transitions, 1 always, 1 step, 1 sometimes/), text);
  });

  test("a machine is simulated with the sample sets of the specs it imports", async () => {
    // Every amount the account offers is more than the bank's current account holds, so nothing can ever be saved.
    const { failed, said, text } = await run(fixtures(["account", "bank"], (f) => { f["spec/account.md"] = f["spec/account.md"].replace("type Account", "pure val amountValues = Set(7)\ntype Account"); }));
    assert.ok(failed.includes("sometimes"), text);
    assert.ok(said("sometimes", /\bsave in .* never happened/), text);
  });

  test("tables keyed by integers and variants, getOr, nthOr, removeAt, structural == and a mapped append are simulated, replayed and proved", async () => {
    const root = fixtures(["hall"]);
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^hall\.ts: all \d+ obligations proved/), text);
    const hall = await import(path.join(root, "gen/hall.ts"));
    // A seat equal to a booked one, though another object, is booked already.
    const booked = hall.step(hall.initial, { type: "book", row: 1, kind: "Adult" });
    assert.equal(hall.enabled(booked, { type: "book", row: 1, kind: "Adult" }), false);
    assert.deepEqual(hall.parseState(booked), { booked: [{ row: 1, kind: "Adult" }], byRow: { 1: 1 }, byKind: { Adult: 1 } });
    for (const x of [{ ...booked, byRow: { "01": 1 } }, { ...booked, byRow: { $1: 1 } }, { ...booked, byKind: { Senior: 1 } }])
      assert.equal(hall.parseState(x), undefined, JSON.stringify(x));
  });

  test("one machine uses another under a name, keeps its rules, and adds rules about the pair", async () => {
    const { failed, said, text } = await run(fixtures(["lamp", "room"]));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^room\.ts: all \d+ obligations proved/), text);
  });

  test("a map is looked up safely, division and remainder agree with Quint for negative numbers, and the parsers admit only what fits", async () => {
    const root = fixtures(["stock"]);
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["proof", "review"], text);
    assert.ok(said("replay", /every law, and \d+ definitions/)?.ok, text);
    const proof = said("proof", /^stock\.ts:/);
    assert.ok(proof, text);
    assert.doesNotMatch(`${proof.summary}\n${proof.detail}`, /lawBoxesAndLooseMakeTheWhole/, "the division law is proved, so it is not listed as unproved");
    const stock = await import(path.join(root, "gen/stock.ts"));
    // A map key that every object has, a getter on an event, and an extra field are all harmless.
    const received = stock.step(stock.initial, stock.parseEvent({ type: "receive", sku: "constructor", qty: 1 }));
    assert.equal(stock.level(received, "constructor"), 1);
    assert.equal(stock.level(received, "toString"), 0);
    let reads = 0;
    assert.deepEqual(stock.parseEvent({ type: "receive", sku: "a", get qty() { return reads++ ? 1000 : 2; }, extra: 1 }), { type: "receive", sku: "a", qty: 2 });
    assert.equal(stock.parseEvent({ type: "receive", sku: "a", qty: 1.5 }), undefined);
    // parseState admits exactly a value with the state's shape that keeps every rule, as a fresh copy.
    const kept = { levels: { $a: 2 }, known: ["a"] };
    const parsed = stock.parseState(kept);
    assert.deepEqual(parsed, kept);
    assert.ok(parsed !== kept && parsed.levels !== kept.levels, "a fresh copy");
    assert.equal(stock.level(parsed, "a"), 2);
    const refused = [
      undefined, null, "state", [], { levels: { a: 2 }, known: ["a"] }, { levels: { $a: 1.5 }, known: ["a"] }, { levels: [], known: [] },
      { ...kept, extra: 1 }, { levels: { $a: -1 }, known: ["a"] }, // the last has the right shape but breaks alwaysNoLevelIsNegative
    ];
    for (const x of refused) assert.equal(stock.parseState(x), undefined, JSON.stringify(x));
  });

  test("replay notices TypeScript that disagrees with Quint, in a step or in a definition", async () => {
    const root = copyOfProject();
    const model = await gen(root, parseSpec(root, "spec/index.md"));
    const domain = await import(path.join(root, "gen/index.ts"));
    const trace = [{ state: domain.initial }, ...[{ type: "addItem", qty: 1 }, { type: "submit" }, { type: "pay", amount: 2 }]
      .map((event, i, all) => ({ event, state: all.slice(0, i + 1).reduce(domain.step, domain.initial) }))];
    replay(domain, trace);
    const broken = { ...domain, step: (s: any, e: any) => (e.type === "pay" ? { ...domain.step(s, e), status: "Paid" } : domain.step(s, e)) };
    assert.throws(() => replay(broken, trace), /TypeScript and Quint disagree/);
    assert.ok(model.evals.some((v) => v.name === "canSubmit"), "guards are among the definitions compared");
    const evaluated = (result: boolean) => [{ state: domain.initial }, { evaluated: { name: "canSubmit", picks: {}, result } }];
    replay(domain, evaluated(false), model);
    assert.throws(() => replay(domain, evaluated(true), model), /disagree on canSubmit/);
    assert.throws(() => replay({ ...domain, canSubmit: () => true }, evaluated(false), model), /disagree on canSubmit/);
  });

  test("a rule heading cannot become code", async () => {
    const { said, text } = await run(oneRule("counter", "A counter */ globalThis.INJECTED = true; /* starts at zero", "pure val initial: int = 0\npure def bump(n: int): int = n + 1"));
    assert.equal((globalThis as any).INJECTED, undefined, "the heading ran as code");
    assert.ok(said("replay", /agrees with Quint/)?.ok, text);
  });

  test("a proof cannot be forged from inside the project", async () => {
    const withFile = (file: string, text: string) => {
      const root = copyOfProject("spec/index.md", notInductive);
      fs.writeFileSync(path.join(root, file), text);
      return root;
    };
    const unproved = /^index\.ts: \d+ of \d+ obligations not proved/;
    const tsconfigured = withFile("tsconfig.json", `{"compilerOptions":{"noLib":true,"types":["missing"]},"files":["missing.ts"]}`);
    const lookalike = copyOfProject("src/ledger.ts", (s) => s.replace('"../gen/index.ts"', '"./index.ts"'));
    fs.writeFileSync(path.join(lookalike, "src/index.ts"), 'export * from "../gen/index.ts";\n');
    const [namesake, configured, ownConfig, sneaky, lying, disguised] = await Promise.all([
      run(withFile("src/index.ts", ONE)),
      run(withFile("lemmascript.json", `{"proof-dir":"proofs"}`)),
      run(tsconfigured),
      run(copyOfProject("src/ledger.ts", (s) => s.replace("return order.due - order.paid;", "/* x */ //@ assume false\n  return order.paid - order.due;"))),
      run(copyOfProject("src/ledger.ts", (s) => s.replace("\nexport function replay", '\n  import { owed } from "/tmp/lies.ts";\nexport function replay'))),
      run(lookalike),
    ]);
    // A file in src/ named after the spec does not take the place of the spec's own proof.
    assert.ok(namesake.said("proof", unproved), namesake.text);
    // A LemmaScript configuration in the project cannot point the proof at files someone could edit.
    assert.ok(configured.said("proof", unproved), configured.text);
    // Nor can the project's tsconfig.json add files, globals or options to the proof: each unit has its own.
    assert.ok(ownConfig.said("proof", unproved), ownConfig.text);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tsconfigured, "gen/proof/index/tsconfig.json"), "utf8")).files, ["index.ts"]);
    // An annotation that asks the prover for trust is refused wherever it sits on the line.
    assert.ok(sneaky.said("proof", /`\/\/@ assume` is not allowed/), sneaky.text);
    // So is an import of anything but a generated module, however it is indented, or of a look-alike of one.
    assert.ok(lying.said("proof", /may only import generated modules/), lying.text);
    assert.deepEqual(disguised.failed, ["proof"], disguised.text);
    assert.ok(disguised.said("proof", /may only import generated modules/), disguised.text);
  });

  test("a law that needs induction is proved by a proof file, and only then offered to the spec that imports it", async () => {
    const project = (edit: (f: Record<string, string>) => void = () => {}) => fixtures(["highest", "ticket"], edit);
    const root = project();
    const [bare, proved, unoffered, trusting] = await Promise.all([
      run(project((f) => { delete f["spec/highest.proof.dfy"]; delete f["spec/ticket.proof.dfy"]; f["spec/typo.proof.dfy"] = ""; })),
      run(root),
      run(project((f) => { delete f["spec/highest.proof.dfy"]; })),
      run(project((f) => { f["spec/highest.proof.dfy"] = f["spec/highest.proof.dfy"].replace("ProofLib.FoldLeftMax", "assume false;\n  ProofLib.FoldLeftMax"); })),
    ]);
    // Without a proof file the law is not proved, and a proof file that belongs to nothing is pointed out.
    assert.equal(bare.said("proof", /^highest\.ts: 1 of 1 obligations not proved/)?.ok, false, bare.text);
    assert.equal(bare.said("proof", /^spec\/typo\.proof\.dfy belongs to no proof unit/)?.ok, false, bare.text);
    // With both proof files, everything proves, and the final Dafny is there to read.
    assert.deepEqual(proved.failed, ["review"], proved.text);
    assert.ok(proved.said("proof", /^ticket\.ts: all 3 obligations proved/), proved.text);
    assert.match(fs.readFileSync(path.join(root, "gen/proof/ticket/ticket.dfy"), "utf8"), /lemma \{:axiom\} highest_lawTheHighestIsAtLeastTheStart_ensures/);
    // A law its own unit does not prove is not offered.
    assert.equal(unoffered.said("proof", /^ticket\.ts: Dafny could not check it[\s\S]*unresolved identifier: highest_lawTheHighestIsAtLeastTheStart_ensures/)?.ok, false, unoffered.text);
    // A proof file that asks for trust is refused, with its file and line.
    assert.equal(trusting.said("proof", /spec\/highest\.proof\.dfy:4: `assume` is not allowed/)?.ok, false, trusting.text);
  });

  test("a proof file may only add lemmas, and only bodies to the generated ones; a body is the brace group that ends a lemma, after a complete header", () => {
    const refused: [string, string, RegExp][] = [
      ["a block comment", "lemma A() { /* } */ }", /block comments are not allowed/],
      ["an @-attribute", "@Axiom\nlemma A() {}", /p\.dfy:1: `@` is not allowed/],
      ["the axiom attribute", "lemma {:axiom} A() ensures false {}", /the attribute \{:axiom\} is not allowed/],
      ["an attribute with spaces", "lemma A() { assert { : verify false } true; }", /the attribute \{:verify\} is not allowed/],
      ["a character literal", "lemma A() { var c := 'a'; }", /character literals are not allowed/],
      ["assume", "lemma A()\n  ensures false\n{\n  assume false;\n}", /p\.dfy:4: `assume` is not allowed/],
      ["a function", "function F(): int { 1 }", /`function` is not allowed/],
      ["a predicate", "lemma A() {}\npredicate P() { true }", /p\.dfy:2: `predicate` is not allowed/],
      ["an include", 'include "other.dfy"', /`include` is not allowed/],
      ["a module", "module M {}", /`module` is not allowed/],
      ["expect", "lemma A() { expect false; }", /`expect` is not allowed/],
      ["reads", "lemma A() reads {} {}", /`reads` is not allowed/],
      ["a lemma with no body", "lemma A() ensures false", /lemma A has no body/],
      ["an unclosed body", "lemma A() { if true { }", /unbalanced braces/],
      ["a brace that closes nothing", "lemma A() { } }", /this \} closes nothing/],
      ["anything else at the top level", "assert false;", /only `lemma` declarations/],
      ["a lemma declared twice", "lemma A() {}\nlemma A() {}", /declared twice/],
      ["a carriage return that would end a comment early", "lemma A() { // note\rassume false;\n}", /line breaks other than/],
      ["a string that is not closed", 'lemma A() { var s := "x; }', /not closed/],
      ["a NUL character", "lemma A() { }\0", /p\.dfy:1: NUL characters are not allowed/],
      ["decreases with a set display", "lemma Bad() ensures false decreases {0}\nlemma B() { Bad(); }", /p\.dfy:1: lemma Bad has no body/],
      ["ensures with a set display", "lemma Bad(x: int) ensures x in {1}", /p\.dfy:1: lemma Bad has no body/],
      ["a multiset display", "lemma Bad(x: int) ensures x in multiset{1}", /p\.dfy:1: lemma Bad has no body/],
      ["a body followed by more", "lemma A() { } ensures false", /p\.dfy:1: lemma A has no body/],
    ];
    for (const [what, text, message] of refused) assert.throws(() => parseProofFile(text, "p.dfy"), message, what);
    assert.equal(parseProofFile("lemma Ok(s: set<int>) ensures s == {} ==> |s| == 0 ensures 1 in {1} { assert true; }", "p.dfy")[0].body.trim(), "assert true;");
    assert.equal(parseProofFile("// a comment\nlemma A(xs: seq<int>)\n  ensures forall i {:trigger xs[i]} :: 0 <= i < |xs| ==> xs[i] == xs[i]\n{\n  reveal F();\n  calc { 1; 1; }\n  forall i | 0 <= i < |xs| ensures xs[i] == xs[i] {}\n  assert true by { var x := 1; if x > 0 { } match xs { case _ => } }\n}\n", "p.dfy").length, 1);

    const spliced = (text: string) => splice(GENERATED_F, { proof: { file: "p.dfy", text }, axioms: [] }).dfy;
    // A body goes inside the generated lemma; a helper is appended; nothing generated changes.
    const out = spliced("lemma f_ensures(x: int)\n  ensures (f(x) >= x)   // spacing and comments do not matter\n{\n  Helper(x);\n}\nlemma Helper(x: int) ensures f(x) == x { }\n");
    assert.ok(out.startsWith(GENERATED_F.replace("{\n}\n", "{\n  Helper(x);\n}\n")), out);
    assert.match(out, /lemma Helper\(x: int\)/);
    // A header that no longer matches the generated one is stale.
    assert.throws(() => spliced("lemma f_ensures(x: int)\n  requires x > 0\n  ensures (f(x) >= x)\n{\n}\n"), /p\.dfy:1: lemma f_ensures does not repeat its generated header, so it is refused as stale/);
    // A helper may not take a generated name, or the library's.
    assert.throws(() => spliced("lemma f(x: int) { }"), /p\.dfy:1: lemma f: the name is already declared/);
    assert.throws(() => spliced("lemma ProofLib() { }"), /the name is already declared/);
  });

  test("an obligation that fails is not assumed while the others are checked", async () => {
    const { said, text } = await run(fixtures(["twins"]));
    const found = said("proof", /^twins\.ts: 3 of 4 obligations not proved/);
    assert.equal(found?.ok, false, text);
    assert.match(found!.detail, /alwaysBIsAtMostThreeOrNinetyNine/);
    // The tools' step body calls the transition's lemma, so step rests on what that lemma does not prove.
    assert.match(found!.detail, /step: inv\(step\(current, event\)\)   \[rests on bump: /);
  });

  test("verified code in a subdirectory of src is proved too", async () => {
    const root = copyOfProject("src/deep/owed.ts", () => 'import { type Order } from "../../gen/index.ts";\n//@ pure\nexport function owed(o: Order): number {\n  //@ ensures \\result > 0\n  return o.due - o.paid;\n}\n');
    const { failed } = await run(root);
    assert.deepEqual(failed, ["proof", "review"]); // and its contract is new
    fs.renameSync(path.join(root, "src/deep/owed.ts"), path.join(root, "src/deep/source.txt"));
    fs.symlinkSync("source.txt", path.join(root, "src/deep/owed.ts"));
    assert.deepEqual((await run(root)).failed, ["proof", "review"]);
  });

  test("hand-written logic that breaks its contract is caught by the proof", async () => {
    const failed = await failedStages("src/ledger.ts", (s) => s.replace("return order.due - order.paid;", "return order.paid - order.due;"));
    assert.deepEqual(failed, ["proof", "tests"]);
  });

  test("moving a line break so that a comment swallows half a guard is a change to the model", async () => {
    const failed = await failedStages("spec/index.md", (s) => s.replace("pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 and o.units + qty <= maxUnits",
      "pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 // and o.units + qty <= maxUnits"));
    assert.ok(failed.includes("review"), failed.join());
  });

  test("init preserves local instructions and refreshes its marked procedure", () => {
    const root = scratch({ "AGENTS.md": "mine\n", "package.json": `{"scripts":{"check":"mine"}}` });
    const added = init(root);
    const agents = path.join(root, "AGENTS.md");
    const expected = `mine\n\n<!-- vibestack:start -->\n${read("AGENTS.md").trim()}\n<!-- vibestack:end -->\n`;
    assert.equal(fs.readFileSync(agents, "utf8"), expected);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts.check, "mine");
    assert.ok(["sync", "design"].every((s) => fs.existsSync(path.join(root, `.claude/skills/${s}/SKILL.md`))) && added.includes("tsconfig.json"), added.join());
    assert.match(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /^@AGENTS\.md$/m);
    assert.deepEqual(init(root), []);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "My existing instructions.\n");
    init(root);
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "My existing instructions.\n\n@AGENTS.md\n");
    assert.equal(fs.readFileSync(agents, "utf8"), expected);
    assert.deepEqual(init(root), []);
    for (const marker of ["onespec", "vibestack"]) {
      fs.writeFileSync(agents, `before\r\n<!-- ${marker}:start -->\r\nold instructions\r\n<!-- ${marker}:end -->\r\nafter\r\n`);
      init(root);
      assert.equal(fs.readFileSync(agents, "utf8"), `before\r\n<!-- vibestack:start -->\r\n${read("AGENTS.md").trim().replace(/\r?\n/g, "\r\n")}\r\n<!-- vibestack:end -->\r\nafter\r\n`);
      assert.deepEqual(init(root), []);
    }
    for (const invalid of [
      "<!-- vibestack:start -->\nincomplete\n",
      "<!-- vibestack:end -->\n<!-- vibestack:start -->\n",
      "<!-- vibestack:start -->\n<!-- vibestack:end -->\n<!-- vibestack:start -->\n<!-- vibestack:end -->\n",
    ]) {
      fs.writeFileSync(agents, invalid);
      assert.throws(() => init(root), /repair.*markers/);
      assert.equal(fs.readFileSync(agents, "utf8"), invalid);
    }
  });

  test("init sets a package up for a VibeLang shell: compiler and test runner configuration, scripts, the pinned toolchain with one Effect; what the package already has is kept, and a second run adds nothing", () => {
    const json = (root: string, file: string) => JSON.parse(read(file, root));
    const pins: Record<string, string> = { ...json(project, "package.json").dependencies, ...json(project, "package.json").devDependencies };
    const pinned = (...names: string[]) => Object.fromEntries(names.map((n) => [n, pins[n]]));
    const [runtime, tooling] = [["effect", "@effect/platform-node", "vibelang-runtime"], ["vibelang", "vibelang-vite", "vite", "vitest", "@effect/vitest", "@types/node"]];
    // VibeLang's packages move together, and with one version of Effect: each is pinned exactly.
    for (const name of [...runtime, ...tooling].filter((n) => n !== "@types/node")) assert.match(pins[name], /^\d+\.\d+\.\d+$/, name);
    // A workspace's `catalog:` means nothing in the package `init` writes it into.
    assert.match(pins["@types/node"], /^\^\d+\.\d+\.\d+$/);
    const one = { "@effect/platform-node-shared": pins["@effect/platform-node"] };
    const scripts = { dev: "spec studio", check: "spec check", gen: "spec gen", accept: "spec accept", build: "vibelang", test: "vitest run" };

    const fresh = scratch({ "package.json": '{"name":"fresh"}' });
    assert.deepEqual(init(fresh), [".claude/skills/sync/SKILL.md", ".agents/skills/sync", ".claude/skills/design/SKILL.md", ".agents/skills/design", "AGENTS.md (Vibestack instructions)", "CLAUDE.md (imports AGENTS.md)",
      "tsconfig.json", "vitest.config.ts", "spec/index.md", ".gitignore", "package.json scripts: dev, check, gen, accept, build, test",
      `package.json VibeLang toolchain: ${[...runtime, ...tooling].join(", ")} (run your package manager's install)`, 'package.json "type": "module"']);
    assert.deepEqual(json(fresh, "tsconfig.json"), {
      compilerOptions: { target: "es2023", module: "nodenext", strict: true, skipLibCheck: true, types: ["node"], rootDir: ".", rootDirs: [".", ".vibe/declarations"], outDir: "dist", noEmitOnError: true, rewriteRelativeImportExtensions: true },
      include: ["src", "test", "gen/*.ts", "gen/*.vibe"], vibe: { sidecarDir: ".vibe/declarations" },
    });
    assert.equal(read("vitest.config.ts", fresh), 'import vibelang from "vibelang-vite";\nimport { defineConfig } from "vitest/config";\n\nexport default defineConfig({ plugins: [vibelang()], test: { include: ["test/**/*.test.vibe"], passWithNoTests: true, testTimeout: 60_000 } });\n');
    assert.equal(read(".gitignore", fresh), "gen/\n.spec-cache/\n.studio/\ndist/\n.vibe/\n");
    assert.deepEqual(json(fresh, "package.json"), {
      name: "fresh", type: "module", scripts, engines: { node: "^22.22.3 || >=24.11.1" },
      dependencies: pinned(...runtime), devDependencies: pinned(...tooling), overrides: one, pnpm: { overrides: one },
    });
    assert.deepEqual(init(fresh), []);

    // The placeholder `npm init` writes is no test script; a script, a dependency, an override or an ignored path already there stays.
    const own = { name: "own", type: "module", scripts: { build: "mine", test: 'echo "Error: no test specified" && exit 1' }, engines: { node: ">=26" },
      dependencies: { effect: "mine" }, devDependencies: { vitest: "mine" }, overrides: { "@effect/platform-node-shared": "mine" }, pnpm: { overrides: { other: "mine" } } };
    const kept = scratch({ "package.json": JSON.stringify(own), "tsconfig.json": "{}\n", "vitest.config.ts": "export default {};\n", ".gitignore": "dist/\n" });
    const added = init(kept);
    assert.deepEqual(added.filter((a) => /^(package\.json|tsconfig|vitest|\.gitignore)/.test(a)), [".gitignore", "package.json scripts: dev, check, gen, accept, test",
      `package.json VibeLang toolchain: ${[...runtime, ...tooling].filter((n) => n !== "effect" && n !== "vitest").join(", ")} (run your package manager's install)`]);
    assert.deepEqual([read("tsconfig.json", kept), read("vitest.config.ts", kept), read(".gitignore", kept)], ["{}\n", "export default {};\n", "dist/\ngen/\n.spec-cache/\n.studio/\n.vibe/\n"]);
    assert.deepEqual(json(kept, "package.json"), {
      ...own, scripts: { ...scripts, build: "mine" }, dependencies: { ...pinned(...runtime), effect: "mine" }, devDependencies: { ...pinned(...tooling), vitest: "mine" },
      pnpm: { overrides: { ...one, other: "mine" } },
    });
    assert.deepEqual(init(kept), []);
  });

  test("nested specs link to children and reuse a machine through its directory index", async () => {
    const root = scratch({
      "spec/index.md": "# Home\n\n[Room](./rooms/)\n[Other lamp](./other/light/index.md)\n",
      "spec/rooms/index.md": read("vibestack/fixtures/room.md").replace('import lamp as L from "./lamp"', 'import /* from "wrong" */ lamp\n  from\n  "./light"').replaceAll("L::", "lamp::"),
      "spec/rooms/light/index.md": read("vibestack/fixtures/lamp.md"),
      "spec/rooms/light/index.proof.dfy": "",
      "spec/other/light/index.md": read("vibestack/fixtures/lamp.md"),
      "src/app.ts": `// ${"spec/rooms/index.md"}, ${JSON.stringify("Story: Light a room")}\nexport { initial, step } from "../gen/rooms.ts";\n`,
    });
    const specs = readSpecs(root);
    assert.deepEqual(specs.find((s) => s.name === "index")?.links, ["spec/rooms/index.md", "spec/other/light/index.md"]);
    assert.deepEqual(specs.find((s) => s.name === "rooms")?.imports, ["rooms__light"]);
    assert.equal(specs.find((s) => s.name === "rooms")?.uses[0].alias, "lamp");
    assert.deepEqual(danglingCitations(root, specs), []);
    const first = await run(root, "reviews");
    assert.deepEqual(first.failed, [], first.text);
    assert.ok(first.said("proof", /^rooms\.ts: all \d+ obligations proved/), first.text);
    const room = await import(path.join(root, "gen/rooms.ts"));
    const lit = room.step(room.step(room.initial, { type: "toggleLeft" }), { type: "toggleRight" });
    assert.equal(room.sometimesFullyLit(lit), true);
    assert.equal(room.inv(lit), true);
    assert.ok(fs.existsSync(path.join(root, "gen/other__light.ts")));
    const { conformance } = await import(path.join(root, "gen/rooms.conformance.ts"));
    await assert.rejects(conformance({
      reset: () => {},
      dispatch: () => "refused",
      observe: () => room.initial,
    }, { walks: 0 }), /conformance to spec\/rooms\/index\.md:/);
    fs.appendFileSync(path.join(root, "spec/rooms/light/index.md"), `\n${F}quint\npure val label = "lamp"\n${F}\n`);
    const changed = readSpecs(root);
    assert.ok(pending(root, changed.find((s) => s.name === "rooms")!, changed).some((p) => p.note?.includes("spec/rooms/light/index.md")));
  });

  test("nested spec paths refuse missing links, escaped targets, duplicate modules, cycles and symlinks", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ "spec/index.md": "[Missing](./missing/)\n" }, /no spec at this path/],
      [{ "spec/index.md": "[Outside](../outside.md)\n", "outside.md": "" }, /stay within spec/],
      [{ "spec/index.md": "[Outside](..%2Foutside.md)\n", "outside.md": "" }, /stay within spec/],
      [{ "spec/index.md": "", "spec/room.md": "", "spec/room/index.md": "" }, /same module name/],
      [{ "spec/index.md": "", "spec/a/index.md": ruleSpec('import b.* from "../b"', "Import", "A"),
        "spec/b/index.md": ruleSpec('import a.* from "../a"', "Import", "B") }, /circle/],
    ];
    for (const [files, error] of cases) assert.throws(() => readSpecs(scratch(files)), error);
    const root = scratch({ "spec/index.md": "", "outside.md": "" });
    fs.symlinkSync(path.join(root, "outside.md"), path.join(root, "spec/linked.md"));
    assert.throws(() => readSpecs(root), /symbolic links/);
  });

  test("one lock preserves migrated reviews, contracts and proof acceptance and records deleted specs", async () => {
    const root = fixtures(["door"]);
    for (const spec of readSpecs(root)) acceptReviews(root, spec);
    const proof = { door: { text: "previously-reviewed", unproved: ["an obligation"] } };
    writeLedger(root, proof);
    const lockPath = path.join(root, "spec/lock.json");
    const before = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    before.contracts["src/old.ts"] = "old-contract";
    fs.writeFileSync(path.join(root, "spec/door.lock.json"), JSON.stringify(before.specs["spec/door.md"]));
    fs.writeFileSync(path.join(root, "spec/src.lock.json"), JSON.stringify(before.contracts));
    fs.writeFileSync(path.join(root, "spec/unproved.lock.json"), JSON.stringify(before.unproved));
    fs.rmSync(lockPath);
    assert.deepEqual(migrateLocks(root), ["spec/door.lock.json", "spec/src.lock.json", "spec/unproved.lock.json"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), before);
    assert.deepEqual(readLedger(root), proof);
    assert.deepEqual(pending(root, readSpecs(root)[0]), []);
    assert.equal(fs.existsSync(path.join(root, "spec/door.lock.json")), false);
    fs.rmSync(path.join(root, "spec/door.md"));
    fs.writeFileSync(path.join(root, "spec/index.md"), "");
    assert.deepEqual(pendingSpecs(root, readSpecs(root)).map((p) => p.where), ["spec/door.md"]);
    const removed = await run(root, "reviews");
    assert.deepEqual(removed.failed, [], removed.text);
    const after = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.deepEqual(Object.keys(after.specs), ["spec/index.md"]);
    assert.deepEqual(pendingSpecs(root, readSpecs(root)), []);
    assert.deepEqual(after.contracts, {});
    assert.deepEqual(after.unproved, proof);
    fs.mkdirSync(path.join(root, "spec/child"));
    fs.writeFileSync(path.join(root, "spec/child/index.md"), "");
    fs.writeFileSync(path.join(root, "spec/index.md"), "# Home\n\n[Child](./child/)\n");
    assert.deepEqual((await run(root, "reviews")).failed, []);
    fs.writeFileSync(path.join(root, "spec/index.md"), "# Home\n\n[Open child](./child/)\n");
    const linked = readSpecs(root);
    assert.ok(pending(root, linked.find((s) => s.name === "index")!, linked).some((p) => p.status === "document changed"));
    assert.deepEqual((await run(root, "reviews")).failed, []);
    assert.deepEqual(pending(root, readSpecs(root).find((s) => s.name === "index")!), []);
  });

  test("malformed unified review records fail before checks can accept them", async () => {
    const root = scratch({ "spec/index.md": "", "spec/lock.json": JSON.stringify({ version: 1, specs: { "spec/index.md": { invalid: false } }, contracts: {}, unproved: {} }) });
    const before = fs.readFileSync(path.join(root, "spec/lock.json"), "utf8");
    const result = await run(root, "reviews");
    assert.deepEqual(result.failed, ["model"], result.text);
    assert.match(result.text, /invalid review records/);
    assert.equal(fs.readFileSync(path.join(root, "spec/lock.json"), "utf8"), before);
  });

  test("the package's own test script is what runs, never the check itself; without one Node runs test/**/*.test.ts and says that nothing runs a VibeLang test; a citation of a heading the spec does not have is caught, in a .vibe file as in a test, and never in what the compiler wrote for one", async () => {
    // The manifest keeps its name: the compiler derives the key of a service in src/ from it.
    const manifest = (scripts: Record<string, string>) => JSON.stringify({ ...JSON.parse(PACKAGE["package.json"]), scripts });
    const root = copyOfProject("package.json", () => manifest({ test: `node ${JSON.stringify(path.join(project, "vibestack/spec.ts"))} check` }));
    const again = await run(root);
    assert.deepEqual(again.failed, ["tests"], again.text);
    assert.ok(again.said("tests", /a test script cannot run spec check or accept: the check already runs the tests/), again.text);
    // A test script may check another project, as a tool's journey tests do: only its own project's lock is held.
    const other = fixtures(["door"]);
    fs.writeFileSync(path.join(root, "package.json"), manifest({ test: `cd ${JSON.stringify(other)} && node ${JSON.stringify(path.join(project, "vibestack/spec.ts"))} check --json > /dev/null; test -f gen/door.ts` }));
    const elsewhere = await run(root);
    assert.ok(elsewhere.said("tests", /^pass/), elsewhere.text);
    fs.writeFileSync(path.join(root, "package.json"), manifest({}));
    const cite = (heading: string) => `// spec/index.md, ${JSON.stringify(heading)}\n`;
    const cites = ["Story: Check out", "Only a non-empty draft can be submitted", "Refunds are instant"].map(cite).join("");
    fs.mkdirSync(path.join(root, "test/journeys"), { recursive: true });
    // Node's runner loads the shell the journey imports only through VibeLang's loader.
    fs.writeFileSync(path.join(root, "test/journeys/checkout.test.ts"), `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { noted } from "../../src/notes.vibe";\n${cites}test("a journey", () => assert.ok(noted));\n`);
    fs.writeFileSync(path.join(root, "src/notes.vibe"), `${cite("Story: Check out")}${cite("Refunds are final")}export const noted = true\n`);
    // What the compiler writes for notes.vibe is its output, not the package's code, wherever it lands.
    fs.writeFileSync(path.join(root, "src/notes.d.vibe.ts"), `${cite("Refunds are final")}export declare const noted: boolean;\n`);
    const dangling = [["src/notes.vibe:2", "Refunds are final"], ["test/journeys/checkout.test.ts:6", "Refunds are instant"]].map(([at, heading]) => `${at}  ${cite(heading).slice(3, -1)}`);
    assert.deepEqual(danglingCitations(root, readSpecs(root)), dangling);
    const { failed, text, said } = await run(root);
    assert.deepEqual(failed, ["tests"], text);
    assert.equal(said("tests", /^2 citations name no story or rule of the spec\n/)?.detail, dangling.map((d) => `      ${d}`).join("\n"), text);
    assert.equal(said("tests", /^test\/app\.test\.vibe: a VibeLang test, and the package has no `test` script to run it/)?.ok, false, text);
    assert.ok(said("tests", /^pass\n$/), text);
  });

  test("a conformance driver that asks the Effect adapter of the generated oracle is refused, though it may name a typed failure", async () => {
    const { said, text } = await run(copyOfProject("test/app.test.vibe", (s) => s.replace("import { type Event, Rejected }", "import { type Event, Rejected, apply, initial }")
      .replace("app.runPromise(outcome(id, event))", 'app.runPromise(Effect.match(apply(initial, event), { onSuccess: () => "accepted" as const, onFailure: (error) => (error instanceof Rejected ? "refused" as const : "accepted" as const) }))')));
    assert.match(said("tests", /^conformance drivers must reach the application, not call the generated oracle\n/)?.detail ?? "",
      /^ +test\/app\.test\.vibe:(\d+): driver uses generated apply\n +test\/app\.test\.vibe:\1: driver uses generated initial$/, text);
  });

  test("nothing stale survives in gen/", async () => {
    const root = copyOfProject();
    fs.mkdirSync(path.join(root, "gen"), { recursive: true });
    for (const stale of ["renamed.ts", "renamed.effect.vibe"]) fs.writeFileSync(path.join(root, "gen", stale), "export const stale = true;\n");
    await check(root);
    // index.effect.vibe.pure.d.ts is the VibeLang compiler's: the declarations of the adapter's `module pure` body.
    assert.deepEqual(fs.readdirSync(path.join(root, "gen")).filter((f) => /\.(ts|vibe)$/.test(f)).sort(),
      ["_conformance.ts", "index.conformance.ts", "index.effect.vibe", "index.effect.vibe.pure.d.ts", "index.ts"]);
  });

  test("a truncated cache entry is recomputed and generated modules run in a CommonJS project", async () => {
    const root = fixtures(["door"], (f) => { f["package.json"] = '{"type":"commonjs"}'; });
    const before = await run(root);
    assert.deepEqual(before.failed, ["review"], before.text);
    const cache = path.join(root, ".spec-cache");
    const entries = fs.readdirSync(cache).filter((f) => f.endsWith(".json"));
    assert.ok(entries.length > 0);
    for (const entry of entries) fs.writeFileSync(path.join(cache, entry), "{");
    const after = await run(root);
    assert.deepEqual(after.failed, ["review"], after.text);
    for (const entry of fs.readdirSync(cache).filter((f) => f.endsWith(".json"))) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(cache, entry), "utf8")));
  });

  test("changing an imported definition invalidates model and simulation results", async () => {
    const wrap = (quint: string) => ruleSpec(quint, "Price", "Library", "Values");
    const root = libAndUse(wrap("pure val price = 1"), wrap('import lib.* from "./lib"\npure def lawPrice(k: int): bool = price == 1'));
    const first = await run(root);
    assert.deepEqual(first.failed, ["review"], first.text);
    fs.writeFileSync(path.join(root, "spec/lib.md"), wrap("pure val price = 2"));
    const after = await run(root);
    assert.equal(after.said("always", /the law .* is false/)?.ok, false, after.text);
  });

  test("proof caching follows library changes and compiler failure waits for proof completion", async () => {
    const root = toolchain(fixtures(["highest"], (f) => { f["package.json"] = '{"type":"module"}'; }), "quint", "lsc");
    const script = path.join(root, "vibestack/spec.ts");
    const first = await runCli(script, root, "check", "--json");
    const checked = JSON.parse(first.stdout);
    assert.ok(checked.results.some((r: Result) => r.stage === "proof" && r.ok), first.stdout + first.stderr);
    const marker = "// A distinct proof-library version for this scratch project.";
    fs.appendFileSync(path.join(root, "vibestack/proof/lib.dfy"), `\n${marker}\n`);
    const second = await runCli(script, root, "check", "--json");
    const again = JSON.parse(second.stdout);
    assert.ok(again.results.some((r: Result) => r.stage === "proof" && r.ok), second.stdout + second.stderr);
    assert.ok(fs.readFileSync(path.join(root, "gen/proof/highest/highest.dfy"), "utf8").includes(marker));
    fs.writeFileSync(path.join(root, "tsconfig.json"), '{"compilerOptions":{"noEmit":true},"include":["gen/*.ts"]}');
    if (process.platform !== "win32") {
      const compiler = path.join(root, "node_modules/.bin/vibelang");
      fs.writeFileSync(compiler, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(compiler, 0o644);
    }
    fs.appendFileSync(path.join(root, "spec/highest.proof.dfy"), "// Recheck the proof beside the failed compiler.\n");
    const failed = await runCli(script, root, "check", "--json");
    const result = JSON.parse(failed.stdout);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.ok(result.results.some((r: Result) => r.stage === "types" && !r.ok), failed.stdout);
    assert.ok(result.results.some((r: Result) => r.stage === "proof" && r.ok), failed.stdout);
    assert.ok(!fs.existsSync(path.join(root, ".spec-cache/lock")));
  });

  test("a story's text, a definition a rule relies on, here or in an imported spec, and a src contract are each reviewed", () => {
    const root = copyOfProject();
    const edit = (file: string, change: (s: string) => string) => fs.writeFileSync(path.join(root, file), change(fs.readFileSync(path.join(root, file), "utf8")));
    assert.deepEqual(pendingItems(root), []);
    const original = read("spec/index.md", EXAMPLE);
    edit("spec/index.md", (s) => s.replace("so that I can buy\n> several things in one go.", "so that I can buy\n> many things at once."));
    assert.deepEqual(pendingItems(root), ["Story: Fill a draft: story changed"]);
    edit("spec/index.md", () => original.replace("pure val unitPrice = 5", "pure val unitPrice = 7"));
    const moved = pendingItems(root);
    assert.ok(moved.includes("Domain / Unit price and order size: model changed"), moved.join("\n"));
    assert.ok(moved.includes("Story: Fill a draft / Items can only be added to a draft: model changed through maxUnits, unitPrice (Domain / Unit price and order size)"), moved.join("\n"));
    assert.ok(moved.includes("Story: Fill a draft / The amount due is always the price of the units: model changed through unitPrice (Domain / Unit price and order size)"), moved.join("\n"));
    assert.ok(!moved.some((m) => m.startsWith("Story: Check out / A payment never exceeds the balance")), "a rule that does not use the price is not flagged");

    // Across specs: a change to a library definition flags the rules that use it,
    // through a namespace beside a local namesake, and past a comment that hides a namesake.
    const libChanged = (root: string, lib: string) => {
      for (const spec of readSpecs(root)) acceptReviews(root, spec);
      fs.writeFileSync(path.join(root, "spec/lib.md"), lib);
      return pendingItems(root);
    };
    const flagged = libChanged(fixtures(["lib", "shop"]), read("vibestack/fixtures/lib.md").replace("acc + x)", "x + acc)"));
    assert.ok(flagged.includes("Story: Fill a cart / A cart holds lines: model changed through total (spec/lib.md: Sums / The total of a list)"), flagged.join("\n"));
    const names = (quint: string) => ruleSpec(quint, "Identity", "Names", "Rules");
    const namespaced = libChanged(libAndUse(names("pure def identity(n: int): int = n"), names('import lib as L from "./lib"\npure def identity(n: int): int = 0\npure def lawIdentity(n: int): bool = L::identity(n) == n')),
      names("pure def identity(n: int): int = n + 0"));
    assert.ok(namespaced.some((item) => item.includes("model changed through") && item.includes("identity")), namespaced.join("\n"));
    const lib = ruleSpec("pure def value(n: int): int = n + 1", "Imported", "Names", "Rules");
    const hidden = libChanged(libAndUse(lib, `# Use\n\n## Rules\n\n### Local\n\n${F}quint\nimport lib.* from "./lib"\n/*\npure def value(n: int): int = 0\n*/\npure def other(n: int): int = n\n${F}\n\n### Uses imported value\n\n${F}quint\npure def lawValue(n: int): bool = value(n) > n\n${F}\n`),
      lib.replace("n + 1", "n + 2"));
    assert.ok(hidden.some((item) => item.startsWith("Rules / Uses imported value: model changed through") && item.includes("value")), hidden.join("\n"));

    // The //@ lines of hand-written code: changed, new, and gone, whether the file loses them or is deleted.
    const contract = () => pendingContracts(root).map((p) => `${p.where}: ${p.status}`);
    assert.deepEqual(contract(), []);
    edit("src/ledger.ts", (s) => s.replace("  //@ ensures \\result >= 0\n", ""));
    fs.writeFileSync(path.join(root, "src/extra.ts"), ONE);
    assert.deepEqual(contract(), ["src/extra.ts: new contract", "src/ledger.ts: contract changed"]);
    acceptContracts(root);
    edit("src/ledger.ts", (s) => s.replace(/^.*\/\/@.*\n/gm, ""));
    fs.rmSync(path.join(root, "src/extra.ts"));
    assert.deepEqual(contract(), ["src/extra.ts: contract removed", "src/ledger.ts: contract removed"]);
  });

  test("source edited by a test cannot be accepted with a proof of its earlier contents", async () => {
    const changed = ONE.replace("return 1", "return 2");
    const root = fixtures(["door"], (f) => {
      f["src/count.ts"] = ONE;
      f["test/change.test.ts"] = `import fs from "node:fs";\nimport { test } from "node:test";\ntest("an editor changes source", () => fs.writeFileSync("src/count.ts", ${JSON.stringify(changed)}));\n`;
    });
    for (const spec of readSpecs(root)) acceptReviews(root, spec);
    acceptContracts(root);
    const ledger = fs.readFileSync(path.join(root, "spec/lock.json"), "utf8");
    const result = await run(root, "reviews");
    assert.equal(result.said("review", /^sources changed while the check ran; nothing was accepted/)?.ok, false, result.text);
    assert.equal(fs.readFileSync(path.join(root, "spec/lock.json"), "utf8"), ledger);
  });

  test("moving an unchanged contract to another function requires review", () => {
    const text = `${ONE}//@ pure\nexport function two(): number {\n  return 2;\n}\n`;
    const root = scratch({ "src/count.ts": text });
    fs.mkdirSync(path.join(root, "spec"));
    acceptContracts(root);
    fs.writeFileSync(path.join(root, "src/count.ts"), text.replace("  //@ ensures \\result === 1\n", "").replace("  return 2;", "  //@ ensures \\result === 1\n  return 2;"));
    assert.deepEqual(pendingContracts(root).map((p) => p.status), ["contract changed"]);
  });

  test("accept records a changed story and a changed contract, after which nothing is left to reconcile", async () => {
    const root = copyOfProject("src/ledger.ts", (s) => s.replace("  //@ ensures order.status === \"Paid\" ==> \\result === 0\n", ""));
    fs.writeFileSync(path.join(root, "spec/index.md"), read("spec/index.md", EXAMPLE).replace("> get my money back.", "> get all my money back."));
    const before = await run(root);
    assert.deepEqual(before.failed, ["review"], before.text);
    assert.ok(before.said("review", /story changed/) && before.said("review", /src\/ledger\.ts\n\s+contract changed/), before.text);
    assert.match(before.next, /pnpm accept/);
    await check(root, "reviews");
    const after = await run(root);
    assert.deepEqual(after.failed, [], after.text);
    assert.equal(after.next, "all green");
    // The total is the `ensures` of the generated Dafny: two are left in src/ledger.ts, and its loop invariants are not counted.
    assert.ok(after.said("proof", /^src-ledger\.ts: all 2 obligations proved/), after.text);
  });

  test("a second check in the same project is refused, a lock left by a process that ended is taken over, and unused cache entries go", async () => {
    const root = fixtures(["door"]);
    const lock = path.join(root, ".spec-cache/lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid}\n`);
    await assert.rejects(check(root), /another check or accept is running in this project \(process \d+\)/);
    fs.writeFileSync(lock, `${spawnSync(process.execPath, ["-e", ""]).pid}\n`);
    const unused = path.join(root, ".spec-cache/000000000000000000000000.json");
    fs.writeFileSync(unused, "{}");
    const { failed, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(!fs.existsSync(lock), "the lock is released");
    assert.ok(!fs.existsSync(unused), "a cache entry the run did not use is deleted");
    assert.ok(fs.readdirSync(path.dirname(lock)).length > 0, "the entries it used are kept");
  });

  test("a rebuilt packaged command can generate a project from the repository root", async () => {
    const root = oneRule("packaged", "A packaged value", "pure val answer = 42");
    const copy = toolchain(scratch({ "package.json": read("package.json"), "tsconfig.build.json": read("tsconfig.build.json") }), "quint", "lsc", "vibelang");
    // Studio's page is built from the workspace packages it shares with every interface.
    fs.cpSync(path.join(project, "packages"), path.join(copy, "packages"), { recursive: true, verbatimSymlinks: true });
    const built = await exec(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], copy);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const script = path.join(copy, "dist/spec.js");
    const generated = await exec(process.platform === "win32" ? process.execPath : script,
      [...(process.platform === "win32" ? [script] : []), "gen", root], copy);
    assert.equal(generated.status, 0, generated.stdout + generated.stderr);
    assert.equal((await import(path.join(root, "gen/packaged.ts"))).answer, 42);
  });

  test("the command line checks, generates and watches a project directory from its parent", async () => {
    const script = path.join(project, "vibestack/spec.ts");
    const cli = (root: string, ...args: string[]) => runCli(script, root, ...args);
    const parent = scratch({});
    const root = path.join(parent, "a project");
    fs.mkdirSync(root);
    const blank = scratch({ "spec/index.md": "" });
    assert.equal((await cli(blank, "new")).status, 0);
    assert.match(fs.readFileSync(path.join(blank, "spec/index.md"), "utf8"), /## Story:/);
    assert.equal((await cli(blank, "new")).status, 1);
    assert.equal((await cli(blank, "new", "area/child")).status, 0);
    assert.ok(fs.existsSync(path.join(blank, "spec/area/child/index.md")));
    assert.equal((await cli(blank, "new", "../escape")).status, 1);
    fs.writeFileSync(path.join(blank, "spec/conflict.md"), "");
    assert.equal((await cli(blank, "new", "conflict")).status, 1);
    assert.equal(fs.existsSync(path.join(blank, "spec/conflict")), false);
    assert.equal((await cli(root, "new", "Tally")).status, 1);
    const namedSrc = scratch({});
    assert.equal((await cli(namedSrc, "new", "src")).status, 0);
    assert.ok(fs.existsSync(path.join(namedSrc, "spec/src/index.md")), "the unified ledger leaves src available as a spec name");
    assert.equal((await cli(root, "new", "tally")).status, 0);
    assert.match((await cli(root, "new", "tally")).stderr, /spec\/tally\/index\.md already exists/);
    const missing = await cli(root, "accept", "unprovd");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /not an existing project directory/);
    assert.equal((await cli(root, "accept", "--unprovd")).status, 2);
    assert.equal((await cli(root, "check", "--everything")).status, 2);
    // The starter spec passes every stage but review, and proves without a proof file.
    const checked = JSON.parse((await cli(parent, "check", "a project", "--json")).stdout);
    assert.deepEqual([...new Set(checked.results.filter((r: Result) => !r.ok).map((r: Result) => r.stage))], ["review"], JSON.stringify(checked, null, 2));
    for (const stage of ["model", "always", "sometimes", "replay", "proof"]) assert.ok(checked.results.some((r: Result) => r.stage === stage && r.ok), stage);
    assert.match(checked.next, /pnpm accept/);
    assert.ok(fs.existsSync(path.join(root, "gen/tally.ts")));
    assert.ok(!fs.existsSync(path.join(parent, "gen")));
    const accepted = await cli(parent, "accept", root);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.ok(fs.existsSync(path.join(root, "spec/lock.json")));
    assert.ok(!fs.existsSync(path.join(parent, "spec")));
    assert.equal((await cli(parent, "migrate", root)).status, 0);
    assert.equal((await cli(parent, "gen", root)).status, 0);
    fs.appendFileSync(path.join(root, "spec/tally/index.md"), `\n### Broken\n\n${F}quint\npure def\n${F}\n`);
    const lenient = await cli(parent, "gen", "--if-valid", root);
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.match(lenient.stdout, /^note: gen\/ was not generated/);
    assert.equal((await cli(parent, "gen", root)).status, 1);
    assert.equal((await cli(root, "gen")).status, 1);
    for (const target of ["missing", path.join(root, "spec/tally/index.md")]) {
      const invalid = await cli(parent, "check", target);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /not an existing project directory/);
    }
    assert.equal((await cli(parent, "check", root, parent)).status, 2);

    const watchedRoot = path.join(parent, "watched project");
    fs.mkdirSync(watchedRoot);
    assert.equal((await cli(parent, "init", watchedRoot)).status, 0);
    const watcher = spawn(process.execPath, [script, "watch", watchedRoot], { cwd: parent, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    watcher.stdout.on("data", (chunk) => { output += chunk; });
    watcher.stderr.on("data", (chunk) => { output += chunk; });
    const waitFor = (ready: () => boolean) => until(() => { assert.equal(watcher.exitCode, null, output); return ready(); }, () => output);
    try {
      await waitFor(() => output.includes("watching spec/"));
      fs.writeFileSync(path.join(watchedRoot, "spec/index.md"), ruleSpec("pure val watchedValue = 1", "Value", "Watched"));
      const generated = path.join(watchedRoot, "gen/index.ts");
      await waitFor(() => fs.existsSync(generated) && fs.readFileSync(generated, "utf8").includes("export const watchedValue"));
      await waitFor(() => (output.match(/watching spec\//g)?.length ?? 0) >= 2);
      assert.equal((await import(generated)).watchedValue, 1);
      assert.ok(!fs.existsSync(path.join(parent, "gen")));
    } finally {
      if (watcher.exitCode === null && watcher.signalCode === null) {
        const closed = new Promise((resolve) => watcher.once("close", resolve));
        watcher.kill("SIGTERM");
        await closed;
      }
    }
  });

  test("a fence of any length or kind holds prose, and closes only with its own kind and length", () => {
    const four = "`".repeat(4);
    const root = scratch({ "spec/f.md": `# F\n\n## Story\n\n### Real\n\n${F}quint\npure val a = 1\n${F}\n\n${four}markdown\n### Not a rule\n${F}quint\npure val b = 2\n${F}\n${four}\n\n~~~\n### Nor this\n${F}\n~~~\n\n### Also real\n\n${F}quint\npure val c = 3\n${F}\n` });
    const spec = parseSpec(root, "spec/f.md");
    assert.deepEqual(spec.rules.map((r) => r.key), ["Story / Real", "Story / Also real"]);
    assert.deepEqual(spec.rules.flatMap((r) => r.defs), ["a", "c"]);
    assert.match(spec.rules[0].prose, /### Not a rule[\s\S]*### Nor this/);
  });
  // Each of these is a way a false obligation could be reported as proved.
  const bumpHeader = "lemma bump_ensures(c: C, k: int)\n  ensures (inv(c) ==> canBump(c, k) ==> alwaysNonNegative(bump(c, k)))\n  ensures (inv(c) ==> canBump(c, k) ==> alwaysBumpsNonNegative(bump(c, k)))\n{\n";
  const magic = (proof?: string) => fixtures(["magic"], (f) => { if (proof !== undefined) f["spec/magic.proof.dfy"] = proof; });

  test("a proof file reaches the standard library only by the names the generated code uses, and the tools' library only by its own", () => {
    const lib = fs.readFileSync(LIB_FILE, "utf8");
    const gen = "function f(xs: seq<int>): bool\n{\n  Std.Collections.Seq.All(xs, (x: int) => x > 0)\n}\n\nlemma f_ensures(xs: seq<int>)\n  ensures (f(xs) == true)\n{\n}\n";
    const header = "lemma f_ensures(xs: seq<int>)\n  ensures (f(xs) == true)\n{\n";
    const spliced = (body: string) => splice(gen, { proof: { file: "p.dfy", text: `${header}${body}\n}\n` }, axioms: [], lib }).dfy;
    // Std.Ordinal.TimesIncreasingOnLeft is a false {:axiom}; dafny audit reports it only against the library's own file.
    assert.throws(() => spliced("  Std.Ordinal.TimesIncreasingOnLeft(0, 0, 0);"), /p\.dfy:4: `Std\.Ordinal\.TimesIncreasingOnLeft` is not allowed[^\n]*\(Std\.Collections\.Seq\.All\)/);
    assert.throws(() => spliced("  ProofLib.Seq.LemmaFlattenConcat<int>([], []);"), /`ProofLib\.Seq\.LemmaFlattenConcat` is not a lemma or function of vibestack\/proof\/lib\.dfy/);
    assert.throws(() => spliced("  assert (xs).Std.Ordinal == 0;"), /`Std` may only begin a name/);
    assert.ok(spliced("  assert Std.Collections.Seq.All(xs, (x: int) => x > 0) == f(xs);\n  ProofLib.FilterNil((x: int) => true, []);").includes("ProofLib.FilterNil"));
  });

  test("a failure is charged to the definition it is in, by where the tools put each line, not by reading the text back", () => {
    const { dfy, regions } = splice(GENERATED_F, { proof: { file: "p.dfy", text: "lemma\nLiar()\n  ensures false\n{\n}\nlemma f_ensures(x: int)\n  ensures (f(x) >= x)\n{\n  Liar();\n}\n" }, axioms: [] });
    const lines = dfy.split("\n");
    const liar = lines.indexOf("Liar()");
    assert.deepEqual(regions[liar], { def: "Liar", generated: false });
    assert.equal(regions[lines.indexOf("  Liar();")].def, "f_ensures");
    const out = (summary: string, ...messages: string[]) => `${messages.join("\n")}\n\nDafny program verifier finished with ${summary}\n`;
    const failure = `t.dfy(${liar + 4},0): Error: a postcondition could not be proved on this return path\nt.dfy(${liar + 2},10): Related location: this is the postcondition that could not be proved`;
    assert.match([...readVerdict(out("3 verified, 1 error", failure), dfy, "t.dfy", regions).errors].join("\n"), /^Liar \(t\.dfy:\d+\) does not verify: false; a lemma that is not generated must prove$/);
    const runtime = splice(GENERATED_F, { axioms: [] }, "t.dfy", new Set(["f_ensures"]));
    const at = runtime.dfy.split("\n").findIndex((line) => line.includes("ensures (f(x)")) + 1;
    const rejected = readVerdict(out("1 verified, 1 error", `t.dfy(${at + 1},0): Error: a postcondition could not be proved on this return path`, `t.dfy(${at},0): Related location: this is the postcondition that could not be proved`), runtime.dfy, "t.dfy", runtime.regions);
    assert.equal(rejected.unproved.size, 0);
    assert.match([...rejected.errors].join("\n"), /one of LemmaScript's own helpers/);
  });

  test("a sibling postcondition cannot pass when its generated definition cannot be copied", () => {
    const dfy = "lemma f_ensures(n: int)\n  ensures n > 0\n  ensures n < 0\n{ }\n";
    const region = { def: "f_ensures", generated: true };
    const result = isolatedCopies({ dfy, regions: dfy.split("\n").map(() => region) }, new Map([["f_ensures", new Set([2])]]));
    assert.equal(result.copies.length, 0);
    assert.deepEqual([...result.closed.keys()], ["f: n < 0"]);
    const unknown = isolatedCopies({ dfy, regions: [] }, new Map([["missing", new Set([2])]]));
    assert.match(unknown.errors.join("\n"), /cannot locate the generated definition/);
  });

  test("a generated runtime helper does not inflate the unit's obligation count", async () => {
    const { said, text, failed } = await run(oneRule("division", "Divide", "pure def lawHalves(n: int): bool = n / 2 == n / 2"));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^division\.ts: all 1 obligations proved/), text);
  });

  test("only Dafny's own messages are read: from the start of a line, from the error's block and definition, and as many as it counted", () => {
    const gen = "lemma a_ensures(x: int)\n  ensures P(x)\n  ensures Q(x)\n{\n}\n\nlemma b_ensures(x: int)\n  ensures R(x)\n{\n}\n";
    const { dfy, regions } = splice(gen, { axioms: [] });
    const verdict = (...messages: string[]) => readVerdict(`${messages.join("\n")}\n`, dfy, "t.dfy", regions);
    const error = "t.dfy(4,0): Error: a postcondition could not be proved on this return path";
    const related = (line: number) => `t.dfy(${line},2): Related location: this is the postcondition that could not be proved`;
    const summary = (n: number) => `\nDafny program verifier finished with 2 verified, ${n} error${n === 1 ? "" : "s"}`;
    // A message in the text of a line (as an echoed source line would carry it) is not a message.
    const echoed = verdict(error, related(3), `  | //x/t.dfy(8,2): Related location: this is the postcondition that could not be proved`, summary(1));
    assert.deepEqual([...echoed.unproved.keys()], ["a: Q(x)"]);
    assert.deepEqual([...echoed.errors], []);
    // A postcondition of another definition does not answer for this one.
    const elsewhere = verdict(error, related(8), summary(1));
    assert.deepEqual([...elsewhere.unproved.keys()], []);
    assert.match([...elsewhere.errors].join("\n"), /a_ensures: a postcondition could not be proved on this return path, and Dafny named no postcondition of it/);
    // One that comes after another message is not part of the error's block.
    const later = verdict(error, "t.dfy(9,0): Warning: something", related(3), summary(1));
    assert.deepEqual([...later.unproved.keys()], []);
    // Fewer failures read than Dafny counted is an error, never a smaller list.
    assert.match([...verdict(error, related(3), summary(2)).errors].join("\n"), /Dafny reported 2 failures, but 1 were read from its output/);
  });

  test("a proof file can neither use the standard library's axioms, nor charge a helper's failure to an obligation, nor spoof Dafny's messages", async () => {
    const [std, liar, spoof] = await Promise.all([
      run(magic(`${bumpHeader}  Std.Ordinal.TimesIncreasingOnLeft(0, 0, 0);\n}\n`)),
      run(magic(`lemma\nLiar()\n  ensures false\n{\n}\n\n${bumpHeader}  Liar();\n}\n`)),
      // A message inside a source comment must not name mark's obligation in place of bump's.
      run(magic(`${bumpHeader}  return; //magic.dfy(39,40): Related location: this is the postcondition that could not be proved\n}\n`)),
    ]);
    assert.equal(std.said("proof", /^magic\.ts: Dafny could not check it[\s\S]*spec\/magic\.proof\.dfy:5: `Std\.Ordinal\.TimesIncreasingOnLeft` is not allowed/)?.ok, false, std.text);
    assert.equal(liar.said("proof", /^magic\.ts: Dafny could not check it[\s\S]*Liar \(magic\.dfy:\d+\) does not verify/)?.ok, false, liar.text);
    const spoofed = spoof.said("proof", /^magic\.ts: 3 of 6 obligations not proved/);
    assert.equal(spoofed?.ok, false, spoof.text);
    assert.match(spoofed!.detail, /bump: \(inv\(c\) ==> canBump\(c, k\) ==> alwaysNonNegative\(bump\(c, k\)\)\)/);
  });

  test("an obligation whose proof calls a lemma that is not proved is not proved either, the tools' own step body included", async () => {
    const markProof = "lemma mark_ensures(c: C, k: int)\n  ensures (inv(c) ==> canMark(c, k) ==> alwaysNonNegative(mark(c, k)))\n  ensures (inv(c) ==> canMark(c, k) ==> alwaysBumpsNonNegative(mark(c, k)))\n{\n  bump_ensures(C(0, 0), 777777);\n  assert false;\n}\n";
    const [bare, borrowed] = await Promise.all([run(magic()), run(magic(markProof))]);
    const plain = bare.said("proof", /^magic\.ts: 3 of 6 obligations not proved/);
    assert.equal(plain?.ok, false, bare.text);
    assert.match(plain!.detail, /step: inv\(step\(current, event\)\)   \[rests on bump: /);
    const resting = borrowed.said("proof", /^magic\.ts: 4 of 6 obligations not proved/);
    assert.equal(resting?.ok, false, borrowed.text);
    assert.match(resting!.detail, /mark: \(inv\(c\) ==> canMark\(c, k\) ==> alwaysNonNegative\(mark\(c, k\)\)\)   \[rests on bump: /);
  });

  test("a law is offered to an importer only if it is proved without resting on one that is not", async () => {
    const counter = read("vibestack/fixtures/magic.md").replace("type C = {", 'import forbidden.* from "./forbidden"\ntype C = {').replace(/### Mark by[\s\S]*?(?=### The count is never)/, "").replace(/### The count of bumps[\s\S]*?(?=### Bumped)/, "");
    const { said, text } = await run(fixtures(["forbidden"], (f) => Object.assign(f, {
      "spec/magic.md": counter,
      "spec/forbidden.proof.dfy": "lemma lawNotSecond_ensures(n: int)\n  ensures (lawNotSecond(n) == true)\n{\n  lawNotFirst_ensures(987654321);\n}\n",
      "spec/magic.proof.dfy": "lemma bump_ensures(c: C, k: int)\n  ensures (inv(c) ==> canBump(c, k) ==> alwaysNonNegative(bump(c, k)))\n{\n  forbidden_lawNotSecond_ensures(123456789);\n}\n",
    })));
    const lib = said("proof", /^forbidden\.ts: 2 of 2 obligations not proved/);
    assert.equal(lib?.ok, false, text);
    assert.match(lib!.detail, /lawNotSecond: \(lawNotSecond\(n\) == true\)   \[rests on lawNotFirst: /);
    assert.equal(said("proof", /^magic\.ts: Dafny could not check it[\s\S]*unresolved identifier: forbidden_lawNotSecond_ensures/)?.ok, false, text);
  });

  test("verified code is refused where the proof and Node would read it differently", () => {
    const refused: [string, string, RegExp][] = [
      ["the name of Dafny's standard library", "export const Std = 1;", /`Std` names a Dafny library/],
      ["a renamed import", 'import { sometimesFour as alwaysNotNegative, type C } from "../gen/counter.ts";', /may not rename what it imports/],
      ["a default import", 'import counter from "../gen/counter.ts";', /not a default or namespace import/],
      ["a namespace import", 'import * as counter from "../gen/counter.ts";', /not a default or namespace import/],
      ["an export list", "function double(x: number): number {\n  return x * 2;\n}\nexport { double as half };", /may hold only imports, functions with a body/],
      ["a re-export", 'export * from "../gen/counter.ts";', /may hold only imports, functions with a body/],
      ["a default export", "export default function f(): number {\n  return 1;\n}", /`default` is not allowed/],
      ["an export assignment", "const f = 1;\nexport = f;", /may hold only imports, functions with a body/],
      ["a statement at the top level", "Math.max = (a: number, b: number) => -1000;", /may hold only imports, functions with a body/],
      ["a declaration without a body", "declare function f(x: number): number;", /`declare` is not allowed/],
      ["an overload without a body", "export function f(x: number): number;\nexport function f(x: number): number {\n  return x;\n}", /may hold only imports, functions with a body/],
      ["a let", "let x = 1;", /may hold only imports, functions with a body/],
      ["an annotation in a block comment", "export function twice(x: number): number {\n  //@ ensures \\result >= x\n  /*\n  //@ ensures \\result === 3 * x\n  */\n  return x + x;\n}", /:5: `\/\/@` here is not in a `\/\/` comment/],
      ["an annotation in a doc comment", "/** //@ ensures \\result === 3 */\nexport function three(): number {\n  return 3;\n}", /:2: `\/\/@` here is not in a `\/\/` comment/],
      ["an annotation in a string", 'export const note = "//@ ensures false";', /`\/\/@` here is not in a `\/\/` comment/],
      ["an annotation in a template", "export const note = `${1} //@ ensures false`;", /`\/\/@` here is not in a `\/\/` comment/],
      ["a NUL character", "export const x = 1; // \0", /NUL characters are not allowed/],
      ["a carriage return in a comment", "export const x = 1; // \r hidden", /line break/],
      ["a Unicode line break in a comment", "export const x = 1; // \u2028 hidden", /line break/],
    ];
    for (const [what, code, message] of refused) assert.throws(() => checkVerifiedSource("src/x.ts", `//@ backend dafny\n${code}\n`), message, what);
    checkVerifiedSource("src/ledger.ts", read("src/ledger.ts", EXAMPLE));
    checkVerifiedSource("src/fields.ts", "//@ backend dafny\nexport interface Box { Std: number; ProofLib: number }\n//@ pure\nexport function value(box: Box): number { return box.Std + box.ProofLib; }\n");
    checkVerifiedSource("src/x.ts", '//@ backend dafny\n// What the //@ lines promise.\nimport { type C, inv } from "../gen/c.ts";\nexport type D = C;\nexport interface E { c: C }\nconst limit = 3;\n//@ pure\nexport function f(c: C): boolean {\n  //@ ensures \\result === inv(c)\n  return inv(c) && limit > 0 || inv(c);\n}\n');
    checkVerifiedSource("src/x.ts", "//@ backend dafny\nexport function f(x: number): number { //@ requires x > 0\n  let i = 0; //@ type nat\n  return x + i;\n}\n");
  });

  test("verified code that renames an import or re-exports, or annotations in a file that is not .ts, a VibeLang one included, fail the proof", async () => {
    const renamed = copyOfProject("src/guard.ts", () => '//@ backend dafny\nimport { canSubmit as canCancel, type Order } from "../gen/index.ts";\n//@ pure\nexport function cancellable(o: Order): boolean {\n  //@ ensures \\result === (o.status === "Pending")\n  return canCancel(o);\n}\n');
    const module = copyOfProject("src/dec.mts", () => "//@ backend dafny\nexport function dec(x: number): number {\n  //@ ensures \\result > x\n  return x - 1;\n}\n");
    const reexport = copyOfProject("src/ledger.ts", (s) => s + '\nexport * from "./app.vibe";\n');
    const vibe = copyOfProject("src/dec.vibe", () => "//@ backend dafny\nexport const dec = 1\n");
    const [r, m, x, v] = await Promise.all([run(renamed), run(module), run(reexport), run(vibe)]);
    assert.equal(r.said("proof", /src\/guard\.ts:2: `canSubmit as canCancel`: verified code may not rename what it imports/)?.ok, false, r.text);
    assert.equal(m.said("proof", /src\/dec\.mts: `\/\/@` appears in it, but only \.ts files under src\/ are proved/)?.ok, false, m.text);
    assert.equal(v.said("proof", /src\/dec\.vibe: `\/\/@` appears in it, but only \.ts files under src\/ are proved/)?.ok, false, v.text);
    assert.equal(x.said("proof", /src\/ledger\.ts.*may hold only imports, functions with a body/)?.ok, false, x.text);
  });

  test("hand-written code is not simulated, so none of its obligations can be accepted as simulated only", async () => {
    const root = fixtures(["door"], (f) => { f["src/inc.ts"] = "//@ backend dafny\n//@ pure\nexport function inc(x: number): number {\n  //@ ensures \\result === x\n  return x + 1;\n}\n"; });
    const { said, text } = await run(root, "unproved");
    const inc = said("proof", /^src-inc\.ts: 1 of 1 obligations not proved/);
    assert.equal(inc?.ok, false, text);
    assert.match(inc!.summary, /Hand-written code is not simulated, so they must be proved/);
    assert.doesNotMatch(inc!.summary, /accept -- unproved/);
    const ledger = path.join(root, "spec/lock.json");
    assert.ok(!fs.existsSync(ledger) || !fs.readFileSync(ledger, "utf8").includes("src-inc.ts"), text);
  });
});
