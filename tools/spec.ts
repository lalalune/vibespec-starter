#!/usr/bin/env node
// The whole pipeline: spec/*.md -> Quint model -> TypeScript -> proofs.
//
//   node tools/spec.ts gen      tangle the specs and generate gen/<name>.ts
//   node tools/spec.ts check    gen, then run every check (see README)
//   node tools/spec.ts sync     check, hand what fails to an agent to translate
//                               (story -> rules -> Quint -> prose), and repeat
//   node tools/spec.ts brief    print what sync would hand to the agent
//   node tools/spec.ts accept   check, and if all else passes, record that the
//                               prose and model of every rule have been reconciled

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { generate, type Model, type Origin } from "./gen.ts";

const BIN = path.join(import.meta.dirname, "../node_modules/.bin");
const SAMPLES = 10000; // simulated traces per check
const STEPS = 20; // events per trace
const REPLAYED = 50; // of those, how many are replayed through the generated TypeScript
const ANNOTATIONS = ["backend", "pure", "requires", "ensures", "invariant", "decreases", "type", "ghost", "assert"];

// --- the spec file -----------------------------------------------------------

export interface Rule { key: string; line: number; prose: string; code: string; defs: string[] }
export interface Spec { name: string; file: string; rules: Rule[]; stories: { title: string; line: number }[]; qnt: string }

/**
 * A spec is Markdown. `##` starts a story (or any grouping), `###` starts a
 * rule, and the ```quint blocks under a rule are its formal half. Tangling
 * keeps every line on its own line number, so Quint errors point into the
 * Markdown file.
 */
export function parseSpec(root: string, file: string): Spec {
  const name = path.basename(file, ".md");
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw new Error(`${file}: a spec's file name becomes a module name, so it must look like \`order.md\` or \`orderBook.md\``);
  const rules: Rule[] = [];
  const stories: Spec["stories"] = [];
  const qnt: string[] = [];
  let story = "";
  let rule: Rule | undefined;
  let inQuint = false;
  let inOther = false;
  fs.readFileSync(path.join(root, file), "utf8").split("\n").forEach((text, i) => {
    const fence = text.match(/^\s*```\s*(\w*)/);
    if (fence && !inOther && !inQuint && fence[1] !== "quint") inOther = true;
    else if (fence && inOther) inOther = false;
    else if (fence) {
      if (!rule) throw new Error(`${file}:${i + 1}: a quint block must sit under a ### rule`);
      inQuint = !inQuint;
    } else if (inQuint) {
      rule!.code += text + "\n";
      const def = text.match(/^\s*(?:pure\s+)?(?:def|val|type)\s+(\w+)/);
      if (def) rule!.defs.push(def[1]);
      qnt.push(text);
      return;
    } else if (!inOther && text.startsWith("## ")) {
      story = text.slice(3).trim();
      stories.push({ title: story, line: i + 1 });
      rule = undefined;
    } else if (!inOther && text.startsWith("### ")) {
      rule = { key: `${story} / ${text.slice(4).trim()}`, line: i + 1, prose: "", code: "", defs: [] };
      if (rules.some((r) => r.key === rule!.key)) throw new Error(`${file}:${i + 1}: duplicate rule "${rule.key}"`);
      rules.push(rule);
    } else if (rule) rule.prose += text + "\n";
    qnt.push(i === 0 ? `module ${name} { // ${text}` : text ? `// ${text}` : "");
  });
  return { name, file, rules, stories, qnt: qnt.join("\n") + "\n}\n" };
}

// --- review ledger: has anyone confirmed that prose and model still agree? ----

const hash = (s: string) => createHash("sha256").update(s.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
const lockFile = (root: string, spec: Spec) => path.join(root, spec.file.replace(/\.md$/, ".lock.json"));
const fingerprint = (r: Rule): [string, string] => [hash(r.prose), hash(r.code)];

/** Rules whose prose or model changed since `accept`, with what to do about each. */
export function pending(root: string, spec: Spec): string[] {
  const file = lockFile(root, spec);
  const lock: Record<string, [string, string]> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const out: string[] = [];
  for (const s of spec.stories)
    if (!spec.rules.some((r) => r.key.startsWith(`${s.title} / `))) out.push(`${spec.file}:${s.line}  ${s.title}\n      story has no rules: write one ### rule for each thing the story requires`);
  for (const r of spec.rules) {
    const [prose, code] = fingerprint(r);
    const was = lock[r.key];
    const where = `${spec.file}:${r.line}  ${r.key}`;
    if (!r.code.trim()) out.push(`${where}\n      not formalized: add a quint block that says what the prose says`);
    else if (!was) out.push(`${where}\n      new: confirm the prose and the model say the same thing`);
    else if (was[0] !== prose && was[1] !== code) out.push(`${where}\n      prose and model both changed: confirm they still agree`);
    else if (was[0] !== prose) out.push(`${where}\n      prose changed: update the model to match, or confirm it already does`);
    else if (was[1] !== code) out.push(`${where}\n      model changed: update the prose to match, or confirm it already does`);
  }
  for (const key of Object.keys(lock))
    if (!spec.rules.some((r) => r.key === key)) out.push(`${spec.file}  ${key}\n      removed or renamed: confirm the rule is meant to be gone`);
  return out;
}

function accept(root: string, spec: Spec) {
  // One rule per line, so a diff of the ledger shows exactly which rules were re-reviewed.
  const lines = spec.rules.map((r) => `  ${JSON.stringify(r.key)}: ${JSON.stringify(fingerprint(r))}`);
  fs.writeFileSync(lockFile(root, spec), `{\n${lines.join(",\n")}\n}\n`);
}

// --- running tools -------------------------------------------------------------

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync(path.join(BIN, cmd), args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ?? ""}` };
}

/** Tangle, typecheck and generate. Throws with a message that points into the spec. */
export function gen(root: string, spec: Spec): Model {
  const dir = path.join(root, "gen");
  const out = path.join(dir, `${spec.name}.ir.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${spec.name}.qnt`), spec.qnt);
  const typed = run("quint", ["typecheck", "--out", out, `gen/${spec.name}.qnt`], root);
  const ir = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { errors: [] };
  fs.rmSync(out, { force: true });
  // Tangling keeps line numbers, so Quint's locations are locations in the Markdown.
  const errors = ir.errors.map((e: any) => `${spec.file}:${e.locs[0].start.line + 1}:${e.locs[0].start.col + 1}  ${e.explanation}`);
  if (!typed.ok) throw new Error(errors.join("\n") || typed.out);
  const origins = new Map<string, Origin>();
  for (const r of spec.rules) for (const d of r.defs) origins.set(d, { rule: r.key, line: r.line });
  const model = generate(ir, spec.name, spec.file, (d) => origins.get(d));
  fs.writeFileSync(path.join(dir, `${spec.name}.ts`), model.ts);
  fs.writeFileSync(path.join(dir, `${spec.name}.run.qnt`), model.harness);
  return model;
}

// --- traces: Quint simulates, the generated TypeScript must agree -------------------

interface Step { event?: { type: string }; state: unknown }

const decode = (v: any): any => {
  if (v === null || typeof v !== "object") return v;
  if ("#bigint" in v) return Number(v["#bigint"]);
  if ("tag" in v && "value" in v) return v.tag;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
};

function readTrace(file: string, model: Model): Step[] {
  return JSON.parse(fs.readFileSync(file, "utf8")).states.map((st: any, i: number): Step => {
    const t = model.transitions.find((t) => t.name === st["mbt::actionTaken"]);
    if (i > 0 && !t) throw new Error(`${file}: unknown action ${st["mbt::actionTaken"]}`);
    const event = t && { type: t.name, ...Object.fromEntries(t.params.map((p) => [p.name, decode(st["mbt::nondetPicks"][p.name].value)])) };
    return { event, state: decode(st.state) };
  });
}

/** Simulate the harness until `invariant` breaks; returns the traces Quint wrote. */
function simulate(root: string, model: Model, name: string, invariant: string, traces: number): { broken: boolean; traces: Step[][] } {
  const dir = path.join(root, "gen/traces", `${name}.${invariant}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = run("quint", ["run", `gen/${name}.run.qnt`, "--main", `${name}_run`, "--invariant", invariant,
    "--max-samples", String(SAMPLES), "--max-steps", String(STEPS), "--mbt", "--n-traces", String(traces),
    "--out-itf", path.join(dir, "{seq}.itf.json")], root);
  const broken = r.out.includes("[violation]");
  const files = fs.readdirSync(dir);
  // Anything other than "held" or "violated", each with a trace, is Quint failing to run.
  if ((!r.ok && !broken) || !files.length) throw new Error(`quint run did not complete:\n${r.out.trim()}`);
  return { broken, traces: files.map((f) => readTrace(path.join(dir, f), model)) };
}

/** Replay one Quint trace through the TypeScript domain; throws at the first difference. */
export function replay(domain: any, trace: Step[]) {
  const differ = (what: string) => new Error(`TypeScript and Quint disagree ${what}`);
  let s = domain.initial;
  for (const { event, state } of trace) {
    if (event) {
      if (!domain.enabled(s, event)) throw differ(`on whether ${JSON.stringify(event)} is allowed in ${JSON.stringify(s)}`);
      s = domain.step(s, event);
    }
    if (!isDeepStrictEqual(s, state)) throw differ(`after ${JSON.stringify(event ?? "init")}: TypeScript reached ${JSON.stringify(s)}, Quint reached ${JSON.stringify(state)}`);
  }
}

const showTrace = (trace: Step[]) =>
  trace.map(({ event, state }) => `      ${(event ? JSON.stringify(event) : "initial").padEnd(30)} -> ${JSON.stringify(state)}`).join("\n");

// --- proofs ----------------------------------------------------------------------

/**
 * LemmaScript verifies one file at a time, so hand-written code that carries
 * `//@` annotations is proved in a bundle: the generated modules it imports,
 * followed by the file itself. Generated modules are proved first, on their own.
 */
function proofUnits(root: string, names: string[]): string[] {
  const dir = path.join(root, "gen/proof");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const generated = (n: string) => fs.readFileSync(path.join(root, `gen/${n}.ts`), "utf8");
  for (const n of names) fs.writeFileSync(path.join(dir, `${n}.ts`), generated(n));
  const units = names.map((n) => `${n}.ts`);
  const src = path.join(root, "src");
  const files = fs.existsSync(src) ? (fs.readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).sort() : [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, f), "utf8");
    const used = [...text.matchAll(/^\s*\/\/@ (\w+)/gm)].map((m) => m[1]);
    if (!used.length) continue;
    // Annotations that tell the prover to trust or skip something are not proofs.
    const refused = used.filter((k) => !ANNOTATIONS.includes(k));
    if (refused.length) throw new Error(`src/${f}: \`//@ ${refused[0]}\` is not allowed; verified code may only use ${ANNOTATIONS.join(", ")}`);
    const imports = /^import\b[^;]*?from\s+["']([^"']+)["'];?[ \t]*\n/gm;
    const deps = [...text.matchAll(imports)].map((m) => {
      const target = path.resolve(src, path.dirname(f), m[1]);
      const name = names.find((n) => target === path.join(root, `gen/${n}.ts`));
      if (!name) throw new Error(`src/${f}: verified code may only import generated modules (gen/<name>.ts), not ${m[1]}`);
      return name;
    });
    const unit = f.replaceAll(path.sep, "_");
    fs.writeFileSync(path.join(dir, unit), [...deps.map(generated), `// ---- src/${f} ----`, text.replace(imports, "")].join("\n"));
    units.push(unit);
  }
  return units;
}

/** What Dafny could not prove, one line each, in terms of the TypeScript annotations. */
function unproved(out: string): string[] {
  const found = new Set<string>();
  const lines = out.split("\n");
  const quoted = (from: number) => lines.slice(from, from + 4).map((l) => l.match(/^\s*\d+ \|\s*(.*)$/)?.[1]).find(Boolean) ?? "";
  lines.forEach((l, i) => {
    if (l.includes("this is the postcondition that could not be proved")) found.add(quoted(i).replace(/^ensures /, ""));
    else if (l.includes("Error:") && !l.includes("a postcondition could not be proved")) found.add(`${l.split("Error: ")[1]}: ${quoted(i)}`);
  });
  return [...found];
}

// --- check -------------------------------------------------------------------------

/**
 * Run every check, cheapest first. Stages after a broken model are skipped,
 * because their failures would only restate the first one.
 */
export async function check(root: string, log: (line: string) => void = console.log, acceptReviewed = false): Promise<boolean> {
  let allOk = true;
  const report = (ok: boolean, stage: string, summary: string, detail = "") => {
    allOk &&= ok;
    log(`${ok ? "✓" : "✗"} ${stage.padEnd(9)} ${summary}${!ok && detail ? "\n" + detail.trimEnd() : ""}`);
    return ok;
  };
  const indent = (s: string) => s.split("\n").map((l) => "      " + l).join("\n");
  fs.rmSync(path.join(root, "gen"), { recursive: true, force: true }); // nothing stale survives a rename
  let specs: Spec[];
  try {
    specs = readSpecs(root);
  } catch (e) {
    return report(false, "model", (e as Error).message);
  }
  const valid: Spec[] = [];

  for (const spec of specs) {
    const cite = (def: string) => {
      const rule = spec.rules.find((r) => r.defs.includes(def));
      return rule ? `"${rule.key}" (${spec.file}:${rule.line})` : def;
    };
    let model: Model;
    let domain: any;
    try {
      model = gen(root, spec);
      domain = await import(`${pathToFileURL(path.join(root, `gen/${spec.name}.ts`))}?t=${Date.now()}`);
    } catch (e) {
      report(false, "model", `${spec.file} is not a valid model`, indent((e as Error).message.trim()));
      continue;
    }
    valid.push(spec);
    report(true, "model", `${spec.file}: ${model.transitions.length} transitions, ${model.always.length} always, ${model.sometimes.length} sometimes`);
    try {
      const sim = simulate(root, model, spec.name, "inv", REPLAYED);
      const last = (t: Step[]) => t[t.length - 1].state;
      const bad = sim.traces.find((t) => !domain.inv(last(t)));
      if (sim.broken || bad) {
        const broken = bad ? model.always.filter((a) => !domain[a](last(bad))).map(cite).join(", ") : "a rule";
        const lastEvent = bad?.[bad.length - 1].event?.type;
        const guard = model.transitions.find((t) => t.name === lastEvent)?.guard;
        const hint = lastEvent ? `\n      the last event is ${cite(lastEvent)}${guard ? `; its guard ${guard} let it through` : "; it has no guard"}` : "";
        report(false, "always", `a reachable state breaks ${broken}: fix the model, or add the rule that forbids this trace`, bad ? showTrace(bad) + hint : "");
        continue;
      }
      report(true, "always", `no rule broken in ${SAMPLES} simulated traces`);
      const traces = sim.traces;
      for (const w of model.sometimes) {
        const found = simulate(root, model, spec.name, `never_${w}`, 1);
        report(found.broken, "sometimes", found.broken ? `${w} is reachable`
          : `${cite(w)} was not reached in ${SAMPLES} traces of ${STEPS} events: a guard is too strict, a transition is missing, or the goal needs values the simulator does not try`);
        if (found.broken) traces.push(...found.traces);
      }
      for (const t of traces) replay(domain, t);
      report(true, "replay", `generated TypeScript reproduces ${traces.length} Quint traces`);
    } catch (e) {
      const mismatch = (e as Error).message.startsWith("TypeScript and Quint disagree");
      report(false, mismatch ? "replay" : "always", mismatch ? "this is a bug in tools/gen.ts, not in the spec" : "the simulator could not run", indent((e as Error).message));
    }
  }

  if (allOk) {
    if (fs.existsSync(path.join(root, "tsconfig.json"))) {
      const tsc = run("tsc", ["--noEmit", "-p", "."], root);
      report(tsc.ok, "types", tsc.ok ? "application typechecks against the generated contract" : "application does not fit the generated contract", indent(tsc.out.trim()));
    }
    try {
      for (const unit of proofUnits(root, specs.map((s) => s.name))) {
        const proof = run("lsc", ["check", "--backend=dafny", unit], path.join(root, "gen/proof"));
        const verified = proof.out.match(/(\d+) verified, 0 errors/);
        const ok = proof.ok && !!verified;
        const logFile = `gen/proof/${unit.replace(/\.ts$/, ".log")}`;
        fs.writeFileSync(path.join(root, logFile), proof.out);
        report(ok, "proof", ok ? `${unit}: ${verified![1]} obligations proved for all states and inputs` : `${unit}: not proved (full output in ${logFile})`,
          indent(unproved(proof.out).join("\n") || proof.out.trim()));
        if (!ok) break; // later units include this one and would repeat its failures
      }
    } catch (e) {
      report(false, "proof", (e as Error).message);
    }
    const tests = fs.existsSync(path.join(root, "test")) ? fs.readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.ts")) : [];
    if (tests.length) {
      const t = spawnSync(process.execPath, ["--test", ...tests.map((f) => `test/${f}`)], { cwd: root, encoding: "utf8" });
      const failures = t.stdout.slice(Math.max(0, t.stdout.indexOf("✖ failing tests:")));
      report(t.status === 0, "tests", t.status === 0 ? "application tests pass" : "application tests fail", indent((failures + t.stderr).trim()));
    }
  }

  // A spec that is not a valid model has nothing to reconcile yet.
  for (const spec of valid) {
    const todo = pending(root, spec);
    const formal = spec.rules.every((r) => r.code.trim()) && !todo.some((t) => t.includes("story has no rules"));
    if (acceptReviewed && allOk && todo.length && formal) {
      accept(root, spec);
      report(true, "review", `${spec.file}: recorded ${todo.length} item(s) as reconciled\n${todo.map((t) => "    " + t.split("\n")[0]).join("\n")}`);
    } else {
      const next = !acceptReviewed ? "then run `npm run accept`" : allOk ? "every story needs rules and every rule a quint block before anything can be accepted" : "nothing was accepted: fix the stages above first";
      report(!todo.length, "review", todo.length ? `${todo.length} item(s) to reconcile, ${next}` : `${spec.file}: prose and model reconciled for all ${spec.rules.length} rules`,
        todo.map((t) => "    " + t).join("\n"));
    }
  }
  return allOk;
}

const readSpecs = (root: string) =>
  fs.readdirSync(path.join(root, "spec")).filter((f) => f.endsWith(".md")).sort().map((f) => parseSpec(root, path.join("spec", f)));

// --- sync: the generative half ---------------------------------------------------------

const DEFAULT_AGENT = "claude -p --permission-mode acceptEdits --allowedTools Read,Edit,Write,Grep,Glob";
const ROUNDS = 5;
const BRIEF = `You maintain this repository's spec. Read AGENTS.md and CONTRIBUTING.md first and follow them.
Below is the report from \`npm run check\`. Resolve every line marked ✗ by editing files, mainly spec/*.md:
- a story with no rules: write the ### rules it requires, in prose and Quint;
- a rule that is not formalized: write Quint that says what its prose says;
- a rule whose prose or model changed: make the two halves say the same thing, changing the half that is behind;
- a trace that breaks a rule, or a transition that cannot be proved: add the missing rule or guard, in prose and
  Quint, under the story it belongs to, and say in its prose that the checks discovered it.
Change src/ or test/ only if the types or tests stage requires it. Never edit gen/ or *.lock.json, never weaken an
existing rule, and do not run any commands: the check is rerun for you after you finish.
End with three short lists: rules added, rules discovered by the checks, rules changed.

`;

/**
 * Check, give what fails to an agent, and repeat until only a human's sign-off
 * is left. The agent translates; \`npm run accept\` remains the person's decision.
 */
async function sync(root: string): Promise<boolean> {
  const AGENT = process.env.SPEC_AGENT ?? DEFAULT_AGENT;
  for (let round = 1; round <= ROUNDS; round++) {
    const lines: string[] = [];
    if (await check(root, (l) => lines.push(l))) {
      console.log(lines.join("\n") + "\n\nnothing to sync");
      return true;
    }
    const report = lines.join("\n");
    const failed = [...new Set(lines.filter((l) => l.startsWith("✗")).map((l) => l.split(/\s+/)[1]))];
    const untranslated = /story has no rules|not formalized/.test(report);
    if (round > 1 && failed.join() === "review" && !untranslated) {
      console.log(report + "\n\nsynced: read the changes to spec/ (git diff), then run `npm run accept` to sign them off");
      return true;
    }
    console.log(`--- round ${round}: ${failed.join(", ")} need attention; asking the agent ---`);
    const [cmd, ...args] = AGENT.split(" ");
    const agent = spawnSync(cmd, args, { cwd: root, encoding: "utf8", input: BRIEF + report, stdio: ["pipe", "inherit", "inherit"] });
    if (agent.status !== 0) throw new Error(`the agent command failed (${AGENT}); set SPEC_AGENT to a command that reads a prompt on stdin and may edit files`);
  }
  console.log(`not synced after ${ROUNDS} rounds; run \`npm run check\` to see what is left`);
  return false;
}

// --- CLI -----------------------------------------------------------------------------

if (import.meta.main) {
  const root = process.cwd();
  const command = process.argv[2];
  try {
    if (command === "gen") for (const s of readSpecs(root)) gen(root, s);
    else if (command === "check" || command === "accept") process.exitCode = (await check(root, console.log, command === "accept")) ? 0 : 1;
    else if (command === "sync") process.exitCode = (await sync(root)) ? 0 : 1;
    else if (command === "brief") {
      // What `sync` would hand to the agent, for pasting into any agent by hand.
      const lines: string[] = [];
      await check(root, (l) => lines.push(l));
      console.log(BRIEF + lines.join("\n"));
    }
    else {
      console.error("usage: spec.ts gen | check | sync | brief | accept");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
