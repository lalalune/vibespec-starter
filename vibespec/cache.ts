import fs from "node:fs";
import path from "node:path";
import { sha } from "./util.ts";
import { solver } from "./prove.ts";
import { dafnyVersion } from "./run.ts";

/** What a remembered result of one stage was produced by; the proof library is in each proof's key (spec.ts, provingAll). */
const toolchains = new Map<string, Promise<string>>();
function toolchainId(stage: "model" | "simulate" | "prove"): Promise<string> {
  let id = toolchains.get(stage);
  if (!id) toolchains.set(stage, (id = (async () => {
    const version = (dep: string) => {
      for (let dir = import.meta.dirname; dir !== path.dirname(dir); dir = path.dirname(dir)) {
        const file = path.join(dir, "node_modules", dep, "package.json");
        if (fs.existsSync(file)) return `${dep}@${JSON.parse(fs.readFileSync(file, "utf8")).version}`;
      }
      return dep;
    };
    const ext = path.extname(import.meta.filename);
    const own = (f: string) => f.endsWith(ext) && f !== `selftest${ext}` && !["fixtures", "examples", "studio"].includes(f.split(path.sep)[0]) && (stage === "prove" || f !== `prove${ext}`);
    const tools = (fs.readdirSync(import.meta.dirname, { recursive: true }) as string[]).filter(own).sort().map((f) => `${f}\0${fs.readFileSync(path.join(import.meta.dirname, f), "utf8")}`);
    const parts = [stage, version("@informalsystems/quint"), `node@${process.versions.node}`, sha(...tools).slice(0, 12)];
    if (stage === "prove") {
      const z3 = await solver();
      parts.push(version("lemmascript"), `dafny@${(await dafnyVersion()).version ?? "none"}`, `z3@${z3.version}:${z3.path}`);
    }
    return parts.join(" ");
  })()));
  return id;
}

/** The remembered results of one check: whether it may read them, and every entry it read or wrote. */
export interface Memory { root: string; fresh: boolean; used: Set<string> }
/** An entry of `.spec-cache`. */
interface Entry { name: string; file: string }
const cacheDir = (root: string) => path.join(root, ".spec-cache");
export async function entry(root: string, stage: "model" | "simulate" | "prove", key: string[]): Promise<Entry> {
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
    const value = JSON.parse(text) as T;
    // collectGarbage
    try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* still a hit */ }
    return value;
  } catch {
    fs.rmSync(file, { force: true });
    return undefined;
  }
}
/** Write an entry whole or not at all: to a file of its own, then renamed into place. */
export function store(memory: Memory, { name, file }: Entry, value: unknown) {
  memory.used.add(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
  } catch (e) {
    fs.rmSync(temporary, { force: true });
    throw e;
  }
}

/** `produce()`, or what it returned the last time for the same key, if `keep` said it was worth keeping. */
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
