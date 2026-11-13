# Architecture

How the repository is laid out, what is generated from what, and what each
kind of check establishes. [AGENTS.md](../AGENTS.md) is the procedure; this
is the map.

## One source of truth per layer

| Layer | Lives in | Owned by | Never |
|---|---|---|---|
| Source model | `spec/**/*.md` at the repository root, one tree for every package: stories, rules, Quint | a person, who signs off with `pnpm accept` | a second model of the same state |
| Generated contract | `gen/<name>.ts`, `gen/<name>.effect.vibe`, `gen/<name>.conformance.ts`: every module in the root's `gen/`; those of `spec/<name>/`, and what they import, also in the `gen/` of `apps/<name>` or `packages/<name>` | `spec gen` and `spec check` at the root; gitignored | edited by hand, imported from another package's `gen/` |
| Verified logic Quint cannot express | `src/**/*.ts` with `//@` contracts | hand-written, proved by Dafny | I/O, classes, libraries |
| Shell: effects, services, I/O | `src/**/*.vibe` on Effect 4 | hand-written VibeLang | rules restated; state the spec owns |
| Boundary schemas | `src/**/*.schema.ts` (Effect Schema) | hand-written | types repeated beside them |
| React interface | `src/**/*.tsx`, hooks over the `Machine` service | hand-written | business rules; state the spec owns in `useState` |
| Runtime state | the `Machine` service (`machine()` layer) | generated adapter | a store library |
| Persisted state | behind a service; read back through `decodeState` or a schema | the shell | trusted without parsing |
| Test fixtures | `test/`, `test/counterexamples/` | hand-written, or saved by a failing run | copies of generated values |

A transition is legal exactly when the spec's guard allows it: `enabled` and
`step` are generated from the model, the shell reaches the state only through
`Machine`, and a control is offered when `enabled` says so.

## What is generated, and where it goes

| Output | From | By | Written to | Kept in Git |
|---|---|---|---|---|
| TypeScript, Quint harness, Dafny | the spec | `spec gen`, `spec check` | `gen/` | no |
| Effect adapter | the generated TypeScript | `spec gen` | `gen/<name>.effect.vibe` | no |
| Conformance module: events, journeys, `conformance`, `replay` | Quint simulation | `spec check` | `gen/<name>.conformance.ts` | no |
| Property and model-based tests | schemas, contracts, drivers | `vibestack/testing/generate.ts` | `.cache/generated/tests/` | no |
| Component stories and their catalog | component prop types and `*.meta.tsx` | `vibestack/stories` | `generated/stories/` | no |
| Theme CSS | `packages/design-system/tokens.json` | `vibestack/design` | `packages/design-system/generated/` | no |
| The packaged `spec` command | `vibestack/` | `pnpm build` | `dist/` | no; it is what `npm pack` ships |
| Review ledger | a person's sign-off | `pnpm accept` | `spec/lock.json` | yes |
| Counterexamples | a failing conformance run | `vibestack/testing` | `test/counterexamples/` | yes: they are regression tests |

Every generator reads the one representation the layer above it wrote: the
adapter and the conformance module come from the generated model, generated
tests from schemas, contracts and that conformance module. None parses the
spec again.

**Deterministic, and only when something changed.** Output order and names
are stable and carry no timestamps. `spec` keeps each simulation and proof
result in `.spec-cache/` under a hash of the spec, what it imports and the
versions of Quint, Dafny, Z3, LemmaScript, Node and the tools themselves.
Generated test files carry the generator's version and their source's hash,
are rewritten only when their bytes differ, and are removed when their source
is. Turborepo skips whole `gen`, `build`, `typecheck`, `test`, `test:browser`
and lint tasks whose inputs it has seen (`turbo.json`). It never skips
`check`, which runs the real application in its `traces` stage, nor the
examples, which install from the network.

**Seeds and budgets.** Simulation is seeded from what it simulates. Property
tests take `FUZZ_SEED` (default 1) and `FUZZ_RUNS` (default 100), which is
also the number of walks of a model-based test whose driver's `options` set
no `walks`: 1000 on a pull request into `main` and on every push to `develop`
or `main`, 20000 nightly. A failure prints the seed and the shrunk
counterexample.

## Which test, for what

| Kind | Purpose | With | Where |
|---|---|---|---|
| Unit | pure hand-written logic the spec cannot hold | Vitest | `test/*.test.ts` |
| Effect | services, layers, typed failures, retries, time, interruption, cleanup | `@effect/vitest`, `TestClock`, `vibestack/testing` helpers | `test/*.test.vibe` |
| Property | what a schema or a declared contract promises, for generated values | Effect `Arbitrary`; generated | `.cache/generated/tests/` |
| Model-based | the real shell against the spec: witnessed journeys, then random walks | `gen/<name>.conformance.ts` through `conformanceTests`; generated when `test/drivers/<name>.ts` exists | `.cache/generated/tests/` |
| Component | a story walked through the page | Testing Library on happy-dom (jsdom on request) | `test/*.test.tsx` |
| Browser | what a DOM emulation cannot show: focus, layout, real storage | Vitest Browser Mode, Playwright Chromium, headless | `test/*.browser.test.tsx` |
| Integration, end to end | a journey across real services | the same runner, real servers | `test/` |
| Formal | rules and laws, for every state and input | Quint simulation, Dafny through LemmaScript | `spec check` |

A generated test asserts only what a schema, a declared contract or the model
states: never what the implementation happened to return. A schema with no
derivable generator, or a module that cannot be loaded, is reported with its
file and reason and gets no test. Effect's `Arbitrary` does not produce
invalid values, so "invalid input is refused" is written by hand where it
matters.

## What a green check means

| Said of a rule or function | Means | Does not mean |
|---|---|---|
| **proved** | Dafny proved it for every state and input (`proof`) | anything about code outside the spec and `//@` files |
| **simulated only** | no simulated trace broke it; a person accepted that with `pnpm accept unproved` | proved |
| **model checked within bounds** | Quint found no violation in the traces and depth it tried (`always`, `sometimes`, `leadsTo`) | true beyond those bounds |
| **runtime tested** | the tests, properties and conformance walks that ran passed | true for inputs not generated |
| **not verified** | the shell's effects, timing and third parties beyond what tests exercise | — |

Asynchronous Effect programs are tested, not proved. Each `proof` line of
`check` says how many obligations are proved and how many are simulated only.

## Packages and boundaries

`apps/*` deploy; `packages/*` are shared by them; `vibestack/` is the tools;
`vibestack/examples/*` stand alone. The root's `check` is also the check of
each package a directory of `spec/` names (SPEC.md, "One spec tree"); a
package with a `spec/` of its own, as Studio and each example have, is a
project of its own. ESLint (`eslint.config.js`) refuses an
import of another package beyond its `exports`, React in domain and tool
code, and a second state, UI or test framework. Knip reports unused files,
exports and dependencies, reading `.vibe` through VibeLang's compiler; Madge
reports import cycles among `.ts` and `.tsx` files, which is all it can
read. What each excludes, and why, is at the top of `knip.config.js` and in
`eslint.config.js`.

## CI

| When | Runs |
|---|---|
| every pull request and push | build, types, tests, browser tests, every `check`, ESLint, Stylelint, Knip, Madge |
| pull request into `main`; push to `develop` or `main` | the same with 1000 runs per property, and `pnpm selftest` |
| nightly | tests and `check`s with 20000 runs and a new seed |

Each run restores pnpm's store, Turborepo's cache and every `.spec-cache/`
from the last, so a change pays only for what it reaches; superseded runs are
cancelled. There is no remote cache: the restored local one already covers
repeat runs of the same inputs.

Standalone examples are checked manually with `pnpm examples`, outside CI.
