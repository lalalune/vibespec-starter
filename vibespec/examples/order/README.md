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
| `src/app.vibe` | Order storage, input parsing and rejection reporting |
| `src/demo.vibe` | Scripted checkout session |
| `test/app.test.vibe` | Checkout journeys through the real shell |

The shell parses external events, stores allowed events and replays them
through the generated core.

The VibeLang shell provides `OrderBookMemory` and uses the generated Effect
adapter for decoding and guarded transitions. `src/ledger.ts` retains its
proved contracts. `pnpm test` runs the checkout journeys.
