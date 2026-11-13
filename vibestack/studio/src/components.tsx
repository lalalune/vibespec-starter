import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Checkbox, Input, Label } from "@repo/ui";
import type { Component, ComponentIndex, Prop } from "@repo/storybook";
export type { Component, ComponentIndex, Prop, Story } from "@repo/storybook";

export interface ComponentsOptions {
  storybook?: string;
  openSpec?: (path: string) => void;
  openSource?: (file: string, line: number) => void;
}
type Arg = string | number | boolean;
const isArg = (value: unknown): value is Arg => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Storybook's primitive argument encoding; arbitrary object values stay in the generated story. */
export function previewUrl(storybook: string, story: string, args: Record<string, Arg> = {}): string {
  const values = Object.entries(args).filter(([key, value]) => /^[\w.-]+$/.test(key) && (typeof value !== "string" || /^[\w .-]*$/.test(value)))
    .map(([key, value]) => `${key}:${typeof value === "boolean" ? `!${value}` : encodeURIComponent(String(value))}`).join(";");
  return `${storybook.replace(/\/$/, "")}/iframe.html?id=${encodeURIComponent(story)}&viewMode=story${values ? `&args=${values}` : ""}`;
}
export function matching(index: ComponentIndex, query: string): Component[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return index.components.filter((c) => {
    const text = [c.package, c.name, c.model?.spec, ...c.stories.map((s) => s.name)].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
export const componentsOf = (index: ComponentIndex, spec: string) => index.components.filter((c) => c.model?.spec === spec);

/** Catalog selection and preview controls are local UI state; domain state remains in each story's machine. */
export function Components({ index, ...options }: ComponentsOptions & { index: ComponentIndex }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(index.components[0]?.id);
  const [storyId, setStoryId] = useState<string>();
  const [edits, setEdits] = useState<Record<string, Arg>>({});
  const component = index.components.find((c) => c.id === selected) ?? index.components[0];
  const story = component?.stories.find((s) => s.id === storyId) ?? component?.stories[0];
  const storybook = options.storybook ?? index.storybook.url;
  const args = { ...Object.fromEntries(Object.entries(story?.args ?? {}).filter((entry): entry is [string, Arg] => isArg(entry[1]))), ...edits };
  const select = (c: Component, id?: string) => { setSelected(c.id); setStoryId(id); setEdits({}); };
  const set = (prop: Prop, value: Arg) => setEdits((before) => ({ ...before, [prop.name]: value }));
  const found = matching(index, query);
  return <section className="grid h-full min-h-0 gap-6 md:grid-cols-4" aria-label="Components">
    <nav className="flex min-h-0 flex-col gap-2 overflow-auto" aria-label="Component catalog">
      <Input type="search" aria-label="Search components" value={query} onChange={(event) => setQuery(event.target.value)} />
      {[...new Set(found.map((c) => c.package))].map((pkg) => <div key={pkg} className="flex flex-col gap-2">
        <span className="text-sm text-muted-foreground">{pkg}</span>
        {found.filter((c) => c.package === pkg).map((c) => <Button key={c.id} variant={c.id === selected ? "secondary" : "ghost"} aria-current={c.id === selected ? "true" : undefined} className="justify-start" onClick={() => select(c)}>{c.name}</Button>)}
      </div>)}
    </nav>
    {component ? <div className="flex min-w-0 flex-col gap-4 overflow-auto md:col-span-3">
      <h1 className="text-lg font-semibold">{component.name}</h1>
      {component.diagnostics.map((diagnostic) => <p className="text-destructive" role="alert" key={diagnostic}>{diagnostic}</p>)}
      {storybook && story && <iframe title={`${component.name}: ${story.name}`} className="h-72 w-full rounded-lg border border-border bg-background" src={previewUrl(storybook, story.id, args)} />}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Stories">{component.stories.map((s) => <Button key={s.id} variant={s.id === story?.id ? "secondary" : "ghost"} aria-pressed={s.id === story?.id} onClick={() => select(component, s.id)}>{s.name}</Button>)}</div>
      <div className="flex flex-wrap gap-4">{component.props.map((prop) => {
        const value = args[prop.name] ?? prop.default;
        if (prop.kind === "boolean") return <Label key={prop.name} className="flex items-center gap-2"><Checkbox checked={value === true} onCheckedChange={(checked) => set(prop, checked === true)} />{prop.name}</Label>;
        if (prop.kind === "string" || prop.kind === "number") return <Label key={prop.name}>{prop.name}<Input value={isArg(value) ? String(value) : ""} type={prop.kind === "number" ? "number" : "text"} onChange={(event) => set(prop, prop.kind === "number" ? Number(event.target.value) : event.target.value)} /></Label>;
        if (prop.options?.every(isArg)) return <Label key={prop.name}>{prop.name}<select className="rounded-md border border-input bg-background p-2" value={prop.options.findIndex((option) => option === value)} onChange={(event) => set(prop, prop.options![Number(event.target.value)] as Arg)}>{prop.options.map((option, i) => <option key={String(option)} value={i}>{String(option)}</option>)}</select></Label>;
        return null;
      })}</div>
      <table className="w-full text-left text-sm"><tbody>{component.props.map((prop) => <tr key={prop.name} className="border-b border-border"><th className="p-2 font-medium">{prop.name}{prop.required ? "" : "?"}</th><td className="p-2">{prop.options?.map(String).join(" | ") ?? prop.kind}</td><td className="p-2">{prop.description}</td></tr>)}</tbody></table>
      {component.model && <dl className="grid grid-cols-2 gap-2 text-sm"><dt>State</dt><dd>{component.model.state}</dd><dt>Events</dt><dd>{component.model.events.join(", ")}</dd></dl>}
      <div className="flex flex-wrap gap-2">
        {component.model && <Button variant="ghost" onClick={() => options.openSpec?.(component.model!.spec)}>{component.model.spec}</Button>}
        {component.design?.map((file) => <Button key={file} variant="ghost" onClick={() => options.openSpec?.(file)}>{file}</Button>)}
        <Button variant="ghost" onClick={() => options.openSource?.(component.source.file, component.source.line)}>{component.source.file}:{component.source.line}</Button>
      </div>
    </div> : <p className="text-muted-foreground">No components</p>}
  </section>;
}

/** Mount the React catalog in a host that already loads the shared Tailwind theme. */
export function renderComponents(index: ComponentIndex, options: ComponentsOptions = {}): HTMLElement {
  const element = document.createElement("div");
  createRoot(element).render(<Components index={index} {...options} />);
  return element;
}
