import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { exec } from "./run.ts";
import { heading, type Spec } from "./parse.ts";
import type { Result } from "./spec.ts";
import ts from "typescript";
import { FAILURES } from "./gen/vibe.ts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** A hash of several texts, in which no two lists of texts give the same input. */
export const sha = (...parts: string[]) => digest(JSON.stringify(parts));
export const short = (text: string) => digest(text).slice(0, 12);
export const indent = (s: string, by = 6) => s.split("\n").map((l) => " ".repeat(by) + l).join("\n");
/** What each promise gives, once every one has finished: a failure is thrown only then, so that nothing is left running. */
export async function allDone<T>(promises: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((r) => r.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/** Files and symbolic links below a project directory, excluding directory entries. */
export const filesUnder = (root: string, dir: string) => !fs.existsSync(path.join(root, dir)) ? []
  : fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true }).filter((e) => e.isFile() || e.isSymbolicLink())
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)).split(path.sep).join("/")).sort();

/** Resolve a project folder before a command reads or writes its files. */
export function projectRoot(directory: string, base = process.cwd()): string {
  const root = path.resolve(base, directory);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${directory}: not an existing project directory`);
  return fs.realpathSync(root);
}

/** The declarations the VibeLang compiler writes for a `.vibe` module: its output, not the package's code. */
const SIDECAR = /\.d\.vibex?\.ts$/;

/** Does this Node run `.vibe` sources (`node --import vibelang/register`)? The loader needs 22.22.3 on the 22 line, or 24.11.1 and later. */
export function nodeRunsVibelang(version = process.versions.node): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  const from = (a: number, b: number) => minor > a || (minor === a && patch >= b);
  return major === 22 ? from(22, 3) : major === 24 ? from(11, 1) : major > 24;
}

/**
 * The workspace package a spec belongs to by name, as a path from the root: `spec/<name>/…` is `apps/<name>` or
 * `packages/<name>`, if that is a package with no `spec/` of its own. The root's check generates into its `gen/` and
 * checks its code (AGENTS.md, "One spec tree").
 */
export function owner(root: string, spec: string): string | undefined {
  const [top, name, below] = spec.split("/");
  if (top !== "spec" || below === undefined) return undefined;
  return [`apps/${name}`, `packages/${name}`].find((dir) => fs.existsSync(path.join(root, dir, "package.json")) && !fs.existsSync(path.join(root, dir, "spec")));
}
/**
 * The directories whose code a check reads, each as the prefix of a path from the root: "" for the root's own
 * `src/` and `test/`, then `apps/app/` for each package that owns a directory of the spec tree.
 */
export const codeDirs = (root: string): string[] => ["", ...!fs.existsSync(path.join(root, "spec")) ? []
  : [...new Set(fs.readdirSync(path.join(root, "spec")).flatMap((name) => owner(root, `spec/${name}/`) ?? []))].sort().map((dir) => `${dir}/`)];
/** Which of `codeDirs` a path from the root is in: the root holds no `apps/` or `packages/` code of its own. */
export const codeDirOf = (file: string): string => file.match(/^(?:(?:apps|packages)\/[^/]+\/)?/)![0];

/** A file with `//@` under a `src/` the check reads; `file` is its path from the root (`src/x.ts`, `apps/app/src/x.ts`). */
export interface SrcFile { file: string; code: string; ts: boolean }
/** Every such file, read once: a check proves and reviews the same text, even if a file changes while it runs. */
export function readSrc(root: string): SrcFile[] {
  const files = codeDirs(root).flatMap((dir) => filesUnder(root, `${dir}src`)).filter((f) => /\.(?:[mc]?ts|tsx|[mc]?jsx?|vibex?)$/.test(f) && !SIDECAR.test(f));
  return files.map((f) => ({ file: f, code: fs.readFileSync(path.join(root, f), "utf8"), ts: /\.ts$/.test(f) })).filter((u) => u.code.includes("//@"));
}

/** One result as `report` in spec.ts takes it. */
export type Reported<S extends Result["stage"] = Result["stage"]> = [ok: boolean, stage: S, summary: string, detail?: string, where?: string];

/** A directory's package.json, or nothing; one that is not JSON is refused with its path. */
function manifest(dir: string) {
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`, { cause: e });
  }
}
/** A package's scripts. */
export const packageScripts = (root: string): Record<string, string> => manifest(root).scripts ?? {};

/** The tests stage of one of `codeDirs`: citations that name nothing, then the package's own tests, run in its directory. */
export async function tests(checking: string, dir: string, specs: Spec[]): Promise<Reported<"tests">[]> {
  const said: Reported<"tests">[] = [];
  const root = path.join(checking, dir);
  try {
    const scripts = packageScripts(root);
    const dangling = danglingCitations(checking, specs, dir);
    if (dangling.length) said.push([false, "tests", `${dangling.length} citations name no story or rule of the spec`, indent(dangling.join("\n"))]);
    const directOracle = conformanceImports(root).map((problem) => dir + problem);
    if (directOracle.length) said.push([false, "tests", "conformance drivers must reach the application, not call the generated oracle", indent(directOracle.join("\n"))]);
    // The package's own tests, in whatever runner it chose (AGENTS.md, "Tests"): its `test` script, or else
    // Node's on test/**/*.test.ts. The placeholder `npm init` writes is no script.
    const script = /no test specified/.test(scripts.test ?? "") ? undefined : scripts.test;
    const files = filesUnder(root, "test").filter((f) => f.endsWith(".test.ts"));
    // A test in VibeLang cannot import node:test, so Node's runner below would pass over it without a word.
    const unrun = script ? [] : filesUnder(root, "test").filter((f) => /\.test\.vibex?$/.test(f));
    if (unrun.length) said.push([false, "tests", `${unrun.join(", ")}: a VibeLang test, and the package has no \`test\` script to run it; add one, such as \`vitest run\``, undefined, "test/"]);
    // Without a script, Node's runner: tests in TypeScript may import the `.vibe` shell, which the loader compiles.
    const [command, args] = script ? [packageManager(root), ["run", "test"]] : [process.execPath, ["--import", "vibelang/register", "--test", ...files]];
    if (script || files.length) {
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      // The root that is checking: spec.ts refuses a check of it, or of a package below it, started from these tests.
      const t = await exec(command, args, root, { ...env, SPEC_TESTS: fs.realpathSync(checking) });
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
 * Every `spec/<name>.md, "<heading>"` in a package's code whose heading is no story or rule of that spec, as
 * `file:line  citation`, both paths from the root. The package is one of `codeDirs`: an owner cites as the root does.
 * Build output and the packages nested inside it, which are checked on their own, are not read.
 */
export function danglingCitations(root: string, specs: Spec[], dir = ""): string[] {
  const names = (s: Spec, h: string) => s.stories.some((t) => t.title === h) || s.rules.some((r) => heading(r) === h);
  return packageCode(path.join(root, dir)).map((f) => dir + f).flatMap((f) =>
    fs.readFileSync(path.join(root, f), "utf8").split("\n").flatMap((line, i) =>
      [...line.matchAll(/(?<![\w/.-])(spec\/(?:[A-Za-z0-9]+\/)*[A-Za-z0-9]+\.md), "([^"]+)"/g)]
        .filter(([, file, h]) => !specs.some((s) => s.file === file && names(s, h)))
        .map(([cited]) => `${f}:${i + 1}  ${cited}`)));
}

function packageCode(root: string, dir = ""): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isFile()) return /\.(?:[cm]?[jt]sx?|vibex?)$/.test(e.name) && !SIDECAR.test(e.name) ? [rel] : [];
    const skip = /^(node_modules|dist|build|out|coverage|\..*)$/.test(e.name) || rel === "gen" || fs.existsSync(path.join(root, rel, "package.json"));
    return e.isDirectory() && !skip ? packageCode(root, rel) : [];
  }).sort();
}

/** Only the driver's body is checked: other journeys in the same file may test generated parsers directly. */
function conformanceImports(root: string): string[] {
  const problems: string[] = [];
  for (const file of packageCode(root)) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    if (!text.includes(".conformance.ts")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const calls = new Set<string>();
    const namespaces = new Set<string>();
    const oracle = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause || statement.importClause.isTypeOnly) continue;
      const module = statement.moduleSpecifier.text;
      const bindings = statement.importClause.namedBindings;
      if (module.endsWith(".conformance.ts")) {
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements)
          if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === "conformance") calls.add(element.name.text);
      } else if (/\bgen\/[^/]+\.(?:ts|effect\.vibe)$/.test(module) && !module.endsWith("/_conformance.ts")) {
        // The Effect face of a generated module is the same oracle; its typed failures are not.
        if (statement.importClause.name) oracle.add(statement.importClause.name.text);
        if (bindings && ts.isNamespaceImport(bindings)) oracle.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements)
          if (!element.isTypeOnly && !FAILURES.includes(element.propertyName?.text ?? element.name.text)) oracle.add(element.name.text);
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && calls.has(node.expression.text)
        || ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && namespaces.has(node.expression.expression.text) && node.expression.name.text === "conformance")) {
        const inspect = (inside: ts.Node) => {
          if (ts.isIdentifier(inside) && oracle.has(inside.text)) problems.push(`${file}:${source.getLineAndCharacterOfPosition(inside.getStart(source)).line + 1}: driver uses generated ${inside.text}`);
          inside.forEachChild(inspect);
        };
        node.arguments[0]?.forEachChild(inspect);
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  return [...new Set(problems)];
}

/** The package manager a package declares, or whose lock file sits in it or a directory above it, up to the repository or workspace root. */
function packageManager(root: string): string {
  const locks: Record<string, string> = { "pnpm-lock.yaml": "pnpm", "bun.lock": "bun", "bun.lockb": "bun", "yarn.lock": "yarn", "package-lock.json": "npm" };
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const pkg = manifest(dir);
    if (pkg.packageManager) return pkg.packageManager.split("@")[0];
    const lock = Object.keys(locks).find((f) => fs.existsSync(path.join(dir, f)));
    if (lock) return locks[lock];
    if (pkg.workspaces || fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) return "npm";
  }
}
