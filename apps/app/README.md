# @repo/app

The application, blank: a page shell on `@repo/ui` and the design-system theme, and nothing it does yet.

Its requirements are [`spec/app/index.md`](../../spec/app/index.md), in the one spec tree at the repository root. `pnpm check`
there generates `gen/app.ts` and `gen/app.effect.vibe` here, and checks this package's types, tests and traces
(SPEC.md, "One spec tree").

To add the first rule:

1. Write a story and its rules in `spec/app/index.md` (`pnpm dev` at the root opens Studio on it).
2. Run `pnpm check` at the root and follow what it says.
3. Write the shell in `src/` on `gen/app.effect.vibe`, and a journey in `test/app.test.vibe` that cites the rule:
   `// spec/app/index.md, "<the rule's heading>"`. Add `"test": "node ../../vibestack/testing/generate.ts . && vitest run"` to `package.json` with the first test.

| Command | Does |
|---|---|
| `pnpm dev` | the app, with Vite |
| `pnpm typecheck`, `pnpm build` | `vibelang --noEmit`; `vite build` to `dist/` |
