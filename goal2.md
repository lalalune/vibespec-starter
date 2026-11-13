# Goal 2 — Monorepo Architecture, Vibelang/Effect Testing, Generated Tests, Formal Verification, and Fast CI

Companion: [goal1.md](goal1.md) (component system, generated Storybook, design tokens, visual editor).
This goal comes first: goal 1 builds on the package layout and testing infrastructure it establishes.

## Mission

Thoroughly research, design, implement, validate, and optimize the repository's core application architecture and development infrastructure.

Establish a fast, deterministic, model-driven TypeScript monorepo where React applications are built with Vite, domain/state behavior is implemented through Vibelang and Effect.ts, and tests can be generated automatically from models, schemas, contracts, and source code.

The architecture must support the companion Storybook/design-system goal.

The priorities are:

1. Correctness
2. Determinism
3. Minimal code duplication
4. Fast developer feedback
5. Incremental and cached computation
6. Clear package boundaries
7. Low maintenance overhead
8. Reliable formal and runtime validation

Implement the architecture throughout the actual repository, including all examples and templates.

Do not stop at a proposal.

## 1. Research existing architecture first

Inspect:

* The entire repository structure.
* Existing AGENTS.md files.
* Current package manager and build tooling.
* Existing examples and starter templates.
* Vibelang source, compilers, generators, and runtime integration.
* Effect.ts versions and usage patterns.
* Quint integrations and models.
* LemmaScript integrations and proof workflows.
* Existing React components and hooks.
* Existing test runners and utilities.
* Current CI configuration.
* Existing caching and generated files.
* Existing Storybook and story-editor infrastructure.

Research the latest compatible versions and official recommendations for all selected tools.

Identify what can be preserved, what should be consolidated, and what genuinely needs to be replaced.

Do not introduce unnecessary duplicate frameworks or workflows.

## 2. Standard monorepo architecture

Use a pnpm workspace monorepo with Turborepo.

Require:

* Node.js 26
* pnpm, pinned through `packageManager`
* TypeScript in strict mode
* Consistent ESM conventions where supported
* React
* Vite
* Effect.ts
* Vibelang
* Vitest

Use this default directory structure:

```
/
├── apps/
│   ├── web/
│   ├── story-editor/
│   └── ...
├── packages/
│   ├── ui/
│   ├── design-system/
│   ├── models/
│   ├── contracts/
│   ├── domain/
│   ├── testing/
│   ├── tooling/
│   └── ...
├── examples/
│   └── ...
├── docs/
├── .github/workflows/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── turbo.json
└── tsconfig.base.json
```

This is a logical target, not a requirement to create empty packages.

Only create packages with actual responsibilities.

Conventions:

* `apps/` contains deployable applications.
* `packages/` contains reusable code, schemas, models, components, and tooling.
* `examples/` contains independently understandable examples wired into the workspace.
* Domain logic must not depend on React.
* UI packages should not own backend business logic.
* Packages must have explicit public exports.
* Avoid deep imports into other packages' internals.
* Avoid circular package dependencies.
* Keep shared types close to their owning contracts rather than creating a dumping-ground types package.

Use workspace dependencies and proper package exports.

Avoid excessive build steps for internal TypeScript development while preserving valid production package boundaries.

## 3. Vibelang is required

The project was previously made usable without Vibelang.

Reverse that policy.

Vibelang is now a mandatory part of the standard project architecture and development workflow.

Do not create a separate, competing state framework.

Requirements:

* Vibelang integration is required by default.
* Node.js 26 is required.
* React is the only UI framework.
* React hooks remain the UI integration mechanism.
* Effect.ts provides domain services, effects, concurrency, resource management, and asynchronous workflows.
* Vibelang models and generated artifacts integrate with the Effect-based application architecture.
* Reuse existing Vibelang compiler and generation capabilities where possible.

Inspect Vibelang's actual current APIs before designing adapters.

Do not invent APIs or duplicate features that Vibelang already implements.

Define clear boundaries between:

* Source models
* Generated contracts
* Domain implementations
* React-facing hooks
* Runtime state
* Persisted state
* Test fixtures

Prevent competing sources of truth.

For stateful domain workflows, the model and its explicit contracts should govern legal transitions wherever practical.

## 4. Canonical build and generation pipeline

Create one coherent generation architecture.

Generated outputs may include:

* TypeScript declarations
* Runtime schemas
* Model adapters
* Test fixtures
* Generated unit tests
* Quint execution traces
* Storybook metadata
* Design-system outputs
* Documentation indexes

Do not implement independent generators that each rediscover and reinterpret the same source information.

Use a shared model/contract representation where justified.

Requirements:

* Deterministic generation
* Stable identifiers
* Versioned generator inputs
* Input hashing
* Output caching
* Incremental invalidation
* Minimal regenerated output
* Reproducible seeds
* Useful diagnostics
* Explicit handling of unsupported cases

Store disposable generated files in a gitignored cache directory, such as `.cache/generated/`.

Do not rely on that exact path if the repository already has a better established cache convention.

Distinguish disposable outputs from generated artifacts that must be published or are required by downstream consumers.

Define what may be cached and what must be rebuilt.

Avoid committing large generated test suites or duplicated derived source.

## 5. Testing architecture

Standardize on:

* Vitest
* `@effect/vitest`
* Effect Schema
* Effect Arbitrary
* Vitest + happy-dom
* Vitest + jsdom where appropriate
* Vitest Browser Mode
* Playwright as a Vitest browser provider

Do not introduce Jest or a second independent testing framework.

Use the Effect APIs supported by the installed Effect version.

If the chosen Effect version lacks a needed stable arbitrary-generation capability, investigate compatible integrations such as fast-check instead of relying on nonexistent APIs.

Provide shared configuration through `packages/testing`.

Define a coherent set of test categories:

* **Unit tests** — Fast, isolated tests for pure TypeScript/domain code.
* **Effect tests** — Tests for services, layers, resources, interruption, retries, scheduling, and typed failures.
* **Property-based tests** — Generated values from Effect Schemas and explicit invariants.
* **Model-based tests** — Execution sequences derived from Vibelang and Quint models.
* **Component tests** — Vitest with happy-dom as the default lightweight DOM environment, jsdom when compatibility requires it, and real browser tests for actual layout or browser-specific behavior.
* **Integration tests** — Tests spanning several real services or package boundaries.
* **Browser tests** — Vitest Browser Mode using a Playwright provider.
* **Formal verification** — LemmaScript and Quint checks where suitable.
* **End-to-end smoke tests** — A small representative set of complete application workflows.

Each test type should have a clear purpose.

Avoid running the same scenario through multiple expensive layers unless it provides genuinely different coverage.

## 6. Automatically generated unit tests

Research and implement automatic generation of useful unit/property tests from:

* TypeScript types
* Effect Schemas
* Vibelang models
* Function contracts
* Documented invariants
* Explicit state transitions
* LemmaScript contracts where available

Generate transient test files in the gitignored cache.

They must be executable by Vitest through supported discovery/configuration mechanisms.

Support regeneration when source changes.

Generate meaningful tests rather than superficial snapshots or tautologies.

Distinguish between:

1. Input generation
2. Property generation
3. Expected-result oracles
4. Implementation execution
5. Failure shrinking
6. Regression reproduction

Types alone are not sufficient to infer correct business behavior.

Generate tests automatically only where behavior can be derived from an actual contract, model, or explicit property.

Provide concise opt-in metadata where additional behavior specifications are needed.

Never generate assertions by blindly copying the implementation's current behavior.

Make hand-authored tests and generated tests complementary.

## 7. Property-based fuzzing

Integrate Effect Schema/Arbitrary with the test runner.

Support:

* Valid value generation
* Boundary values
* Invalid value generation where appropriate
* Recursive structures
* Tagged unions
* Branded values
* Shrinking
* Deterministic seeds
* Configurable test budgets

Use schema annotations or explicit arbitraries for constraints that cannot be reliably inferred.

Automatically generate property tests for appropriate contracts, such as:

* Encoding/decoding round trips
* Parser/serializer round trips
* Schema validation invariants
* Idempotency
* Deterministic reducers
* Serialization stability
* Explicit domain invariants

Do not assume every arbitrary function is idempotent, reversible, or pure.

Fail clearly when a valid generator or trustworthy test oracle cannot be derived.

Preserve minimal failing examples.

## 8. Quint model-based testing

Research the current Quint model-testing tools, trace generation, ITF format, and TypeScript integration options.

Implement an adapter between Quint-generated traces and our Vibelang/Effect implementation where feasible.

The adapter should:

* Read generated model traces.
* Map model actions to implementation operations.
* Execute them in a controlled Effect test environment.
* Observe resulting state.
* Compare observed state against model expectations.
* Enforce explicit invariants.
* Save counterexamples.
* Support deterministic replay.

Focus on stateful workflows and edge cases:

* Cancellation
* Retry
* Timeout
* Duplicate events
* Concurrency
* Out-of-order completion
* Partial failure
* Invalid transitions
* Interruption
* Resource cleanup

Where Vibelang can produce Quint models or common intermediate representations, reuse that capability.

Do not create a second competing formal model unnecessarily.

Investigate whether a direct Vibelang-to-test-generator path is preferable to a mandatory Quint dependency for simple models.

Select the simplest approach that preserves meaningful model-based testing.

## 9. LemmaScript and formal verification

Inspect the existing LemmaScript implementation and supported proof workflows.

Integrate it into automated validation for appropriate functions.

Prioritize:

* Pure deterministic functions
* Critical calculations
* Authorization logic
* State-transition predicates
* Explicitly supported contracts

Do not imply that arbitrary asynchronous Effect programs can be fully proved correct.

Generate proof obligations where supported.

Cache proof results based on relevant inputs and prover versions.

Provide actionable diagnostics.

Distinguish:

* Formally proved
* Runtime tested
* Model checked within bounds
* Not verified

Never present bounded fuzzing or model exploration as a universal mathematical proof.

Keep formal verification optional per function or model where support is limited, while keeping the overall toolchain integrated.

## 10. React component testing

Use React Testing Library where it improves tests.

Prefer happy-dom for inexpensive component testing.

Use jsdom when its DOM behavior or library compatibility is required.

Use Vitest Browser Mode when tests depend on:

* Actual browser rendering
* Layout
* Focus behavior not faithfully simulated
* Browser-native interactions
* Real browser APIs
* Visual behavior

Use Playwright as the default browser provider.

Configure:

* Headless execution
* Browser-process reuse
* Sensible concurrency
* Minimal unnecessary browser launches
* Reused fixtures where safe
* Deterministic test setup
* Screenshots/traces primarily for failures
* Sharding where beneficial

Benchmark and tune worker counts rather than assuming maximum parallelism is fastest.

Do not run full browser testing for every simple component property.

Ensure generated Storybook tests can reuse this test infrastructure.

## 11. Shared test environments for Effect

Build compact test helpers for:

* Test layers
* Mock services
* TestClock
* Deterministic randomness
* Controlled failures
* Cancellation
* Timeouts
* Fiber lifecycle testing
* Resource cleanup
* Service dependency injection

Keep helpers small and composable.

Use Effect's own testing capabilities wherever practical.

Avoid wrapping Effect in a large redundant custom testing framework.

Preserve error causes and useful diagnostics.

## 12. ESLint configuration

Set up ESLint using the current flat-config approach.

Include appropriate TypeScript and React rules.

Enforce:

* Correct TypeScript usage
* React Hooks rules
* Avoidance of unused code
* No accidental unsafe operations where enforceable
* Clear package boundaries
* Consistent imports
* No prohibited cross-package internals
* No unnecessary React state frameworks
* Existing Effect/Vibelang conventions

Investigate useful existing rules before implementing custom ones.

Only create custom rules for important project invariants that cannot be enforced otherwise.

Do not build an enormous restrictive rule system that prevents legitimate development.

Avoid conflicting or redundant lint rules.

Make generated code exempt only from rules that legitimately do not apply to disposable artifacts.

## 13. Stylelint and Tailwind compatibility

Set up Stylelint for Tailwind v4 and shadcn-style CSS.

Handle Tailwind-specific directives correctly.

Share design-system enforcement with the companion UI goal.

Stylelint should check actual CSS.

ESLint and design-system-specific rules should govern JSX/TSX class usage where appropriate.

Do not duplicate the same expensive validation in several tools.

Ensure config files and generated outputs have correct exclusions.

## 14. Knip and Madge

Install and configure both tools as repository defaults.

Knip should detect:

* Unused files
* Unused exports
* Unused dependencies
* Relevant workspace dead code

Madge should detect:

* Circular dependencies
* Problematic dependency graphs

Configure support for:

* Workspace packages
* TypeScript paths
* Package exports
* Generated artifacts
* Storybook entries
* Vitest tests
* Vibelang entrypoints
* CLI tools
* Build configuration
* Dynamically discovered modules

Do not globally suppress legitimate errors merely because generated files or dynamic imports exist.

Keep exclusions minimal and documented.

Ensure both tools can run successfully across relevant examples and packages.

Eliminate real dead code and dependency cycles identified during integration.

## 15. Fast builds and caching

Use Turborepo for task orchestration.

Define task dependencies correctly.

Cache:

* Type checking where appropriate
* Compilation
* Code generation
* Linting
* Static analysis
* Deterministic tests
* Model checks
* Proof artifacts
* Storybook builds

Do not cache non-deterministic results unsafely.

Ensure cache keys account for:

* Source files
* Relevant configuration
* Lockfile
* Runtime version
* Compiler/generator versions
* Model/schema dependencies
* Relevant environment variables

Avoid rebuilding unchanged packages.

Use dependency-aware affected-package execution.

Optimize warm-cache and incremental workflows, not just cold full builds.

Investigate whether the existing infrastructure supports persistent local or remote caching.

Don't add an external cache service unless it provides a clear benefit and can be configured appropriately.

## 16. CI branching strategy

Use:

* `develop` for ongoing integration.
* `main` for stable releases.

For ordinary pull requests targeting develop, run minimal but meaningful CI:

* Formatting/lint checks for affected code
* Affected-package type checking
* Affected unit/property tests
* Fast generation consistency checks
* Relevant dependency-boundary checks

Run only the necessary tasks and their dependent verification steps.

For develop → main, run complete validation:

* Full type checking
* Full relevant linting
* All unit tests
* Property tests with larger budgets
* Model-based tests
* Formal checks where supported
* Integration tests
* Browser smoke tests
* Production builds
* Knip
* Madge
* Generated-artifact reproducibility checks

Preserve required baseline security/correctness checks on every PR.

Do not sacrifice correctness merely to make PR CI fast.

Add scheduled heavier fuzzing or extended trace exploration where useful.

Research and implement GitHub Actions or the repository's existing CI platform.

Use appropriate caching for pnpm and Turborepo.

Configure concurrency cancellation for superseded runs.

Avoid unnecessary matrix expansion.

Parallelize independent CI work where beneficial.

## 17. Developer commands and workflows

Provide a small coherent command interface.

Example intended commands:

```
pnpm dev
pnpm build
pnpm test
pnpm test:affected
pnpm test:browser
pnpm test:models
pnpm verify
pnpm lint
pnpm lint:css
pnpm typecheck
pnpm analyze
```

Adapt names to established repository conventions where sensible.

Avoid dozens of nearly identical scripts.

Provide one convenient command for fast local checks and one for complete validation.

Make failure diagnostics actionable.

Ensure all examples can be run and tested without bespoke undocumented setup steps.

## 18. Starter repository and examples

Update all relevant examples and starter templates.

They must use:

* The monorepo structure
* Node.js 26
* pnpm
* Turborepo
* React
* Vite
* Tailwind CSS v4
* shadcn/ui conventions
* Vibelang
* Effect.ts
* Vitest
* @effect/vitest
* Effect Schema/Arbitrary
* happy-dom/jsdom as appropriate
* Vitest Browser Mode
* Playwright browser provider
* ESLint
* Stylelint
* Knip
* Madge

Only add dependencies to workspaces that genuinely require them.

Share configuration to avoid copy/paste.

Keep examples small and educational.

Make sure they remain runnable.

Preserve important existing examples and demonstrate the new testing capabilities through them.

## 19. AGENTS.md and architecture documentation

Update the root AGENTS.md and relevant nested files.

Explicitly mandate:

* Node.js 26
* Vibelang
* Effect.ts
* React as the only UI framework
* React hooks for UI integration
* Vite
* Tailwind CSS v4
* sh

<!-- The pasted goal ended here, mid-item ("* sh", presumably "shadcn/ui conventions"). Everything
after this point of the original was not received: the rest of section 19 and any later sections
(implementation and verification, review passes, definition of done). Paste the remainder below. -->
