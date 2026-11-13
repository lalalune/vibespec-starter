import fs from "node:fs";
import path from "node:path";
import { LIST_HELPERS } from "./gen.ts";

export interface Rule { key: string; story: string; line: number; prose: string; code: string; defs: string[] }
/** A `##` heading: a story or another group of rules. Its prose is the text between the heading and its first rule. */
export interface Story { title: string; line: number; prose: string }
export interface SpecReference { target: string; line: number }
/** `meaning` is the Quint as written, with every line of prose blank: what a cache key may depend on. */
export interface Spec { name: string; file: string; preamble: string; rules: Rule[]; stories: Story[]; imports: string[]; references: SpecReference[]; links: string[]; qnt: string; meaning: string }

interface SpecImport { name: string; target?: string; line: number; column: number; pathLine?: number; pathColumn?: number; pathLength?: number }
const importSources = new WeakMap<Spec, SpecImport[]>();

/** Why a name cannot name a spec, or undefined if it can. */
export function badSpecName(name: string): string | undefined {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) return `a spec's file name becomes a module name, so it must look like \`order.md\` or \`orderBook.md\``;
}

/** The path supplies a unique module name; an index names the directory that owns it. */
export function specName(file: string): string {
  const parts = file.replaceAll(path.sep, "/").replace(/^spec\//, "").replace(/\.md$/, "").split("/");
  for (const part of parts) {
    const bad = badSpecName(part);
    if (bad) throw new Error(`${file}: ${bad}`);
  }
  if (parts.length > 1 && parts.at(-1) === "index") parts.pop();
  return parts.join("__");
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
export function parseSpec(root: string, file: string, text = fs.readFileSync(path.join(root, file), "utf8")): Spec {
  const name = specName(file);
  const rules: Rule[] = [];
  const stories: Story[] = [];
  const qnt: string[] = [];
  const meaning: string[] = [];
  const imports: string[] = [];
  const references: SpecReference[] = [];
  let preamble = "";
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
    if (!story && !rule && (fence || !/^#{2,3} /.test(text))) preamble += text + "\n";
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
    } else {
      if (!fence) {
        // A code span and an image are not navigation to another spec.
        const prose = text.replace(/(`+).*?\1/g, "");
        for (const link of prose.matchAll(/(?<!!)\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)) {
          const target = link[1] ?? link[2];
          if (!/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target) && (target.endsWith("/") || /\.md(?:[?#]|$)/.test(target) || !path.posix.extname(target)))
            references.push({ target, line: i + 1 });
        }
      }
      if (rule) rule.prose += text + "\n";
      else if (story) story.prose += text + "\n";
    }
    qnt.push(i === 0 ? `module ${name} { // ${text}` : text ? `// ${text}` : "");
    meaning.push(i === 0 ? `module ${name} {` : "");
  });
  if (fence?.quint && scan(block).mode) throw new Error(`${file}: a quint block is never closed, and a comment or string in it is still open`);
  try {
    const tangled = qnt.join("\n");
    const sources = importsOf(tangled);
    imports.push(...sources.map((source) => source.name));
    const spec = { name, file, preamble, rules, stories, imports, references, links: [], qnt: expandListHelpers(tangled) + "\n}\n", meaning: meaning.join("\n") };
    importSources.set(spec, sources);
    return spec;
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
function scan(text: string): { code: boolean[]; strings: Set<number>; mode: "" | '"' | "//" | "/*" } {
  const code: boolean[] = [];
  const strings = new Set<number>();
  let mode: "" | '"' | "//" | "/*" = "";
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (mode === "" && text[i] === '"') { strings.add(i); mode = '"'; }
    else if (mode === "" && two === "//") mode = "//";
    else if (mode === "" && two === "/*") { i++; mode = "/*"; }
    else if (mode === "") { code[i] = true; continue; }
    else if (mode === '"' && text[i] === "\\") i++;
    else if (mode === '"' && text[i] === '"') mode = "";
    else if (mode === "//" && text[i] === "\n") mode = "";
    else if (mode === "/*" && two === "*/") { i++; mode = ""; }
  }
  return { code, strings, mode: mode === "//" ? "" : mode };
}

/** Import tokens retain their source positions, including when comments or newlines separate them. */
function importsOf(text: string): SpecImport[] {
  const { code, strings } = scan(text);
  const tokens: { text: string; index: number }[] = [];
  const word = /[A-Za-z_]\w*|[.*]/y;
  for (let i = 0; i < text.length; i++) {
    if (strings.has(i)) {
      let end = i + 1;
      for (; end < text.length; end++) {
        if (text[end] === "\\") end++;
        else if (text[end] === '"') break;
      }
      tokens.push({ text: text.slice(i, end + 1), index: i });
      i = end;
    } else if (code[i]) {
      word.lastIndex = i;
      const token = word.exec(text);
      if (token) { tokens.push({ text: token[0], index: i }); i += token[0].length - 1; }
    }
  }
  const position = (offset: number) => ({ line: text.slice(0, offset).split("\n").length, column: offset - text.lastIndexOf("\n", offset - 1) - 1 });
  return tokens.flatMap((token, i) => {
    if (token.text !== "import" || !code[token.index]) return [];
    const name = tokens[i + 1];
    if (!name || !/^[A-Za-z_]\w*$/.test(name.text)) return [];
    const from = i + ([".", "as"].includes(tokens[i + 2]?.text) ? 4 : 2);
    const path = tokens[from + 1];
    const target = tokens[from]?.text === "from" && path && strings.has(path.index) ? path : undefined;
    const at = target && position(target.index);
    return [{ name: name.text, ...position(name.index), ...(target && at ? { target: JSON.parse(target.text) as string, pathLine: at.line, pathColumn: at.column, pathLength: target.text.length } : {}) }];
  });
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

/** All Markdown sources under spec/, including children, without parsing their unfinished text. */
export function specFiles(root: string): string[] {
  const dir = path.join(root, "spec");
  const files: string[] = [];
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${path.relative(root, file)}: specs and their directories cannot be symbolic links`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.relative(root, file).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("spec/: the spec directory cannot be a symbolic link");
    walk(dir);
  }
  return files;
}

/** Every spec, with each one after the specs it imports. `texts` can be a Studio snapshot. */
export function readSpecs(root: string, texts?: Record<string, string>): Spec[] {
  const files = texts ? Object.keys(texts).sort() : specFiles(root);
  if (!files.length) throw new Error(`there are no specs: ${path.join(root, "spec")} holds no .md file`);
  const all = files.map((f) => parseSpec(root, f, texts?.[f]));
  const byFile = new Map(all.map((s) => [s.file, s]));
  const byName = new Map<string, Spec>();
  for (const spec of all) {
    const previous = byName.get(spec.name);
    if (previous) throw new Error(`${previous.file} and ${spec.file} have the same module name ${spec.name}; keep only one`);
    byName.set(spec.name, spec);
  }
  const resolve = (spec: Spec, target: string, line: number): Spec => {
    const fail = (reason: string): never => { throw new Error(`${spec.file}:${line}: ${target}: ${reason}`); };
    let link: string;
    try { link = decodeURIComponent(target.split(/[?#]/, 1)[0]); } catch { return fail("invalid path encoding"); }
    if (!link || link.includes("\\") || link.includes("\0") || path.posix.isAbsolute(link) || /^[a-z][a-z0-9+.-]*:/i.test(link)) return fail("use a relative path within spec/");
    const dest = path.posix.normalize(path.posix.join(path.posix.dirname(spec.file), link)).replace(/\/$/, "");
    if (dest !== "spec" && !dest.startsWith("spec/")) return fail("the target must stay within spec/");
    const candidates = path.posix.extname(dest) ? [dest] : [`${dest}.md`, `${dest}/index.md`];
    const found = candidates.map((f) => byFile.get(f)).filter((s) => s !== undefined);
    if (found.length !== 1) return fail(found.length ? "the path is ambiguous: name the .md file" : "no spec at this path (a directory needs index.md)");
    return found[0];
  };
  for (const spec of all) {
    const qnt = spec.qnt.split("\n");
    const meaning = spec.meaning.split("\n");
    const replacements: { line: number; column: number; length: number; value: string }[] = [];
    spec.imports = (importSources.get(spec) ?? []).map((imported) => {
      if (!imported.target) throw new Error(`${spec.file}:${imported.line}: import ${imported.name} needs a relative from path`);
      const dep = resolve(spec, imported.target, imported.line);
      replacements.push({ line: imported.pathLine!, column: imported.pathColumn!, length: imported.pathLength!, value: `"./${dep.name}"` },
        { line: imported.line, column: imported.column, length: imported.name.length, value: dep.name });
      return dep.name;
    });
    for (const { line, column, length, value } of replacements.sort((a, b) => b.line - a.line || b.column - a.column))
      for (const lines of [qnt, meaning]) lines[line - 1] = lines[line - 1].slice(0, column) + value + lines[line - 1].slice(column + length);
    spec.qnt = qnt.join("\n");
    spec.meaning = meaning.join("\n");
    spec.links = [...new Set(spec.references.map(({ target, line }) => resolve(spec, target, line).file))];
  }
  const ordered: Spec[] = [];
  const visit = (spec: Spec, trail: string[]) => {
    if (ordered.includes(spec)) return;
    if (trail.includes(spec.name)) throw new Error(`specs import each other in a circle: ${[...trail, spec.name].join(" -> ")}`);
    for (const i of spec.imports) {
      visit(byName.get(i)!, [...trail, spec.name]);
    }
    ordered.push(spec);
  };
  all.forEach((s) => visit(s, []));
  return ordered;
}
