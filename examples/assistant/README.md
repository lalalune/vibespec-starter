# Assistant

An Eliza-style agent turn driving a Grace-style bill payment, in one spec:
[spec/assistant.md](spec/assistant.md). `npm run check` simulates it, proves
it and runs [the trust-boundary test](test/assistant.test.ts).

| From | Behaviour | Rule |
|---|---|---|
| Eliza `runtime/limits.ts`, Grace `host/guide-loop.ts` | every agent turn ends | `stepChoicesSpendBudget`, `alwaysBudgetBounded` |
| Eliza `roles.ts`, `runtime/action-gate.ts` | the sender comes from the session, never the message | `by`; `step(s, e, by)` |
| Grace `host/bill-reconciliation.ts`, `task-board.ts` | a late reply is never acted on, before or after a restart | `stepReplyAnswersWaiting` |
| Billworld `engine.mjs` | reviewed, then paid once, on the person's yes | `alwaysPaidOnlyReviewed`, `alwaysChargedOnce`, `stepChargedOnlyOnConfirm` |
| Grace `browser-lookalike.ts`, `saved-detail-offers.ts` | card details and payment only on the biller's own page | `alwaysFilledOnlyGenuine`, `stepPaidOnlyOnGenuine` |
| Grace `secret-memory.ts` | the model cannot have the card read aloud | `alwaysNothingSecretSaid` |
| Grace `onboarding-machine.ts` | effects carried out by the program, from an outbox | `outbox`, `drain` |

Written by hand here, with no help from the tools yet:

| Need | How |
|---|---|
| Termination | a budget every choice spends |
| Requests in flight | a request number, saved |
| Crash and restart | `restart` resets what is not saved |
| The model and the world as adversaries | their choices are event parameters; the simulator tries every sender |
| Secrets | effects tagged `secret` |
| Effects | an outbox in the state |

What the tools still need for systems like these: [docs/roadmap.md](../../docs/roadmap.md), items 8–18.
