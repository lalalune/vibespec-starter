<div align="center">

# Vibespec (Starter Template)

**Write user stories. Get formally verified TypeScript.**

One Markdown file per application holds the stories, the rules each story
implies, and under every rule a few lines of [Quint](https://quint-lang.org)
that say it exactly. Everything else is generated, simulated and proved with
[Dafny](https://dafny.org). The coding agent in your session keeps prose and
model in step; you sign off.

[![Use this template](https://img.shields.io/badge/Use_this_template-2ea44f?style=for-the-badge&logo=github)](https://github.com/lalalune/vibespec-starter/generate)

[![check](https://github.com/lalalune/vibespec-starter/actions/workflows/check.yml/badge.svg)](https://github.com/lalalune/vibespec-starter/actions/workflows/check.yml)

[Quick start](#quick-start) ·
[Tutorial](#tutorial) ·
[How it works](#what-npm-run-check-checks) ·
[Guarantees](#what-is-and-is-not-guaranteed) ·
[Spec reference](AGENTS.md#spec-reference)

</div>

---

## Why

Agents write code fast; reading all of it is the slow part. Vibespec moves
what you must read to the top: a short list of sentences a product owner
would call true or false, each with its formal meaning underneath. From
there:

- **Generated, not written.** Types, guards, transitions and rule checks in
  `gen/<name>.ts` come from the spec. Nobody edits them.
- **Simulated.** Thousands of random traces look for a reachable state that
  breaks a rule, and report the shortest one.
- **Proved.** Dafny proves that every transition keeps every rule, for all
  states and all inputs, and that your hand-written logic meets its contract.
- **Reviewed.** Every rule that changed is shown with its sentence and its
  Quint side by side, and nothing is done until you sign off.

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

The example is an order checkout (`spec/order.md`, about 250 lines): fill a
draft, submit, pay in instalments, hold, cancel, reopen.

| Order example | |
|---|---|
| Model | 10 transitions, 6 `always`, 1 `step`, 3 `sometimes` rules |
| Proved, spec | 72 obligations, all states and inputs |
| Proved, `src/ledger.ts` | 2 hand-written functions, 3 obligations |

## Quick start

**Needs** Node 24+ and [Dafny](https://github.com/dafny-lang/dafny/releases)
4.11 on the `PATH`. Packages with `src/` or `test/` also need a
`tsconfig.json` so the generated contract is checked against the application.

1. Click **[Use this template](https://github.com/lalalune/vibespec-starter/generate)**
   to create your own repository, then clone it.
2. Install, then open the studio:

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` starts the [studio](#the-studio) and opens it in your browser:
the place to read, write and reorder stories and rules, publish them, have an
agent sync them, check, and sign off. To work on the larger example instead:

```bash
npm run dev dashboard
```

3. Or work from the terminal: check, and run the example.

```bash
npm run check
```

```bash
npm run demo
```

`npm install` builds the `spec` command and generates `gen/` when every spec
is valid. `npm run check` runs every stage and ends with one `next:` line
naming what to do first. `npm run demo` drives the verified order checkout
through a scripted session; every `✗` is a rule refusing an event:

```
✗ {"type":"submit"}              submit is not allowed for a Draft order
✓ {"type":"addItem","qty":2}     {"status":"Draft","units":2,"due":10,"paid":0}
✓ {"type":"submit"}              {"status":"Pending","units":2,"due":10,"paid":0}
✓ {"type":"pay","amount":4}      {"status":"Pending","units":2,"due":10,"paid":4}
✗ {"type":"pay","amount":7}      pay is not allowed for a Pending order
✓ {"type":"pay","amount":6}      {"status":"Paid","units":2,"due":10,"paid":10}
✗ {"type":"cancel"}              cancel is not allowed for a Paid order
balance 0
```

## The studio

`npm run dev` serves a page at `http://localhost:4321` (the next free port if
that one is taken) for the project, with every example in `vibespec/examples/` (order
checkout, dashboard, assistant, full-stack) one click away. It works on `spec/*.md` directly: nothing else holds the stories.

```mermaid
flowchart LR
  edit["Edit<br/>stories and rules"] --> publish["Publish<br/>writes spec/*.md<br/>and the manifest"]
  publish --> sync["Sync<br/>Claude Code or Codex,<br/>on the sync prompt"]
  sync --> check["Check<br/>npm run check"]
  check --> sign["Sign off<br/>npm run accept"]
  check -. "✗" .-> sync
```

| You can | How |
|---|---|
| Read every story and rule, its Quint coloured, what it defines as a glyph (`→` transition, `?` guard, `□` always, `Δ` step, `◇` sometimes, `∀` law, `●` initial state, `T` type) | Click a row; `Expand` opens all; `/` searches |
| See what needs you | A dot on each story, rule and spec: accent unpublished, amber waiting for review (with the status `check` gives it), red named by a failing check. `Needs attention` hides the rest |
| Edit a story, a rule, its prose and its Quint, or the spec's title | Double-click, the pencil, or `e` on a focused row. `Esc` or `Done` closes it |
| Add a story, a rule, a spec; delete any of them | `+ Story`, `+` on a story, the field under the specs; the bin. `⌘Z` or `Undo` in the toast brings it back |
| Reorder and regroup | Drag a story or rule, `Alt ↑`/`Alt ↓` on a focused row, or the `⇅` menu: a rule into another story, a story onto another spec |
| Publish | `⌘S` or `Publish`: shows the diff of every spec it writes, refuses empty or duplicate headings, and refuses to overwrite a spec that changed on disk unless you say so |
| Sync | `Run` starts Claude Code or Codex in the project on the sync prompt, its progress in the log, `■` stops it. `Open` starts a new Claude Code or Codex chat in the project with the prompt filled in. The copy button copies it |
| Check and sign off | `Run check` runs `npm run check`, also after every publish and sync. `Sign off` runs `npm run accept`, once every stage but `review` passes and nothing is unpublished or unsynced |

Unpublished edits are kept in the browser, so a reload loses nothing; a spec
an agent or an editor changes underneath them is flagged with `Keep mine` and
`Take disk`. Pages follow every change to `spec/` as it happens.

**Publishing** rewrites only the specs that changed, and leaves everything you
did not touch byte for byte as it was. It then keeps, in `.studio/` (ignored by
git), the specs as the agent last synced them and a manifest of what changed
since, which the sync prompt points to. `.studio/manifest.json` lists each
story and rule added, deleted, renamed, reworded, re-modelled, reordered or
moved to another story or spec, with what each asks of the agent in the words
of the [sync skill](.claude/skills/sync/SKILL.md); the rules whose Quint relied
on one that changed or went; the generated modules to rebuild and the code in
`src/` and `test/` that imports them; and the citations that name a heading
the specs no longer have. A sync that the studio ran and that ended well clears
it; `Mark synced` clears it by hand.

**Agents.** `Run` needs `claude` or `codex` on the `PATH`, signed in. Claude
Code runs with edits allowed and only the check, `npx quint` and file tools,
never `accept`; Codex runs in its `workspace-write` sandbox. `Open` uses the
`claude-cli://` and `codex://` links, which the apps register when installed
(Claude Code's after its first interactive session); a link carries at most
5,000 characters of prompt, so a long manifest is summarized and the rest read
from the file.

`npx spec watch` reruns the checks whenever a spec, a source file or a test changes.

## Tutorial

### 1. Read a spec

In [spec/order.md](spec/order.md), `##` is a story, `###` a rule, and the
`quint` block under a rule is its formal half.

````markdown
## Story: Check out

> As a shopper, I want to submit my order and pay it off in one or more
> payments, so that I do not need the whole amount at once.

### A payment never exceeds the balance

A payment is a positive amount toward a pending order. The payment that
clears the balance marks the order as paid.

```quint
pure def canPay(o: Order, amount: int): bool =
  o.status == Pending and amount > 0 and o.paid + amount <= o.due

pure def pay(o: Order, amount: int): Order =
  val paid = o.paid + amount
  { ...o, paid: paid, status: if (paid == o.due) Paid else Pending }
```

### A pending order still has a balance

```quint
pure def alwaysPendingHasBalance(o: Order): bool =
  o.status == Pending implies o.paid < o.due
```
````

There is no state machine to write. A definition's name and signature give
its role ([all of them](AGENTS.md#what-goes-in-the-quint-blocks)):

| You write | It is |
|---|---|
| `pure val initial: Order` | the initial state; its type is the state type |
| `pure def pay(o: Order, …): Order` | a transition, and an event `{ type: "pay", amount }` |
| `pure def canPay(o: Order, …): bool` | the guard of `pay` |
| `pure def alwaysX(o: Order): bool` | holds in every reachable state |
| `pure def stepX(before: Order, after: Order): bool` | holds across every transition |
| `pure def sometimesX(o: Order): bool` | some reachable state has it |
| `pure def lawX(…): bool` | true for every argument |

`gen/order.ts` gets the same definitions in TypeScript. Each transition
carries one obligation per rule, which Dafny proves:

```ts
/** Story: Check out / A payment never exceeds the balance (spec/order.md:73) */
//@ pure
export function pay(o: Order, amount: number): Order {
  //@ ensures (inv(o) && canPay(o, amount)) ==> alwaysPendingHasBalance(\result)
  //@ ensures (inv(o) && canPay(o, amount)) ==> stepNothingIsPaidOnHold(o, \result)
  // … one per always and step rule
  const paid = o.paid + amount;
  return { ...o, paid: paid, status: paid === o.due ? "Paid" : "Pending" };
}

export function parseEvent(x: unknown): Event | undefined  // untrusted input → event, or not
export function enabled(current: Order, event: Event): boolean
export function step(current: Order, event: Event): Order
export function inv(current: Order): boolean               // every always rule at once
```

### 2. Start your own application

```bash
npm run new -- tally
```

This writes `spec/tally.md`, a [starter spec](AGENTS.md#writing-a-spec)
that passes every stage but `review`: one story, a state, one guarded
transition, an `always` and a `sometimes` rule. Replace its story with yours.
When you no longer need the order example, delete `spec/order.*`, everything
in `src/` and `test/` (the example's logic, shell and tests), and the `demo` script in
`package.json`.

### 3. Write a story; let the agent write the rules

Add a story in prose only:

```markdown
## Story: Start again

> As a user, I want to reset my tally to zero, so that I can count again.
```

Then ask the agent in your session (Claude Code, or any agent that reads
[AGENTS.md](AGENTS.md)) to sync. It follows the
[`sync` skill](.claude/skills/sync/SKILL.md):

```mermaid
flowchart LR
  edit["You edit<br/>a story, a rule or Quint"] --> check["npm run check"]
  check -- "✗" --> agent["Agent in your session<br/>sync skill"]
  agent -- "edits spec/, src/" --> check
  check -- "only sign-off left" --> accept["You read the diff<br/>npm run accept"]
  accept --> use["src/ imports gen/name.ts<br/>tsc flags what must follow"]
```

Each kind of report asks for one translation:

| `npm run check` reports | The agent writes |
|---|---|
| story has no rules | rules, then their Quint |
| not formalized | Quint that says what the sentence says, and no more |
| prose changed | Quint, if the meaning moved |
| model changed | the sentence, to match the Quint |
| a trace breaks a rule | the missing reason, as a new rule |
| not proved | a proof, or the missing fact as a new rule |

For the story above it might write:

````markdown
### A tally that has counted something can be reset to zero

```quint
pure def canReset(t: Tally): bool = t.count > 0
pure def reset(t: Tally): Tally = { count: 0 }
```
````

It then stops and reports the rules it added, the rules the checks forced,
and anything it could not formalize or prove. It runs `npm run accept` only
when you ask.

### 4. When simulation finds a missing rule

Weaken `canSubmit` in the order example to `o.status == Draft`, and the
`always` stage finds the shortest trace to a broken rule:

```
✗ always    spec/order.md: a reachable state breaks "Story: Check out /
            A pending order still has a balance" (spec/order.md:93)
      initial                        -> {"status":"Draft","units":0,"due":0,"paid":0}
      {"type":"submit"}              -> {"status":"Pending","units":0,"due":0,"paid":0}
      last event: "Story: Check out / Only a non-empty draft can be submitted" (spec/order.md:63); its guard canSubmit let it through
      fallback: refuse submit when its result would break alwaysPendingHasBalance
      seed …; to simulate again: npx quint run gen/order.run.qnt …
```

The fix is the *reason*, written as a rule in the user's words. Rules found
this way say so: see "No more can be removed than the order holds" in
[spec/order.md](spec/order.md).

### 5. When a proof fails

A rule can hold on every trace and still not be provable, because the proof
starts from *any* state that satisfies the rules, reachable or not. Delete
"Drafts and cancelled orders hold no money" from the order example: every
trace still passes, but Dafny now considers a draft that is already paid,
and `submit` can no longer be proved to leave a balance.

[Three ways out](AGENTS.md#when-a-proof-does-not-go-through). First
decide whether the obligation holds in every state that satisfies the rules.
If you can name one where it does not, as with the paid draft here, no proof
can help.

1. **Prove it**, if it holds, in `spec/<name>.proof.dfy`, with Dafny lemmas
   only. The tools refuse anything that would assume rather than prove.
2. **State the missing fact** as a new `always` rule, if it does not. "An
   order on hold still has a balance" in the order example was found this way.
3. **Accept it as simulated only**, with `npm run accept -- unproved`, for a
   spec only: hand-written code must be proved. Your decision, never the
   agent's, and it lapses when the spec or its proof file changes.

### 6. Build on the generated code

Application code goes through `parseEvent`, `enabled` and `step`, as
[src/app.ts](src/app.ts) does:

```ts
dispatch(id: string, input: unknown): Order {
  const event = parseEvent(input);
  if (!event) throw new Rejected("not a well-formed event");
  const order = this.get(id);
  if (!enabled(order, event)) throw new Rejected(`${event.type} is not allowed …`);
  …
}
```

Logic Quint cannot express, such as a loop over an event log, is written in
TypeScript with [LemmaScript](https://github.com/midspiral/LemmaScript)
contracts and proved too. From [src/ledger.ts](src/ledger.ts):

```ts
export function replay(events: Event[]): Order {
  //@ ensures inv(\result)
  …
}
```

When the spec changes, `tsc` points at every line of `src/` that must follow.

### 7. Sign off

When only `review` items are left, read the diff of `spec/`, `src/` and `test/`, and
check that each rule's sentence and its Quint say the same thing. Then:

```bash
npm run accept
```

`accept` checks afresh and records what `review` lists in the lock files,
[all or nothing](AGENTS.md#review). Commit them with the spec.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | The [studio](#the-studio), on this project; `npm run dev <example>` on `vibespec/examples/<example>`, `-- --port <n>` on another port |
| `npm run check` | Every stage below; ends with one `next:` line. `rm -rf .spec-cache` runs it afresh |
| `npm run -s check -- --json` | The same, as one JSON object ([shape](AGENTS.md#changing-the-tools)) |
| `npm run gen` | Generates `gen/` only |
| `npm run accept` | The user's sign-off: checks afresh and records what `review` lists, [all or nothing](AGENTS.md#review) |
| `npm run accept -- unproved` | Records the listed obligations as simulated only. The user's decision |
| `npm run new -- <name>` | Writes a [starter spec](AGENTS.md#writing-a-spec) |
| `npm run demo` | A scripted session against the verified core |
| `npm run check:dashboard` | `check` on `vibespec/examples/dashboard` |
| `npm run selftest` | Breaks the pipeline one way at a time and checks each break is caught |
| `npm run build` | Compiles the tools into `dist/`, the packaged `spec` command |
| `npx spec init` | Sets up another package; see [Using it from another package](AGENTS.md#using-it-from-another-package) |

| Exit code | Means |
|---|---|
| 0 | green |
| 1 | a `✗`, or an error |
| 2 | bad arguments; prints the usage line |

## What `npm run check` checks

Stages run cheapest first. `✓` passed, `✗` failed, `-` skipped: blocked by a
`✗` above, or (`types`) there is no `tsconfig.json` and no source or tests to typecheck.

| Stage | Question | Strength |
|---|---|---|
| `model` | Is the spec well-typed and inside the supported subset? | exact; anything unsupported is refused by name |
| `always` | Does a reachable state break an `always` rule, a step break a `step` rule, or a sampled argument break a law? | 10,000 random traces; a failure comes with the shortest trace and its seed |
| `sometimes` | Can each `sometimes` goal be reached? Does each guard allow its event in some reachable state? | a witness trace is a proof; a failure means searches of 20, 40 and 100 events found none (200,000 traces at depth 20, with proportionally fewer at larger depths). [Guards never seen to refuse](AGENTS.md#writing-good-rules) are listed, not failed |
| `replay` | Does the generated TypeScript mean what the Quint means? | 400 sampled traces and every witness: every state, every law, and every definition the simulator can evaluate. The rest are listed |
| `types` | Does the application fit the generated contract? | exact |
| `proof` | Does every transition preserve every `always` and `step` rule, does every law hold, and does hand-written logic meet its `//@` contract? | all states, all inputs, counted per obligation under a fixed resource limit. What Dafny cannot prove alone is proved in a proof file (`spec/<name>.proof.dfy`: lemmas only, checked to add nothing but proof), or listed; a listed obligation passes only once the user records it in `spec/unproved.lock.json`, for that text of the unit |
| `tests` | Does the application do what the spec says, with the real services around it? | the generated conformance check through a driver: a shortest journey per `sometimes` rule, then random walks, shrunk on failure ([AGENTS.md](AGENTS.md#conformance)); hand-written journeys for what the spec does not model |
| `review` | Does every story have rules and every rule Quint? Has every new or changed story, rule and `//@` contract been reconciled? | exact |

## What lives where

Keep `spec/`, `src/`, `test/` and `vibespec/` in git, lock files included.
`gen/`, `dist/` and `.spec-cache/` are derived and ignored by git; never edit them.
`.studio/` is the studio's own working state, also ignored.

| Path | Role |
|---|---|
| `spec/order.md` | The source of truth: stories, rules, Quint |
| `spec/order.lock.json` | Review ledger of stories and rules, written by `npm run accept` |
| `spec/src.lock.json` | Review ledger of the `//@` contracts in `src/`, written by `npm run accept`. Absent when there are none |
| `spec/<name>.proof.dfy`, `src/<path>.proof.dfy` | Proofs, in Dafny lemmas, of obligations Dafny cannot prove alone. Written by the agent; optional |
| `spec/unproved.lock.json` | Obligations accepted as simulated only, per unit and tied to its text, written by `npm run accept -- unproved`. Absent when there are none |
| `.spec-cache/` | Remembered results, and `lock`: one check or accept per project at a time |
| `.claude/skills/sync/SKILL.md` | How the agent in your session keeps stories, rules and model in step |
| `.claude/skills/design/SKILL.md` | How the agent designs what a person sees: only what the spec asks, visual first, few words |
| `.agents/skills/` | Links to the same skills for Codex; edit the files in `.claude/skills/` |
| `vibespec/spec.ts` | The pipeline and command line |
| `vibespec/parse.ts`, `vibespec/review.ts` | Literate specs and review ledgers |
| `vibespec/cache.ts`, `vibespec/run.ts` | Stage caches and bounded tool execution |
| `vibespec/units.ts`, `vibespec/simulate.ts`, `vibespec/util.ts` | Generation, proof units, simulation, replay and shell tests |
| `vibespec/conformance.ts` | The conformance runtime copied into `gen/`: journeys, walks, shrinking |
| `vibespec/prove.ts`, `vibespec/proof/lib.dfy` | The proof stage for one unit, with the checks on proof files, and the library of general lemmas proof files call |
| `vibespec/gen.ts`, `vibespec/gen/` | Quint → TypeScript and the simulation harness |
| `vibespec/studio/` | The studio: `server.ts` serves the page in `public/` and runs the check, agents and sign-off; `doc.ts` reads and writes specs losslessly and writes the manifest |
| `vibespec/selftest.ts`, `vibespec/fixtures/` | Tests of the pipeline itself and the studio, and the small specs they use |
| `src/ledger.ts` | Hand-written logic, proved against the generated contract |
| `src/app.ts`, `src/demo.ts` | Unverified shell: storage, input parsing, error reporting; and the demo |
| `test/app.test.ts` | Tests of the shell, run by the `tests` stage |
| `vibespec/examples/dashboard/` | A larger, synthesized example, as a separate package |
| `.github/workflows/check.yml` | Continuous integration: `npm run check` without the cache |
| **Derived** (not in git) | |
| `gen/<name>.ts`, `gen/<name>.qnt` | Generated TypeScript, and the tangled Quint model |
| `gen/<name>.run.qnt` | The simulation harness that `npx quint run` and `quint verify` take |
| `gen/<name>.conformance.ts`, `gen/conformance.ts` | What the check found for testing the application against a state machine, and the runner-agnostic check a driver calls ([AGENTS.md](AGENTS.md#conformance)) |
| `gen/traces/`, `gen/proof/` | The last simulated traces; the final Dafny and logs of each proof unit |
| `dist/` | The built `spec` command, from `npm run build` |
| `.studio/state.json`, `.studio/manifest.json` | The specs as last synced, and what was published since; written by the studio |

## A larger example

`vibespec/examples/dashboard` is a synthesized team task dashboard with made-up names
and data: tasks live in a shared spreadsheet that people also edit by hand, a
chat app carries commands and notifications, and a web page shows the state.

| Spec | Models | Rules | Proved |
|---|---|---|---|
| `kernel.md` | Arithmetic library | 10 laws | 10 obligations |
| `tracker.md` | One project's sheet: guarded dashboard edits, unguarded hand edits | 20 transitions; 10 `always`, 4 `step`, 4 `sometimes` | 282 obligations |
| `projects.md` | The registry of projects | 4 transitions; 2 `always`, 1 `step`, 1 `sometimes`, 1 law | 15 obligations |
| `src/columns.ts` | Hand-written logic | `//@` contracts | 4 obligations |

Every obligation is proved for all states and inputs.

Modelling an owners cell as a list, not a set, exposed a case a set cannot
express: a name typed twice. The rule "A person named twice in a cell is told
once" covers it, and `src/notify.ts` sends each person one message.

Two more examples exercise different boundaries:

- [Shared to-do list](vibespec/examples/fullstack/README.md): an HTTP server, browser
  client and a model of two tabs exchanging messages over an unreliable network.
- [Assistant](vibespec/examples/assistant/README.md): trusted senders, a bounded agent
  turn, late replies and a bill payment that requires the person's confirmation.

## What is and is not guaranteed

Proved for all states and inputs: the initial state satisfies every `always`
rule, every transition preserves every `always` and `step` rule, every law
holds, and hand-written `//@ ensures` hold, except for obligations listed in
`spec/unproved.lock.json` (spec units only; hand-written code must be proved)
and those resting on them, which every proof line lists. The order example has
none. Proof files add only lemmas, and those are proved too
([what they may use](AGENTS.md#proof-files)).

Trusted, not proved:

- **The prose.** Whether the Quint under a rule means what the sentence above
  it says is a judgement. The `review` stage makes sure someone made it.
- **The generator** (`vibespec/gen.ts`, `vibespec/gen/`). Simulation checks the Quint model; the proof checks the
  TypeScript. `replay` ties the two together on sampled traces only.
- **The shell** (`src/app.ts`), LemmaScript, Dafny and Quint.
- **Built-ins.** The proofs assume that built-ins such as `Math` and
  `Array.prototype` are not modified at run time, anywhere in the process.
- **Preconditions.** A `//@ requires` that can never hold makes a contract
  vacuous: everything after it is proved. That is why contracts are reviewed,
  through `spec/src.lock.json`.
- **Numbers.** The proofs treat `number` as an unbounded integer. The
  generated `parseEvent` admits only safe integers, but nothing stops sums of
  them from passing 2^53, where JavaScript arithmetic is no longer exact.
- **The working directory.** Anyone who can edit `gen/`, `.spec-cache/` or the
  tools can make `check` say what they like. `accept` ignores the cache, and
  continuous integration starts without `.spec-cache/`, which is not in git.

## FAQ

**Do I need to know Quint or Dafny?** To read a spec, a little Quint: it
reads like typed functional pseudocode, and each block sits under the
sentence it formalizes. Dafny you rarely see; when a proof needs help, the
agent writes the lemmas.

**What can a spec express?** Records, variants, lists, sets, maps, integers,
strings and booleans, with folds instead of loops. Anything outside the
subset is refused by name ([supported Quint](AGENTS.md#supported-quint)).

**What about I/O, HTTP and storage?** That is the shell, written by hand
around the generated core and covered by tests.

**Which agent?** Claude Code loads `.claude/skills/`; Codex loads the same
files through the skill-folder links in `.agents/skills/`. Keep skill edits in
`.claude/skills/` so both agents use one source. `npx spec init` sets up both
paths in another project without replacing existing skills. Other agents can
follow [AGENTS.md](AGENTS.md) directly. Codex's
[skill discovery documentation](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)
describes the supported locations and links.

**Can I check harder than simulation?** Yes: run the Apalache model checker
on the generated harness, exhaustively up to a depth
([checking harder](AGENTS.md#checking-harder)).

## Contributing

How the repository works, the spec format, proof files and how to change the
tools are in [AGENTS.md](AGENTS.md); every agent reads it and this README in
full before doing any work. A change to `vibespec/` needs
`npm run selftest` to pass, with a new case for each new kind of mistake it
catches.

## License

[MIT](LICENSE)
