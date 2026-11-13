import vibelang from "vibelang-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "test/page.ts",
    projects: [
      { plugins: [vibelang()], test: { name: "shell", include: ["test/**/*.test.vibe"], testTimeout: 60_000 } },
      // `pnpm stories` writes a mount of every story of src/web/components.
      { test: { name: "stories", include: ["generated/stories/stories.test.tsx"], environment: "happy-dom" } },
    ],
  },
});
