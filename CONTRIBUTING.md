# Using the system

How to write a spec, what gets generated from it, and how to build on the
generated code. Setup and the overall process are in [README.md](README.md);
the procedure an agent follows is in [AGENTS.md](AGENTS.md) and the `sync`
skill it points to.

"The order example" below is `spec/order.md` in this repository. "The tracker
example" is `examples/dashboard/spec/tracker.md`.

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

Only types, imports, `pure val` and `pure def`. There is no `var`, no
`action`, and no `init` or `step`: the state machine around your definitions
is generated. The role of a definition comes from its name and signature:

| You write | It is | Generated from it |
|---|---|---|
| `type Order = { … }`, `type Status = A \| B` | the vocabulary | `interface Order`, `type Status = "A" \| "B"` |
| `pure val initial: Order = …` | the initial state; its type is *the state type*. A spec without one is a library | `initial`, and a proof that it satisfies every `always` rule |
| `pure def pay(o: Order, amount: int): Order` | a transition: any `pure def` whose first parameter is the state and that returns the state | `pay(o, amount)`, an `Event` variant `{ type: "pay", amount }`, a case in `step`, `enabled` and `parseEvent`, and proofs that it preserves every rule |
| `pure def canPay(o: Order, amount: int): bool` | the guard of `pay` (same parameters); optional | `canPay`, used by `enabled` and `step`. What is proved about `pay` is proved for the cases the guard allows. A guard may call its own transition to look at the result |
| `pure def alwaysPaidWithinDue(o: Order): bool` | a rule that holds in every reachable state | a conjunct of `inv`; simulated and proved |
| `pure def stepNeverGoesBack(before: Order, after: Order): bool` | a rule about every single step | a postcondition on every transition; simulated and proved |
| `pure def sometimesPaid(o: Order): bool` | a state that must be reachable | a reachability check with a witness trace |
| `pure def lawTotalIsNotNegative(xs: List[int]): bool` | a law: true for every value of its parameters | a function proved to return `true`, and sampled by the simulator |
| `pure val idValues = Set(1, 2, 3)` | what the simulator tries for a parameter named `id`. It must be a set; any Quint is allowed in it | nothing: it never reaches TypeScript |
| any other `pure val` or `pure def` | a constant or helper | the same constant or function |

A helper that takes the state first and returns the state would be taken for
a transition. Give it the state as its second parameter, or return something
smaller.

Some names are refused, with a message saying why: the generated names
(`init`, `step`, `inv`, `enabled`, `parseEvent`, `Event`, `current`, `event`,
`state`, …), JavaScript globals and keywords (`Number`, `delete`, …), Quint
built-ins (`to`, `next`, `all`, `size`, …), a parameter named like a variant,
a variant field called `tag`, and near-misses of the conventions above such as
`alwayspaid` or `CanPay`.

### Using one spec from another

- **`import kernel.* from "./kernel"`** takes a library's names as they are.
  A library is a spec with no `initial`: definitions and laws, or a
  *component* such as an account with `canWithdraw` and `withdraw` and no
  state of its own (`tools/fixtures/account.md`, used by `bank.md`).
- **`import lamp as L from "./lamp"`** takes any spec under a name, a state
  machine included. A room can then hold two `L::Lamp`s in its state, start
  them from `L::initial`, move them with `L::toggle`, require
  `L::alwaysFlipsAreCounted` of each, and add rules about the pair that
  neither lamp could state (`tools/fixtures/room.md`). This is how one machine
  uses and observes another.

A spec is imported once, one way or the other, and imports cannot form a
circle. In the generated TypeScript a name from another module is spelled
`<module>_<name>`, for example `lamp_toggle`.

### Supported Quint

| In a spec | In TypeScript | Notes |
|---|---|---|
| `int`, `bool`, `str` | `number`, `boolean`, `string` | Integer literals must fit in 2^53 |
| records | interfaces | Nest as deep as you like |
| `type Status = Draft \| Paid` | `"Draft" \| "Paid"` | |
| `type Parcel = Packed({ weight: int }) \| Lost` | `{ tag: "Packed"; weight: number } \| { tag: "Lost" }` | Read with `match p { \| Packed(x) => … \| _ => … }` |
| `List[T]` | `T[]` | `List(…)`, `append`, `concat`, `length`, `nth`, `head`, `tail`, `select`, `foldl`, and `every`, `some`, `includes`, `listMap` |
| `Set[T]` of simple values | `T[]` that never holds a value twice | `Set(…)`, `union`, `intersect`, `exclude`, `filter`, `map`, `forall`, `exists`, `contains`, `in`, `subseteq`, `size` |
| `str -> T` | `Record<string, T>` | `Map()`, `put`, `get`, `m.keys().contains(k)` |

Also: `+ - * / %`, comparisons, `and or not implies iff`, `if … else`, record
construction, spread update and field access, calls to your own definitions,
and `val` bindings at the top of a definition. Anything else stops the `model`
stage with the name of the construct, rather than being translated loosely.

Things to know:

- **`==` compares numbers, strings, booleans and plain variants only.** Compare
  records field by field, and lists with `every`.
- **Guard every partial operation in the definition that uses it.** An index
  outside a list, a missing map key and a zero divisor stop the simulator and
  cannot be proved safe. Test first and give a default, as `problemAt` does
  in the tracker example. For a map the form is exactly
  `if (m.keys().contains(k)) m.get(k) else 0`.
- **`/` and `%` go towards zero**, as in Quint: `-7 / 2` is `-3` and `-7 % 2`
  is `-1`. The generated TypeScript and the proofs agree with that exactly.
- **There are no loops and no recursion**, because Quint has none. To repeat
  something until done, fold over a list that is long enough, as `ancestors`
  does in the tracker example. What needs a real loop is written by hand in
  `src/` and proved there.
- **A set holds simple values only**, and `Set(a, b)` with members that are
  not literals is refused, because the two could be equal: write
  `Set(a).union(Set(b))`. Use a set when duplicates are impossible in the
  real thing and a list when they are not. In the tracker example, modelling
  an owners cell as a list exposed that a name typed twice is notified twice,
  which a set-based model cannot express.
- **A map is a lookup table.** It cannot be listed or iterated; keep a list of
  keys beside it, or use a list of records with a key field. An event cannot
  carry one. In the generated state its keys carry a `$` in front, so that no
  key can collide with a property every JavaScript object has.
- **In a `match` arm, use the fields of what the variant carries**
  (`x.weight`), or rebuild the variant (`Packed({ ...x, weight: 2 })`). The
  carried value cannot be passed on whole. `match` must be on a name.
- **`every`, `some`, `includes` and `listMap` are not Quint.** The tool
  rewrites them into Quint's `foldl` before Quint sees the spec, because Quint
  evaluates a definition that takes a lambda wrongly when it is used inside
  its own argument.
- **The simulator tries small values**: integers −1…6, both booleans, three
  strings, every variant, and short lists and sets of those. Define
  `<param>Values` to choose, which a record-valued parameter needs.

### Writing good rules

- `always` rules alone are satisfied by a system that does nothing. Add a
  `sometimes` rule for each kind of state a story is meant to make possible.
- `always` rules must hold *inductively*: from any state that satisfies all of
  them, every transition must lead to a state that satisfies all of them. If
  simulation passes but `proof` fails on a transition, a fact about which
  states are reachable is unstated. In the order example, "Drafts and
  cancelled orders hold no money" is such a fact: delete it and no simulated
  trace fails, but `submit` can no longer be proved to leave a balance.
- Keep simulation bounds out of guards. A guard such as "stop after day 6"
  ends up in the generated code. Bound the simulator with `<param>Values`.
- Compute something once with a `val` when a rule uses it several times;
  repeated folds are what make simulation slow.

### When a proof does not go through

Dafny proves arithmetic and simple list facts on its own. It usually cannot
prove a rule that depends on a fold, a count or a search without help. When
`proof` lists obligations as "not proved" although simulation found nothing,
choose for each:

1. **State the missing fact** as another `always` rule or a law, if there is
   one. This is the inductiveness case above.
2. **Move the arithmetic into a small function with a law**, in a library
   spec. Small functions prove; the tracker example's `kernel` does this.
3. **Write it by hand with loop invariants** in `src/`, where LemmaScript can
   be told why it holds.
4. **Accept simulation for it**: `npm run accept -- unproved` records the
   obligations in `spec/unproved.lock.json`. The check then passes, says how
   many obligations are simulated only, and fails again if a *new* one
   appears. Read the list before recording it: an obligation that is false is
   also "not proved". An entry that says the prover ran out of time covers
   every obligation of that definition.

## Using the generated code

`gen/<name>.ts` exports your types, constants and functions under the names
you gave them, plus:

```ts
type Event = { type: "addItem"; qty: number } | { type: "submit" } | …
function parseEvent(x: unknown): Event | undefined   // an untrusted value as an event, or not
function enabled(s: Order, e: Event): boolean        // do the rules allow e now?
function step(s: Order, e: Event): Order             // apply e; unchanged if not allowed
function inv(s: Order): boolean                      // every always-rule at once
```

Every export carries a doc comment naming its rule and spec line, so hovering
`pay` in an editor shows where it comes from.

- Import with the `.ts` extension, as Node requires:
  `import { type Event, enabled, step } from "../gen/order.ts";`
- **Pass everything that arrives from outside through `parseEvent`.** The
  proofs assume whole numbers and plain data. `parseEvent` checks the shape,
  that every number is a safe integer and that a set holds nothing twice, and
  returns a fresh copy with exactly the fields the event has, so nothing the
  caller keeps can change it afterwards.
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

- Any `.ts` file under `src/` that contains `//@` is proved by
  `npm run check`, as the unit `src-<path>`.
- Such a file may import one generated module and nothing else. Its
  annotations may mention anything that module defines (`inv`, guards, rules),
  imported or not.
- Allowed annotations: `backend`, `pure`, `requires`, `ensures`, `invariant`,
  `decreases`, `type`, `ghost`, `assert`. Any other, such as `assume`,
  `extern`, `havoc`, `skip` or `verify`, is refused wherever on a line it
  appears, because it would tell the prover to trust or skip something.
- Keep I/O, classes and libraries out of these files; put them in the shell.
- When a proof fails, the summary names the function and the annotation, and
  the full Dafny output is in `gen/proof/<unit>.log`.

Tests for the shell go in `test/*.test.ts` and run with Node's test runner.

## Who syncs

The agent working in your session does: Claude Code, or any agent that reads
AGENTS.md. Its procedure is the `sync` skill in
`.claude/skills/sync/SKILL.md`: run `npm run check`, translate what the
report asks for (story to rules, rule to Quint, a changed model back to prose,
a counterexample to a new rule), repeat, then stop for your `npm run accept`.
Nothing else needs to be installed or signed in.

## Using it from another package

The toolchain is a package with a `spec` command. It is not on the npm
registry; install it from a path or a tarball made with `npm pack`.

```sh
npm install --save-dev /path/to/onespec-0.1.0.tgz
npx spec init      # adds the sync skill, AGENTS.md, CONTRIBUTING.md, a tsconfig.json,
                   # .gitignore entries and package scripts; replaces nothing
npm run check
```

`spec` expects `spec/*.md`, and optionally `src/`, `test/*.test.ts` and a
`tsconfig.json`, in the directory it is run from. Without a `tsconfig.json`
nothing is typechecked, and the check says so. `examples/dashboard` is such
a package. To hand the generated code to yet another package, compile
`gen/*.ts` with `tsc` and export the result; it has no dependencies.

## Large applications

- **One spec per area**, each a few hundred lines: a state machine for each
  thing that has a life cycle, libraries for what they share, and machines
  that import machines where rules span them. `check` runs them in dependency
  order and proves each one against the *definitions* of what it imports, not
  their proofs, so the cost of a proof grows with the spec, not with
  everything beneath it.
- **Only what changed is checked again.** A spec that passed simulation, and
  each proof result, is remembered in `.spec-cache/` under a fingerprint of
  the spec, everything it imports and the versions of the tools. Set
  `SPEC_NO_CACHE=1` to run everything afresh, which also gives the simulator
  new random traces. `accept` always runs afresh.
- **Three levels of assurance**, reported per obligation: proved for all
  inputs; simulated and accepted; and the shell, which is tested.
- **The spec covers the rules, not the plumbing.** The dashboard example
  states its rules in about 700 lines of spec; chat, HTTP and spreadsheet
  access would stay hand-written around the generated core, as its
  `src/notify.ts` does for sending messages.

## Checking harder

`npm run check` simulates. To check a model exhaustively up to a depth with
the Apalache model checker (needs Java 17+, downloads Apalache on first use):

```sh
npx quint verify gen/order.run.qnt --main order_run --invariant inv --max-steps 10
```

## Changing the tools

`tools/spec.ts` is the pipeline. `tools/gen.ts` is the translator: it reads
what a module imports and defines, and hands the rest to one file each in
`tools/gen/`: `types.ts` (everything decided by a type), `print.ts`
(expressions), `classify.ts` (which definition is a transition, a guard or a
rule), `typescript.ts` and `harness.ts` (the two outputs). All of it is
TypeScript that Node runs directly (`npm run build` compiles it for the
packaged `spec` command).

`check(root)` returns `{ ok, results }`, one result per stage and spec with
`ok`, `stage`, `summary` and `detail`; the command line prints them. `npm run
selftest` builds scratch projects, from this project's spec or from the small
specs in `tools/fixtures/`, breaks one thing at a time and asserts on those
results which stage catches each. Add a case for every new
kind of mistake a change is meant to catch.
