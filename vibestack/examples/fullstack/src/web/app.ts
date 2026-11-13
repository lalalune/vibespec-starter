// spec/client.md, "Story: Edit the list in the browser"; spec/client.md, "Story: Hear back from the server"
// The React page: the part of the frontend that touches the DOM, which a
// `.vibe` file cannot. Its state is the client of spec/client.md that the Tab
// of sync.vibe holds: the page renders every state the tab publishes, and a
// click runs one of the tab's effects, so an event the rules do not allow
// changes nothing. React comes from a CDN through the import map in
// index.html and is passed in, so this file needs no React type declarations.
import { Effect, type Fiber, ManagedRuntime, Stream } from "effect";
import { type Client, canCreate, canRemove, canRename, canSetDone, initial, visible } from "../../gen/client.ts";
import type { Todo } from "../../gen/todo.ts";
import { Tab, browser, newId } from "./sync.vibe";

/** The part of React this page uses. */
export interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useEffect(effect: () => void | (() => void), deps: unknown[]): void;
  useState<T>(value: T): [T, (value: T) => void];
}
export type CreateRoot = (el: Element) => { render(node: unknown): void };

/** Start one of the tab's effects. */
type Run = (use: (tab: Tab.Shape) => Effect.Effect<unknown, unknown>) => Fiber.Fiber<unknown, unknown>;

export function mount(React: ReactLike, createRoot: CreateRoot, el: Element, base = location.origin): void {
  const name = Math.random().toString(36).slice(2, 8);
  const runtime = ManagedRuntime.make(browser(base, name));
  const run: Run = (use) => runtime.runFork(Effect.flatMap(Effect.service(Tab), use));
  createRoot(el).render(React.createElement(page(React, name, run)));
}

function page(React: ReactLike, name: string, run: Run) {
  const h = React.createElement;
  return function TodoPage() {
    const [c, render] = React.useState<Client>(initial);
    const [draft, setDraft] = React.useState("");

    // spec/client.md, "Story: Hear back from the server"
    React.useEffect(() => {
      const open = [
        run((tab) => Stream.runForEach(tab.changes, (next) => Effect.sync(() => render(next)))),
        run((tab) => tab.listen()),
      ];
      return () => open.forEach((fiber) => fiber.interruptUnsafe());
    }, []);

    const id = newId(name, c);
    const unconfirmed = new Set(c.pending.map((p) => p.op.id));
    const row = (t: Todo) =>
      h("li", { key: t.id, className: unconfirmed.has(t.id) ? "unconfirmed" : undefined },
        h("input", {
          type: "checkbox", checked: t.done, disabled: !canSetDone(c, t.id, !t.done),
          "aria-label": `Mark ${t.title} ${t.done ? "incomplete" : "done"}`,
          onChange: () => run((tab) => tab.edit({ type: "setDone", id: t.id, done: !t.done })),
        }),
        h("button", {
          type: "button", className: "title", "aria-label": `Rename ${t.title}`,
          onClick: () => {
            const title = window.prompt("Rename", t.title)?.trim() ?? "";
            if (canRename(c, t.id, title)) run((tab) => tab.edit({ type: "rename", id: t.id, title }));
          },
        }, t.title),
        h("button", { type: "button", className: "icon", "aria-label": `Remove ${t.title}`, disabled: !canRemove(c, t.id), onClick: () => run((tab) => tab.edit({ type: "remove", id: t.id })) }, "×"));

    return h("main", null,
      h("header", null,
        h("h1", null, "To-do"),
        c.refusals > 0 && h("span", { className: "refused", role: "status", "aria-label": `${c.refusals} edits refused` }, `⚠ ${c.refusals}`),
        h("button", {
          type: "button", className: "online", "aria-label": "Online", "aria-pressed": c.online,
          onClick: () => run((tab) => (c.online ? tab.dispatch({ type: "goOffline" }) : tab.goOnline())),
        })),
      h("form", {
        onSubmit: (e: { preventDefault(): void }) => {
          e.preventDefault();
          if (!canCreate(c, id, draft.trim())) return;
          run((tab) => tab.edit({ type: "create", id, title: draft.trim() }));
          setDraft("");
        },
      },
        h("input", { value: draft, "aria-label": "New to-do", onChange: (e: { target: { value: string } }) => setDraft(e.target.value) }),
        h("button", { className: "icon", "aria-label": "Add", disabled: !canCreate(c, id, draft.trim()) }, "+")),
      h("ul", null, ...visible(c).map(row)));
  };
}
