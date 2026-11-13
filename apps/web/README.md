# @repo/web

The starter application: a task list that holds at most three open tasks. Copy it for a new app.

| It shows | In |
|---|---|
| Stories, rules and Quint, proved | `spec/index.md`, `spec/index.proof.dfy` |
| A VibeLang shell on the generated `Machine`, storing the list in a `KeyValueStore` | `src/tasks.vibe` |
| An Effect Schema for what the store holds | `src/tasks.schema.ts` |
| React over the machine: a control is enabled exactly when `enabled` allows its event | `src/useTasks.ts`, `src/App.tsx` |
| The shell against a store that fails; the story through the page; the browser's own focus | `test/tasks.test.vibe`, `test/app.test.tsx`, `test/app.browser.test.tsx` |
| The driver the generated model-based test runs the shell through | `test/drivers/index.ts` |

| Command | Does |
|---|---|
| `pnpm dev` | the app, with Vite |
| `pnpm check` | every stage of AGENTS.md, "Spec reference" |
| `pnpm accept` | signs off what `review` lists |
| `pnpm test` | generates the schema and conformance tests, then runs them with the hand-written ones |
| `pnpm test:browser` | the browser test, in headless Chromium |
| `pnpm typecheck`, `pnpm build` | `vibelang --noEmit`; `vite build` to `dist/` |
