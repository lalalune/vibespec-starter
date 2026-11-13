# Assistant

An illustrative agent turn driving a bill payment, in one spec:
[spec/assistant.md](spec/assistant.md). `pnpm check` simulates and proves it, then runs the VibeLang shell journeys.

| Behaviour | Rule |
|---|---|
| Every model choice spends a bounded budget | `stepChoicesSpendBudget`, `alwaysBudgetBounded` |
| The sender comes from the session, never the message | `by`; `step(s, e, by)` |
| A late reply is refused, before or after a restart | `stepReplyAnswersWaiting`, `stepRequestNeverGoesBack` |
| A bill is reviewed, then paid once, after the person's confirmation | `alwaysPaidOnlyReviewed`, `alwaysChargedOnce`, `stepChargedOnlyOnConfirm` |
| Card details and payment go only to the biller's own page | `alwaysFilledOnlyGenuine`, `stepPaidOnlyOnGenuine` |
| The model cannot have the card read aloud | `alwaysNothingSecretSaid` |
| The program carries out effects from an outbox | `outbox`, `drain` |

Run `pnpm install` and `pnpm check` in this directory.

The VibeLang shell in `src/agent.vibe` drives the generated `Machine` through
`Model` and `World` services. The scripted services are shared by the demo and
`test/assistant.test.vibe`; live authentication, payment execution and durable
storage remain outside this example.
