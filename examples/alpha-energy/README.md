# Alpha Energy tracker, modelled

A model of a real application: a project tracker whose data lives in
hand-editable Google Sheets and which is used from Slack. The application is
about 5,500 lines of JavaScript; this is its rules in about 700 lines of spec.
It is a separate package that depends on the toolchain the way any project
would.

```sh
npm install
npm run check
```

| Spec | Kind | What it covers |
|---|---|---|
| `spec/kernel.md` | library, 10 laws | Which number a new row gets, when an edit is announced, which reminder is due, where a list page starts, request freshness |
| `spec/tracker.md` | state machine, 20 transitions | One project's sheet: guarded app edits, unguarded hand edits, the warning list and its one-click fixes, notifications |
| `spec/projects.md` | state machine, 4 transitions | The list of projects: one sheet per project, one project per channel, never guessing |
| `src/columns.ts` | hand-written, proved | Spreadsheet column letters, which need a loop and so cannot be written in Quint |

Not modelled: Slack, HTTP, Google Sheets and the web view. They are the shell
around these rules.

## What the checks found

- **A real bug in the application.** A name typed twice in an owners cell
  (`Liza, Liza`) made the notifier send that person the same message twice.
  The application's own model used sets, where a duplicate cannot exist, so it
  could not see this. Here a cell is a list, the rule "nothing is sent twice"
  failed in simulation, and the same input run through the real notifier
  produced two messages to one person. The spec now has the rule "A person
  named twice in a cell is told once". [notify-once.patch](notify-once.patch)
  is the one-line fix with a test, and it has been applied to the
  application: the new test fails without the fix, and with it all 69 of
  the application's tests pass.
- **A wrong rename in the first draft of this model.** Renaming a person onto
  a name already typed in a cell left the name there twice. The real
  application removes duplicates whenever it writes a cell; the model now does
  too.
- **A missing precondition in hand-written code.** `columnName` called the
  proved `columnDigits` without establishing that the column is not negative.
  The proof refused it.

## How much is proved

Everything holds in simulation, and the generated TypeScript agrees with Quint
on all 102 definitions the simulator can evaluate. Of 272 proof obligations,
191 are proved for all inputs. The other 81 hold in 10,000 simulated traces
but Dafny cannot prove them on its own, mostly because they depend on folding
over the warning list. The owner decided that simulation is enough for them
and recorded them with `npm run accept -- unproved`, so they are listed in
`spec/unproved.lock.json` and the check passes. Proving more of them, by
moving the folds into hand-written code with proof hints in `src/`, would
shrink that file. The split is close to the application's own experience: it proves
its arithmetic kernel and model-checks the rest.
