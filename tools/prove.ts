// The proof stage for one unit: LemmaScript turns the unit's TypeScript into
// Dafny, the tools add what they generate and what the unit's proof file
// supplies, LemmaScript checks that nothing generated was changed, Dafny
// verifies the result, and `dafny audit` checks that nothing added is trusted
// rather than proved.
//
// Counting is per obligation. Dafny first verifies each definition as a whole,
// which is all a definition that proves needs. Each definition with a failure
// is then verified again with every assertion isolated and no error limit, so
// that no failure hides another. Because a postcondition that fails is still
// assumed while the ones after it are checked, every later postcondition of a
// definition with a failure is checked again on its own. A lemma that calls a
// lemma with a failing postcondition assumes it, so every obligation of such a
// lemma is counted as not proved too.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The library of general lemmas that proof files call as ProofLib.<Name>. */
export const LIB_FILE = path.join(import.meta.dirname, "proof", "lib.dfy");
/** The one name the library adds to a unit. */
export const LIB_MODULE = "ProofLib";
/**
 * How Dafny is run. No error limit: no failure hides another. A resource limit
 * instead of a time limit: the same proof gives the same answer on any machine
 * with the same solver, which is why the solver is named explicitly and is part
 * of what a remembered verdict was produced by. The limit applies to each batch
 * Dafny hands the solver: a whole definition at first, one assertion when a
 * definition with a failure is verified again. 30 million is about twice what
 * the largest proved batch in this repository and its examples needs. The time
 * limit only stops a run that would never end. Source lines are not echoed: a
 * proof file's text must never be read back as one of Dafny's own messages.
 */
export const RESOURCE_LIMIT = 30_000_000;
const DAFNY_FLAGS = ["--error-limit", "0", "--resource-limit", String(RESOURCE_LIMIT), "--show-snippets:false"];
/** Verify every assertion in a batch of its own, to say which ones fail. */
const ISOLATED = ["--isolate-assertions"];
const TIME_LIMIT = 600;

// --- running tools -------------------------------------------------------------

export const WINDOWS = process.platform === "win32";
/** The most output a tool may write before it is stopped. */
export const OUTPUT_LIMIT = 1 << 28;
/** How long a tool may run before it is stopped: long enough that only a tool that hangs is stopped. */
export const TOOL_TIMEOUT = 60 * 60 * 1000;

/** An executable from the toolchain's dependencies, wherever npm put it: beside the tools, or in the project. */
export function bin(cmd: string, root: string): string {
  // On Windows npm installs a `.cmd` shim beside the extensionless shell script, and only the shim runs there.
  const name = WINDOWS ? `${cmd}.cmd` : cmd;
  for (let dir of [path.join(import.meta.dirname, ".."), root]) {
    for (;;) {
      const candidate = path.join(dir, "node_modules/.bin", name);
      if (fs.existsSync(candidate)) return candidate;
      if (dir === path.dirname(dir)) break;
      dir = path.dirname(dir);
    }
  }
  throw new Error(`${cmd} is not installed; run npm install`);
}

/** How to start a tool: Dafny from the PATH, anything else from the toolchain's dependencies; a .cmd shim needs a shell, and then every argument is quoted for cmd.exe. */
function launch(cmd: string, args: string[], cwd: string): { exe: string; file: string; args: string[]; shell: boolean } {
  const exe = cmd === "dafny" ? cmd : bin(cmd, cwd);
  const shell = WINDOWS && exe.endsWith(".cmd");
  const quote = (a: string) => (a === "" || /[\s"&|<>^%()!,;=]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  return shell ? { exe, file: quote(exe), args: args.map(quote), shell } : { exe, file: exe, args, shell };
}
const cannotRun = (cmd: string, exe: string, e: Error) =>
  `${cmd} could not be run (${exe}): ${e.message}${cmd === "dafny" ? "; the proof stage needs Dafny 4.11 on the PATH" : "; run npm install"}`;
const tooMuch = (cmd: string) => `${cmd} wrote more than ${OUTPUT_LIMIT / 2 ** 20} MB of output and was stopped`;
const tooLong = (cmd: string) => `${cmd} ran for more than ${TOOL_TIMEOUT / 60_000} minutes and was stopped`;

/**
 * Run a tool to the end and return what it wrote. A tool that cannot be started is an error; one that writes too
 * much or runs too long is stopped, and its output says so.
 */
export function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const t = launch(cmd, args, cwd);
  const r = spawnSync(t.file, t.args, { cwd, encoding: "utf8", maxBuffer: OUTPUT_LIMIT, timeout: TOOL_TIMEOUT, shell: t.shell });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const stopped = code === "ENOBUFS" ? tooMuch(cmd) : code === "ETIMEDOUT" ? tooLong(cmd) : undefined;
  if (r.error && !stopped) throw new Error(cannotRun(cmd, t.exe, r.error));
  return { ok: r.status === 0 && !stopped, out: `${r.stdout ?? ""}${r.stderr ?? ""}${stopped ? `\n${stopped}\n` : ""}` };
}

/**
 * Overlapping runs, at most one core's worth per core across everything in this process (several checks at once
 * included). A run that uses several cores, as Dafny does, takes as many slots; runs start in the order they asked.
 */
const CORES = Math.max(1, os.availableParallelism());
const slots = { free: CORES, waiting: [] as { n: number; go: () => void }[] };
function acquire(want: number): Promise<number> {
  const n = Math.min(Math.max(1, Math.floor(want)), CORES);
  if (!slots.waiting.length && slots.free >= n) { slots.free -= n; return Promise.resolve(n); }
  return new Promise((go) => slots.waiting.push({ n, go: () => go(n) }));
}
function release(n: number) {
  slots.free += n;
  while (slots.waiting.length && slots.free >= slots.waiting[0].n) { const next = slots.waiting.shift()!; slots.free -= next.n; next.go(); }
}
/** The cores one Dafny verification may use, and the slots it takes. */
export const DAFNY_CORES = Math.min(4, CORES);

/**
 * `run`, without blocking, so that independent runs can overlap; `cores` is how many slots of the pool the run
 * takes. A tool that cannot be started, writes too much or runs too long is stopped, and its output says so; its
 * slots are given back whatever happens.
 */
export async function runAsync(cmd: string, args: string[], cwd: string, { cores = 1, env }: { cores?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; out: string }> {
  const t = launch(cmd, args, cwd);
  const held = await acquire(cores);
  try {
    return await new Promise((resolve) => {
      let out = "";
      let stopped: string | undefined;
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (ok: boolean, extra = "") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: ok && !stopped, out: `${out}${extra}${stopped ? `\n${stopped}\n` : ""}` });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(t.file, t.args, { cwd, shell: t.shell, env: env ?? process.env });
      } catch (e) {
        finish(false, cannotRun(cmd, t.exe, e as Error));
        return;
      }
      const stop = (why: string) => { if (!stopped) { stopped = why; child.kill(); } };
      timer = setTimeout(() => stop(tooLong(cmd)), TOOL_TIMEOUT);
      const take = (d: string) => { if (stopped) return; if (out.length + d.length > OUTPUT_LIMIT) stop(tooMuch(cmd)); else out += d; };
      child.stdout!.setEncoding("utf8").on("data", take);
      child.stderr!.setEncoding("utf8").on("data", take);
      child.on("error", (e) => finish(false, `\n${cannotRun(cmd, t.exe, e)}\n`));
      child.on("close", (status) => finish(status === 0));
    });
  } finally {
    release(held);
  }
}

/**
 * The solver Dafny is to use, found once: the one bundled with Dafny if there is one, else the first `z3` on the
 * PATH, which is where Dafny itself would look. It is passed to Dafny by its path, and its version is part of what
 * a remembered verdict was produced by: whether a proof stays within the resource limit depends on the solver.
 */
let found: { path?: string; version?: string; note?: string; problem?: string } | undefined;
export const SOLVERS_DAFNY_SUPPORTS = ["4.12.1", "4.8.5"];
export function solver(): { path?: string; version?: string; note?: string; problem?: string } {
  if (found) return found;
  const exts = WINDOWS ? [".exe", ".cmd", ""] : [""];
  const onPath = (name: string) => {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean))
      for (const ext of exts) {
        const f = path.join(dir, name + ext);
        try { if (fs.statSync(f).isFile()) return f; } catch { /* not here */ }
      }
    return undefined;
  };
  const candidates: string[] = [];
  const dafny = onPath("dafny");
  if (dafny) {
    // Dafny looks beside its own assembly, which a package manager may keep in libexec behind a script.
    const real = fs.realpathSync(dafny);
    for (const dir of [path.dirname(real), path.join(path.dirname(real), "..", "libexec")]) {
      const z3 = path.join(dir, "z3", "bin");
      const names = fs.existsSync(z3) ? fs.readdirSync(z3).filter((f) => /^z3(-\d+(\.\d+)*)?(\.exe)?$/.test(f)) : [];
      const rank = (f: string) => { const i = SOLVERS_DAFNY_SUPPORTS.findIndex((v) => f.includes(v)); return i < 0 ? SOLVERS_DAFNY_SUPPORTS.length : i; };
      candidates.push(...names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((f) => path.join(z3, f)));
    }
  }
  const z3 = onPath("z3");
  if (z3) candidates.push(z3);
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 60_000 });
    const version = (r.stdout ?? "").match(/Z3 version (\d+\.\d+\.\d+)/)?.[1];
    if (!version) continue;
    const note = SOLVERS_DAFNY_SUPPORTS.includes(version) ? undefined
      : `z3 ${version} (${c}) is not a version Dafny 4.11 is tested with (${SOLVERS_DAFNY_SUPPORTS.join(", ")}); a proof near the resource limit may come out differently with another solver`;
    return (found = { path: c, version, note });
  }
  return (found = { problem: `no z3 was found beside Dafny or on the PATH${candidates.length ? ` (none of ${candidates.join(", ")} said its version)` : ""}: the proof stage needs the solver Dafny uses` });
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
  // With `refuse`, the text has passed plainText: `\n` is its only line break.
  const out: Token[] = [];
  let line = 1;
  for (let i = 0; i < text.length; ) {
    const rest = text.slice(i, i + 200);
    const ch = text[i];
    if (ch === "\n") { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (rest.startsWith("//")) {
      const e = text.indexOf("\n", i);
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

/**
 * A text with `\n` as its only line break (a `\r\n` is read as one) and no NUL, or an error that names the file and
 * line. Readers may disagree on where a line ends at any other break, so what a reviewer sees could differ from what
 * the compiler reads, anywhere in the file: in code, in a comment and in a string.
 */
export function plainText(file: string, source: string): string {
  const text = source.replace(/\r\n/g, "\n");
  const odd = text.search(/[\0\r\v\f\u0085\u2028\u2029]/);
  if (odd >= 0) throw new Error(`${file}:${text.slice(0, odd).split("\n").length}: ${text[odd] === "\0" ? "NUL characters are not allowed" : "line breaks other than \\n are not allowed"}`);
  return text;
}

/** One lemma of a proof file. */
export interface Lemma { name: string; line: number; header: string; headerText: string; body: string; text: string }

/**
 * Words after which a brace starts an operand, such as the set display in `decreases {0}` or `x in {1}`, never a
 * body. A brace starts a lemma's body only after a token that can end a header: `)`, `]`, `}`, a number, a string
 * or any other word.
 */
const OPERAND_AFTER = new Set("in requires ensures decreases then else returns by set iset multiset seq map imap calc assert var if match case forall exists old fresh reveal lemma".split(" "));
// A `|` right before the body can only close a cardinality, as in `decreases |xs|`.
const endsHeader = (t: Token | undefined) => !!t && (t.kind === "close" || t.t === ")" || t.t === "]" || t.t === "|" || /^[0-9"]/.test(t.t) || (t.kind === "word" && !OPERAND_AFTER.has(t.t)));

/**
 * A proof file holds only `lemma` declarations, each with a body, and `//`
 * comments. Anything else is refused with the file and line. A lemma runs to
 * the next `lemma`; its body is the brace group it ends with, which must follow
 * a complete header.
 */
export function parseProofFile(source: string, file: string): Lemma[] {
  const text = plainText(file, source);
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
    // Where the last brace group at the top level of the lemma opens; any other token at the top level resets it.
    let open = -1;
    let end = q + 1;
    let depth = 0;
    for (; end < toks.length && toks[end].t !== "lemma"; end++) {
      const k = toks[end];
      if (k.kind === "open" || k.kind === "attr") { if (depth++ === 0) open = k.kind === "open" ? end : -1; }
      else if (k.kind === "close") { if (--depth < 0) refuse(k.line, "unbalanced braces: this } closes nothing"); }
      else if (depth === 0) open = -1;
    }
    if (depth > 0) refuse(start.line, `lemma ${name}: unbalanced braces, its body is never closed`);
    if (open < 0 || !endsHeader(toks[open - 1])) refuse(start.line, `lemma ${name} has no body; every lemma must be proved, and end with its body`);
    if (lemmas.some((l) => l.name === name)) refuse(start.line, `lemma ${name} is declared twice`);
    const close = end - 1;
    lemmas.push({
      name, line: start.line,
      header: toks.slice(p, open).map((t) => t.t).join(" "),
      headerText: text.slice(start.at, toks[open].at).replace(/\s+/g, " ").trim(),
      body: text.slice(toks[open].end, toks[close].at),
      text: text.slice(start.at, toks[close].end),
    });
    p = end;
  }
  return lemmas;
}

/** Each dotted name a Dafny text uses, such as `Std.Collections.Seq.All`, from its first word; comments and strings are not names. */
function dottedNames(toks: Token[]): { name: string; first: Token; inner: boolean }[] {
  const out: { name: string; first: Token; inner: boolean }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const inner = toks[i - 1]?.t === ".";
    if (toks[i].kind !== "word" || (inner && toks[i - 2]?.kind === "word")) continue;
    const parts = [toks[i].t];
    for (let j = i; toks[j + 1]?.t === "." && toks[j + 2]?.kind === "word"; j += 2) parts.push(toks[j + 2].t);
    out.push({ name: parts.join("."), first: toks[i], inner });
  }
  return out;
}

/**
 * A proof file may reach Dafny's standard library only by a name the generated
 * code itself uses, since the library holds axioms, and the library of the
 * tools only by the lemmas and functions it declares.
 */
function checkNames(proof: { file: string; text: string }, gen: string, lib: string | undefined) {
  const used = new Set(dottedNames(tokenize(gen)).map((d) => d.name));
  const own = new Set([...(lib ?? "").matchAll(/^\s*(?:ghost\s+)?(?:lemma|function|predicate)\s+(\w+)/gm)].map((m) => m[1]));
  for (const d of dottedNames(tokenize(proof.text.replace(/\r\n/g, "\n")))) {
    const parts = d.name.split(".");
    const at = `${proof.file}:${d.first.line}`;
    const misplaced = parts.find((p, i) => (i > 0 || d.inner) && (p === "Std" || p === LIB_MODULE));
    if (misplaced) throw new Error(`${at}: \`${misplaced}\` may only begin a name`);
    const std = [...used].filter((n) => n.startsWith("Std."));
    if (parts[0] === "Std" && !used.has(d.name))
      throw new Error(`${at}: \`${d.name}\` is not allowed: Dafny's standard library holds axioms, so a proof file may use only the names of it that the generated code uses${std.length ? ` (${std.join(", ")})` : ", and it uses none"}`);
    if (parts[0] === LIB_MODULE && !(parts.length === 2 && own.has(parts[1])))
      throw new Error(`${at}: \`${d.name}\` is not a lemma or function of tools/proof/lib.dfy; call those as ${LIB_MODULE}.<Name>`);
  }
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
 * A definition of the final Dafny, as the tools placed it: one generated by
 * LemmaScript (with any body the proof file supplied), or one added after the
 * generated text (a law of a dependency, a helper, the library).
 */
export interface Region { def: string; generated: boolean; /** One of LemmaScript's own helpers, which the unit did not write. */ prelude?: boolean }
/** The final Dafny, and for each of its lines (line n at index n - 1) the definition it belongs to. */
export interface Spliced { dfy: string; regions: Region[] }

/** A line of generated Dafny that starts a definition, and its name. */
const DEFINITION = /^\s*(?:ghost\s+)?(?:lemma|method|function|predicate)\s+(?:\{:[^}]*\}\s*)*(\w+)/;

/**
 * The final Dafny for a unit: what LemmaScript generated, with the bodies the
 * proof file supplies inside the empty generated lemmas, and after it the
 * tools' lemmas, the proof file's helpers and the library. Only lines are
 * added; nothing generated changes. Each line is recorded with the definition
 * it belongs to, so that a failure is charged to where it really is.
 */
export function splice(gen: string, { proof, stepBody, axioms, lib: wholeLib }: Additions, where = "gen/proof/<unit>/<unit>.dfy", prelude: ReadonlySet<string> = new Set()): Spliced {
  const lemmas = proof ? parseProofFile(proof.text, proof.file) : [];
  if (proof) checkNames(proof, gen, wholeLib);
  // Only the part of the library the proof file reaches: the rest would be verified again for nothing.
  const lib = proof && wholeLib !== undefined ? libClosure(wholeLib, proof.text) : undefined;
  const empty = emptyLemmas(gen);
  const bodies = new Map<string, string>();
  const helpers: Lemma[] = [];
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
    } else helpers.push(l);
  }
  if (stepBody && empty.has("step_ensures") && !bodies.has("step_ensures")) bodies.set("step_ensures", stepBody);
  const lines: string[] = [];
  const regions: Region[] = [];
  const add = (text: string, region: Region) => { for (const l of text.split("\n")) { lines.push(l); regions.push(region); } };
  // The line of each empty generated lemma's `{`, after which its body goes.
  const opens = new Map([...empty].map(([name, { bodyAt }]) => [gen.slice(0, bodyAt).split("\n").length - 1, name]));
  let region: Region = { def: "?", generated: false };
  gen.split("\n").forEach((line, i) => {
    const m = line.match(DEFINITION);
    if (m) region = prelude.has(m[1]) ? { def: m[1], generated: true, prelude: true } : { def: m[1], generated: true };
    add(line, region);
    const body = bodies.get(opens.get(i) ?? "");
    if (body) add(body, region);
  });
  const tail: [string, Region][] = [
    ...axioms.map((a, i): [string, Region] => [`${i ? "" : "// ---- laws of the units this one imports, each proved in its own unit (added by the tools) ----\n\n"}${a}`, { def: a.match(/^lemma \{:axiom\} (\w+)/)![1], generated: false }]),
    ...helpers.map((h, i): [string, Region] => [`${i ? "" : `// ---- helpers from ${proof!.file} ----\n\n`}${h.text}`, { def: h.name, generated: false }]),
    ...(lib ? [[`// ---- tools/proof/lib.dfy ----\n\n${lib.trimEnd()}`, { def: LIB_MODULE, generated: false }] as [string, Region]] : []),
  ];
  if (tail.length) {
    while (lines.length && !lines.at(-1)!.trim()) { lines.pop(); regions.pop(); }
    lines[lines.length - 1] = lines.at(-1)!.trimEnd();
    for (const [text, r] of tail) add(`\n${text}`, r);
    add("", region);
  }
  return { dfy: lines.join("\n"), regions };
}

/**
 * The declarations of the library a proof file names as ProofLib.<Name>, with everything of the library they
 * mention, in the library's order; undefined if it names none. Leaving a lemma out can only make less provable,
 * since a lemma is used only where it is called; so can leaving out the library's import of Dafny's standard
 * library when nothing kept mentions it. A library not laid out as expected is kept whole.
 */
export function libClosure(lib: string, proofText: string): string | undefined {
  const wanted = dottedNames(tokenize(proofText.replace(/\r\n/g, "\n"))).flatMap((d) => (d.name.startsWith(`${LIB_MODULE}.`) ? [d.name.split(".")[1]] : []));
  if (!wanted.length) return undefined;
  const lines = lib.trimEnd().split("\n");
  const DECL = /^  (?:ghost\s+)?(?:lemma|function|predicate)\s+(\w+)/;
  const starts = lines.flatMap((l, i) => { const m = l.match(DECL); return m ? [{ at: i, name: m[1] }] : []; });
  const end = lines.length - 1;
  if (!starts.length || lines[end] !== "}" || !/^module ProofLib \{$/m.test(lines.slice(0, starts[0].at).join("\n"))) return lib;
  const chunks = new Map(starts.map(({ at, name }, k) => [name, lines.slice(at, starts[k + 1]?.at ?? end)]));
  const kept = new Set<string>();
  for (const queue = [...wanted]; queue.length; ) {
    const name = queue.pop()!;
    if (kept.has(name) || !chunks.has(name)) continue;
    kept.add(name);
    for (const t of tokenize(chunks.get(name)!.join("\n"))) if (t.kind === "word" && chunks.has(t.t) && !kept.has(t.t)) queue.push(t.t);
  }
  const body = starts.filter((s) => kept.has(s.name)).flatMap((s) => chunks.get(s.name)!);
  const usesStd = body.some((l) => /\bSeq\./.test(l.replace(/\/\/.*$/, "")));
  const head = lines.slice(0, starts[0].at).filter((l) => usesStd || !/^\s*import\s+Std\./.test(l));
  return [...head, ...body, lines[end]].join("\n") + "\n";
}

/** The lemma that makes a dependency's law usable here: `<fn>` is how this unit spells the law. */
export function lawAxiom(gen: string, fn: string): string | undefined {
  const m = gen.match(new RegExp(`^function ${fn}\\(([^\\n]*)\\): bool\\n\\{`, "m"));
  if (!m) return undefined;
  const args = [...m[1].matchAll(/(?:^|,\s*)(\w+)\s*:/g)].map((a) => a[1]);
  return `lemma {:axiom} ${fn}_ensures(${m[1]})\n  ensures ${fn}(${args.join(", ")}) == true`;
}

// --- reading what Dafny said -----------------------------------------------------

interface Verdict {
  unproved: Map<string, string>;
  exhausted: Set<string>;
  errors: Set<string>;
  failing: Map<string, Set<number>>;
  /** The definitions of the unit that any failure was reported in. */
  touched: Set<string>;
  /** How many failures were read; Dafny's own count is checked against it. */
  read: number;
}

/** Dafny's closing line: how many it verified, and how many failures of each kind it reported. */
const SUMMARY = /^Dafny program verifier finished with \d+ verified, (\d+) errors?((?:, \d+ [a-z ]+)*)$/gm;
const finished = (out: string) => new RegExp(SUMMARY.source, "m").test(out);
const tail = (out: string) => out.trim().split("\n").slice(-3).join(" / ");
const obligation = (def: string, clause: string) => `${def.replace(/_ensures$/, "")}: ${clause}`;

/**
 * Sort Dafny's messages about `file` into obligations not proved (keyed by
 * definition and clause), obligations it ran out of resources on, and errors.
 * A message counts only at the start of a line and with the bare file name
 * (Dafny runs in the unit's directory, without echoing source lines); a
 * postcondition is taken only from the error's own block and definition. A
 * failure anywhere but in a definition the unit's own code generated (a helper,
 * the library, a lemma the tools add, one of LemmaScript's own helpers) is an
 * error: the proof itself is broken. So is a count of failures that differs
 * from the one Dafny reports. Messages about definitions `only` refuses are
 * counted, and otherwise passed over.
 */
function readVerdict(out: string, dfy: string, file: string, regions: Region[], { rename = (n: string) => n, only = () => true }: { rename?: (def: string) => string; only?: (def: string) => boolean } = {}): Verdict {
  const lines = out.split("\n");
  const source = dfy.split("\n");
  const pattern = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\((\\d+),\\d+\\): (Error|Warning|Related location): (.*)$`);
  const at = (l: string | undefined) => {
    const m = l?.match(pattern);
    return m ? { line: Number(m[1]), kind: m[2], what: m[3] } : undefined;
  };
  const clause = (line: number) => (source[line - 1] ?? "").trim().replace(/^ensures\s+/, "");
  const v: Verdict = { unproved: new Map(), exhausted: new Set(), errors: new Set(), failing: new Map(), touched: new Set(), read: 0 };
  const fail = (line: number, text: string, exhausted: boolean) => {
    const r = regions[line - 1];
    if (r?.prelude) { v.errors.add(`${r.def} (${file}:${line}), one of LemmaScript's own helpers, does not verify: ${text}; it is not an obligation of the unit`); return; }
    if (!r?.generated) { v.errors.add(`${r?.def ?? "?"} (${file}:${line}) does not verify: ${text}; a lemma that is not generated must prove`); return; }
    const def = rename(r.def);
    const k = obligation(def, text);
    v.unproved.set(k, def);
    if (exhausted) v.exhausted.add(k);
    if (!v.failing.has(def)) v.failing.set(def, new Set());
    v.failing.get(def)!.add(line);
  };
  lines.forEach((l, i) => {
    const m = at(l);
    if (!m) {
      if (/^Error:|: Error:/.test(l) && !l.startsWith(`${file}(`)) v.errors.add(l.trim());
      return;
    }
    if (m.kind === "Error") v.read++;
    const region = regions[m.line - 1];
    if (!only(region?.def ?? "?")) return;
    if (m.kind === "Error" && region?.generated && !region.prelude) v.touched.add(region.def);
    if (m.kind === "Error" && m.what.startsWith("a postcondition could not be proved")) {
      const block: { line: number; what: string }[] = [];
      for (let j = i + 1, r = at(lines[j]); r?.kind === "Related location"; r = at(lines[++j])) block.push(r);
      const related = block.find((r) => r.what.includes("postcondition") && regions[r.line - 1] && regions[r.line - 1] === region);
      if (related) fail(related.line, clause(related.line), false);
      else v.errors.add(`${region?.def ?? "?"}: ${m.what}, and Dafny named no postcondition of it: ${clause(m.line)}`);
    } else if (m.kind === "Error" && /out of resource|timed out/.test(m.what)) {
      const text = source[m.line - 1]?.trim() ?? "";
      fail(m.line, text.startsWith("ensures") ? clause(m.line) : "the prover ran out of resources", true);
    } else if (m.kind === "Error") v.errors.add(`${region?.def ?? "?"}: ${m.what}: ${clause(m.line)}`);
    else if (m.kind === "Warning") v.errors.add(`${region?.def ?? "?"}: ${m.what}`);
  });
  const reported = [...out.matchAll(SUMMARY)].reduce((n, s) => n + Number(s[1]) + [...s[2].matchAll(/\d+/g)].reduce((a, x) => a + Number(x[0]), 0), 0);
  if (reported !== v.read) v.errors.add(`Dafny reported ${reported} failures, but ${v.read} were read from its output`);
  return v;
}

/** A run of Dafny that gave no verdict, or failed without saying where, is an error. */
function explain(v: Verdict, { ok, out }: { ok: boolean; out: string }, what: string) {
  if (!finished(out)) v.errors.add(`${what} gave no verdict: ${tail(out) || "it printed nothing"}`);
  else if (!ok && !v.read && !v.errors.size) v.errors.add(`${what} failed and said nowhere why: ${tail(out)}`);
}

function merge(into: Verdict, from: Verdict) {
  for (const [k, def] of from.unproved) into.unproved.set(k, def);
  for (const k of from.exhausted) into.exhausted.add(k);
  for (const e of from.errors) into.errors.add(e);
  for (const [def, lines] of from.failing) into.failing.set(def, new Set([...(into.failing.get(def) ?? []), ...lines]));
}

/** Whether a Dafny text uses the standard library, read outside comments; a wrong yes only costs time, a wrong no fails to resolve. */
const usesStd = (dfy: string) => dfy.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").includes("Std.");
const verifyArgs = (dfy: string, cores: number) => {
  const z3 = solver();
  return ["verify", ...(usesStd(dfy) ? ["--standard-libraries"] : []), "--unicode-char:true", ...DAFNY_FLAGS, "--verification-time-limit", String(TIME_LIMIT),
    "--cores", String(cores), ...(z3.path ? ["--solver-path", z3.path] : [])];
};
/** Verify `file`, whose text is `dfy`, in `dir`, with Dafny using as many cores as it takes slots. */
const verify = (dir: string, file: string, dfy: string, extra: string[], cores = DAFNY_CORES) =>
  runAsync("dafny", [...verifyArgs(dfy, cores), ...extra, file], dir, { cores });

/**
 * What a run logged as CSV says of each batch it verified: the symbol (a definition, as Dafny names it), and the
 * outcome. Undefined if there is no log. A run restricted with `--filter-symbol` says nothing about a definition it
 * did not select, so a definition counts as verified there only if it is listed.
 */
function readCsv(dir: string, csv: string): { name: string; passed: boolean }[] | undefined {
  const file = path.join(dir, csv);
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8").split("\n").slice(1).filter((r) => r.trim()).map((row) => {
    const cells = row.match(/^"((?:[^"]|"")*)",(\w+)|^([^,]*),(\w+)/);
    const name = (cells?.[1]?.replace(/""/g, '"') ?? cells?.[3] ?? row).replace(/ \(.*$/, "");
    return { name, passed: (cells?.[2] ?? cells?.[4]) === "Passed" };
  });
}
const logTo = (csv: string) => ["--log-format", `csv;LogFileName=${csv}`];

/**
 * Verify again, each assertion on its own, the definitions a whole-definition run found a failure in: one run per
 * definition, or a single run when there are many. What each run says counts only for its own definitions, and only
 * if the run's log shows that Dafny verified them. Without `defs`, everything is verified again and all of it counts.
 */
async function isolate(dir: string, { dfy, regions }: Spliced, file: string, defs?: string[]): Promise<{ verdict: Verdict; log: string }> {
  const base = file.replace(/\.dfy$/, "");
  const groups = !defs ? [{ filter: undefined, defs: undefined }] : defs.length > 4 ? [{ filter: undefined, defs }] : defs.map((d) => ({ filter: d, defs: [d] }));
  const verdict: Verdict = { unproved: new Map(), exhausted: new Set(), errors: new Set(), failing: new Map(), touched: new Set(), read: 0 };
  const logs = await Promise.all(groups.map(async ({ filter, defs }) => {
    const csv = `${base}.isolated-${filter ?? "all"}.csv`;
    fs.rmSync(path.join(dir, csv), { force: true });
    const r = await verify(dir, file, dfy, [...ISOLATED, ...logTo(csv), ...(filter ? ["--filter-symbol", filter] : [])]);
    const w = readVerdict(r.out, dfy, file, regions, defs ? { only: (d) => defs.includes(d) } : {});
    explain(w, r, `Dafny, verifying ${filter ?? (defs ? "the definitions with a failure" : "the unit")} one assertion at a time,`);
    const listed = new Set((readCsv(dir, csv) ?? []).map((row) => row.name));
    for (const d of defs ?? []) if (!listed.has(d)) w.errors.add(`${d} failed when verified as a whole, and Dafny did not verify it again one assertion at a time`);
    merge(verdict, w);
    return r.out;
  }));
  return { verdict, log: logs.join("\n") };
}

/**
 * For each definition with a failure, a copy of it for each postcondition that may have passed only because a
 * failure before it was assumed, with that postcondition as its only one; definitions in `skip` (whose obligations
 * are all counted as not proved anyway) get none. Postconditions are checked in order after the body, so one before
 * the first that failed cannot have relied on a failure, unless the body itself has one. A definition that cannot be
 * copied has each such postcondition counted as not proved: `closed`.
 */
export function isolatedCopies({ dfy, regions }: Spliced, failing: Map<string, Set<number>>, skip: ReadonlySet<string>, prefix: string): { copies: [string, Region][]; copyOf: Map<string, string>; closed: Map<string, string> } {
  const lines = dfy.split("\n");
  const copies: [string, Region][] = [];
  const copyOf = new Map<string, string>();
  const closed = new Map<string, string>();
  const isEnsures = (i: number) => /^\s*ensures\b/.test(lines[i]);
  for (const [def, failed] of failing) {
    if (skip.has(def)) continue;
    const own = lines.flatMap((_, i) => (regions[i]?.def === def && regions[i].generated ? [i] : []));
    const start = own[0] ?? -1;
    const open = start < 0 ? -1 : lines.findIndex((l, i) => i > start && l === "{");
    const header = start < 0 ? undefined : lines[start].match(DEFINITION);
    const shaped = !!header && header[1] === def && open > start && regions[open] === regions[start];
    // Its obligations, as line numbers: the postconditions before its body, or, if it cannot be read, every one of its lines that looks like one.
    const obligations = (shaped ? own.filter((i) => i > start && i < open) : own).filter(isEnsures).map((i) => i + 1);
    const first = Math.min(...failed);
    const todo = ([...failed].every((l) => obligations.includes(l)) ? obligations.filter((l) => l > first) : obligations).filter((l) => !failed.has(l));
    if (!todo.length) continue;
    let bodyText: string | undefined;
    if (shaped) {
      const rest = lines.slice(open).join("\n");
      let depth = 0;
      const close = tokenize(rest).find((t) => (t.kind === "open" || t.kind === "attr" ? (depth++, false) : t.kind === "close" ? --depth === 0 : false));
      if (close) bodyText = rest.slice(0, close.end);
    }
    if (bodyText === undefined) {
      for (const l of todo) closed.set(obligation(def, lines[l - 1].trim().replace(/^ensures\s+/, "")), def);
      continue;
    }
    for (const line of todo) {
      const name = `${prefix}${copies.length}_${def}`;
      copyOf.set(name, def);
      const head = lines.slice(start, open).filter((l, i) => !/^\s*ensures\b/.test(l) || start + 1 + i === line);
      copies.push([[head[0].replace(new RegExp(`\\b${def}\\b`), name), ...head.slice(1), bodyText].join("\n"), { def: name, generated: true }]);
    }
  }
  return { copies, copyOf, closed };
}

/**
 * A postcondition that fails is assumed while the later ones of the same
 * definition are checked, so those may pass only because of it. Check each of
 * them again in a copy of the definition that has it as its only postcondition.
 */
async function recheck(dir: string, spliced: Spliced, file: string, failing: Map<string, Set<number>>, skip: ReadonlySet<string>): Promise<{ verdict?: Verdict; log: string; closed: Map<string, string> }> {
  const { dfy, regions } = spliced;
  let prefix = "isolated";
  while (dfy.includes(prefix)) prefix = `x${prefix}`;
  const { copies, copyOf, closed } = isolatedCopies(spliced, failing, skip, prefix);
  if (!copies.length) return { log: "", closed };
  const derived: string[] = dfy.trimEnd().split("\n");
  const derivedRegions = regions.slice(0, derived.length);
  for (const [text, r] of copies) for (const l of `\n${text}`.split("\n")) { derived.push(l); derivedRegions.push(r); }
  const name = file.replace(/\.dfy$/, ".isolated.dfy");
  const text = `${derived.join("\n")}\n`;
  fs.writeFileSync(path.join(dir, name), text);
  const csv = name.replace(/\.dfy$/, ".csv");
  fs.rmSync(path.join(dir, csv), { force: true });
  const r = await verify(dir, name, text, [...ISOLATED, ...logTo(csv), "--filter-symbol", prefix], Math.min(DAFNY_CORES, copies.length));
  const verdict = readVerdict(r.out, text, name, derivedRegions, { rename: (n) => copyOf.get(n) ?? n });
  explain(verdict, r, "Dafny, checking postconditions one by one,");
  const listed = new Set((readCsv(dir, csv) ?? []).map((row) => row.name));
  const missed = [...copyOf.keys()].filter((c) => !listed.has(c));
  if (missed.length) verdict.errors.add(`Dafny did not check ${missed.length} of the postconditions to be checked one by one (${missed.map((c) => copyOf.get(c)).join(", ")})`);
  return { verdict, log: r.out, closed };
}

/**
 * The definitions that rest on an obligation not proved: a lemma assumes every
 * postcondition of each lemma it calls, so one that calls a lemma with a failing
 * postcondition, or a lemma that does, proves nothing more than that one does.
 * Calls are read conservatively, as any mention of the name. Returns, for each
 * such definition, one obligation it rests on.
 */
function restingOn({ dfy, regions }: Spliced, unproved: Map<string, string>): Map<string, string> {
  const texts = new Map<Region, string[]>();
  dfy.split("\n").forEach((l, i) => { const t = texts.get(regions[i]); if (t) t.push(l); else texts.set(regions[i], [l]); });
  // What each definition mentions besides its own declaration; a second mention of its own name is a call to itself.
  const mentions = new Map<string, string[]>();
  for (const [r, t] of texts) {
    const words = tokenize(t.join("\n")).filter((k) => k.kind === "word").map((k) => k.t);
    if (words.includes(r.def)) words.splice(words.indexOf(r.def), 1);
    mentions.set(r.def, [...(mentions.get(r.def) ?? []), ...words]);
  }
  const failing = new Map<string, string>();
  for (const [k, def] of unproved) if (!failing.has(def)) failing.set(def, k);
  const rests = new Map<string, string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [def, words] of mentions) {
      if (rests.has(def)) continue;
      const callee = words.find((w) => failing.has(w) || rests.has(w));
      if (callee) { rests.set(def, failing.get(callee) ?? rests.get(callee)!); changed = true; }
    }
  }
  return rests;
}

/**
 * Findings of `dafny audit` in the unit's own file, other than the lemmas the tools add on purpose. It reads a copy
 * of its own, so that it can run while LemmaScript checks the original.
 */
async function audit(dir: string, dfy: string, file: string, allowed: Set<string>): Promise<{ findings: string[]; log: string }> {
  const copy = file.replace(/\.dfy$/, ".audit.dfy");
  fs.writeFileSync(path.join(dir, copy), dfy);
  const { out: raw } = await runAsync("dafny", ["audit", ...(usesStd(dfy) ? ["--standard-libraries"] : []), "--unicode-char:true", copy], dir);
  // Read as if it had audited the original, which has the same text.
  const out = raw.split(copy).join(file);
  const findings = out.split("\n").filter((l) => l.startsWith(`${file}(`) && /: (Warning|Error): /.test(l))
    .filter((l) => !/: Warning: (\w+): Declaration has explicit `\{:axiom\}` attribute/.test(l) || !allowed.has(l.match(/: Warning: (\w+):/)![1]));
  if (!/Dafny auditor completed/.test(out)) findings.push(`dafny audit gave no verdict: ${out.trim().split("\n").slice(-3).join(" / ")}`);
  return { findings: findings.map((f) => `dafny audit: ${f}`), log: out };
}

// --- one unit --------------------------------------------------------------------

export interface Proof {
  /** The unit's obligations: the `ensures` of its generated Dafny. */
  total: number;
  /** Obligations not proved, as `<definition>: <clause>`. */
  unproved: string[];
  /** Of those, the ones the prover ran out of resources on. */
  exhausted: string[];
  /** Of those, the ones whose proof calls, directly or not, a lemma with an obligation not proved: each with one such obligation. */
  resting: Record<string, string>;
  errors: string[];
  log: string;
  /** The final Dafny, as it was verified. */
  dfy: string;
}

export interface Unit {
  unit: string;
  text: string;
  /** Hand-written code under src/, whose obligations must be proved: nothing simulates them. */
  src: boolean;
  /** spec/<name>.proof.dfy or src/<path>.proof.dfy, relative to the project. */
  proofFile: string;
  /** Laws of the units this one imports, as this unit spells them, and the unit that proves each. */
  laws: { fn: string; law: string; from: string }[];
  /** The units whose assurance this one's rests on. */
  rests: string[];
  /** The unit's text as far as its proof depends on it: generated code without the comments that cite the spec. */
  meaning: string;
  /** How many `//@ requires` hand-written code assumes of its callers. */
  requires?: number;
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
  if (!cases.every(Boolean)) return undefined;
  // Each case needs only what `step` does and what `inv` says; hiding every other definition only removes facts, and
  // keeps the solver from unfolding them.
  const hide = /^function step\(/m.test(gen) && /^function inv\(/m.test(gen) ? ["  hide *;", "  reveal step, inv;"] : [];
  return [...hide, "  match event {", ...cases, "  }"].join("\n");
}

/** The names of LemmaScript's own helpers, which it adds to the Dafny of a unit that uses them. */
let helpers: Promise<ReadonlySet<string>> | undefined;
function helperNames(root: string): Promise<ReadonlySet<string>> {
  return (helpers ??= (async () => {
    // The module beside the lsc this run uses.
    const lsc = bin("lsc", root);
    const real = fs.realpathSync(lsc);
    const file = [path.join(path.dirname(real), "dafny-emit.js"), path.join(path.dirname(lsc), "..", "lemmascript", "tools", "dist", "dafny-emit.js")].find((f) => fs.existsSync(f));
    if (!file) throw new Error("LemmaScript's dafny-emit.js was not found beside lsc");
    const names = (await import(pathToFileURL(file).href)).DAFNY_HELPER_NAMES;
    if (!(names instanceof Set)) throw new Error("LemmaScript's dafny-emit.js does not export DAFNY_HELPER_NAMES");
    return names as ReadonlySet<string>;
  })());
}

/** Prove one unit in a directory of its own, so that nothing left over from another run or project can vouch for it. */
export async function prove(root: string, u: Unit, offered: { proof?: { file: string; text: string }; lib?: string; laws: string[] }): Promise<Proof> {
  const dir = path.join(root, "gen/proof", u.unit.replace(/\.ts$/, ""));
  const base = u.unit.replace(/\.ts$/, "");
  const file = `${base}.dfy`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, u.unit), u.text);
  // A configuration of our own, so that one further up cannot redirect the proof or relax it, and a TypeScript
  // project of our own, so that the project's tsconfig.json cannot add files, globals or options to it.
  fs.writeFileSync(path.join(dir, "lemmascript.json"), JSON.stringify({ "unread-annotations": "error", "run-log": false }));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "es2023", lib: ["es2023"], module: "nodenext", strict: true, noEmit: true, allowImportingTsExtensions: true, types: [] },
    files: [u.unit],
  }));
  let total = 0;
  const z3 = solver();
  let log = z3.note ? `note: ${z3.note}\n` : "";
  const result = (errors: string[], out: string, dfy = ""): Proof => ({ total, unproved: [], exhausted: [], resting: {}, errors, log: `${log}${out}`, dfy });
  if (z3.problem) return result([z3.problem], "");
  const generated = await runAsync("lsc", ["gen", "--backend=dafny", u.unit], dir);
  const genFile = path.join(dir, `${file}.gen`);
  if (!generated.ok || !fs.existsSync(genFile)) return result([tail(generated.out) || "lsc generated nothing"], generated.out);
  const gen = fs.readFileSync(genFile, "utf8");
  // Dafny is run with Unicode characters, the only string model the tools let a unit choose.
  if (/^\/\/ lsc options:.*javascript-utf16/m.test(gen)) return result(["the generated Dafny asks for UTF-16 strings, which the tools do not verify"], generated.out);
  const prelude = await helperNames(root);
  // Every obligation is an `ensures` of what LemmaScript generated from the unit; the imported modules come without
  // theirs, and LemmaScript's own helpers are not the unit's.
  let def: string | undefined;
  for (const line of gen.split("\n")) {
    def = line.match(DEFINITION)?.[1] ?? def;
    if (/^\s*ensures\b/.test(line) && !(def && prelude.has(def))) total++;
  }
  // Laws proved elsewhere, and the library, are only of use to a proof file.
  const axioms = offered.proof ? offered.laws.flatMap((fn) => lawAxiom(gen, fn) ?? []) : [];
  const axiomNames = new Set(axioms.map((a) => a.match(/^lemma \{:axiom\} (\w+)/)![1]));
  let spliced: Spliced;
  try {
    spliced = splice(gen, { proof: offered.proof, lib: offered.proof && offered.lib, axioms, stepBody: u.transitions && stepBody(gen, u.transitions) }, `gen/proof/${base}/${file}`, prelude);
  } catch (e) {
    return result([(e as Error).message], generated.out);
  }
  const { dfy } = spliced;
  fs.writeFileSync(path.join(dir, file), dfy);
  // Every unit, with or without a proof file: should LemmaScript ever emit something trusted, it fails here.
  const audited = audit(dir, dfy, file, axiomNames);
  // LemmaScript refuses this .dfy unless it is its own fresh output plus added lines; meanwhile Dafny verifies each
  // definition as a whole.
  const wholeCsv = `${base}.whole.csv`;
  const [diff, whole] = await Promise.all([runAsync("lsc", ["gen-check", "--backend=dafny", u.unit], dir), verify(dir, file, dfy, logTo(wholeCsv))]);
  log += `${generated.out}${diff.out}${whole.out}`;
  let v = readVerdict(whole.out, dfy, file, spliced.regions);
  if (!diff.ok) v.errors.add(`LemmaScript refused the final Dafny: ${tail(diff.out)}`);
  explain(v, whole, "Dafny");
  if (v.touched.size) {
    // What the whole-definition run says about the definitions without a failure stands; each one with a failure is
    // verified again, one assertion at a time, to say which of its obligations fail.
    const touched = v.touched;
    const rest = readVerdict(whole.out, dfy, file, spliced.regions, { only: (d) => !touched.has(d) });
    if (!diff.ok) rest.errors.add(`LemmaScript refused the final Dafny: ${tail(diff.out)}`);
    explain(rest, whole, "Dafny");
    if (!rest.errors.size) {
      // Only if the failures Dafny logged are exactly in those definitions: one charged to a definition but logged
      // under another symbol (a constant, a type) has everything verified again.
      const failed = readCsv(dir, wholeCsv)?.filter((row) => !row.passed).map((row) => row.name);
      const targeted = !!failed && failed.every((n) => touched.has(n)) && [...touched].every((d) => failed.includes(d));
      const again = await isolate(dir, spliced, file, targeted ? [...touched] : undefined);
      log += `\n---- ${targeted ? "each definition with a failure" : "the unit"}, verified again one assertion at a time ----\n${again.log}`;
      if (targeted) { merge(rest, again.verdict); v = rest; }
      else v = again.verdict;
    }
  }
  if (!v.errors.size && v.failing.size) {
    // A definition that rests on a failure has every obligation counted as not proved below; it needs no recheck.
    const again = await recheck(dir, spliced, file, v.failing, new Set(restingOn(spliced, v.unproved).keys()));
    for (const [k, d] of again.closed) v.unproved.set(k, d);
    if (again.verdict) {
      log += `\n---- each postcondition of a definition with a failure, checked on its own ----\n${again.log}`;
      merge(v, again.verdict);
    }
  }
  // Every obligation of a generated definition that rests on one not proved is not proved either.
  const resting: Record<string, string> = {};
  const lines = dfy.split("\n");
  for (const [def, on] of restingOn(spliced, v.unproved)) {
    const start = lines.findIndex((l, i) => spliced.regions[i].def === def && spliced.regions[i].generated && !spliced.regions[i].prelude);
    if (start < 0) continue;
    for (let i = start + 1; i < lines.length && lines[i] !== "{" && spliced.regions[i].def === def; i++) {
      const m = lines[i].match(/^\s*ensures\s+(.*)$/);
      const k = m && obligation(def, m[1].trim());
      if (k && !v.unproved.has(k)) { v.unproved.set(k, def); resting[k] = on; }
    }
  }
  const { findings, log: auditLog } = await audited;
  log += `\n---- dafny audit ----\n${auditLog}`;
  for (const f of findings) v.errors.add(f);
  return { total, unproved: [...v.unproved.keys()], exhausted: [...v.exhausted], resting, errors: [...v.errors], log, dfy };
}
