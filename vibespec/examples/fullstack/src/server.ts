// spec/server.md, "A request is answered only once"; spec/server.md, "A new request can be refused, which is logged with its edit and changes nothing else"; spec/system.md, "The server takes any request off the network and answers it"
import fs from "node:fs";
import http from "node:http";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { type Server, acceptedAs, answered, enabled, initial, parseEvent, step } from "../gen/server.ts";
import { type Answer, type Snapshot, opOf, parseJson } from "./protocol.ts";

type Listener = (s: Snapshot) => void;

/** The server machine and the tabs listening for changes, each under its client's name. */
export class TodoStore {
  state: Server = initial;
  private listeners = new Map<Listener, string | null>();

  snapshot(): Snapshot {
    return { version: this.state.version, todos: this.state.todos };
  }

  subscribe(client: string | null, listener: Listener): () => void {
    this.listeners.set(listener, client);
    return () => this.listeners.delete(listener);
  }

  /** Answer one request, or undefined for input that is not a request a client may send. */
  handle(input: unknown): Answer | undefined {
    const event = parseEvent(input);
    if (!event || event.type === "refuse") return undefined;
    const { client, seq } = event;
    const op = opOf(event);
    if (answered(this.state, client, seq)) return this.answer(acceptedAs(this.state, client, seq, op), seq);
    if (enabled(this.state, event)) {
      this.state = step(this.state, event);
      const snapshot = this.snapshot();
      for (const [listener, who] of this.listeners) if (who !== client) listener(snapshot);
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
const BODY_LIMIT = 64 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The whole body, or undefined if it is over BODY_LIMIT; read to the end either way. */
async function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= BODY_LIMIT) chunks.push(chunk as Buffer);
  }
  return size <= BODY_LIMIT ? Buffer.concat(chunks).toString("utf8") : undefined;
}

/** The HTTP API and the frontend's files. */
export function createServer(store = new TodoStore()): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/api/events") {
        const text = await readBody(req);
        if (text === undefined) return sendJson(res, 413, { error: "request too large" });
        const answer = store.handle(parseJson(text));
        return answer ? sendJson(res, 200, answer) : sendJson(res, 400, { error: "not a well-formed request" });
      }
      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const push = (s: Snapshot) => res.write(`data: ${JSON.stringify(s)}\n\n`);
        push(store.snapshot());
        req.on("close", store.subscribe(url.searchParams.get("client"), push));
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
      console.error(e);
      sendJson(res, 500, { error: "internal error" });
    }
  });
}
