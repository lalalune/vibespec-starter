# Operating procedure for agents

This repository has one source of truth per application: `spec/<name>.md`.
Stories, rules and the Quint model live there together. TypeScript in `gen/`
is derived from it. Your job is to keep the spec true to what the user wants
and to keep `npm run check` green.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the spec format and naming rules
before editing a spec.

## Who does what

The tools detect; you translate. `npm run brief` reports which story has no
rules, which rule has no Quint, which half of a rule moved, which trace breaks
which rule and which obligation cannot be proved. Turning a story into rules,
a rule into Quint, a changed model back into prose, and a counterexample into
a new rule is your work, in this session. It does not depend on any other
program or account.

**Follow [.claude/skills/sync/SKILL.md](.claude/skills/sync/SKILL.md) whenever
`spec/` or `src/` has changed.** It is the whole procedure: the loop, what
each failure asks of you, and what to report when you stop. Claude Code loads
it as the `sync` skill; any other agent should read it as a file.

The person signs off with `npm run accept`.

## Hard rules

- Never edit `gen/` or `spec/*.lock.json`. The tools write them.
- Never run `npm run accept -- unproved` unless the user asks. It lowers the
  assurance of the listed obligations from proved to simulated.
- Do not run `npm run accept` unless the user asks you to, and then only
  after you have read each rule that `review` lists and its prose and Quint
  say the same thing.
- Never weaken or delete an `always` or `sometimes` rule to make a check pass
  without telling the user which rule and why.
- Verified logic belongs in the spec as `pure def`. Write TypeScript by hand in
  `src/` only for what Quint cannot express or what touches the outside world.

## Definition of done

- `npm run check` prints no `✗` other than `review` items waiting for the
  user's `npm run accept` and `proof` obligations waiting for their decision.
- If you changed anything under `tools/`, `npm run selftest` passes, with a
  new case for any new kind of mistake the change is meant to catch.
- Your summary follows "When you stop" in the sync skill.
