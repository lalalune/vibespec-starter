---
name: sync
description: Bring the stories, rules, Quint model and generated TypeScript of this repository back into step. Use when the user asks for new or changed behaviour of an application that has a spec/ directory, after any change to spec/*.md or src/, when the user adds or edits a story or rule, when they edit Quint by hand, or when `npm run check` shows a ✗.
---

# Sync the spec

You, the agent working in this session, do the syncing. No other program is
needed: the tools detect what is out of step and you make the translations.

## Before you start

- Read CONTRIBUTING.md once per session, at least "Writing a spec",
  "Supported Quint" and "Writing good rules"; it is the reference for every
  construct and name the checks refuse.
- **A request for new behaviour starts as a story.** Add it in the user's
  words, as a `## Story: …` with a `>` quote, to the spec it belongs to; a new
  application or area gets a new `spec/<name>.md` (the name is a plain
  identifier and becomes `gen/<name>.ts`). Then run the loop: the check asks
  for the rules, and you write them.
- Code that only touches the outside world (HTTP, storage, UI) goes in `src/`
  and calls the generated `parseEvent`, `enabled` and `step`; logic goes in
  the spec.

## The loop

1. Run `npm run check`. It runs every check and prints a report. Each line
   starting with `✗` is something to resolve. Under `review` it also prints
   both halves of every rule that moved.
2. Resolve the **first** failing stage using the table below, by editing
   `spec/*.md` (and `src/` or `test/` only when `types` or `tests` asks for it).
3. Run `npm run check` again. Repeat until the only `✗` lines are `review`
   items saying `new`, `prose changed`, `model changed` or `prose and model
   both changed`, and `proof` items listing obligations that you could not
   prove (see below).
4. Stop and report (see "When you stop"). Do not accept anything.

Give up and report after five rounds on the same failure.

The check remembers what passed, keyed on what each spec and proof means:
editing prose costs nothing, and editing one spec re-checks only it and the
specs that import it. Do not set `SPEC_NO_CACHE=1` while iterating; the
user's `npm run accept` always checks afresh. In a package of its own, such
as `examples/dashboard`, run the check from that directory.

## What each failure asks of you

| Report says | Translate |
|---|---|
| `review` … **story has no rules** | Story → rules. Under the story, write one `###` rule for each thing the story requires: a sentence a product owner would call true or false. Then write each rule's Quint. If the story makes a new kind of state possible, add a `sometimes` rule for it. |
| `review` … **not formalized** | Rule → model. Write Quint that says exactly what the sentence says and no more. If that model then breaks a rule, the trace shows what the sentence left out. |
| `review` … **prose changed** | Rule → model. If the meaning changed, change the Quint to match. If only the wording changed, leave the Quint. |
| `review` … **model changed** | Model → rule. Someone edited the Quint. Rewrite the sentence so that a reader of the prose alone is not misled. |
| `review` … **prose and model both changed**, or **new** | Read both halves and make sure they moved to the same place. |
| `review` … **removed or renamed** | Check that no story still depends on the rule. |
| `model` | Fix at the reported `spec/…:line:col`. CONTRIBUTING.md lists what Quint is supported and which names are refused. |
| `always` with a trace | Model → rule. The trace reaches a state that breaks the named rule; its last lines name the event and its guard. Decide whether the user would want that trace forbidden. If so, write the **reason** as a new rule and guard, such as "a payment may not exceed the balance". Only if you cannot find the reason, use the fallback the report offers: refuse the event when its result would break the rule. If the trace is fine and the `always` rule is wrong, fix the rule and say so. |
| `always` … "the law … is false for" | The law or the function is wrong for those arguments. Fix whichever does not say what the prose says. |
| `always` … "the simulator could not run" | A definition failed while being evaluated: usually a list index out of range, a missing map key or a division by zero. Guard it in the definition that uses it. |
| `sometimes` not reached | A guard is too strict, a transition is missing, or the goal needs values the simulator does not try (define `<param>Values`). |
| `sometimes` … **never happened** | The guard refused its event in every state reached, so every rule holds of it trivially and the story behind it may be impossible. Find which clause never holds: loosen the guard, add the transition that leads to the states it needs, or define `<param>Values` that it allows. If the event can only happen after more than 20 events, say so in your report; do not remove the event or weaken the guard to make the check pass. |
| `sometimes` ✓ … **never seen to refuse** | Not a failure. For each guard listed, check that it refuses what its rule says. If it only restates an `always` rule, keep it when it protects `enabled` from outside input; if it was meant to refuse something, write what, or define `<param>Values` that it refuses. List these guards in your report. |
| `replay` | Generated TypeScript and Quint disagree. That is a bug in the tools, not in the spec. Stop and report it. |
| `types` | Update `src/` and `test/` to the new generated contract. If it says there is no `tsconfig.json`, run `npx spec init`. |
| `proof` … "not proved" | It holds in simulation; it is yours to prove. First decide whether it is true for every state that satisfies all the rules. If it is not (you can name such a state), no proof can help: the missing fact about reachable states becomes a new `always` rule, a discovered rule. If it is, prove it in the unit's proof file, `spec/<name>.proof.dfy` or `src/<path>.proof.dfy`: copy the obligation's `lemma …_ensures` header from `gen/proof/<unit>/<unit>.dfy` and write its body, calling `ProofLib` lemmas and your own helper lemmas (CONTRIBUTING.md, "Proof files"). Only what you cannot prove goes in your report, with what you tried; recording it as simulated only is the user's last resort, not yours. |
| `proof` … "Dafny could not check it" | The generated or hand-written code is not something Dafny accepts (an unguarded lookup, index or division, or a wrong annotation), or the proof file is refused or does not verify: a stale header, a forbidden construct, a helper lemma that fails. The lines under it say which, with the file and line. |
| `proof`, a `src-…` unit | Fix the hand-written code, its `//@` annotation, or its proof file. The full output is in `gen/proof/<unit>.log`. A line saying it holds "under N //@ requires" is not a failure, but report each precondition: unverified callers must meet it. |
| `proof` … "accepted earlier … no longer count" | The unit or its proof file changed since the user accepted those obligations as simulated only. Treat them as "not proved" above; whatever you cannot prove, report for the user to accept again. |
| `proof` … "accepted earlier now prove" | Good news: report it; the user may tighten the ledger with `npm run accept -- unproved`. |
| `tests` | Fix the application or its test in `src/` and `test/`. |

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
- Never edit `gen/`, `.spec-cache/` or `spec/*.lock.json`, and never add a
  `lemmascript.json`. The tools own them. Proof files are yours to write.
- Never try to get a proof past the checks instead of proving it.
- Do not run `npm run accept` or `npm run accept -- unproved`. They are the
  user's sign-off.

## When you stop

Tell the user, in this order:

1. **Rules added** from their stories.
2. **Rules discovered** by the checks, each with what went wrong without it.
   These need their confirmation most.
3. **Rules changed**, and which half you changed to follow the other.
4. **Proved by hand**: proof files you wrote or changed, and which
   obligations they prove.
5. **Not proved**: obligations that hold in simulation only, if any, each
   with why you could not prove it.
6. **Could not formalize**: anything in a story you left out, and why.

Then ask them to read the diff of `spec/` and run `npm run accept`.
