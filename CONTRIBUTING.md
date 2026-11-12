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
| `pure def canPay(o: Order, amount: int): bool` | the guard of `pay` (same parameters); optional | `canPay`, used by `enabled`, `step` and as the precondition of `pay` |
| `pure def alwaysPaidWithinDue(o: Order): bool` | a rule that holds in every reachable state | a conjunct of `inv`; simulated and proved |
| `pure def sometimesPaid(o: Order): bool` | a state that must be reachable | a reachability check with a witness trace |
| any other `pure val` or `pure def` | a constant or helper | the same constant or function |

Names that are refused, with a message saying why: `init`, `step`, `inv`,
`enabled`, `isEvent`, `Event`, `initialHolds`, `state`, TypeScript keywords
(`delete`, `new`, …), Quint built-ins (`to`, `next`, `always`, …), a
parameter named like a variant, and near-misses of the conventions above such
as `alwayspaid` or `CanPay`.

### Supported Quint

`int`, `bool`, `str`, records, and sum types whose variants carry no data;
arithmetic `+ - *`, comparisons, `and or not implies iff`, `if … else`,
record construction, spread update and field access, calls to your own
`pure def`s, and `val` bindings at the top of a definition. Integer literals
must fit in 2^53.

Anything else stops the `model` stage with the name of the construct, rather
than being translated loosely. To add an operator, add a case to `print` in
`tools/gen.ts`; to change the values the simulator tries for event
parameters (integers −1…6, both booleans, three strings, every variant),
edit `SAMPLES` there. Run `npm run selftest` afterwards.

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

## Choosing the agent for `npm run sync`

`sync` runs the command in `SPEC_AGENT`, in the repository root, with the
brief and the check report on stdin. The command must be able to read and
edit files. The default is Claude Code in headless mode:

```sh
SPEC_AGENT="claude -p --permission-mode acceptEdits --allowedTools Read,Edit,Write,Grep,Glob" npm run sync
```

With no account, a local [Ollama](https://ollama.com) model can do the
simpler translations. Start `ollama serve`, then:

```sh
SPEC_AGENT="node tools/agent-ollama.ts" npm run sync     # OLLAMA_MODEL picks the model, default qwen2.5:7b
```

That adapter asks the model one small question per item: rules for a story
that has none, prose for a rule whose model changed (or the reverse), and a
stronger guard for a new transition that a trace shows to be too permissive.
A 7B model gets these right often, not always, and writes clumsy headings;
the checks reject what is wrong and `review` leaves the wording to you. It
does not attempt failed proofs.

`node tools/spec.ts brief` prints exactly what the agent would be given, for
pasting into an agent by hand.

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
