// Does each check catch the kind of mistake it exists for? Every case builds a
// scratch project, from this project's own spec or from the small specs in
// tools/fixtures/, breaks one thing, and asserts which stage of `check` fails.
// Run with `npm run selftest`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { acceptReviews, check, expandListHelpers, gen, init, parseSpec, readSpecs, replay, show, type Result } from "./spec.ts";

const project = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(project, file), "utf8");
const F = "`".repeat(3);
const roots: string[] = [];
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

/** A scratch project holding the given files. */
function scratch(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
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
  for (const dir of ["spec", "src"]) fs.cpSync(path.join(project, dir), path.join(root, dir), { recursive: true });
  for (const spec of readSpecs(root)) acceptReviews(root, spec);
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
  const { results } = await check(root, accept);
  const text = results.map(show).join("\n");
  return {
    text,
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

  test("a missing guard is found by simulation, as a trace", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace("o.status == Draft and o.units > 0", "o.status == Draft"));
    assert.ok(failed.includes("always"), failed.join());
  });

  test("a rule set that holds in simulation but is not inductive is caught by the proof", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace(/### Drafts and cancelled orders hold no money[\s\S]*?```\n\n/, ""));
    assert.deepEqual(failed, ["proof", "review"]); // simulation passes; the deletion itself also awaits review
  });

  test("rules too strict to ever reach a goal are caught by a `sometimes` rule", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace("o.paid + amount <= o.due", "o.paid + amount < o.due"));
    assert.ok(failed.includes("sometimes"), failed.join());
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
    const recorded = shop();
    await check(recorded, "unproved");
    assert.deepEqual((await run(recorded)).failed, ["review"]);
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
    assert.ok(!/lawBoxesAndLooseMakeTheWhole/.test(text), "the division law is proved, so it is not listed as unproved");
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

  test("verified code cannot assume, or import a look-alike of the generated module", async () => {
    const assumed = await failedStages("src/ledger.ts", (s) => s.replace("return order.due - order.paid;", "//@ assume false\n  return order.paid - order.due;"));
    assert.deepEqual(assumed, ["proof"]);
    const lookalike = await failedStages("src/ledger.ts", (s) => s.replace('"../gen/order.ts"', '"./order.ts"'));
    assert.deepEqual(lookalike, ["proof"]);
  });

  test("verified code in a subdirectory of src is proved too", async () => {
    const failed = await failedStages("src/deep/owed.ts", () => 'import { type Order } from "../../gen/order.ts";\n//@ pure\nexport function owed(o: Order): number {\n  //@ ensures \\result > 0\n  return o.due - o.paid;\n}\n');
    assert.deepEqual(failed, ["proof"]);
  });

  test("hand-written logic that breaks its contract is caught by the proof", async () => {
    const failed = await failedStages("src/ledger.ts", (s) => s.replace("return order.due - order.paid;", "return order.paid - order.due;"));
    assert.deepEqual(failed, ["proof"]);
  });

  test("moving a line break so that a comment swallows half a guard is a change to the model", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace("pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 and o.units + qty <= maxUnits",
      "pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 // and o.units + qty <= maxUnits"));
    assert.ok(failed.includes("review"), failed.join());
  });

  test("a deleted rule is flagged for review", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace(/### An order can be cancelled[\s\S]*$/, ""));
    assert.deepEqual(failed, ["review"]);
  });

  test("accept records nothing while another stage fails, and records when all pass", async () => {
    const reworded = (s: string) => s.replace("Every unit costs the same", "Each unit has one price");
    assert.deepEqual(await failedStages("spec/order.md", reworded, true), []);
    const failed = await failedStages("spec/order.md", (s) => reworded(s).replace("o.status == Draft and o.units > 0", "o.status == Draft"), true);
    assert.deepEqual(failed, ["always", "review"]);
  });

  test("init adds what a project lacks and replaces nothing", () => {
    const root = scratch({ "AGENTS.md": "mine\n", "package.json": `{"scripts":{"check":"mine"}}` });
    const added = init(root);
    assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "mine\n");
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
});
