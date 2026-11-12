# Team task dashboard, modelled

A synthesized example, modelled on a common kind of application: a team task
dashboard. Tasks live in a shared spreadsheet that people also edit by hand, a
chat app carries commands and notifications, and a web dashboard shows the
state. The names and data are made up. The rules take about 700 lines of
spec. It is a separate package that depends on the toolchain the way any
project would.

```sh
npm install
npm run check
```

| Path | Kind | What it covers |
|---|---|---|
| `spec/kernel.md` | library, 10 laws | Which number a new row gets, when an edit is announced, which reminder is due, where a list page starts, request freshness |
| `spec/tracker.md` | state machine, 20 transitions | One project's sheet: guarded dashboard edits, unguarded hand edits, the warning list and its one-click fixes, notifications |
| `spec/projects.md` | state machine, 4 transitions | The list of projects: one spreadsheet per project, one project per chat channel, never guessing |
| `src/columns.ts` | hand-written, proved | Spreadsheet column letters, which need a loop and so cannot be written in Quint |
| `src/notify.ts` | hand-written shell, tested | Turns one notifier pass's notes into chat messages, one per person |

Not modelled: the chat app, HTTP, spreadsheet access and the web dashboard.
They are the shell around these rules; `src/notify.ts` is a small piece of
it, tested by `test/notify.test.ts`.

## What the checks found

- **A name typed twice is notified twice.** A natural first model keeps a
  task's owners in a set, where a duplicate cannot exist. A spreadsheet cell
  is not a set: someone can type `ana, ana`. Here a cell is a list, and the
  rule "nothing is sent twice" failed in simulation. The spec now has the rule
  "A person named twice in a cell is told once", and the shell in
  `src/notify.ts` sends each person one message; its test types a name twice
  and checks that the person is told once.
- **A wrong rename in the first draft of the model.** Renaming a person onto
  a name already typed in a cell left the name there twice. The model now
  removes duplicates whenever the dashboard writes a cell.
- **A missing precondition in hand-written code.** `columnName` called the
  proved `columnDigits` without establishing that the column is not negative.
  The proof refused it.

## How much is proved

Everything holds in simulation. Not every obligation is proved for all
inputs; those that hold only in simulation are listed in
`spec/unproved.lock.json`, and `npm run check` reports where each stands.
Moving the folds over the warning list into hand-written code with proof
hints in `src/` would shrink that file.
