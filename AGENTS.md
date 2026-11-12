# Operating procedure for agents

<!-- onespec:start (installed and kept up to date by `spec init`; edit outside these markers) -->
## Specs are the source of truth

Each application has one source of truth: `spec/<name>.md`. Stories, rules
and the Quint model live there together. TypeScript in `gen/` is derived from
it. Your job is to keep the spec true to what the user wants and to keep
`npm run check` green.

Read CONTRIBUTING.md for the spec format and naming rules before editing a
spec.

### Who does what

The tools detect; you translate. `npm run check` reports which story has no
rules, which rule has no Quint, which half of a rule moved, which trace breaks
which rule and which obligation cannot be proved. Turning a story into rules,
a rule into Quint, a changed model back into prose, a counterexample into a
new rule, and an unproved obligation into a proof is your work, in this
session. It does not depend on any other program or account.

**Follow the `sync` skill (`.claude/skills/sync/SKILL.md`) whenever the user
asks for new or changed behaviour, or `spec/` or `src/` has changed.** It is
the whole procedure: the loop, what each failure asks of you, and what to
report when you stop. Claude Code loads it as a skill; any other agent should
read it as a file.

The person signs off with `npm run accept`.

### Commands

| Command | What it does |
|---|---|
| `npm run check` | Every stage, cheapest first; remembers what passed, so a re-run costs only what changed |
| `npm run watch` | `check` again on every change to `spec/`, `src/` or `test/`, in one warm process; for a person iterating |
| `npm run gen` | Only regenerate `gen/` from the specs |
| `npm run accept` | The user's sign-off on reconciled rules. Not yours to run |
| `npm run accept -- unproved` | The user's decision to accept obligations as simulated only. Not yours to run |
| `SPEC_NO_CACHE=1 npm run check` | Everything afresh, with new random traces; for CI, not for iterating |

Where to look: Dafny's full output for a unit is `gen/proof/<unit>.log` and
what it verified is `gen/proof/<unit>/<unit>.dfy`; simulated traces are in
`gen/traces/`.

### Hard rules

- Never edit `gen/`, `.spec-cache/` or `spec/*.lock.json`, and never add a
  `lemmascript.json`. The tools own them, and a change there could make a
  check pass that should not.
- Never run `npm run accept -- unproved` unless the user asks. It lowers the
  assurance of the listed obligations from proved to simulated.
- Do not run `npm run accept` unless the user asks you to, and then only
  after you have read each rule that `review` lists and its prose and Quint
  say the same thing.
- Never weaken or delete a rule (`always`, `step`, `sometimes` or `law`) to
  make a check pass without telling the user which rule and why.
- Proving obligations is your work: write proofs in `spec/<name>.proof.dfy`
  or `src/<path>.proof.dfy` (CONTRIBUTING.md, "Proof files"). Never try to
  get past a check instead of satisfying it: no trust or skip annotations, no
  edits to the tools or what they generate, no workaround for what a proof
  file may not contain.
- Verified logic belongs in the spec as `pure def`. Write TypeScript by hand in
  `src/` only for what Quint cannot express or what touches the outside world,
  and pass everything that arrives from outside through `parseEvent`.

### Definition of done

- `npm run check` prints no `✗` other than `review` items waiting for the
  user's `npm run accept`, and `proof` obligations you could not prove,
  each reported with why, waiting for their decision.
- Your summary follows "When you stop" in the sync skill.
<!-- onespec:end -->

## Working on the tools (this repository only)

- `tools/` is the pipeline (CONTRIBUTING.md, "Changing the tools").
- If you changed anything under `tools/`, `npm run selftest` passes, with a
  new case for any new kind of mistake the change is meant to catch.
- `npm run check:dashboard` checks the larger example; it takes minutes when
  nothing is cached.
