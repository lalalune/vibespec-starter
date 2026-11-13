import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss()],
  test: {
    projects: [
      { extends: true, test: { name: "dom", environment: "happy-dom", include: ["test/**/*.test.tsx", "generated/stories/stories.test.tsx"] } },
      {
        extends: true,
        test: { name: "browser", include: ["generated/stories/stories.browser.test.tsx"], browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }] } },
      },
    ],
  },
});
