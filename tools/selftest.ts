// Does each check catch the kind of mistake it exists for? Every case copies the
// project's spec into a scratch directory, breaks one thing, and asserts which
// stage of `check` fails. Run with `npm run selftest`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { check, expandListHelpers, gen, parseSpec, replay } from "./spec.ts";

const project = path.join(import.meta.dirname, "..");

/** Run `check` on a copy of the project with `edit` applied to one file; return the failed stages. */
async function failedStages(file: string, edit: (text: string) => string, accept = false): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
  for (const dir of ["spec", "src"]) fs.cpSync(path.join(project, dir), path.join(root, dir), { recursive: true });
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
    const failed = await failedStages("spec/order.md", (s) => s.replace("pure val unitPrice = 5", "pure val unitPrice = Set(5).size()"));
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

  test("sync hands failures to the agent round by round and stops at the human's sign-off", () => {
    // A scripted stand-in for the agent: it formalizes the story carelessly, then repairs what the check reports.
    const agent = `
      import fs from "node:fs";
      const report = fs.readFileSync(0, "utf8");
      let spec = fs.readFileSync("spec/order.md", "utf8");
      if (report.includes("story has no rules"))
        spec += "\\n### An order can be gift wrapped for a fee\\n\\n\\\`\\\`\\\`quint\\npure def wrap(o: Order): Order = { ...o, due: o.due + 1 }\\n\\\`\\\`\\\`\\n";
      else if (report.includes("✗ always")) spec = spec.replace("due: o.due + 1", "due: o.due");
      fs.writeFileSync("spec/order.md", spec);`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
    for (const dir of ["spec", "src"]) fs.cpSync(path.join(project, dir), path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, "agent.mjs"), agent);
    fs.appendFileSync(path.join(root, "spec/order.md"), "\n## Story: Gift wrap\n\n> As a shopper, I want my order wrapped.\n");
    const run = spawnSync(process.execPath, [path.join(project, "tools/spec.ts"), "sync"], { cwd: root, encoding: "utf8", env: { ...process.env, SPEC_AGENT: "node agent.mjs" } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /round 1: review/);
    assert.match(run.stdout, /round 2: always, review/);
    assert.match(run.stdout, /synced: read the changes/);
    assert.match(fs.readFileSync(path.join(root, "spec/order.md"), "utf8"), /due: o\.due \}/);
    assert.ok(!fs.readFileSync(path.join(root, "spec/order.lock.json"), "utf8").includes("gift wrapped"), "sync must not accept on the person's behalf");
    fs.rmSync(root, { recursive: true });
  });

  test("the local-model agent turns a brief into edits: rules for a story, prose for a changed model", async () => {
    const F = "`".repeat(3);
    // A canned stand-in for Ollama, so the adapter's parsing and editing are tested without a model.
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c)).on("end", () => {
        const prompt: string = JSON.parse(body).prompt;
        const response = prompt.includes("has no rules yet")
          ? `### ### A cancelled order can be archived\n\n${F}quint\npure def canArchive(o: Order): bool = o.status == Cancelled\npure def archive(o: Order): Order = { ...o, units: 0, due: 0 }\n${F}`
          : `${F}\nEvery unit costs the same, and one order holds at most 7 units.\n${F}`;
        res.end(JSON.stringify({ response }));
      });
    });
    await new Promise<void>((done) => server.listen(0, done));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
    fs.cpSync(path.join(project, "spec"), path.join(root, "spec"), { recursive: true });
    const specFile = path.join(root, "spec/order.md");
    fs.appendFileSync(specFile, "\n## Story: Archive\n\n> As a shopper, I want cancelled orders out of my way.\n");
    const prose = "Every unit costs the same, and one order holds at most 40 units.";
    const brief = `✗ review    2 item(s)\n    spec/order.md:210  Story: Archive\n      story has no rules: write them\n\n`
      + `RULE "Domain / Unit price and order size" (model changed)\nits prose now:\n${prose}\nits Quint now:\npure val maxUnits = 7\nEND RULE\n`;
    const agent = spawn(process.execPath, [path.join(project, "tools/agent-ollama.ts")],
      { cwd: root, env: { ...process.env, OLLAMA_HOST: `http://localhost:${(server.address() as AddressInfo).port}` } });
    agent.stdin.end(brief);
    let out = "";
    agent.stdout.on("data", (c) => (out += c));
    agent.stderr.on("data", (c) => (out += c));
    const status = await new Promise((done) => agent.on("close", done));
    server.close();
    const after = fs.readFileSync(specFile, "utf8");
    assert.equal(status, 0, out);
    assert.match(out, /made 2 edit/);
    assert.match(after, /## Story: Archive\n\n> As a shopper.*\n\n### A cancelled order can be archived\n\n```quint\npure def canArchive/);
    assert.ok(after.includes("at most 7 units.") && !after.includes(prose));
    fs.rmSync(root, { recursive: true });
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
    assert.match(importsMachine.text, /only a library/);
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

  test("with no model at all, sync turns a counterexample into a rule that passes simulation and proof", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-selftest-"));
    fs.cpSync(path.join(project, "spec"), path.join(root, "spec"), { recursive: true });
    const file = path.join(root, "spec/order.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("o.status == Pending and amount > 0 and o.paid + amount <= o.due", "o.status == Pending and amount > 0"));
    const run = spawnSync(process.execPath, [path.join(project, "tools/spec.ts"), "sync"], { cwd: root, encoding: "utf8", env: { ...process.env, SPEC_AGENT: `node ${path.join(project, "tools/agent-lookahead.ts")}` } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /a rule that would forbid it: refuse pay when its result would break alwaysPaidWithinDue/);
    assert.match(run.stdout, /✓ proof +order\.ts/);
    assert.match(run.stdout, /synced: read the changes/);
    const after = fs.readFileSync(file, "utf8");
    assert.match(after, /### Pay is refused when it would break "paid within due"\n\nDiscovered by simulation/);
    assert.match(after, /pure def payKeepsPaidWithinDue\(o: Order, amount: int\): bool = alwaysPaidWithinDue\(pay\(o, amount\)\)/);
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
