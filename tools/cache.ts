// Remembered results in .spec-cache/: what keeps a check proportional to what changed (docs/roadmap.md, "Speed").

import fs from "node:fs";
import path from "node:path";
import { dafnyVersion, LIB_FILE } from "./prove.ts";
import { filesUnder, findUp, sha } from "./util.ts";

/** What a remembered result was produced by: a different Quint, LemmaScript, Dafny or version of these tools must not reuse it. */
let toolchain: string | undefined;
function toolchainId(): string {
  if (toolchain) return toolchain;
  const version = (dep: string) => {
    const file = findUp(import.meta.dirname, path.join("node_modules", dep, "package.json"));
    return file ? `${dep}@${JSON.parse(fs.readFileSync(file, "utf8")).version}` : dep;
  };
  // Every file of the tools themselves, as source or as built, and the proof library; the self-test and its fixtures are not part of them.
  const own = filesUnder(import.meta.dirname, /./).filter((f) => f.endsWith(path.extname(import.meta.filename)) && !f.startsWith("selftest") && !f.startsWith("fixtures"));
  const tools = [...own.map((f) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8")), fs.readFileSync(LIB_FILE, "utf8")];
  return (toolchain = [version("@informalsystems/quint"), version("lemmascript"), `dafny@${dafnyVersion().version ?? "none"}`, sha(...tools).slice(0, 12)].join(" "));
}

/**
 * `produce()`, or what it returned the last time for the same key, if that was
 * worth keeping. The cache is a convenience: `accept` never reads it (`fresh`).
 * `used` hears of every entry read or written, so that a full check can delete
 * the ones no longer used.
 */
export async function remembered<T>(root: string, fresh: boolean, used: Set<string>, key: string[], produce: () => T | Promise<T>, keep: (result: T) => boolean): Promise<T> {
  const name = `${sha(toolchainId(), ...key).slice(0, 24)}.json`;
  const file = path.join(root, ".spec-cache", name);
  used.add(name);
  if (!fresh && !process.env.SPEC_NO_CACHE && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const result = await produce();
  if (keep(result)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result));
  }
  return result;
}
