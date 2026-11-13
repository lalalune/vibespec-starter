// spec/index.md, "Story: Keep a short list"
import { Alert, Button, Checkbox, Input, Progress } from "@repo/ui";
import { Cause, Exit } from "effect";
import { useRef, useState } from "react";
import { type Event, limit } from "../gen/index.ts";
import { NotSaved } from "./tasks.vibe";
import { type Runtime, useTasks } from "./useTasks.ts";

/**
 * The task list: a control is enabled exactly when the rules allow its event.
 * @model spec/index.md
 */
export function App({ runtime }: { runtime: Runtime }) {
  const { tasks, can, send } = useTasks(runtime);
  const [draft, setDraft] = useState("");
  const [unsaved, setUnsaved] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  if (!tasks) return null;
  if (tasks === "unreadable") return <main className="mx-auto max-w-md p-6"><Alert variant="destructive">The list cannot be read</Alert></main>;

  /** Whether `event` was taken. One the rules refuse is no failure to save: the list shown was behind the stored one. */
  const run = async (event: Event) => {
    const exit = await send(event);
    setUnsaved(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof NotSaved);
    return Exit.isSuccess(exit);
  };
  const add = async () => {
    if (!await run({ type: "add", title: draft })) return;
    setDraft("");
    titleRef.current?.focus();
  };
  const row = (name: string, done: boolean) => (
    <li key={name} className="flex items-center gap-3">
      <Checkbox aria-label={`Complete ${name}`} checked={done} disabled={!can({ type: "complete", title: name })} onCheckedChange={() => void run({ type: "complete", title: name })} />
      <span className={done ? "flex-1 text-muted-foreground line-through" : "flex-1"}>{name}</span>
      <Button variant="ghost" size="icon" aria-label={`Remove ${name}`} disabled={!can({ type: "remove", title: name })} onClick={() => void run({ type: "remove", title: name })}>×</Button>
    </li>
  );

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Tasks</h1>
      <Progress aria-label="Open tasks" value={tasks.open.length} max={limit} />
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <Input ref={titleRef} aria-label="New task" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit" disabled={!can({ type: "add", title: draft })}>Add</Button>
      </form>
      {unsaved && <Alert variant="destructive">Not saved</Alert>}
      <ul className="flex flex-col gap-2">
        {tasks.open.map((name) => row(name, false))}
        {tasks.done.map((name) => row(name, true))}
      </ul>
    </main>
  );
}
