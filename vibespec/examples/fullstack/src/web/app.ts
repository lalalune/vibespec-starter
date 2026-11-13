// spec/client.md, "Story: Edit the list in the browser"; spec/client.md, "Story: Hear back from the server"; src/web/sync.ts; src/web/index.html
import { type Client, canCreate, canRemove, canRename, canSetDone, visible } from "../../gen/client.ts";
import type { Todo } from "../../gen/todo.ts";
import { Tab } from "./sync.ts";

/** The part of React this page uses. */
export interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useEffect(effect: () => void | (() => void), deps: unknown[]): void;
  useState<T>(value: T): [T, (value: T) => void];
}
export type CreateRoot = (el: Element) => { render(node: unknown): void };

type Key = { key: string; currentTarget: { value: string } };

export function mount(React: ReactLike, createRoot: CreateRoot, el: Element): void {
  createRoot(el).render(React.createElement(page(React, new Tab(""))));
}

function page(React: ReactLike, tab: Tab) {
  const h = React.createElement;
  return function TodoPage() {
    const [c, setC] = React.useState<Client>(tab.state);
    const [draft, setDraft] = React.useState("");
    const [editing, setEditing] = React.useState<string | undefined>(undefined);
    React.useEffect(() => {
      tab.onChange = setC;
      tab.listen();
      return () => tab.close();
    }, []);

    const waiting = new Set(c.pending.map((p) => p.op.id));
    const id = tab.newId();
    const title = draft.trim();
    const rename = (t: Todo, to: string) => {
      setEditing(undefined);
      if (canRename(c, t.id, to)) void tab.edit({ type: "rename", id: t.id, title: to });
    };
    const row = (t: Todo) =>
      h("li", { key: t.id, "aria-busy": waiting.has(t.id) },
        h("input", {
          type: "checkbox", checked: t.done, disabled: !canSetDone(c, t.id, !t.done),
          "aria-label": `Mark ${t.title} ${t.done ? "not done" : "done"}`,
          onChange: () => void tab.edit({ type: "setDone", id: t.id, done: !t.done }),
        }),
        editing === t.id
          ? h("input", {
            className: "title", defaultValue: t.title, autoFocus: true, "aria-label": `Rename ${t.title}`,
            onKeyDown: (e: Key) => {
              if (e.key === "Enter") rename(t, e.currentTarget.value.trim());
              if (e.key === "Escape") setEditing(undefined);
            },
            onBlur: () => setEditing(undefined),
          })
          : h("button", { type: "button", className: "title", "aria-label": `Rename ${t.title}`, onClick: () => setEditing(t.id) }, t.title),
        h("button", {
          type: "button", className: "icon", "aria-label": `Remove ${t.title}`, disabled: !canRemove(c, t.id),
          onClick: () => void tab.edit({ type: "remove", id: t.id }),
        }, "×"));

    return h("main", null,
      h("header", null,
        h("h1", null, "Shared to-do list"),
        h("span", { className: "refused", role: "status", "aria-label": c.refusals ? `${c.refusals} edits refused` : undefined }, c.refusals ? `! ${c.refusals}` : ""),
        h("button", {
          type: "button", className: "net", "aria-pressed": c.online, "aria-label": "Online",
          onClick: () => (c.online ? tab.goOffline() : void tab.goOnline()),
        })),
      h("form", {
        onSubmit: (e: { preventDefault(): void }) => {
          e.preventDefault();
          if (!canCreate(c, id, title)) return;
          void tab.edit({ type: "create", id, title });
          setDraft("");
        },
      },
        h("input", { value: draft, "aria-label": "New to-do", onChange: (e: { target: { value: string } }) => setDraft(e.target.value) }),
        h("button", { className: "icon", "aria-label": "Add", disabled: !canCreate(c, id, title) }, "+")),
      h("ul", null, ...visible(c).map(row)));
  };
}
