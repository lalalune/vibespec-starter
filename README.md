# One spec, proved software

Turn user stories into working, formally verified TypeScript, with one
hand-written source of truth.

You write `spec/<name>.md`: stories, the rules each story implies, and under
every rule the few lines of [Quint](https://quint-lang.org) that say the same
thing exactly. Everything else is derived and checked:

```mermaid
flowchart LR
  spec["spec/order.md<br/>stories · rules · Quint"]
  qnt["Quint model<br/>+ generated harness"]
  ts["gen/order.ts<br/>types · guards · transitions · rules"]
  app["src/<br/>hand-written logic and shell"]

  spec -- tangle --> qnt
  qnt -- generate --> ts
  ts -- import --> app

  qnt -. "simulate: always / step / law / sometimes" .-> v1([counterexample or witness trace])
  qnt -. "compare every state and definition" .-> ts
  ts -. "LemmaScript + Dafny" .-> v2([proof for all states and inputs])
  app -. "LemmaScript + Dafny" .-> v2
```

The example is an order checkout (`spec/order.md`): fill a draft, submit, pay
in instalments, hold, cancel, reopen. From about 250 lines of Markdown the
pipeline produces the TypeScript domain module, proves that each of its 10
transitions preserves every rule, and proves two hand-written functions
against that contract.

## Run it

Needs Node 24+ and [Dafny](https://github.com/dafny-lang/dafny) 4+ on the path
(`brew install dafny`, or see Dafny's install page).

```sh
npm install        # also builds the `spec` command and generates gen/
npm run check      # the whole pipeline; a few seconds when nothing changed
npm run watch      # the same, again on every change to spec/, src/ or test/
npm run accept     # sign off the reconciled rules
npm run demo       # a scripted session against the verified core
npm run selftest   # breaks things one at a time and checks each break is caught
npm run check:dashboard   # the same pipeline on examples/dashboard
npm run check:fullstack   # and on examples/fullstack, a React + Node app
```

## The process

1. **Change any embodiment.** Add a story in prose, a rule in prose, or edit
   the Quint, in any order and as little as you like.
2. **The agent in your session syncs.** It follows the `sync` skill
   ([.claude/skills/sync/SKILL.md](.claude/skills/sync/SKILL.md), linked from
   [AGENTS.md](AGENTS.md)): it runs `npm run check`, which reports what is out
   of step, and makes each translation. A story with no rules becomes rules.
   A rule with no Quint gets its Quint. A rule whose model moved gets its
   prose updated, and the reverse. A counterexample trace or an unprovable
   transition becomes a new rule, marked as discovered. It repeats until only
   your sign-off is left. No other program or account is involved.
3. **Sign off.** Read the diff of `spec/` and what the agent reports, then
   **`npm run accept`**. It checks everything afresh and records the rules as
   reconciled only if every other stage passes. The agent never accepts on
   your behalf.
4. **Use the result.** The application imports `gen/<name>.ts`. When the
   contract changes, `tsc` points at every place the application must follow.

[CONTRIBUTING.md](CONTRIBUTING.md) is the reference for writing specs and
using the generated code.

## What `npm run check` checks

Stages run cheapest first. A broken model stops the later stages, because
their failures would only restate the first one.

| Stage | Question | Strength |
|---|---|---|
| `model` | Is the spec well-typed and inside the supported subset? | exact; anything unsupported is refused by name |
| `always` | Does a reachable state break an `always` rule, a step break a `step` rule, or a sampled argument break a law? | 12,000 random traces, plus every witness search below, which stops at a broken rule too; a failure comes with the shortest trace |
| `sometimes` | Can each `sometimes` goal be reached at all? Does each guard allow its event in some reachable state? | a witness trace is a proof; a failure means 200,000 traces of 20 events found none. Guards never seen to refuse their event are listed, not failed |
| `replay` | Does the generated TypeScript mean what the Quint means? | 400 sampled traces: every state, every law tried, and the result of every definition the simulator can evaluate. Definitions it cannot evaluate are listed |
| `types` | Does the application fit the generated contract? | exact |
| `proof` | Does every transition preserve every `always` and `step` rule, does every law hold, and does hand-written logic meet its `//@` contract? | all states, all inputs, counted per obligation under a fixed resource limit. What Dafny cannot prove alone is proved in a proof file (`spec/<name>.proof.dfy`: lemmas only, checked to add nothing but proof), or listed; a listed obligation passes only once the user records it in `spec/unproved.lock.json`, for that text of the unit |
| `tests` | Does the shell work? | examples |
| `review` | Does every story have rules, and has every rule whose prose or model changed been reconciled? | exact |

## What lives where

Keep `spec/`, `src/`, `test/` and `tools/` in git, lock files included.
`gen/` and `.spec-cache/` are derived and ignored by git; never edit them.

| Path | Role |
|---|---|
| `spec/order.md` | The source of truth: stories, rules, Quint |
| `spec/order.lock.json` | Review ledger written by `npm run accept` |
| `spec/<name>.proof.dfy`, `src/<path>.proof.dfy` | Proofs, in Dafny lemmas, of obligations Dafny cannot prove alone. Written by the agent; optional |
| `spec/unproved.lock.json` | Obligations accepted as simulated only, per unit and tied to its text, written by `npm run accept -- unproved`. Absent when there are none |
| `.claude/skills/sync/SKILL.md` | How the agent in your session keeps stories, rules and model in step |
| `tools/spec.ts` | The pipeline: tangle, simulate, compare, prove, review |
| `tools/prove.ts`, `tools/proof/lib.dfy` | The proof stage for one unit, with the checks on proof files, and the library of general lemmas proof files call |
| `tools/gen.ts`, `tools/gen/` | Quint → TypeScript and the simulation harness: types, expressions, classification, and the two outputs, one file each |
| `tools/selftest.ts`, `tools/fixtures/` | Tests of the pipeline itself, and the small specs they use |
| `src/ledger.ts` | Hand-written logic, proved against the generated contract |
| `src/app.ts` | Unverified shell: storage, input parsing, error reporting |
| `examples/dashboard/` | A larger, synthesized example modelled with the same tools, as a separate package |
| `examples/fullstack/` | A React frontend and a Node backend modelled together, network faults included, as a separate package |
| `docs/roadmap.md` | Review findings: what has been fixed, and what to do next for speed and for larger applications |

## A frontend and a backend together

`examples/fullstack` is a shared to-do list: a `node:http` server, and a
React page whose `useReducer` reducer is the generated client `step`. Four
specs model it end to end: the to-do library, the server (idempotent
requests, a version that counts changes), one browser tab (optimistic edits
queued while offline, acknowledged, refused, rebased on snapshots), and a
system of the server, two tabs and a network that loses, duplicates and
reorders messages. Its rules say every copy of the list, in a tab or in
flight, is exactly the server's list at that version, and a `sometimes` rule
shows two tabs that both edited converging. All 124 obligations are proved,
including a hand-written loop that applies a batch of pushes; its README says
how the halves fit and what the language could not yet say.

## A larger example

`examples/dashboard` is a synthesized team task dashboard, modelled on a
common kind of application: tasks live in a shared spreadsheet that people
also edit by hand, a chat app carries commands and notifications, and a web
dashboard shows the state. Its names and data are made up. It has three
specs: a library of arithmetic with laws, one project's sheet with guarded
dashboard edits and unguarded hand edits, and the registry of projects. It
has 24 transitions, 17 `always` and `step` rules and 11 laws.

Everything holds in simulation. Not every obligation is proved for all
inputs; those that hold only in simulation are listed in the example's
`spec/unproved.lock.json`, and `npm run check:dashboard` reports where each
stands.

Modelling an owners cell as a list rather than a set exposed that a name
typed twice is notified twice; a set-based model cannot express that case.
The spec now has the rule "A person named twice in a cell is told once", and
the example's hand-written shell, `src/notify.ts`, sends each person one
message, with a test for a name typed twice.

## What is and is not guaranteed

Proved for all states and inputs: the initial state satisfies every `always`
rule, every transition preserves every `always` and `step` rule, every law
holds, and hand-written `//@ ensures` hold, except for obligations listed in
`spec/unproved.lock.json`. The order example has none. Proof files add only
lemmas, and those are proved too.

Trusted, not proved:

- **The prose.** Whether the Quint under a rule means what the sentence above
  it says is a judgement. The `review` stage makes sure someone made it.
- **The generator** (`tools/gen.ts`, `tools/gen/`). Simulation checks the Quint model; the proof checks the
  TypeScript. `replay` ties the two together on sampled traces only.
- **The shell** (`src/app.ts`), LemmaScript, Dafny and Quint.
- **Numbers.** The proofs treat `number` as an unbounded integer. The
  generated `parseEvent` admits only safe integers, but nothing stops sums of
  them from passing 2^53, where JavaScript arithmetic is no longer exact.
- **The working directory.** Anyone who can edit `gen/`, `.spec-cache/` or the
  tools can make `check` say what they like. `accept` ignores the cache, and
  continuous integration should run with `SPEC_NO_CACHE=1`.
