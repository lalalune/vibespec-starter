// The Components view: every React component the story generator found, its generated stories as live
// previews, and its links to the spec model, source and design document. It reads `catalog.json`, written
// by `@repo/storybook` (packages/storybook/src/catalog.ts declares the same shape); DOM only, no imports.

export interface ComponentIndex {
  version: 1;
  storybook: { url?: string };
  components: Component[];
}
export interface Component {
  id: string;
  name: string;
  package: string;
  title: string;
  description: string;
  source: { file: string; line: number };
  props: Prop[];
  stories: Story[];
  model?: { spec: string; module: string; state: string; events: string[] };
  design?: string[];
  diagnostics: string[];
}
export interface Prop {
  name: string;
  kind: "boolean" | "number" | "string" | "union" | "function" | "node" | "object" | "array" | "unknown";
  required: boolean;
  options?: (string | number | boolean)[];
  default?: unknown;
  description?: string;
}
export interface Story {
  id: string;
  name: string;
  kind: "default" | "prop" | "state" | "example" | "model";
  args: Record<string, unknown>;
}

export interface ComponentsOptions {
  /** Where Storybook serves previews; overrides `index.storybook.url`. */
  storybook?: string;
  /** Open a spec (a model's, or a design document) in the editor. */
  openSpec?: (path: string) => void;
  /** Open a source file at a line in the user's editor. */
  openSource?: (file: string, line: number) => void;
}

type Arg = string | number | boolean;
type Kid = Node | string | false | undefined | Kid[];

function h(tag: string, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k,v === true ? "" : String(v));
  }
  for (const kid of (kids as unknown[]).flat(Infinity) as Kid[]) if (kid !== undefined && kid !== false) el.append(kid as Node | string);
  return el;
}

/** Storybook's `args` URL parameter: `key:value;…`, with `!` marking a boolean. */
function argsParam(args: Record<string, Arg>): string {
  const safe = (s: string) => /^[\w .-]*$/.test(s);
  return Object.entries(args)
    .filter(([, v]) => typeof v !== "string" || safe(v))
    .map(([k, v]) => `${k}:${typeof v === "boolean" ? `!${v}` : encodeURIComponent(String(v))}`)
    .join(";");
}

/** The address of one story's preview. */
export function previewUrl(storybook: string, story: string, args: Record<string, Arg> = {}): string {
  const extra = argsParam(args);
  return `${storybook.replace(/\/$/, "")}/iframe.html?id=${encodeURIComponent(story)}&viewMode=story${extra ? `&args=${extra}` : ""}`;
}

/** The components whose package, name, model, or a story's name contains every word of the query. */
export function matching(index: ComponentIndex, query: string): Component[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return index.components.filter((c) => {
    const text = [c.package, c.name, c.model?.spec, ...c.stories.map((s) => s.name)].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

const STYLE = `
.cmp { display: grid; grid-template-columns: 240px 1fr; gap: var(--s5); height: 100%; min-height: 0; }
.cmp-list { display: flex; flex-direction: column; gap: var(--s2); min-height: 0; overflow: auto; }
.cmp-list input { padding: var(--s2) var(--s3); border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
.cmp-list h3 { margin: var(--s3) 0 0; font-size: 12px; font-weight: 500; color: var(--muted); }
.cmp-list button, .cmp-stories button { text-align: left; padding: var(--s1) var(--s2); border: 0; border-radius: var(--radius); background: none; cursor: pointer; }
.cmp-list button:hover, .cmp-stories button:hover { background: var(--hover); }
.cmp [aria-current="true"], .cmp [aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); }
.cmp-detail { display: flex; flex-direction: column; gap: var(--s4); min-width: 0; overflow: auto; }
.cmp-detail h2 { margin: 0; font-size: 18px; }
.cmp-detail p { margin: 0; color: var(--muted); }
.cmp-detail iframe { width: 100%; height: 280px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
.cmp-stories, .cmp-controls, .cmp-links { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); align-items: center; }
.cmp-controls label { display: flex; gap: var(--s2); align-items: center; }
.cmp-controls input:not([type="checkbox"]), .cmp-controls select { padding: var(--s1) var(--s2); border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
.cmp-detail table { border-collapse: collapse; width: 100%; }
.cmp-detail td, .cmp-detail th { text-align: left; padding: var(--s1) var(--s3) var(--s1) 0; border-bottom: 1px solid var(--line); font-weight: 400; vertical-align: top; }
.cmp-detail th { color: var(--muted); }
.cmp-detail code { font-family: var(--mono); font-size: 12px; }
.cmp-links button { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; }
.cmp-bad { color: var(--bad); }
@media (max-width: 700px) { .cmp { grid-template-columns: 1fr; } }
`;

const typeOf = (p: Prop) => (p.options ? p.options.map((o) => JSON.stringify(o)).join(" | ") : p.kind);
const isArg = (v: unknown): v is Arg => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** The view. It keeps its own selection, query and edited args; the caller mounts the element. */
export function renderComponents(index: ComponentIndex, options: ComponentsOptions = {}): HTMLElement {
  if (!document.getElementById("cmp-style")) document.head.append(h("style", { id: "cmp-style" }, STYLE));
  const storybook = options.storybook ?? index.storybook.url;
  const root = h("div", { class: "cmp" });
  let query = "";
  let component = index.components[0];
  let story = component?.stories[0];
  let edits: Record<string, Arg> = {};

  const select = (c: Component, s = c.stories[0]) => { component = c; story = s; edits = {}; draw(); };

  function list(): HTMLElement {
    const found = matching(index, query);
    const input = h("input", { type: "search", placeholder: "Search", "aria-label": "Search components", value: query, oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value;
      nav.replaceWith((nav = list()));
      (nav.querySelector("input") as HTMLInputElement).focus();
    } });
    return h("nav", { class: "cmp-list", "aria-label": "Components" }, input,
      [...new Set(found.map((c) => c.package))].map((pkg) => [
        h("h3", {}, pkg),
        found.filter((c) => c.package === pkg).map((c) => h("button", { "aria-current": String(c === component), onclick: () => select(c) }, c.name)),
      ]));
  }

  function control(p: Prop, frame: HTMLIFrameElement | undefined): HTMLElement | false {
    const current = edits[p.name] ?? story?.args[p.name] ?? p.default;
    const set = (v: Arg) => { edits[p.name] = v; if (frame && storybook && story) frame.src = previewUrl(storybook, story.id, edits); };
    if (p.kind === "boolean") return h("label", {}, h("input", { type: "checkbox", checked: current === true, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), p.name);
    if (p.options?.every(isArg)) return h("label", {}, p.name, h("select", { onchange: (e: Event) => set(p.options![(e.target as HTMLSelectElement).selectedIndex] as Arg) },
      p.options.map((o) => h("option", { selected: o === current }, String(o)))));
    if (p.kind === "number") return h("label", {}, p.name, h("input", { type: "number", value: isArg(current) ? String(current) : "", onchange: (e: Event) => set(Number((e.target as HTMLInputElement).value)) }));
    if (p.kind === "string") return h("label", {}, p.name, h("input", { value: isArg(current) ? String(current) : "", onchange: (e: Event) => set((e.target as HTMLInputElement).value) }));
    return false;
  }

  function detail(c: Component): HTMLElement {
    const frame = storybook && story ? (h("iframe", { title: `${c.name}: ${story.name}`, src: previewUrl(storybook, story.id) }) as HTMLIFrameElement) : undefined;
    return h("section", { class: "cmp-detail" },
      h("h2", {}, c.name),
      c.description && h("p", {}, c.description),
      c.diagnostics.map((d) => h("p", { class: "cmp-bad", role: "alert" }, d)),
      frame ?? (c.stories.length > 0 && h("p", {}, "Start Storybook to see previews: pnpm storybook")),
      h("div", { class: "cmp-stories", role: "group", "aria-label": "Stories" },
        c.stories.map((s) => h("button", { "aria-pressed": String(s === story), onclick: () => select(c, s) }, s.name))),
      h("div", { class: "cmp-controls" }, c.props.map((p) => control(p, frame))),
      h("table", {}, h("tbody", {}, c.props.map((p) => h("tr", {},
        h("td", {}, h("code", {}, p.name + (p.required ? "" : "?"))),
        h("td", {}, h("code", {}, typeOf(p))),
        h("td", {}, p.default !== undefined && h("code", {}, JSON.stringify(p.default))),
        h("td", {}, p.description ?? ""))))),
      c.model && h("table", { "aria-label": "Model" }, h("tbody", {},
        h("tr", {}, h("th", {}, "Model"), h("td", {}, h("code", {}, c.model.state))),
        h("tr", {}, h("th", {}, "Events"), h("td", {}, h("code", {}, c.model.events.join("  ")))))),
      h("div", { class: "cmp-links" },
        c.model && h("button", { onclick: () => options.openSpec?.(c.model!.spec) }, c.model.spec),
        (c.design ?? []).map((d) => h("button", { onclick: () => options.openSpec?.(d) }, d)),
        h("button", { onclick: () => options.openSource?.(c.source.file, c.source.line) }, `${c.source.file}:${c.source.line}`)));
  }

  let nav = list();
  function draw() {
    nav = list();
    root.replaceChildren(nav, component ? detail(component) : h("p", {}, "No components yet"));
  }
  draw();
  return root;
}

/** The components that show a model: the way from a spec to its components, stories and source. */
export function componentsOf(index: ComponentIndex, spec: string): Component[] {
  return index.components.filter((c) => c.model?.spec === spec);
}
