# Team task dashboard, modelled

Tasks in a shared spreadsheet, edited by hand and through a chat dashboard.

```sh
npm run check:dashboard
```

| Path | Kind | Covers |
|---|---|---|
| `spec/kernel.md` | library | New row numbers, when an edit is announced, which reminder is due, list paging, request freshness |
| `spec/tracker.md` | state machine | One project's sheet: guarded dashboard edits, unguarded hand edits, warnings and their fixes, notifications |
| `spec/projects.md` | state machine | Projects: one sheet each, one per chat channel, never guessed |
| `spec/*.proof.dfy` | proofs | Obligations Dafny cannot prove alone |
| `src/notify.ts` | hand-written, tested | One notifier pass → one chat message per person |

Not modelled: the chat app, HTTP, spreadsheet access, the web dashboard.

## What the checks found

- **A name typed twice was notified twice.** A cell is a list, not a set
  (`ana, ana`), and "Nothing is sent twice" failed in simulation. Fixed: the
  notifier treats a cell as a set of people, and `test/notify.test.ts` types
  a name twice.
- **A rename left a name in a cell twice.** Fixed: a rename removes duplicate
  names from every owners cell.

Obligations that hold in simulation only are listed under `unproved` in
`spec/lock.json`.
