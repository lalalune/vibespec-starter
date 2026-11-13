// What Studio reads of a project, through the tools' own synchronous API (../../spec.ts, ../../parse.ts), and the
// Node edges Effect has no service for. Everything that runs, writes or serves is ./server.vibe's.
// README, "Studio".
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import ts from "typescript";
import { trusted } from "vibelang-runtime";
import { acceptable, parseSpec, pending, pendingKey, readSpecs, type Lock, type Result } from "../../spec.ts";
import { specFiles, specName } from "../../parse.ts";
import { filesUnder, projectRoot, short } from "../../util.ts";
import type { Verdict } from "../gen/index.ts";
import { manifestOf, nodesOf, type Ids, type Manifest } from "./doc.ts";
import { outlineOf, specOrder } from "./markdown.ts";

const EXT = path.extname(import.meta.filename);
/** The tools: vibestack/ from source, dist/ when built. */
export const TOOLS = path.join(import.meta.dirname, "..", "..");
/** The `spec` command, as source or as built. */
export const SPEC = path.join(TOOLS, `spec${EXT}`);
export const PUBLIC = path.join(import.meta.dirname, "public");
/** This Node, to run the `spec` command with. */
export const NODE = process.execPath;
/** The modules the page may load from the tools, by their path below them: the page, what it imports, and nothing else. */
const MODULES = /^(scan|studio\/src\/(page|markdown)|studio\/gen\/(index|outline))$/;

/** @throws {never} */
export const createServer = () => http.createServer();
/** The directory and arguments `spec studio` was started with (../../spec.ts). @throws {never} */
export const commandLine = () => ({ cwd: process.cwd(), args: process.argv.slice(2) });
/** @throws {never} */
export const interactive = () => process.stdout.isTTY === true;
/** The program that opens a URL in the browser. @throws {never} */
export const opener = () => (process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open");
/** The program that says whether another is on the PATH. @throws {never} */
export const finder = () => (process.platform === "win32" ? "where" : "which");

const readJson = <T>(file: string): T | undefined => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined);
/** The project's name in its package.json, or its directory's. A trusted call: VibeLang code receives its `Error`s as failures. */
export const projectName = trusted((root: string) => readJson<{ name?: string }>(path.join(root, "package.json"))?.name ?? path.basename(root), [Error]);
/** What the last publish left for an agent to sync. A trusted call. */
export const readManifest = trusted((root: string) => readJson<Manifest>(manifestFile(root)), [Error]);
/** @throws {never} */
export const stateFile = (root: string) => path.join(root, ".studio", "state.json");
/** @throws {never} */
export const manifestFile = (root: string) => path.join(root, ".studio", "manifest.json");

/** `spec studio [<directory>]`'s project: the directory, which must hold a spec tree. A trusted call. */
export const studioRoot = trusted(function studioRoot(cwd: string, directory: string): string {
  const root = projectRoot(directory, cwd);
  if (!fs.statSync(path.join(root, "spec"), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${root}: no spec/ directory; run \`spec init\` in the project first`);
  return root;
}, [Error]);

/** Every Markdown spec in the tree, by its path from the project root. A trusted call. */
export const specTexts = trusted(function specTexts(root: string): Record<string, string> {
  return Object.fromEntries(specFiles(root).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
}, [Error]);

/** The command a person or agent runs in a project to check it: its own script if it can, else the tools of this repository. A trusted call. */
export const checkCommand = trusted(function checkCommand(root: string): string {
  const scripts = readJson<{ scripts?: Record<string, string> }>(path.join(root, "package.json"))?.scripts ?? {};
  const hasSpecBin = fs.existsSync(path.join(root, "node_modules/.bin/spec")) || !scripts.check?.startsWith("spec ");
  return scripts.check && hasSpecBin ? "pnpm check" : `node ${path.relative(root, SPEC)} check`;
}, [Error]);

/** The sync skill, as a path from the project root: its own copy, or the nearest one above it. @throws {never} */
export function skillPath(root: string): string {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const file = path.join(dir, ".claude/skills/sync/SKILL.md");
    if (fs.existsSync(file)) return path.relative(root, file);
    if (dir === path.dirname(dir)) return ".claude/skills/sync/SKILL.md";
  }
}

/** The review ledgers and Studio state belong to the tools, not the sync agent. A trusted call. */
export const ownedFiles = trusted(function ownedFiles(root: string): Record<string, string> {
  return Object.fromEntries([...filesUnder(root, "spec").filter((f) => f.endsWith("lock.json")), ...filesUnder(root, ".studio")]
    .map((f) => [f, short(fs.readFileSync(path.join(root, f), "utf8"))]));
}, [Error]);

/**
 * What a check found, as spec/index.md's verdict. `Reviewable` is what `accept` can record: every stage but review
 * passed, every story has rules and every rule has Quint. @throws {never}
 */
export function verdictOf(results: Result[]): Verdict {
  return !results.some((r) => !r.ok) ? "Green" : acceptable(results) ? "Reviewable" : "Failing";
}

/** The specs as the page shows them, with what the review ledger says of each story and rule. A trusted call. */
export const specsOf = trusted(function specsOf(root: string) {
  const texts = specTexts(root);
  const specs = readSpecs(root);
  const locks = new Map<string, Lock>();
  const review = Object.fromEntries(specs.map((s) => [s.file, Object.fromEntries(pending(root, s, specs, locks).map((p) => [pendingKey(p), p.status + (p.note ?? "")]))]));
  return Object.entries(texts).sort(([a], [b]) => specOrder(a).localeCompare(specOrder(b)))
    .map(([file, text]) => ({ file, module: specName(file), hash: short(text), text, outline: outlineOf(file, text), review: review[file] ?? {} }));
}, [Error]);

/** A module the page imports, as JavaScript: transpiled from source, or as built; undefined for any other path. A trusted call. */
export const pageModule = trusted(function pageModule(name: string): string | undefined {
  const file = [`${name}${EXT}`, `${name}.js`].map((f) => path.join(TOOLS, f)).find((f) => MODULES.test(name) && fs.existsSync(f));
  if (!file) return undefined;
  const code = fs.readFileSync(file, "utf8");
  if (!file.endsWith(".ts")) return code;
  return ts.transpileModule(code, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, rewriteRelativeImportExtensions: true } }).outputText;
}, [Error]);

/** What the page asks to publish: each file as it was loaded (`base`, a hash) and as it is now (`text`, null to delete). */
export interface Publish { files: { file: string; base: string | null; text: string | null }[]; origins: [string, string | null][]; force?: boolean }
interface State { baseline: Record<string, string>; ids: Ids }
/** What publishing writes, or why it may not. */
export type Plan =
  | { status: 400 | 409; body: { error: string; conflicts?: string[] } }
  | { status: 200; disk: Record<string, string>; state: State; manifest: Manifest };

/**
 * Check a publish against the project, and work out the manifest it leaves: the baseline the agent last synced, and
 * where each story and rule came from. A trusted call. */
export const planPublish = trusted(function planPublish(root: string, body: Publish): Plan {
  const disk = specTexts(root);
  const conflicts = body.force ? [] : body.files.filter((f) => (f.file in disk ? short(disk[f.file]) : null) !== f.base).map((f) => f.file);
  if (conflicts.length) return { status: 409, body: { error: "changed on disk since you loaded it", conflicts } };
  const next = { ...disk };
  for (const f of body.files) {
    try {
      specName(f.file);
      let target = root;
      for (const segment of f.file.split("/")) {
        target = path.join(target, segment);
        if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${f.file}: spec paths may not be symlinks`);
      }
      if (f.text !== null) parseSpec(root, f.file, f.text);
    } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
    if (f.text === null) delete next[f.file];
    else next[f.file] = f.text;
  }
  // Every heading the page meant to write is a heading of the text: a prose line that starts with ## would not be.
  const origins = new Map(body.origins);
  for (const f of body.files) if (f.text !== null) {
    const stray = nodesOf(f.file, f.text).find((n) => !origins.has(n.id));
    if (stray) return { status: 400, body: { error: `${f.file}: "${stray.heading}" would be a heading; a line of prose may not start with ## or ###` } };
  }
  const state = readJson<State>(stateFile(root)) ?? { baseline: disk, ids: {} };
  const inBaseline = new Set(Object.entries(state.baseline).flatMap(([f, t]) => nodesOf(f, t).map((n) => n.id)));
  const baseOf = (id: string) => (id in state.ids ? state.ids[id] : inBaseline.has(id) ? id : null);
  const ids: Ids = {};
  for (const [file, text] of Object.entries(next)) for (const n of nodesOf(file, text)) {
    const origin = body.files.some((f) => f.file === file) ? origins.get(n.id) ?? null : n.id;
    ids[n.id] = origin === null ? null : baseOf(origin);
  }
  return { status: 200, disk, state: { baseline: state.baseline, ids }, manifest: manifestOf(root, state.baseline, next, ids) };
}, [Error]);
