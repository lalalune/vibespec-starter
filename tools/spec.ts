#!/usr/bin/env node
// spec/*.md -> Quint -> TypeScript -> proofs (README, "What `npm run check` checks").
//
//   spec check [--json]     run every stage, report what is out of step
//   spec watch              check, then check again on every change to spec/, src/ or test/
//   spec gen [--if-valid]   generate gen/ only
//   spec accept [unproved]  check afresh, then record the reviews (or the obligations simulated only)
//   spec new <name>         write a starter spec/<name>.md
//   spec init               add the sync and design skills, AGENTS.md's section on specs, CLAUDE.md's import of it,
//                           CONTRIBUTING.md and scripts to a project

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, styleText } from "node:util";
import ts from "typescript";
import { generate, LIST_HELPERS, type Model, type Origin } from "./gen.ts";
import { fail } from "./gen/types.ts";
import { exec, LIB_FILE, prove, run, type Proof, type Unit } from "./prove.ts";

// How much is simulated. SPEC_QUICK=1 simulates a tenth as much, for iterating; `accept` never does (checkLocked).
let SAMPLES = 10000; // simulated traces per check
let WITNESS_SAMPLES = 20 * SAMPLES; // traces tried when looking for a state a `sometimes` rule says is reachable
let COMPARED_SAMPLES = 2000; // traces simulated with definitions evaluated along the way
let REPLAYED = 200; // traces of each kind replayed through the generated TypeScript
let QUICK = false;
const STEPS = 20; // events per trace
/** The annotations hand-written verified code may use. Ones that tell the prover to trust or skip something are not proofs. */
const ANNOTATIONS = ["backend", "pure", "requires", "ensures", "invariant", "decreases", "type", "ghost", "assert"];

// --- the spec file -----------------------------------------------------------

export interface Rule { key: string; story: string; line: number; prose: string; code: string; defs: string[] }
/** A `##` heading: a story or another group of rules. Its prose is the text between the heading and its first rule. */
export interface Story { title: string; line: number; prose: string }
/** `meaning` is the Quint as written, with every line of prose blank: what a cache key may depend on. */
export interface Spec { name: string; file: string; rules: Rule[]; stories: Story[]; imports: string[]; qnt: string; meaning: string }

/** Why a name cannot name a spec, or undefined if it can. */
export function badSpecName(name: string): string | undefined {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) return `a spec's file name becomes a module name, so it must look like \`order.md\` or \`orderBook.md\``;
  if (name === "src" || name === "unproved") return `\`${name}\` cannot name a spec: spec/${name}.lock.json is a ledger the tools keep`;
}

/**
 * A spec is Markdown. `##` starts a story (or any grouping), `###` starts a
 * rule, and the ```quint blocks under a rule are its formal half. Tangling
 * keeps every line on its own line number, so Quint errors point into the
 * Markdown file. A fence of any other kind (``` or ~~~, of any length) is
 * prose, and closes only with a fence of the same character at least as long.
 */
export function parseSpec(root: string, file: string): Spec {
  const name = path.basename(file, ".md");
  const bad = badSpecName(name);
  if (bad) throw new Error(`${file}: ${bad}`);
  const rules: Rule[] = [];
  const stories: Story[] = [];
  const qnt: string[] = [];
  const meaning: string[] = [];
  const imports: string[] = [];
  let story: Story | undefined;
  let rule: Rule | undefined;
  let fence: { mark: string; quint: boolean } | undefined;
  // The Quint of the block in progress, to check that no comment or string runs on past its end.
  let block = "";
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
  // Quint and Markdown may not agree on where a line ends at these, and prose could then end a comment early.
  const odd = source.search(/[\r\v\f\u0085\u2028\u2029]/);
  if (odd >= 0) throw new Error(`${file}:${source.slice(0, odd).split("\n").length}: a line break other than \\n; save the file with plain line endings`);
  source.split("\n").forEach((text, i) => {
    const marker = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
    const closes = fence && marker && marker[1][0] === fence.mark[0] && marker[1].length >= fence.mark.length && !marker[2].trim();
    if (closes) {
      // Prose is tangled as `//` comments, which is only safe if no comment or string runs on into it from the code.
      const open = fence!.quint ? scan(block).mode : "";
      if (open) throw new Error(`${file}:${i + 1}: a ${open === '"' ? "string" : "comment"} is still open at the end of this quint block; close it inside the block`);
      fence = undefined;
      block = "";
    } else if (fence?.quint) {
      block += text + "\n";
      meaning.push(text);
      rule!.code += text + "\n";
      const def = text.match(/^\s*(?:pure\s+)?(?:def|val|type)\s+(\w+)/);
      if (def) rule!.defs.push(def[1]);
      const dep = text.match(/^\s*import\s+(\w+)\b/);
      if (dep) imports.push(dep[1]);
      qnt.push(text);
      return;
    } else if (!fence && marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      const quint = marker[2].trim().split(/\s+/)[0] === "quint";
      if (quint && !rule) throw new Error(`${file}:${i + 1}: a quint block must sit under a ### rule`);
      fence = { mark: marker[1], quint };
    } else if (!fence && text.startsWith("## ")) {
      story = { title: text.slice(3).trim(), line: i + 1, prose: "" };
      stories.push(story);
      rule = undefined;
    } else if (!fence && text.startsWith("### ")) {
      rule = { key: `${story?.title ?? ""} / ${text.slice(4).trim()}`, story: story?.title ?? "", line: i + 1, prose: "", code: "", defs: [] };
      if (rules.some((r) => r.key === rule!.key)) throw new Error(`${file}:${i + 1}: duplicate rule "${rule.key}"`);
      rules.push(rule);
    } else if (rule) rule.prose += text + "\n";
    else if (story) story.prose += text + "\n";
    qnt.push(i === 0 ? `module ${name} { // ${text}` : text ? `// ${text}` : "");
    meaning.push(i === 0 ? `module ${name} {` : "");
  });
  if (fence?.quint && scan(block).mode) throw new Error(`${file}: a quint block is never closed, and a comment or string in it is still open`);
  try {
    return { name, file, rules, stories, imports, qnt: expandListHelpers(qnt.join("\n")) + "\n}\n", meaning: meaning.join("\n") };
  } catch (e) {
    throw new Error(`${file}:${(e as Error).message}`);
  }
}

/** Which characters of Quint are code, as opposed to part of a string or a comment, and what is still open at the end. */
function scan(text: string): { code: boolean[]; mode: "" | '"' | "//" | "/*" } {
  const code: boolean[] = [];
  let mode: "" | '"' | "//" | "/*" = "";
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (mode === "" && text[i] === '"') mode = '"';
    else if (mode === "" && two === "//") mode = "//";
    else if (mode === "" && two === "/*") { i++; mode = "/*"; }
    else if (mode === "") { code[i] = true; continue; }
    else if (mode === '"' && text[i] === "\\") i++;
    else if (mode === '"' && text[i] === '"') mode = "";
    else if (mode === "//" && text[i] === "\n") mode = "";
    else if (mode === "/*" && two === "*/") { i++; mode = ""; }
  }
  return { code, mode: mode === "//" ? "" : mode };
}

/**
 * Rewrite `xs.every(x => e)`, `.some`, `.listMap` and `.includes(v)` into Quint's
 * built-in `foldl`, in place and without moving a line (see LIST_HELPERS in
 * gen.ts for why). Strings and comments are left alone.
 */
export function expandListHelpers(text: string): string {
  const { code } = scan(text);
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

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** A hash of several texts, in which no two lists of texts give the same input. */
const sha = (...parts: string[]) => digest(JSON.stringify(parts));
const short = (text: string) => digest(text).slice(0, 12);
const lockFile = (root: string, spec: Spec) => path.join(root, spec.file.replace(/\.md$/, ".lock.json"));
/** Prose may be re-wrapped without becoming a different sentence. Code may not: a line break can end a comment. */
const proseFingerprint = (prose: string) => short(prose.replace(/\s+/g, " ").trim());
export const fingerprint = (r: Rule): [string, string] => [proseFingerprint(r.prose), short(r.code.split("\n").map((l) => l.trimEnd()).join("\n").trim())];
/** A story is recorded under its heading, which no rule's key can be. */
const storyKey = (s: Story) => `## ${s.title}`;
const rulesOf = (spec: Spec, s: Story) => spec.rules.filter((r) => r.story === s.title && r.line > s.line);

/** The identifiers a piece of Quint mentions, outside comments and strings. */
const mentions = (code: string) => new Set(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*|"(?:[^"\\\n]|\\.)*"/g, " ").match(/[A-Za-z_]\w*/g) ?? []);
/** The names a rule's Quint defines: its definitions and types, and the variants of its sum types. */
function defines(rule: Rule): string[] {
  const variants: string[] = [];
  let inType = false;
  for (const line of rule.code.replace(/\/\/.*/g, "").split("\n")) {
    const declared = line.match(/^\s*(?:pure\s+)?(?:def|val|type|import|var|const)\b/);
    if (declared) inType = /^\s*type\s+\w+\s*=/.test(line);
    if (!inType) continue;
    const after = declared ? line.slice(line.indexOf("=") + 1) : line;
    for (const m of after.matchAll(/(?:^|\|)\s*([A-Z]\w*)\s*(?=\(|\||$)/g)) variants.push(m[1]);
  }
  return [...rule.defs, ...variants];
}
const definedIn = new WeakMap<Spec, Map<string, Rule[]>>();
function namesOf(spec: Spec): Map<string, Rule[]> {
  let names = definedIn.get(spec);
  if (!names) {
    names = new Map();
    for (const r of spec.rules) for (const n of defines(r)) names.set(n, [...(names.get(n) ?? []), r]);
    definedIn.set(spec, names);
  }
  return names;
}

/** A rule whose Quint another rule's Quint relies on, and the names it is relied on for. */
interface Dependency { spec: Spec; rule: Rule; names: Set<string> }

/**
 * The rules whose Quint `rule` relies on, directly or through others, in its own spec and in the specs it imports.
 * A name is looked up first in the spec that mentions it, then in the specs that one imports. The scan is
 * conservative: an identifier that happens to share a definition's name counts as a use of it.
 */
export function dependencies(spec: Spec, rule: Rule, specs: Spec[]): Dependency[] {
  const found = new Map<string, Dependency>();
  const visit = (s: Spec, r: Rule) => {
    for (const n of mentions(r.code)) {
      const own = namesOf(s).get(n);
      const homes = own ? own.map((x) => [s, x] as const)
        : s.imports.flatMap((i) => { const d = specs.find((x) => x.name === i); return d ? (namesOf(d).get(n) ?? []).map((x) => [d, x] as const) : []; });
      for (const [ds, dr] of homes) {
        if (dr === r || dr === rule) continue;
        const key = `${ds.file}\0${dr.key}`;
        const seen = found.get(key);
        if (seen) { seen.names.add(n); continue; }
        found.set(key, { spec: ds, rule: dr, names: new Set([n]) });
        visit(ds, dr);
      }
    }
  };
  visit(spec, rule);
  return [...found.values()];
}
/** One fingerprint for the Quint of every rule a rule relies on; undefined if it relies on none. */
const dependencyFingerprint = (deps: Dependency[]) =>
  deps.length ? short(deps.map((d) => `${d.spec.name} / ${d.rule.key}: ${fingerprint(d.rule)[1]}`).sort().join("\n")) : undefined;

/** Something a person has to reconcile before the spec can be accepted. `lines` are a story's rules, or a contract's `//@` lines. */
export interface Pending { where: string; rule?: Rule; story?: Story; lines?: string[]; status: Status; note?: string }
/** What each asks of the agent: .claude/skills/sync/SKILL.md, "What each failure asks of you". */
type Status = "story has no rules" | "new story" | "story changed" | "not formalized" | "new" | "prose and model both changed" | "prose changed"
  | "model changed" | "removed or renamed" | "new contract" | "contract changed" | "contract removed";

/** One item to reconcile, with both halves of what moved beneath it, so that whoever reconciles them compares rather than guesses. */
const showPending = ({ where, rule, story, lines, status, note }: Pending) => {
  const half = (label: string, text: string) => `\n${indent(label, 8)}\n${indent(text || "(only the heading)", 10)}`;
  return `    ${where}\n      ${status}${note ?? ""}${
    rule && (status === "new" || status.includes("changed")) ? half("prose:", rule.prose.trim()) + half("quint:", rule.code.trim())
    : story && lines?.length ? half("text:", story.prose.trim()) + half("rules:", lines.join("\n"))
    : !story && lines ? `\n${indent(lines.join("\n"), 8)}`
    : ""}`;
};

type Lock = Record<string, string[]>;
const readLock = (root: string, spec: Spec): Lock => (fs.existsSync(lockFile(root, spec)) ? JSON.parse(fs.readFileSync(lockFile(root, spec), "utf8")) : {});

/**
 * Stories and rules to reconcile since `accept`. A rule's model is its own Quint and that of every rule it relies
 * on (see `dependencies`), so a change to a helper, a type or an imported definition flags every rule that uses it.
 */
export function pending(root: string, spec: Spec, specs: Spec[] = readSpecs(root)): Pending[] {
  const lock = readLock(root, spec);
  const out: Pending[] = [];
  for (const s of spec.stories) {
    const was = lock[storyKey(s)];
    const status = !rulesOf(spec, s).length ? "story has no rules" : !was ? "new story" : was[0] !== proseFingerprint(s.prose) ? "story changed" : undefined;
    if (status) out.push({ where: `${spec.file}:${s.line}  ${s.title}`, story: s, status, lines: rulesOf(spec, s).map((r) => r.key.slice(s.title.length + 3)) });
  }
  for (const rule of spec.rules) {
    const [prose, code] = fingerprint(rule);
    const deps = dependencies(spec, rule, specs);
    const was = lock[rule.key];
    const prosed = was && was[0] !== prose;
    const relied = was && was[2] !== dependencyFingerprint(deps);
    const modelled = was && (was[1] !== code || relied);
    const status = !rule.code.trim() ? "not formalized" : !was ? "new"
      : prosed && modelled ? "prose and model both changed" : prosed ? "prose changed" : modelled ? "model changed" : undefined;
    let note: string | undefined;
    if (status && relied) {
      // Name the rules it relies on whose own Quint is not what was recorded for them.
      const changed = deps.filter((d) => readLock(root, d.spec)[d.rule.key]?.[1] !== fingerprint(d.rule)[1]);
      note = changed.length ? ` through ${changed.map((d) => `${[...d.names].join(", ")} (${d.spec === spec ? "" : `${d.spec.file}: `}${d.rule.key})`).join("; ")}`
        : was[1] === code ? " through a definition it relies on" : undefined;
    }
    if (status) out.push({ where: `${spec.file}:${rule.line}  ${rule.key}`, rule, status, note });
  }
  for (const key of Object.keys(lock))
    if (!spec.rules.some((r) => r.key === key) && !spec.stories.some((s) => storyKey(s) === key)) out.push({ where: `${spec.file}  ${key}`, status: "removed or renamed" });
  return out;
}

/** Record every story and rule of a spec as reconciled. */
export function acceptReviews(root: string, spec: Spec, specs: Spec[] = readSpecs(root)) {
  // One story or rule per line, in the order of the spec, so a diff of the ledger shows exactly what was re-reviewed.
  const entries = [
    ...spec.stories.map((s) => ({ line: s.line, key: storyKey(s), value: [proseFingerprint(s.prose)] })),
    ...spec.rules.map((r) => {
      const deps = dependencyFingerprint(dependencies(spec, r, specs));
      return { line: r.line, key: r.key, value: deps ? [...fingerprint(r), deps] : fingerprint(r) };
    }),
  ].sort((a, b) => a.line - b.line);
  fs.writeFileSync(lockFile(root, spec), `{\n${entries.map((e) => `  ${JSON.stringify(e.key)}: ${JSON.stringify(e.value)}`).join(",\n")}\n}\n`);
}

// --- the contracts of hand-written verified code ------------------------------------

/**
 * Every file under src/ that LemmaScript would read, because `//@` appears in it, with its text: the .ts files, which
 * are proved, or with `other` the scripts of any other kind, which are refused rather than left unproved.
 */
function srcUnits(root: string, other = false): { file: string; code: string }[] {
  const src = path.join(root, "src");
  const kind = other ? /\.(?:[mc]ts|tsx|[mc]?jsx?)$/ : /\.ts$/;
  const files = fs.existsSync(src) ? (fs.readdirSync(src, { recursive: true }) as string[]).filter((f) => kind.test(f)).sort() : [];
  return files.map((f) => ({ file: f, code: fs.readFileSync(path.join(src, f), "utf8") })).filter((u) => u.code.includes("//@"));
}
const contractsFile = (root: string) => path.join(root, "spec/src.lock.json");
const contractOf = (code: string) => code.split("\n").filter((l) => l.includes("//@")).map((l) => l.trim());
/** The contract of every proved src file, its `//@` lines, under its path. */
const contracts = (root: string) => new Map(srcUnits(root).map((u) => [`src/${u.file.split(path.sep).join("/")}`, contractOf(u.code)]));

/** The `//@` contracts in src/ that are new, changed or gone since `accept`. A file that loses every `//@` is gone. */
export function pendingContracts(root: string): Pending[] {
  const lock: Record<string, string> = fs.existsSync(contractsFile(root)) ? JSON.parse(fs.readFileSync(contractsFile(root), "utf8")) : {};
  const now = contracts(root);
  const out: Pending[] = [];
  for (const [file, lines] of now) {
    const status = !(file in lock) ? "new contract" : lock[file] !== short(lines.join("\n")) ? "contract changed" : undefined;
    if (status) out.push({ where: file, status, lines });
  }
  for (const file of Object.keys(lock)) if (!now.has(file)) out.push({ where: file, status: "contract removed" });
  return out;
}

/** Record the `//@` contract of every proved src file as reconciled. */
export function acceptContracts(root: string) {
  const lines = [...contracts(root)].map(([file, c]) => `  ${JSON.stringify(file)}: ${JSON.stringify(short(c.join("\n")))}`);
  if (lines.length) fs.writeFileSync(contractsFile(root), `{\n${lines.join(",\n")}\n}\n`);
  else fs.rmSync(contractsFile(root), { force: true });
}

const indent = (s: string, by = 6) => s.split("\n").map((l) => " ".repeat(by) + l).join("\n");

// --- remembered results ------------------------------------------------------------

/** What a remembered result was produced by: a different Quint, LemmaScript, Dafny or version of these tools must not reuse it. */
let toolchain: Promise<string> | undefined;
const toolchainId = () => (toolchain ??= (async () => {
  const version = (dep: string) => {
    for (let dir = import.meta.dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const file = path.join(dir, "node_modules", dep, "package.json");
      if (fs.existsSync(file)) return `${dep}@${JSON.parse(fs.readFileSync(file, "utf8")).version}`;
    }
    return dep;
  };
  // Every file of the tools themselves, as source or as built, and the proof library; the self-test and its fixtures are not part of them.
  const own = (f: string) => f.endsWith(path.extname(import.meta.filename)) && !f.startsWith("selftest") && !f.startsWith("fixtures");
  const tools = [...(fs.readdirSync(import.meta.dirname, { recursive: true }) as string[]).filter(own).sort().map((f) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8")), fs.readFileSync(LIB_FILE, "utf8")];
  return [version("@informalsystems/quint"), version("lemmascript"), `dafny@${(await dafnyVersion()).version ?? "none"}`, sha(...tools).slice(0, 12)].join(" ");
})());

/** The version of Dafny on the PATH, read once, or why it could not be read. */
let dafny: Promise<{ version?: string; problem?: string }> | undefined;
const dafnyVersion = () => (dafny ??= run("dafny", ["--version"], import.meta.dirname).then((r) => {
  const version = r.ok ? r.out.match(/\d+\.\d+\.\d+/)?.[0] : undefined;
  const problem = !version ? `Dafny could not be run (${r.out.trim().split("\n")[0] || "it printed no version"})`
    : !version.startsWith("4.11.") ? `this is Dafny ${version}, and LemmaScript targets Dafny 4.11.x` : undefined;
  return { version, problem: problem && `${problem}: the proof stage needs Dafny 4.11 on the PATH (see README, "Quick start")` };
}, (e: Error): { version?: string; problem?: string } => ({ problem: `${e.message} (see README, "Quick start")` })));

/**
 * `produce()`, or what it returned for the same key before if `keep` said so. `accept` (`fresh`) and SPEC_NO_CACHE=1
 * read nothing from the cache. `used` collects every entry touched, so a full check can delete the rest.
 */
async function remembered<T>(root: string, fresh: boolean, used: Set<string>, key: string[], produce: () => Promise<T>, keep: (result: T) => boolean): Promise<T> {
  const name = `${sha(await toolchainId(), ...key).slice(0, 24)}.json`;
  const file = path.join(root, ".spec-cache", name);
  used.add(name);
  if (!fresh && !process.env.SPEC_NO_CACHE && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const result = await produce();
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
export async function gen(root: string, spec: Spec, models = new Map<string, Model>()): Promise<Model> {
  const dir = path.join(root, "gen");
  const out = path.join(dir, `${spec.name}.ir.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${spec.name}.qnt`), spec.qnt);
  const typed = await run("quint", ["typecheck", "--out", out, `gen/${spec.name}.qnt`], root);
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
      state: model.stateType ? read(model.stateType, st.state) : undefined,
      lawsHold: st.lawsHold,
    };
  });
}

/** Every result, once all have ended, in order; the first failure in that order, if any. */
async function settled<T>(work: Promise<T>[]): Promise<T[]> {
  const all = await Promise.allSettled(work);
  for (const r of all) if (r.status === "rejected") throw r.reason;
  return all.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/** SPEC_SEED, or a seed derived from what is simulated, so a run repeats exactly (AGENTS.md, "Checking harder"). */
const seedFor = (...what: string[]) => process.env.SPEC_SEED?.trim() || String(parseInt(digest(what.join("\0")).slice(0, 12), 16));

/**
 * Simulate the harness until `invariant` breaks; returns the traces Quint wrote, and the command that runs the same
 * simulation again.
 */
async function simulate(root: string, model: Model, invariant: string, traces: number, samples = SAMPLES, step = "step"): Promise<{ broken: boolean; traces: Step[][]; again: string }> {
  const dir = path.join(root, "gen/traces", `${model.name}.${invariant}.${step}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = seedFor(model.harness, invariant, step, String(samples));
  const args = ["run", `gen/${model.name}.run.qnt`, "--main", `${model.name}_run`, "--step", step, "--invariant", invariant,
    "--max-samples", String(samples), "--max-steps", String(STEPS), "--mbt", "--seed", seed];
  const r = await run("quint", [...args, "--n-traces", String(traces), "--out-itf", path.join(dir, "{seq}.itf.json")], root);
  const broken = r.out.includes("[violation]");
  const files = fs.readdirSync(dir);
  const again = `seed ${seed}; to simulate again: npx quint ${args.join(" ")}`;
  // Anything other than "held" or "violated", each with a trace, is Quint failing to run.
  if ((!r.ok && !broken) || !files.length) throw new Error(`quint run did not complete (${again}):\n${r.out.trim()}`);
  return { broken, traces: files.map((f) => readTrace(path.join(dir, f), model)), again };
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
 * One unit per spec and per src file with `//@`, each a bundle of what it imports (names prefixed `<module>_`,
 * obligations dropped: they are proved in their own unit) and then itself, since LemmaScript reads one file at a time.
 * AGENTS.md, "Proof files" and "Large applications".
 */
function proofUnits(root: string, models: Model[]): Unit[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const withoutImports = (text: string) => {
    const file = ts.createSourceFile("unit.ts", text, ts.ScriptTarget.Latest, true);
    // `export … from` loads a module as surely as `import` does.
    const imports = file.statements.filter((d): d is ts.ImportDeclaration | ts.ExportDeclaration => ts.isImportDeclaration(d) || (ts.isExportDeclaration(d) && !!d.moduleSpecifier));
    const kept = imports.reduceRight((rest, d) => rest.slice(0, d.getFullStart()) + rest.slice(d.getEnd()), text);
    return { kept, from: imports.map((d) => (d.moduleSpecifier as ts.StringLiteral).text) };
  };
  const withoutObligations = (text: string) => text.replace(/^\s*\/\/@ ensures .*\n/gm, "");
  /** The modules a module needs beside it, dependencies first. */
  const needs = (m: Model, seen: string[] = []): string[] => {
    for (const dep of m.imports) if (!seen.includes(dep)) { needs(byName.get(dep)!, seen); seen.push(dep); }
    return seen;
  };
  const asDependency = (name: string, docs = true) => withoutObligations(withoutImports(byName.get(name)!.render(`${name}_`, docs)).kept);
  /** The laws of modules placed beside a unit, as the unit spells them. */
  const lawsOf = (names: string[], spelled: (dep: string) => string) =>
    names.flatMap((dep) => byName.get(dep)!.laws.map((l) => ({ fn: `${spelled(dep)}${l.name}`, law: l.name, from: `${dep}.ts` })));
  const units: Unit[] = models.map((m) => ({
    unit: `${m.name}.ts`,
    text: [...needs(m).map((n) => asDependency(n)), withoutImports(m.ts).kept].join("\n"),
    meaning: [...needs(m).map((n) => asDependency(n, false)), withoutImports(m.render("", false)).kept].join("\n"),
    src: false,
    proofFile: `spec/${m.name}.proof.dfy`,
    laws: lawsOf(needs(m), (dep) => `${dep}_`),
    rests: [], // proved against the definitions of what it imports, never against their obligations
    transitions: m.stateType ? m.transitions.map((t) => ({ name: t.name, params: t.params.length })) : undefined,
  }));

  const src = path.join(root, "src");
  const other = srcUnits(root, true)[0];
  if (other) throw new Error(`src/${other.file}: \`//@\` appears in it, but only .ts files under src/ are proved; rename it to .ts or remove the annotations`);
  for (const { file: f, code } of srcUnits(root)) {
    // Wherever `//@` appears, even after other text on the line, LemmaScript may read it.
    const used = [...code.matchAll(/\/\/@\s*([\w-]*)/g)].map((m) => m[1]);
    const refused = used.find((k) => !ANNOTATIONS.includes(k));
    if (refused !== undefined) throw new Error(`src/${f}: \`//@ ${refused}\` is not allowed; verified code may only use ${ANNOTATIONS.join(", ")}`);
    if (/\bimport\s*\(|\brequire\s*\(/.test(code)) throw new Error(`src/${f}: verified code may not load other code with import() or require()`);
    checkVerifiedSource(`src/${f}`, code);
    const { kept, from } = withoutImports(code);
    const deps = from.map((spec) => {
      const target = path.resolve(src, path.dirname(f), spec);
      return models.find((m) => target === path.join(root, `gen/${m.name}.ts`))?.name ?? fail(`src/${f}: verified code may only import generated modules (gen/<name>.ts), not ${spec}`);
    });
    if (new Set(deps).size > 1) throw new Error(`src/${f}: verified code may import one generated module; put what it needs from the others into that module's spec`);
    // The module it imports sits beside it under its own names, as the code refers to them.
    const d = deps[0];
    const beside = (docs: boolean) => d ? [...needs(byName.get(d)!).map((n) => asDependency(n, docs)), withoutObligations(withoutImports(byName.get(d)!.render("", docs)).kept)] : [];
    units.push({
      requires: used.filter((k) => k === "requires").length,
      unit: `src-${f.replaceAll(path.sep, "-")}`,
      text: [...beside(true), `// ---- src/${f} ----`, kept].join("\n"),
      // The hand-written code exactly as it is: only what the tools generated is read without its citations.
      meaning: [...beside(false), `// ---- src/${f} ----`, kept].join("\n"),
      src: true,
      proofFile: `src/${f.replace(/\.ts$/, ".proof.dfy")}`,
      laws: d ? [...lawsOf(needs(byName.get(d)!), (dep) => `${dep}_`), ...lawsOf([d], () => "")] : [],
      rests: d ? [...needs(byName.get(d)!), d].map((m) => `${m}.ts`) : [],
    });
  }
  const twice = units.find((u, i) => units.findIndex((v) => v.unit === u.unit) !== i);
  if (twice) throw new Error(`two files would be proved under the name ${twice.unit}; rename one of them`);
  return units;
}

/**
 * Refuse in hand-written verified code what the proof would read one way and Node another: a renamed, default or
 * namespace import, an export other than of a function, constant, type or interface declared in the file, any other
 * top-level statement (LemmaScript does not model one, though Node runs it), and a `//@` that is not in a `//`
 * comment (one in a block comment or a string is not an annotation, though it looks like one). And NUL, which no
 * source needs.
 */
export function checkVerifiedSource(file: string, code: string) {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const refuse = (at: number, why: string): never => { throw new Error(`${file}:${sf.getLineAndCharacterOfPosition(at).line + 1}: ${why}`); };
  if (code.includes("\0")) refuse(code.indexOf("\0"), "NUL characters are not allowed");
  for (const s of sf.statements) {
    const modifier = (ts.canHaveModifiers(s) ? ts.getModifiers(s) ?? [] : []).find((m) => m.kind !== ts.SyntaxKind.ExportKeyword);
    if (modifier) refuse(modifier.getStart(), `\`${modifier.getText()}\` is not allowed in verified code`);
    const clause = ts.isImportDeclaration(s) ? s.importClause : undefined;
    const bindings = clause?.namedBindings;
    if (clause?.name || (bindings && ts.isNamespaceImport(bindings))) refuse(s.getStart(), "verified code may import only by name (`import { a, type B } from ...`): not a default or namespace import");
    const renamed = bindings && ts.isNamedImports(bindings) && bindings.elements.find((e) => e.propertyName);
    if (renamed) refuse(renamed.getStart(), `\`${renamed.getText()}\`: verified code may not rename what it imports, since the proof reads the name as written`);
    const allowed = ts.isImportDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)
      || (ts.isFunctionDeclaration(s) && !!s.body && !s.asteriskToken)
      || (ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const);
    if (!allowed) refuse(s.getStart(), "verified code may hold only imports, functions with a body, interfaces, type aliases and const declarations, each exported in its own declaration or not at all");
  }
  // Every comment is the leading trivia of a token; JSDoc is skipped, since its parts lie inside a comment.
  const lineComments: [number, number][] = [];
  const visit = (n: ts.Node) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    for (const c of ts.getLeadingCommentRanges(code, n.pos) ?? []) if (c.kind === ts.SyntaxKind.SingleLineCommentTrivia) lineComments.push([c.pos, c.end]);
    n.getChildren(sf).forEach(visit);
  };
  visit(sf);
  for (const m of code.matchAll(/\/\/@/g))
    if (!lineComments.some(([from, to]) => from <= m.index && m.index < to)) refuse(m.index, "`//@` here is not in a `//` comment (it is in a block comment or a string), so it is not an annotation; remove it or make it one");
}

/** Proof files that belong to no unit: a typo, or a source file that is no longer proved. */
function strayProofFiles(root: string, units: Unit[]): string[] {
  const found = ["spec", "src"].flatMap((dir) => fs.existsSync(path.join(root, dir))
    ? (fs.readdirSync(path.join(root, dir), { recursive: true }) as string[]).filter((f) => f.endsWith(".proof.dfy")).map((f) => path.join(dir, f).split(path.sep).join("/")) : []);
  return found.filter((f) => !units.some((u) => u.proofFile === f));
}

/**
 * Obligations that hold in simulation but that Dafny cannot prove on its own,
 * accepted by a person: per unit, the list, and a fingerprint of the unit's
 * text and proof file when they were accepted. A list accepted for another
 * text no longer counts.
 */
interface Accepted { text: string; unproved: string[] }
const ledgerFile = (root: string) => path.join(root, "spec/unproved.lock.json");
function readLedger(root: string): Record<string, Accepted | undefined> {
  if (!fs.existsSync(ledgerFile(root))) return {};
  const raw: Record<string, unknown> = JSON.parse(fs.readFileSync(ledgerFile(root), "utf8"));
  // A bare list names no text it was accepted for, so it never counts.
  return Object.fromEntries(Object.entries(raw).map(([unit, v]) => [unit, Array.isArray(v) ? { text: "", unproved: v } : (v as Accepted)]));
}
function writeLedger(root: string, ledger: Record<string, Accepted>) {
  // One obligation per line, so a diff of the ledger shows exactly what was accepted.
  const lines = Object.entries(ledger).map(([unit, { text, unproved }]) =>
    `  ${JSON.stringify(unit)}: {\n    "text": ${JSON.stringify(text)},\n    "unproved": [\n${unproved.map((u) => `      ${JSON.stringify(u)}`).join(",\n")}\n    ]\n  }`);
  if (lines.length) fs.writeFileSync(ledgerFile(root), `{\n${lines.join(",\n")}\n}\n`);
  else fs.rmSync(ledgerFile(root), { force: true });
}

// --- check -------------------------------------------------------------------------

/**
 * What one stage found: about one spec, one proof unit, or the project as a whole. `where` is the spec, unit or file
 * it is about. A result of the stage "skipped" names stages that did not run, and is not a failure in itself.
 */
export interface Result { ok: boolean; stage: "model" | "always" | "sometimes" | "replay" | "types" | "proof" | "tests" | "review" | "skipped"; summary: string; detail: string; where?: string }
/** One result as the command line prints it, prefixed with what it is about unless its summary already says. Colour only on a terminal. */
export const show = ({ ok, stage, summary, detail, where }: Result) => {
  const mark = stage === "skipped" ? styleText("dim", "-") : ok ? styleText("green", "✓") : styleText("red", "✗");
  const about = where && !summary.startsWith(where) ? `${where}: ` : "";
  return `${mark} ${stage.padEnd(9)} ${about}${summary}${detail ? "\n" + detail.trimEnd() : ""}`;
};

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
      tests: "fix the application, or cite the story or rule by its heading as the spec now has it",
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
    if (alive(holder) || attempt) throw new Error(`another check or accept is running in this project (process ${holder}); if it is not, delete ${path.relative(root, file)}`);
    fs.rmSync(file, { force: true });
  }
}

/**
 * Run every stage, cheapest first; `log` hears of each result as it arrives. Stages after a ✗ are skipped, and said
 * to be. `accept` records the reviews, or the obligations simulated only, and reads nothing from the cache. One check
 * or accept per project at a time.
 */
export async function check(root: string, accept: false | "reviews" | "unproved" = false, log: (result: Result) => void = () => {}): Promise<{ ok: boolean; results: Result[]; next: string }> {
  // The tests stage sets SPEC_TESTS for what it runs: a test script that runs the check again would wait on this check's lock.
  if (process.env.SPEC_TESTS) throw new Error("the package's `test` script runs `spec check`; it must run only the tests (AGENTS.md, \"Tests\")");
  const release = lockProject(root);
  try {
    const results: Result[] = [];
    const ok = await checkLocked(root, accept, (r) => { results.push(r); log(r); });
    return { ok, results, next: nextStep(results) };
  } finally {
    release();
  }
}

async function checkLocked(root: string, accept: false | "reviews" | "unproved", log: (result: Result) => void): Promise<boolean> {
  QUICK = !accept && !!process.env.SPEC_QUICK && process.env.SPEC_QUICK !== "0";
  [SAMPLES, COMPARED_SAMPLES, REPLAYED] = QUICK ? [1000, 200, 50] : [10000, 2000, 200];
  WITNESS_SAMPLES = 20 * SAMPLES;
  let allOk = true;
  const report = (ok: boolean, stage: Result["stage"], summary: string, detail = "", where?: string, keepDetail = false) => {
    allOk &&= ok;
    log({ ok, stage, summary, detail: ok && !keepDetail ? "" : detail, ...(where ? { where } : {}) });
  };
  const skip = (stages: string, why = "blocked by the ✗ above") => report(true, "skipped", `${stages}: ${why}`);
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
  // A spec is simulated while the next is generated, and what each says is reported in spec order.
  let turn = Promise.resolve();
  const inTurn = <T>(then: (r: T) => void, work?: Promise<T>) => (turn = Promise.all([turn, work]).then(([, r]) => then(r as T))).catch(() => {});

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
      model = await gen(root, spec, models);
      fs.mkdirSync(loaded, { recursive: true });
      fs.copyFileSync(path.join(root, `gen/${spec.name}.ts`), path.join(loaded, `${spec.name}.ts`));
      domain = await import(pathToFileURL(path.join(loaded, `${spec.name}.ts`)).href);
    } catch (e) {
      inTurn(() => {
        report(false, "model", `${spec.file} is not a valid model`, indent((e as Error).message.trim()), spec.file);
        skip(`always, sometimes and replay of ${spec.file}`);
      });
      continue;
    }
    valid.push(spec);
    const parts = [[model.transitions.length, "transitions"], [model.always.length, "always"], [model.steps.length, "step"], [model.sometimes.length, "sometimes"], [model.laws.length, "laws"]];
    inTurn(() => report(true, "model", `${spec.file}: ${parts.filter(([n]) => n).map((p) => p.join(" ")).join(", ") || "definitions only"}`, "", spec.file));
    if (!model.stateType && !model.laws.length && !model.evals.length) continue;

    // A spec whose model and harness are unchanged, and that passed, is not simulated again.
    const closure = (names: string[]): string => names.map((n) => { const dep = specs.find((x) => x.name === n)!; return closure(dep.imports) + dep.meaning; }).join("");
    const found = remembered<Result[]>(root, !!accept, used, ["simulate", closure(spec.imports), spec.meaning, model.harness, String([SAMPLES, WITNESS_SAMPLES, COMPARED_SAMPLES, REPLAYED, STEPS]), process.env.SPEC_SEED ?? ""], async () => {
      const said: Result[] = [];
      const say = (ok: boolean, stage: Result["stage"], summary: string, detail = "") => said.push({ ok, stage, summary, detail });
      try {
        // Of the traces that break a rule, the shortest, and only up to the break.
        const shortestBreak = (traces: Step[][]) => traces.flatMap((t) => { const b = firstBreak(domain, model, t, cite); return b ? [{ t: t.slice(0, b.steps), why: b.why }] : []; })
          .sort((x, y) => x.t.length - y.t.length)[0];
        // The first run goes alone: Quint installs its evaluator on first use, and runs started together would race to.
        // The rest are independent and overlap. The probe, in which the simulator also evaluates every definition it
        // can, supplies more traces to replay. Each witness search stops at its goal or at a broken rule, whichever
        // comes first (see the harness). All of them finish before anything is reported, failures included.
        const sim = await simulate(root, model, "inv", REPLAYED);
        const [probe, ...goals] = await settled([simulate(root, model, "inv", REPLAYED, COMPARED_SAMPLES, "probe"),
          ...model.sometimes.map((w) => simulate(root, model, `never_${w}`, 1, WITNESS_SAMPLES))]);
        const witnesses = model.sometimes.map((w, i) => ({ w, search: goals[i] }));
        const traces = [...sim.traces, ...probe.traces, ...witnesses.flatMap(({ search }) => (search.broken ? search.traces : []))];
        const bad = shortestBreak(traces);
        if (sim.broken || probe.broken || bad) {
          const lastEvent = bad?.t.findLast((s) => s.event)?.event?.type;
          const guard = model.transitions.find((t) => t.name === lastEvent)?.guard;
          // One repair is always available: refuse the event when its result would break the rule. A reason is better.
          const brokenRule = bad && lastEvent ? model.always.find((a) => !domain[a](bad.t[bad.t.length - 1].state)) : undefined;
          const hint = lastEvent && !bad?.why.startsWith("the law") ? `\n      last event: ${cite(lastEvent)}${guard ? `; its guard ${guard} let it through` : ", unguarded"}`
            + (brokenRule ? `\n      fallback: refuse ${lastEvent} when its result would break ${brokenRule}` : "") : "";
          say(false, "always", bad?.why ?? "a rule is broken", `${bad ? showTrace(bad.t) + hint + "\n" : ""}      ${sim.again}`);
          return said;
        }
        say(true, "always", `no rule broken in ${SAMPLES + COMPARED_SAMPLES} traces${QUICK ? " (SPEC_QUICK: a tenth of a full check; `npm run accept` simulates in full)" : ""}`);
        // A witness search ends at its goal or at a broken rule, so only a final state that meets the goal reaches it.
        const reached: string[] = [];
        for (const { w, search } of witnesses) {
          if (search.broken && search.traces.some((t) => domain[w](t.at(-1)?.state))) reached.push(w);
          else say(false, "sometimes", `${cite(w)} not reached in ${WITNESS_SAMPLES} traces of ${STEPS} events`, `      ${search.again}`);
        }
        // A guard must allow its event in some reachable state; one never seen to refuse it is listed (AGENTS.md,
        // "Writing good rules"). The simulator searches only for the side the traces so far do not show.
        const guarded = model.transitions.filter((t) => t.guard);
        const seen = new Map(guarded.map((t) => [t.guard!, { allows: false, refuses: false }]));
        for (const { event, evaluated } of traces.flat()) {
          const fired = event && guarded.find((g) => g.name === event.type);
          if (fired) seen.get(fired.guard!)!.allows = true;
          if (evaluated && seen.has(evaluated.name)) seen.get(evaluated.name)![evaluated.result ? "allows" : "refuses"] = true;
        }
        // The harness has a witness invariant for every guard whose arguments the simulator can supply.
        const searches = [...new Set(guarded.flatMap((t) => (["allows", "refuses"] as const).filter((side) => !seen.get(t.guard!)![side] && model.evals.some((v) => v.name === t.guard)).map((side) => `never_${side}_${t.guard}`)))];
        const searched = new Map((await settled(searches.map((inv) => simulate(root, model, inv, 1, WITNESS_SAMPLES, "probe")))).map((r, i) => [searches[i], r]));
        const neverRefused: string[] = [];
        for (const t of guarded) {
          const g = t.guard!;
          for (const side of ["allows", "refuses"] as const) {
            if (seen.get(g)![side]) continue;
            const found = searched.get(`never_${side}_${g}`);
            if (found?.broken) { seen.get(g)![side] = true; traces.push(...found.traces); continue; }
            if (side === "refuses") { neverRefused.push(g); continue; }
            const values = t.params.length ? `; if it needs other values, define ${t.params.map((p) => `${p.name}Values`).join(" or ")}` : "";
            say(false, "sometimes", `${t.name} in ${cite(t.name)} never happened: its guard ${g} refused it in every state of ${WITNESS_SAMPLES} traces of ${STEPS} events${values}`, found ? `      ${found.again}` : "");
          }
        }
        const allowing = guarded.filter((t) => seen.get(t.guard!)!.allows).length;
        const fine = [
          ...(reached.length ? [`${reached.join(", ")} reachable`] : []),
          ...(allowing ? [`${allowing} of ${guarded.length} guards allow their event` + (neverRefused.length ? `; never seen to refuse it (${STEPS} events, values tried): ${neverRefused.join(", ")}` : " and refuse it")] : []),
        ];
        if (fine.length) say(true, "sometimes", fine.join("; "));
        for (const t of traces) replay(domain, t, model);
        const compared = new Set(traces.flatMap((t) => t.flatMap((s) => (s.evaluated ? [s.evaluated.name] : []))));
        const missed = [...model.evals.map((v) => v.name).filter((n) => !compared.has(n)), ...model.uncompared];
        say(true, "replay", `TypeScript agrees with Quint on ${traces.length} traces: every state${model.laws.length ? ", every law" : ""}, and ${compared.size} definitions`
          + (missed.length ? `; not compared, no arguments sampled: ${missed.join(", ")}` : ""));
      } catch (e) {
        const message = (e as Error).message;
        const mismatch = message.startsWith("TypeScript and Quint disagree");
        say(false, mismatch ? "replay" : "always", mismatch ? "generated TypeScript disagrees with Quint: a bug in tools/gen.ts or tools/gen/" : "the simulator could not run", indent(message));
      }
      return said;
    }, (said) => said.every((r) => r.ok));
    inTurn((found) => {
      for (const r of found) report(r.ok, r.stage, r.summary, r.detail, spec.file);
      const ran = new Set(found.map((r) => r.stage));
      const notRun = (["sometimes", "replay"] as const).filter((s) => !ran.has(s) && (s !== "sometimes" || model.sometimes.length));
      if (notRun.length && found.some((r) => !r.ok)) skip(`${notRun.join(" and ")} of ${spec.file}`);
    }, found);
  }
  await turn;

  const complete = allOk;
  if (!allOk) skip("types, proof and tests");
  if (allOk) {
    // Types, proofs and tests run side by side, and are reported in that order.
    const typing = fs.existsSync(path.join(root, "tsconfig.json")) ? run("tsc", ["--noEmit", "-p", "."], root) : undefined;
    const testing = tests(root, specs);
    // Each unit is proved as soon as the units whose laws it may use are.
    const proving = new Map<string, Promise<{ proof: Proof; proofText?: string }>>();
    const starting = (async () => {
      const dafnyProblem = (await dafnyVersion()).problem;
      if (dafnyProblem) throw new Error(dafnyProblem);
      const accepted = readLedger(root);
      fs.rmSync(path.join(root, "gen/proof"), { recursive: true, force: true });
      const units = proofUnits(root, [...models.values()]);
      const lib = fs.readFileSync(LIB_FILE, "utf8");
      for (const u of units) {
        const deps = u.laws.flatMap(({ from }) => (proving.has(from) ? [[from, proving.get(from)!] as const] : []));
        const unitProof = (async () => {
          const proofPath = path.join(root, u.proofFile);
          const proofText = fs.existsSync(proofPath) ? fs.readFileSync(proofPath, "utf8") : undefined;
          // Laws are offered only to a proof file, so a unit without one waits for nothing.
          const proved = new Map(proofText === undefined ? [] : await Promise.all(deps.map(async ([d, p]) => [d, (await p).proof] as const)));
          // A law of an imported module is offered only if its own unit proved it, in this run: not simulated only, and
          // not resting on an obligation that is (a law that does is among the unit's obligations not proved).
          const laws = u.laws.filter(({ law, from }) => {
            const p = proved.get(from);
            return p && !p.errors.length && !p.unproved.some((x) => x.startsWith(`${law}: `));
          }).map((l) => l.fn);
          const offered = { proof: proofText === undefined ? undefined : { file: u.proofFile, text: proofText }, lib, laws };
          const proof = await remembered(root, !!accept, used, ["prove", u.unit, u.meaning, proofText ?? "", proofText === undefined ? "" : laws.join(" ")], () => prove(root, u, offered), (p) => !p.errors.length);
          return { proof, proofText };
        })();
        unitProof.catch(() => {});
        proving.set(u.unit, unitProof);
      }
      return { accepted, units };
    })();
    starting.catch(() => {});
    if (typing) {
      const tsc = await typing;
      report(tsc.ok, "types", tsc.ok ? "fit the generated contract" : "do not fit the generated contract", indent(tsc.out.trim()), "src/ and test/");
    } else {
      const code = ["src", "test"].filter((d) => fs.existsSync(path.join(root, d)));
      if (code.length) report(false, "types", `${code.join(" and ")} exist but there is no tsconfig.json, so nothing checks them against the generated contract; run \`spec init\` to add one`);
      else skip("types", "no tsconfig.json, and no src/ or test/");
    }
    let proofsRan = false;
    try {
      const { accepted, units } = await starting;
      const ledger: Record<string, Accepted> = {};
      let recordable = true;
      for (const f of strayProofFiles(root, units))
        report(false, "proof", `${f} belongs to no proof unit: spec/<name>.proof.dfy belongs to spec/<name>.md, and src/<path>.proof.dfy to src/<path>.ts if that file contains //@`, "", f);
      const proved = new Map<string, Proof>();
      for (const u of units) {
        const { proof, proofText } = await proving.get(u.unit)!;
        proved.set(u.unit, proof);
        const base = u.unit.replace(/\.ts$/, "");
        const logFile = `gen/proof/${base}.log`;
        // The final Dafny stays on disk even when the result was remembered, so that it can be read.
        const dfyFile = path.join(root, "gen/proof", base, `${base}.dfy`);
        fs.mkdirSync(path.dirname(dfyFile), { recursive: true });
        fs.writeFileSync(path.join(root, logFile), proof.log);
        if (proof.dfy && !fs.existsSync(dfyFile)) fs.writeFileSync(dfyFile, proof.dfy);
        // What was accepted is tied to the text it was accepted for. Hand-written code is not simulated, so nothing
        // of it can be accepted: its obligations must be proved.
        const meaning = sha(u.text, proofText ?? "").slice(0, 12);
        const was = u.src ? undefined : accepted[u.unit];
        const valid = was?.text === meaning ? was.unproved : [];
        const outdated = was && was.text !== meaning ? `; the ${was.unproved.length} accepted earlier were accepted for another text of this unit or its proof file, and no longer count` : "";
        const fresh = proof.unproved.filter((x) => !valid.includes(x));
        const stale = valid.filter((x) => !proof.unproved.includes(x));
        if (proof.unproved.length && !u.src) ledger[u.unit] = { text: meaning, unproved: proof.unproved };
        const listed = (xs: string[]) => indent(xs.map((x) => x + (proof.exhausted.includes(x) ? "   [the prover ran out of resources]" : "")
          + (proof.resting?.[x] ? `   [rests on ${proof.resting[x]}]` : "")).join("\n"));
        // Hand-written code proved against a module that is only partly proved rests on what is not.
        const assumed = u.rests.flatMap((r) => (proved.get(r)?.unproved ?? []).map((x) => `${r}: ${x}`));
        const assuming = (assumed.length ? `, assuming the obligations that are simulated only (${u.rests.flatMap((r) => (proved.get(r)?.unproved.length ? [`${proved.get(r)!.unproved.length} of ${r}`] : [])).join(", ")})` : "")
          // A precondition is assumed by the proof and checked by no one: callers outside verified code must meet it.
          + (u.requires ? `, under ${u.requires} //@ requires that its unverified callers must meet` : "");
        if (proof.errors.length) {
          recordable = false;
          report(false, "proof", `${u.unit}: Dafny could not check it (full output in ${logFile}, final Dafny in gen/proof/${base}/${base}.dfy)`, indent(proof.errors.join("\n")), u.unit);
        } else if (fresh.length && (accept !== "unproved" || u.src)) {
          const what = u.src ? "Hand-written code is not simulated, so they must be proved" : "if simulation is enough for them, that is the user's decision (`npm run accept -- unproved`)";
          report(false, "proof", `${u.unit}: ${fresh.length} of ${proof.total} obligations not proved${outdated}. Prove them in ${u.proofFile}, or add the rule that makes them provable; ${what}. Full output in ${logFile}, final Dafny in gen/proof/${base}/${base}.dfy`, listed(fresh), u.unit);
        } else {
          // Whatever a proof line relies on without proof is listed under it.
          const relied = [...(proof.unproved.length ? ["simulated only, accepted in spec/unproved.lock.json:", ...proof.unproved.map((x) => `  ${x}`)] : []),
            ...(assumed.length ? ["assumed from the module it is proved against, simulated only there:", ...assumed.map((x) => `  ${x}`)] : [])];
          report(true, "proof", `${u.unit}: ${proof.unproved.length ? `${proof.total} obligations, of which ${proof.unproved.length} are simulated only (accepted) and the rest proved` : `all ${proof.total} obligations proved`} for all states and inputs${assuming}`
            + (stale.length && accept !== "unproved" ? `; ${stale.length} accepted earlier now prove, run \`npm run accept -- unproved\` to tighten the ledger` : ""), indent(relied.join("\n")), u.unit, relied.length > 0);
        }
      }
      if (accept === "unproved" && recordable) {
        writeLedger(root, ledger);
        // What was recorded, against what was there: an entry recorded for another text of its unit is replaced.
        const entries = (l: Record<string, Accepted | undefined>) => Object.entries(l).flatMap(([unit, a]) => (a?.unproved ?? []).map((x) => `${unit}: ${x}  [${a!.text}]`));
        const [before, after] = [entries(accepted), entries(ledger)];
        const added = after.filter((x) => !before.includes(x));
        const removed = before.filter((x) => !after.includes(x));
        const line = (sign: string) => (x: string) => `    ${sign} ${x.replace(/  \[[^\]]*\]$/, "")}`;
        report(true, "proof", `${path.relative(root, ledgerFile(root))}: ${added.length} added, ${removed.length} removed`,
          [...added.map(line("+")), ...removed.map(line("-"))].join("\n"), undefined, true);
      }
      proofsRan = true;
    } catch (e) {
      await Promise.allSettled(proving.values());
      report(false, "proof", (e as Error).message);
    }
    for (const r of await testing) report(...r);
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
  const refused = accept !== "reviews" || record ? "" : !allOk ? "; nothing recorded: the ✗ above comes first" : "; nothing recorded: every story needs rules, every rule a quint block";
  const items = (todo: Pending[]) => todo.map(showPending).join("\n");
  for (const { spec, todo } of todos) {
    if (record && todo.length) {
      acceptReviews(root, spec, specs);
      report(true, "review", `${spec.file}: recorded ${todo.map((t) => t.rule?.key ?? t.story?.title ?? t.where.slice(t.where.indexOf("  ") + 2)).join("; ")}`, "", spec.file);
    } else report(!todo.length, "review", todo.length ? `${spec.file}: ${todo.length} to reconcile${refused}` : `${spec.file}: ${spec.rules.length} rules and ${spec.stories.length} stories reconciled`, items(todo), spec.file);
  }
  const proved = contracts(root).size;
  if (record && contractsToDo.length) {
    acceptContracts(root);
    report(true, "review", `src/: recorded ${contractsToDo.map((t) => t.where).join("; ")}`, "", "src/");
  } else if (contractsToDo.length) report(false, "review", `src/: ${contractsToDo.length} contracts to reconcile${refused}`, items(contractsToDo), "src/");
  else if (proved) report(true, "review", `src/: ${proved} //@ contracts reconciled`, "", "src/");
  return allOk;
}

/** The tests stage: citations that name nothing, then the package's own tests; each result as `report` takes it. */
async function tests(root: string, specs: Spec[]): Promise<[boolean, "tests", string, string?, string?][]> {
  const said: [boolean, "tests", string, string?, string?][] = [];
  try {
    const dangling = danglingCitations(root, specs);
    if (dangling.length) said.push([false, "tests", `${dangling.length} citations name no story or rule of the spec`, indent(dangling.join("\n"))]);
    // The package's own tests, in whatever runner it chose (AGENTS.md, "Tests"): its `test` script, or else
    // Node's on test/**/*.test.ts. The placeholder `npm init` writes is no script.
    const pkg = fs.existsSync(path.join(root, "package.json")) ? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) : {};
    const script = /no test specified/.test(pkg.scripts?.test ?? "") ? undefined : pkg.scripts?.test;
    const files = fs.existsSync(path.join(root, "test")) ? (fs.readdirSync(path.join(root, "test"), { recursive: true }) as string[]).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `test/${f}`) : [];
    const [command, args] = script ? [packageManager(root), ["run", "test"]] : [process.execPath, ["--test", ...files]];
    if (script || files.length) {
      // Inside another test run (NODE_TEST_CONTEXT set), `node --test` would report to that run and always exit 0.
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      const t = await exec(command, args, root, { ...env, SPEC_TESTS: "1" });
      const failures = t.stdout.includes("✖ failing tests:") ? t.stdout.slice(t.stdout.indexOf("✖ failing tests:")) : t.stdout.split("\n").slice(-80).join("\n");
      const ok = t.status === 0 && !t.stopped;
      said.push([ok, "tests", ok ? "pass" : "fail", indent((failures + t.stderr + (t.stopped ? `\n${t.stopped}` : "")).trim()), script ? `${command} run test` : "test/"]);
    }
  } catch (e) {
    said.push([false, "tests", (e as Error).message]);
  }
  return said;
}

/**
 * Every `spec/<name>.md, "<heading>"` in the package's code whose heading is no story or rule of that spec, as
 * `file:line  citation`. Build output and packages nested inside it, which have specs of their own, are not read.
 */
export function danglingCitations(root: string, specs: Spec[]): string[] {
  const code = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isFile()) return /\.[cm]?[jt]sx?$/.test(e.name) ? [rel] : [];
    const skip = /^(node_modules|dist|build|out|coverage|\..*)$/.test(e.name) || rel === "gen" || fs.existsSync(path.join(root, rel, "package.json"));
    return e.isDirectory() && !skip ? code(rel) : [];
  });
  const heading = (s: Spec, r: Rule) => r.key.slice((s.stories.findLast((t) => t.line < r.line)?.title ?? "").length + 3);
  const names = (s: Spec, h: string) => s.stories.some((t) => t.title === h) || s.rules.some((r) => heading(s, r) === h);
  return code("").sort().flatMap((f) =>
    fs.readFileSync(path.join(root, f), "utf8").split("\n").flatMap((line, i) =>
      [...line.matchAll(/(?<![\w/.-])spec\/(\w+)\.md, "([^"]+)"/g)]
        .filter(([, name, h]) => !specs.some((s) => s.name === name && names(s, h)))
        .map(([cited]) => `${f}:${i + 1}  ${cited}`)));
}

/** The package manager a package declares, or whose lock file sits in it or a directory above it, up to the repository or workspace root. */
function packageManager(root: string): string {
  const locks: Record<string, string> = { "pnpm-lock.yaml": "pnpm", "bun.lock": "bun", "bun.lockb": "bun", "yarn.lock": "yarn", "package-lock.json": "npm" };
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const pkg = fs.existsSync(path.join(dir, "package.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) : {};
    if (pkg.packageManager) return pkg.packageManager.split("@")[0];
    const lock = Object.keys(locks).find((f) => fs.existsSync(path.join(dir, f)));
    if (lock) return locks[lock];
    if (pkg.workspaces || fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) return "npm";
  }
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
    const scripts = { check: "spec check", watch: "spec watch", gen: "spec gen", accept: "spec accept", new: "spec new" };
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
rules with your own; AGENTS.md says how to write them.

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
  if (fs.existsSync(path.join(root, file))) throw new Error(`${file} already exists`);
  fs.mkdirSync(path.join(root, "spec"), { recursive: true });
  fs.writeFileSync(path.join(root, file), starter(name));
  return file;
}

// --- CLI -----------------------------------------------------------------------------

const script = process.argv[1];
const isMain = !!script && fs.existsSync(script) && fs.realpathSync(script) === fs.realpathSync(import.meta.filename);
const USAGE = "usage: spec check [--json] | watch | gen [--if-valid] | accept [unproved] | new <name> | init";

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
        console.log(`\n${styleText("bold", "next:")} ${next}\n(${((Date.now() - started) / 1000).toFixed(1)}s; watching spec/, src/, test/ and tsconfig.json; Ctrl-C to stop)`);
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

if (isMain) {
  const root = process.cwd();
  const [command, ...args] = process.argv.slice(2);
  const takes = (...allowed: string[][]) => allowed.some((a) => a.length === args.length && a.every((x, i) => x === "*" || x === args[i]));
  try {
    if (Number(process.versions.node.split(".")[0]) < 24) throw new Error(`spec needs Node 24 or later; this is Node ${process.versions.node}`);
    if (command === "gen" && takes([], ["--if-valid"])) {
      try {
        const models = new Map<string, Model>();
        for (const s of readSpecs(root)) await gen(root, s, models);
      } catch (e) {
        if (!args.length) throw e;
        // --if-valid: package.json "prepare", so that a spec mid-edit does not fail `npm install`.
        console.log(`note: gen/ was not generated: ${(e as Error).message.split("\n")[0]}`);
      }
    } else if ((command === "check" && takes([], ["--json"])) || (command === "accept" && takes([], ["unproved"]))) {
      const json = args[0] === "--json";
      const accept = command === "check" ? false : args[0] === "unproved" ? "unproved" : "reviews";
      const { ok, results, next } = await check(root, accept, json ? undefined : (r) => console.log(show(r)));
      console.log(json ? JSON.stringify({ ok, results, next }, null, 2) : `\n${styleText("bold", "next:")} ${next}`);
      process.exitCode = ok ? 0 : 1;
    } else if (command === "init" && takes([])) {
      const done = init(root);
      console.log(done.length ? `added ${done.join(", ")}` : "nothing to add");
    } else if (command === "watch" && takes([])) {
      await watch(root);
    } else if (command === "new" && takes(["*"])) {
      console.log(`wrote ${newSpec(root, args[0])}`);
    } else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
