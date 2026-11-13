# Goal 1 — Unified React Component System, Generated Storybook, Design Tokens, and Visual Editor

Companion: [goal2.md](goal2.md) (monorepo, testing, verification and CI). This goal builds on the
package layout and testing infrastructure that goal 2 establishes.

## Mission

Research, design, implement, test, and fully integrate a deterministic, automatically generated component development system across the entire repository.

We want every React component to be discoverable, visually inspectable, interactively testable, connected to its underlying models, and governed by a unified design system — without requiring developers or AI agents to manually maintain Storybook stories, duplicate styling, or generate large amounts of boilerplate.

This must integrate with our existing Vibelang models, Effect.ts architecture, story editor, examples, documentation, and project conventions.

Implement the system rather than merely proposing it.

## 1. Research and architectural evaluation

Before implementation, thoroughly investigate:

* Storybook's latest React/Vite integration, CSF, autodocs, args, controls, interaction testing, portable stories, and composition capabilities.
* Whether stories can be generated dynamically or at build time from TypeScript ASTs, React component signatures, Effect Schemas, Vibelang models, and component metadata.
* Alternatives to Storybook, including Ladle, Histoire where applicable, React Cosmos, Vitest Browser Mode, custom component explorers, and generated visual catalogs.
* Existing libraries for TypeScript prop extraction and component introspection.
* Whether Storybook's indexing and file discovery can support gitignored/generated stories without needing checked-in files.
* Storybook visual regression tools and integration with Vitest Browser Mode.
* shadcn/ui, Radix, Tailwind v4, Class Variance Authority, token systems, and design-system linting.
* Current options for ESLint and Stylelint enforcement of Tailwind tokens and allowed classes.
* Approaches to synchronizing natural-language design documents, structured tokens, generated CSS, and visual previews.

Choose the smallest reliable architecture. Avoid adopting tools that duplicate functionality or introduce large maintenance burdens.

Research must inform implementation, not become a substitute for it.

## 2. Strict UI architecture

Use:

* React as the only UI component framework.
* TypeScript throughout.
* Vite for development and building.
* shadcn/ui conventions and Radix primitives for reusable components.
* Tailwind CSS v4 for styling.
* React hooks with Vibelang/Effect.ts for stateful/domain behavior.
* Effect Schema for typed inputs, outputs, and domain data.

Do not introduce Vue, Svelte, Angular, Redux, Zustand, or another competing state architecture.

Follow the monorepo conventions established by the repository-infrastructure goal.

The shared component system should live in `packages/ui`.

Design tokens and style-related generated infrastructure should live in `packages/design-system`, unless the existing architecture strongly justifies a smaller arrangement.

Generators and Storybook integrations should live in appropriate tooling packages.

Do not generate copies of reusable React components. Components remain normal, editable, idiomatic React source.

## 3. Automatic Storybook generation

Design and implement a system that generates Storybook entries for all eligible React components without manually authored stories.

Generated stories must:

* Live in a gitignored, disposable cache directory.
* Be regenerated automatically when relevant source changes.
* Be deterministic and reproducible.
* Not pollute production bundles or source-control diffs.
* Be incremental and content-hash cached.
* Integrate directly with Storybook's discovery/indexing system.
* Support hot reload during development.
* Work across the monorepo.
* Be available automatically in all starter examples.

Investigate generating Storybook CSF files versus using a custom Storybook indexer or virtual modules.

Prefer the least complex reliable mechanism.

Automatically infer:

* Component names and module paths.
* TypeScript prop types.
* Required versus optional properties.
* Enums, unions, literals, booleans, and numeric controls.
* Default values when statically discoverable.
* Effect Schema constraints.
* Vibelang model associations.
* Variants and supported component states.
* Relevant documentation and examples.

Generate meaningful variants:

* Default
* Supported prop variations
* Loading
* Empty
* Error
* Disabled
* Interactive
* Boundary values
* Relevant domain-specific states

Only generate variants where they actually apply.

Avoid exponential combinations of props. Use representative combinations, pairwise generation, schema boundaries, and configurable limits.

Recognize that TypeScript types alone cannot reliably synthesize meaningful callback implementations, realistic domain objects, context providers, or external resources.

Provide a compact, optional metadata mechanism for exceptional cases.

This metadata must be reusable by Storybook, testing, documentation, and the visual editor — not a Storybook-specific parallel specification.

Support manually authored stories as optional overrides or additions, with clear precedence rules.

## 4. Deterministic component fixtures

Integrate the story generator with Effect Schema, Vibelang, and existing model definitions.

Where schemas are available, derive valid example props and boundary inputs automatically.

Use deterministic seeds.

Generate reproducible fixtures for:

* Valid domain objects
* Edge cases
* Different model states
* Error conditions
* Relevant state transitions

Do not simply populate every string with meaningless placeholder text.

Use schema annotations, domain fixtures, and explicit examples when necessary.

For unsupported or ambiguous prop types, surface a diagnostic and request optional metadata rather than silently fabricating incorrect fixtures.

Create a clear separation between:

1. Component source
2. Typed component contracts
3. Generated fixtures
4. Generated stories
5. Runtime component state

Avoid multiple competing sources of truth.

## 5. Integration with the existing story editor

Inspect and understand the existing story editor before changing its architecture.

Generated Storybook components must be integrated into that editor, not exist as a disconnected secondary UI.

The story editor should support:

* Browsing all discovered components
* Searching and filtering by package, model, component, and variant
* Rendering generated stories
* Editing supported props through controls
* Switching between component states
* Viewing relevant models and schemas
* Inspecting supported input/output contracts
* Exploring linked model transitions
* Opening the component's source
* Navigating to associated design documentation
* Referencing components from design documents

Establish stable component and model identifiers so references survive regeneration and source changes where possible.

Provide bidirectional navigation:

* Model → associated components → stories → source
* Component → related models → schemas → design documents

Do not create two separate component catalogs.

Reuse Storybook where appropriate, but keep our story editor as the ergonomic project-level interface.

If embedding Storybook directly is unnecessarily complex, use a thin integration with shared generated metadata and previews.

## 6. Unified design system

Build a minimal, scalable design system using Tailwind v4.

There must be one authoritative structured source for project-wide design decisions, covering:

* Semantic colors
* Typography
* Font families and scales
* Spacing
* Border radii
* Borders
* Shadows
* Elevation
* Motion and transitions
* Breakpoints
* Light and dark themes
* Focus states
* Interactive states
* Accessible contrast

Prefer CSS custom properties with Tailwind v4's `@theme` integration.

Use semantic tokens rather than distributing hardcoded palette values throughout components.

For example, components should use semantic concepts such as:

* background
* foreground
* primary
* secondary
* muted
* destructive
* border
* surface

Avoid directly coupling ordinary components to specific color values.

Changing the primary color should update the application everywhere without rewriting components.

Make themes and component variants composable.

Do not build an enormous token hierarchy or generate tokens for every conceivable value.

## 7. Styling rules and compact component conventions

Establish consistent conventions for:

* Tailwind utilities
* Semantic tokens
* Class merging
* Component variants
* Shared styling primitives
* Responsive behavior
* Accessibility
* Component composition

Use `clsx` and `tailwind-merge` through a single `cn()` utility where appropriate.

Use CVA or a comparable lightweight pattern for components with genuine variants.

Do not force every component to use CVA.

Favor readable, idiomatic JSX and small reusable abstractions.

Avoid duplicated long class strings, unnecessary wrappers, deeply nested variant systems, and abstract styling DSLs.

Use shadcn/ui as the baseline without making the application dependent on a frozen copy of its upstream implementation.

## 8. Enforceable design-system linting

Investigate and integrate the best current ESLint, Stylelint, and Tailwind-specific linting tools.

Build small custom lint rules only where existing tools cannot enforce our requirements.

Rules should prevent:

* Hardcoded colors where semantic tokens are required
* Duplicate styling definitions
* Arbitrary values where supported design tokens exist
* Unapproved global CSS
* Unnecessary inline styles
* Reimplementation of existing UI primitives
* Uncontrolled styling conventions
* Invalid or unknown Tailwind classes
* Excessive styling complexity

Do not ban arbitrary values globally; permit justified exceptions with explicit, narrowly scoped mechanisms.

Do not generate a huge catalog of wrapper classes or utilities. Prefer Tailwind's standard utilities combined with semantic tokens and a limited number of shared patterns.

Provide helpful lint diagnostics and autofixes where safe.

Generated lint configuration must derive from the authoritative design-system configuration rather than require parallel manual updates.

Preserve legitimate accessibility, third-party integration, and specialized visualization needs.

## 9. Natural-language design synchronization

Build a mechanism for design documents to describe the project's design system in plain language.

For example:

> "The application uses a warm, understated visual style with rounded controls and a blue primary action color."

The system should support an AI-assisted workflow that proposes structured token changes from such descriptions.

Architecture:

Natural-language design document
→ proposed structured design-system changes
→ validation
→ generated Tailwind/CSS token output
→ component preview
→ approval/application

Plain text should not be parsed heuristically into unsafe or ambiguous styling changes at runtime.

AI-generated changes must produce explicit structured diffs that can be validated before application.

Avoid maintaining two authoritative definitions.

The structured design tokens must be canonical. Natural-language documentation should describe them or propose changes to them.

When tokens change:

* Regenerate affected CSS/configuration artifacts.
* Update rendered Storybook previews.
* Update the story editor.
* Refresh visual references.
* Invalidate only affected caches.
* Report any components that violate the resulting rules.

## 10. Component and model documentation

Automatically generate a navigable component catalog containing:

* Component identity
* Description
* Prop contracts
* Defaults
* Variants
* Supported model states
* Associated Vibelang models
* Related Effect Schemas
* Story links
* Source links
* Design-document references

Avoid repeating documentation manually when it can be derived from source.

Support explicit descriptions and examples when inference is insufficient.

Maintain stable references so components can be embedded, linked, or previewed within design documents and the story editor.

## 11. Automatic visual and interaction validation

Use generated stories as reusable testing inputs.

Integrate with the testing infrastructure established in Goal 2.

Support:

* Story smoke tests
* Mount and render checks
* Accessibility checks
* Generated interaction tests where behavior is specified
* Model-state rendering checks
* Browser-mode component tests
* Selected visual regression tests
* Deterministic screenshot fixtures

Do not assert behavioral correctness solely because a component renders successfully.

Do not attempt to generate arbitrary user interactions from props without an actual behavioral contract.

Use Vitest Browser Mode where browser fidelity is required.

Prefer inexpensive DOM tests for behavior that does not require a real browser.

Only generate visual snapshots for explicitly selected or high-value representative states to avoid excessive snapshot churn.

## 12. Performance and generation efficiency

Optimize for extremely fast development feedback.

Requirements:

* Incremental generation
* Content-based caching
* File-change dependency tracking
* Minimal regeneration
* Lazy loading where appropriate
* Limited generated fixture combinations
* Reuse of TypeScript analysis results
* No unnecessary subprocess spawning
* No required full Storybook build for ordinary component tests
* No generated files committed to Git

Benchmark cold and warm generation, watch-mode regeneration, and Storybook startup.

Prevent generated story growth from becoming proportional to all possible prop combinations.

## 13. Integration with examples and starter templates

Update every relevant React example and the starter repository.

Ensure they include:

* Vite
* React
* Tailwind v4
* shadcn/ui conventions
* Design-system integration
* Generated Storybook support
* Component discovery
* Appropriate linting
* Generated fixtures
* Story editor integration where applicable

Remove obsolete competing styling or component infrastructure.

Preserve working examples and established APIs wherever practical.

## 14. Documentation and agent instructions

Update the relevant AGENTS.md files and documentation.

Make the following mandatory conventions explicit:

* React only.
* Tailwind v4 for styling.
* shadcn/ui component conventions.
* Vibelang + Effect.ts for state/domain behavior.
* Reuse existing components before creating new ones.
* Use semantic tokens for important styling values.
* Do not duplicate the design system.
* Do not manually maintain generated Storybook stories.
* Generated artifacts are disposable and gitignored.
* Use the monorepo's established package boundaries.
* Keep component code small, readable, and composable.

Document how an AI agent should:

1. Find an existing component.
2. Identify its model and contracts.
3. Modify or extend it.
4. Regenerate its stories.
5. Preview it.
6. Validate styling and behavior.
7. Update design documentation where necessary.

## 15. Implementation and verification

Delegate independent research, implementation, and review work to parallel subagents where supported.

Use separate worktrees or non-overlapping file ownership to prevent conflicting edits.

Implement everything in the actual repository.

Inspect and respect existing conventions instead of blindly replacing working infrastructure.

Test:

* Story generation
* Schema-derived fixtures
* Stable generated IDs
* Hot reload
* Incremental regeneration
* Storybook rendering
* Story editor integration
* Design-token synchronization
* Theme changes
* Lint rules
* Example applications
* Production builds

Run available validation and verification steps.

Do not claim functionality works without executing the corresponding test.

## 16. Multiple review and cleanup passes

After the initial implementation:

* **Pass 1:** Review correctness and integration. Fix broken tests, missing coverage, architectural inconsistencies, and incomplete examples.
* **Pass 2:** Consolidate and simplify. Remove redundant generators, duplicated metadata, unnecessary dependencies, excessive abstractions, and stale code.
* **Pass 3:** Optimize startup, cache behavior, regeneration speed, story loading, and CI overhead.

Review AGENTS.md, documentation, generated-file boundaries, and repository conventions again.

Use the repository's develop/main workflow:

* Work on an isolated branch.
* Integrate into develop after validation.
* Run the required full validation for promotion to main.
* Merge to main only when checks succeed.
* Repeat review and cleanup as necessary, validating and merging each completed pass.

Push changes where repository permissions and configured remotes allow.

Do not bypass failing checks, force-push protected branches, or fabricate success.

## Definition of done

The goal is complete when:

* Every eligible React component can be discovered automatically.
* Generated stories require no routine manual maintenance.
* Generated stories are integrated into the existing story editor.
* Component/model/document links work.
* Design tokens control global visual styles.
* Tailwind and lint rules enforce meaningful consistency.
* AI-assisted design-document changes can update tokens safely.
* Component tests reuse generated fixtures and stories.
* Generated files stay out of Git.
* All relevant examples work.
* Builds, tests, linting, and verification pass.
* Documentation and AGENTS.md accurately reflect the implementation.
* The system is demonstrably smaller and easier to maintain than manually maintained stories and styling.

Deliver a concise final report describing decisions, implemented functionality, tests executed, performance measurements, remaining limitations, and final Git state.
