# Order checkout

A checkout with a draft, instalment payments, hold, cancellation and reopening.
The complete example lives here; the template's root `spec/index.md` is empty.

```sh
npm run check --workspace order-example
npm run demo
```

Run those commands from the repository root. This package can also run them
from its own directory after the root install:

| Command | Does |
|---|---|
| `npm run check` | Everything: model, simulation, proofs, types, the tests below, review |
| `npm run demo` | Generates `gen/` and prints a scripted checkout, run from source |
| `npm run build` | `vibelang`: typechecks `.vibe` and `.ts` together and writes JavaScript to `dist/` |
| `npm test` | `vitest run`: the journeys in `test/app.test.vibe`, compiled by `vibelang-vite`. `check` runs it after writing the simulated events its last journey sends; `gen` and `demo` clear them |

| Path | Role |
|---|---|
| `spec/index.md` | Stories, rules and the Quint checkout model |
| `spec/lock.json` | Review ledger for this example |
| `gen/index.ts` | The verified core, generated |
| `gen/index.effect.vibe` | The same core for Effect code, generated: `apply`, `decodeEvent`, and the failures `Rejected` and `NotAnEvent` |
| `src/ledger.ts` | Event replay and balance, with proved contracts |
| `src/app.vibe` | The `OrderBook` service: order storage, input decoding and rejection reporting |
| `src/demo.vibe` | Scripted checkout session |
| `test/app.test.vibe` | Checkout journeys through the real shell |

The model has 10 transitions, six `always` rules, one `step` rule and three
`sometimes` goals. The shell decodes external events, stores allowed events
and replays them through the generated core.

## VibeLang and TypeScript

The shell is [VibeLang](https://github.com/smithersai/vibelang): TypeScript
syntax in which an `effect` function returns an [Effect](https://effect.website),
`try` runs one and `throw` fails with a typed error. `OrderBook` is a service
with one layer, `OrderBookMemory`. `dispatch` fails with `NotAnEvent` for input
that is not an event and `Rejected` for an event the rules refuse, so a caller
cannot forget either case, and the book takes one event at a time.

Two things stay TypeScript:

- `gen/index.ts` is what the proofs are about. `gen/index.effect.vibe` only
  calls it.
- `src/ledger.ts` carries `//@` contracts, which LemmaScript and Dafny prove
  from TypeScript. `src/app.vibe` calls it through a `module` body, the one
  place a `.vibe` file states what a TypeScript function throws.

`demo` runs `src/demo.vibe` from source with `node --import vibelang/register`.
`dist/` and `.vibe/` are build output.
