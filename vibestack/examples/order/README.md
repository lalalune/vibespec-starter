# Order checkout

A checkout with a draft, instalment payments, hold, cancellation and reopening.
The complete example lives here; the template's root `spec/index.md` is empty.

```sh
npm run check --workspace order-example
npm run demo
```

Run those commands from the repository root. This package can also run
`npm run check` and `npm run demo` from its own directory after the root install.

| Path | Role |
|---|---|
| `spec/index.md` | Stories, rules and the Quint checkout model |
| `spec/lock.json` | Review ledger for this example |
| `src/ledger.ts` | Event replay and balance, with proved contracts |
| `src/app.ts` | Order storage, input parsing and rejection reporting |
| `src/demo.ts` | Scripted checkout session |
| `test/app.test.ts` | Checkout journeys through the real shell |

The model has 10 transitions, six `always` rules, one `step` rule and four
`sometimes` goals. The shell parses external events, stores allowed events
and replays them through the generated core.
