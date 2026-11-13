import fs from "node:fs";
import path from "node:path";
import { sha, writeWhole } from "./util.ts";
import { dafnyVersion, solver } from "./prove.ts";

/**
 * What a remembered result of one stage was produced by: a different Quint, Node or version of these tools must not
 * reuse a model or a simulation, and a proof also depends on LemmaScript, Dafny and the prover's own code. Each stage
 * has its own, so that a change that matters only to the proof (prove.ts, Dafny, LemmaScript) does not simulate
 * everything again. The part of the proof library a proof file calls (prove.ts, `libraryFor`) is part of its unit's key.
 */
const toolchains = new Map<string, Promise<string>>();
function toolchainId(stage: "model" | "simulate" | "prove" | "tests"): Promise<string> {
  let id = toolchains.get(stage);
  if (id) return id;
  toolchains.set(stage, (id = (async () => {
    const version = (dep: string) => {
      for (let dir = import.meta.dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
        const file = path.join(dir, "node_modules", dep, "package.json");
        if (fs.existsSync(file)) return `${dep}@${JSON.parse(fs.readFileSync(file, "utf8")).version}`;
      }
      return dep;
    };
    // The tools' own scripts, as source or as built: this directory and gen/, never the projects below it (examples,
    // Studio), whose checks rewrite their gen/ while this one reads. Only the prover's own file is left out of what a
    // model or simulation depends on: anything else may be used by both.
    const ext = path.extname(import.meta.filename);
    const own = (f: string) => f.endsWith(ext) && f !== `selftest${ext}` && (stage === "prove" || f !== `prove${ext}`);
    const tools = ["", "gen"].flatMap((dir) => fs.readdirSync(path.join(import.meta.dirname, dir)).map((f) => path.join(dir, f))).filter(own).sort()
      .map((f) => `${f}\0${fs.readFileSync(path.join(import.meta.dirname, f), "utf8")}`);
    const parts = [stage, version("@informalsystems/quint"), `node@${process.versions.node}`, sha(...tools).slice(0, 12)];
    if (stage === "prove") {
      const z3 = await solver();
      parts.push(version("lemmascript"), `dafny@${(await dafnyVersion()).version ?? "none"}`, `z3@${z3.version}:${z3.path}`);
    }
    return parts.join(" ");
  })()));
  // A failed probe is not remembered: the next check probes again.
  id.catch(() => toolchains.delete(stage));
  return id;
}

/** The remembered results of one check: whether it may read them, and every entry it read or wrote. */
export interface Memory { root: string; fresh: boolean; used: Set<string> }
/** An entry of `.spec-cache`. */
interface Entry { name: string; file: string }
const cacheDir = (root: string) => path.join(root, ".spec-cache");
export async function entry(root: string, stage: "model" | "simulate" | "prove" | "tests", key: string[]): Promise<Entry> {
  const name = `${stage}-${sha(await toolchainId(stage), ...key).slice(0, 24)}.json`;
  return { name, file: path.join(cacheDir(root), name) };
}
/** What an entry holds, or undefined. An entry that cannot be read, cut short by a kill or a full disk, is deleted and is a miss. */
export function recall<T>(memory: Memory, { name, file }: Entry): T | undefined {
  memory.used.add(name);
  if (memory.fresh) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    fs.rmSync(file, { force: true });
    return undefined;
  }
}
export function store(memory: Memory, { name, file }: Entry, value: unknown) {
  memory.used.add(name);
  writeWhole(file, JSON.stringify(value));
}

/**
 * `produce()`, or what it returned the last time for the same key, if that was
 * worth keeping. This is what keeps a check proportional to what changed. The
 * cache is a convenience: `accept` never reads it. Every entry read or written is recorded as used, so that a
 * full check can delete the ones no longer used.
 */
export async function remembered<T>(memory: Memory, at: Entry | Promise<Entry>, produce: () => T | Promise<T>, keep: (result: T) => boolean): Promise<T> {
  const e = await at;
  const known = recall<T>(memory, e);
  if (known !== undefined) return known;
  const result = await produce();
  if (keep(result)) store(memory, e, result);
  return result;
}

/** Drop entries no stage of this completed check used. */
export function collectGarbage(memory: Memory) {
  for (const name of fs.readdirSync(cacheDir(memory.root)))
    if (name !== "lock" && !memory.used.has(name)) fs.rmSync(path.join(cacheDir(memory.root), name), { recursive: true, force: true });
}
