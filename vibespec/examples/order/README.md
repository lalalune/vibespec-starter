# Order checkout

Draft, instalments, take-back, hold, cancel and reopen.

```sh
pnpm --filter order-example check
pnpm demo
```

| Path | Role |
|---|---|
| `spec/index.md` | Stories, rules and the Quint checkout model |
| `spec/lock.json` | Review ledger for this example |
| `src/ledger.ts` | Event replay and balance, with proved contracts |
| `src/app.ts` | Order storage, input parsing and rejection reporting |
| `src/demo.ts` | Scripted checkout session |
| `test/app.test.ts` | Checkout journeys through the real shell |
