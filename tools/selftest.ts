// Does each check catch the kind of mistake it exists for? Every case copies the
// project's spec into a scratch directory, breaks one thing, and asserts which
// stage of `check` fails. Run with `npm run selftest`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { acceptReviews, check, expandListHelpers, gen, init, parseSpec, readSpecs, replay } from "./spec.ts";

const project = path.join(import.meta.dirname, "..");

/** Run `check` on a copy of the project with `edit` applied to one file; return the failed stages. */
async function failedStages(file: string, edit: (text: string) => string, accept = false): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
  for (const dir of ["spec", "src"]) fs.cpSync(path.join(project, dir), path.join(root, dir), { recursive: true });
  // Start from a reconciled spec, whatever is awaiting sign-off in the project itself.
  for (const spec of readSpecs(root)) acceptReviews(root, spec);
  const target = path.join(root, file);
  const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const after = edit(before);
  assert.notEqual(after, before, "the edit must change the file");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, after);
  const lines: string[] = [];
  await check(root, (l) => lines.push(l), accept ? "reviews" : false);
  fs.rmSync(root, { recursive: true });
  return [...new Set(lines.filter((l) => l.startsWith("✗")).map((l) => l.split(/\s+/)[1]))];
}

const door = `# Door

## Domain

### Door

\`\`\`quint
type Mode = Open | Closed | Locked
type Door = { mode: Mode, opened: int, alarm: bool }
pure val initial: Door = { mode: Closed, opened: 0, alarm: false }
\`\`\`

## Story: Use the door

### Anyone can switch the alarm at any time

\`\`\`quint
pure def setAlarm(d: Door, on: bool): Door = { ...d, alarm: on }
\`\`\`

### A locked door must be unlocked before it opens

\`\`\`quint
pure def canMove(d: Door, target: Mode): bool = d.mode != target and not(d.mode == Locked and target == Open)
pure def move(d: Door, target: Mode): Door =
  { ...d, mode: target, opened: if (target == Open) d.opened + 1 else d.opened }
pure def alwaysCountsOpenings(d: Door): bool = d.opened - (0 - 1) > 0 and (d.mode == Open implies d.opened > 0)
pure def sometimesLocked(d: Door): bool = d.mode == Locked and d.alarm
\`\`\`
`;

const F = "`".repeat(3);

/** A scratch project holding the given files. */
function scratch(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

/** Run `check` on a scratch project made of the named fixture specs. */
async function checkFixtures(files: string[]): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
  fs.mkdirSync(path.join(root, "spec"));
  for (const f of files) fs.copyFileSync(path.join(import.meta.dirname, "fixtures", f), path.join(root, "spec", f));
  const lines: string[] = [];
  await check(root, (l) => lines.push(l));
  fs.rmSync(root, { recursive: true });
  return lines;
}

describe("each check catches its own kind of mistake", { concurrency: true }, () => {
  test("a fresh spec with enum and bool parameters and an unguarded transition passes everything but review", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
    fs.mkdirSync(path.join(root, "spec"));
    fs.writeFileSync(path.join(root, "spec/door.md"), door);
    const lines: string[] = [];
    await check(root, (l) => lines.push(l));
    assert.deepEqual(lines.filter((l) => l.startsWith("✗")).map((l) => l.split(/\s+/)[1]), ["review"], lines.join("\n"));
    fs.rmSync(root, { recursive: true });
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

  test("a quint block indented inside a list is still part of the model", async () => {
    const failed = await failedStages("spec/order.md", (s) => s + "\n### Nothing is ever fine\n\n- because:\n\n  ```quint\n  pure def alwaysBogus(o: Order): bool = false\n  ```\n");
    assert.ok(failed.includes("always"), failed.join());
  });

  test("a story with no rules is flagged for translation", async () => {
    const failed = await failedStages("spec/order.md", (s) => s + "\n## Story: Gift wrap\n\n> As a shopper, I want my order wrapped.\n");
    assert.deepEqual(failed, ["review"]);
  });

  test("lists, nested helpers, an imported library, laws, step rules and the proof ledger work together", async () => {
    const F = "`".repeat(3);
    const lib = `# Lib\n\n## Sums\n\n### The total of a list\n\n${F}quint
pure def total(xs: List[int]): int = xs.foldl(0, (acc, x) => acc + x)
pure def lawTheTotalOfOneNumberIsItself(n: int): bool = total(List()) == 0 and total(List(n)) == n
${F}\n`;
    const shop = `# Shop\n\n## Story: Fill a cart\n\n### A cart holds lines\n\n${F}quint
import lib.* from "./lib"
type Line = { sku: str, qty: int, tags: List[str] }
type Cart = { lines: List[Line], count: int }
pure val initial: Cart = { lines: List(), count: 0 }
pure val skuValues = Set("a", "b")
pure def canAdd(c: Cart, sku: str, qty: int): bool = qty > 0 and not(c.lines.some(l => l.sku == sku))
pure def add(c: Cart, sku: str, qty: int): Cart =
  { lines: c.lines.append({ sku: sku, qty: qty, tags: List(sku) }), count: c.count + 1 }
pure def remove(c: Cart, sku: str): Cart = { lines: c.lines.select(l => l.sku != sku), count: c.count }
pure def alwaysQuantitiesArePositive(c: Cart): bool = c.lines.every(l => l.qty > 0)
pure def alwaysEveryTagNamesALine(c: Cart): bool = c.lines.every(l => l.tags.some(t => c.lines.some(m => m.sku == t)))
pure def alwaysTheTotalIsNotNegative(c: Cart): bool = total(c.lines.listMap(l => l.qty)) >= 0
pure def stepTheCountNeverGoesDown(before: Cart, after: Cart): bool = after.count >= before.count
pure def sometimesTwoLines(c: Cart): bool = c.lines.length() == 2
${F}\n`;
    const run = async (edit: (files: Record<string, string>) => void, accept: false | "unproved" = false) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
      const files: Record<string, string> = { "lib.md": lib, "shop.md": shop };
      edit(files);
      fs.mkdirSync(path.join(root, "spec"));
      for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, "spec", name), text);
      const lines: string[] = [];
      if (accept) await check(root, () => {}, accept);
      await check(root, (l) => lines.push(l));
      fs.rmSync(root, { recursive: true });
      return { failed: [...new Set(lines.filter((l) => l.startsWith("✗")).map((l) => l.split(/\s+/)[1]))], text: lines.join("\n") };
    };
    // The nested helpers (some inside some inside every) agree between Quint and TypeScript, and simulation passes.
    const plain = await run(() => {});
    assert.deepEqual(plain.failed, ["proof", "review"], plain.text);
    assert.match(plain.text, /not proved/);
    // Once the unproved obligations are recorded, only the review is left.
    assert.deepEqual((await run(() => {}, "unproved")).failed, ["review"]);
    const wrongStep = await run((f) => { f["shop.md"] = f["shop.md"].replace("count: c.count }", "count: c.count - 1 }"); });
    assert.match(wrongStep.text, /✗ always +a step breaks/);
    const wrongLaw = await run((f) => { f["lib.md"] = f["lib.md"].replace("total(List(n)) == n", "total(List(n)) == n + 1"); });
    assert.match(wrongLaw.text, /✗ always +the law .* is false for \{"n":/);
    const importsMachine = await run((f) => { f["other.md"] = `# Other\n\n## Group\n\n### Uses a machine\n\n${F}quint\nimport shop.* from "./shop"\npure val two = 2\n${F}\n`; });
    assert.match(importsMachine.text, /is imported under a name/);
    const circle = await run((f) => { f["lib.md"] = f["lib.md"].replace("pure def total", 'import shop.* from "./shop"\npure def total'); });
    assert.match(circle.text, /import each other in a circle/);
  });

  test("list helpers are expanded into built-in folds, innermost first, without moving a line", () => {
    const out = expandListHelpers("pure def f(xs: List[T]): bool =\n  xs.every(t => t.ps.some(p =>\n    p == t.id))\n// xs.some(note in prose)");
    assert.equal(out.split("\n").length, 4);
    assert.ok(!/\.(every|some)\(/.test(out.split("\n").slice(0, 3).join("\n")), out);
    assert.match(out, /std_every_\d+ and/);
    assert.match(out, /std_some_\d+ or/);
    assert.match(out, /\/\/ xs\.some\(note in prose\)$/);
  });

  test("a state whose stages carry different data, with match and sets, is simulated, replayed and fully proved", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
    fs.mkdirSync(path.join(root, "spec"));
    fs.copyFileSync(path.join(import.meta.dirname, "fixtures/parcel.md"), path.join(root, "spec/parcel.md"));
    const lines: string[] = [];
    await check(root, (l) => lines.push(l));
    assert.deepEqual(lines.filter((l) => l.startsWith("✗")).map((l) => l.split(/\s+/)[1]), ["review"], lines.join("\n"));
    assert.match(lines.join("\n"), /✓ proof +parcel\.ts: all \d+ obligations proved/);
    const generated = fs.readFileSync(path.join(root, "gen/parcel.ts"), "utf8");
    assert.match(generated, /\| \{ tag: "Shipped"; weight: number; labels: string\[\]; hops: number \}/);
    fs.rmSync(root, { recursive: true });
  });

  test("a machine built from a component states and proves a rule that spans two of them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
    fs.mkdirSync(path.join(root, "spec"));
    for (const f of ["account.md", "bank.md"]) fs.copyFileSync(path.join(import.meta.dirname, "fixtures", f), path.join(root, "spec", f));
    const lines: string[] = [];
    await check(root, (l) => lines.push(l));
    assert.deepEqual([...new Set(lines.filter((l) => l.startsWith("✗")).map((l) => l.split(/\s+/)[1]))], ["review"], lines.join("\n"));
    assert.match(lines.join("\n"), /spec\/bank\.md: 2 transitions, 1 always, 1 step, 1 sometimes/);
    fs.rmSync(root, { recursive: true });
  });

  test("one machine uses another under a name, keeps its rules, and adds rules about the pair", async () => {
    const lines = await checkFixtures(["lamp.md", "room.md"]);
    assert.deepEqual([...new Set(lines.filter((l) => l.startsWith("✗")).map((l) => l.split(/\s+/)[1]))], ["review"], lines.join("\n"));
    assert.match(lines.join("\n"), /✓ proof +room\.ts: all \d+ obligations proved/);
  });

  test("a map is looked up safely, and division and remainder agree with Quint for negative numbers", async () => {
    const lines = await checkFixtures(["stock.md"]);
    const text = lines.join("\n");
    assert.deepEqual([...new Set(lines.filter((l) => l.startsWith("✗")).map((l) => l.split(/\s+/)[1]))], ["proof", "review"], text);
    assert.match(text, /✓ replay .* every law, and \d+ definitions/);
    assert.ok(!/lawBoxesAndLooseMakeTheWhole/.test(text), "the division law is proved, so it is not listed as unproved");
  });

  test("replay notices a definition whose TypeScript result differs from Quint's", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
    fs.cpSync(path.join(project, "spec"), path.join(root, "spec"), { recursive: true });
    const model = gen(root, parseSpec(root, "spec/order.md"));
    const domain = await import(path.join(root, "gen/order.ts"));
    assert.ok(model.evals.some((v) => v.name === "canSubmit"), "guards are among the definitions compared");
    const evaluated = (result: boolean) => [{ state: domain.initial }, { evaluated: { name: "canSubmit", picks: {}, result } }];
    replay(domain, evaluated(false), model);
    assert.throws(() => replay(domain, evaluated(true), model), /disagree on canSubmit/);
    assert.throws(() => replay({ ...domain, canSubmit: () => true }, evaluated(false), model), /disagree on canSubmit/);
    fs.rmSync(root, { recursive: true });
  });

  test("a rule heading cannot become code", async () => {
    const lines: string[] = [];
    const root = scratch({ "spec/counter.md": `# Counter\n\n## Story\n\n### A counter */ globalThis.INJECTED = true; /* starts at zero\n\n${F}quint\npure val initial: int = 0\npure def bump(n: int): int = n + 1\n${F}\n` });
    await check(root, (l) => lines.push(l));
    assert.equal((globalThis as any).INJECTED, undefined, "the heading ran as code");
    assert.match(lines.join("\n"), /✓ replay/);
    fs.rmSync(root, { recursive: true });
  });

  test("a proof cannot be forged from inside the project", async () => {
    const notInductive = (s: string) => s.replace(/### Drafts and cancelled orders hold no money[\s\S]*?```\n\n/, "");
    const project = (files: Record<string, string>) => {
      const root = scratch(files);
      fs.cpSync(path.join(import.meta.dirname, "../spec"), path.join(root, "spec"), { recursive: true });
      fs.writeFileSync(path.join(root, "spec/order.md"), notInductive(fs.readFileSync(path.join(root, "spec/order.md"), "utf8")));
      return root;
    };
    const proofLines = async (root: string) => {
      const lines: string[] = [];
      await check(root, (l) => lines.push(l));
      fs.rmSync(root, { recursive: true });
      return lines.filter((l) => l.includes(" proof ")).join("\n");
    };
    // A file in src/ named after the spec does not take the place of the spec's own proof.
    assert.match(await proofLines(project({ "src/order.ts": "//@ pure\nexport function one(): number {\n  return 1;\n}\n" })), /✗ proof +order\.ts: \d+ of \d+ obligations not proved/);
    // A LemmaScript configuration in the project cannot point the proof at files someone could edit.
    assert.match(await proofLines(project({ "lemmascript.json": `{"proof-dir":"proofs"}` })), /✗ proof +order\.ts: \d+ of \d+ obligations not proved/);
    // An annotation that asks the prover for trust is refused wherever it sits on the line.
    const ledger = fs.readFileSync(path.join(import.meta.dirname, "../src/ledger.ts"), "utf8");
    const sneaky = ledger.replace("return order.due - order.paid;", "/* x */ //@ assume false\n  return order.paid - order.due;");
    assert.match(await proofLines(scratch({ "spec/order.md": fs.readFileSync(path.join(import.meta.dirname, "../spec/order.md"), "utf8"), "src/ledger.ts": sneaky })), /`\/\/@ assume` is not allowed/);
    // So is an import of anything but a generated module, however it is indented.
    const lying = ledger.replace("\n/** Rebuild", '\n  import { owed } from "/tmp/lies.ts";\n/** Rebuild');
    assert.match(await proofLines(scratch({ "spec/order.md": fs.readFileSync(path.join(import.meta.dirname, "../spec/order.md"), "utf8"), "src/ledger.ts": lying })), /may only import generated modules/);
  });

  test("list helpers are not rewritten inside strings or comments, and a stray parenthesis is an error, not a hang", () => {
    const kept = 'pure val note = "xs.some(y)" // xs.every(z)\npure def f(xs: List[int]): bool = xs.some(x => x > 0)';
    const out = expandListHelpers(kept);
    assert.ok(out.includes('"xs.some(y)" // xs.every(z)'), out);
    assert.match(out, /xs\.foldl\(false, \(std_some_\d+, x\)/);
    assert.throws(() => expandListHelpers("pure def f(xs: List[int]): bool = xs.every(x => x > 0 // oops"), /no closing parenthesis/);
  });

  test("moving a line break so that a comment swallows half a guard is a change to the model", async () => {
    const failed = await failedStages("spec/order.md", (s) => s.replace("pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 and o.units + qty <= maxUnits",
      "pure def canAddItem(o: Order, qty: int): bool =\n  o.status == Draft and qty > 0 // and\n  and o.units + qty <= maxUnits").replace("// and\n  and", "// and"));
    assert.ok(failed.includes("review"), failed.join());
  });

  test("names and constructs that would be translated wrongly are refused", async () => {
    const spec = (body: string) => ({ "spec/t.md": `# T\n\n## Story\n\n### A rule\n\n${F}quint\n${body}\n${F}\n` });
    const refused: [string, string, RegExp][] = [
      ["a type named like a generated one", "type Event = { n: int }\npure val initial: Event = { n: 0 }", /cannot be used as a name/],
      ["a definition named like a JavaScript global", "pure val initial: int = 0\npure def Number(n: int): int = n", /cannot be used as a name/],
      ["a set of two computed members", "pure val initial: int = 0\npure def pair(a: int, b: int): int = Set(a, b).size()", /could hold the same value twice/],
      ["a variant field called tag", "type P = A({ tag: int }) | B\npure val initial: int = 0", /cannot be called `tag`/],
      ["a match binder used as a whole value", "type N = { n: int }\ntype P = A(N) | B\npure val initial: int = 0\npure def g(r: N): int = r.n\npure def f(p: P): int = match p { | A(x) => g(x) | _ => 0 }", /is what a match arm carries/],
    ];
    for (const [what, body, message] of refused) {
      const root = scratch(spec(body));
      const lines: string[] = [];
      await check(root, (l) => lines.push(l));
      fs.rmSync(root, { recursive: true });
      assert.match(lines.join("\n"), /✗ model/, what);
      assert.match(lines.join("\n"), message, what);
    }
  });

  test("a map key that every object has, a getter on an event, and an extra field are all harmless", async () => {
    const root = scratch({ "spec/stock.md": fs.readFileSync(path.join(import.meta.dirname, "fixtures/stock.md"), "utf8") });
    gen(root, parseSpec(root, "spec/stock.md"));
    const stock = await import(path.join(root, "gen/stock.ts"));
    const received = stock.step(stock.initial, stock.parseEvent({ type: "receive", sku: "constructor", qty: 1 }));
    assert.equal(stock.level(received, "constructor"), 1);
    assert.equal(stock.level(received, "toString"), 0);
    let reads = 0;
    const event = stock.parseEvent({ type: "receive", sku: "a", get qty() { return reads++ ? 1000 : 2; }, extra: 1 });
    assert.deepEqual(event, { type: "receive", sku: "a", qty: 2 });
    assert.equal(stock.parseEvent({ type: "receive", sku: "a", qty: 1.5 }), undefined);
    fs.rmSync(root, { recursive: true });
  });

  test("init adds what a project lacks and replaces nothing", () => {
    const root = scratch({ "AGENTS.md": "mine\n", "package.json": `{"scripts":{"check":"mine"}}` });
    const added = init(root);
    assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "mine\n");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts.check, "mine");
    assert.ok(fs.existsSync(path.join(root, ".claude/skills/sync/SKILL.md")) && added.includes("tsconfig.json"), added.join());
    assert.deepEqual(init(root), []);
    fs.rmSync(root, { recursive: true });
  });

  test("nothing stale survives in gen/", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
    fs.cpSync(path.join(project, "spec"), path.join(root, "spec"), { recursive: true });
    fs.mkdirSync(path.join(root, "gen"));
    fs.writeFileSync(path.join(root, "gen/renamed.ts"), "export const stale = true;\n");
    await check(root, () => {});
    assert.deepEqual(fs.readdirSync(path.join(root, "gen")).filter((f) => f.endsWith(".ts")), ["order.ts"]);
    fs.rmSync(root, { recursive: true });
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

  test("TypeScript that diverges from the Quint model is caught by replay", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
    fs.cpSync(path.join(project, "spec"), path.join(root, "spec"), { recursive: true });
    gen(root, parseSpec(root, "spec/order.md"));
    const domain = await import(path.join(root, "gen/order.ts"));
    const trace = [{ state: domain.initial }, ...[{ type: "addItem", qty: 1 }, { type: "submit" }, { type: "pay", amount: 2 }]
      .map((event, i, all) => ({ event, state: all.slice(0, i + 1).reduce(domain.step, domain.initial) }))];
    replay(domain, trace);
    const broken = { ...domain, step: (s: any, e: any) => (e.type === "pay" ? { ...domain.step(s, e), status: "Paid" } : domain.step(s, e)) };
    assert.throws(() => replay(broken, trace), /TypeScript and Quint disagree/);
    fs.rmSync(root, { recursive: true });
  });
});
