---
name: sync
description: Bring the stories, rules, Quint model and generated TypeScript of this repository back into step. Use after any change to spec/*.md or src/, when the user adds or edits a story or rule, when they edit Quint by hand, or when `npm run check` shows a ✗.
---

# Sync the spec

You, the agent working in this session, do the syncing. No other program is
needed: the tools detect what is out of step and you make the translations.

## The loop

1. Run `npm run brief`. It runs every check and prints a report. Each line
   starting with `✗` is something to resolve.
2. Resolve the **first** failing stage using the table below, by editing
   `spec/*.md` (and `src/` or `test/` only when `types` or `tests` asks for it).
3. Run `npm run brief` again. Repeat until the only `✗` lines are `review`
   items saying `new`, `prose changed`, `model changed` or `both changed`,
   and `proof` items listing obligations that are "not proved".
4. Stop and report (see "When you stop"). Do not accept anything.

Give up and report after five rounds on the same failure.

## What each failure asks of you

| Report says | Translate |
|---|---|
| `review` … **story has no rules** | Story → rules. Under the story, write one `###` rule for each thing the story requires: a sentence a product owner would call true or false. Then write each rule's Quint. If the story makes a new kind of state possible, add a `sometimes` rule for it. |
| `review` … **not formalized** | Rule → model. Write Quint that says exactly what the sentence says and no more. If that model then breaks a rule, the trace shows what the sentence left out. |
| `review` … **prose changed** | Rule → model. If the meaning changed, change the Quint to match. If only the wording changed, leave the Quint. |
| `review` … **model changed** | Model → rule. Someone edited the Quint. Rewrite the sentence so that a reader of the prose alone is not misled. |
| `review` … **removed or renamed** | Check that no story still depends on the rule. |
| `model` | Fix at the reported `spec/…:line:col`. CONTRIBUTING.md lists what Quint is supported and which names are refused. |
| `always` with a trace | Model → rule. The trace reaches a state that breaks the named rule; its last lines name the event and propose "refuse *event* when its result would break *rule*". Decide whether the user would want that trace forbidden. If so, write the **reason** as a new rule and guard: prefer "a payment may not exceed the balance" to the proposed look-ahead. If you cannot find the reason, use the proposal. If the trace is fine and the `always` rule is wrong, fix the rule and say so. |
| `always` … "the law … is false for" | The law or the function is wrong for those arguments. Fix whichever does not say what the prose says. |
| `sometimes` not reached | A guard is too strict, a transition is missing, or the goal needs values the simulator does not try (define `<param>Values`). |
| `replay` | Generated TypeScript and Quint disagree. That is a bug in the tools, not in the spec. Stop and report it. |
| `types` | Update `src/` and `test/` to the new generated contract. |
| `proof` … "not proved", generated module | Model → rule. It holds in simulation but not for every state. Look for a fact about reachable states that no rule states, and add it as an `always` rule: that is a discovered rule. If there is no such fact (the obligation depends on a fold or a count), leave it and list it in your report. |
| `proof`, a `src/` file | Fix the hand-written code or its `//@` annotation. The full output is in `gen/proof/<file>.log`. |

## Rules for what you write

- Prose and Quint are two statements of the same rule. Neither is senior: the
  half that changed last is the one the user meant.
- Quint is only read from blocks under a `###` rule. If you add a definition
  to an existing rule's block, check that the rule's sentence still covers it;
  otherwise give it its own rule.
- A rule that the checks forced, and that the user did not write, goes under
  the story it belongs to, in the user's vocabulary, with a sentence beginning
  "Discovered by simulation:" or "Discovered by the proof:" that says what
  went wrong without it.
- Never weaken or delete an `always`, `step`, `sometimes` or `law` rule to
  make a check pass, unless it is the rule that is wrong, and then say so.
- Never edit `gen/` or `spec/*.lock.json`.
- Do not run `npm run accept` or `npm run accept -- unproved`. They are the
  user's sign-off.

## When you stop

Tell the user, in this order:

1. **Rules added** from their stories.
2. **Rules discovered** by the checks, each with what went wrong without it.
   These need their confirmation most.
3. **Rules changed**, and which half you changed to follow the other.
4. **Not proved**: obligations that hold in simulation only, if any.
5. **Could not formalize**: anything in a story you left out, and why.

Then ask them to read the diff of `spec/` and run `npm run accept`.
