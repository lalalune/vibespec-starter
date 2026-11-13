# Shared to-do list, modelled end to end

A Node.js backend and a React page share one to-do list between browser tabs
that may go offline. Both run the machines generated from `spec/`; a fourth
spec puts the server, two tabs and an unreliable network together.

```sh
npm run check      # the whole pipeline (from this directory)
npm start          # then open http://localhost:3000 in two windows
```

Needs Node 24+ and Dafny on the path. The page loads React 18 from esm.sh.

| Path | Kind | Covers |
|---|---|---|
| `spec/todo.md` | library | A to-do, the four edits, when an edit makes sense, how it is applied |
| `spec/server.md` | machine | One request per edit, answered once, version = number of changes, ids never reused |
| `spec/client.md` | machine | One tab: confirmed copy, queue of unanswered edits, offline, answers and pushes |
| `spec/system.md` | machine | Server + tabs `a` and `b` + a lossy, repeating, reordering network + forged requests |
| `spec/*.proof.dfy` | proofs | What Dafny could not prove alone |
| `src/server.ts`, `src/main.ts` | backend shell | `POST /api/events`, `GET /api/snapshot`, `GET /api/stream`, the page's files |
| `src/protocol.ts` | shared shell | Wire format |
| `src/web/` | frontend shell | React page and the network code it shares with `test/e2e.test.ts` |

```mermaid
sequenceDiagram
  participant A as tab a
  participant S as src/server.ts
  participant B as tab b
  Note over A: create / setDone / rename / remove<br/>queued with id "a-n"
  A->>S: POST /api/events (oldest queued edit only)
  Note over S: TodoStore.handle: parseEvent, then step or refuse<br/>same client + seq + edit = retry, applied once
  S-->>A: Answer → receiveAck / receiveRefusal
  S-->>B: /api/stream push → receiveSnapshot
```

## Proved, simulated, tested, trusted

- **Proved**: every transition of server, client and system keeps every
  `always` and `step` rule, and every law holds. `npm run check` gives the count.
- **Simulated**: the `sometimes` rules, among them that both tabs can finish
  their edits and agree with the server despite loss, duplication and reordering.
- **Tested**: the HTTP shell and two tabs against the real server (`test/`).
- **Trusted**: `src/`, React, the generator, Dafny and Quint.

## Limits of the spec language met here

- **A machine cannot be imported with `.*`**; the system spec uses `S::` and `C::`.
- **Proofs about an imported machine's transitions cannot be reused**, so the
  server and client restate "a commit / refusal / queued edit / answer keeps
  the rules" as laws, which `system.proof.dfy` calls.
- **No equality on records or lists**: `sameTodos` is a fold with a position counter.
- **No list indexing besides `nth`**: taking the i-th message off the network is a fold (`dropAt`).
- **Folds over records need a named type**, hence `Walk` and `Cut`.
- **A helper that takes the state first and returns it is a transition**, so
  `commit`, `queue` and `withClient` take it second.
