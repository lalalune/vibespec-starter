import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { exec } from "./prove.ts";
import { entry, recall, store, type Memory } from "./cache.ts";
import type { Spec, Rule } from "./parse.ts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** A hash of several texts, in which no two lists of texts give the same input. */
export const sha = (...parts: string[]) => digest(JSON.stringify(parts));
export const short = (text: string) => digest(text).slice(0, 12);
export const indent = (s: string, by = 6) => s.split("\n").map((l) => " ".repeat(by) + l).join("\n");

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
  const files = fs.existsSync(src) ? (fs.readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.(?:[mc]?ts|tsx|[mc]?jsx?)$/.test(f)).sort() : [];
  return files.map((f) => ({ file: f, code: fs.readFileSync(path.join(src, f), "utf8"), ts: /\.ts$/.test(f) })).filter((u) => u.code.includes("//@"));
}
/** Compatibility view of the verified or unsupported source files. */
export function srcUnits(root: string, other = false): { file: string; code: string }[] {
  return readSrc(root).filter((u) => other ? !u.ts : u.ts).map(({ file, code }) => ({ file, code }));
}

/** The package's own code: what the tests stage reads. Build output and packages nested inside it, which have specs of their own, are not read. */
export function packageCode(root: string, dir = ""): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isFile()) return /\.[cm]?[jt]sx?$/.test(e.name) ? [rel] : [];
    const skip = /^(node_modules|dist|build|out|coverage|\..*)$/.test(e.name) || rel === "gen" || fs.existsSync(path.join(root, rel, "package.json"));
    return e.isDirectory() && !skip ? packageCode(root, rel) : [];
  }).sort();
}

/**
 * The tests stage (AGENTS.md, "Tests"): citations that name nothing and conformance drivers that import the spec's code
 * fail; the package's own tests run unless nothing they read has changed since they last passed; what the policy warns
 * of is listed.
 */
export async function tests(root: string, specs: Spec[], memory: Memory): Promise<[boolean, "tests", string, string?, string?][]> {
  const said: [boolean, "tests", string, string?, string?][] = [];
  try {
    const code = packageCode(root).map((file) => ({ file, text: fs.readFileSync(path.join(root, file), "utf8") }));
    const dangling = danglingCitations(root, specs, code);
    if (dangling.length) said.push([false, "tests", `${dangling.length} citations name no story or rule of the spec`, indent(dangling.join("\n"))]);
    // A driver reaches the application, never the spec: with the spec's code it could agree with the oracle without asking the application.
    const drivers = code.filter(({ text }) => /from\s+["'][^"']*gen\/\w+\.conformance\.ts["']/.test(text));
    const leaks = drivers.flatMap(({ file, text }) => [...text.matchAll(/import\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']*gen\/\w+\.ts)["']/g)]
      .filter(([, names]) => !/^\{[^}]*\}$/.test(names.trim()) || names.replace(/[{}]/g, "").split(",").some((n) => n.trim() && !n.trim().startsWith("type ")))
      .map(([m]) => `${file}  ${m.replace(/\s+/g, " ")}`));
    if (leaks.length) said.push([false, "tests", `${leaks.length} conformance tests import the spec's code; a driver may import its types only`, indent(leaks.join("\n"))]);
    // The package's own tests, in whatever runner it chose (AGENTS.md, "Tests"): its `test` script, or else
    // Node's on test/**/*.test.ts. The placeholder `npm init` writes is no script.
    const pkg = fs.existsSync(path.join(root, "package.json")) ? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) : {};
    const script = /no test specified/.test(pkg.scripts?.test ?? "") ? undefined : pkg.scripts?.test;
    const files = fs.existsSync(path.join(root, "test")) ? (fs.readdirSync(path.join(root, "test"), { recursive: true }) as string[]).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`) : [];
    const [command, args] = script ? [packageManager(root), ["run", "test"]] : [process.execPath, ["--test", ...files]];
    const where = script ? `${command} run test` : "test/";
    // A pass is remembered against everything the tests can read of the package; SPEC_NO_CACHE runs them again, as
    // tests of outside services need (AGENTS.md, "Tests").
    const read = (f: string) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : "");
    const generated = fs.existsSync(path.join(root, "gen")) ? fs.readdirSync(path.join(root, "gen")).filter((f) => f.endsWith(".ts")).sort().map((f) => `gen/${f}`) : [];
    const inputs = [...code.map(({ file, text }) => `${file}\0${text}`), ...[...generated, "package.json", "tsconfig.json", "package-lock.json", "pnpm-lock.yaml", "bun.lock", "yarn.lock"].map((f) => `${f}\0${read(f)}`)];
    const at = await entry(root, "tests", [command, ...args, ...inputs]);
    if (script || files.length) {
      if (recall<true>(memory, at)) said.push([true, "tests", "pass: nothing they read has changed since they last passed", "", where]);
      else {
        const { NODE_TEST_CONTEXT: _, ...env } = process.env;
        const t = await exec(command, args, root, { ...env, SPEC_TESTS: "1" });
        const failures = t.stdout.includes("✖ failing tests:") ? t.stdout.slice(t.stdout.indexOf("✖ failing tests:")) : t.stdout.split("\n").slice(-80).join("\n");
        const ok = t.status === 0 && !t.stopped;
        if (ok) store(memory, at, true);
        said.push([ok, "tests", ok ? "pass" : "fail", indent((failures + t.stderr + (t.stopped ? `\n${t.stopped}` : "")).trim()), where]);
      }
    }
    // What the policy warns of, without failing: state machines no test checks the application against, test files
    // past the size to consolidate at, snapshots, and mocks of the package's own modules.
    const unchecked = specs.filter((s) => fs.existsSync(path.join(root, "gen", `${s.name}.conformance.ts`)) && !drivers.some(({ text }) => text.includes(`gen/${s.name}.conformance.ts`)));
    const isTest = (f: string) => /(^|\/)(test|tests|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
    const notes = [
      ...(unchecked.length ? [`no test checks the application against ${unchecked.map((s) => s.file).join(", ")} (AGENTS.md, "Conformance")`] : []),
      ...code.filter(({ file, text }) => isTest(file) && text.split("\n").length > 15_000).map(({ file, text }) => `${file} has ${text.split("\n").length} lines: consolidate and simplify it`),
      ...code.filter(({ file, text }) => isTest(file) && /\.toMatch(Inline)?Snapshot\(|\bassert\.snapshot\(/.test(text)).map(({ file }) => `${file} asserts a snapshot`),
      ...code.filter(({ file, text }) => isTest(file) && /\b(?:vi|jest)\.mock\(\s*["']\.{1,2}\/|\bmock\.module\(\s*["']\.{1,2}\//.test(text)).map(({ file }) => `${file} mocks the package's own code`),
    ];
    if (notes.length) said.push([true, "tests", `note: ${notes.join("; ")}`]);
  } catch (e) {
    said.push([false, "tests", (e as Error).message]);
  }
  return said;
}

/** Every `spec/<name>.md, "<heading>"` in the package's code whose heading is no story or rule of that spec, as `file:line  citation`. */
export function danglingCitations(root: string, specs: Spec[], code = packageCode(root).map((file) => ({ file, text: fs.readFileSync(path.join(root, file), "utf8") }))): string[] {
  const heading = (s: Spec, r: Rule) => r.key.slice((s.stories.findLast((t) => t.line < r.line)?.title ?? "").length + 3);
  const names = (s: Spec, h: string) => s.stories.some((t) => t.title === h) || s.rules.some((r) => heading(s, r) === h);
  return code.flatMap(({ file: f, text }) =>
    text.split("\n").flatMap((line, i) =>
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
