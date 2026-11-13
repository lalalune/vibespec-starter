// The proof units of a project, one per spec and one per hand-written verified file under src/, and the proof stage
// that proves them all (prove.ts proves one) against the ledger of obligations accepted as simulated only
// (spec/unproved.lock.json).

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { remembered } from "./cache.ts";
import type { Model } from "./gen.ts";
import { importOrder } from "./parse.ts";
import { dafnyVersion, LIB_FILE, prove, type Proof, type Unit } from "./prove.ts";
import { fail, filesUnder, indent, sha, writeLock, type Accept, type Report } from "./util.ts";

/** The annotations hand-written verified code may use. Ones that tell the prover to trust or skip something are not proofs. */
const ANNOTATIONS = ["backend", "pure", "requires", "ensures", "invariant", "decreases", "type", "ghost", "assert"];

/**
 * Every file under src/ that LemmaScript would read, because `//@` appears in it, with its text: the .ts files, which
 * are proved, or with `other` the scripts of any other kind, which are refused rather than left unproved.
 */
export function srcUnits(root: string, other = false): { file: string; code: string }[] {
  const src = path.join(root, "src");
  return filesUnder(src, other ? /\.(?:[mc]ts|tsx|[mc]?jsx?)$/ : /\.ts$/).map((f) => ({ file: f, code: fs.readFileSync(path.join(src, f), "utf8") })).filter((u) => u.code.includes("//@"));
}

/**
 * LemmaScript verifies one file at a time and does not carry definitions across
 * imports, so every unit is proved as a bundle: what it imports, then itself.
 * An imported module comes with its names prefixed by the module's name and
 * without its own obligations, which are proved once, in its own unit; that
 * keeps the cost of a proof proportional to the module, not to everything
 * beneath it. A law an imported module proved is offered to the unit's proof
 * file as a lemma; nothing else of it is.
 *
 * A unit may have a proof file: spec/<name>.proof.dfy for a spec,
 * src/<path>.proof.dfy for src/<path>.ts.
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
  const needs = (m: Model) => importOrder(m.imports, (n) => byName.get(n)!.imports);
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
    transitions: m.stateType ? m.transitions.map((t) => ({ name: t.name, params: t.params.map((p) => p.name) })) : undefined,
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
function checkVerifiedSource(file: string, code: string) {
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
  const found = ["spec", "src"].flatMap((dir) => filesUnder(path.join(root, dir), /\.proof\.dfy$/).map((f) => path.join(dir, f).split(path.sep).join("/")));
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
  // An entry without a fingerprint was accepted before acceptance named what it was for.
  return Object.fromEntries(Object.entries(raw).map(([unit, v]) => [unit, Array.isArray(v) ? { text: "", unproved: v } : (v as Accepted)]));
}
function writeLedger(root: string, ledger: Record<string, Accepted>) {
  // One obligation per line, so a diff of the ledger shows exactly what was accepted.
  writeLock(ledgerFile(root), Object.entries(ledger).map(([unit, { text, unproved }]) =>
    `  ${JSON.stringify(unit)}: {\n    "text": ${JSON.stringify(text)},\n    "unproved": [\n${unproved.map((u) => `      ${JSON.stringify(u)}`).join(",\n")}\n    ]\n  }`));
}

/**
 * The proof stage: prove every unit, each as soon as the units whose laws it may use are done, and compare what was
 * not proved with the ledger, which `accept` "unproved" rewrites. Returns what it found, in order, for the caller to
 * report after the typecheck that runs beside it, and whether it ran to the end; `report` hears at once of what the
 * ledger now holds. `used` is as for `remembered`.
 */
export async function proofStage(root: string, models: Model[], accept: Accept, used: Set<string>, report: Report): Promise<{ found: Parameters<Report>[]; ran: boolean }> {
  const found: Parameters<Report>[] = [];
  const said = (...args: Parameters<Report>) => { found.push(args); };
  try {
    const dafnyProblem = dafnyVersion().problem;
    if (dafnyProblem) throw new Error(dafnyProblem);
    const accepted = readLedger(root);
    const ledger: Record<string, Accepted> = {};
    let recordable = true;
    fs.rmSync(path.join(root, "gen/proof"), { recursive: true, force: true });
    const units = proofUnits(root, models);
    for (const f of strayProofFiles(root, units))
      said(false, "proof", `${f} belongs to no proof unit: spec/<name>.proof.dfy belongs to spec/<name>.md, and src/<path>.proof.dfy to src/<path>.ts if that file contains //@`, "", f);
    const lib = fs.readFileSync(LIB_FILE, "utf8");
    const proved = new Map<string, Proof>();
    // Units are proved at the same time, each as soon as the units it may take laws from are done; they are
    // reported in order.
    const running = new Map<string, Promise<Proof>>();
    const proofTexts = new Map<string, string | undefined>();
    for (const u of units) {
      const proofPath = path.join(root, u.proofFile);
      const proofText = fs.existsSync(proofPath) ? fs.readFileSync(proofPath, "utf8") : undefined;
      proofTexts.set(u.unit, proofText);
      running.set(u.unit, (async () => {
        if (proofText !== undefined) await Promise.allSettled(u.laws.map((l) => running.get(l.from)));
        // A law of an imported module is offered only if its own unit proved it, in this run.
        const laws = u.laws.filter(({ law, from }) => {
          const p = proved.get(from);
          return p && !p.errors.length && !p.unproved.some((x) => x.startsWith(`${law}: `));
        }).map((l) => l.fn);
        const offered = { proof: proofText === undefined ? undefined : { file: u.proofFile, text: proofText }, lib, laws };
        const proof = await remembered(root, !!accept, used, ["prove", u.unit, u.meaning, proofText ?? "", proofText === undefined ? "" : laws.join(" ")], () => prove(root, u, offered), (p) => !p.errors.length);
        proved.set(u.unit, proof);
        return proof;
      })());
    }
    // Every unit finishes, whatever another one does, before anything is reported.
    const settledProofs = await Promise.allSettled(units.map((u) => running.get(u.unit)!));
    const thrown = settledProofs.find((r) => r.status === "rejected");
    if (thrown) throw thrown.reason;
    for (const u of units) {
      const proofText = proofTexts.get(u.unit);
      const proof = proved.get(u.unit)!;
      const base = u.unit.replace(/\.ts$/, "");
      const logFile = `gen/proof/${base}.log`;
      // The final Dafny stays on disk even when the result was remembered, so that it can be read.
      const dfyFile = path.join(root, "gen/proof", base, `${base}.dfy`);
      fs.mkdirSync(path.dirname(dfyFile), { recursive: true });
      fs.writeFileSync(path.join(root, logFile), proof.log);
      if (proof.dfy && !fs.existsSync(dfyFile)) fs.writeFileSync(dfyFile, proof.dfy);
      // What was accepted is tied to the text it was accepted for.
      const meaning = sha(u.text, proofText ?? "").slice(0, 12);
      const was = accepted[u.unit];
      const valid = was?.text === meaning ? was.unproved : [];
      const outdated = was && was.text !== meaning ? `; the ${was.unproved.length} accepted earlier were accepted for another text of this unit or its proof file, and no longer count` : "";
      const fresh = proof.unproved.filter((x) => !valid.includes(x));
      const stale = valid.filter((x) => !proof.unproved.includes(x));
      if (proof.unproved.length) ledger[u.unit] = { text: meaning, unproved: proof.unproved };
      const listed = (xs: string[]) => indent(xs.map((x) => (proof.exhausted.includes(x) ? `${x}   [the prover ran out of resources]` : x)).join("\n"));
      // Hand-written code proved against a module that is only partly proved rests on what is not.
      const assumed = u.rests.flatMap((r) => (proved.get(r)?.unproved.length ? [`${proved.get(r)!.unproved.length} of ${r}`] : []));
      const assuming = (assumed.length ? `, assuming the obligations that are simulated only (${assumed.join(", ")})` : "")
        // A precondition is assumed by the proof and checked by no one: callers outside verified code must meet it.
        + (u.requires ? `, under ${u.requires} //@ requires that its unverified callers must meet` : "");
      if (proof.errors.length) {
        recordable = false;
        said(false, "proof", `${u.unit}: Dafny could not check it (full output in ${logFile}, final Dafny in gen/proof/${base}/${base}.dfy)`, indent(proof.errors.join("\n")), u.unit);
      } else if (fresh.length && accept !== "unproved") {
        said(false, "proof", `${u.unit}: ${fresh.length} of ${proof.total} obligations not proved${outdated}. Prove them in ${u.proofFile}, or add the rule that makes them provable; if simulation is enough for them, that is the user's decision (\`npm run accept -- unproved\`). Full output in ${logFile}, final Dafny in gen/proof/${base}/${base}.dfy`, listed(fresh), u.unit);
      } else {
        said(true, "proof", `${u.unit}: ${proof.unproved.length ? `${proof.total} obligations, of which ${proof.unproved.length} are simulated only (accepted) and the rest proved` : `all ${proof.total} obligations proved`} for all states and inputs${assuming}`
          + (stale.length && accept !== "unproved" ? `; ${stale.length} accepted earlier now prove, run \`npm run accept -- unproved\` to tighten the ledger` : ""), "", u.unit);
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
    return { found, ran: true };
  } catch (e) {
    said(false, "proof", (e as Error).message);
    return { found, ran: false };
  }
}
