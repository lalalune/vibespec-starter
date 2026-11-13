# Team task dashboard, modelled

A synthesized team task dashboard: tasks live in a shared spreadsheet people
also edit by hand, a chat app carries commands and notifications, a web
dashboard shows the state.

```sh
pnpm install
pnpm check
```

| Path | Kind | Covers |
|---|---|---|
| `spec/kernel.md` | library | New row numbers, when an edit is announced, which reminder is due, list paging, request freshness |
| `spec/tracker.md` | state machine | One project's sheet: guarded dashboard edits, unguarded hand edits, warnings and their fixes, notifications |
| `spec/projects.md` | state machine | Projects: one sheet each, one per chat channel, never guessed |
| `spec/*.proof.dfy` | proofs | Obligations Dafny cannot prove alone |
| `src/notify.vibe` | hand-written, tested | One notifier pass → one chat message per person |

Not modelled: the chat app, HTTP, spreadsheet access, the web dashboard.

## What the checks found

- **A name typed twice was notified twice.** A cell is a list, not a set
  (`ana, ana`), and "Nothing is sent twice" failed in simulation. Fixed: the
  notifier treats a cell as a set of people, and `test/notify.test.vibe` types
  a name twice.
- **A rename left a name in a cell twice.** Fixed: a rename removes duplicate
  names from every owners cell.

Obligations accepted as holding in simulation only are recorded in
`spec/lock.json`, under `unproved`; `pnpm check` shows where each stands.

The VibeLang shell uses the generated tracker adapter and sends notifications
through the `Chat` service. `pnpm test` runs the notifier journeys.
