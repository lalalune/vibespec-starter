// spec/client.md, "Story: Edit the list in the browser"; spec/client.md, "Story: Hear back from the server"
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Effect, type Fiber, ManagedRuntime, Stream } from "effect";
import { Button, Checkbox, Input } from "@repo/ui";
import { type Client, canCreate, canRemove, canRename, canSetDone, initial, visible } from "../../gen/client.ts";
import { Tab, browser, newId } from "./sync.vibe";
import "./theme.css";

type Run = (use: (tab: Tab.Shape) => Effect.Effect<unknown, unknown>) => Fiber.Fiber<unknown, unknown>;

/** The React state is a view of the Tab service; every edit goes through its generated machine. */
function TodoPage({ name, run }: { name: string; run: Run }) {
  const [client, render] = useState<Client>(initial);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    const running = [
      run((tab) => Stream.runForEach(tab.changes, (next) => Effect.sync(() => render(next)))),
      run((tab) => tab.listen()),
    ];
    return () => running.forEach((fiber) => fiber.interruptUnsafe());
  }, [run]);

  const id = newId(name, client);
  const unconfirmed = new Set(client.pending.map((pending) => pending.op.id));
  return <main className="mx-auto flex max-w-lg flex-col gap-6 px-4 py-8">
    <header className="flex items-center gap-4">
      <h1 className="flex-1 text-3xl font-semibold tracking-tight">To-do</h1>
      {client.refusals > 0 && <span className="text-destructive" role="status" aria-label={`${client.refusals} edits refused`}>⚠ {client.refusals}</span>}
      <Button variant="ghost" size="icon" aria-label="Online" aria-pressed={client.online} onClick={() => run((tab) => client.online ? tab.dispatch({ type: "goOffline" }) : tab.goOnline())}>
        <span aria-hidden className={`size-3 rounded-full border-2 border-ok ${client.online ? "bg-ok" : "bg-transparent"}`} />
      </Button>
    </header>
    <form className="flex gap-2" onSubmit={(event) => {
      event.preventDefault();
      const title = draft.trim();
      if (!canCreate(client, id, title)) return;
      run((tab) => tab.edit({ type: "create", id, title }));
      setDraft("");
    }}>
      <Input value={draft} aria-label="New to-do" onChange={(event) => setDraft(event.target.value)} />
      <Button type="submit" size="icon" aria-label="Add" disabled={!canCreate(client, id, draft.trim())}>+</Button>
    </form>
    <ul className="m-0 list-none p-0">{visible(client).map((todo) => <li key={todo.id} aria-label={unconfirmed.has(todo.id) ? `${todo.title}, waiting for server` : undefined} className={`flex items-center gap-2 border-b border-border py-2 ${unconfirmed.has(todo.id) ? "border-dashed text-muted-foreground" : ""}`}>
      <Checkbox checked={todo.done} disabled={!canSetDone(client, todo.id, !todo.done)} aria-label={`Mark ${todo.title} ${todo.done ? "incomplete" : "done"}`} onCheckedChange={() => run((tab) => tab.edit({ type: "setDone", id: todo.id, done: !todo.done }))} />
      <Button variant="ghost" className={`flex-1 justify-start ${todo.done ? "text-muted-foreground line-through" : ""}`} aria-label={`Rename ${todo.title}`} onClick={() => {
        const title = window.prompt("Rename", todo.title)?.trim() ?? "";
        if (canRename(client, todo.id, title)) run((tab) => tab.edit({ type: "rename", id: todo.id, title }));
      }}>{todo.title}</Button>
      <Button variant="ghost" size="icon" aria-label={`Remove ${todo.title}`} disabled={!canRemove(client, todo.id)} onClick={() => run((tab) => tab.edit({ type: "remove", id: todo.id }))}>×</Button>
    </li>)}</ul>
  </main>;
}

export function mount(element: Element, base = location.origin): () => void {
  const name = Math.random().toString(36).slice(2, 8);
  const runtime = ManagedRuntime.make(browser(base, name));
  const run: Run = (use) => runtime.runFork(Effect.flatMap(Effect.service(Tab), use));
  const root = createRoot(element);
  root.render(<TodoPage name={name} run={run} />);
  return () => { root.unmount(); void runtime.dispose(); };
}

mount(document.getElementById("root")!);
