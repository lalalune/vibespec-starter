# Team task dashboard, modelled

A synthesized team task dashboard: tasks live in a shared spreadsheet people
also edit by hand, a chat app carries commands and notifications, a web
dashboard shows the state. A separate package that depends on the toolchain
like any project would.

```sh
pnpm install   # here, after the install at the repository root
pnpm check   # model, proofs, types (vibelang --noEmit) and tests
pnpm test        # the journeys alone: vitest run
pnpm build   # vibelang: JavaScript in dist/
```

The shell is [VibeLang](https://github.com/smithersai/vibelang): Effect in
TypeScript syntax, in `.vibe` files. `pnpm gen` writes an adapter
`gen/<name>.effect.vibe` beside each generated module; the shell takes the
tracker's types from its adapter, and the test drives that adapter's `Machine`.

| Path | Kind | Covers |
|---|---|---|
| `spec/kernel.md` | library | New row numbers, when an edit is announced, which reminder is due, list paging, request freshness |
| `spec/tracker.md` | state machine | One project's sheet: guarded dashboard edits, unguarded hand edits, warnings and their fixes, notifications |
| `spec/projects.md` | state machine | Projects: one sheet each, one per chat channel, never guessed |
| `spec/*.proof.dfy` | proofs | Obligations Dafny cannot prove alone |
| `src/columns.ts` | hand-written, proved | Spreadsheet column letters (needs a loop) |
| `src/notify.vibe` | hand-written, tested | One notifier pass → one chat message per person |

Not modelled: the chat app, HTTP, spreadsheet access, the web dashboard.

## The shell

| In `src/notify.vibe` | Is |
|---|---|
| `messages` | notes grouped into one message per person |
| `Chat` | the chat app as a service: `post(handle, text)`, failing with `Undelivered` |
| `send` | posts one pass's messages in order, one after another; how many went out |

`test/notify.test.vibe` walks the journey through the tracker's `Machine` and
gives `send` the one fake, a `Chat` that records what is posted to it.

`src/columns.ts` stays TypeScript: LemmaScript proves its `//@` contracts from
that text. `gen/*.ts` stays TypeScript too; the adapters only wrap it.

## What the checks found

- **A name typed twice was notified twice.** A cell is a list, not a set
  (`ana, ana`), and "Nothing is sent twice" failed in simulation. Fixed by
  the rule "A person named twice in a cell is told once"; `test/notify.test.vibe`
  types a name twice.
- **A rename left a name in a cell twice.** Fixed: the model removes duplicates
  whenever the dashboard writes a cell.
- **A missing precondition.** `columnName` called `columnDigits` without
  showing the column is not negative; the proof refused it.

Obligations that hold in simulation only are listed in `spec/lock.json` under
`unproved`; `pnpm check` shows where each stands.
