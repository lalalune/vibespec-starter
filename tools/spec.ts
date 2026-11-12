#!/usr/bin/env node
// The whole pipeline: spec/*.md -> Quint model -> TypeScript -> proofs.
//
//   node tools/spec.ts gen      tangle the specs and generate gen/<name>.ts
//   node tools/spec.ts check    gen, then run every check (see README)
//   node tools/spec.ts brief    check, and print the report as a work order for the
//                               agent in your session (see .claude/skills/sync)
//   node tools/spec.ts sync     unattended: check, hand what fails to the command in
//                               SPEC_AGENT (or a built-in, model-free agent), repeat
//   node tools/spec.ts init     add the sync skill and AGENTS.md to this project
//   node tools/spec.ts accept   check, and if all else passes, record that the
//                               prose and model of every rule have been reconciled
//   node tools/spec.ts accept unproved
//                               record the obligations that hold in simulation but
//                               that Dafny cannot prove on its own

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { generate, LIST_HELPERS, type Model, type Origin } from "./gen.ts";

const SAMPLES = 10000; // simulated traces per check
const WITNESS_SAMPLES = 20 * SAMPLES; // traces tried when looking for a state a `sometimes` rule says is reachable
const STEPS = 20; // events per trace
const REPLAYED = 50; // of those, how many are replayed through the generated TypeScript
const ANNOTATIONS = ["backend", "pure", "requires", "ensures", "invariant", "decreases", "type", "ghost", "assert"];

// --- the spec file -----------------------------------------------------------

export interface Rule { key: string; line: number; prose: string; code: string; defs: string[] }
export interface Spec { name: string; file: string; rules: Rule[]; stories: { title: string; line: number }[]; imports: string[]; qnt: string }

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
  const imports: string[] = [];
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
      const dep = text.match(/^\s*import\s+(\w+)\b/);
      if (dep) imports.push(dep[1]);
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
  return { name, file, rules, stories, imports, qnt: expandListHelpers(qnt.join("\n")) + "\n}\n" };
}

/**
 * Rewrite `xs.every(x => e)`, `.some`, `.listMap` and `.includes(v)` into Quint's
 * built-in `foldl`, in place and without moving a line. See LIST_HELPERS in gen.ts.
 */
export function expandListHelpers(text: string): string {
  let count = 0;
  const go = (src: string): string => {
    const call = /\.(every|some|includes|listMap)\(/g;
    let out = "";
    let at = 0;
    for (let m; (m = call.exec(src)); ) {
      const commented = src.slice(src.lastIndexOf("\n", m.index) + 1, m.index).trimStart().startsWith("//");
      if (commented) continue;
      let end = call.lastIndex;
      for (let depth = 1; end < src.length && depth; end++) {
        if (src[end] === '"') end = src.indexOf('"', end + 1);
        else if (src[end] === "(") depth++;
        else if (src[end] === ")") depth--;
      }
      const arg = go(src.slice(call.lastIndex, end - 1));
      const n = count++;
      const acc = `std_${m[1]}_${n}`;
      const lambda = arg.match(/^\s*\(?\s*(\w+)\s*\)?\s*=>([\s\S]*)$/);
      const item = m[1] === "includes" || !lambda ? `std_x_${n}` : lambda[1];
      const body = m[1] === "includes" ? `${item} == (${arg})` : lambda ? lambda[2] : `${arg.trim()}(${item})`;
      out += `${src.slice(at, m.index)}.foldl(${LIST_HELPERS[m[1]].init}, (${acc}, ${item}) => ${LIST_HELPERS[m[1]].step(acc, body)})`;
      at = call.lastIndex = end;
    }
    return out + src.slice(at);
  };
  return go(text);
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

export function acceptReviews(root: string, spec: Spec) {
  // One rule per line, so a diff of the ledger shows exactly which rules were re-reviewed.
  const lines = spec.rules.map((r) => `  ${JSON.stringify(r.key)}: ${JSON.stringify(fingerprint(r))}`);
  fs.writeFileSync(lockFile(root, spec), `{\n${lines.join(",\n")}\n}\n`);
}

// --- running tools -------------------------------------------------------------

/** An executable from the toolchain's dependencies, wherever npm put it: beside the tools, or in the project. */
function bin(cmd: string, root: string): string {
  for (let dir of [path.join(import.meta.dirname, ".."), root]) {
    for (;;) {
      const candidate = path.join(dir, "node_modules/.bin", cmd);
      if (fs.existsSync(candidate)) return candidate;
      if (dir === path.dirname(dir)) break;
      dir = path.dirname(dir);
    }
  }
  throw new Error(`${cmd} is not installed; run npm install`);
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync(bin(cmd, cwd), args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ?? ""}` };
}

/**
 * Tangle, typecheck and generate one spec. `models` holds the specs it imports,
 * already generated, and receives this one. Throws with a message that points
 * into the spec.
 */
export function gen(root: string, spec: Spec, models = new Map<string, Model>()): Model {
  const dir = path.join(root, "gen");
  const out = path.join(dir, `${spec.name}.ir.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${spec.name}.qnt`), spec.qnt);
  const typed = run("quint", ["typecheck", "--out", out, `gen/${spec.name}.qnt`], root);
  const ir = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { errors: [] };
  fs.rmSync(out, { force: true });
  // Tangling keeps line numbers, so Quint's locations are locations in the Markdown.
  const errors = ir.errors.map((e: any) => {
    const at = e.locs[0];
    const file = at?.source ? `spec/${path.basename(at.source, ".qnt")}.md` : spec.file;
    return at ? `${file}:${at.start.line + 1}:${at.start.col + 1}  ${e.explanation}` : e.explanation;
  });
  if (!typed.ok) throw new Error(errors.join("\n") || typed.out);
  const origins = new Map<string, Origin>();
  for (const r of spec.rules) for (const d of r.defs) origins.set(d, { rule: r.key, line: r.line });
  const model = generate(ir, spec.name, spec.file, (d) => origins.get(d), models);
  fs.writeFileSync(path.join(dir, `${spec.name}.ts`), model.ts);
  fs.writeFileSync(path.join(dir, `${spec.name}.run.qnt`), model.harness);
  models.set(spec.name, model);
  return model;
}

// --- traces: Quint simulates, the generated TypeScript must agree -------------------

/** One state of a simulated trace, and what led to it: an event, or a law tried on some arguments. */
interface Step { event?: { type: string }; asked?: { event: { type: string }; allowed: boolean }; law?: { name: string; args: Record<string, unknown> }; state?: unknown; lawsHold?: boolean }

function readTrace(file: string, model: Model): Step[] {
  return JSON.parse(fs.readFileSync(file, "utf8")).states.map((st: any): Step => {
    // Values are decoded by their type, and sets put in a fixed order, so that they compare equal to TypeScript's.
    const read = (type: any, itf: any) => model.canon(type, model.decode(type, itf));
    const picked = (ps: { name: string; type: any }[]) => Object.fromEntries(ps.map((p) => [p.name, read(p.type, st["mbt::nondetPicks"][p.name].value)]));
    const taken: string = st["mbt::actionTaken"];
    const t = model.transitions.find((t) => t.name === taken);
    const a = model.transitions.find((t) => `ask_${t.name}` === taken);
    const l = model.laws.find((l) => l.name === taken);
    return {
      event: t && { type: t.name, ...picked(t.params) },
      asked: a && { event: { type: a.name, ...picked(a.params) }, allowed: st.allowed },
      law: l && { name: l.name, args: picked(l.params) },
      state: model.state ? read(model.stateType, st.state) : undefined,
      lawsHold: st.lawsHold,
    };
  });
}

/** Simulate the harness until `invariant` breaks; returns the traces Quint wrote. */
function simulate(root: string, model: Model, invariant: string, traces: number, samples = SAMPLES): { broken: boolean; traces: Step[][] } {
  const dir = path.join(root, "gen/traces", `${model.name}.${invariant}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = run("quint", ["run", `gen/${model.name}.run.qnt`, "--main", `${model.name}_run`, "--invariant", invariant,
    "--max-samples", String(samples), "--max-steps", String(STEPS), "--mbt", "--n-traces", String(traces),
    "--out-itf", path.join(dir, "{seq}.itf.json")], root);
  const broken = r.out.includes("[violation]");
  const files = fs.readdirSync(dir);
  // Anything other than "held" or "violated", each with a trace, is Quint failing to run.
  if ((!r.ok && !broken) || !files.length) throw new Error(`quint run did not complete:\n${r.out.trim()}`);
  return { broken, traces: files.map((f) => readTrace(path.join(dir, f), model)) };
}

/** Replay one Quint trace through the TypeScript domain; throws at the first difference. */
export function replay(domain: any, trace: Step[], canon: (state: any) => any = (x) => x) {
  const differ = (what: string) => new Error(`TypeScript and Quint disagree ${what}`);
  let s = domain.initial;
  for (const { event, asked, law, state, lawsHold } of trace) {
    if (event) {
      if (!domain.enabled(s, event)) throw differ(`on whether ${JSON.stringify(event)} is allowed in ${JSON.stringify(s)}`);
      s = domain.step(s, event);
    } else if (asked) {
      // An event that was only asked about: both sides must give the same answer, and a refused one must change nothing.
      if (domain.enabled(s, asked.event) !== asked.allowed) throw differ(`on whether ${JSON.stringify(asked.event)} is allowed in ${JSON.stringify(s)}: Quint says ${asked.allowed}`);
      if (!asked.allowed && !isDeepStrictEqual(domain.step(s, asked.event), s)) throw differ(`on ${JSON.stringify(asked.event)}: it is refused, yet TypeScript changes the state`);
    } else if (law && domain[law.name](...Object.values(law.args)) !== lawsHold)
      throw differ(`on ${law.name}${JSON.stringify(law.args)}: Quint says ${lawsHold}`);
    if (state !== undefined && !isDeepStrictEqual(canon(s), state)) throw differ(`after ${JSON.stringify(event ?? "init")}: TypeScript reached ${JSON.stringify(s)}, Quint reached ${JSON.stringify(state)}`);
  }
}

/** The first rule a trace breaks, in the spec's words, and how many steps it took; undefined if it breaks none. */
function firstBreak(domain: any, model: Model, trace: Step[], cite: (def: string) => string): { why: string; steps: number } | undefined {
  let before: unknown;
  for (const [i, { event, law, state, lawsHold }] of trace.entries()) {
    const found = (why: string) => ({ why, steps: i + 1 });
    if (law && lawsHold === false) return found(`the law ${cite(law.name)} is false for ${JSON.stringify(law.args)}`);
    const always = model.always.filter((a) => !domain[a](state)).map(cite);
    if (always.length) return found(`a reachable state breaks ${always.join(", ")}`);
    const steps = event ? model.steps.filter((r) => !domain[r](before, state)).map(cite) : [];
    if (steps.length) return found(`a step breaks ${steps.join(", ")}`);
    before = state;
  }
}

const showTrace = (trace: Step[]) =>
  trace.filter((s, i) => i === 0 || s.event || s.lawsHold === false).map(({ event, law, state, lawsHold }) =>
    `      ${(event ? JSON.stringify(event) : law ? `${law.name}${JSON.stringify(law.args)}` : "initial").padEnd(30)} -> ${law && !event ? lawsHold : JSON.stringify(state)}`).join("\n");

// --- proofs ----------------------------------------------------------------------

const IMPORT = /^import\b[^;]*?from\s+["']([^"']+)["'];?[ \t]*\n/gm;

/**
 * LemmaScript verifies one file at a time and does not carry definitions across
 * imports, so every unit is proved as a bundle: what it imports, then itself.
 * The imported modules come without their own obligations, which are proved
 * once, in their own unit; that keeps the cost of a proof proportional to the
 * module, not to everything beneath it.
 */
function proofUnits(root: string, models: Model[]): string[] {
  const dir = path.join(root, "gen/proof");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const byName = new Map(models.map((m) => [m.name, m]));
  const text = (n: string) => fs.readFileSync(path.join(root, `gen/${n}.ts`), "utf8").replace(IMPORT, "");
  const asDependency = (n: string) => text(n).replace(/^\s*\/\/@ ensures .*\n/gm, "");
  /** A module's imports, transitively, dependencies first. */
  const closure = (names: string[], seen: string[] = []): string[] => {
    for (const n of names) if (!seen.includes(n)) { closure(byName.get(n)!.imports, seen); seen.push(n); }
    return seen;
  };
  const units: string[] = [];
  for (const m of models) {
    fs.writeFileSync(path.join(dir, `${m.name}.ts`), [...closure(m.imports).map(asDependency), text(m.name)].join("\n"));
    units.push(`${m.name}.ts`);
  }
  const src = path.join(root, "src");
  const files = fs.existsSync(src) ? (fs.readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).sort() : [];
  for (const f of files) {
    const code = fs.readFileSync(path.join(src, f), "utf8");
    const used = [...code.matchAll(/^\s*\/\/@ (\w+)/gm)].map((m) => m[1]);
    if (!used.length) continue;
    // Annotations that tell the prover to trust or skip something are not proofs.
    const refused = used.filter((k) => !ANNOTATIONS.includes(k));
    if (refused.length) throw new Error(`src/${f}: \`//@ ${refused[0]}\` is not allowed; verified code may only use ${ANNOTATIONS.join(", ")}`);
    const deps = [...code.matchAll(IMPORT)].map((m) => {
      const target = path.resolve(src, path.dirname(f), m[1]);
      const name = models.find((n) => target === path.join(root, `gen/${n.name}.ts`))?.name;
      if (!name) throw new Error(`src/${f}: verified code may only import generated modules (gen/<name>.ts), not ${m[1]}`);
      return name;
    });
    const unit = f.replaceAll(path.sep, "_");
    fs.writeFileSync(path.join(dir, unit), [...closure(deps).map(asDependency), `// ---- src/${f} ----`, code.replace(IMPORT, "")].join("\n"));
    units.push(unit);
  }
  return units;
}

/**
 * Prove one unit, or reuse the result of proving exactly the same text before. A unit's text is its own
 * definitions and those of everything it imports, so a change anywhere beneath it is a different text.
 * This is what keeps a check proportional to what changed: simulation takes a second per spec, proofs do not.
 */
function prove(root: string, unit: string): { out: string } {
  const text = fs.readFileSync(path.join(root, "gen/proof", unit), "utf8");
  const cached = path.join(root, ".spec-cache", `${createHash("sha256").update(text).digest("hex").slice(0, 24)}.log`);
  if (!process.env.SPEC_NO_CACHE && fs.existsSync(cached)) return { out: fs.readFileSync(cached, "utf8") };
  const { out } = run("lsc", ["check", "--backend=dafny", unit], path.join(root, "gen/proof"));
  if (/\d+ verified, \d+ errors?/.test(out)) {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, out);
  }
  return { out };
}

/** What Dafny reported: postconditions it could not prove (in the words of the annotations), and anything else. */
function dafnyFailures(out: string): { unproved: string[]; errors: string[] } {
  const unproved = new Set<string>();
  const errors = new Set<string>();
  const lines = out.split("\n");
  const quoted = (from: number) => lines.slice(from, from + 4).map((l) => l.match(/^\s*\d+ \|\s*(.*)$/)?.[1]).find(Boolean) ?? "";
  lines.forEach((l, i) => {
    if (l.includes("this is the postcondition that could not be proved")) unproved.add(quoted(i).replace(/^ensures /, ""));
    else if (l.includes("Error:") && !l.includes("a postcondition could not be proved")) errors.add(`${l.split("Error: ")[1]}: ${quoted(i)}`);
  });
  return { unproved: [...unproved], errors: [...errors] };
}

// Obligations that hold in simulation but that Dafny cannot prove on its own, accepted by a person.
const ledgerFile = (root: string) => path.join(root, "spec/unproved.lock.json");
const readLedger = (root: string): Record<string, string[]> => (fs.existsSync(ledgerFile(root)) ? JSON.parse(fs.readFileSync(ledgerFile(root), "utf8")) : {});

// --- check -------------------------------------------------------------------------

/**
 * Run every check, cheapest first. Stages after a broken model are skipped,
 * because their failures would only restate the first one. `accept` is
 * "reviews" to record reconciled rules, or "unproved" to record the
 * obligations that are simulated but not proved.
 */
export async function check(root: string, log: (line: string) => void = console.log, accept: false | "reviews" | "unproved" = false): Promise<boolean> {
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
  const models = new Map<string, Model>();
  // Node caches imported modules by path, so each run loads its generated code from a directory of its own.
  const loaded = path.join(root, "gen", `run-${Date.now()}`);

  for (const spec of specs) {
    const cite = (def: string) => {
      const rule = spec.rules.find((r) => r.defs.includes(def));
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
      report(false, "model", `${spec.file} is not a valid model`, indent((e as Error).message.trim()));
      continue;
    }
    valid.push(spec);
    const parts = [[model.transitions.length, "transitions"], [model.always.length, "always"], [model.steps.length, "step"], [model.sometimes.length, "sometimes"], [model.laws.length, "laws"]];
    report(true, "model", `${spec.file}: ${parts.filter(([n]) => n).map((p) => p.join(" ")).join(", ") || "definitions only"}`);
    if (!model.state && !model.laws.length) continue;
    // A spec whose model and harness are unchanged, and that passed, is not simulated again.
    const closure = (names: string[]): string => names.map((n) => { const dep = specs.find((x) => x.name === n)!; return closure(dep.imports) + dep.qnt; }).join("");
    const fingerprint = createHash("sha256").update([closure(spec.imports), spec.qnt, model.harness, SAMPLES, WITNESS_SAMPLES, STEPS].join("\n")).digest("hex").slice(0, 24);
    const passed = path.join(root, ".spec-cache", `sim-${fingerprint}.json`);
    if (!process.env.SPEC_NO_CACHE && fs.existsSync(passed)) {
      for (const [stage, summary] of JSON.parse(fs.readFileSync(passed, "utf8"))) report(true, stage, `${summary} (unchanged since it last passed)`);
      continue;
    }
    const said: [string, string, boolean][] = [];
    const reportSim = (ok: boolean, stage: string, summary: string, detail = "") => { said.push([stage, summary, ok]); return report(ok, stage, summary, detail); };
    try {
      const sim = simulate(root, model, "inv", REPLAYED);
      // Of the traces that break a rule, show the shortest, and only up to the break.
      const bad = sim.traces.flatMap((t) => { const b = firstBreak(domain, model, t, cite); return b ? [{ t: t.slice(0, b.steps), why: b.why }] : []; })
        .sort((x, y) => x.t.length - y.t.length)[0];
      if (sim.broken || bad) {
        const lastEvent = bad?.t.findLast((s) => s.event)?.event?.type;
        const guard = model.transitions.find((t) => t.name === lastEvent)?.guard;
        // When an event walks into a state that breaks an `always` rule, one repair is always available and can be
        // made mechanically: refuse the event when its result would break the rule. `agent-lookahead` applies it.
        const brokenRule = bad && lastEvent ? model.always.find((a) => !domain[a](bad.t[bad.t.length - 1].state)) : undefined;
        const hint = lastEvent && !bad?.why?.startsWith("the law") ? `\n      the last event is ${cite(lastEvent)}${guard ? `; its guard ${guard} let it through` : "; it has no guard"}`
          + (brokenRule ? `\n      a rule that would forbid it: refuse ${lastEvent} when its result would break ${brokenRule}` : "") : "";
        reportSim(false, "always", `${bad?.why ?? "a rule is broken"}: fix the model, or add the rule that forbids this trace`, bad ? showTrace(bad.t) + hint : "");
        continue;
      }
      reportSim(true, "always", `no rule broken in ${SAMPLES} simulated traces`);
      const traces = sim.traces;
      for (const w of model.sometimes) {
        const found = simulate(root, model, `never_${w}`, 1, WITNESS_SAMPLES); // stops at the first witness, so a large budget is cheap
        reportSim(found.broken, "sometimes", found.broken ? `${w} is reachable`
          : `${cite(w)} was not reached in ${WITNESS_SAMPLES} traces of ${STEPS} events: a guard is too strict, a transition is missing, or the goal needs values the simulator does not try`);
        if (found.broken) traces.push(...found.traces);
      }
      for (const t of traces) replay(domain, t, (x) => model.canon(model.stateType, x));
      reportSim(true, "replay", `generated TypeScript reproduces ${traces.length} Quint traces`);
    } catch (e) {
      const mismatch = (e as Error).message.startsWith("TypeScript and Quint disagree");
      reportSim(false, mismatch ? "replay" : "always", mismatch ? "this is a bug in tools/gen.ts, not in the spec" : "the simulator could not run", indent((e as Error).message));
    }
    if (said.every(([, , ok]) => ok)) {
      fs.mkdirSync(path.dirname(passed), { recursive: true });
      fs.writeFileSync(passed, JSON.stringify(said.map(([stage, summary]) => [stage, summary])));
    }
  }

  if (allOk) {
    if (fs.existsSync(path.join(root, "tsconfig.json"))) {
      const tsc = run("tsc", ["--noEmit", "-p", "."], root);
      report(tsc.ok, "types", tsc.ok ? "application typechecks against the generated contract" : "application does not fit the generated contract", indent(tsc.out.trim()));
    }
    try {
      const accepted = readLedger(root);
      const ledger: Record<string, string[]> = {};
      let recordable = true;
      for (const unit of proofUnits(root, [...models.values()])) {
        const proof = prove(root, unit);
        const logFile = `gen/proof/${unit.replace(/\.ts$/, ".log")}`;
        fs.writeFileSync(path.join(root, logFile), proof.out);
        const proved = Number(proof.out.match(/(\d+) verified, \d+ errors?/)?.[1] ?? NaN);
        const { unproved, errors } = dafnyFailures(proof.out);
        const fresh = unproved.filter((u) => !(accepted[unit] ?? []).includes(u));
        const broken = errors.length > 0 || Number.isNaN(proved);
        if (unproved.length) ledger[unit] = unproved;
        if (broken) {
          recordable = false;
          report(false, "proof", `${unit}: Dafny could not check it (full output in ${logFile})`, indent(errors.join("\n") || proof.out.trim()));
        } else if (fresh.length && accept !== "unproved") {
          report(false, "proof", `${unit}: ${proved} proved, ${fresh.length} not proved. If simulation is enough for these, record them with \`npm run accept -- unproved\`; otherwise add the rule or guard that makes them provable (full output in ${logFile})`, indent(fresh.join("\n")));
        } else {
          const stale = (accepted[unit] ?? []).length - unproved.length;
          report(true, "proof", `${unit}: ${proved} obligations proved for all states and inputs${unproved.length ? `, ${unproved.length} simulated only (accepted)` : ""}${stale > 0 && accept !== "unproved" ? `; ${stale} accepted earlier now prove, run \`npm run accept -- unproved\` to tighten the ledger` : ""}`);
        }
      }
      if (accept === "unproved" && recordable) {
        const lines = Object.entries(ledger).map(([unit, list]) => `  ${JSON.stringify(unit)}: [\n${list.map((u) => `    ${JSON.stringify(u)}`).join(",\n")}\n  ]`);
        if (lines.length) fs.writeFileSync(ledgerFile(root), `{\n${lines.join(",\n")}\n}\n`);
        else fs.rmSync(ledgerFile(root), { force: true });
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
  fs.rmSync(loaded, { recursive: true, force: true });

  // A spec that is not a valid model has nothing to reconcile yet.
  for (const spec of valid) {
    const todo = pending(root, spec);
    const formal = spec.rules.every((r) => r.code.trim()) && !todo.some((t) => t.includes("story has no rules"));
    if (accept === "reviews" && allOk && todo.length && formal) {
      acceptReviews(root, spec);
      report(true, "review", `${spec.file}: recorded ${todo.length} item(s) as reconciled\n${todo.map((t) => "    " + t.split("\n")[0]).join("\n")}`);
    } else {
      const next = accept !== "reviews" ? "then run `npm run accept`" : allOk ? "every story needs rules and every rule a quint block before anything can be accepted" : "nothing was accepted: fix the stages above first";
      report(!todo.length, "review", todo.length ? `${todo.length} item(s) to reconcile, ${next}` : `${spec.file}: prose and model reconciled for all ${spec.rules.length} rules`,
        todo.map((t) => "    " + t).join("\n"));
    }
  }
  return allOk;
}

/** Every spec, with each one after the specs it imports. */
export function readSpecs(root: string): Spec[] {
  const all = fs.readdirSync(path.join(root, "spec")).filter((f) => f.endsWith(".md")).sort().map((f) => parseSpec(root, path.join("spec", f)));
  const ordered: Spec[] = [];
  const visit = (spec: Spec, trail: string[]) => {
    if (ordered.includes(spec)) return;
    if (trail.includes(spec.name)) throw new Error(`specs import each other in a circle: ${[...trail, spec.name].join(" -> ")}`);
    for (const i of spec.imports) {
      const dep = all.find((s) => s.name === i);
      if (!dep) throw new Error(`${spec.file} imports ${i}, but there is no spec/${i}.md`);
      visit(dep, [...trail, spec.name]);
    }
    ordered.push(spec);
  };
  all.forEach((s) => visit(s, []));
  return ordered;
}

// --- sync: the generative half ---------------------------------------------------------

// Syncing is normally done by the agent in the user's session, following the sync skill. `sync` is for running
// unattended: it uses the command in SPEC_AGENT, or else a built-in agent that needs no model and can only add
// the rule that the check itself proposes.
const tool = (name: string) => [process.execPath, path.join(import.meta.dirname, `${name}${path.extname(import.meta.filename)}`)];
const ROUNDS = 5;
const BRIEF = `You maintain this repository's spec. Read AGENTS.md, the sync skill it points to, and CONTRIBUTING.md, and follow them.
Below is the report from \`npm run check\`. Resolve every line marked ✗ by editing files, mainly spec/*.md:
- a story with no rules: write the ### rules it requires, in prose and Quint;
- a rule that is not formalized: write Quint that says what its prose says;
- a rule whose prose or model changed: make the two halves say the same thing, changing the half that is behind;
- a trace that breaks a rule, or a transition that cannot be proved: add the missing rule or guard, in prose and
  Quint, under the story it belongs to, and say in its prose that the checks discovered it.
Change src/ or test/ only if the types or tests stage requires it. Never edit gen/ or *.lock.json, never weaken an
existing rule, and never run \`npm run accept\`.

`;

/** Both halves of every rule the report says has moved, so that whoever reconciles them compares rather than guesses. */
function movedRules(root: string, report: string): string {
  const moved = readSpecs(root).flatMap((spec) => spec.rules).flatMap((r) => {
    const at = report.indexOf(`  ${r.key}\n`);
    const status = at < 0 ? null : report.slice(at + r.key.length + 3).match(/^ +(prose changed|model changed|prose and model both changed)/)?.[1];
    return status ? [`RULE "${r.key}" (${status})\nits prose now:\n${r.prose.trim() || "(only the heading)"}\nits Quint now:\n${r.code.trim()}\nEND RULE`] : [];
  });
  return moved.length ? `\n\nThe rules that changed, both halves:\n\n${moved.join("\n\n")}` : "";
}

/**
 * Check, give what fails to an agent, and repeat until only a human's sign-off
 * is left. The agent translates; \`npm run accept\` remains the person's decision.
 */
async function sync(root: string): Promise<boolean> {
  let agents = process.env.SPEC_AGENT ? [process.env.SPEC_AGENT.split(" ")] : [tool("agent-lookahead")];
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
      const oneSided = (report.match(/(prose|model) changed:/g) ?? []).length;
      console.log(report + "\n\nsynced: read the changes to spec/ (git diff), then run `npm run accept` to sign them off"
        + (oneSided ? `\n${oneSided} rule(s) above still have only one half changed: the agent judged the other half already agrees, or missed it, so read those first` : ""));
      return true;
    }
    console.log(`${report}\n\n--- round ${round}: ${failed.join(", ")} need attention; asking the agent ---`);
    const input = BRIEF + report + movedRules(root, report);
    for (;;) {
      const [cmd, ...args] = agents[0];
      const agent = spawnSync(cmd, args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "inherit", "inherit"] });
      if (agent.status === 0) break;
      if (agents.length === 1) throw new Error(`the agent command failed (${path.basename(cmd)}); SPEC_AGENT must be a command that reads a prompt on stdin and may edit files`);
      agents = agents.slice(1);
      const named = (agent: string[]) => path.basename(agent.at(-1)!.includes("agent-") ? agent.at(-1)! : agent[0], path.extname(agent.at(-1)!));
      console.log(`--- ${named([cmd, ...args])} could not run; using ${named(agents[0])} instead ---`);
    }
  }
  console.log(`not synced after ${ROUNDS} rounds. What is left needs the agent in your session (the sync skill) or a person; \`npm run brief\` shows it`);
  return false;
}

// --- CLI -----------------------------------------------------------------------------

if (import.meta.main) {
  const root = process.cwd();
  const command = process.argv[2];
  try {
    if (command === "gen") {
      const models = new Map<string, Model>();
      for (const s of readSpecs(root)) gen(root, s, models);
    } else if (command === "check") process.exitCode = (await check(root)) ? 0 : 1;
    else if (command === "accept") process.exitCode = (await check(root, console.log, process.argv[3] === "unproved" ? "unproved" : "reviews")) ? 0 : 1;
    else if (command === "sync") process.exitCode = (await sync(root)) ? 0 : 1;
    else if (command === "brief") {
      // The work order for the agent in the session: the report, and both halves of every rule that moved.
      const lines: string[] = [];
      const ok = await check(root, (l) => lines.push(l));
      const report = lines.join("\n");
      console.log(ok ? `${report}\n\nEverything is in step.` : BRIEF + report + movedRules(root, report));
      process.exitCode = ok ? 0 : 1;
    } else if (command === "init") {
      // Give a project that uses the package the same operating procedure.
      const pkg = path.join(import.meta.dirname, "..");
      const skill = path.join(root, ".claude/skills/sync/SKILL.md");
      fs.mkdirSync(path.dirname(skill), { recursive: true });
      fs.copyFileSync(path.join(pkg, ".claude/skills/sync/SKILL.md"), skill);
      for (const doc of ["AGENTS.md", "CONTRIBUTING.md"]) if (!fs.existsSync(path.join(root, doc))) fs.copyFileSync(path.join(pkg, doc), path.join(root, doc));
      fs.mkdirSync(path.join(root, "spec"), { recursive: true });
      console.log("added .claude/skills/sync/SKILL.md, and AGENTS.md and CONTRIBUTING.md where there were none");
    }
    else {
      console.error("usage: spec gen | check | brief | accept | accept unproved | sync | init");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
