// What every part of the tools shares: errors, hashes, files, running the toolchain's programs, and what a stage of
// `check` reports (spec.ts).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const fail = (msg: string): never => { throw new Error(msg); };

export const indent = (s: string, by = 6) => s.split("\n").map((l) => " ".repeat(by) + l).join("\n");

/** The last lines of a program's output, on one line: what to quote when it gave no verdict. */
export const tail = (out: string) => out.trim().split("\n").slice(-3).join(" / ");

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
/** A hash of several texts, in which no two lists of texts give the same input. */
export const sha = (...parts: string[]) => digest(JSON.stringify(parts));
export const short = (text: string) => digest(text).slice(0, 12);

/** `name` in `from` or the nearest directory above it that has one, or undefined. */
export function findUp(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    if (dir === path.dirname(dir)) return undefined;
  }
}

/** The files under `dir`, at any depth, whose path relative to it matches `kind`, sorted; none if `dir` does not exist. */
export const filesUnder = (dir: string, kind: RegExp): string[] =>
  fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => kind.test(f)).sort() : [];

/**
 * Write a ledger the tools keep (spec/*.lock.json), one entry per line so that a diff shows exactly what was recorded,
 * or delete it if there is nothing to record.
 */
export function writeLock(file: string, entries: string[]) {
  if (entries.length) fs.writeFileSync(file, `{\n${entries.join(",\n")}\n}\n`);
  else fs.rmSync(file, { force: true });
}

// --- what a stage of `check` found ----------------------------------------------------

/**
 * What one stage found: about one spec, one proof unit, or the project as a whole. `where` is the spec, unit or file
 * it is about. A result of the stage "skipped" names stages that did not run, and is not a failure in itself.
 */
export interface Result { ok: boolean; stage: "model" | "always" | "sometimes" | "replay" | "types" | "proof" | "tests" | "review" | "skipped"; summary: string; detail: string; where?: string }
/** How a stage reports a result as it is found; the detail of one that passed is dropped unless `keepDetail`. */
export type Report = (ok: boolean, stage: Result["stage"], summary: string, detail?: string, where?: string, keepDetail?: boolean) => void;
/** What a check records besides checking: reconciled reviews, or obligations accepted as simulated only (spec.ts `check`). */
export type Accept = false | "reviews" | "unproved";
export const show = ({ ok, stage, summary, detail }: Result) => `${stage === "skipped" ? "-" : ok ? "✓" : "✗"} ${stage.padEnd(9)} ${summary}${detail ? "\n" + detail.trimEnd() : ""}`;

// --- running tools -------------------------------------------------------------

const WINDOWS = process.platform === "win32";
/** The most output a tool may write before it is stopped. */
const OUTPUT_LIMIT = 1 << 28;
/** How long a tool may run before it is stopped: long enough that only a tool that hangs is stopped. */
const TOOL_TIMEOUT = 60 * 60 * 1000;

/** An executable from the toolchain's dependencies, wherever npm put it: beside the tools, or in the project. */
export function bin(cmd: string, root: string): string {
  // On Windows npm installs a `.cmd` shim beside the extensionless shell script, and only the shim runs there.
  const name = path.join("node_modules/.bin", WINDOWS ? `${cmd}.cmd` : cmd);
  return findUp(path.join(import.meta.dirname, ".."), name) ?? findUp(root, name) ?? fail(`${cmd} is not installed; run npm install`);
}

/**
 * Run a tool to the end and return what it wrote. A tool that cannot be started is an error; one that writes too
 * much or runs too long is stopped, and its output says so.
 */
export function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const exe = cmd === "dafny" ? cmd : bin(cmd, cwd);
  // A .cmd shim needs a shell, and then every argument is quoted for cmd.exe.
  const shell = WINDOWS && exe.endsWith(".cmd");
  const quote = (a: string) => (a === "" || /[\s"&|<>^%()!,;=]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const r = shell
    ? spawnSync(quote(exe), args.map(quote), { cwd, encoding: "utf8", maxBuffer: OUTPUT_LIMIT, timeout: TOOL_TIMEOUT, shell: true })
    : spawnSync(exe, args, { cwd, encoding: "utf8", maxBuffer: OUTPUT_LIMIT, timeout: TOOL_TIMEOUT });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const stopped = code === "ENOBUFS" ? `${cmd} wrote more than ${OUTPUT_LIMIT / 2 ** 20} MB of output and was stopped`
    : code === "ETIMEDOUT" ? `${cmd} ran for more than ${TOOL_TIMEOUT / 60_000} minutes and was stopped`
    : undefined;
  if (r.error && !stopped) throw new Error(`${cmd} could not be run (${exe}): ${r.error.message}${cmd === "dafny" ? "; the proof stage needs Dafny 4.11 on the PATH" : "; run npm install"}`);
  return { ok: r.status === 0 && !stopped, out: `${r.stdout ?? ""}${r.stderr ?? ""}${stopped ? `\n${stopped}\n` : ""}` };
}

/** Overlapping runs, at most one per core across everything in this process (several checks at once included). */
const slots = { free: Math.max(1, os.availableParallelism()), waiting: [] as (() => void)[] };
const acquire = () => (slots.free > 0 ? (slots.free--, Promise.resolve()) : new Promise<void>((go) => slots.waiting.push(go)));
const release = () => { const next = slots.waiting.shift(); if (next) next(); else slots.free++; };

/** `run`, without blocking, so that independent runs can overlap. */
export async function runAsync(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const exe = cmd === "dafny" ? cmd : bin(cmd, cwd);
  await acquire();
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (out += d));
    let done = false;
    const finish = (r: { ok: boolean; out: string }) => { if (!done) { done = true; release(); resolve(r); } };
    child.on("error", (e) => finish({ ok: false, out: out + e }));
    child.on("close", (status) => finish({ ok: status === 0, out }));
  });
}
