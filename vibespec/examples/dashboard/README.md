# Team task dashboard, modelled

A team's tasks in a shared spreadsheet, chat notifications and a web dashboard.

```sh
npm run check --workspace dashboard-model
```

| Path | Kind | Covers |
|---|---|---|
| `spec/kernel.md` | library | New row numbers, when an edit is announced, which reminder is due, list paging, request freshness |
| `spec/tracker.md` | state machine | One project's sheet: guarded dashboard edits, unguarded hand edits, warnings and their fixes, notifications |
| `spec/projects.md` | state machine | Projects: one sheet each, one per chat channel, never guessed |
| `spec/*.proof.dfy` | proofs | Obligations Dafny cannot prove alone |
| `src/columns.ts` | hand-written, proved | Spreadsheet column letters (needs a loop) |
| `src/notify.ts` | hand-written, tested | One notifier pass → one chat message per person |

## What the checks found

- **A name typed twice was notified twice.** A cell is a list, not a set
  (`ana, ana`), and "Nothing is sent twice" failed in simulation. Fixed by
  the rule "A person named twice in a cell is told once"; `test/notify.test.ts`
  types a name twice.
- **A rename left a name in a cell twice.** Fixed: the model removes duplicates
  whenever the dashboard writes a cell.
- **A missing precondition.** `columnName` called `columnDigits` without
  showing the column is not negative; the proof refused it.
