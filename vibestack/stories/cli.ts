#!/usr/bin/env node
// `node <tool>/stories/cli.ts gen [--watch] [--check] [--components <glob>...] [--out <dir>] [--cap <n>]`,
// run from the project whose components it reads.
import { watch } from "node:fs";
import { COMPONENTS, generator, watched } from "./emit.ts";

const argv = process.argv.slice(2);
/** The words after a flag, up to the next flag. */
const after = (flag: string) => {
  const at = argv.indexOf(flag);
  const end = argv.findIndex((word, i) => i > at && word.startsWith("--"));
  return at < 0 ? [] : argv.slice(at + 1, end < 0 ? undefined : end);
};
if (argv[0] !== "gen") {
  console.error("usage: stories gen [--watch] [--check] [--components <glob>...] [--out <dir>] [--cap <n>]");
  process.exit(2);
}

const root = process.cwd();
const run = generator({
  root,
  components: after("--components").length ? after("--components") : COMPONENTS,
  out: after("--out")[0],
  cap: Number(after("--cap")[0] ?? 12),
});
/** Brings the output up to date and says what changed; false when a component could not be given stories. */
function once(quiet = false): boolean {
  const start = performance.now();
  const { index, written, removed, analyzed, diagnostics } = run();
  const stories = index.components.reduce((sum, c) => sum + c.stories.length, 0);
  if (quiet && !analyzed && !removed.length) return true;
  console.log(`${index.components.length} components, ${stories} stories: ${analyzed} files analyzed, ${written.length} written, ${removed.length} removed in ${Math.round(performance.now() - start)} ms`);
  for (const line of diagnostics) console.error(`✗ ${line}`);
  return diagnostics.length === 0;
}

const ok = once();
if (argv.includes("--watch")) {
  let timer: NodeJS.Timeout | undefined;
  watch(root, { recursive: true }, (_, file) => {
    if (!file || !watched(file)) return;
    clearTimeout(timer);
    timer = setTimeout(once, 20, true);
  });
} else if (argv.includes("--check") && !ok) process.exit(1);
