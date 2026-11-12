# Operating procedure for agents

This repository has one source of truth per application: `spec/<name>.md`.
Stories, rules and the Quint model live there together. TypeScript in `gen/`
is derived from it. Your job is to keep the spec true to what the user wants
and to keep `npm run check` green.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the spec format and naming rules
before editing a spec.

## Who does what

The tools detect; you translate. `npm run check` tells you which story has no
rules, which rule has no Quint, which half of a rule moved, which trace
breaks which rule and which transition cannot be proved. Turning a story into
rules, a rule into Quint, a changed model back into prose, and a
counterexample into a new rule is your work.

You are reached in one of two ways:

- **By `npm run sync`.** You receive a brief and the check report on stdin.
  Edit files to resolve every `✗`, run nothing, and finish; the check is
  rerun for you and you are called again with the new report if anything is
  left.
- **Interactively.** Run `npm run check` yourself and follow the loop below.

Either way the person signs off with `npm run accept`.

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

## The loop

Run `npm run check` after every change to `spec/` or `src/`. Fix the first
failing stage, then run it again.

### From stories to a model

1. Write the story under a `##` heading, as the user told it.
2. Under it, write one `###` rule per thing the story requires. A rule is one
   sentence a product owner would recognise as true or false.
3. Under each rule, write the Quint that says the same thing: a type, a
   transition with its guard, an `always` rule, or a `sometimes` rule.
4. When a story makes a new kind of state possible, add a `sometimes` rule
   for it. Without one, rules that forbid everything pass.

### When a stage fails

| Stage | What it means | What to do |
|---|---|---|
| `model` | The spec does not typecheck, or uses something the translator refuses. | Fix at the reported `spec/…:line:col`. If the construct is legitimate, extend `tools/gen.ts`. |
| `always` | The printed trace reaches a state that breaks the named rule. The last line names the event that got there and its guard. | Decide whether the user wants that trace forbidden. If so a rule is missing: add a guard or rule, in prose and Quint. If not, the `always` rule is wrong: fix it and tell the user. |
| `sometimes` | No simulated trace reaches the goal. | A guard is too strict, a transition is missing, or the goal needs event values outside −1…6 (see `SAMPLES` in `tools/gen.ts`). |
| `replay` | Generated TypeScript and Quint disagree. | This is a bug in `tools/gen.ts`, not in the spec. Fix the generator. |
| `types` | `src/` or `test/` no longer fits the generated contract. | Update the application to the new contract. |
| `proof`, generated module | An obligation holds in simulation but Dafny cannot prove it. Either the rules are not inductive (some unreachable state satisfies every rule and breaks one after a step), or the rule depends on a fold or a count that Dafny cannot see through. | First look for an unstated fact and add it as a rule. If there is none, follow "When a proof does not go through" in CONTRIBUTING.md. Do not run `npm run accept -- unproved` yourself: recording an obligation as simulated-only is the user's decision. List the obligations for them. |
| `proof`, `src/` file | A hand-written `//@ ensures` or loop invariant does not hold. | Fix the code or the annotation. The full Dafny output is in `gen/proof/<file>.log`. |
| `review` | Prose or model of the listed rules changed since they were last reconciled. | See below. |

### Reconciling prose and model

The prose and the Quint are two statements of the same rule; neither is
senior. `review` reports one of these per rule:

- **story has no rules**: translate the story into `###` rules.
- **not formalized**: the rule has prose only. Write its Quint, saying
  exactly what the prose says and no more. If that model breaks a rule, the
  trace shows what the prose left out.
- **new**: read both halves and confirm they agree.
- **prose changed**: if the meaning changed, change the Quint to match.
- **model changed**: if the meaning changed, rewrite the prose so that a
  reader of the prose alone is not misled.
- **prose and model both changed**: confirm they moved to the same place.
- **removed or renamed**: confirm the rule is meant to be gone, and that no
  story still depends on it.

Quint is only read from blocks under a `###` rule, so a model element with no
rule cannot exist. If you add a definition to an existing rule's block, check
that the rule's sentence still covers it; otherwise give it its own rule.

When every listed rule agrees, the work is ready for `npm run accept`, which
runs the whole check and records the rules as reconciled only if every other
stage passes.

### Rules the checks discovered

When `always` or `proof` forces a new rule or guard, that rule did not come
from the user. Add it under the story it belongs to, in the user's
vocabulary, say in its prose that it was discovered and by what, and list it
in your summary so the user can confirm it is what they want. "No more can be
removed than the order holds" in `spec/order.md` is an example.

## Definition of done

- `npm run check` prints no `✗` other than `review` items that are waiting
  for the user's `npm run accept`.
- If you changed anything under `tools/`, `npm run selftest` passes, with a
  new case for any new kind of mistake the change is meant to catch.
- Your summary lists: rules added or changed, rules discovered by the checks,
  and anything you could not formalize.
