// spec/server.md, "A request is answered only once"; spec/server.md, "A new request can be refused, which is logged with its edit and changes nothing else"; spec/client.md, "Story: Hear back from the server"
import fs from "node:fs";
import http from "node:http";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { type Server, acceptedAs, answered, enabled, initial, parseEvent, step } from "../gen/server.ts";
import { type Answer, type Snapshot, opOf } from "./protocol.ts";

/** The server machine and the tabs listening for changes. */
export class TodoStore {
  state: Server = initial;
  private listeners = new Set<(s: Snapshot) => void>();

  snapshot(): Snapshot {
    return { version: this.state.version, todos: this.state.todos };
  }

  subscribe(listener: (s: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The answer to `input` from the network, or undefined if it is not a request a client may send. */
  handle(input: unknown): Answer | undefined {
    const event = parseEvent(input);
    if (!event || event.type === "refuse") return undefined;
    const { client, seq } = event;
    const op = opOf(event);
    if (answered(this.state, client, seq)) return this.answer(acceptedAs(this.state, client, seq, op), seq);
    if (enabled(this.state, event)) {
      this.state = step(this.state, event);
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
      return this.answer(true, seq);
    }
    this.state = step(this.state, { type: "refuse", client, seq, op });
    return this.answer(false, seq);
  }

  private answer(ok: boolean, seq: number): Answer {
    return { ok, seq, ...this.snapshot() };
  }
}

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVED = /^\/(src|gen)\/[A-Za-z0-9_/.-]+\.ts$/;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The HTTP API and the frontend's files. */
export function createServer(store = new TodoStore()): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/api/events") {
        // src/web/sync.ts sends JSON; a cross-site page cannot without a CORS preflight, which is never granted.
        if (!req.headers["content-type"]?.startsWith("application/json")) return sendJson(res, 415, { error: "send application/json" });
        const text = await readBody(req);
        let input: unknown;
        try { input = text === undefined ? undefined : JSON.parse(text); } catch { input = undefined; }
        const answer = store.handle(input);
        return answer ? sendJson(res, 200, answer) : sendJson(res, 400, { error: "not a well-formed request" });
      }
      if (req.method === "GET" && url.pathname === "/api/snapshot") return sendJson(res, 200, store.snapshot());
      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const push = (s: Snapshot) => res.write(`data: ${JSON.stringify(s)}\n\n`);
        push(store.snapshot());
        const stop = store.subscribe(push);
        req.on("close", stop);
        return;
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(path.join(ROOT, "src/web/index.html")));
      }
      if (req.method === "GET" && SERVED.test(url.pathname) && !url.pathname.includes("..")) {
        const file = path.join(ROOT, url.pathname);
        if (fs.existsSync(file)) {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          return res.end(stripTypeScriptTypes(fs.readFileSync(file, "utf8")));
        }
      }
      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  });
}
