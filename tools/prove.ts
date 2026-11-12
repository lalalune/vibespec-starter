// The proof stage for one unit: LemmaScript turns the unit's TypeScript into
// Dafny, the tools add what they generate and what the unit's proof file
// supplies, LemmaScript checks that nothing generated was changed and runs
// Dafny, and `dafny audit` checks that nothing added is trusted rather than
// proved.
//
// Counting is per obligation. Dafny runs with every assertion isolated and no
// error limit, and because a postcondition that fails is still assumed while
// the ones after it are checked, every postcondition of a lemma that has a
// failure is checked again on its own.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The library of general lemmas that proof files call as ProofLib.<Name>. */
export const LIB_FILE = path.join(import.meta.dirname, "proof", "lib.dfy");
/** The one name the library adds to a unit. */
export const LIB_MODULE = "ProofLib";
/**
 * How Dafny is run. Isolation and no error limit: no failure hides another. A
 * resource limit instead of a time limit: the same proof gives the same answer
 * on any machine. In this repository and its example, the most any proved
 * assertion needs is 14.2 million (the example tracker's step, through its
 * generated body); every other one needs under 1.3 million. 30 million leaves
 * twice the largest. The time limit only stops a run that would never end.
 */
export const RESOURCE_LIMIT = 30_000_000;
const DAFNY_FLAGS = ["--isolate-assertions", "--error-limit", "0", "--resource-limit", String(RESOURCE_LIMIT)];
const TIME_LIMIT = 600;

// --- running tools -------------------------------------------------------------

/** An executable from the toolchain's dependencies, wherever npm put it: beside the tools, or in the project. */
export function bin(cmd: string, root: string): string {
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

export function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const exe = cmd === "dafny" ? cmd : bin(cmd, cwd);
  const r = spawnSync(exe, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ?? ""}` };
}

// --- proof files ---------------------------------------------------------------

/**
 * Words a proof file may not use. Each declares something other than a lemma,
 * asks Dafny to trust or skip something, or reaches outside the unit.
 */
const FORBIDDEN = new Set(`
  assume expect include import module abstract refines extern function predicate method constructor datatype
  codatatype type newtype const class trait iterator opaque ghost twostate least greatest static export provides
  reveals print modify modifies reads axiom verify colemma inductive
`.split(/\s+/).filter(Boolean));
const ATTRIBUTES = new Set(["trigger", "induction"]);

const STRING = /"(?:[^"\\\n]|\\.)*"/y;

interface Token { t: string; kind: "word" | "open" | "attr" | "close" | "other"; at: number; end: number; line: number }

/**
 * Dafny's tokens, as far as they matter here: comments and whitespace dropped,
 * strings kept whole, `{:` attributes told apart from braces. With `refuse`,
 * anything a proof file may not contain is refused where it appears.
 */
function tokenize(text: string, refuse?: (line: number, why: string) => never): Token[] {
  const out: Token[] = [];
  let line = 1;
  for (let i = 0; i < text.length; ) {
    const rest = text.slice(i, i + 200);
    const ch = text[i];
    if (refuse && /[\r\v\f\u0085\u2028\u2029]/.test(ch)) refuse(line, "line breaks other than \\n are not allowed");
    if (ch === "\n") { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (rest.startsWith("//")) {
      const e = text.indexOf("\n", i);
      const comment = text.slice(i, e < 0 ? text.length : e);
      if (refuse && /[\r\v\f\u0085\u2028\u2029]/.test(comment)) refuse(line, "line breaks other than \\n are not allowed");
      i = e < 0 ? text.length : e;
      continue;
    }
    const push = (kind: Token["kind"], t: string) => { out.push({ t, kind, at: i, end: i + t.length, line }); i += t.length; };
    if (ch === '"') {
      STRING.lastIndex = i;
      const m = STRING.exec(text);
      if (!m) { if (refuse) refuse(line, "a string is not closed on its line"); push("other", ch); continue; }
      push("other", m[0]);
      continue;
    }
    if (refuse) {
      if (rest.startsWith("/*")) refuse(line, "block comments are not allowed; use //");
      if (ch === "@") refuse(line, "`@` is not allowed: attributes and verbatim strings could change what is checked");
      if (ch === "'") refuse(line, "character literals are not allowed");
      if (/[^\x20-\x7e]/.test(ch)) refuse(line, "outside comments and strings only ASCII is allowed");
    }
    const attr = rest.match(/^\{\s*:\s*([A-Za-z_]\w*)?/);
    if (attr) {
      if (refuse && !ATTRIBUTES.has(attr[1] ?? "")) refuse(line, `the attribute {:${attr[1] ?? ""}} is not allowed; only ${[...ATTRIBUTES].map((a) => `{:${a}}`).join(" and ")}`);
      push("attr", attr[0]);
      continue;
    }
    if (ch === "{") { push("open", ch); continue; }
    if (ch === "}") { push("close", ch); continue; }
    const word = rest.match(/^[A-Za-z_][\w'?]*/);
    if (word) {
      if (refuse && FORBIDDEN.has(word[0])) refuse(line, `\`${word[0]}\` is not allowed in a proof file`);
      push("word", word[0]);
      continue;
    }
    push("other", ch);
  }
  return out;
}

/** One lemma of a proof file. */
export interface Lemma { name: string; line: number; header: string; headerText: string; body: string; text: string }

/**
 * A proof file holds only `lemma` declarations, each with a body, and `//`
 * comments. Anything else is refused with the file and line.
 */
export function parseProofFile(source: string, file: string): Lemma[] {
  const text = source.replace(/\r\n/g, "\n");
  const refuse = (line: number, why: string): never => { throw new Error(`${file}:${line}: ${why}`); };
  const toks = tokenize(text, refuse);
  const lemmas: Lemma[] = [];
  for (let p = 0; p < toks.length; ) {
    const start = toks[p];
    if (start.kind === "close") refuse(start.line, "unbalanced braces: this } closes nothing");
    if (start.t !== "lemma") refuse(start.line, `only \`lemma\` declarations and // comments may appear at the top level, not \`${start.t}\``);
    let q = p + 1;
    // Attributes may come before the name.
    for (let depth = 0; toks[q] && (toks[q].kind === "attr" || depth > 0); q++) {
      if (toks[q].kind === "attr" || toks[q].kind === "open") depth++;
      else if (toks[q].kind === "close") depth--;
    }
    const name = toks[q]?.kind === "word" ? toks[q].t : refuse(start.line, "a lemma needs a name");
    // The body is the first brace that is not an attribute's.
    let open = -1;
    for (let r = q + 1, depth = 0; r < toks.length && open < 0; r++) {
      const k = toks[r];
      if (k.kind === "attr") depth++;
      else if (k.kind === "close") { if (--depth < 0) refuse(k.line, `lemma ${name}: unbalanced braces`); }
      else if (k.kind === "open" && depth === 0) open = r;
      else if (k.t === "lemma" && depth === 0) break;
    }
    if (open < 0) refuse(start.line, `lemma ${name} has no body; every lemma must be proved`);
    let close = -1;
    for (let r = open, depth = 0; r < toks.length; r++) {
      if (toks[r].kind === "open" || toks[r].kind === "attr") depth++;
      else if (toks[r].kind === "close" && --depth === 0) { close = r; break; }
    }
    if (close < 0) refuse(toks[open].line, `lemma ${name}: unbalanced braces, its body is never closed`);
    if (lemmas.some((l) => l.name === name)) refuse(start.line, `lemma ${name} is declared twice`);
    lemmas.push({
      name, line: start.line,
      header: toks.slice(p, open).map((t) => t.t).join(" "),
      headerText: text.slice(start.at, toks[open].at).replace(/\s+/g, " ").trim(),
      body: text.slice(toks[open].end, toks[close].at),
      text: text.slice(start.at, toks[close].end),
    });
    p = close + 1;
  }
  return lemmas;
}

const DECLARATION = /^\s*(?:ghost\s+)?(?:function|predicate|lemma|method|datatype|codatatype|type|newtype|const|class|trait|module)\s+(?:\{:[^}]*\}\s*)*([A-Za-z_][\w']*)/;

/** Every name a Dafny text declares at the top level, constructors of its datatypes included. */
export function declaredNames(dfy: string): Set<string> {
  const names = new Set<string>();
  for (const line of dfy.split("\n")) {
    if (/^\s/.test(line)) continue; // inside a declaration or a module
    const m = line.match(DECLARATION);
    if (m) names.add(m[1]);
    const data = line.match(/^(?:co)?datatype\s+\w+(?:<[^>]*>)?\s*=(.*)$/);
    if (data) for (const c of data[1].matchAll(/(?:^|\|)\s*([A-Za-z_][\w']*)/g)) names.add(c[1]);
  }
  return names;
}

/** The generated `<fn>_ensures` lemmas with an empty body: where each one's header ends, and its tokens. */
function emptyLemmas(gen: string): Map<string, { bodyAt: number; header: string; headerText: string }> {
  const found = new Map<string, { bodyAt: number; header: string; headerText: string }>();
  for (const m of gen.matchAll(/^lemma (\w+_ensures)\([^\n]*\n(?:(?!\{\n)[^\n]*\n)*?(?=\{\n\}\n)/gm))
    found.set(m[1], { bodyAt: m.index + m[0].length, header: tokenize(m[0]).map((t) => t.t).join(" "), headerText: m[0].replace(/\s+/g, " ").trim() });
  return found;
}

export interface Additions {
  /** The unit's proof file, if it has one: where it is, and its text. */
  proof?: { file: string; text: string };
  /** The body the tools give `step_ensures` when the proof file does not. */
  stepBody?: string;
  /** Lemmas the tools add: laws of dependencies proved in their own units. */
  axioms: string[];
  /** The library, added when there is a proof file. */
  lib?: string;
}

/**
 * The final Dafny for a unit: what LemmaScript generated, with the bodies the
 * proof file supplies inside the empty generated lemmas, and after it the
 * tools' lemmas, the proof file's helpers and the library. Only lines are
 * added; nothing generated changes.
 */
export function splice(gen: string, { proof, stepBody, axioms, lib }: Additions, where = "gen/proof/<unit>/<unit>.dfy"): string {
  const lemmas = proof ? parseProofFile(proof.text, proof.file) : [];
  const empty = emptyLemmas(gen);
  const bodies = new Map<string, string>();
  const helpers: string[] = [];
  const taken = declaredNames([gen, ...axioms].join("\n"));
  taken.add(LIB_MODULE);
  for (const l of lemmas) {
    const generated = empty.get(l.name);
    if (generated) {
      if (generated.header !== l.header)
        throw new Error(`${proof!.file}:${l.line}: lemma ${l.name} does not repeat its generated header, so it is refused as stale; copy the header again from ${where}\n  generated: ${generated.headerText}\n  yours:     ${l.headerText}`);
      bodies.set(l.name, l.body.replace(/^[ \t]*\n/, "").trimEnd());
    } else if (taken.has(l.name)) {
      throw new Error(`${proof!.file}:${l.line}: lemma ${l.name}: the name is already declared in ${where}; a helper needs a name of its own`);
    } else helpers.push(l.text);
  }
  if (stepBody && empty.has("step_ensures") && !bodies.has("step_ensures")) bodies.set("step_ensures", stepBody);
  let out = gen;
  for (const [name, { bodyAt }] of [...empty].sort((a, b) => b[1].bodyAt - a[1].bodyAt)) {
    const body = bodies.get(name);
    if (body) out = `${out.slice(0, bodyAt)}{\n${body}\n${out.slice(bodyAt + 2)}`;
  }
  const tail = [
    ...(axioms.length ? ["// ---- laws of the units this one imports, each proved in its own unit (added by the tools) ----", ...axioms] : []),
    ...(helpers.length ? [`// ---- helpers from ${proof!.file} ----`, ...helpers] : []),
    ...(lib ? ["// ---- tools/proof/lib.dfy ----", lib.trimEnd()] : []),
  ];
  return tail.length ? `${out.trimEnd()}\n\n${tail.join("\n\n")}\n` : out;
}

/** The lemma that makes a dependency's law usable here: `<fn>` is how this unit spells the law. */
export function lawAxiom(gen: string, fn: string): string | undefined {
  const m = gen.match(new RegExp(`^function ${fn}\\(([^\\n]*)\\): bool\\n\\{`, "m"));
  if (!m) return undefined;
  const args = [...m[1].matchAll(/(?:^|,\s*)(\w+)\s*:/g)].map((a) => a[1]);
  return `lemma {:axiom} ${fn}_ensures(${m[1]})\n  ensures ${fn}(${args.join(", ")}) == true`;
}

// --- reading what Dafny said -----------------------------------------------------

interface Verdict { unproved: Map<string, string>; exhausted: Set<string>; errors: Set<string>; failing: Map<string, Set<number>> }

/**
 * Sort Dafny's messages about `file` into obligations not proved (keyed by
 * definition and clause), obligations it ran out of resources on, and errors.
 * A failure in a definition the generated code does not declare (a helper, the
 * library, a lemma the tools add) is an error: the proof itself is broken.
 */
function readVerdict(out: string, dfy: string, file: string, generated: Set<string>, rename = (n: string) => n): Verdict {
  const lines = out.split("\n");
  const source = dfy.split("\n");
  const owner = (line: number) => {
    for (let i = line - 1; i >= 0; i--) {
      const m = source[i]?.match(/^\s*(?:ghost\s+)?(?:lemma|method|function|predicate)\s+(?:\{:[^}]*\}\s*)*(\w+)/);
      if (m) return rename(m[1]);
    }
    return "?";
  };
  const at = (l: string) => {
    const m = l.match(new RegExp(`^(?:.*/)?${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\((\\d+),\\d+\\): (Error|Warning|Related location): (.*)$`));
    return m && { line: Number(m[1]), kind: m[2], what: m[3] };
  };
  const clause = (line: number) => (source[line - 1] ?? "").trim().replace(/^ensures\s+/, "");
  const key = (line: number, text: string) => `${owner(line).replace(/_ensures$/, "")}: ${text}`;
  const v: Verdict = { unproved: new Map(), exhausted: new Set(), errors: new Set(), failing: new Map() };
  const fail = (line: number, text: string, exhausted: boolean) => {
    const def = owner(line);
    if (!generated.has(def)) { v.errors.add(`${def} (${file}:${line}) does not verify: ${text}; a lemma that is not generated must prove`); return; }
    const k = key(line, text);
    v.unproved.set(k, def);
    if (exhausted) v.exhausted.add(k);
    if (!v.failing.has(def)) v.failing.set(def, new Set());
    v.failing.get(def)!.add(line);
  };
  lines.forEach((l, i) => {
    const m = at(l);
    if (!m) {
      if (/^Error:|: Error:/.test(l) && !l.includes(file)) v.errors.add(l.trim());
      return;
    }
    if (m.kind === "Error" && m.what.startsWith("a postcondition could not be proved")) {
      const related = lines.slice(i + 1, i + 12).map(at).find((r) => r?.kind === "Related location" && r.what.includes("postcondition"));
      if (related) fail(related.line, clause(related.line), false);
      else v.errors.add(`${m.what}: ${clause(m.line)}`);
    } else if (m.kind === "Error" && /out of resource|timed out/.test(m.what)) {
      const text = source[m.line - 1]?.trim() ?? "";
      fail(m.line, text.startsWith("ensures") ? clause(m.line) : "the prover ran out of resources", true);
    } else if (m.kind === "Error") v.errors.add(`${owner(m.line)}: ${m.what}: ${clause(m.line)}`);
    else if (m.kind === "Warning") v.errors.add(`${owner(m.line)}: ${m.what}`);
  });
  return v;
}

const verifyArgs = (dfy: string) => ["verify", ...(dfy.includes("Std.") ? ["--standard-libraries"] : []), "--unicode-char:true", ...DAFNY_FLAGS, "--verification-time-limit", String(TIME_LIMIT)];
const finished = (out: string) => /\d+ verified, \d+ errors?/.test(out);

/**
 * A postcondition that fails is assumed while the later ones of the same
 * definition are checked, so those may pass only because of it. Check each of
 * them again in a copy of the definition that has it as its only postcondition.
 */
function recheck(dir: string, dfy: string, file: string, generated: Set<string>, failing: Map<string, Set<number>>): { verdict: Verdict; log: string } | undefined {
  const lines = dfy.split("\n");
  let prefix = "isolated";
  while (dfy.includes(prefix)) prefix = `x${prefix}`;
  const copies: string[] = [];
  const copyOf = new Map<string, string>();
  for (const [def, failed] of failing) {
    const start = lines.findIndex((l) => new RegExp(`^(lemma|method) ${def}\\b`).test(l));
    const open = lines.findIndex((l, i) => i > start && l === "{");
    if (start < 0 || open < 0) continue;
    const ensures = lines.slice(start + 1, open).map((l, i) => [l, start + 2 + i] as const).filter(([l]) => /^\s*ensures\b/.test(l));
    if (ensures.length < 2) continue;
    const body = tokenize(lines.slice(open).join("\n"));
    let depth = 0;
    const close = body.find((t) => (t.kind === "open" || t.kind === "attr" ? (depth++, false) : t.kind === "close" ? --depth === 0 : false));
    if (!close) continue;
    const bodyText = lines.slice(open).join("\n").slice(0, close.end);
    for (const [, line] of ensures) {
      if (failed.has(line)) continue;
      const name = `${prefix}${copies.length}_${def}`;
      copyOf.set(name, def);
      const header = lines.slice(start, open).filter((l, i) => !/^\s*ensures\b/.test(l) || start + 1 + i === line);
      copies.push([header[0].replace(new RegExp(`\\b${def}\\b`), name), ...header.slice(1), bodyText].join("\n"));
    }
  }
  if (!copies.length) return undefined;
  const derived = `${dfy.trimEnd()}\n\n${copies.join("\n\n")}\n`;
  const name = file.replace(/\.dfy$/, ".isolated.dfy");
  fs.writeFileSync(path.join(dir, name), derived);
  const { out } = run("dafny", [...verifyArgs(derived), "--filter-symbol", prefix, name], dir);
  const verdict = readVerdict(out, derived, name, new Set([...generated, ...copyOf.keys()]), (n) => copyOf.get(n) ?? n);
  if (!finished(out)) verdict.errors.add(`the postconditions checked one by one gave no verdict: ${out.trim().split("\n").slice(-3).join(" / ")}`);
  return { verdict, log: out };
}

/** Findings of `dafny audit` in the unit's own file, other than the lemmas the tools add on purpose. */
function audit(dir: string, dfy: string, file: string, allowed: Set<string>): { findings: string[]; log: string } {
  const { out } = run("dafny", ["audit", ...(dfy.includes("Std.") ? ["--standard-libraries"] : []), "--unicode-char:true", file], dir);
  const findings = out.split("\n").filter((l) => l.startsWith(`${file}(`) && /: (Warning|Error): /.test(l))
    .filter((l) => !/: Warning: (\w+): Declaration has explicit `\{:axiom\}` attribute/.test(l) || !allowed.has(l.match(/: Warning: (\w+):/)![1]));
  if (!/Dafny auditor completed/.test(out)) findings.push(`dafny audit gave no verdict: ${out.trim().split("\n").slice(-3).join(" / ")}`);
  return { findings: findings.map((f) => `dafny audit: ${f}`), log: out };
}

// --- one unit --------------------------------------------------------------------

export interface Proof {
  total: number;
  /** Obligations not proved, as `<definition>: <clause>`. */
  unproved: string[];
  /** Of those, the ones the prover ran out of resources on. */
  exhausted: string[];
  errors: string[];
  log: string;
  /** The final Dafny, as it was verified. */
  dfy: string;
}

export interface Unit {
  unit: string;
  text: string;
  /** spec/<name>.proof.dfy or src/<path>.proof.dfy, relative to the project. */
  proofFile: string;
  /** Laws of the units this one imports, as this unit spells them, and the unit that proves each. */
  laws: { fn: string; law: string; from: string }[];
  /** The units whose assurance this one's rests on. */
  rests: string[];
  /** For a state machine: its transitions and how many parameters each takes after the state. */
  transitions?: { name: string; params: number }[];
}

/**
 * The body the tools give step_ensures: each event is covered by its
 * transition's own lemma. Constructors are read from the generated Event type,
 * which spells a name that is a Dafny keyword differently; undefined if the
 * generated text is not as expected.
 */
export function stepBody(gen: string, transitions: { name: string; params: number }[]): string | undefined {
  const event = gen.match(/^datatype Event = (.*)$/m);
  const constructors = event ? event[1].split("|").map((c) => c.trim().match(/^(\w+)/)?.[1] ?? "") : [];
  if (constructors.length !== transitions.length) return undefined;
  const cases = transitions.map(({ name, params }, i) => {
    if (!new RegExp(`^lemma ${name}_ensures\\(`, "m").test(gen)) return undefined;
    const bound = Array.from({ length: params }, (_, j) => `i_event_${j}`);
    return `    case ${constructors[i]}${params ? `(${bound.join(", ")})` : ""} => ${name}_ensures(${["current", ...bound].join(", ")});`;
  });
  return cases.every(Boolean) ? ["  match event {", ...cases, "  }"].join("\n") : undefined;
}

/** Prove one unit in a directory of its own, so that nothing left over from another run or project can vouch for it. */
export function prove(root: string, u: Unit, offered: { proof?: { file: string; text: string }; lib?: string; laws: string[] }): Proof {
  const dir = path.join(root, "gen/proof", u.unit.replace(/\.ts$/, ""));
  const base = u.unit.replace(/\.ts$/, "");
  const file = `${base}.dfy`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, u.unit), u.text);
  // A configuration of our own, so that one further up cannot redirect the proof or relax it.
  fs.writeFileSync(path.join(dir, "lemmascript.json"), JSON.stringify({ "unread-annotations": "error", "run-log": false }));
  const total = (u.text.match(/^\s*\/\/@ (ensures|invariant) /gm) ?? []).length;
  const result = (errors: string[], log: string, dfy = ""): Proof => ({ total, unproved: [], exhausted: [], errors, log, dfy });
  const generated = run("lsc", ["gen", "--backend=dafny", u.unit], dir);
  const genFile = path.join(dir, `${file}.gen`);
  if (!generated.ok || !fs.existsSync(genFile)) return result([generated.out.trim().split("\n").slice(-3).join(" / ") || "lsc generated nothing"], generated.out);
  const gen = fs.readFileSync(genFile, "utf8");
  // Laws proved elsewhere, and the library, are only of use to a proof file.
  const axioms = offered.proof ? offered.laws.flatMap((fn) => lawAxiom(gen, fn) ?? []) : [];
  const axiomNames = new Set(axioms.map((a) => a.match(/^lemma \{:axiom\} (\w+)/)![1]));
  let dfy: string;
  try {
    dfy = splice(gen, { proof: offered.proof, lib: offered.proof && offered.lib, axioms, stepBody: u.transitions && stepBody(gen, u.transitions) }, `gen/proof/${base}/${file}`);
  } catch (e) {
    return result([(e as Error).message], generated.out);
  }
  fs.writeFileSync(path.join(dir, file), dfy);
  // LemmaScript keeps this .dfy, refuses it unless it is its own fresh output plus added lines, and runs Dafny.
  const checked = run("lsc", ["check", "--backend=dafny", `--time-limit=${TIME_LIMIT}`, `--extra-flags=${DAFNY_FLAGS.join(" ")}`, u.unit], dir);
  let log = `${generated.out}${checked.out}`;
  const declared = declaredNames(gen);
  const v = readVerdict(checked.out, dfy, file, declared);
  // The verdict is Dafny's own summary; without it, or with anything left unexplained, the unit was not checked.
  if (!v.errors.size && (!finished(checked.out) || (!checked.ok && !v.unproved.size))) v.errors.add(checked.out.trim().split("\n").slice(-3).join(" / ") || "lsc produced no verdict");
  if (!v.errors.size && v.failing.size) {
    const again = recheck(dir, dfy, file, declared, v.failing);
    if (again) {
      log += `\n---- each postcondition of a definition with a failure, checked on its own ----\n${again.log}`;
      for (const [k, def] of again.verdict.unproved) v.unproved.set(k, def);
      for (const k of again.verdict.exhausted) v.exhausted.add(k);
      for (const e of again.verdict.errors) v.errors.add(e);
    }
  }
  if (offered.proof) {
    const audited = audit(dir, dfy, file, axiomNames);
    log += `\n---- dafny audit ----\n${audited.log}`;
    for (const f of audited.findings) v.errors.add(f);
  }
  return { total, unproved: [...v.unproved.keys()], exhausted: [...v.exhausted], errors: [...v.errors], log, dfy };
}
