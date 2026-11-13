# Shared to-do list, modelled end to end

A small full-stack application: a Node.js backend with an HTTP API and a
React page, sharing one to-do list between browser tabs that may go offline.
Both halves run the state machines generated from `spec/`, and a fourth spec
puts the server, two tabs and an unreliable network together and checks the
rules only the whole system can state.

```sh
npm run check      # the whole pipeline (from this directory)
npm start          # then open http://localhost:3000 in two windows
```

Needs Node 24+ (the server strips TypeScript types itself, so there is no
build step) and Dafny on the path. The page loads React 18 from esm.sh.

| Path | Kind | What it covers |
|---|---|---|
| `spec/todo.md` | library, 4 laws | A to-do, the four edits, when an edit makes sense, how it is applied, list equality |
| `spec/server.md` | state machine, 5 transitions | The backend: one request per edit, each request answered once and recognised as a retry only with the same edit, version = number of changes, ids never reused |
| `spec/client.md` | state machine, 9 transitions | One tab: confirmed copy + queue of unanswered edits, optimistic view, offline, answers and pushes |
| `spec/system.md` | state machine, 9 transitions | Server + tabs `a` and `b` + a network that loses, repeats and reorders + anyone forging requests in a tab's name; a ghost history of every version |
| `spec/*.proof.dfy` | proofs | Everything Dafny could not prove alone (uniqueness under append/filter/map, fold lemmas, the system rules) |
| `src/server.ts`, `src/main.ts` | backend shell, tested | `node:http`: `POST /api/events`, `GET /api/snapshot`, `GET /api/stream` (server-sent pushes), and the frontend's files |
| `src/protocol.ts` | shared shell | Wire format; a queued edit as a server event |
| `src/web/app.ts`, `index.html` | frontend shell | React page; `useReducer` with the generated client `step` |
| `src/web/sync.ts` | frontend shell, tested | fetch/stream code shared by the page and the end-to-end test |
| `src/inbox.ts` | hand-written, proved | `drain`: a batch of pushes applied in a loop, proved to keep the client's rules |
| `test/` | tests | server over HTTP, the reducer, two tabs converging against the real server |

## How the halves fit

- **Backend.** `TodoStore.handle` passes the request body through
  `parseEvent` of `gen/server.ts`, and answers 400 to `refuse`, which only
  the server may decide. A request whose client and number the log already
  holds is not applied again: it is told it was accepted only if the log
  accepted that same edit (`acceptedAs`), so a request that reuses a number
  for another edit is refused rather than taken for a retry. A new request is
  applied with `step` if `enabled` says so, and otherwise refused with the
  machine's `refuse` event, which is logged too. Every change is pushed to
  the open tabs. The rules are checked once, of the initial state; every
  transition is proved to keep them.
- **Frontend.** The page's state is a `Client` and its reducer is `step` from
  `gen/client.ts`. Clicks dispatch `create`/`setDone`/`rename`/`remove`;
  answers dispatch `receiveAck`/`receiveRefusal`; pushes dispatch
  `receiveSnapshot`. Buttons are enabled by the generated guards
  (`canCreate`, …). The page keeps one request in flight: it sends the
  oldest queued edit, and the next once that one is answered, also after
  coming back online. Sending the whole queue at once would let the network
  reorder a user's own edits, so that ticking off a to-do could arrive
  before creating it and be refused; the system spec requires that a user
  editing alone is never refused.
- **Ids.** A tab names a new to-do `<tab>-<n>`, so it can create and edit
  to-dos offline. Removing leaves a tombstone, so an id is never reused.

## What is proved, simulated and trusted

- **Proof obligations** (205, none accepted as simulated only): every
  transition of the server, the client and the system must keep every
  `always` and `step` rule, every law must hold, and `drain` must meet its
  contract. `npm run check` reports the current proof result. At the system
  level that includes: each part keeps its
  own rules, no tab is ahead of the server, and every copy of the list, in a
  tab or in flight, is exactly the list as it was at the version it carries.
- **Simulated**: all of the above on 10,000 random traces per spec, and the
  `sometimes` rules, among them that two tabs that both edited can converge
  on the server's list despite loss, duplication and reordering.
- **Tested**: the HTTP shell, the push stream, the page's network code and a
  two-tab run against the real server (`test/`).
- **Trusted**: the shell (`src/server.ts`, `src/web/`), React, the
  generator, LemmaScript, Dafny and Quint. Convergence is a `sometimes`
  rule: the model shows it can happen, not that it always does; a `leadsTo`
  rule could say it always does (see "Simplifying it").

## What the checks found

- **A negative edit count.** The client rule "every queued edit was numbered
  here" could not be proved for a new edit: nothing said `made` is not
  negative, and with a negative count the next number is below 1. Now a
  rule, marked "Discovered by the proof".
- **Copies in flight need a rule of their own.** "A tab's copy is the list at
  its version" is only inductive together with the same statement for every
  answer on the network; the system spec states both.
- **A request number does not identify its edit.** A retry must carry the
  same edit before an earlier acceptance can acknowledge it.
- **A user's dependent edits must arrive in order.** Sending the oldest
  unanswered edit first prevents a later edit reaching the server before
  the to-do it changes has been created.
- **The forgery count is nonnegative.** Otherwise a forgery could change a
  negative count to zero and incorrectly restore the lone-user guarantee.

## Limits of the spec language met here

- **A machine cannot be imported with `.*`**, and two machines whose
  transitions share names (`create`, `initial`) could not be anyway; the
  system spec uses `S::` and `C::`.
- **Folds over records need a named type.** `foldl` with an anonymous record
  accumulator is refused (`unsupported type rec`), hence `Walk` and `Cut`.
- **A helper that takes the state first and returns it is a transition**, so
  helpers such as `commit`, `queue`, `withClient` take it second.
- **Two specs that define the same name cannot be imported `.*` together**,
  so the library's sample sets have their own names (`changeValues`,
  `xsValues`).
- **The HTTP and React layers are outside the model.** Retry timing, the
  push stream and the DOM are tested, not proved.

## Simplifying it

The specs were written before the tools could do the following, and still
work around their absence. Each is a good first exercise:

- **Imported types.** The server and client state types write the to-do and
  edit records out in full (the tools match them back to `Todo` and `Op` by
  shape), and the edit's kind is a string. An imported machine now brings the
  types it imports along (selftest: "a machine whose state holds a library's
  type can be imported under a name"), so they can use `Todo` and `Op`.
- **Imported proofs.** The server and client restate "a commit / refusal /
  queued edit / answer keeps the rules" as laws for the system proof file.
  It can call `server_<transition>_ensures` and `client_<transition>_ensures`
  instead (AGENTS.md, "Proof files").
- **Equality.** `sameTodos` and its reflexivity law can become `==`, which
  compares lists and records by structure.
- **List operations.** `dropAt`, and its induction, can become `removeAt`.
- **Sample sets.** An imported library's `<param>Values` now apply to the
  specs that import it; a set an importing spec only repeats can go.
- **Hand-written loops.** `drain` calls `receiveSnapshot`; it can call the
  generated `step` instead, since a `src` unit can call `step_ensures` of
  the module it imports.
- **Liveness.** "Both tabs eventually agree" is stated as "sometimes they
  agree"; a `leadsTo` rule with `fair_` events can state it (AGENTS.md,
  "Liveness").
