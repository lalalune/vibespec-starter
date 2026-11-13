// Does each check catch the kind of mistake it exists for? Every case builds a
// scratch project, from this project's own spec or from the small specs in
// tools/fixtures/, breaks one thing, and asserts which stage of `check` fails.
// Run with `npm run selftest`.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { expandListHelpers, gen, parseSpec, readSpecs } from "./parse.ts";
import { parseProofFile, splice } from "./prove.ts";
import { acceptContracts, acceptReviews, pending, pendingContracts } from "./review.ts";
import { replay } from "./simulate.ts";
import { check, init } from "./spec.ts";
import { findUp, show, type Result } from "./util.ts";

const project = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(project, file), "utf8");
const F = "`".repeat(3);
const roots: string[] = [];
/** The node_modules this project resolves from, wherever up the tree it is (a git worktree has none of its own). */
const nodeModules = findUp(project, "node_modules") ?? assert.fail("no node_modules: run npm install");
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

/** A scratch project holding the given files. */
function scratch(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  // Hand-written code is typechecked, as in a project set up with `spec init`.
  if (Object.keys(files).some((f) => f.startsWith("src/")) && !files["tsconfig.json"]) {
    fs.writeFileSync(path.join(root, "tsconfig.json"), read("tsconfig.json"));
    fs.symlinkSync(nodeModules, path.join(root, "node_modules"), "dir");
  }
  return root;
}
/** A scratch project whose specs are the named fixtures, each changed by `edit` if it is given. */
const fixtures = (names: string[], edit: (files: Record<string, string>) => void = () => {}) => {
  const files = Object.fromEntries(names.map((n) => [`spec/${n}.md`, read(`tools/fixtures/${n}.md`)]));
  edit(files);
  return scratch(files);
};
/** A scratch project with one spec made of a single rule. */
const oneRule = (name: string, heading: string, quint: string) => scratch({ [`spec/${name}.md`]: `# T\n\n## Story\n\n### ${heading}\n\n${F}quint\n${quint}\n${F}\n` });
/** A copy of this project's spec and src, reconciled whatever awaits sign-off here, with `edit` applied to one file. */
function copyOfProject(file?: string, edit: (text: string) => string = (s) => s): string {
  const root = scratch({});
  for (const dir of ["spec", "src", "test", "tsconfig.json"]) fs.cpSync(path.join(project, dir), path.join(root, dir), { recursive: true });
  // So that the `types` and `tests` stages run as they do here: with the same compiler and Node types.
  fs.symlinkSync(nodeModules, path.join(root, "node_modules"), "dir");
  for (const spec of readSpecs(root)) acceptReviews(root, spec);
  acceptContracts(root);
  if (!file) return root;
  const target = path.join(root, file);
  const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  assert.notEqual(edit(before), before, "the edit must change the file");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, edit(before));
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
const failedStages = async (file: string, edit: (text: string) => string, accept = false) =>
  (await run(copyOfProject(file, edit), accept ? "reviews" : false)).failed;

describe("each check catches its own kind of mistake", { concurrency: true }, () => {
  test("a fresh spec with enum and bool parameters and an unguarded transition passes everything but review", async () => {
    const { failed, text } = await run(fixtures(["door"]));
    assert.deepEqual(failed, ["review"], text);
  });

  test("a missing guard is found by simulation, as a trace that the same seed gives again, and the later stages say they were skipped", async () => {
    const root = copyOfProject("spec/order.md", (s) => s.replace("o.status == Draft and o.units > 0", "o.status == Draft"));
    const [first, again] = [await run(root), await run(root)];
    const trace = first.said("always", /./);
    assert.equal(trace?.ok, false, first.text);
    assert.match(trace!.detail, /seed \d+; to simulate again: npx quint run gen\/order\.run\.qnt .* --seed \d+/);
    assert.equal(again.said("always", /./)?.detail, trace!.detail, "the same harness gives the same trace");
    assert.ok(first.said("skipped", /^types, proof and tests: /), first.text);
    assert.match(first.next, /^always \(spec\/order\.md\) is the first ✗/);
  });

  test("a rule set that holds in simulation but is not inductive is caught by the proof", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace(/### Drafts and cancelled orders hold no money[\s\S]*?```\n\n/, ""));
    assert.deepEqual(failed, ["proof", "review"]); // simulation passes; the deletion itself also awaits review
  });

  test("rules too strict to ever reach a goal are caught by a `sometimes` rule", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace("o.paid + amount <= o.due", "o.paid + amount < o.due"));
    assert.ok(failed.includes("sometimes"), failed.join());
  });

  test("a guard that never allows its event is caught, although every rule holds of the event trivially", async () => {
    // Cancelling refunds every payment, so a reopen that needs money paid can never happen.
    const { failed, text, said } = await run(copyOfProject("spec/order.md", (s) => s.replace("canReopen(o: Order): bool = o.status == Cancelled", "canReopen(o: Order): bool = o.status == Cancelled and o.paid > 0")));
    assert.ok(failed.includes("sometimes"), text);
    assert.ok(said("sometimes", /reopen in .* never happened: its guard canReopen refused it/), text);
  });

  test("a guard that needs values the simulator does not try says which to define", async () => {
    const { text, said } = await run(copyOfProject("spec/order.md", (s) => s.replace("o.status == Pending and amount > 0 and neverMoreThanPaid", "o.status == Pending and amount > 6 and neverMoreThanPaid")));
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

  test("prose edited without the model is flagged for review, and nothing else", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace("Every unit costs the same", "Every unit costs 7"));
    assert.deepEqual(failed, ["review"]);
  });

  test("a rule with no formal half is flagged", async () => {
    const failed = await failedStages("spec/order.md", (s) => s + "\n### Refunds arrive within three days\n\nNot yet modelled.\n");
    assert.deepEqual(failed, ["review"]);
  });

  test("Quint outside the supported subset is refused, not mistranslated", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5^1"));
    assert.ok(failed.includes("model"), failed.join());
  });

  test("a spec the translator cannot render faithfully is refused", async () => {
    const refused: [string, (s: string) => string][] = [
      ["integer beyond 2^53", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 9007199254740993")],
      ["parameter named like a variant", (s) => s.replace("canCancel(o: Order): bool = o.status == Pending", "canCancel(o: Order): bool = o.status == Pending\npure def isIt(o: Order, Draft: Status): bool = o.status == Draft")],
      ["rule name with the wrong capital", (s) => s.replace(/alwaysPaidWithinDue/g, "alwayspaidWithinDue")],
      ["TypeScript keyword as a name", (s) => s.replace(/\bcancel\b/g, "delete").replace(/canCancel/g, "canDelete")],
      ["parameter that collides with the harness's state variable", (s) => s.replace(/\bamount\b/g, "state")],
      ["duplicate rule heading", (s) => s.replace("### An order can be cancelled", "### A pending order can be cancelled, refunding every payment")],
    ];
    for (const [what, edit] of refused) assert.deepEqual(await failedStages("spec/order.md", edit), ["model"], what);
  });

  test("names and constructs that would be translated wrongly are refused", async () => {
    const refused: [string, string, RegExp][] = [
      ["a type named like a generated one", "type Event = { n: int }\npure val initial: Event = { n: 0 }", /cannot be used as a name/],
      ["a definition named like a JavaScript global", "pure val initial: int = 0\npure def Number(n: int): int = n", /cannot be used as a name/],
      ["a set of two computed members", "pure val initial: int = 0\npure def pair(a: int, b: int): int = Set(a, b).size()", /could hold the same value twice/],
      ["a variant field called tag", "type P = A({ tag: int }) | B\npure val initial: int = 0", /cannot be called `tag`/],
      ["a match binder used as a whole value", "type N = { n: int }\ntype P = A(N) | B\npure val initial: int = 0\npure def g(r: N): int = r.n\npure def f(p: P): int = match p { | A(x) => g(x) | _ => 0 }", /is what a match arm carries/],
      ["state declared by hand", "pure val initial: int = 0\nvar n: int", /only types, imports, `pure val` and `pure def` belong in a spec/],
    ];
    for (const [what, quint, message] of refused) {
      const { said, text } = await run(oneRule("t", "A rule", quint));
      assert.equal(said("model", message)?.ok, false, `${what}\n${text}`);
    }
  });

  test("a rule written as a `pure val` is refused rather than generated as a constant, and a constant named alike is not", async () => {
    const { said, text } = await run(oneRule("t", "A rule", "pure val initial: int = 0\npure val alwaysNever = false"));
    assert.equal(said("model", /is a `pure def` with parameters/)?.ok, false, text);
    const constant = await run(oneRule("t", "A rule", "pure val stepLimit = 3\npure def lawPositive(k: int): bool = stepLimit > 0"));
    assert.ok(!constant.failed.includes("model"), constant.text);
  });

  test("a comment or string left open at the end of a quint block is refused, so prose can never become model", async () => {
    // Prose is tangled as `// …`; inside an open block comment, `// */ code` would be code that no review or cache key sees as such.
    const { said, text } = await run(copyOfProject("spec/order.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5\n/*")));
    assert.equal(said("model", /a comment is still open at the end of this quint block/)?.ok, false, text);
  });

  test("a quint block under a nested list item is part of the model", async () => {
    const failed = await failedStages("spec/order.md", (s) => s + "\n### Nothing is ever fine\n\n- because:\n  - nested:\n\n    ```quint\n    pure def alwaysBogus(o: Order): bool = false\n    ```\n");
    assert.ok(failed.includes("always"), failed.join());
  });

  test("who sent an event travels beside it, a guard takes only what it uses, a step rule sees the event, and deep goals are found", async () => {
    const vault = (edit: (s: string) => string = (s) => s) => fixtures(["vault"], (f) => { f["spec/vault.md"] = edit(f["spec/vault.md"]); });
    const root = vault();
    const ok = await run(root);
    assert.deepEqual(ok.failed, ["review"], ok.text);
    assert.ok(ok.said("sometimes", /sometimesLate is reachable/), ok.text); // thirty ticks: beyond a trace of 20 events
    const gen = await import(path.join(root, "gen/vault.ts"));
    assert.deepEqual(gen.parseEvent({ type: "open", by: "Owner" }), { type: "open" });
    assert.equal(gen.enabled(gen.initial, { type: "open" }, "Guest"), false);
    assert.equal(gen.step(gen.initial, { type: "relabel", label: "a" }, "Owner").label, "a");
    // A counterexample shows each event with only what it changed.
    const broken = await run(vault((s) => s.replace("{ ...v, open: false }", "{ ...v, open: true }")));
    assert.ok(broken.said("always", /a step breaks[\s\S]*\n\s+close\s+-> open = true\n/), broken.text);
    const stray = await run(vault((s) => s.replace("canRelabel(v: Vault, by: Actor): bool = by", "canRelabel(v: Vault, who: Actor): bool = who")));
    assert.ok(stray.said("model", /canRelabel: `who` must be a parameter of relabel/), stray.text);
  });

  test("a rule broken only on the way to a `sometimes` goal is still reported", async () => {
    // Only the witness search goes deep enough: the goal is three steps away and the break is on the way.
    const quint = "pure val initial: int = 0\npure def up(n: int): int = n + 1\npure def canUp(n: int): bool = n < 5\npure def alwaysBelowThree(n: int): bool = n < 3\npure def sometimesFour(n: int): bool = n == 4";
    const { failed, text } = await run(oneRule("t", "Counting", quint));
    assert.ok(failed.includes("always"), text);
    assert.ok(!failed.includes("sometimes") || failed.includes("always"), text);
  });

  test("hand-written code that changes what it is checked against is refused or flagged", async () => {
    const reexport = await failedStages("src/ledger.ts", (s) => s + '\nexport * from "./app.ts";\n');
    assert.ok(reexport.includes("proof"), reexport.join());
    const { said, text } = await run(copyOfProject("src/ledger.ts", (s) => s.replace(/(\/\/@ ensures)/, "//@ requires true\n$1")));
    assert.ok(said("proof", /^src-ledger\.ts: .*under 2 \/\/@ requires/), text);
  });

  test("the application's types and tests are checked", async () => {
    assert.ok((await failedStages("src/app.ts", (s) => s + "\nconst wrong: number = \"x\";\n")).includes("types"));
    const failing = await run(copyOfProject("test/app.test.ts", (s) => s + '\ntest("fails", () => { throw new Error("no"); });\n'));
    assert.ok(failing.failed.includes("tests"), failing.text);
    const untyped = copyOfProject();
    fs.rmSync(path.join(untyped, "tsconfig.json"));
    assert.ok((await run(untyped)).failed.includes("types"));
  });

  test("Markdown the tools would read differently from a viewer is refused or read as a viewer does", async () => {
    const cr = await failedStages("spec/order.md", (s) => s.replace("Every unit costs the same", "Every unit costs the same\rpure val sneaky = 1"));
    assert.deepEqual(cr, ["model"]);
    // A fence with an info string does not close a quint block, so what follows is still Quint (and here not valid Quint).
    const fence = await failedStages("spec/order.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = 5\n```text\nnot quint"));
    assert.ok(fence.includes("model"), fence.join());
  });

  test("a story whose title starts another story's title still needs rules of its own", async () => {
    const story = "\n## Story: Wrap\n\n> As a shopper, I want my order wrapped.\n\n## Story: Wrap / gifts\n\n### Gifts are wrapped\n\n```quint\npure def lawWrapped(n: int): bool = true\n```\n";
    const { said, text } = await run(copyOfProject("spec/order.md", (s) => s + story));
    assert.ok(said("review", /  Story: Wrap\n\s+story has no rules/), text);
  });

  test("a helper lemma whose header ends in a cardinality is read as having a body", () => {
    const lemmas = parseProofFile("lemma L(xs: seq<int>)\n  ensures |xs| >= 0\n  decreases |xs|\n{\n}\n", "p.dfy");
    assert.deepEqual(lemmas.map((l) => l.name), ["L"]);
  });

  test("a machine whose state holds a library's type can be imported under a name", async () => {
    const spec = (title: string, quint: string) => `# ${title}\n\n## Story\n\n### ${title}\n\n${F}quint\n${quint}\n${F}\n`;
    const root = scratch({
      "spec/lib.md": spec("Library", "type T = { n: int }\npure def lawZeroIsZero(k: int): bool = k * 0 == 0"),
      "spec/mach.md": spec("Machine", 'import lib.* from "./lib"\ntype St = { t: T }\npure val initial: St = { t: { n: 0 } }\npure def bump(s: St): St = { t: { n: s.t.n + 1 } }'),
      "spec/sys.md": spec("System", 'import mach as M from "./mach"\ntype Sys = { a: M::St }\npure val initial: Sys = { a: M::initial }\npure def go(s: Sys): Sys = { a: M::bump(s.a) }'),
    });
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^sys\.ts: all \d+ obligations proved/), text);
  });

  test("a quint block indented inside a list is still part of the model", async () => {
    const failed = await failedStages("spec/order.md", (s) => s + "\n### Nothing is ever fine\n\n- because:\n\n  ```quint\n  pure def alwaysBogus(o: Order): bool = false\n  ```\n");
    assert.ok(failed.includes("always"), failed.join());
  });

  test("a story with no rules is flagged for translation", async () => {
    const failed = await failedStages("spec/order.md", (s) => s + "\n## Story: Gift wrap\n\n> As a shopper, I want my order wrapped.\n");
    assert.deepEqual(failed, ["review"]);
  });

  test("lists, nested helpers, an imported library, laws, step rules and the proof ledger work together", async () => {
    const shop = (edit?: (files: Record<string, string>) => void) => fixtures(["lib", "shop"], edit);
    // The nested helpers (some inside some inside every) agree between Quint and TypeScript, and simulation passes.
    const plain = await run(shop());
    assert.deepEqual(plain.failed, ["proof", "review"], plain.text);
    assert.ok(plain.said("proof", /not proved/), plain.text);
    // Once the unproved obligations are recorded, only the review is left.
    // Hand-written code proved against the shop says that it rests on what is simulated only there.
    const recorded = shop((f) => { f["src/count.ts"] = 'import { type Cart } from "../gen/shop.ts";\n//@ pure\nexport function count(c: Cart): number {\n  //@ ensures \\result === c.count\n  return c.count;\n}\n'; });
    const recording = await check(recorded, "unproved");
    const ledger = recording.results.find((r) => r.stage === "proof" && /^spec\/unproved\.lock\.json: [1-9]\d* added, 0 removed$/.test(r.summary));
    assert.match(ledger?.detail ?? "", /^    \+ shop\.ts: /m, recording.results.map(show).join("\n"));
    const accepted = await run(recorded);
    assert.deepEqual(accepted.failed, ["review"], accepted.text);
    assert.ok(accepted.said("proof", /^src-count\.ts: all 1 obligations proved for all states and inputs, assuming the obligations that are simulated only \([^)]*\d+ of shop\.ts\)/), accepted.text);
    // What was recorded is tied to the text it was recorded for: once the unit's text changes, it no longer counts.
    fs.appendFileSync(path.join(recorded, "spec/lib.md"), `\n### Two\n\n${F}quint\npure val two = 2\n${F}\n`);
    const moved = await run(recorded);
    assert.equal(moved.said("proof", /^shop\.ts: \d+ of \d+ obligations not proved; the \d+ accepted earlier were accepted for another text/)?.ok, false, moved.text);
    const wrongStep = await run(shop((f) => { f["spec/shop.md"] = f["spec/shop.md"].replace("count: c.count }", "count: c.count - 1 }"); }));
    assert.equal(wrongStep.said("always", /^a step breaks/)?.ok, false, wrongStep.text);
    const wrongLaw = await run(shop((f) => { f["spec/lib.md"] = f["spec/lib.md"].replace("total(List(n)) == n", "total(List(n)) == n + 1"); }));
    assert.equal(wrongLaw.said("always", /^the law .* is false for \{"n":/)?.ok, false, wrongLaw.text);
    const importsMachine = await run(shop((f) => { f["spec/other.md"] = `# Other\n\n## Group\n\n### Uses a machine\n\n${F}quint\nimport shop.* from "./shop"\npure val two = 2\n${F}\n`; }));
    assert.ok(importsMachine.said("model", /is imported under a name/), importsMachine.text);
    const circle = await run(shop((f) => { f["spec/lib.md"] = f["spec/lib.md"].replace("pure def total", 'import shop.* from "./shop"\npure def total'); }));
    assert.ok(circle.said("model", /import each other in a circle/), circle.text);
  });

  test("list helpers are expanded into built-in folds, innermost first, without moving a line", () => {
    const out = expandListHelpers("pure def f(xs: List[T]): bool =\n  xs.every(t => t.ps.some(p =>\n    p == t.id))\n// xs.some(note in prose)");
    assert.equal(out.split("\n").length, 4);
    assert.ok(!/\.(every|some)\(/.test(out.split("\n").slice(0, 3).join("\n")), out);
    assert.match(out, /std_every_\d+ and/);
    assert.match(out, /std_some_\d+ or/);
    assert.match(out, /\/\/ xs\.some\(note in prose\)$/);
  });

  test("list helpers are not rewritten inside strings or comments, and a stray parenthesis is an error, not a hang", () => {
    const kept = 'pure val note = "xs.some(y)" // xs.every(z)\npure def f(xs: List[int]): bool = xs.some(x => x > 0)';
    const out = expandListHelpers(kept);
    assert.ok(out.includes('"xs.some(y)" // xs.every(z)'), out);
    assert.match(out, /xs\.foldl\(false, \(std_some_\d+, x\)/);
    assert.throws(() => expandListHelpers("pure def f(xs: List[int]): bool = xs.every(x => x > 0 // oops"), /no closing parenthesis/);
  });

  test("a state whose stages carry different data, with match and sets, is simulated, replayed and fully proved", async () => {
    const root = fixtures(["parcel"]);
    const { failed, said, text } = await run(root);
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^parcel\.ts: all \d+ obligations proved/), text);
    assert.match(fs.readFileSync(path.join(root, "gen/parcel.ts"), "utf8"), /\| \{ tag: "Shipped"; weight: number; labels: string\[\]; hops: number \}/);
  });

  test("a machine built from a component states and proves a rule that spans two of them", async () => {
    const { failed, said, text } = await run(fixtures(["account", "bank"]));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("model", /^spec\/bank\.md: 2 transitions, 1 always, 1 step, 1 sometimes/), text);
  });

  test("one machine uses another under a name, keeps its rules, and adds rules about the pair", async () => {
    const { failed, said, text } = await run(fixtures(["lamp", "room"]));
    assert.deepEqual(failed, ["review"], text);
    assert.ok(said("proof", /^room\.ts: all \d+ obligations proved/), text);
  });

  test("a map is looked up safely, and division and remainder agree with Quint for negative numbers", async () => {
    const { failed, said, text } = await run(fixtures(["stock"]));
    assert.deepEqual(failed, ["proof", "review"], text);
    assert.ok(said("replay", /every law, and \d+ definitions/)?.ok, text);
    assert.ok(!said("proof", /lawBoxesAndLooseMakeTheWhole/), "the division law is proved, so it is not listed as unproved");
  });

  test("a map key that every object has, a getter on an event, and an extra field are all harmless", async () => {
    const root = fixtures(["stock"]);
    gen(root, parseSpec(root, "spec/stock.md"));
    const stock = await import(path.join(root, "gen/stock.ts"));
    const received = stock.step(stock.initial, stock.parseEvent({ type: "receive", sku: "constructor", qty: 1 }));
    assert.equal(stock.level(received, "constructor"), 1);
    assert.equal(stock.level(received, "toString"), 0);
    let reads = 0;
    const event = stock.parseEvent({ type: "receive", sku: "a", get qty() { return reads++ ? 1000 : 2; }, extra: 1 });
    assert.deepEqual(event, { type: "receive", sku: "a", qty: 2 });
    assert.equal(stock.parseEvent({ type: "receive", sku: "a", qty: 1.5 }), undefined);
  });

  test("replay notices a definition whose TypeScript result differs from Quint's", async () => {
    const root = copyOfProject();
    const model = gen(root, parseSpec(root, "spec/order.md"));
    const domain = await import(path.join(root, "gen/order.ts"));
    assert.ok(model.evals.some((v) => v.name === "canSubmit"), "guards are among the definitions compared");
    const evaluated = (result: boolean) => [{ state: domain.initial }, { evaluated: { name: "canSubmit", picks: {}, result } }];
    replay(domain, evaluated(false), model);
    assert.throws(() => replay(domain, evaluated(true), model), /disagree on canSubmit/);
    assert.throws(() => replay({ ...domain, canSubmit: () => true }, evaluated(false), model), /disagree on canSubmit/);
  });

  test("TypeScript that diverges from the Quint model is caught by replay", async () => {
    const root = copyOfProject();
    gen(root, parseSpec(root, "spec/order.md"));
    const domain = await import(path.join(root, "gen/order.ts"));
    const trace = [{ state: domain.initial }, ...[{ type: "addItem", qty: 1 }, { type: "submit" }, { type: "pay", amount: 2 }]
      .map((event, i, all) => ({ event, state: all.slice(0, i + 1).reduce(domain.step, domain.initial) }))];
    replay(domain, trace);
    const broken = { ...domain, step: (s: any, e: any) => (e.type === "pay" ? { ...domain.step(s, e), status: "Paid" } : domain.step(s, e)) };
    assert.throws(() => replay(broken, trace), /TypeScript and Quint disagree/);
  });

  test("a rule heading cannot become code", async () => {
    const { said, text } = await run(oneRule("counter", "A counter */ globalThis.INJECTED = true; /* starts at zero", "pure val initial: int = 0\npure def bump(n: int): int = n + 1"));
    assert.equal((globalThis as any).INJECTED, undefined, "the heading ran as code");
    assert.ok(said("replay", /agrees with Quint/)?.ok, text);
  });

  test("a proof cannot be forged from inside the project", async () => {
    const notInductive = (s: string) => s.replace(/### Drafts and cancelled orders hold no money[\s\S]*?```\n\n/, "");
    const withFile = (file: string, text: string) => {
      const root = copyOfProject("spec/order.md", notInductive);
      fs.writeFileSync(path.join(root, file), text);
      return root;
    };
    const unproved = /^order\.ts: \d+ of \d+ obligations not proved/;
    // A file in src/ named after the spec does not take the place of the spec's own proof.
    const namesake = await run(withFile("src/order.ts", "//@ pure\nexport function one(): number {\n  return 1;\n}\n"));
    assert.ok(namesake.said("proof", unproved), namesake.text);
    // A LemmaScript configuration in the project cannot point the proof at files someone could edit.
    const configured = await run(withFile("lemmascript.json", `{"proof-dir":"proofs"}`));
    assert.ok(configured.said("proof", unproved), configured.text);
    // An annotation that asks the prover for trust is refused wherever it sits on the line.
    const sneaky = await run(copyOfProject("src/ledger.ts", (s) => s.replace("return order.due - order.paid;", "/* x */ //@ assume false\n  return order.paid - order.due;")));
    assert.ok(sneaky.said("proof", /`\/\/@ assume` is not allowed/), sneaky.text);
    // So is an import of anything but a generated module, however it is indented.
    const lying = await run(copyOfProject("src/ledger.ts", (s) => s.replace("\n/** Rebuild", '\n  import { owed } from "/tmp/lies.ts";\n/** Rebuild')));
    assert.ok(lying.said("proof", /may only import generated modules/), lying.text);
  });

  test("a law that needs induction is proved by a proof file, and only then offered to the spec that imports it", async () => {
    const highestProof = "// The fold keeps the larger of the two.\nlemma lawTheHighestIsAtLeastTheStart_ensures(xs: seq<int>, start: int)\n  ensures (lawTheHighestIsAtLeastTheStart(xs, start) == true)\n{\n  ProofLib.FoldLeftMax((top: int, x: int) => (if (x > top) then x else top), start, xs);\n}\n";
    const ticketProof = "lemma issue_ensures(d: Desk)\n  ensures (inv(d) ==> alwaysTheLastNumberIsNotNegative(issue(d)))\n{\n  highest_lawTheHighestIsAtLeastTheStart_ensures(d.issued, d.last);\n}\n";
    const project = (files: Record<string, string>) => fixtures(["highest", "ticket"], (f) => Object.assign(f, files));
    // Without a proof file the law is not proved, and a proof file that belongs to nothing is pointed out.
    const bare = await run(project({ "spec/typo.proof.dfy": "" }));
    assert.equal(bare.said("proof", /^highest\.ts: 1 of 1 obligations not proved/)?.ok, false, bare.text);
    assert.equal(bare.said("proof", /^spec\/typo\.proof\.dfy belongs to no proof unit/)?.ok, false, bare.text);
    // With both proof files, everything proves, and the final Dafny is there to read.
    const root = project({ "spec/highest.proof.dfy": highestProof, "spec/ticket.proof.dfy": ticketProof });
    const proved = await run(root);
    assert.deepEqual(proved.failed, ["review"], proved.text);
    assert.ok(proved.said("proof", /^ticket\.ts: all 3 obligations proved/), proved.text);
    assert.match(fs.readFileSync(path.join(root, "gen/proof/ticket/ticket.dfy"), "utf8"), /lemma \{:axiom\} highest_lawTheHighestIsAtLeastTheStart_ensures/);
    // A law its own unit does not prove is not offered.
    const unoffered = await run(project({ "spec/ticket.proof.dfy": ticketProof }));
    assert.equal(unoffered.said("proof", /^ticket\.ts: Dafny could not check it[\s\S]*unresolved identifier: highest_lawTheHighestIsAtLeastTheStart_ensures/)?.ok, false, unoffered.text);
    // A proof file that asks for trust is refused, with its file and line.
    const trusting = await run(project({ "spec/highest.proof.dfy": highestProof.replace("ProofLib.FoldLeftMax", "assume false;\n  ProofLib.FoldLeftMax") }));
    assert.equal(trusting.said("proof", /spec\/highest\.proof\.dfy:5: `assume` is not allowed/)?.ok, false, trusting.text);
  });

  test("a proof file may only add lemmas, and only bodies to the generated ones", () => {
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
    ];
    for (const [what, text, message] of refused) assert.throws(() => parseProofFile(text, "p.dfy"), message, what);
    assert.equal(parseProofFile("// a comment\nlemma A(xs: seq<int>)\n  ensures forall i {:trigger xs[i]} :: 0 <= i < |xs| ==> xs[i] == xs[i]\n{\n  reveal F();\n  calc { 1; 1; }\n  forall i | 0 <= i < |xs| ensures xs[i] == xs[i] {}\n  assert true by { var x := 1; if x > 0 { } match xs { case _ => } }\n}\n", "p.dfy").length, 1);

    const gen = "function f(x: int): int\n{\n  x\n}\n\nlemma f_ensures(x: int)\n  ensures (f(x) >= x)\n{\n}\n";
    const spliced = (text: string) => splice(gen, { proof: { file: "p.dfy", text }, axioms: [] }).dfy;
    // A body goes inside the generated lemma; a helper is appended; nothing generated changes.
    const out = spliced("lemma f_ensures(x: int)\n  ensures (f(x) >= x)   // spacing and comments do not matter\n{\n  Helper(x);\n}\nlemma Helper(x: int) ensures f(x) == x { }\n");
    assert.ok(out.startsWith(gen.replace("{\n}\n", "{\n  Helper(x);\n}\n")), out);
    assert.match(out, /lemma Helper\(x: int\)/);
    // A header that no longer matches the generated one is stale.
    assert.throws(() => spliced("lemma f_ensures(x: int)\n  requires x > 0\n  ensures (f(x) >= x)\n{\n}\n"), /p\.dfy:1: lemma f_ensures does not repeat its generated header, so it is refused as stale/);
    // A helper may not take a generated name, or the library's.
    assert.throws(() => spliced("lemma f(x: int) { }"), /p\.dfy:1: lemma f: the name is already declared/);
    assert.throws(() => spliced("lemma ProofLib() { }"), /the name is already declared/);
  });

  test("an obligation that fails is not assumed while the others are checked", async () => {
    const { said, text } = await run(fixtures(["twins"]));
    const found = said("proof", /^twins\.ts: 2 of 4 obligations not proved/);
    assert.equal(found?.ok, false, text);
    assert.match(found!.detail, /alwaysBIsAtMostThreeOrNinetyNine/);
  });

  test("verified code cannot assume, or import a look-alike of the generated module", async () => {
    const assumed = await failedStages("src/ledger.ts", (s) => s.replace("return order.due - order.paid;", "//@ assume false\n  return order.paid - order.due;"));
    assert.deepEqual(assumed, ["proof", "tests", "review"]); // the code is also wrong, and the new //@ line is a changed contract
    const lookalike = await run(copyOfProject("src/ledger.ts", (s) => s.replace('"../gen/order.ts"', '"./order.ts"')));
    assert.ok(lookalike.said("proof", /may only import generated modules/), lookalike.text);
  });

  test("verified code in a subdirectory of src is proved too", async () => {
    const failed = await failedStages("src/deep/owed.ts", () => 'import { type Order } from "../../gen/order.ts";\n//@ pure\nexport function owed(o: Order): number {\n  //@ ensures \\result > 0\n  return o.due - o.paid;\n}\n');
    assert.deepEqual(failed, ["proof", "review"]); // and its contract is new
  });

  test("hand-written logic that breaks its contract is caught by the proof", async () => {
    const failed = await failedStages("src/ledger.ts", (s) => s.replace("return order.due - order.paid;", "return order.paid - order.due;"));
    assert.deepEqual(failed, ["proof", "tests"]);
  });

  test("moving a line break so that a comment swallows half a guard is a change to the model", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace("pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 and o.units + qty <= maxUnits",
      "pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 // and o.units + qty <= maxUnits"));
    assert.ok(failed.includes("review"), failed.join());
  });

  test("a deleted rule is flagged for review", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace(/### An order can be cancelled[\s\S]*$/, ""));
    assert.deepEqual(failed, ["tests", "review"]); // the application's test of cancelling fails too
  });

  test("accept records nothing while another stage fails, and records when all pass", async () => {
    const reworded = (s: string) => s.replace("Every unit costs the same", "Each unit has one price");
    assert.deepEqual(await failedStages("spec/order.md", reworded, true), []);
    const failed = await failedStages("spec/order.md", (s) => reworded(s).replace("o.status == Draft and o.units > 0", "o.status == Draft"), true);
    assert.deepEqual(failed, ["always", "review"]);
  });

  test("init adds what a project lacks, keeps its own AGENTS.md and brings only the section on specs up to date", () => {
    const root = scratch({ "AGENTS.md": "mine\n", "package.json": `{"scripts":{"check":"mine"}}` });
    const added = init(root);
    const agents = () => fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    // Claude Code skips AGENTS.md when a CLAUDE.md exists, so CLAUDE.md imports it.
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    const kept = scratch({ "CLAUDE.md": "Use pnpm.\n" });
    init(kept);
    assert.equal(fs.readFileSync(path.join(kept, "CLAUDE.md"), "utf8"), "Use pnpm.\n\n@AGENTS.md\n");
    assert.ok(agents().startsWith("mine\n") && agents().includes("<!-- onespec:start") && agents().includes("sync"), agents());
    fs.writeFileSync(path.join(root, "AGENTS.md"), agents().replace(/(<!-- onespec:start[^\n]*\n)[\s\S]*?(<!-- onespec:end -->)/, "$1outdated\n$2") + "\nmore of mine\n");
    assert.deepEqual(init(root), ["AGENTS.md (its section on specs)"]);
    assert.ok(!agents().includes("outdated") && agents().endsWith("more of mine\n"), agents());
    // Markers that do not pair up, or a whole copy from an earlier version, are left for a person to sort out.
    fs.writeFileSync(path.join(root, "AGENTS.md"), agents().replace("<!-- onespec:end -->", ""));
    assert.throws(() => init(root), /fix the markers by hand/);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Operating procedure for agents\n\nThe person signs off with `npm run accept`.\n");
    assert.throws(() => init(root), /without markers/);
    // A file with Windows line endings keeps them.
    fs.writeFileSync(path.join(root, "AGENTS.md"), "mine\r\n");
    init(root);
    assert.ok(!/[^\r]\n/.test(agents()), "every line ends in \\r\\n");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts.check, "mine");
    assert.ok(fs.existsSync(path.join(root, ".claude/skills/sync/SKILL.md")) && added.includes("tsconfig.json"), added.join());
    assert.deepEqual(init(root), []);
  });

  test("nothing stale survives in gen/", async () => {
    const root = copyOfProject();
    fs.mkdirSync(path.join(root, "gen"));
    fs.writeFileSync(path.join(root, "gen/renamed.ts"), "export const stale = true;\n");
    await check(root);
    assert.deepEqual(fs.readdirSync(path.join(root, "gen")).filter((f) => f.endsWith(".ts")), ["order.ts"]);
  });

  test("a story's text, a definition a rule relies on, here or in an imported spec, and a src contract are each reviewed", () => {
    const root = copyOfProject();
    const items = () => readSpecs(root).flatMap((spec) => pending(root, spec).map((p) => `${p.where.split("  ")[1]}: ${p.status}${p.note ?? ""}`));
    const edit = (file: string, change: (s: string) => string) => fs.writeFileSync(path.join(root, file), change(fs.readFileSync(path.join(root, file), "utf8")));
    assert.deepEqual(items(), []);
    const original = read("spec/order.md");
    edit("spec/order.md", (s) => s.replace("so that I can buy\n> several things in one go.", "so that I can buy\n> many things at once."));
    assert.deepEqual(items(), ["Story: Fill a draft: story changed"]);
    edit("spec/order.md", () => original.replace("pure val unitPrice = 5", "pure val unitPrice = 7"));
    const moved = items();
    assert.ok(moved.includes("Domain / Unit price and order size: model changed"), moved.join("\n"));
    assert.ok(moved.includes("Story: Fill a draft / Items can only be added to a draft: model changed through unitPrice, maxUnits (Domain / Unit price and order size)")
      || moved.includes("Story: Fill a draft / Items can only be added to a draft: model changed through maxUnits, unitPrice (Domain / Unit price and order size)"), moved.join("\n"));
    assert.ok(moved.includes("Story: Fill a draft / The amount due is always the price of the units: model changed through unitPrice (Domain / Unit price and order size)"), moved.join("\n"));
    assert.ok(!moved.some((m) => m.startsWith("Story: Check out / A payment never exceeds the balance")), "a rule that does not use the price is not flagged");

    // Across specs: a change to a library definition flags the rules that use it.
    const shop = fixtures(["lib", "shop"]);
    for (const spec of readSpecs(shop)) acceptReviews(shop, spec);
    fs.writeFileSync(path.join(shop, "spec/lib.md"), read("tools/fixtures/lib.md").replace("acc + x)", "x + acc)"));
    const flagged = readSpecs(shop).flatMap((spec) => pending(shop, spec).map((p) => `${p.where.split("  ")[1]}: ${p.status}${p.note ?? ""}`));
    assert.ok(flagged.includes("Story: Fill a cart / A cart holds lines: model changed through total (spec/lib.md: Sums / The total of a list)"), flagged.join("\n"));

    // The //@ lines of hand-written code: changed, new, and gone, whether the file loses them or is deleted.
    const contract = () => pendingContracts(root).map((p) => `${p.where}: ${p.status}`);
    assert.deepEqual(contract(), []);
    edit("src/ledger.ts", (s) => s.replace("  //@ ensures \\result >= 0\n", ""));
    fs.writeFileSync(path.join(root, "src/extra.ts"), "//@ pure\nexport function one(): number {\n  //@ ensures \\result === 1\n  return 1;\n}\n");
    assert.deepEqual(contract(), ["src/extra.ts: new contract", "src/ledger.ts: contract changed"]);
    acceptContracts(root);
    edit("src/ledger.ts", (s) => s.replace(/^.*\/\/@.*\n/gm, ""));
    fs.rmSync(path.join(root, "src/extra.ts"));
    assert.deepEqual(contract(), ["src/extra.ts: contract removed", "src/ledger.ts: contract removed"]);
  });

  test("accept records a changed story and a changed contract, after which nothing is left to reconcile", async () => {
    const root = copyOfProject("src/ledger.ts", (s) => s.replace("  //@ ensures order.status === \"Paid\" ==> \\result === 0\n", ""));
    fs.writeFileSync(path.join(root, "spec/order.md"), read("spec/order.md").replace("> get my money back.", "> get all my money back."));
    const before = await run(root);
    assert.deepEqual(before.failed, ["review"], before.text);
    assert.ok(before.said("review", /story changed/) && before.said("review", /src\/ledger\.ts\n\s+contract changed/), before.text);
    assert.match(before.next, /npm run accept/);
    await check(root, "reviews");
    const after = await run(root);
    assert.deepEqual(after.failed, [], after.text);
    assert.equal(after.next, "all green");
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

  test("the command line: spec new, the arguments it accepts, gen --if-valid and check --json", async () => {
    const cli = (root: string, ...args: string[]) => new Promise<{ status: number; stdout: string; stderr: string }>((done) =>
      execFile(process.execPath, [path.join(project, "tools/spec.ts"), ...args], { cwd: root, maxBuffer: 1 << 26 }, (e, stdout, stderr) => done({ status: e ? Number(e.code) : 0, stdout, stderr })));
    const root = scratch({});
    assert.equal((await cli(root, "new", "Tally")).status, 1);
    assert.equal((await cli(root, "new", "src")).status, 1);
    assert.equal((await cli(root, "new", "tally")).status, 0);
    assert.match((await cli(root, "new", "tally")).stderr, /spec\/tally\.md already exists/);
    assert.equal((await cli(root, "accept", "unprovd")).status, 2);
    assert.equal((await cli(root, "check", "--everything")).status, 2);
    // The starter spec passes every stage but review, and proves without a proof file.
    const checked = JSON.parse((await cli(root, "check", "--json")).stdout);
    assert.deepEqual([...new Set(checked.results.filter((r: Result) => !r.ok).map((r: Result) => r.stage))], ["review"], JSON.stringify(checked, null, 2));
    for (const stage of ["model", "always", "sometimes", "replay", "proof"]) assert.ok(checked.results.some((r: Result) => r.stage === stage && r.ok), stage);
    assert.match(checked.next, /npm run accept/);
    fs.appendFileSync(path.join(root, "spec/tally.md"), `\n### Broken\n\n${F}quint\npure def\n${F}\n`);
    const lenient = await cli(root, "gen", "--if-valid");
    assert.equal(lenient.status, 0, lenient.stderr);
    assert.match(lenient.stdout, /^note: gen\/ was not generated/);
    assert.equal((await cli(root, "gen")).status, 1);
  });

  test("parseState admits exactly a value with the state's shape that keeps every rule, as a fresh copy", async () => {
    const root = fixtures(["stock", "parcel"]);
    const models = new Map();
    for (const spec of readSpecs(root)) gen(root, spec, models);
    const stock = await import(path.join(root, "gen/stock.ts"));
    const parcel = await import(path.join(root, "gen/parcel.ts"));
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
    assert.deepEqual(parcel.parseState({ tag: "Packed", weight: 1, labels: ["fragile"] }), { tag: "Packed", weight: 1, labels: ["fragile"] });
    for (const x of [{ tag: "Packed", weight: 1, labels: ["a", "a"] }, { tag: "Lost", weight: 1 }, { tag: "Shipped", weight: 1, labels: [], hops: -1 }, { tag: "Gone" }])
      assert.equal(parcel.parseState(x), undefined, JSON.stringify(x));
  });

  test("a fence of any length or kind holds prose, and closes only with its own kind and length", () => {
    const four = "`".repeat(4);
    const root = scratch({ "spec/f.md": `# F\n\n## Story\n\n### Real\n\n${F}quint\npure val a = 1\n${F}\n\n${four}markdown\n### Not a rule\n${F}quint\npure val b = 2\n${F}\n${four}\n\n~~~\n### Nor this\n${F}\n~~~\n\n### Also real\n\n${F}quint\npure val c = 3\n${F}\n` });
    const spec = parseSpec(root, "spec/f.md");
    assert.deepEqual(spec.rules.map((r) => r.key), ["Story / Real", "Story / Also real"]);
    assert.deepEqual(spec.rules.flatMap((r) => r.defs), ["a", "c"]);
    assert.match(spec.rules[0].prose, /### Not a rule[\s\S]*### Nor this/);
  });
});
