// The studio's page: the shell around the outline (spec/outline.md) and the session (spec/index.md). Every edit to a
// spec is an outline event, applied only if `enabled` allows it; every action on the project is offered only if the
// session allows it. This file draws what they hold and turns clicks, keys and drags into their events.
import { enabled as allowed, type Event as SessionEvent, type Session } from "../gen/index.ts";
import { enabled, headingsAreSound, step, type Event as Edit, type Outline, type Rule, type Story } from "../gen/outline.ts";
import { bodyOf, itemsOf, nodeId, nodesOfOutline, ruleKey, SIGN, specOrder, storyKey, textBody, textOf, type Item } from "./markdown.ts";
// Types only: the page loads none of the server's or the tools' code.
import type { Result } from "../../spec.ts";
import type { JobView, Snapshot } from "./server.ts";

type SpecView = Snapshot["specs"][number];

// --- the working copy --------------------------------------------------------------------------------------

/** One spec as this page holds it: the outline being edited, and what it was when loaded (`base` is its hash on disk). */
interface Working { file: string; base: string | null; orig: string | null; was: Outline; outline: Outline; deleted: boolean }

const S = {
  snap: undefined as Snapshot | undefined,
  specs: [] as Working[],
  sel: new URLSearchParams(location.search).get("spec") ?? "",
  /** Which stories and rules are open, or being edited, as `<file>#<number>`; `<file>#head` is the title. */
  open: new Set<string>(),
  editing: new Set<string>(),
  /** The prose and Quint of each rule being edited, while it is edited. */
  items: new Map<string, Item[]>(),
  history: [] as string[],
  conflicts: [] as string[],
  publishing: false,
};
const ui = (file: string, id: number | "head") => `${file}#${id}`;

const working = (spec: SpecView): Working => ({ file: spec.file, base: spec.hash, orig: spec.text, was: spec.outline, outline: spec.outline, deleted: false });
/** The text a spec would be published as: as it was if nothing changed, tidied if something did. */
const publishedText = (spec: Working) => {
  if (spec.deleted) return null;
  const text = textOf(spec.outline);
  return text === spec.orig ? text : textOf(spec.outline, true);
};
const isDirty = (spec: Working) => spec.deleted || spec.orig === null || publishedText(spec) !== spec.orig;
const dirtySpecs = () => S.specs.filter(isDirty);
/** The session as this page sees it: the server's, and whether there is anything to publish. */
const session = (): Session => ({ ...S.snap!.session, unpublished: dirtySpecs().length > 0 });
const can = (event: SessionEvent) => !!S.snap && allowed(session(), event);

/** Whether a story or rule differs from what was loaded: new, edited, or somewhere else. */
function storyChanged(spec: Working, s: Story, i: number) {
  const was = spec.was.stories.findIndex((x) => x.id === s.id);
  return was < 0 || was !== i || spec.was.stories[was].title !== s.title || spec.was.stories[was].body !== s.body;
}
function ruleChanged(spec: Working, s: Story, r: Rule, j: number) {
  const home = spec.was.stories.find((x) => x.rules.some((y) => y.id === r.id));
  const was = home?.rules.findIndex((y) => y.id === r.id) ?? -1;
  return !home || home.id !== s.id || was !== j || home.rules[was].title !== r.title || home.rules[was].body !== r.body;
}

/** The specs on disk, with the ones this page changed kept, and those that changed on disk underneath them noted. */
function merge(snap: Snapshot, mine: Working[]): Working[] {
  const keys = (specs: Working[]) => new Map(specs.flatMap((w) => nodesOfOutline(w.file, w.outline).map((n) => [n.id, ui(w.file, (n.rule ?? n.story).id)] as const)));
  const before = keys(mine);
  const out: Working[] = [];
  S.conflicts = [];
  for (const d of mine) {
    if (!isDirty(d)) continue;
    if ((snap.specs.find((x) => x.file === d.file)?.hash ?? null) !== d.base) S.conflicts.push(d.file);
    out.push(d);
  }
  for (const f of snap.specs) if (!out.some((o) => o.file === f.file)) out.push(working(f));
  out.sort((a, b) => specOrder(a.file, b.file));
  // A story or rule stays open, or being edited, across a reload: by what it is called, since its number may change.
  const after = keys(out);
  const remap = (id: string) => {
    const key = [...before].find(([, v]) => v === id)?.[0];
    return key ? after.get(key) : id;
  };
  S.open = new Set([...S.open].flatMap((id) => remap(id) ?? []));
  S.editing = new Set([...S.editing].flatMap((id) => remap(id) ?? []));
  S.items = new Map([...S.items].flatMap(([id, v]) => { const to = remap(id); return to ? [[to, v] as const] : []; }));
  return out;
}

// --- server -------------------------------------------------------------------------------------------------

async function api(route: string, body?: unknown) {
  const res = await fetch(`/api/${route}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? res.statusText), { status: res.status, body: json });
  return json;
}

async function refresh(force = false) {
  if (S.publishing) return; // publishing refreshes once it is done
  const snap: Snapshot = await api("project");
  if (S.publishing) return;
  // Keep the working objects that the active editor's handlers close over until typing stops.
  const typing = doc().contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement!.tagName);
  const first = !S.snap;
  S.snap = snap;
  if (typing && !force && !first) { renderRail(); renderBuild(); return; }
  S.specs = merge(snap, S.specs);
  if (!S.specs.some((s) => s.file === S.sel)) S.sel = S.specs[0]?.file ?? "";
  render();
}

// --- small helpers -------------------------------------------------------------------------------------------

type Kid = Node | string | number | false | null | undefined | Kid[];
function h(tag: string, props: Record<string, any> = {}, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && typeof v !== "string") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of (kids as unknown[]).flat(Infinity) as Kid[]) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const doc = () => document.getElementById("doc")!;
const ICONS: Record<string, string> = {
  grip: "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01",
  chev: "M6 4l4 4-4 4",
  edit: "M10.5 3.5l2 2L6 12H4v-2z",
  trash: "M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8",
  plus: "M8 3.5v9M3.5 8h9",
  check: "M3.5 8.5l3 3 6-7",
  close: "M4 4l8 8M12 4l-8 8",
  play: "M5 3.5l7 4.5-7 4.5z",
  stop: "M4.5 4.5h7v7h-7z",
  open: "M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  up: "M8 12.5v-9M4.5 7L8 3.5 11.5 7",
  undo: "M5.5 4L3 6.5 5.5 9M3 6.5h6.5a3 3 0 010 6H7",
};
const icon = (name: string) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `<path d="${ICONS[name]}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  return svg;
};
const iconButton = (name: string, label: string, onclick: (e: MouseEvent) => void, cls = "", disabled = false) =>
  h("button", { class: `icon ${cls}`, type: "button", title: label, "aria-label": label, disabled, onclick: (e: MouseEvent) => { e.stopPropagation(); onclick(e); } }, icon(name));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, action?: { label: string; run: () => void }) {
  const el = document.getElementById("toast")!;
  el.replaceChildren(h("span", {}, text), action ? h("button", { type: "button", onclick: () => { action.run(); el.classList.remove("show"); } }, action.label) : "");
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), action ? 6000 : 2600);
}

/** Markdown, as far as specs use it: paragraphs, quotes, lists, code, emphasis and links to other specs. */
function markdown(text: string, file: string) {
  const inline = (s: string) => {
    let out = "", end = 0;
    for (const m of s.matchAll(/`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g)) {
      out += esc(s.slice(end, m.index));
      if (m[1]) out += `<code>${esc(m[1])}</code>`;
      else if (m[2]) {
        let link: URL | undefined, name = "";
        try {
          link = new URL(m[3], new URL(file, "https://spec.invalid/"));
          name = decodeURIComponent(link.pathname).slice(1).replace(/\/$/, "");
        } catch { link = undefined; }
        const local = link?.origin === "https://spec.invalid";
        const target = local && S.specs.find((spec) => !spec.deleted && [name, `${name}.md`, `${name}/index.md`].includes(spec.file));
        out += target ? `<a href="#${encodeURIComponent(target.file)}" data-spec="${esc(target.file)}">${esc(m[2])}</a>`
          : link && !local && /^https?:$/.test(link.protocol) ? `<a href="${esc(link.href)}" target="_blank" rel="noreferrer">${esc(m[2])}</a>` : esc(m[0]);
      } else if (m[4]) out += `<strong>${esc(m[4])}</strong>`;
      else out += `<em>${esc(m[5])}</em>`;
      end = m.index! + m[0].length;
    }
    return out + esc(s.slice(end));
  };
  return text.trim().split(/\n\s*\n/).map((block) =>
    /^\s*(`{3,}|~{3,})/.test(block) ? `<pre class="code">${esc(block.split("\n").slice(1, -1).join("\n"))}</pre>`
    : /^>/.test(block) ? `<blockquote>${inline(block.replace(/^>\s?/gm, ""))}</blockquote>`
    : /^\s*[-*] /.test(block) ? `<ul>${block.split(/\n(?=\s*[-*] )/).map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`
    : /^\|/.test(block) ? `<pre class="code">${esc(block)}</pre>`
    : `<p>${inline(block)}</p>`).join("");
}

const KEYWORDS = /^(pure|def|val|const|type|import|from|if|else|match|and|or|not|implies|iff|all|any|Set|List|Map|int|bool|str|true|false|module|as)$/;
/** Quint, coloured: keywords, the names a block defines, strings, numbers and comments. */
function highlight(code: string) {
  const out: string[] = [];
  let end = 0;
  for (const match of code.matchAll(/(\/\/.*)|("(?:[^"\\\n]|\\.)*")|\b(\d+)\b|\b([A-Za-z_]\w*)\b/g)) {
    const [text, com, str, num, word] = match;
    out.push(esc(code.slice(end, match.index)));
    const kind = com ? "com" : str ? "str" : num ? "num" : KEYWORDS.test(word) ? "kw"
      : /\b(def|val|type)\s+$/.test(code.slice(Math.max(0, match.index! - 6), match.index)) ? "def" : null;
    out.push(kind ? `<span class="${kind}">${esc(text)}</span>` : esc(text));
    end = match.index! + text.length;
  }
  return out.join("") + esc(code.slice(end));
}

// --- what the checks say about each story and rule ------------------------------------------------------------

/** Failing check results by the spec file and the rule key they cite. */
function failures() {
  const byKey = new Map<string, string[]>();
  const bySpec = new Map<string, Result[]>();
  for (const r of S.snap?.check?.results ?? []) {
    if (r.ok || r.stage === "review" || r.stage === "skipped") continue;
    const file = r.where?.startsWith("spec/") ? r.where : S.snap?.specs.find((s) => `${s.module}.ts` === r.where)?.file;
    if (file) bySpec.set(file, [...(bySpec.get(file) ?? []), r]);
    for (const m of `${r.summary}\n${r.detail}`.matchAll(/"([^"]+)" \((spec\/(?:[a-z][A-Za-z0-9]*\/)*[a-z][A-Za-z0-9]*\.md):\d+\)/g)) {
      const id = nodeId(m[2], m[1]);
      byKey.set(id, [...(byKey.get(id) ?? []), `${r.stage}: ${r.summary}`]);
    }
  }
  return { byKey, bySpec };
}
const reviewOf = (spec: Working, key: string) => S.snap?.specs.find((s) => s.file === spec.file)?.review[key];

// --- edits: outline events -------------------------------------------------------------------------------------

const current = () => S.specs.find((s) => s.file === S.sel);
/** Where a story or rule is now: its spec, and its position (spec/outline.md, "Positions"). */
function find(id: string) {
  for (const spec of S.specs) for (const [s, story] of spec.outline.stories.entries()) {
    if (ui(spec.file, story.id) === id) return { spec, s, story };
    const r = story.rules.findIndex((x) => ui(spec.file, x.id) === id);
    if (r >= 0) return { spec, s, story, r, rule: story.rules[r] };
  }
}
/** Apply events to a spec's outline, all or none: false, and nothing changed, if the outline refuses one. */
function apply(spec: Working, ...events: Edit[]) {
  let o = spec.outline;
  for (const e of events) {
    if (!enabled(o, e)) return false;
    o = step(o, e);
  }
  spec.outline = o;
  return true;
}
/** Every change but typing is undoable; typing is undone a whole edit at a time. */
function remember() {
  S.history.push(JSON.stringify(S.specs));
  if (S.history.length > 50) S.history.shift();
}
function change(fn: () => boolean | void, message?: string) {
  remember();
  if (fn() === false) { S.history.pop(); return toast("The outline does not allow that"); }
  render();
  if (message) toast(message, { label: "Undo", run: undo });
}
function undo() {
  const was = S.history.pop();
  if (!was) return;
  S.specs = JSON.parse(was);
  S.editing.clear();
  render();
}
/** Typing changes only the outline and the marks; the document is not redrawn under the caret. */
function edited() {
  renderRail();
  renderBuild();
  document.querySelectorAll<HTMLElement>("[data-uid]").forEach((el) => {
    const f = find(el.dataset.uid!);
    if (!f) return;
    el.classList.toggle("changed", f.rule ? ruleChanged(f.spec, f.story, f.rule, f.r!) : storyChanged(f.spec, f.story, f.s));
    const title = el.querySelector(":scope > .row .title");
    if (title) title.textContent = (f.rule ?? f.story).title.trim() || "Untitled";
  });
}

function addStory(spec: Working) {
  const id = spec.outline.counter;
  change(() => apply(spec, { type: "addStory", at: spec.outline.stories.length, title: "Story:", body: "\n", origin: "" }) && editNode(ui(spec.file, id), false));
}
function addRule(spec: Working, s: number) {
  const id = spec.outline.counter;
  S.open.add(ui(spec.file, spec.outline.stories[s].id));
  change(() => apply(spec, { type: "addRule", s, at: spec.outline.stories[s].rules.length, title: "", body: "\n", origin: "" }) && editNode(ui(spec.file, id), false));
}
function removeNode(id: string) {
  const f = find(id);
  if (!f) return;
  change(() => apply(f.spec, f.rule ? { type: "removeRule", s: f.s, r: f.r! } : { type: "removeStory", s: f.s }), `Deleted “${(f.rule ?? f.story).title.trim() || "untitled"}”`);
}

/** The events that put a story, and its rules after it, into another spec at position `at`. */
const storyInto = (spec: Working, at: number, story: Story): Edit[] => [
  { type: "addStory", at, title: story.title, body: story.body, origin: story.origin },
  ...story.rules.map((r, i): Edit => ({ type: "addRule", s: at, at: i, title: r.title, body: r.body, origin: r.origin })),
];

/**
 * Move a story or rule before or after another, into a story, or to the end of another spec: one outline event for
 * a move within a spec, and a removal and additions, keeping each one's key, for a move between specs.
 */
function move(dragged: string, target: { uid?: string; where?: "before" | "after"; spec?: string }) {
  const from = find(dragged);
  if (!from || dragged === target.uid) return;
  change(() => {
    if (target.spec) {
      const into = S.specs.find((s) => s.file === target.spec)!;
      if (!from.rule) return apply(into, ...storyInto(into, into.outline.stories.length, from.story)) && apply(from.spec, { type: "removeStory", s: from.s });
      const last = into.outline.stories.length - 1;
      if (last < 0) return false;
      const r = from.rule;
      return apply(into, { type: "addRule", s: last, at: into.outline.stories[last].rules.length, title: r.title, body: r.body, origin: r.origin }) && apply(from.spec, { type: "removeRule", s: from.s, r: from.r! });
    }
    const to = find(target.uid!)!;
    const after = target.where === "after" ? 1 : 0;
    if (to.spec !== from.spec) {
      if (!from.rule) return apply(to.spec, ...storyInto(to.spec, to.s + after, from.story)) && apply(from.spec, { type: "removeStory", s: from.s });
      const at = to.rule ? to.r! + after : to.story.rules.length;
      const r = from.rule;
      return apply(to.spec, { type: "addRule", s: to.s, at, title: r.title, body: r.body, origin: r.origin }) && apply(from.spec, { type: "removeRule", s: from.s, r: from.r! });
    }
    if (!from.rule) {
      // A story's new position, counted without it.
      const dest = to.s + after - (from.s < to.s + after ? 1 : 0);
      return apply(from.spec, { type: "moveStory", s: from.s, dest });
    }
    const at = to.rule ? to.r! + after - (to.s === from.s && from.r! < to.r! + after ? 1 : 0) : to.story.rules.length - (to.s === from.s ? 1 : 0);
    return apply(from.spec, { type: "moveRule", s: from.s, r: from.r!, dest: to.s, at });
  });
}
function nudge(id: string, by: number) {
  const f = find(id);
  if (!f) return;
  change(() => apply(f.spec, f.rule ? { type: "moveRule", s: f.s, r: f.r!, dest: f.s, at: f.r! + by } : { type: "moveStory", s: f.s, dest: f.s + by }));
  focusLater(`[data-uid="${id}"] > .row`);
}
/** Focus after the next redraw, with the caret at the end of any text already there. */
const focusLater = (selector: string) => setTimeout(() => {
  const el = document.querySelector<HTMLInputElement>(selector);
  el?.focus();
  if (el && "selectionStart" in el && el.value !== undefined) el.selectionStart = el.selectionEnd = el.value.length;
}, 0);

/**
 * A new spec at `spec/<path>/index.md`, empty and unpublished, linked from the nearest spec above it, so publishing
 * hands both to the agent (spec/index.md, "Story: Edit, then publish").
 */
function newSpec(path: string) {
  const file = `spec/${path}/index.md`;
  if (!/^([a-z][A-Za-z0-9]*\/)*[a-z][A-Za-z0-9]*$/.test(path)) return toast("A spec's path is names like billing or billing/payments");
  if (S.specs.some((s) => s.file === file || s.file === `spec/${path}.md`)) return toast(`${file} already exists`);
  const name = path.split("/").pop()!;
  const empty: Outline = { title: name[0].toUpperCase() + name.slice(1), body: "\n", stories: [], counter: 1 };
  change(() => {
    S.specs.push({ file, base: null, orig: null, was: empty, outline: empty, deleted: false });
    const dirs = path.split("/");
    for (let n = dirs.length - 1; n >= 0; n--) {
      const parent = S.specs.find((s) => s.file === `spec/${[...dirs.slice(0, n), "index.md"].join("/")}` && !s.deleted);
      if (!parent) continue;
      const link = `[${empty.title}](./${dirs.slice(n).join("/")}/)`;
      apply(parent, { type: "retitle", title: parent.outline.title, body: textBody(`${parent.outline.body.trim()}\n\n${link}`) });
      break;
    }
    S.sel = file;
  }, `${file} will be written on publish`);
}

// --- rendering ------------------------------------------------------------------------------------------------

function render() {
  renderRail();
  renderDoc();
  renderBuild();
}

/** A spec's name in the rail: its path below spec/, and its directory for an index. */
const specLabel = (file: string) => file.slice(5, -3).replace(/(^|\/)index$/, "") || "index";

function renderRail() {
  const fails = failures().bySpec;
  const rail = document.getElementById("rail")!;
  const newName = h("input", { placeholder: "area/child", "aria-label": "Path of a new spec", onkeydown: (e: KeyboardEvent) => e.key === "Enter" && create() }) as HTMLInputElement;
  const create = () => (newName.value.trim() ? newSpec(newName.value.trim()) : newName.focus());
  rail.replaceChildren(
    h("div", { class: "project", title: S.snap?.project.root }, S.snap?.project.name),
    h("a", { href: "/components" }, "Components"),
    h("ul", { class: "specs" }, S.specs.map((spec) => {
      const review = reviewCount(spec.file);
      const status = isDirty(spec) ? ["dirty", "unpublished changes"] : fails.has(spec.file) ? ["bad", "failing checks"] : review ? ["review", `${review} to review`] : ["", ""];
      const depth = specLabel(spec.file).split("/").length - (spec.file === "spec/index.md" ? 1 : 0);
      const li = h("li", { class: `spec${spec.deleted ? " deleted" : ""}`, style: `padding-left: ${8 + 12 * depth}px`, "aria-current": spec.file === S.sel ? "true" : "false", tabindex: 0, title: spec.file,
        onclick: () => { S.sel = spec.file; render(); }, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") { S.sel = spec.file; render(); } } },
        h("span", { class: `dot ${status[0]}`, role: "img", "aria-label": status[1] || "in step", title: status[1] }),
        h("span", { class: "name" }, specLabel(spec.file).split("/").pop()),
        h("span", { class: "count", title: "stories · rules" }, `${spec.outline.stories.length}·${spec.outline.stories.reduce((n, s) => n + s.rules.length, 0)}`),
        spec.deleted ? iconButton("undo", `Keep ${spec.file}`, () => change(() => { spec.deleted = false; }))
          : iconButton("trash", `Delete ${spec.file}`, () => change(() => { spec.deleted = true; }, `${spec.file} will be deleted on publish`), "danger"));
      // A story dropped on a spec moves to its end.
      li.addEventListener("dragover", (e) => { if (drag?.kind === "story" && !spec.deleted && find(drag.uid)?.spec.file !== spec.file) { e.preventDefault(); li.classList.add("drop"); } });
      li.addEventListener("dragleave", () => li.classList.remove("drop"));
      li.addEventListener("drop", (e) => { e.preventDefault(); li.classList.remove("drop"); if (drag) move(drag.uid, { spec: spec.file }); });
      return li;
    })),
    h("div", { class: "newspec" }, newName, iconButton("plus", "Add spec", create)),
  );
}

let drag: { uid: string; kind: "story" | "rule" } | null = null;
function draggable(el: HTMLElement, id: string, kind: "story" | "rule") {
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    drag = { uid: id, kind };
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", id);
    setTimeout(() => el.classList.add("dragging"), 0);
  });
  el.addEventListener("dragend", () => { el.classList.remove("dragging"); drag = null; clearDrops(); });
}
const clearDrops = () => document.querySelectorAll(".drop-before,.drop-after,.drop-into,.drop").forEach((x) => x.classList.remove("drop-before", "drop-after", "drop-into", "drop"));
/** Where a drag over `el` would land: before or after it, by the half of it the pointer is over, or into a story. */
function dropTarget(el: HTMLElement, id: string, accepts: (kind: string) => boolean) {
  el.addEventListener("dragover", (e) => {
    if (!drag || !accepts(drag.kind) || drag.uid === id) return;
    e.preventDefault();
    e.stopPropagation();
    clearDrops();
    const box = el.getBoundingClientRect();
    el.classList.add(drag.kind === "rule" && el.classList.contains("section") ? "drop-into" : e.clientY < box.top + box.height / 2 ? "drop-before" : "drop-after");
  });
  el.addEventListener("drop", (e) => {
    if (!drag || !accepts(drag.kind)) return;
    e.preventDefault();
    e.stopPropagation();
    const where = el.classList.contains("drop-before") ? "before" : "after";
    clearDrops();
    move(drag.uid, { uid: id, where });
  });
}

/** An auto-growing text box. */
function textBox(value: string, set: (v: string) => void, { code = false, placeholder = "", label = "" } = {}) {
  const ta = h("textarea", { class: code ? "code" : "", spellcheck: !code, placeholder, "aria-label": label, rows: 1 }) as HTMLTextAreaElement;
  ta.value = value;
  const grow = () => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; };
  ta.addEventListener("input", () => { grow(); set(ta.value); edited(); });
  ta.addEventListener("keydown", (e) => {
    if (code && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input"));
    }
  });
  setTimeout(grow, 0);
  return ta;
}
function headingInput(value: string, set: (v: string) => void, label: string) {
  const input = h("input", { class: "heading", value, "aria-label": label, placeholder: label }) as HTMLInputElement;
  input.addEventListener("input", () => { set(input.value.trim()); input.classList.toggle("invalid", !input.value.trim()); edited(); });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    input.closest(".edit")?.querySelector("textarea")?.focus();
  });
  return input;
}

function renderDoc() {
  const el = doc();
  const spec = current();
  const scroll = el.scrollTop;
  const active = (document.activeElement?.closest("[data-uid]") as HTMLElement | null)?.dataset.uid;
  if (!spec) { el.replaceChildren(); return focusLater(".newspec input"); }
  const { byKey, bySpec } = failures();
  const o = spec.outline;

  const conflict = S.conflicts.includes(spec.file) && renderConflict(spec);
  const problem = S.snap?.problem && h("pre", { class: "problem" }, S.snap.problem);
  const specFails = bySpec.get(spec.file)?.filter((r) => !/"[^"]+" \(spec\//.test(`${r.summary}\n${r.detail}`));

  const headId = ui(spec.file, "head");
  const head = h("div", { class: "head", "data-uid": headId }, S.editing.has(headId)
    ? h("div", { class: "edit" },
      headingInput(o.title, (title) => apply(spec, { type: "retitle", title, body: spec.outline.body }), "Title"),
      textBox(o.body.trim(), (v) => apply(spec, { type: "retitle", title: spec.outline.title, body: textBody(v) }), { label: "What the application is for" }),
      h("div", { class: "bar" }, h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => { S.editing.delete(headId); renderDoc(); } }, icon("check"), "Done")))
    : [h("h1", { ondblclick: () => editNode(headId) }, o.title || specLabel(spec.file), " ", iconButton("edit", "Edit title and introduction", () => editNode(headId))),
      o.body.trim() && h("div", { class: "intro prose", html: markdown(o.body, spec.file) })]);

  el.replaceChildren(conflict || "", problem || "",
    specFails?.length ? h("div", { class: "banner bad" }, h("span", {}, specFails.map((r) => `${r.stage}: ${r.summary}`).join("\n"))) : "",
    spec.deleted ? h("div", { class: "banner bad" }, h("span", {}, "Deleted on publish."), h("button", { class: "btn", type: "button", onclick: () => change(() => { spec.deleted = false; }) }, "Keep")) : "",
    head, ...o.stories.map((s, i) => renderStory(spec, s, i, byKey)),
    h("div", { class: "add newstory" }, h("button", { class: "btn", type: "button", onclick: () => addStory(spec) }, icon("plus"), "Story")));
  el.scrollTop = scroll;
  if (active && !document.activeElement?.closest("[data-uid]")) document.querySelector<HTMLElement>(`[data-uid="${active}"] > .row`)?.focus({ preventScroll: true });
}

/** Open a story or rule for editing, as one undoable change. */
function editNode(id: string, undoable = true) {
  if (undoable && !S.editing.has(id)) remember();
  S.editing.add(id);
  S.open.add(id);
  renderDoc();
  focusLater(`[data-uid="${id}"] input.heading`);
}

/** The mark a story or rule carries: failing a check, waiting for review, or unpublished. */
const statusOf = (changed: boolean, fails: string[] | undefined, review: string | undefined) =>
  fails?.length ? ["bad", fails.join("\n")] : review ? ["review", review] : changed ? ["dirty", "unpublished change"] : ["", ""];

function renderStory(spec: Working, story: Story, s: number, byKey: Map<string, string[]>) {
  const id = ui(spec.file, story.id);
  const review = reviewOf(spec, storyKey(story.title));
  const changed = storyChanged(spec, story, s);
  const open = S.open.has(id);
  const editing = S.editing.has(id);
  const [cls, label] = statusOf(changed, undefined, review);
  const unique = soleHeading(spec.outline.stories.map((x) => x.title.trim()), story.title.trim());
  const row = h("div", { class: `row${editing ? " editing" : ""}`, tabindex: 0, onkeydown: (e: KeyboardEvent) => keys(e, id) },
    h("span", { class: "grip", "aria-hidden": "true" }, icon("grip")),
    h("span", { class: `chev${open ? " open" : ""}`, "aria-hidden": "true", onclick: () => toggle(id) }, icon("chev")),
    h("span", { class: "title", onclick: () => toggle(id), ondblclick: () => editNode(id), style: unique ? undefined : "color: var(--bad)" }, story.title.trim() || "Untitled"),
    h("span", { class: "meta", title: "rules" }, story.rules.length),
    h("span", { class: `dot ${cls}`, role: "img", "aria-label": label || "in step", title: label }),
    h("span", { class: "actions" },
      iconButton("edit", "Edit story", () => editNode(id)),
      iconButton("plus", "Add rule", () => addRule(spec, s)),
      moveMenu(id, "story"),
      iconButton("trash", "Delete story and its rules", () => removeNode(id), "danger")));
  const edit = (title: string, body: string) => apply(spec, { type: "editStory", s: spec.outline.stories.findIndex((x) => x.id === story.id), title, body });
  const card = h("section", { class: `section${story.title.startsWith("Story:") ? "" : " group"}${changed ? " changed" : ""}`, "data-uid": id, "aria-label": story.title || "Rules" }, row,
    open && editing ? h("div", { class: "body edit" },
      headingInput(story.title, (v) => edit(v, current()!.outline.stories.find((x) => x.id === story.id)!.body), "Story: As a … I want …"),
      textBox(story.body.trim(), (v) => edit(current()!.outline.stories.find((x) => x.id === story.id)!.title, textBody(v)), { placeholder: "> As a …, I want …, so that …", label: "Story text" }),
      review ? h("div", { class: "status review" }, review) : "",
      h("div", { class: "bar" }, h("span", { class: "spacer" }), h("button", { class: "btn", type: "button", onclick: () => { S.editing.delete(id); renderDoc(); } }, icon("check"), "Done")))
      : open && story.body.trim() ? h("div", { class: "story prose", html: markdown(story.body, spec.file), ondblclick: () => editNode(id) }) : "",
    open && review && !editing ? h("div", { class: "story status review" }, review) : "",
    open ? h("ul", { class: "rules" }, story.rules.map((r, j) => renderRule(spec, story, s, r, j, byKey)),
      h("li", { class: "add" }, h("button", { class: "btn", type: "button", onclick: () => addRule(spec, s) }, icon("plus"), "Rule"))) : "");
  draggable(card, id, "story");
  dropTarget(card, id, (k) => k === "story" || k === "rule");
  return card;
}
/** Whether `title` is non-empty and appears once among `titles` (spec/outline.md, "Every story and rule needs a heading, unique where it is"). */
const soleHeading = (titles: string[], title: string) => !!title && titles.filter((t) => t === title).length === 1;

function renderRule(spec: Working, story: Story, s: number, rule: Rule, r: number, byKey: Map<string, string[]>) {
  const id = ui(spec.file, rule.id);
  const key = ruleKey(story.title, rule.title);
  const review = reviewOf(spec, key);
  const fails = byKey.get(nodeId(spec.file, key));
  const changed = ruleChanged(spec, story, rule, r);
  const open = S.open.has(id);
  const editing = S.editing.has(id);
  const [cls, label] = statusOf(changed, fails, review);
  const items = itemsOf(rule.body);
  const unique = soleHeading(story.rules.map((x) => x.title.trim()), rule.title.trim());
  const row = h("div", { class: `row${editing ? " editing" : ""}`, tabindex: 0, onkeydown: (e: KeyboardEvent) => keys(e, id) },
    h("span", { class: "grip", "aria-hidden": "true" }, icon("grip")),
    h("span", { class: `chev${open ? " open" : ""}`, "aria-hidden": "true", onclick: () => toggle(id) }, icon("chev")),
    h("span", { class: "title", onclick: () => toggle(id), ondblclick: () => editNode(id), style: unique ? undefined : "color: var(--bad)" }, rule.title.trim() || "Untitled"),
    items.some((i) => i.quint) ? "" : h("span", { class: "kinds", role: "img", "aria-label": "no Quint", title: "no Quint" }, "∅"),
    h("span", { class: `dot ${cls}`, role: "img", "aria-label": label || "in step", title: label }),
    h("span", { class: "actions" }, iconButton("edit", "Edit rule", () => editNode(id)), moveMenu(id, "rule"), iconButton("trash", "Delete rule", () => removeNode(id), "danger")));
  const body = !open ? "" : editing ? renderRuleEditor(spec, id) : h("div", { class: "body" },
    items.map((i) => (i.quint ? h("pre", { class: "code", html: highlight(i.text) }) : h("div", { class: "prose", html: markdown(i.text, spec.file) }))),
    review ? h("div", { class: "status review" }, review) : "",
    fails ? fails.map((f) => h("div", { class: "status bad" }, f)) : "");
  const li = h("li", { class: `rule${open ? " open" : ""}${changed ? " changed" : ""}`, "data-uid": id, ondblclick: (e: MouseEvent) => { if (!editing && (e.target as Element).closest(".body")) editNode(id); } }, row, body);
  draggable(li, id, "rule");
  dropTarget(li, id, (k) => k === "rule");
  return li;
}

/** A rule's heading, prose and Quint blocks being edited; each change is one `editRule` event (spec/outline.md). */
function renderRuleEditor(spec: Working, id: string) {
  const at = () => find(id)!;
  if (!S.items.has(id)) S.items.set(id, itemsOf(at().rule!.body));
  const items = S.items.get(id)!;
  if (!items.length) items.push({ quint: false, text: "" });
  const save = (title = at().rule!.title) => apply(spec, { type: "editRule", s: at().s, r: at().r!, title, body: bodyOf(items) });
  const box = h("div", { class: "edit" });
  const draw = () => box.replaceChildren(
    headingInput(at().rule!.title, (v) => save(v), "One checkable sentence"),
    ...items.map((item, k) => h("div", { class: "item" },
      textBox(item.text, (v) => { item.text = v; save(); }, { code: item.quint, placeholder: item.quint ? "pure def …" : "Prose (optional)", label: item.quint ? "Quint" : "Prose" }),
      h("div", { class: "side" },
        k > 0 && iconButton("up", "Move up", () => { items.splice(k - 1, 0, items.splice(k, 1)[0]); save(); draw(); edited(); }),
        iconButton("close", "Remove", () => { items.splice(k, 1); save(); draw(); edited(); }, "danger")))),
    h("div", { class: "bar" },
      h("button", { class: "btn", type: "button", onclick: () => { items.push({ quint: false, text: "" }); draw(); } }, icon("plus"), "Prose"),
      h("button", { class: "btn", type: "button", onclick: () => { items.push({ quint: true, text: "" }); draw(); focusLater(`[data-uid="${id}"] textarea.code:last-of-type`); } }, icon("plus"), "Quint"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", type: "button", onclick: () => { S.editing.delete(id); S.items.delete(id); renderDoc(); } }, icon("check"), "Done")));
  draw();
  return h("div", { class: "body" }, box);
}

/** "Move to…": every story of every spec for a rule, every other spec for a story. Keyboard users' drag and drop. */
function moveMenu(id: string, kind: "story" | "rule") {
  const home = find(id)?.spec.file;
  return h("select", { class: "icon", title: "Move to…", "aria-label": "Move to", style: "width: 26px; appearance: none; cursor: pointer", onclick: (e: MouseEvent) => e.stopPropagation(),
    onchange: (e: any) => {
      const [type, value] = (e.target.value as string).split("|");
      if (type === "spec") move(id, { spec: value });
      else move(id, { uid: value, where: "after" });
    } },
  h("option", { value: "", selected: true, disabled: true }, "⇅"),
  kind === "rule"
    ? S.specs.filter((s) => !s.deleted).map((spec) => h("optgroup", { label: specLabel(spec.file) }, spec.outline.stories.map((s) => h("option", { value: `story|${ui(spec.file, s.id)}` }, s.title.trim() || "(untitled)"))))
    : S.specs.filter((s) => !s.deleted && s.file !== home).map((spec) => h("option", { value: `spec|${spec.file}` }, `to ${specLabel(spec.file)}`)));
}

function toggle(id: string) {
  S.open.has(id) ? S.open.delete(id) : S.open.add(id);
  renderDoc();
}
function keys(e: KeyboardEvent, id: string) {
  if (e.target !== e.currentTarget) return;
  if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); nudge(id, -1); }
  else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); nudge(id, 1); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(id); focusLater(`[data-uid="${id}"] > .row`); }
  else if (e.key === "e") { e.preventDefault(); editNode(id); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeNode(id); }
}

/** A spec changed on disk while this page edits it: what changed there, so that keeping these edits is a choice. */
function renderConflict(spec: Working) {
  const fresh = S.snap!.specs.find((s) => s.file === spec.file);
  const titles = (o: Outline) => new Map(nodesOfOutline(spec.file, o).map((n) => [n.key, (n.rule ?? n.story).body]));
  const was = titles(spec.was);
  const now = fresh ? titles(fresh.outline) : new Map<string, string>();
  const there = [...now].filter(([k, v]) => was.get(k) !== v).map(([k]) => k).concat([...was.keys()].filter((k) => !now.has(k)).map((k) => `${k} (removed)`));
  return h("div", { class: "banner" },
    h("span", {}, fresh && there.length ? there.map((k) => k.replace(/^## /, "")).join(" · ") : `${spec.file}${fresh ? "" : " (removed)"}`),
    h("button", { class: "btn", type: "button", onclick: () => keepMine(spec.file) }, "Keep mine"),
    h("button", { class: "btn", type: "button", onclick: () => takeTheirs(spec.file) }, "Take disk"));
}
function keepMine(file: string) {
  const fresh = S.snap!.specs.find((s) => s.file === file);
  const mine = S.specs.find((s) => s.file === file)!;
  mine.base = fresh?.hash ?? null;
  mine.orig = fresh?.text ?? null;
  S.conflicts = S.conflicts.filter((f) => f !== file);
  render();
}
function takeTheirs(file: string) {
  const fresh = S.snap!.specs.find((s) => s.file === file);
  S.specs = S.specs.flatMap((s) => (s.file !== file ? [s] : fresh ? [working(fresh)] : []));
  S.conflicts = S.conflicts.filter((f) => f !== file);
  render();
}

// --- the build panel: the session -----------------------------------------------------------------------------

/** Stories and rules waiting for review, in one spec or in all. */
const reviewCount = (file?: string) => (S.snap?.specs ?? []).filter((s) => !file || s.file === file).reduce((n, s) => n + Object.keys(s.review).length, 0);

function renderBuild() {
  const build = document.getElementById("build")!;
  const snap = S.snap;
  if (!snap) return;
  const dirty = dirtySpecs();
  const { job: running, verdict, waiting } = snap.session;
  const jobs = snap.jobs;
  /** The agent's or the sign-off's log, whichever ran last; the check reports in its own block. */
  const job = [jobs.agent, jobs.accept].filter((j): j is JobView => !!j).sort((a, b) => b.started - a.started)[0];
  const check = snap.check;
  const manifest = snap.manifest;
  const results = check?.results ?? [];
  const blocking = results.filter((r) => !r.ok && r.stage !== "review");
  const review = reviewCount();

  const stage = (name: string, state: string, mark: string | number, label: string) => h("div", { class: `stage ${state}` }, h("div", { class: "node", role: "img", "aria-label": `${name}: ${label}`, title: label }, mark), name);
  const pipeline = h("div", { class: "pipeline", "aria-label": "Where the project stands" },
    stage("Edit", dirty.length ? "active" : "idle", dirty.length || "", dirty.length ? `${dirty.length} specs changed` : "nothing unpublished"),
    stage("Publish", dirty.length ? "todo" : waiting ? "ok" : "idle", "", dirty.length ? "waiting to publish" : waiting ? "published" : "nothing to publish"),
    stage("Sync", running === "Syncing" ? "running" : waiting ? "todo" : "ok", waiting || "", waiting ? `${waiting} changes for the agent` : "in step"),
    stage("Check", running === "Checking" ? "running" : verdict === "Unknown" ? "idle" : verdict === "Failing" ? "bad" : "ok", blocking.length || "", { Unknown: "not checked since the specs changed", Failing: `${blocking.length} failing`, Reviewable: "only review left", Green: "all green" }[verdict]),
    stage("Sign off", running === "SigningOff" ? "running" : review ? "todo" : verdict === "Green" ? "ok" : "idle", review || "", review ? `${review} to review` : "nothing to review"));

  const publishBlock = h("div", { class: "block" },
    h("div", { class: "buttons" },
      h("button", { class: "btn primary", type: "button", disabled: !can({ type: "publish", changes: 0 }), onclick: openPublish, title: "⌘S" }, icon("check"), dirty.length ? `Publish ${dirty.length}` : "Publish"),
      can({ type: "discard" }) ? h("button", { class: "btn", type: "button", onclick: discard }, "Discard") : ""));

  const manifestBlock = manifest && h("div", { class: "block" },
    h("ul", { class: "changes" }, manifest.changes.map((c) => h("li", {}, h("span", { class: `sign ${c.action}`, "aria-label": c.action }, SIGN[c.action]),
      h("span", {}, c.kind === "spec" ? c.key : c.key.replace(/^## /, "").replace(/^Story: /, ""), c.what.length ? h("div", { class: "what" }, c.what.join(" · ")) : "")))),
    manifest.regenerate.length ? h("div", { class: "what" }, `↻ ${manifest.regenerate.map((r) => r.gen).join(", ")}`) : "",
    h("div", { class: "buttons" }, h("button", { class: "btn", type: "button", disabled: !can({ type: "markSynced" }), onclick: () => start("synced") }, icon("check"), "Mark synced")));

  const agents = h("div", { class: "block" },
    snap.agents.map((a) => h("div", { class: "agent" },
      h("span", { class: "label" }, a.label),
      h("button", { class: "btn", type: "button", disabled: !a.available || !can({ type: "sync" }), title: a.available ? undefined : `${a.label} is not installed`, onclick: () => start("agent", { agent: a.id }) }, icon("play"), "Run"),
      a.link ? h("a", { class: "btn", href: a.link }, icon("open"), "Open") : "")),
    h("div", { class: "buttons" }, iconButton("copy", "Copy the sync prompt", copyPrompt)));

  const jobBlock = job && h("div", { class: "job" },
    h("div", { class: "top" },
      h("span", { class: `dot ${job.status === "running" ? "dirty" : job.status === "passed" ? "ok" : "bad"}`, role: "img", "aria-label": job.status }),
      h("span", { class: "label" }, job.label),
      h("span", { class: "meta", "data-elapsed": job.label }, elapsed(job)),
      job.status === "running" && can({ type: "stop" }) ? iconButton("stop", "Stop", () => start("stop")) : ""),
    h("pre", { id: "log" }, job.log.join("\n") || "…"));

  const checkBlock = h("div", { class: "block" },
    running === "Checking" && jobs.check ? h("div", { class: "agent" }, h("span", { class: "label" }, "Checking…"), h("span", { class: "meta", "data-elapsed": "check" }, elapsed(jobs.check)), iconButton("stop", "Stop", () => start("stop")))
      : jobs.check?.status === "failed" && !check ? h("div", { class: "results" }, h("details", { open: true }, h("summary", {}, "The check did not finish"), h("pre", {}, jobs.check.log.join("\n")))) : "",
    check ? h("div", { class: "next" }, check.next) : "",
    blocking.length ? h("div", { class: "results" }, blocking.map((r) => h("details", {}, h("summary", {}, `${r.stage}: ${r.summary}`), r.detail ? h("pre", {}, r.detail) : ""))) : "",
    h("div", { class: "buttons" },
      h("button", { class: "btn", type: "button", disabled: !can({ type: "check" }), onclick: () => start("check") }, icon("play"), "Run check"),
      h("button", { class: "btn", type: "button", disabled: !can({ type: "signOff" }), onclick: signOff }, icon("check"), "Sign off"),
      check ? h("span", { class: "meta" }, new Date(check.finished).toLocaleTimeString()) : ""));

  build.replaceChildren(pipeline, publishBlock, manifestBlock || "", agents, jobBlock || "", checkBlock);
  const log = document.getElementById("log");
  if (log) log.scrollTop = log.scrollHeight;
}
const elapsed = (job: JobView) => { const s = Math.round(((job.finished ?? Date.now()) - job.started) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
setInterval(() => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-elapsed]")) {
    const job = Object.values(S.snap?.jobs ?? {}).find((j) => j?.label === el.dataset.elapsed);
    if (job?.status === "running") el.textContent = elapsed(job);
  }
}, 1000);

async function start(route: string, body: unknown = {}) {
  try { await api(route, body); } catch (e) { toast((e as Error).message); }
}
async function copyPrompt() {
  try { await navigator.clipboard.writeText(S.snap!.prompt); toast("Sync prompt copied"); } catch { toast("Could not copy"); }
}
function signOff() {
  if (confirm(`Sign off ${reviewCount()}?`)) start("accept");
}
function discard() {
  if (!confirm(`Discard unpublished changes to ${dirtySpecs().map((s) => s.file).join(", ")}?`)) return;
  change(() => { S.specs = S.snap!.specs.map(working); S.conflicts = []; S.editing.clear(); S.items.clear(); });
}

// --- publishing ---------------------------------------------------------------------------------------------------

/** Line diff by longest common subsequence, with three lines of context around each change. */
function diff(a: string, b: string) {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const t = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const ops: [string, string][] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { ops.push([" ", x[i]]); i++; j++; }
    else if (j < m && (i >= n || t[i][j + 1] >= t[i + 1][j])) ops.push(["+", y[j++]]);
    else ops.push(["-", x[i++]]);
  }
  const near = ops.map((_, k) => ops.slice(Math.max(0, k - 3), k + 4).some(([op]) => op !== " "));
  return ops.flatMap(([op, line], k) => near[k] ? [h("div", { class: `l ${op === "+" ? "add" : op === "-" ? "del" : ""}` }, `${op} ${line}`)]
    : near[k - 1] || k === 0 ? [h("div", { class: "l gap" }, "…")] : []);
}

function openPublish() {
  const dirty = dirtySpecs();
  if (S.publishing || !can({ type: "publish", changes: 0 })) return;
  const unsound = dirty.filter((s) => !s.deleted && !headingsAreSound(s.outline)).map((s) => s.file);
  const dialog = document.getElementById("dialog") as HTMLDialogElement;
  dialog.replaceChildren(h("form", { method: "dialog" },
    h("header", {}, `Publish ${dirty.length === 1 ? dirty[0].file : `${dirty.length} specs`}`),
    h("div", { class: "content" },
      unsound.length ? h("div", { class: "banner bad" }, h("span", {}, unsound.join(", "))) : "",
      dirty.map((spec) => h("div", { class: "diff" }, h("div", { class: "file" }, spec.deleted ? `${spec.file} (deleted)` : spec.orig === null ? `${spec.file} (new)` : spec.file),
        spec.deleted ? "" : diff(spec.orig ?? "", publishedText(spec)!)))),
    h("footer", {},
      h("button", { class: "btn", value: "cancel" }, "Cancel"),
      h("button", { class: "btn primary", value: "publish", disabled: unsound.length > 0, onclick: (e: MouseEvent) => { e.preventDefault(); dialog.close(); publish(); } }, icon("check"), "Publish"))));
  dialog.showModal();
}

async function publish(force = false): Promise<void> {
  if (S.publishing) return;
  const dirty = dirtySpecs();
  // What each story and rule was on disk, so the manifest can say what moved and what was renamed.
  const origins = dirty.filter((s) => !s.deleted).flatMap((spec) => nodesOfOutline(spec.file, spec.outline).map((n) => [n.id, (n.rule ?? n.story).origin || null]));
  S.publishing = true;
  try {
    await api("publish", { files: dirty.map((s) => ({ file: s.file, base: s.base, text: publishedText(s) })), origins, force });
  } catch (e: any) {
    S.publishing = false;
    if (e.status === 409 && e.body.conflicts && confirm(`${e.body.conflicts.join(", ")} changed on disk since you loaded it. Overwrite with your version?`)) return publish(true);
    return toast(e.message);
  }
  // What was published is what is on disk now; the reload takes each spec from there.
  for (const spec of dirty) spec.orig = publishedText(spec);
  S.specs = S.specs.filter((s) => !s.deleted);
  S.editing.clear();
  S.items.clear();
  S.history = [];
  S.publishing = false;
  await refresh(true);
  toast("Published");
}

// --- start -----------------------------------------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); openPublish(); }
  else if ((e.metaKey || e.ctrlKey) && e.key === "z" && !typing && S.history.length) { e.preventDefault(); undo(); }
  else if (e.key === "Escape" && typing && S.editing.size && !(document.getElementById("dialog") as HTMLDialogElement).open) {
    const id = (document.activeElement!.closest("[data-uid]") as HTMLElement | null)?.dataset.uid;
    if (id && S.editing.delete(id)) { S.items.delete(id); renderDoc(); focusLater(`[data-uid="${id}"] > .row`); }
  }
});
document.addEventListener("focusout", (e) => {
  const target = e.target as HTMLElement;
  if (doc().contains(target) && /^(INPUT|TEXTAREA)$/.test(target.tagName)) setTimeout(() => refresh().catch((error) => toast(error.message)), 0);
});
document.addEventListener("click", (e) => {
  const link = (e.target as Element).closest?.("a[data-spec]") as HTMLElement | null;
  if (!link) return;
  e.preventDefault();
  S.sel = link.dataset.spec!;
  render();
});
// spec/index.md, "Edits stay in the page until they are published or discarded"
window.addEventListener("beforeunload", (e) => { if (dirtySpecs().length) e.preventDefault(); });

await refresh();
const events = new EventSource("/api/events");
events.addEventListener("files", () => refresh());
events.addEventListener("job", (e) => {
  const { session, jobs, check } = JSON.parse((e as MessageEvent).data);
  const ended = S.snap!.session.job !== "Idle" && session.job === "Idle";
  Object.assign(S.snap!, { session, jobs, check });
  if (ended) refresh();
  else renderBuild();
});
