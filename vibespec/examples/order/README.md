# Order checkout

Draft, instalments, take-back, hold, cancel and reopen.

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

The shell parses external events, stores allowed events and replays them
through the generated core.
