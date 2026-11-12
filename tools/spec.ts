#!/usr/bin/env node
// The whole pipeline: spec/*.md -> Quint model -> TypeScript -> proofs.
//
//   spec check             run every check and print what is out of step (see README)
//   spec gen               only tangle the specs and generate gen/<name>.ts
//   spec accept            check afresh and, if all else passes, record that the prose
//                          and model of every rule have been reconciled
//   spec accept unproved   check afresh and record the obligations that hold in
//                          simulation but that Dafny cannot prove on its own
//   spec init              set a project up: the sync skill, AGENTS.md, scripts
//
// From this repository the same commands are `node tools/spec.ts …` or `npm run …`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { generate, LIST_HELPERS, type Model, type Origin } from "./gen.ts";

const SAMPLES = 10000; // simulated traces per check
const WITNESS_SAMPLES = 20 * SAMPLES; // traces tried when looking for a state a `sometimes` rule says is reachable
const COMPARED_SAMPLES = 2000; // traces simulated with definitions evaluated along the way
const REPLAYED = 200; // traces of each kind replayed through the generated TypeScript
const STEPS = 20; // events per trace
/** The annotations hand-written verified code may use. Ones that tell the prover to trust or skip something are not proofs. */
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
  try {
    return { name, file, rules, stories, imports, qnt: expandListHelpers(qnt.join("\n")) + "\n}\n" };
  } catch (e) {
    throw new Error(`${file}:${(e as Error).message}`);
  }
}

/**
 * Rewrite `xs.every(x => e)`, `.some`, `.listMap` and `.includes(v)` into Quint's
 * built-in `foldl`, in place and without moving a line (see LIST_HELPERS in
 * gen.ts for why). Strings and comments are left alone.
 */
export function expandListHelpers(text: string): string {
  // Which characters are code, as opposed to part of a string or a comment.
  const code: boolean[] = [];
  for (let i = 0, mode = ""; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (mode === "" && text[i] === '"') mode = '"';
    else if (mode === "" && two === "//") mode = "//";
    else if (mode === "" && two === "/*") mode = "/*";
    else if (mode === "") { code[i] = true; continue; }
    else if (mode === '"' && text[i] === "\\") i++;
    else if (mode === '"' && text[i] === '"') mode = "";
    else if (mode === "//" && text[i] === "\n") mode = "";
    else if (mode === "/*" && two === "*/") { i++; mode = ""; }
  }
  let count = 0;
  const expand = (from: number, to: number): string => {
    const call = /\.(every|some|includes|listMap)\(/g;
    let out = "";
    let at = from;
    call.lastIndex = from;
    for (let m; (m = call.exec(text)) && m.index < to; ) {
      if (!code[m.index]) continue;
      let end = call.lastIndex;
      for (let depth = 1; depth; end++) {
        if (end >= to) throw new Error(`${text.slice(0, m.index).split("\n").length}: no closing parenthesis for .${m[1]}(`);
        if (code[end] && text[end] === "(") depth++;
        else if (code[end] && text[end] === ")") depth--;
      }
      const arg = expand(call.lastIndex, end - 1);
      const n = count++;
      const acc = `std_${m[1]}_${n}`;
      const lambda = arg.match(/^\s*\(?\s*(\w+)\s*\)?\s*=>([\s\S]*)$/);
      const item = m[1] === "includes" || !lambda ? `std_x_${n}` : lambda[1];
      const body = m[1] === "includes" ? `${item} == (${arg})` : lambda ? lambda[2] : `${arg.trim()}(${item})`;
      out += `${text.slice(at, m.index)}.foldl(${LIST_HELPERS[m[1]].init}, (${acc}, ${item}) => ${LIST_HELPERS[m[1]].step(acc, body)})`;
      at = call.lastIndex = end;
    }
    return out + text.slice(at, to);
  };
  return expand(0, text.length);
}

// --- review ledger: has anyone confirmed that prose and model still agree? ----

const sha = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");
const lockFile = (root: string, spec: Spec) => path.join(root, spec.file.replace(/\.md$/, ".lock.json"));
/** Prose may be re-wrapped without becoming a different sentence. Code may not: a line break can end a comment. */
export const fingerprint = (r: Rule): [string, string] => [
  sha(r.prose.replace(/\s+/g, " ").trim()).slice(0, 12),
  sha(r.code.split("\n").map((l) => l.trimEnd()).join("\n").trim()).slice(0, 12),
];

/** Stories and rules to reconcile since `accept`, with what to do about each. */
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

/** Both halves of every rule the report says has moved, so that whoever reconciles them compares rather than guesses. */
function movedRules(spec: Spec, todo: string[]): string[] {
  return spec.rules.flatMap((r) => {
    const status = todo.find((t) => t.includes(`  ${r.key}\n`))?.match(/\n +(prose changed|model changed|prose and model both changed)/)?.[1];
    return status ? [`    "${r.key}" (${status})\n      its prose:\n${indent(r.prose.trim() || "(only the heading)", 8)}\n      its Quint:\n${indent(r.code.trim(), 8)}`] : [];
  });
}

const indent = (s: string, by = 6) => s.split("\n").map((l) => " ".repeat(by) + l).join("\n");
const fail = (message: string): never => { throw new Error(message); };

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

/** What a remembered result was produced by: a different Quint, LemmaScript, Dafny or version of these tools must not reuse it. */
let toolchain: string | undefined;
function toolchainId(): string {
  const version = (dep: string) => {
    for (let dir = import.meta.dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const file = path.join(dir, "node_modules", dep, "package.json");
      if (fs.existsSync(file)) return `${dep}@${JSON.parse(fs.readFileSync(file, "utf8")).version}`;
    }
    return dep;
  };
  const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" });
  const tools = ["spec", "gen"].map((f) => fs.readFileSync(path.join(import.meta.dirname, f + path.extname(import.meta.filename)), "utf8"));
  return (toolchain ??= [version("@informalsystems/quint"), version("lemmascript"), `dafny@${(dafny.stdout ?? "").trim()}`, sha(...tools).slice(0, 12)].join(" "));
}

/**
 * `produce()`, or what it returned the last time for the same key, if that was
 * worth keeping. This is what keeps a check proportional to what changed. The
 * cache is a convenience: `accept` never reads it.
 */
function remembered<T>(root: string, fresh: boolean, key: string[], produce: () => T, keep: (result: T) => boolean): T {
  const file = path.join(root, ".spec-cache", `${sha(toolchainId(), ...key).slice(0, 24)}.json`);
  if (!fresh && !process.env.SPEC_NO_CACHE && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const result = produce();
  if (keep(result)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result));
  }
  return result;
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

/** One state of a simulated trace, and what led to it. */
export interface Step {
  event?: { type: string };
  law?: { name: string; args: Record<string, unknown> };
  /** A definition the simulator evaluated: what was picked for its sampled parameters, and what Quint got. */
  evaluated?: { name: string; picks: Record<string, unknown>; result: unknown };
  state?: unknown;
  lawsHold?: boolean;
}

function readTrace(file: string, model: Model): Step[] {
  return JSON.parse(fs.readFileSync(file, "utf8")).states.map((st: any): Step => {
    // Values are decoded by their type, and sets put in a fixed order, so that they compare equal to TypeScript's.
    const read = (type: any, itf: any) => model.canon(type, model.decode(type, itf));
    const picked = (ps: { name: string; type: any }[]) => Object.fromEntries(ps.map((p) => [p.name, read(p.type, st["mbt::nondetPicks"][p.name].value)]));
    const taken: string = st["mbt::actionTaken"];
    const t = model.transitions.find((t) => t.name === taken);
    const v = model.evals.find((v) => `eval_${v.name}` === taken);
    const l = model.laws.find((l) => l.name === taken);
    return {
      event: t && { type: t.name, ...picked(t.params) },
      evaluated: v && { name: v.name, picks: picked(v.params.filter((p) => p.from === "pick")), result: read(v.result, st.out.value) },
      law: l && { name: l.name, args: picked(l.params) },
      state: model.state ? read(model.stateType, st.state) : undefined,
      lawsHold: st.lawsHold,
    };
  });
}

/** Simulate the harness until `invariant` breaks; returns the traces Quint wrote. */
function simulate(root: string, model: Model, invariant: string, traces: number, samples = SAMPLES, step = "step"): { broken: boolean; traces: Step[][] } {
  const dir = path.join(root, "gen/traces", `${model.name}.${invariant}.${step}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = run("quint", ["run", `gen/${model.name}.run.qnt`, "--main", `${model.name}_run`, "--step", step, "--invariant", invariant,
    "--max-samples", String(samples), "--max-steps", String(STEPS), "--mbt", "--n-traces", String(traces),
    "--out-itf", path.join(dir, "{seq}.itf.json")], root);
  const broken = r.out.includes("[violation]");
  const files = fs.readdirSync(dir);
  // Anything other than "held" or "violated", each with a trace, is Quint failing to run.
  if ((!r.ok && !broken) || !files.length) throw new Error(`quint run did not complete:\n${r.out.trim()}`);
  return { broken, traces: files.map((f) => readTrace(path.join(dir, f), model)) };
}

/**
 * Replay one Quint trace through the TypeScript domain; throws at the first difference. With the model, sets are
 * compared whatever their order and every definition the simulator evaluated is evaluated here too.
 */
export function replay(domain: any, trace: Step[], model?: Model) {
  const differ = (what: string) => new Error(`TypeScript and Quint disagree ${what}`);
  const canon = (type: any, value: unknown) => (model ? model.canon(type, value) : value);
  let s = domain.initial;
  let before = s;
  for (const { event, evaluated, law, state, lawsHold } of trace) {
    if (event) {
      if (!domain.enabled(s, event)) throw differ(`on whether ${JSON.stringify(event)} is allowed in ${JSON.stringify(s)}`);
      [before, s] = [s, domain.step(s, event)];
    } else if (evaluated && model) {
      const v = model.evals.find((v) => v.name === evaluated.name)!;
      const args = v.params.map((p) => (p.from === "state" ? s : p.from === "prev" ? before : evaluated.picks[p.name]));
      const got = canon(v.result, domain[v.name](...args));
      if (!isDeepStrictEqual(got, evaluated.result)) throw differ(`on ${v.name}(${args.map((a) => JSON.stringify(a)).join(", ")}): TypeScript gives ${JSON.stringify(got)}, Quint gives ${JSON.stringify(evaluated.result)}`);
    } else if (law && domain[law.name](...Object.values(law.args)) !== lawsHold)
      throw differ(`on ${law.name}${JSON.stringify(law.args)}: Quint says ${lawsHold}`);
    if (state !== undefined && !isDeepStrictEqual(canon(model?.stateType, s), state)) throw differ(`after ${JSON.stringify(event ?? "init")}: TypeScript reached ${JSON.stringify(s)}, Quint reached ${JSON.stringify(state)}`);
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

/**
 * LemmaScript verifies one file at a time and does not carry definitions across
 * imports, so every unit is proved as a bundle: what it imports, then itself.
 * An imported module comes with its names prefixed by the module's name and
 * without its own obligations, which are proved once, in its own unit; that
 * keeps the cost of a proof proportional to the module, not to everything
 * beneath it.
 */
function proofUnits(root: string, models: Model[]): { unit: string; text: string }[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const withoutImports = (text: string) => {
    const file = ts.createSourceFile("unit.ts", text, ts.ScriptTarget.Latest, true);
    const imports = file.statements.filter(ts.isImportDeclaration);
    const kept = imports.reduceRight((rest, d) => rest.slice(0, d.getFullStart()) + rest.slice(d.getEnd()), text);
    return { kept, from: imports.map((d) => (d.moduleSpecifier as ts.StringLiteral).text) };
  };
  const withoutObligations = (text: string) => text.replace(/^\s*\/\/@ ensures .*\n/gm, "");
  /** The modules a module needs beside it, dependencies first. */
  const needs = (m: Model, seen: string[] = []): string[] => {
    for (const dep of m.imports) if (!seen.includes(dep)) { needs(byName.get(dep)!, seen); seen.push(dep); }
    return seen;
  };
  const asDependency = (name: string) => withoutObligations(withoutImports(byName.get(name)!.render(`${name}_`)).kept);
  const units = models.map((m) => ({ unit: `${m.name}.ts`, text: [...needs(m).map(asDependency), withoutImports(m.ts).kept].join("\n") }));

  const src = path.join(root, "src");
  const files = fs.existsSync(src) ? (fs.readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).sort() : [];
  for (const f of files) {
    const code = fs.readFileSync(path.join(src, f), "utf8");
    // Wherever `//@` appears, even after other text on the line, LemmaScript may read it.
    const used = [...code.matchAll(/\/\/@\s*([\w-]*)/g)].map((m) => m[1]);
    if (!used.length) continue;
    const refused = used.find((k) => !ANNOTATIONS.includes(k));
    if (refused !== undefined) throw new Error(`src/${f}: \`//@ ${refused}\` is not allowed; verified code may only use ${ANNOTATIONS.join(", ")}`);
    if (/\bimport\s*\(|\brequire\s*\(/.test(code)) throw new Error(`src/${f}: verified code may not load other code with import() or require()`);
    const { kept, from } = withoutImports(code);
    const deps = from.map((spec) => {
      const target = path.resolve(src, path.dirname(f), spec);
      return models.find((m) => target === path.join(root, `gen/${m.name}.ts`))?.name ?? fail(`src/${f}: verified code may only import generated modules (gen/<name>.ts), not ${spec}`);
    });
    if (new Set(deps).size > 1) throw new Error(`src/${f}: verified code may import one generated module; put what it needs from the others into that module's spec`);
    // The module it imports sits beside it under its own names, as the code refers to them.
    const beside = deps.slice(0, 1).flatMap((d) => [...needs(byName.get(d)!).map(asDependency), withoutObligations(withoutImports(byName.get(d)!.ts).kept)]);
    units.push({ unit: `src-${f.replaceAll(path.sep, "-")}`, text: [...beside, `// ---- src/${f} ----`, kept].join("\n") });
  }
  const twice = units.find((u, i) => units.findIndex((v) => v.unit === u.unit) !== i);
  if (twice) throw new Error(`two files would be proved under the name ${twice.unit}; rename one of them`);
  return units;
}

interface Proof { total: number; unproved: string[]; errors: string[]; log: string }

/** Prove one unit in a directory of its own, so that nothing left over from another run or project can vouch for it. */
function prove(root: string, unit: string, text: string): Proof {
  const dir = path.join(root, "gen/proof", unit.replace(/\.ts$/, ""));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, unit), text);
  // A configuration of our own, so that one further up cannot redirect the proof or relax it.
  fs.writeFileSync(path.join(dir, "lemmascript.json"), JSON.stringify({ "unread-annotations": "error", "run-log": false }));
  const { ok, out } = run("lsc", ["check", "--backend=dafny", unit], dir);
  const dfy = path.join(dir, unit.replace(/\.ts$/, ".dfy"));
  const lines = out.split("\n");
  const source = fs.existsSync(dfy) ? fs.readFileSync(dfy, "utf8").split("\n") : [];
  /** The definition a line of the generated Dafny belongs to. */
  const owner = (line: number) => {
    for (let i = line - 1; i >= 0; i--) {
      const m = source[i]?.match(/^\s*(?:lemma|method|function|ghost function|predicate)\s+(\w+?)(?:_ensures)?\b/);
      if (m) return m[1];
    }
    return "?";
  };
  const quoted = (from: number) => lines.slice(from, from + 4).map((l) => l.match(/^\s*\d+ \|\s*(.*)$/)?.[1]).find(Boolean) ?? "";
  const unproved = new Set<string>();
  const errors = new Set<string>();
  lines.forEach((l, i) => {
    const at = Number(l.match(/\.dfy\((\d+),/)?.[1]);
    const timedOut = l.match(/Error: Verification of '(\w+?)(?:_ensures)?' timed out/);
    if (l.includes("this is the postcondition that could not be proved")) unproved.add(`${owner(at)}: ${quoted(i).replace(/^ensures /, "")}`);
    // Running out of time is also "not proved"; which obligation of the definition it was is not reported.
    else if (timedOut) unproved.add(`${timedOut[1]}: the prover ran out of time`);
    else if (l.includes("Error:") && !l.includes("a postcondition could not be proved")) errors.add(`${l.split("Error: ")[1]}: ${quoted(i)}`);
    else if (/\bwarning\b/i.test(l)) errors.add(l.trim());
  });
  // The verdict is Dafny's own summary; without it, or with anything left unexplained, the unit was not checked.
  if (!/\d+ verified, \d+ errors?/.test(out) || (!ok && !unproved.size && !errors.size)) errors.add(out.trim().split("\n").slice(-3).join(" / ") || "lsc produced no verdict");
  return { total: (text.match(/^\s*\/\/@ (ensures|invariant) /gm) ?? []).length, unproved: [...unproved], errors: [...errors], log: out };
}

// Obligations that hold in simulation but that Dafny cannot prove on its own, accepted by a person.
const ledgerFile = (root: string) => path.join(root, "spec/unproved.lock.json");
const readLedger = (root: string): Record<string, string[]> => (fs.existsSync(ledgerFile(root)) ? JSON.parse(fs.readFileSync(ledgerFile(root), "utf8")) : {});

// --- check -------------------------------------------------------------------------

/**
 * Run every check, cheapest first. Stages after a broken model are skipped,
 * because their failures would only restate the first one. `accept` is
 * "reviews" to record reconciled rules, or "unproved" to record the
 * obligations that are simulated but not proved; either way nothing remembered
 * from an earlier run is used.
 */
export async function check(root: string, log: (line: string) => void = console.log, accept: false | "reviews" | "unproved" = false): Promise<boolean> {
  let allOk = true;
  const report = (ok: boolean, stage: string, summary: string, detail = "") => {
    allOk &&= ok;
    log(`${ok ? "✓" : "✗"} ${stage.padEnd(9)} ${summary}${!ok && detail ? "\n" + detail.trimEnd() : ""}`);
    return ok;
  };
  let specs: Spec[];
  try {
    specs = readSpecs(root);
  } catch (e) {
    return report(false, "model", (e as Error).message);
  }
  fs.rmSync(path.join(root, "gen"), { recursive: true, force: true }); // nothing stale survives a rename
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
    if (!model.state && !model.laws.length && !model.evals.length) continue;

    // A spec whose model and harness are unchanged, and that passed, is not simulated again.
    const closure = (names: string[]): string => names.map((n) => { const dep = specs.find((x) => x.name === n)!; return closure(dep.imports) + dep.qnt; }).join("");
    type Line = [ok: boolean, stage: string, summary: string, detail: string];
    const lines = remembered<Line[]>(root, !!accept, ["simulate", closure(spec.imports), spec.qnt, model.harness, String([SAMPLES, WITNESS_SAMPLES, COMPARED_SAMPLES, REPLAYED, STEPS])], () => {
      const said: Line[] = [];
      const say = (ok: boolean, stage: string, summary: string, detail = "") => said.push([ok, stage, summary, detail]);
      try {
        const sim = simulate(root, model, "inv", REPLAYED);
        // Of the traces that break a rule, show the shortest, and only up to the break.
        const bad = sim.traces.flatMap((t) => { const b = firstBreak(domain, model, t, cite); return b ? [{ t: t.slice(0, b.steps), why: b.why }] : []; })
          .sort((x, y) => x.t.length - y.t.length)[0];
        if (sim.broken || bad) {
          const lastEvent = bad?.t.findLast((s) => s.event)?.event?.type;
          const guard = model.transitions.find((t) => t.name === lastEvent)?.guard;
          // One repair is always available: refuse the event when its result would break the rule. A reason is better.
          const brokenRule = bad && lastEvent ? model.always.find((a) => !domain[a](bad.t[bad.t.length - 1].state)) : undefined;
          const hint = lastEvent && !bad?.why.startsWith("the law") ? `\n      the last event is ${cite(lastEvent)}${guard ? `; its guard ${guard} let it through` : "; it has no guard"}`
            + (brokenRule ? `\n      if no better reason can be found: refuse ${lastEvent} when its result would break ${brokenRule}` : "") : "";
          say(false, "always", `${bad?.why ?? "a rule is broken"}: fix the model, or add the rule that forbids this trace`, bad ? showTrace(bad.t) + hint : "");
          return said;
        }
        say(true, "always", `no rule broken in ${SAMPLES} simulated traces`);
        // A second run, in which the simulator also evaluates every definition it can, supplies more traces to replay.
        const traces = [...sim.traces, ...simulate(root, model, "inv", REPLAYED, COMPARED_SAMPLES, "probe").traces];
        for (const w of model.sometimes) {
          const found = simulate(root, model, `never_${w}`, 1, WITNESS_SAMPLES); // stops at the first witness, so a large budget is cheap
          say(found.broken, "sometimes", found.broken ? `${w} is reachable`
            : `${cite(w)} was not reached in ${WITNESS_SAMPLES} traces of ${STEPS} events: a guard is too strict, a transition is missing, or the goal needs values the simulator does not try`);
          if (found.broken) traces.push(...found.traces);
        }
        for (const t of traces) replay(domain, t, model);
        const compared = new Set(traces.flatMap((t) => t.flatMap((s) => (s.evaluated ? [s.evaluated.name] : []))));
        const missed = [...model.evals.map((v) => v.name).filter((n) => !compared.has(n)), ...model.uncompared];
        say(true, "replay", `generated TypeScript agrees with Quint on ${traces.length} traces: every state${model.laws.length ? ", every law" : ""}, and ${compared.size} definitions evaluated on them`
          + (missed.length ? `; not compared on their own, because the simulator had no arguments for them: ${missed.join(", ")}` : ""));
      } catch (e) {
        const mismatch = (e as Error).message.startsWith("TypeScript and Quint disagree");
        say(false, mismatch ? "replay" : "always", mismatch ? "this is a bug in tools/gen.ts, not in the spec" : "the simulator could not run", indent((e as Error).message));
      }
      return said;
    }, (said) => said.every(([ok]) => ok));
    for (const [ok, stage, summary, detail] of lines) report(ok, stage, summary, detail);
  }

  if (allOk) {
    if (fs.existsSync(path.join(root, "tsconfig.json"))) {
      const tsc = run("tsc", ["--noEmit", "-p", "."], root);
      report(tsc.ok, "types", tsc.ok ? "application typechecks against the generated contract" : "application does not fit the generated contract", indent(tsc.out.trim()));
    } else report(true, "types", "skipped: there is no tsconfig.json, so nothing is typechecked");
    try {
      const accepted = readLedger(root);
      const ledger: Record<string, string[]> = {};
      let recordable = true;
      fs.rmSync(path.join(root, "gen/proof"), { recursive: true, force: true });
      for (const { unit, text } of proofUnits(root, [...models.values()])) {
        const proof = remembered(root, !!accept, ["prove", unit, text], () => prove(root, unit, text), (p) => !p.errors.length);
        const logFile = `gen/proof/${unit.replace(/\.ts$/, ".log")}`;
        fs.mkdirSync(path.join(root, "gen/proof"), { recursive: true });
        fs.writeFileSync(path.join(root, logFile), proof.log);
        const fresh = proof.unproved.filter((u) => !(accepted[unit] ?? []).includes(u));
        const stale = (accepted[unit] ?? []).filter((u) => !proof.unproved.includes(u));
        if (proof.unproved.length) ledger[unit] = proof.unproved;
        if (proof.errors.length) {
          recordable = false;
          report(false, "proof", `${unit}: Dafny could not check it (full output in ${logFile})`, indent(proof.errors.join("\n")));
        } else if (fresh.length && accept !== "unproved") {
          report(false, "proof", `${unit}: ${fresh.length} of ${proof.total} obligations not proved. If simulation is enough for these, record them with \`npm run accept -- unproved\`; otherwise add the rule or guard that makes them provable (full output in ${logFile})`, indent(fresh.join("\n")));
        } else {
          report(true, "proof", `${unit}: ${proof.unproved.length ? `${proof.total} obligations, of which ${proof.unproved.length} are simulated only (accepted) and the rest proved` : `all ${proof.total} obligations proved`} for all states and inputs`
            + (stale.length && accept !== "unproved" ? `; ${stale.length} accepted earlier now prove, run \`npm run accept -- unproved\` to tighten the ledger` : ""));
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
      const moved = movedRules(spec, todo);
      report(!todo.length, "review", todo.length ? `${todo.length} item(s) to reconcile, ${next}` : `${spec.file}: prose and model reconciled for all ${spec.rules.length} rules`,
        todo.map((t) => "    " + t).join("\n") + (moved.length ? `\n\n    The rules that moved, both halves:\n${moved.join("\n")}` : ""));
    }
  }
  return allOk;
}

/** Every spec, with each one after the specs it imports. */
export function readSpecs(root: string): Spec[] {
  const dir = path.join(root, "spec");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
  if (!files.length) throw new Error(`there are no specs: ${dir} holds no .md file`);
  const all = files.map((f) => parseSpec(root, path.join("spec", f)));
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

// --- init ----------------------------------------------------------------------------

/** Give a project what it needs to use the package. Nothing that is already there is replaced. */
export function init(root: string): string[] {
  const pkg = path.join(import.meta.dirname, "..");
  const done: string[] = [];
  const add = (file: string, content: () => string) => {
    if (fs.existsSync(path.join(root, file))) return;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content());
    done.push(file);
  };
  for (const doc of [".claude/skills/sync/SKILL.md", "AGENTS.md", "CONTRIBUTING.md"]) add(doc, () => fs.readFileSync(path.join(pkg, doc), "utf8"));
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

// --- CLI -----------------------------------------------------------------------------

if (import.meta.main) {
  const root = process.cwd();
  const [command, what] = process.argv.slice(2);
  try {
    if (command === "gen") {
      const models = new Map<string, Model>();
      for (const s of readSpecs(root)) gen(root, s, models);
    } else if (command === "check") process.exitCode = (await check(root)) ? 0 : 1;
    else if (command === "accept") process.exitCode = (await check(root, console.log, what === "unproved" ? "unproved" : "reviews")) ? 0 : 1;
    else if (command === "init") {
      const done = init(root);
      console.log(done.length ? `added: ${done.join(", ")}` : "nothing to add: everything is already there");
    } else {
      console.error("usage: spec check | gen | accept | accept unproved | init");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
