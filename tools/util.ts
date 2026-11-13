import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { exec } from "./prove.ts";
import type { Spec, Rule } from "./parse.ts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** A hash of several texts, in which no two lists of texts give the same input. */
export const sha = (...parts: string[]) => digest(JSON.stringify(parts));
export const short = (text: string) => digest(text).slice(0, 12);
export const indent = (s: string, by = 6) => s.split("\n").map((l) => " ".repeat(by) + l).join("\n");

export function srcUnits(root: string, other = false): { file: string; code: string }[] {
  const src = path.join(root, "src");
  const kind = other ? /\.(?:[mc]ts|tsx|[mc]?jsx?)$/ : /\.ts$/;
  const files = fs.existsSync(src) ? (fs.readdirSync(src, { recursive: true }) as string[]).filter((f) => kind.test(f)).sort() : [];
  return files.map((f) => ({ file: f, code: fs.readFileSync(path.join(src, f), "utf8") })).filter((u) => u.code.includes("//@"));
}

/** The tests stage: citations that name nothing, then the package's own tests; each result as `report` takes it. */
export async function tests(root: string, specs: Spec[]): Promise<[boolean, "tests", string, string?, string?][]> {
  const said: [boolean, "tests", string, string?, string?][] = [];
  try {
    const dangling = danglingCitations(root, specs);
    if (dangling.length) said.push([false, "tests", `${dangling.length} citations name no story or rule of the spec`, indent(dangling.join("\n"))]);
    // The package's own tests, in whatever runner it chose (AGENTS.md, "Tests"): its `test` script, or else
    // Node's on test/**/*.test.ts. The placeholder `npm init` writes is no script.
    const pkg = fs.existsSync(path.join(root, "package.json")) ? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) : {};
    const script = /no test specified/.test(pkg.scripts?.test ?? "") ? undefined : pkg.scripts?.test;
    const files = fs.existsSync(path.join(root, "test")) ? (fs.readdirSync(path.join(root, "test"), { recursive: true }) as string[]).filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`) : [];
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
      [...line.matchAll(/(?<![\w/.-])(spec\/(?:[A-Za-z0-9]+\/)*[A-Za-z0-9]+\.md), "([^"]+)"/g)]
        .filter(([, file, h]) => !specs.some((s) => s.file === file && names(s, h)))
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
