# Order checkout

A checkout with a draft, instalment payments, hold, cancellation and reopening.

```sh
npm run check --workspace order-example
npm run demo
```

| Path | Role |
|---|---|
| `spec/index.md` | Stories, rules and the Quint checkout model |
| `spec/lock.json` | Review ledger for this example |
| `src/ledger.ts` | Event replay and balance, with proved contracts |
| `src/app.ts` | Order storage, input parsing and rejection reporting |
| `src/demo.ts` | Scripted checkout session |
| `test/app.test.ts` | Checkout journeys through the real shell |
