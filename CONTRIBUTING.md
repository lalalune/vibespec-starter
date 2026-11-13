# Contributing

Every contributor, person or agent, reads [AGENTS.md](AGENTS.md) and [README.md](README.md) in full before any work.
How the repository works is in [AGENTS.md](AGENTS.md); starting a project from the template is [README.md, "Set up a new project"](README.md#set-up-a-new-project).
Everything is built on [the stack](AGENTS.md#the-stack): Node 26, pnpm, VibeLang on Effect for the shell, React for every interface.

## The monorepo

| Path | Holds |
|---|---|
| `apps/` | deployable applications; `apps/app` is the hello world to replace |
| `packages/` | what applications share: `@repo/ui` (components), `@repo/design-system` (tokens) |
| `vibestack/` | the tools: the `spec` command, Studio, and what any project uses but does not own (`vibestack/testing`, `vibestack/design`, `vibestack/stories`) |
| `vibestack/examples/` | standalone projects, each with its own install; never part of the workspace |

The specs of every package are in the one tree at the root ([AGENTS.md, "One spec tree"](AGENTS.md#one-spec-tree));
[docs/architecture.md](docs/architecture.md) maps what is generated from what, which test is for what, and the
budgets and CI.

A package states what it offers in `exports`; import a package by name, never by a path into its `src/`. Domain code
does not import React, and a UI package holds no business rules. A shared type lives with the contract that owns it.

| Command | Does |
|---|---|
| `pnpm dev` | Studio, and every package's `dev` script beside it |
| `pnpm quick` | the fast local check: types, tests, ESLint and Stylelint, in every package |
| `pnpm verify` | what CI runs: build, types, tests, browser tests, every `check`, lint, Knip, Madge and `pnpm selftest` |
| `pnpm all <task>…` | one or more kinds of task in every package: `pnpm all build typecheck test` |
| `pnpm test:browser` | the browser tests |
| `pnpm test:models` | every `check`: the root's, which is its owners' too, Studio's, and the examples' |
| `pnpm examples` | each example's install and `check` |
| `pnpm lint` | ESLint and Stylelint (`pnpm lint:js`, `pnpm lint:css` for one) |
| `pnpm analyze` | Knip (unused files, exports, dependencies) and Madge (import cycles) |
| `pnpm check`, `pnpm gen`, `pnpm build`, `pnpm typecheck`, `pnpm test` | this package's own, here as in every package: at the root, the root project and the tools |

Turborepo (`turbo.json`) orders these and skips a task whose inputs it has seen
([docs/architecture.md](docs/architecture.md#what-is-generated-and-where-it-goes)), so every command above runs only
what a change reaches. `check` is never skipped whole: `spec` keeps its own finer cache in `.spec-cache/`, and runs the
application again each time.

A package joins by having a script named `gen`, `build`, `typecheck`, `test`, `test:browser` or `check`. Its other
tasks wait for its `gen` and the root's, and its `check` for all of them, since `check` rewrites `gen/`. The root's
`check` rewrites its owners' `gen/` too, so it waits for their tasks: name each owner's in `//#check` of `turbo.json`,
as `@repo/app`'s are. `pnpm lint:js` on its own needs what `gen` and `typecheck` write (`gen/`, `.vibe/declarations`);
`pnpm lint` runs them first.

Pull requests go to `develop`, and `develop` to `main`; what CI runs on each is in
[docs/architecture.md, "CI"](docs/architecture.md#ci).

## Changing the tools

| File | Role |
|---|---|
| `vibestack/spec.ts` | the pipeline and the `spec` command |
| `vibestack/parse.ts`, `vibestack/review.ts` | literate specs and the review ledger |
| `vibestack/cache.ts`, `vibestack/run.ts` | stage caches and bounded tool execution |
| `vibestack/units.ts`, `vibestack/simulate.ts` | generation, proof units, simulation and replay |
| `vibestack/util.ts` | source discovery, the `tests` stage and the rules it holds tests to, and citations |
| `vibestack/gen/vibe.ts` | `gen/<name>.effect.vibe`, read off the generated TypeScript |
| `vibestack/scan.ts` | how a spec's lines are read; imports nothing, so Studio's page uses it too |
| `vibestack/studio/` | Studio, a workspace package with its own spec, checked by `pnpm --filter vibestack-studio check`: change `spec/`, then its shell in `src/` |
| `vibestack/prove.ts` | proves one unit: checks and splices the proof file, runs LemmaScript and `dafny audit`, and rechecks alone every postcondition a failing one could hide |
| `vibestack/proof/lib.dfy` | the library proof files call |
| `vibestack/std/` | specs that ship with the tools, which any spec may import, each with its proof file |
| `vibestack/conform.ts` | the `traces` stage: drivers, each in a Node of its own, `driver:` programs and recorded traces; saved counterexamples; the driver stub |
| `vibestack/conformance.ts` | the comparing: journeys, malformed-input probes, walks, shrinking and replay; copied into `gen/` for a driver's types |
| `vibestack/testing/` | what packages import: `project()` (the Vitest configuration), the property-test generator, `effectDriver` |
| `vibestack/stories/`, `vibestack/design/` | generated stories and their tests; design tokens and their lint rules |
| `vibestack/gen.ts` | the translator: reads what a module imports and defines |
| `vibestack/gen/types.ts` | everything decided by a type |
| `vibestack/gen/print.ts` | expressions |
| `vibestack/gen/classify.ts` | which definition is a transition, a guard or a rule |
| `vibestack/gen/secrecy.ts` | where a secret may go |
| `vibestack/gen/typescript.ts`, `vibestack/gen/harness.ts` | the two outputs |
| `vibestack/selftest.ts`, `vibestack/fixtures/` | the selftest and the specs it uses besides the order example |

Node runs all of it directly; `pnpm build` compiles it for the packaged `spec` command.

`check(root)` returns `{ ok, results, next }`, and `spec check --json` prints that object. Each result has `ok`,
`stage` (a stage, or `skipped`), `summary`, `detail` and, when it concerns one, `where`; `next` is the line the command
line ends with. `pnpm selftest` builds scratch projects from this project's spec or from `vibestack/fixtures/`, breaks
one thing at a time and asserts which stage catches each; it is a cached task of `pnpm verify`. What a change to the
tools owes it, and the sync skill, is in [AGENTS.md, "Definition of done"](AGENTS.md#definition-of-done).
