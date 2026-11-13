// The review ledgers: has a person confirmed that each rule's prose and Quint, each story's rules and each contract
// of hand-written verified code still say the same thing since `npm run accept`? (spec/<name>.lock.json and
// spec/src.lock.json; README, "What lives where".)

import fs from "node:fs";
import path from "node:path";
import { readSpecs, type Rule, type Spec, type Story } from "./parse.ts";
import { srcUnits } from "./units.ts";
import { indent, short, writeLock } from "./util.ts";

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
export interface Pending { where: string; rule?: Rule; story?: Story; lines?: string[]; status: keyof typeof ASKS; note?: string }
const ASKS = {
  "story has no rules": "write one ### rule for each thing the story requires",
  "new story": "check that its rules say everything it asks for",
  "story changed": "check its rules still say everything it asks for",
  "not formalized": "add a quint block that says what the prose says",
  "new": "confirm the prose and the model say the same thing",
  "prose and model both changed": "confirm they still agree",
  "prose changed": "update the model to match, or confirm it already does",
  "model changed": "update the prose to match, or confirm it already does",
  "removed or renamed": "confirm the rule is meant to be gone",
  "new contract": "confirm its //@ annotations say what the code must guarantee",
  "contract changed": "confirm its //@ annotations still say what the code must guarantee",
  "contract removed": "confirm the file is no longer meant to be proved",
};
const showPending = (p: Pending) => `${p.where}\n      ${p.status}${p.note ?? ""}: ${ASKS[p.status]}`;

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
        : was[1] === code ? (was.length < 3 ? " (what it relies on was not recorded before)" : " through a definition it relies on") : undefined;
    }
    if (status) out.push({ where: `${spec.file}:${rule.line}  ${rule.key}`, rule, status, note });
  }
  for (const key of Object.keys(lock))
    if (!spec.rules.some((r) => r.key === key) && !spec.stories.some((s) => storyKey(s) === key)) out.push({ where: `${spec.file}  ${key}`, status: "removed or renamed" });
  return out;
}

/** Record every story and rule of a spec as reconciled. */
export function acceptReviews(root: string, spec: Spec, specs: Spec[] = readSpecs(root)) {
  // In the order of the spec, so a diff of the ledger shows exactly what was re-reviewed.
  const entries = [
    ...spec.stories.map((s) => ({ line: s.line, key: storyKey(s), value: [proseFingerprint(s.prose)] })),
    ...spec.rules.map((r) => {
      const deps = dependencyFingerprint(dependencies(spec, r, specs));
      return { line: r.line, key: r.key, value: deps ? [...fingerprint(r), deps] : fingerprint(r) };
    }),
  ].sort((a, b) => a.line - b.line);
  writeLock(lockFile(root, spec), entries.map((e) => `  ${JSON.stringify(e.key)}: ${JSON.stringify(e.value)}`));
}

// --- the contracts of hand-written verified code ------------------------------------

const contractsFile = (root: string) => path.join(root, "spec/src.lock.json");
const contractOf = (code: string) => code.split("\n").filter((l) => l.includes("//@")).map((l) => l.trim());
/** The contract of every proved src file, its `//@` lines, under its path. */
export const contracts = (root: string) => new Map(srcUnits(root).map((u) => [`src/${u.file.split(path.sep).join("/")}`, contractOf(u.code)]));

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
  writeLock(contractsFile(root), [...contracts(root)].map(([file, c]) => `  ${JSON.stringify(file)}: ${JSON.stringify(short(c.join("\n")))}`));
}

/**
 * The pending items as a review result shows them: each with what to do, then both halves of every rule that has
 * moved, the text and rules of every story that has, and the lines of every new or changed contract, so that whoever
 * reconciles them compares rather than guesses.
 */
export function showItems(todo: Pending[], heading: string): string {
  const moved = todo.flatMap(({ where, rule, story, lines, status, note }) =>
    rule && (status === "new" || status.includes("changed")) ? [`    "${rule.key}" (${status}${note ?? ""})\n      its prose:\n${indent(rule.prose.trim() || "(only the heading)", 8)}\n      its Quint:\n${indent(rule.code.trim(), 8)}`]
    : story && status !== "story has no rules" ? [`    "${story.title}" (${status})\n      its text:\n${indent(story.prose.trim() || "(only the heading)", 8)}\n      its rules:\n${indent((lines ?? []).join("\n"), 8)}`]
    : !story && lines ? [`    ${where} (${status})\n      its //@ lines:\n${indent(lines.join("\n"), 8)}`]
    : []);
  return todo.map((t) => "    " + showPending(t)).join("\n") + (moved.length ? `\n\n    ${heading}:\n${moved.join("\n")}` : "");
}
