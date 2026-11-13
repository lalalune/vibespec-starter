// spec/client.md, "Story: Edit the list in the browser"; spec/client.md, "Story: Hear back from the server"; spec/system.md, "Only a tab's oldest queued edit can be on its way unanswered"
// React comes from the import map in index.html.
import { type Client, type Event, canCreate, canRemove, canRename, canSetDone, initial, step, visible } from "../../gen/client.ts";
import type { Todo } from "../../gen/todo.ts";
import { RETRY_MS, fetchSnapshot, listen, newId, sendOldest } from "./sync.ts";

/** The part of React this page uses. */
export interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useReducer<S, A>(reducer: (state: S, action: A) => S, init: S): [S, (action: A) => void];
  useEffect(effect: () => void | (() => void), deps: unknown[]): void;
  useRef<T>(value: T): { current: T };
  useState<T>(value: T): [T, (value: T) => void];
}
export type CreateRoot = (el: Element) => { render(node: unknown): void };

export function mount(React: ReactLike, createRoot: CreateRoot, el: Element): void {
  const name = Math.random().toString(36).slice(2, 8);
  createRoot(el).render(React.createElement(page(React, name)));
}

function page(React: ReactLike, name: string) {
  const h = React.createElement;
  return function TodoPage() {
    const [c, dispatch] = React.useReducer<Client, Event>(step, initial);
    const [draft, setDraft] = React.useState("");
    const [retry, setRetry] = React.useState(0);
    const inFlight = React.useRef(false);

    React.useEffect(() => {
      const stop = new AbortController();
      void listen(dispatch, stop.signal);
      return () => stop.abort();
    }, []);

    React.useEffect(() => {
      const sent = inFlight.current ? undefined : sendOldest(name, c);
      if (!sent) return;
      inFlight.current = true;
      void sent.then((answer) => {
        inFlight.current = false;
        if (answer) dispatch(answer);
        else setTimeout(() => setRetry(Date.now()), RETRY_MS);
      });
    }, [c, retry]);

    const goOnline = async () => {
      dispatch({ type: "goOnline" });
      const snapshot = await fetchSnapshot();
      if (snapshot) dispatch(snapshot);
    };
    const id = newId(name, c);
    const title = draft.trim();
    const unconfirmed = new Set(c.pending.map((p) => p.op.id));
    const row = (t: Todo) =>
      h("li", { key: t.id, className: unconfirmed.has(t.id) ? "unconfirmed" : undefined },
        h("input", {
          type: "checkbox", checked: t.done, disabled: !canSetDone(c, t.id, !t.done),
          "aria-label": `Mark ${t.title} ${t.done ? "not done" : "done"}`,
          onChange: () => dispatch({ type: "setDone", id: t.id, done: !t.done }),
        }),
        h("button", {
          type: "button", className: "title", "aria-label": `Rename ${t.title}`,
          onClick: () => {
            const renamed = window.prompt("Rename", t.title)?.trim() ?? "";
            if (canRename(c, t.id, renamed)) dispatch({ type: "rename", id: t.id, title: renamed });
          },
        }, t.title),
        h("button", {
          type: "button", className: "icon", "aria-label": `Remove ${t.title}`, disabled: !canRemove(c, t.id),
          onClick: () => dispatch({ type: "remove", id: t.id }),
        }, "×"));

    return h("main", null,
      h("header", null,
        h("h1", null, "To-do"),
        c.refusals > 0 && h("span", { className: "refused", role: "status", "aria-label": `${c.refusals} edits refused` }, `⚠ ${c.refusals}`),
        h("button", {
          type: "button", className: "online", "aria-label": "Online", "aria-pressed": c.online,
          onClick: () => (c.online ? dispatch({ type: "goOffline" }) : void goOnline()),
        })),
      h("form", {
        onSubmit: (e: { preventDefault(): void }) => {
          e.preventDefault();
          if (!canCreate(c, id, title)) return;
          dispatch({ type: "create", id, title });
          setDraft("");
        },
      },
        h("input", { value: draft, "aria-label": "New to-do", onChange: (e: { target: { value: string } }) => setDraft(e.target.value) }),
        h("button", { className: "icon", "aria-label": "Add", disabled: !canCreate(c, id, title) }, "+")),
      h("ul", null, ...visible(c).map(row)));
  };
}
