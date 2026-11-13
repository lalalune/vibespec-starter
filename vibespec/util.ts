import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { exec } from "./prove.ts";
import type { Spec, Rule } from "./parse.ts";
import ts from "typescript";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** A hash of several texts, in which no two lists of texts give the same input. */
export const sha = (...parts: string[]) => digest(JSON.stringify(parts));
export const short = (text: string) => digest(text).slice(0, 12);
export const indent = (s: string, by = 6) => s.split("\n").map((l) => " ".repeat(by) + l).join("\n");

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

/**
 * `text` with `\r\n` read as `\n`, or a refusal naming the file and line if it holds NUL or a line break other than
 * `\n`. Quint, TypeScript, Dafny and these tools do not all agree on where a line ends at `\r`, `\v`, `\f`, U+0085,
 * U+2028 or U+2029, so a reviewer could see lines that differ from what a compiler reads, and prose could end a
 * comment early. No source needs NUL.
 */
export function plainText(file: string, text: string): string {
  const plain = text.replace(/\r\n/g, "\n");
  const lineOf = (at: number) => plain.slice(0, at).split("\n").length;
  const nul = plain.indexOf("\0");
  if (nul >= 0) throw new Error(`${file}:${lineOf(nul)}: NUL characters are not allowed`);
  const odd = plain.search(/[\r\v\f\u0085\u2028\u2029]/);
  if (odd >= 0) throw new Error(`${file}:${lineOf(odd)}: a line break other than \\n; save the file with plain line endings`);
  return plain;
}

export interface SrcFile { file: string; code: string; ts: boolean }
/** Every such file, read once: a check proves and reviews the same text, even if a file changes while it runs. */
export function readSrc(root: string): SrcFile[] {
  const src = path.join(root, "src");
  const files = filesUnder(root, "src").map((f) => f.slice(4)).filter((f) => /\.(?:[mc]?ts|tsx|[mc]?jsx?)$/.test(f));
  return files.map((f) => ({ file: f, code: fs.readFileSync(path.join(src, f), "utf8"), ts: /\.ts$/.test(f) })).filter((u) => u.code.includes("//@"));
}
/** Compatibility view of the verified or unsupported source files. */
export function srcUnits(root: string, other = false): { file: string; code: string }[] {
  return readSrc(root).filter((u) => other ? !u.ts : u.ts).map(({ file, code }) => ({ file, code }));
}

/** The tests stage: citations that name nothing, then the package's own tests; each result as `report` takes it. */
export async function tests(root: string, specs: Spec[]): Promise<[boolean, "tests", string, string?, string?][]> {
  const said: [boolean, "tests", string, string?, string?][] = [];
  try {
    const dangling = danglingCitations(root, specs);
    if (dangling.length) said.push([false, "tests", `${dangling.length} citations name no story or rule of the spec`, indent(dangling.join("\n"))]);
    const directOracle = conformanceImports(root);
    if (directOracle.length) said.push([false, "tests", "conformance drivers must reach the application, not call the generated oracle", indent(directOracle.join("\n"))]);
    // The package's own tests, in whatever runner it chose (AGENTS.md, "Tests"): its `test` script, or else
    // Node's on test/**/*.test.ts. The placeholder `npm init` writes is no script.
    const pkg = fs.existsSync(path.join(root, "package.json")) ? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) : {};
    const script = /no test specified/.test(pkg.scripts?.test ?? "") ? undefined : pkg.scripts?.test;
    const files = filesUnder(root, "test").filter((f) => f.endsWith(".test.ts"));
    const [command, args] = script ? [packageManager(root), ["run", "test"]] : [process.execPath, ["--test", ...files]];
    if (script || files.length) {
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
  const heading = (s: Spec, r: Rule) => r.key.slice((s.stories.findLast((t) => t.line < r.line)?.title ?? "").length + 3);
  const names = (s: Spec, h: string) => s.stories.some((t) => t.title === h) || s.rules.some((r) => heading(s, r) === h);
  return packageCode(root).flatMap((f) =>
    fs.readFileSync(path.join(root, f), "utf8").split("\n").flatMap((line, i) =>
      [...line.matchAll(/(?<![\w/.-])(spec\/(?:[A-Za-z0-9]+\/)*[A-Za-z0-9]+\.md), "([^"]+)"/g)]
        .filter(([, file, h]) => !specs.some((s) => s.file === file && names(s, h)))
        .map(([cited]) => `${f}:${i + 1}  ${cited}`)));
}

export function packageCode(root: string, dir = ""): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isFile()) return /\.[cm]?[jt]sx?$/.test(e.name) ? [rel] : [];
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
      } else if (/\bgen\/[^/]+\.ts$/.test(module) && !module.endsWith("/_conformance.ts")) {
        if (statement.importClause.name) oracle.add(statement.importClause.name.text);
        if (bindings && ts.isNamespaceImport(bindings)) oracle.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if (!element.isTypeOnly) oracle.add(element.name.text);
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
    const pkg = fs.existsSync(path.join(dir, "package.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) : {};
    if (pkg.packageManager) return pkg.packageManager.split("@")[0];
    const lock = Object.keys(locks).find((f) => fs.existsSync(path.join(dir, f)));
    if (lock) return locks[lock];
    if (pkg.workspaces || fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) return "npm";
  }
}
