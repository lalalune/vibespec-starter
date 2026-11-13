// spec/system.md, "Only a tab's oldest queued edit can be on its way unanswered"; spec/system.md, "An online tab may send its oldest queued edit again at any time"; spec/client.md, "Story: Hear back from the server"
import { type Client, type Event, type Pending, initial, parseEvent, step } from "../../gen/client.ts";
import { parseJson, toRequest } from "../protocol.ts";

/** What a user does to the list. */
export type Edit = Extract<Event, { type: "create" | "setDone" | "rename" | "remove" }>;

const RETRY_MS = 1000;

/** Wait `ms`, or less if `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); done(); };
    const timer = setTimeout(stop, ms);
    signal.addEventListener("abort", stop);
  });
}

/** A browser tab: the generated client machine, driven by the user and the server. */
export class Tab {
  state: Client = initial;
  onChange: (c: Client) => void = () => {};
  readonly name = crypto.randomUUID();
  readonly base: string;
  private closed = new AbortController();
  private stream = new AbortController();
  private sending = false;

  constructor(base: string) {
    this.base = base;
  }

  /** An id no other to-do has: the tab's name and the number of its next edit. */
  newId(): string {
    return `${this.name}-${this.state.made + 1}`;
  }

  private dispatch(e: Event): void {
    this.state = step(this.state, e);
    this.onChange(this.state);
  }

  async edit(e: Edit): Promise<void> {
    this.dispatch(e);
    await this.flush();
  }

  /** Send one queued edit and take in the answer. Returns false if no answer arrived. */
  async send(p: Pending): Promise<boolean> {
    const request = toRequest(this.name, p.seq, p.op);
    try {
      const res = await fetch(`${this.base}/api/events`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
      });
      const a = res.ok ? parseJson(await res.text()) : undefined;
      const type = a?.ok === true ? "receiveAck" : a?.ok === false ? "receiveRefusal" : undefined;
      const answer = type && parseEvent({ ...a, type });
      if (!answer || !("seq" in answer) || answer.seq !== p.seq) return false;
      this.dispatch(answer);
      return true;
    } catch {
      return false;
    }
  }

  /** Send the queue oldest first, one request at a time, until it is empty or the tab goes offline. */
  private async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    for (let p = this.state.pending[0]; this.state.online && p && !this.closed.signal.aborted; p = this.state.pending[0]) {
      if (!(await this.send(p))) await pause(RETRY_MS, this.closed.signal);
    }
    this.sending = false;
  }

  goOffline(): void {
    this.dispatch({ type: "goOffline" });
  }

  /** Back online: follow the server again, from its current list, and send the queue. */
  async goOnline(): Promise<void> {
    this.dispatch({ type: "goOnline" });
    this.listen();
    await this.flush();
  }

  /** Follow the push stream, whose first frame is the current list, reconnecting until the tab closes. */
  listen(): void {
    this.stream.abort();
    this.stream = new AbortController();
    void this.follow(AbortSignal.any([this.closed.signal, this.stream.signal]));
  }

  private async follow(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${this.base}/api/stream?client=${this.name}`, { signal });
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffered = "";
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          const frames = (buffered + r.value).split("\n\n");
          buffered = frames.pop() ?? "";
          for (const f of frames) {
            const push = f.startsWith("data: ") && parseEvent({ ...parseJson(f.slice("data: ".length)), type: "receiveSnapshot" });
            if (push) this.dispatch(push);
          }
        }
      } catch {
        // spec/system.md, "The network may lose or repeat any message"
      }
      await pause(RETRY_MS, signal);
    }
  }

  close(): void {
    this.closed.abort();
  }
}
