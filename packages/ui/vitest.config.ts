import tailwindcss from "@tailwindcss/vite";
import { project } from "vibestack/testing/vitest";

/** The package's tests and the generated stories, in happy-dom or, with `browser`, in Chromium. */
export const tests = (browser = false) =>
  project({
    root: import.meta.dirname,
    plugins: [tailwindcss()],
    tests: ["test/**/*.test.tsx", "generated/stories/stories.test.tsx"],
    browserTests: ["generated/stories/stories.browser.test.tsx"],
    browser,
  });

export default tests();
