// The wire format shared by the backend (src/server.ts) and the frontend
// (src/web/). A request is an event of the generated server machine; an
// answer and a push carry the list and its version, which the generated
// client machine takes as `receiveAck`, `receiveRefusal` or `receiveSnapshot`.
import type { Op, Todo } from "../gen/todo.ts";
import type { Event as Request } from "../gen/server.ts";

/** The server's answer to one request: was it applied, and the list as it now is. */
export interface Answer { ok: boolean; seq: number; version: number; todos: Todo[] }

/** The list at a version, as `GET /api/snapshot` returns it and `GET /api/stream` pushes it. */
export interface Snapshot { version: number; todos: Todo[] }

/** The request that asks the server to apply one queued edit of a client. */
export function toRequest(client: string, seq: number, op: Op): Request | undefined {
  switch (op.kind) {
    case "create": return { type: "create", client, seq, id: op.id, title: op.title };
    case "done": return { type: "setDone", client, seq, id: op.id, done: op.done };
    case "rename": return { type: "rename", client, seq, id: op.id, title: op.title };
    case "remove": return { type: "remove", client, seq, id: op.id };
  }
  return undefined;
}
