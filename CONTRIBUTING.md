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
| `pure def canPay(o: Order, amount: int): bool` | the guard of `pay` (same parameters); optional | `canPay`, used by `enabled` and `step`. What is proved about `pay` is proved for the cases the guard allows. A guard may call its own transition to look at the result. `check` fails if it never allows `pay` in a reachable state, and lists it if it is never seen to refuse |
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
`state`, …) and `ProofLib`, JavaScript globals and keywords (`Number`, `delete`, …), Quint
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
- A guard that never allows its event makes it impossible, and every rule
  then holds of it trivially, so nothing else would notice. `check` fails
  when no simulated state allows one. It also lists guards it never saw
  refuse their event: such a guard often only restates an `always` rule,
  which is fine when it protects `enabled` from outside input, or refuses
  only beyond the simulator's 20 events.
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
for each one, in this order:

1. **Prove it** in the unit's proof file (next section). This is the agent's
   work, like any other translation.
2. **State the missing fact**, if the obligation is false for some state that
   satisfies every rule: no proof can help then. Add it as an `always` rule
   or a law (the inductiveness case above). Moving arithmetic into a small
   function with a law in a library spec, or writing a loop by hand in
   `src/`, also gives Dafny smaller steps.
3. **Accept simulation for it**: the user's decision, never the agent's.
   `npm run accept -- unproved` records the obligations in
   `spec/unproved.lock.json`, per unit, with a fingerprint of the unit's text
   and proof file. The check then passes and says how many obligations are
   simulated only. It fails again if a *new* one appears, or if the unit or
   its proof file changes: what was accepted for one text does not carry over
   to another. Read the list before recording it: an obligation that is false
   is also "not proved".

Counting is per obligation. Dafny checks every `ensures` on its own, a
failing one is never assumed while another is checked, and the prover works
to a fixed resource limit (`RESOURCE_LIMIT` in `tools/prove.ts`) rather than a
time limit, so the answer does not depend on the machine. An obligation it
could not finish is marked `[the prover ran out of resources]`.

### Proof files

`spec/<name>.proof.dfy` proves obligations of `gen/<name>.ts`;
`src/<path>.proof.dfy` proves those of `src/<path>.ts`. A proof file that
belongs to no unit is reported.

**What the prover sees** is `gen/proof/<unit>/<unit>.dfy`, written by every
`npm run check`, and Dafny's full output is `gen/proof/<unit>.log`. The file
is, in order: what LemmaScript generated (the modules the unit imports, with
names prefixed `<module>_` and without their obligations, then the unit
itself), the bodies the proof file supplied, the lemmas the tools add, the
proof file's helpers, and the library. Each obligation is one `ensures` of a
generated `lemma <fn>_ensures`: for a transition, one per `always` and `step`
rule, each conditional on `inv` and the guard; for a law, `<law>(...) == true`.

**Grammar.** A proof file holds only `lemma` declarations, each with a body,
and `//` comments. Anything else is refused with its file and line.

- A lemma named like a generated `<fn>_ensures` supplies that lemma's body.
  Its header must repeat the generated one exactly; copy it from the `.dfy`
  (whitespace and comments do not matter). When a rule changes, the header
  changes, and the old body is refused as stale.
- Any other lemma is a helper, added after the generated text. Its name must
  not be one the `.dfy` already declares.
- Inside bodies: `assert`, `assert … by`, `calc`, `forall … ensures`, `if`,
  `match`, `var`, `reveal`, calls to lemmas, and the attributes `{:trigger}`
  and `{:induction}`.
- Refused: block comments, `@`, any other attribute, character literals,
  anything but ASCII outside comments and strings, and the words that
  declare or trust something: `assume`, `expect`, `function`, `predicate`,
  `method`, `ghost`, `const`, `type`, `datatype`, `include`, `import`,
  `module`, `reads`, `modifies`, `opaque`, `axiom`, `verify` and the rest of
  `FORBIDDEN` in `tools/prove.ts`.
- After that, LemmaScript refuses the `.dfy` unless it is its own output plus
  added lines, and `dafny audit` refuses anything assumed rather than proved.
  A helper or library lemma that does not verify fails the unit; it is never
  counted as an obligation.

**What a proof can call:**

- `ProofLib.<Name>(...)` from `tools/proof/lib.dfy`, added to every unit that
  has a proof file: `Filter` (a heap-free view of `Std.Collections.Seq.Filter`,
  see below), `Distinct`, `DistinctBy`, and lemmas about filters
  (`FilterNil`, `FilterCons`, `FilterAppend`, `FilterMember`, `FilterSubset`,
  `FilterNone`, `FilterOne`, `FilterTwo`, `FilterCountOneIffUnique`,
  `FilterDistinctCountOne`, `FilterKeepsDistinctBy`, `FilterLengthPointwise`,
  `FilterPointwise`, `FilterSamePredicate`, `FilterOfFilterShorter`) and folds
  (`FoldLeftInflationary`, `FoldLeftAboveEach`, `FoldLeftMax`,
  `FoldLeftPointwise`, `FoldLeftConcatEmpty`, `FoldLeftDedupDistinct`).
  Read the file for what each states. A lemma general enough for any project
  belongs there, with its proof; one about your spec belongs in your proof
  file.
- A law of an imported module, if its own unit proved it in the same run:
  `<module>_<law>_ensures(args)` gives `<module>_<law>(args) == true`. (In a
  `src` unit, the laws of the module it imports are `<law>_ensures`.)
- The generated `_ensures` lemmas and Dafny's standard library.

`step_ensures` gets a body from the tools that calls each transition's lemma;
supply one to replace it.

**Two Dafny facts** shape most proofs about lists:

- `Std.Collections.Seq.Filter` is opaque and reads the heap, so a fact about it
  proved in a lemma does not meet the same call inside a generated rule.
  State facts about `ProofLib.Filter`, and connect them to the rule with a
  helper whose `ensures` is the rule's body with `ProofLib.Filter` in place of
  `Std.Collections.Seq.Filter`; it proves with an empty body:
  `lemma KeysBridge(r: Registry) ensures alwaysAKeyNamesOneProject(r) == Std.Collections.Seq.All(r.entries, (a: Entry) => (|ProofLib.Filter((b: Entry) => (b.key == a.key), r.entries)| == 1)) { }`.
- A lambda is the same term only if it is the same text: pass the lambda the
  generated code uses, copied verbatim from the `.dfy`.

**To prove an obligation:**

1. Find its lemma in `gen/proof/<unit>/<unit>.dfy` (the check names the
   definition and the clause).
2. Copy the lemma's header into the proof file and write a body. For a
   transition, the usual shape is
   `if inv(s) && canX(s, …) { var after := x(s, …); …facts about after… }`.
3. Run `npm run check`. Dafny's messages point into the `.dfy`; the log has
   them all.

`tools/fixtures/highest.md` is the smallest example: its law needs induction
over a fold, and this proof file proves it (the selftest runs it):

```dafny
lemma lawTheHighestIsAtLeastTheStart_ensures(xs: seq<int>, start: int)
  ensures (lawTheHighestIsAtLeastTheStart(xs, start) == true)
{
  ProofLib.FoldLeftMax((top: int, x: int) => (if (x > top) then x else top), start, xs);
}
```

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
  the full Dafny output is in `gen/proof/<unit>.log`. A proof that needs more
  than annotations goes in `src/<path>.proof.dfy` (see "Proof files").
- Such a unit is proved against the definitions of the module it imports.
  If that module has obligations that are simulated only, its proof line says
  that it is proved assuming them, with how many and where.

Tests for the shell go in `test/*.test.ts` and run with Node's test runner.

## Who syncs

The agent working in your session does: Claude Code, or any agent that reads
AGENTS.md. Claude Code reads `AGENTS.md` only when a project has no
`CLAUDE.md` (and only from v2.1.277), so `spec init` makes `CLAUDE.md`
import it with one line, `@AGENTS.md`, adding that line to a `CLAUDE.md` the
project already has. The instructions then load once, in every version. Its procedure is the `sync` skill in
`.claude/skills/sync/SKILL.md`: run `npm run check`, translate what the
report asks for (story to rules, rule to Quint, a changed model back to prose,
a counterexample to a new rule), repeat, then stop for your `npm run accept`.
Nothing else needs to be installed or signed in.

## Using it from another package

The toolchain is a package with a `spec` command. It is not on the npm
registry; install it from a path or a tarball made with `npm pack`.

```sh
npm install --save-dev /path/to/onespec-0.1.0.tgz
npx spec init      # adds the sync skill, CONTRIBUTING.md, a tsconfig.json, .gitignore
                   # entries and package scripts, a section to AGENTS.md (created
                   # if missing) and an import of it to CLAUDE.md; replaces nothing
                   # of the project's own
npm run check
```

`spec` expects `spec/*.md`, and optionally `src/`, `test/*.test.ts` and a
`tsconfig.json`, in the directory it is run from. Without a `tsconfig.json`
nothing is typechecked, so the `types` stage fails if there is a `src/` or
`test/` for it to check. `examples/dashboard` is such
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
  what the spec means, everything it imports and the versions of the tools.
  Prose and the line numbers generated code cites are left out of the
  fingerprint, so editing prose re-runs neither simulation nor proofs.
  Simulation runs overlap. `SPEC_QUICK=1` simulates a tenth as much while
  iterating on a large spec; the result says so, and `accept` always
  simulates in full. Set
  `SPEC_NO_CACHE=1` to run everything afresh; `accept` always does. The
  simulator's seed is derived from what it simulates, so the same spec gives
  the same traces and a counterexample can be had again; set `SPEC_SEED=<n>`
  to try other traces.
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

`tools/spec.ts` is the pipeline. `tools/prove.ts` proves one unit: it
checks and splices the proof file, runs LemmaScript, `dafny audit`, and
checks again on its own every postcondition that a failing one could have
hidden; `tools/proof/lib.dfy` is the library proof files call.
`tools/gen.ts` is the translator: it reads
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
