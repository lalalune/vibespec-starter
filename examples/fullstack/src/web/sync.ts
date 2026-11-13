// The frontend's network code, with no framework in it: the React page
// (app.ts) and the end-to-end test use the same functions. Everything the
// server says is turned into an event of the generated client machine and
// handed to its `step`; nothing here changes a tab's state directly.
import { type Client, type Event, type Pending, initial, step } from "../../gen/client.ts";
import type { Op } from "../../gen/todo.ts";
import { drain } from "../inbox.ts";
import { type Answer, type Snapshot, toRequest } from "../protocol.ts";

/** Send one queued edit. Returns the answer as a client event, or undefined if the network failed. */
export async function sendEdit(base: string, name: string, p: Pending): Promise<Event | undefined> {
  const request = toRequest(name, p.seq, p.op);
  if (!request) return undefined;
  try {
    const res = await fetch(`${base}/api/events`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    if (!res.ok) return undefined;
    const a = (await res.json()) as Answer;
    return { type: a.ok ? "receiveAck" : "receiveRefusal", seq: a.seq, version: a.version, todos: a.todos };
  } catch {
    return undefined;
  }
}

/** The list as the server has it now, as a client event. */
export async function fetchSnapshot(base: string): Promise<Event> {
  const s = (await (await fetch(`${base}/api/snapshot`)).json()) as Snapshot;
  return { type: "receiveSnapshot", version: s.version, todos: s.todos };
}

/** Read the push stream until `signal` aborts, handing each batch of pushes to `onBatch`. */
export async function listen(base: string, onBatch: (events: Event[]) => void, signal: AbortSignal): Promise<void> {
  try {
    const res = await fetch(`${base}/api/stream`, { signal });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      const events = frames.filter((f) => f.startsWith("data: ")).map((f): Event => {
        const s = JSON.parse(f.slice("data: ".length)) as Snapshot;
        return { type: "receiveSnapshot", version: s.version, todos: s.todos };
      });
      if (events.length) onBatch(events);
    }
  } catch {
    // aborted, or the server went away
  }
}

/** A fresh id for a to-do this tab creates: unique, because the tab's name is. */
export function newId(name: string, c: Client): string {
  return `${name}-${c.made + 1}`;
}

/**
 * A tab without a page: the same machine and the same network code as the
 * React page, driven by method calls. The end-to-end test uses it.
 */
export class Tab {
  state: Client = initial;
  private stop = new AbortController();
  readonly base: string;
  readonly name: string;

  constructor(base: string, name: string) {
    this.base = base;
    this.name = name;
  }

  dispatch(e: Event): void {
    this.state = step(this.state, e);
  }

  /** A user edit: queued at once, and sent if the tab is online. */
  async edit(op: Op): Promise<void> {
    const before = this.state.made;
    const e: Event | undefined =
      op.kind === "create" ? { type: "create", id: op.id, title: op.title }
      : op.kind === "done" ? { type: "setDone", id: op.id, done: op.done }
      : op.kind === "rename" ? { type: "rename", id: op.id, title: op.title }
      : op.kind === "remove" ? { type: "remove", id: op.id }
      : undefined;
    if (e) this.dispatch(e);
    const queued = this.state.pending.find((p) => p.seq === before + 1);
    if (queued && this.state.online) await this.send(queued);
  }

  async send(p: Pending): Promise<void> {
    const answer = await sendEdit(this.base, this.name, p);
    if (answer) this.dispatch(answer);
  }

  goOffline(): void {
    this.dispatch({ type: "goOffline" });
  }

  /** Back online: send the whole queue again and catch up. */
  async goOnline(): Promise<void> {
    this.dispatch({ type: "goOnline" });
    for (const p of [...this.state.pending]) await this.send(p);
    this.dispatch(await fetchSnapshot(this.base));
  }

  listen(): Promise<void> {
    return listen(this.base, (events) => { this.state = drain(this.state, events); }, this.stop.signal);
  }

  close(): void {
    this.stop.abort();
  }
}
