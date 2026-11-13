import { defineConfig } from "vitest/config";

// Two suites on this project's install: the generator's own tests, and the stories it generates here.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "generator", include: ["../stories.test.ts"], testTimeout: 60_000 } },
      { test: { name: "stories", include: ["generated/stories/stories.test.tsx"], exclude: [], environment: "happy-dom" } },
    ],
  },
});
