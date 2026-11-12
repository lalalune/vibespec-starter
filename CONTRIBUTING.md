# Using the system

How to write a spec, what gets generated from it, and how to build on the
generated code. Setup and the overall process are in [README.md](README.md);
the step-by-step procedure is in [AGENTS.md](AGENTS.md).

## Writing a spec

A spec is a Markdown file in `spec/`. Its file name is the module name, so it
must be a plain identifier: `spec/order.md` becomes `gen/order.ts`. To start
another application, add another file; `check` picks up every `spec/*.md`.

````markdown
# Order checkout                         <- title, free text

## Story: Check out                      <- a story (any `##` heading groups rules)

> As a shopper, I want to …              <- free prose, as much as you like

### Only a non-empty draft can be submitted      <- a rule: one checkable sentence

Submitting freezes the order.            <- more prose for the rule, optional

```quint
pure def canSubmit(o: Order): bool = o.status == Draft and o.units > 0
pure def submit(o: Order): Order = { ...o, status: Pending }
```
````

- `##` always means a story or a group of rules, and needs at least one rule.
- `###` always means a rule, and a rule needs a `quint` block. For a
  subheading that is not a rule, use `####` or bold text.
- Every `quint` block must sit under a `###` rule.
- A rule is identified by its story and its heading. Renaming a heading shows
  up in `review` as one rule removed and one added.
- Quint errors are reported at `spec/<name>.md:line:col`.

### What goes in the Quint blocks

Only types, `pure val` and `pure def`. There is no `var`, no `action`, and no
`init` or `step`: the state machine around your definitions is generated. The
role of a definition comes from its name and signature:

| You write | It is | Generated from it |
|---|---|---|
| `type Order = { … }`, `type Status = A \| B` | the vocabulary | `interface Order`, `type Status = "A" \| "B"` |
| `pure val initial: Order = …` | the initial state (required); its type is *the state type* | `initial`, and a proof that it satisfies every `always` rule |
| `pure def pay(o: Order, amount: int): Order` | a transition: any `pure def` from the state to the state | `pay(o, amount)`, an `Event` variant `{ type: "pay", amount }`, a case in `step`, `enabled` and `isEvent`, and a proof that it preserves every `always` rule |
| `pure def canPay(o: Order, amount: int): bool` | the guard of `pay` (same parameters); optional | `canPay`, used by `enabled` and `step`; what is proved about `pay` is proved for the cases the guard allows. A guard may call its own transition to look at the result |
| `pure def alwaysPaidWithinDue(o: Order): bool` | a rule that holds in every reachable state | a conjunct of `inv`; simulated and proved |
| `pure def sometimesPaid(o: Order): bool` | a state that must be reachable | a reachability check with a witness trace |
| `pure def stepNeverGoesBack(before: Order, after: Order): bool` | a rule about every single step: it relates the state before a transition to the state after | a postcondition on every transition; simulated and proved |
| `pure def lawTotalIsNotNegative(xs: List[int]): bool` | a law: true for every value of its parameters | a function proved to return `true`, and sampled by the simulator |
| `pure val idValues = Set(1, 2, 3)` | what the simulator tries for a parameter named `id`; any Quint is allowed here | nothing: it never reaches TypeScript |
| any other `pure val` or `pure def` | a constant or helper | the same constant or function |

A helper that returns the state would be taken for a transition. Give it the
state as its second parameter, or return something smaller, to keep it a helper.

A spec with no `initial` is a **library**: definitions and laws, no state
machine. Another spec uses it with `import kernel.* from "./kernel"` in a
`quint` block, and the generated TypeScript imports `gen/kernel.ts` the same
way. Only libraries can be imported, and imports cannot form a circle.

A library can be a **component**: a type with its guards and functions, such
as an account with `canWithdraw` and `withdraw`, and no state of its own. A
machine that has two accounts imports it, holds both in its state, and can
then state a rule that spans them ("a transfer keeps the total"), which
neither account could state alone. `tools/fixtures/bank.md` is an example.

Names that are refused, with a message saying why: `init`, `step`, `inv`,
`enabled`, `isEvent`, `Event`, `initialHolds`, `state`, TypeScript keywords
(`delete`, `new`, …), Quint built-ins (`to`, `next`, `always`, …), a
parameter named like a variant, and near-misses of the conventions above such
as `alwayspaid` or `CanPay`.

### Supported Quint

`int`, `bool`, `str`, records (nested as deep as you like), lists, sets of
simple values, and sum types, with or without data; arithmetic `+ - * / %`, comparisons,
`and or not implies iff`, `if … else`, record construction, spread update and
field access, `match`, calls to your own `pure def`s, and `val` bindings at
the top of a definition. Integer literals must fit in 2^53.

**Collections are lists**, which become arrays. A table is a list of records
with an id field; a multi-valued cell is a list of names or numbers.

| In a spec | In TypeScript |
|---|---|
| `List(a, b)`, `List()` | `[a, b]`, `[] as T[]` |
| `xs.append(x)`, `xs.concat(ys)` | `[...xs, x]`, `[...xs, ...ys]` |
| `xs.length()`, `xs.nth(i)`, `xs.head()`, `xs.tail()` | `xs.length`, `xs[i]`, `xs[0]`, `xs.slice(1)` |
| `xs.select(x => …)` | `xs.filter(…)` |
| `xs.every(x => …)`, `xs.some(x => …)`, `xs.includes(v)`, `xs.listMap(x => …)` | `xs.every(…)`, `xs.some(…)`, `xs.includes(v)`, `xs.map(…)` |
| `xs.foldl(start, (acc, x) => …)` | `xs.reduce(…, start)` |

`every`, `some`, `includes` and `listMap` are not Quint; the tool rewrites
them into Quint's `foldl` before Quint sees the spec. Things to know:

- **Sets hold simple values only** (numbers, strings, booleans, plain
  variants) and become arrays that never hold a value twice. `Set(…)`,
  `union`, `intersect`, `exclude`, `filter`, `map`, `forall`, `exists`,
  `contains`, `in`, `subseteq` and `size` are supported. Use a set when
  duplicates are impossible in the real thing, and a list when they are not:
  the alpha-energy example found a real bug that a set-based model had hidden.
- **No maps.** A lookup of a missing key has no total translation. Use a list
  of records with a key field, as the example's tasks are.
- **A sum type whose variants carry records is a tagged union.**
  `type Parcel = Packed({ weight: int }) | Lost` becomes
  `{ tag: "Packed"; weight: number } | { tag: "Lost" }`, so each stage of a
  life cycle can carry only what is known at that stage. Read it with
  `match p { | Packed(x) => … | _ => … }`, on a name. Inside the `Packed` arm,
  `Packed({ ...x, weight: 2 })` updates the value in place; a different
  variant is built field by field.
- **`==` compares numbers, strings, booleans and variants only.** Compare
  records field by field, and lists with `every`.
- **Make list access total.** `xs.nth(i)` outside the list stops the
  simulator and cannot be proved safe. Test the index in the same definition
  and return a default, as `problemAt` does in the example.
- **No loops or recursion.** To repeat something "until done", fold over a
  list that is long enough, as `ancestors` does in the example. What needs a
  real loop is written by hand in `src/` and proved there.
- **`/` and `%`** agree across Quint, JavaScript and Dafny only for
  non-negative numbers.
- **Recursion does not exist in Quint.** See the point about loops.

Anything else stops the `model` stage with the name of the construct, rather
than being translated loosely. To add an operator, add a case to `print` in
`tools/gen.ts`; to change the values the simulator tries for event
parameters (integers −1…6, both booleans, three strings, every variant, and
short lists of those), edit `SAMPLES` there, or define `<param>Values` in the
spec. A parameter that is a record needs `<param>Values`. Run
`npm run selftest` afterwards.

### Writing good rules

- `always` rules alone are satisfied by a system that does nothing. Add a
  `sometimes` rule for each kind of state a story is meant to make possible.
- `always` rules must hold *inductively*: from any state that satisfies all of
  them, every transition must lead to a state that satisfies all of them. If
  simulation passes but `proof` fails on a transition, a fact about which
  states are reachable is unstated. In the example, "Drafts and cancelled
  orders hold no money" is such a fact: delete it and no simulated trace
  fails, but `submit` can no longer be proved to leave a balance.
- The simulator samples; the proof covers all values.
- Keep simulation bounds out of guards. A guard such as "stop after day 6"
  ends up in the generated code. Bound the simulator with `<param>Values`.
- Compute something once with a `val` when a rule uses it several times;
  repeated folds are what make simulation slow.

### When a proof does not go through

Dafny proves arithmetic and simple list facts on its own. It usually cannot
prove a rule that depends on a fold, a count or a search without help. When
`proof` reports obligations as "not proved" although simulation found nothing,
choose for each:

1. **State the missing fact** as another `always` rule or a law, if there is
   one. This is the inductiveness case above.
2. **Move the arithmetic into a small function with a law**, in a library
   spec. Small functions prove; the example's `kernel` does this.
3. **Write it by hand with loop invariants** in `src/`, where LemmaScript can
   be told why it holds.
4. **Accept simulation for it**: `npm run accept -- unproved` records the
   obligations in `spec/unproved.lock.json`. The check then passes, says how
   many obligations are simulated only, and fails again if a *new* one
   appears. Read the list before recording it: an obligation that is false is
   also "not proved".

## Using the generated code

`gen/<name>.ts` exports your types, constants and functions under the names
you gave them, plus:

```ts
type Event = { type: "addItem"; qty: number } | { type: "submit" } | …
function isEvent(x: unknown): x is Event        // is this untrusted value a well-formed event?
function enabled(s: Order, e: Event): boolean   // do the rules allow e now?
function step(s: Order, e: Event): Order        // apply e; unchanged if not allowed
function inv(s: Order): boolean                 // every always-rule at once
```

Every export carries a doc comment naming its rule and spec line, so hovering
`pay` in an editor shows where it comes from.

- Import with the `.ts` extension, as Node requires:
  `import { type Event, enabled, step } from "../gen/order.ts";`
- The proofs treat `number` as an integer. Pass anything that arrives from
  outside (JSON, a form, a queue) through `isEvent` first; it checks the shape
  and that every number is a safe integer.
- Calling a transition directly (`pay(o, 5)`) is only meaningful when its
  guard holds. Application code should go through `enabled` and `step`, as
  `src/app.ts` does.
- `gen/` is rebuilt by `npm install`, `npm run gen` and `npm run check`.

## Hand-written verified logic

Put logic in the spec when you can: it is then simulated, proved and
generated. For pure logic that Quint cannot express, such as a loop over an
event log, write TypeScript under `src/` with
[LemmaScript](https://github.com/midspiral/LemmaScript) annotations.
`src/ledger.ts` is the worked example.

- Any `.ts` file under `src/` that contains a `//@` annotation is proved by
  `npm run check`.
- Such a file may import only from `gen/`. Its annotations may mention
  anything the generated module defines (`inv`, guards, rules), imported or
  not.
- Allowed annotations: `backend`, `pure`, `requires`, `ensures`, `invariant`,
  `decreases`, `type`, `ghost`, `assert`. Ones that tell the prover to trust
  or skip something (`assume`, `extern`, `havoc`, `skip`, `verify`) are
  refused.
- Keep I/O, classes and libraries out of these files; put them in the shell.
- When a proof fails, the summary names the annotation, and the full Dafny
  output is in `gen/proof/<file>.log`.

Tests for the shell go in `test/*.test.ts` and run with Node's test runner.

## Using it from another package

The toolchain is a package with a `spec` command. In another repository:

```sh
npm install --save-dev onespec        # or a path or tarball: this package is not on the npm registry
npx spec check
```

It expects `spec/*.md`, and optionally `src/`, `test/*.test.ts` and a
`tsconfig.json`, in the directory it is run from. `examples/alpha-energy` is
such a package. To hand the generated code to yet another package, compile
`gen/*.ts` with `tsc` and export the result; it has no dependencies.

## Large applications

- **One spec per area**, each a few hundred lines: a state machine for each
  thing that has a life cycle, libraries and components for what they share.
  `check` runs them in dependency order and proves each one against the
  *definitions* of what it imports, not their proofs, so the cost of a proof
  grows with the spec, not with everything beneath it.
- **Only what changed is checked again.** A spec that passed simulation, and
  each proof result, is remembered in `.spec-cache/` under a fingerprint of
  the spec and of everything it imports. A repeat check of an unchanged
  project takes a second or two. Set `SPEC_NO_CACHE=1` to run everything
  afresh, which also gives the simulator a new set of random traces.
- **Rules that span machines** go in the machine that contains both, built
  from components as described above.
- **Three levels of assurance**, reported per obligation: proved for all
  inputs; simulated and accepted; and the shell, which is tested.
- **The spec covers the rules, not the plumbing.** `examples/alpha-energy`
  models a 5,500-line application in about 700 lines of spec; its Slack,
  HTTP and Google Sheets code stays hand-written around the generated core.

## Who syncs

The agent working in your session does: Claude Code, or any agent that reads
AGENTS.md. Its procedure is the `sync` skill in
`.claude/skills/sync/SKILL.md`: run `npm run brief`, translate what the
report asks for (story to rules, rule to Quint, a changed model back to prose,
a counterexample to a new rule), repeat, then stop for your `npm run accept`.
Nothing else needs to be installed or signed in. In a project that uses the
package, `npx spec init` adds the skill and AGENTS.md.

`npm run sync` is for running unattended. With no configuration it uses a
built-in agent that needs no model (`tools/agent-lookahead.ts`). That agent
cannot turn a story into rules. It does one thing: when a trace shows an
event breaking an `always` rule, it adds the rule "this event is refused when
its result would break that rule", in prose and Quint, and puts it in the
event's guard. The repair is always sound and never insightful; reword it, or
replace it with the real reason, at sign-off.

To have a program do the translating unattended, set `SPEC_AGENT` to any
command that reads the brief on stdin, runs in the repository root, and can
edit files. `tools/agent-ollama.ts` is one for a local
[Ollama](https://ollama.com) model (`OLLAMA_MODEL`, default `qwen2.5:7b`); a
model that small gets simple translations right often, not always.

## Checking harder

`npm run check` simulates. To check the model exhaustively up to a depth with
the Apalache model checker (needs Java 17+, downloads Apalache on first use):

```sh
npx quint verify gen/order.run.qnt --main order_run --invariant inv --max-steps 10
```

## Changing the tools

`tools/spec.ts` is the pipeline and `tools/gen.ts` the translator; both are
plain TypeScript with no build step. `npm run selftest` copies the example
into scratch directories, breaks one thing at a time and asserts which stage
catches each. Add a case there for every new kind of mistake a change is
meant to catch.
