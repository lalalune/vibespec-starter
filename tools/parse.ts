import fs from "node:fs";
import path from "node:path";
import { LIST_HELPERS } from "./gen.ts";

export interface Rule { key: string; story: string; line: number; prose: string; code: string; defs: string[] }
/** A `##` heading: a story or another group of rules. Its prose is the text between the heading and its first rule. */
export interface Story { title: string; line: number; prose: string }
/** `meaning` is the Quint as written, with every line of prose blank: what a cache key may depend on. */
export interface Spec { name: string; file: string; rules: Rule[]; stories: Story[]; imports: string[]; qnt: string; meaning: string }

/** The specs that ship with the tools (std/net.md); a spec imports one as it would one of its own. */
const PACKAGE = path.join(import.meta.dirname, "..");
export const isStd = (file: string) => file.startsWith("std/");
/** Where a spec's file, or its proof file, is: in the project, or in the package for a spec from std/. */
export const located = (root: string, file: string) => path.join(isStd(file) ? PACKAGE : root, file);

/** Why a name cannot name a spec, or undefined if it can. */
export function badSpecName(name: string): string | undefined {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) return `a spec's file name becomes a module name, so it must look like \`order.md\` or \`orderBook.md\``;
  // Their lock files would be the ledgers the tools keep beside the specs.
  if (name === "src" || name === "unproved") return `\`${name}\` cannot name a spec: spec/${name}.lock.json is a ledger the tools keep`;
}

/** What one line of a spec is: a story or rule heading, a fence that opens or closes, a line inside a fence, or prose. */
export type LineKind = "story" | "rule" | "open" | "open quint" | "close" | "quint" | "fenced" | "prose";

/**
 * Every line of a spec with what it is. A fence of any kind (``` or ~~~, of any length) closes only with a fence of
 * the same character at least as long and nothing after it; `##` and `###` inside a fence are not headings.
 */
export function scanSpec(text: string): { text: string; kind: LineKind }[] {
  let fence: { mark: string; quint: boolean } | undefined;
  return text.split("\n").map((text) => {
    const marker = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence && marker && marker[1][0] === fence.mark[0] && marker[1].length >= fence.mark.length && !marker[2].trim()) {
      fence = undefined;
      return { text, kind: "close" };
    }
    if (fence) return { text, kind: fence.quint ? "quint" : "fenced" };
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = { mark: marker[1], quint: marker[2].trim().split(/\s+/)[0] === "quint" };
      return { text, kind: fence.quint ? "open quint" : "open" };
    }
    return { text, kind: text.startsWith("## ") ? "story" : text.startsWith("### ") ? "rule" : "prose" };
  });
}

/**
 * A spec is Markdown. `##` starts a story (or any grouping), `###` starts a
 * rule, and the ```quint blocks under a rule are its formal half. Tangling
 * keeps every line on its own line number, so Quint errors point into the
 * Markdown file. A fence of any other kind (``` or ~~~, of any length) is
 * prose, and closes only with a fence of the same character at least as long.
 */
export function parseSpec(root: string, file: string, text = fs.readFileSync(located(root, file), "utf8")): Spec {
  const name = path.basename(file, ".md");
  const bad = badSpecName(name);
  if (bad) throw new Error(`${file}: ${bad}`);
  const rules: Rule[] = [];
  const stories: Story[] = [];
  const qnt: string[] = [];
  const meaning: string[] = [];
  const imports: string[] = [];
  let story: Story | undefined;
  let rule: Rule | undefined;
  let fence: { mark: string; quint: boolean } | undefined;
  // The Quint of the block in progress, to check that no comment or string runs on past its end.
  let block = "";
  const source = text.replace(/\r\n/g, "\n");
  // Quint and Markdown may not agree on where a line ends at these, and prose could then end a comment early.
  const odd = source.search(/[\r\v\f\u0085\u2028\u2029]/);
  if (odd >= 0) throw new Error(`${file}:${source.slice(0, odd).split("\n").length}: a line break other than \\n; save the file with plain line endings`);
  source.split("\n").forEach((text, i) => {
    const marker = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
    const closes = fence && marker && marker[1][0] === fence.mark[0] && marker[1].length >= fence.mark.length && !marker[2].trim();
    if (closes) {
      // Prose is tangled as `//` comments, which is only safe if no comment or string runs on into it from the code.
      const open = fence!.quint ? scan(block).mode : "";
      if (open) throw new Error(`${file}:${i + 1}: a ${open === '"' ? "string" : "comment"} is still open at the end of this quint block; close it inside the block`);
      fence = undefined;
      block = "";
    } else if (fence?.quint) {
      block += text + "\n";
      meaning.push(text);
      rule!.code += text + "\n";
      const def = text.match(/^\s*(?:pure\s+)?(?:def|val|type)\s+(\w+)/);
      if (def) rule!.defs.push(def[1]);
      const dep = text.match(/^\s*import\s+(\w+)\b/);
      if (dep) imports.push(dep[1]);
      qnt.push(text);
      return;
    } else if (!fence && marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      const quint = marker[2].trim().split(/\s+/)[0] === "quint";
      if (quint && !rule) throw new Error(`${file}:${i + 1}: a quint block must sit under a ### rule`);
      fence = { mark: marker[1], quint };
    } else if (!fence && text.startsWith("## ")) {
      story = { title: text.slice(3).trim(), line: i + 1, prose: "" };
      stories.push(story);
      rule = undefined;
    } else if (!fence && text.startsWith("### ")) {
      rule = { key: `${story?.title ?? ""} / ${text.slice(4).trim()}`, story: story?.title ?? "", line: i + 1, prose: "", code: "", defs: [] };
      if (rules.some((r) => r.key === rule!.key)) throw new Error(`${file}:${i + 1}: duplicate rule "${rule.key}"`);
      rules.push(rule);
    } else if (rule) rule.prose += text + "\n";
    else if (story) story.prose += text + "\n";
    qnt.push(i === 0 ? `module ${name} { // ${text}` : text ? `// ${text}` : "");
    meaning.push(i === 0 ? `module ${name} {` : "");
  });
  if (fence?.quint && scan(block).mode) throw new Error(`${file}: a quint block is never closed, and a comment or string in it is still open`);
  try {
    return { name, file, rules, stories, imports, qnt: expandListHelpers(qnt.join("\n")) + "\n}\n", meaning: meaning.join("\n") };
  } catch (e) {
    throw new Error(`${file}:${(e as Error).message}`);
  }
}

/**
 * Rewrite `xs.every(x => e)`, `.some`, `.listMap` and `.includes(v)` into Quint's
 * built-in `foldl`, in place and without moving a line (see LIST_HELPERS in
 * gen.ts for why). Strings and comments are left alone.
 */
/** Which characters of Quint are code, as opposed to part of a string or a comment, and what is still open at the end. */
function scan(text: string): { code: boolean[]; mode: "" | '"' | "//" | "/*" } {
  const code: boolean[] = [];
  let mode: "" | '"' | "//" | "/*" = "";
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (mode === "" && text[i] === '"') mode = '"';
    else if (mode === "" && two === "//") mode = "//";
    else if (mode === "" && two === "/*") { i++; mode = "/*"; }
    else if (mode === "") { code[i] = true; continue; }
    else if (mode === '"' && text[i] === "\\") i++;
    else if (mode === '"' && text[i] === '"') mode = "";
    else if (mode === "//" && text[i] === "\n") mode = "";
    else if (mode === "/*" && two === "*/") { i++; mode = ""; }
  }
  return { code, mode: mode === "//" ? "" : mode };
}

export function expandListHelpers(text: string): string {
  const { code } = scan(text);
  let count = 0;
  const expand = (from: number, to: number): string => {
    const call = /\.(every|some|includes|listMap)\(/g;
    let out = "";
    let at = from;
    call.lastIndex = from;
    for (let m; (m = call.exec(text)) && m.index < to; ) {
      if (!code[m.index]) continue;
      let end = call.lastIndex;
      for (let depth = 1; depth; end++) {
        if (end >= to) throw new Error(`${text.slice(0, m.index).split("\n").length}: no closing parenthesis for .${m[1]}(`);
        if (code[end] && text[end] === "(") depth++;
        else if (code[end] && text[end] === ")") depth--;
      }
      const arg = expand(call.lastIndex, end - 1);
      const n = count++;
      const acc = `std_${m[1]}_${n}`;
      const lambda = arg.match(/^\s*\(?\s*(\w+)\s*\)?\s*=>([\s\S]*)$/);
      const item = m[1] === "includes" || !lambda ? `std_x_${n}` : lambda[1];
      const body = m[1] === "includes" ? `${item} == (${arg})` : lambda ? lambda[2] : `${arg.trim()}(${item})`;
      out += `${text.slice(at, m.index)}.foldl(${LIST_HELPERS[m[1]].init}, (${acc}, ${item}) => ${LIST_HELPERS[m[1]].step(acc, body)})`;
      at = call.lastIndex = end;
    }
    return out + text.slice(at, to);
  };
  return expand(0, text.length);
}

/** Every spec, with each one after the specs it imports; an import that names no spec of the project names one in std/. */
export function readSpecs(root: string): Spec[] {
  const dir = path.join(root, "spec");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
  if (!files.length) throw new Error(`there are no specs: ${dir} holds no .md file`);
  const all = files.map((f) => parseSpec(root, path.join("spec", f)));
  const ordered: Spec[] = [];
  const fromStd = (name: string) => {
    if (!fs.existsSync(located(root, `std/${name}.md`))) return undefined;
    all.push(parseSpec(root, `std/${name}.md`));
    return all.at(-1);
  };
  const visit = (spec: Spec, trail: string[]) => {
    if (ordered.includes(spec)) return;
    if (trail.includes(spec.name)) throw new Error(`specs import each other in a circle: ${[...trail, spec.name].join(" -> ")}`);
    for (const i of spec.imports) {
      const dep = all.find((s) => s.name === i) ?? fromStd(i);
      if (!dep) throw new Error(`${spec.file} imports ${i}, but there is no spec/${i}.md`);
      visit(dep, [...trail, spec.name]);
    }
    ordered.push(spec);
  };
  all.forEach((s) => visit(s, []));
  return ordered;
}
