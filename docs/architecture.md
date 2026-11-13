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
| Boundary schemas | `src/**/*.schema.{ts,vibe}` (Effect Schema) | hand-written | types repeated beside them |
| React interface | `src/**/*.tsx`, hooks over the `Machine` service | hand-written | business rules; state the spec owns in `useState` |
| Runtime state | the `Machine` service (`machine()` layer) | generated adapter | a store library |
| Persisted state | behind a service; read back through `decodeState` or a schema | the shell | trusted without parsing |
| Tests and drivers | `test/`, `test/drivers/`, `test/counterexamples/` | hand-written, or saved by a failing run | copies of generated values; a driver that imports `gen/` code |

A transition is legal exactly when the spec's guard allows it: `enabled` and
`step` are generated from the model, the shell reaches the state only through
`Machine`, and a control is offered when `enabled` says so.

## What is generated, and where it goes

| Output | From | By | Written to | Kept in Git |
|---|---|---|---|---|
| TypeScript, Quint harness, Dafny | the spec | `spec gen`, `spec check` | `gen/` | no |
| Effect adapter | the generated TypeScript | `spec gen` | `gen/<name>.effect.vibe` | no |
| A driver's types, `Driver` and `Options` | the generated TypeScript | `spec gen` | `gen/<name>.conformance.ts`, over `gen/_conformance.ts` | no |
| A driver to fill in | a `src/` that imports `apply` from a machine with no driver | `spec check` | `test/drivers/<name>.ts` | yes, once filled in |
| Property tests | `src/**/*.schema.{ts,vibe}`, `src/**/*.contract.{ts,vibe}` | `vibestack/testing/generate.ts`, before each test run of a package on `project()` | `.cache/generated/tests/` | no |
| Component stories and their catalog | component prop types and `*.meta.tsx` | `vibestack/stories` | `generated/stories/` | no |
| Theme CSS | `packages/design-system/tokens.json` | `vibestack/design` | `packages/design-system/generated/` | no |
| The packaged `spec` command | `vibestack/` | `pnpm build` | `dist/` | no; it is what `npm pack` ships |
| Review ledger | a person's sign-off | `pnpm accept` | `spec/lock.json` | yes |
| Counterexamples | a journey or walk the application disagreed with | the `traces` stage (`vibestack/conform.ts`) | `test/counterexamples/<name>/` | yes: they are regression tests, replayed first |

Every generator reads the one representation the layer above it wrote: the
adapter and the driver types come from the generated model, the `traces`
stage takes the events the simulator found, and property tests come from
schemas and contracts. None parses the spec again.

**Deterministic, and only when something changed.** Output order and names
are stable and carry no timestamps. `spec` keeps each simulation and proof
result in `.spec-cache/` under a hash of the spec, what it imports and the
versions of Quint, Dafny, Z3, LemmaScript, Node and the tools themselves,
and each package's passing test run under a hash of what its tests read.
Generated test files carry the generator's version and their source's hash,
are rewritten only when their bytes differ, and are removed when their source
is. Turborepo skips whole `gen`, `build`, `typecheck`, `test`, `test:browser`,
selftest and lint tasks whose inputs it has seen (`turbo.json`); `FUZZ_RUNS`
and `FUZZ_SEED` are inputs of the `test` tasks only, so a budget changes no
other task's cache. It never skips
`check`, which runs the real application in its `traces` stage, nor the
examples, which install from the network.

### Seeds and budgets

Every budget is set here, once. Simulation is seeded from what it simulates,
so a run repeats exactly; `FUZZ_SEED`, where it is set, is mixed in, so that a
nightly run tries other traces. Property tests and the walks of a driver take
the two variables:

| | `FUZZ_RUNS` | `FUZZ_SEED` |
|---|---|---|
| a property test | values per property; 100 unless set | 1 unless set |
| a driver (`test/drivers/`) | random walks, after its journeys; 1 unless set, and never more than its `options.walks` | 1 unless set |
| a pull request into `develop` | 100 | unset |
| a pull request into `main`; a push to `develop` or `main` | 1000 | unset |
| nightly (`fuzz.yml`) | 20000 | the run's id, or the seed it is started with |

A failure prints its seed and the shrunk counterexample; a driver's is saved
([SPEC.md, "Conformance"](../SPEC.md#conformance)).

## Which test, for what

What earns a test, and the rules `check` holds each to, are in
[AGENTS.md, "Tests"](../AGENTS.md#tests). The hello world in `apps/app` has
one of each.

| Kind | Checks | Written as | In `apps/app` |
|---|---|---|---|
| Formal | rules and laws, for every state and input | the spec; `.proof.dfy` where Dafny needs help | `spec/app/index.md`, `src/greeting.proof.dfy` |
| Model-based | the real shell against the spec: journeys, malformed inputs, random walks, saved counterexamples | a driver, run by the `traces` stage | `test/drivers/app.ts` |
| Journey, integration | a story end to end through the real shell and real services: storage, HTTP, time; what a driver cannot see | `@effect/vitest`, in `test/*.test.vibe` | `test/app.test.vibe`: the greeter read back from its store |
| Component, browser | a component's stories mounted, played and checked for accessibility; what only a browser shows: focus, layout, real storage | generated from props and `<Name>.meta.tsx` `play`; `test/*.browser.test.tsx` in Chromium | `test/app.browser.test.tsx`; the stories of `@repo/ui` |
| Property, generated | what an Effect Schema or a declared contract promises, for generated values | nothing: a `*.schema.*` or `*.contract.*` in `src/` is enough | `src/greeter.schema.ts` |

A generated test asserts only what a schema, a declared contract or the
model states: never what the implementation happened to return. A schema
with no derivable generator is reported with its file and reason and gets
no test; a module that gets none at all, because it does not load or
declares nothing testable, fails the package's test run with its reason.
Effect's `Arbitrary` does not produce invalid values: a driver's `receive`
covers malformed events, and a journey any other invalid input that matters.
A disabled or loading story is played to check that it refuses clicks and
keys; no test compares screenshots.

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
| every pull request and push | `pnpm verify`: build, types, tests, browser tests, every `check`, ESLint, Stylelint, Knip, Madge, `pnpm selftest` |
| pull request into `main`; push to `develop` or `main` | the same, with larger budgets |
| nightly | every `check`, with a new seed; saved counterexamples become a pull request into `develop` |

Each row's budget is in [Seeds and budgets](#seeds-and-budgets). A failing
run keeps `test/counterexamples/` and `test/__traces__/` as an artifact.

Each run restores pnpm's store, Turborepo's cache and every `.spec-cache/`
from the last, so a change pays only for what it reaches; superseded runs are
cancelled. There is no remote cache: the restored local one already covers
repeat runs of the same inputs.

Standalone examples are checked manually with `pnpm examples`, outside CI.
