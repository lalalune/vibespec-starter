// spec/system.md, "Only a tab's oldest queued edit can be on its way unanswered"; spec/client.md, "Story: Hear back from the server"
// Shared by app.ts and test/e2e.test.ts.
import { type Client, type Event, type Pending, initial, parseEvent, step } from "../../gen/client.ts";
import { toRequest } from "../protocol.ts";

/** How long a tab waits before it tries the network again. */
export const RETRY_MS = 2000;

const snapshotEvent = (s: unknown) => parseEvent({ ...(s as object), type: "receiveSnapshot" });

/** Send one queued edit. Returns the answer as a client event, or undefined if the network failed. */
async function sendEdit(base: string, name: string, p: Pending): Promise<Event | undefined> {
  try {
    const res = await fetch(`${base}/api/events`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toRequest(name, p.seq, p.op)),
    });
    if (!res.ok) return undefined;
    const a = (await res.json()) as { ok?: unknown } | null;
    const event = typeof a?.ok === "boolean" ? parseEvent({ ...a, type: a.ok ? "receiveAck" : "receiveRefusal" }) : undefined;
    return event && "seq" in event && event.seq === p.seq ? event : undefined;
  } catch {
    return undefined;
  }
}

/** The answer to the oldest queued edit of an online tab, or undefined if it has none to send. */
export function sendOldest(name: string, c: Client, base = ""): Promise<Event | undefined> | undefined {
  const p = c.pending[0];
  return c.online && p ? sendEdit(base, name, p) : undefined;
}

/** The list as the server has it now, as a client event, or undefined if the network failed. */
export async function fetchSnapshot(base = ""): Promise<Event | undefined> {
  try {
    const res = await fetch(`${base}/api/snapshot`);
    return res.ok ? snapshotEvent(await res.json()) : undefined;
  } catch {
    return undefined;
  }
}

/** Hand every push to `onEvent` until `signal` aborts, reconnecting whenever the stream ends. */
export async function listen(onEvent: (e: Event) => void, signal: AbortSignal, base = ""): Promise<void> {
  while (!signal.aborted) {
    try {
      const reader = (await fetch(`${base}/api/stream`, { signal })).body!.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        const frames = (buffered + decoder.decode(r.value, { stream: true })).split("\n\n");
        buffered = frames.pop() ?? "";
        for (const f of frames) {
          const event = f.startsWith("data: ") ? snapshotEvent(JSON.parse(f.slice("data: ".length))) : undefined;
          if (event) onEvent(event);
        }
      }
    } catch {
      // aborted, or the server went away: server.ts sends the current list first on the next connection
    }
    if (!signal.aborted) await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

/** A fresh id for a to-do this tab creates: unique, because the tab's name is. */
export function newId(name: string, c: Client): string {
  return `${name}-${c.made + 1}`;
}

/** A tab without a page, driven by method calls: the same machine and network code as app.ts. */
export class Tab {
  state: Client = initial;
  private stop = new AbortController();
  readonly base: string;
  readonly name: string;

  constructor(base: string, name: string) {
    this.base = base;
    this.name = name;
  }

  dispatch(e: Event | undefined): void {
    if (e) this.state = step(this.state, e);
  }

  /** A user edit: queued at once, and sent if the tab is online and has nothing else queued. */
  async edit(e: Event): Promise<void> {
    this.dispatch(e);
    if (this.state.pending.length === 1) await this.flush();
  }

  /** Send one queued edit and take in the answer, as a retry does. */
  async send(p: Pending): Promise<void> {
    this.dispatch(await sendEdit(this.base, this.name, p));
  }

  /** Send the queue oldest first, one request at a time, until it is empty or the network fails. */
  async flush(): Promise<void> {
    for (let sent = sendOldest(this.name, this.state, this.base); sent; sent = sendOldest(this.name, this.state, this.base)) {
      const answer = await sent;
      if (!answer) return;
      this.dispatch(answer);
    }
  }

  goOffline(): void {
    this.dispatch({ type: "goOffline" });
  }

  /** Back online, as app.ts does it: catch up, then send the queue. */
  async goOnline(): Promise<void> {
    this.dispatch({ type: "goOnline" });
    this.dispatch(await fetchSnapshot(this.base));
    await this.flush();
  }

  listen(): Promise<void> {
    return listen((e) => this.dispatch(e), this.stop.signal, this.base);
  }

  close(): void {
    this.stop.abort();
  }
}
