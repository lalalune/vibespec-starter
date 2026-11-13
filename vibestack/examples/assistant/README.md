# Assistant

An illustrative agent turn driving a bill payment, in one spec:
[spec/assistant.md](spec/assistant.md), and the agent loop around it.

```sh
pnpm install --ignore-workspace   # here, after the install at the repository root
pnpm check   # model, proofs, types (vibelang --noEmit) and tests
pnpm test    # the journeys alone: vitest run
pnpm build   # vibelang: JavaScript in dist/
pnpm demo    # generates gen/, and a scripted model pays a bill, then tries what the rules refuse
```

| Behaviour | Rule |
|---|---|
| Every model choice spends a bounded budget | `stepChoicesSpendBudget`, `alwaysBudgetBounded` |
| The sender comes from the session, never the message | `by`; `step(s, e, by)` |
| A late reply is refused, before or after a restart | `stepReplyAnswersWaiting` |
| A bill is reviewed, then paid once, after the person's confirmation | `alwaysPaidOnlyReviewed`, `alwaysChargedOnce`, `stepChargedOnlyOnConfirm` |
| Card details and payment go only to the biller's own page | `alwaysFilledOnlyGenuine`, `stepPaidOnlyOnGenuine` |
| The model cannot have the card read aloud | `alwaysNothingSecretSaid` |
| The program carries out effects from an outbox | `outbox`, `drain` |

## The shell

The shell is [VibeLang](https://github.com/smithersai/vibelang): Effect in
TypeScript syntax, in `.vibe` files. `pnpm gen` writes
`gen/assistant.effect.vibe` beside the generated module, and the shell is
built on its `Machine` service: every event reaches the state through
`send(event, by)` or `receive(input, by)`, which fail with `Rejected` or
`NotAnEvent` where the rules or the parser refuse.

| In `src/agent.vibe` | Is |
|---|---|
| `Model` | the model as a service: `choose(seen)` returns an untrusted answer, or fails with `NoAnswer` |
| `World` | the biller and the browser as a service: `bill(request)`, `page()`, `perform(effect)` |
| `hear(said)` | what the person said, sent as the Person; then the loop: the model's answer offered as the Agent's choice, the outbox that choice left carried out and then drained, the page and the biller's answer sent as the World. It returns where the turn stopped and each answer that ended it, and fails with `Rejected` when the rules refuse the person |

An answer of the model that is no choice the rules allow, or no answer at all,
finishes the turn, so a turn makes at most four passes whatever the model
says.

`src/scripted.vibe` is a `Model` and a `World` that follow a script. The demo
and [the journeys](test/assistant.test.vibe) share it: a real model costs
money, so it is faked at its service. `src/demo.vibe` prints one scripted
bill payment.

What stays TypeScript is `gen/assistant.ts`, which the proofs are about. This
example has no hand-written file with `//@` contracts.

The outbox is carried out at least once: an effect is performed before
`drain` empties it away. There is no live `Model` or `World` here, and the
tests walk no restart.
