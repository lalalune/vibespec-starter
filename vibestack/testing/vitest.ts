// The one Vitest configuration of every package (AGENTS.md, "Tests"; "Building, running and testing").
import { playwright } from "@vitest/browser-playwright";
import vibelang from "vibelang-vite";
import { defineConfig } from "vitest/config";

export interface Project {
  /** The package directory: `import.meta.dirname` of its vitest.config.ts. */
  root: string;
  /** Where tests run when not in a browser; "node" for a package without a DOM. */
  environment?: "node" | "happy-dom" | "jsdom";
  /** Browser Mode: run only `*.browser.test.tsx`, in one headless Chromium. */
  browser?: boolean;
  /** Also run what generate.ts wrote to `.cache/generated/tests`. */
  generated?: boolean;
  tests?: string[];
}

const BROWSER = "test/**/*.browser.test.tsx";

export const project = ({ root, environment = "happy-dom", browser = false, generated = false, tests = ["test/**/*.test.{ts,tsx,vibe}"] }: Project) => defineConfig({
  root,
  plugins: [vibelang()],
  test: {
    include: browser ? [BROWSER] : [...tests, ...generated ? [".cache/generated/tests/**/*.test.ts"] : []],
    exclude: ["**/node_modules/**", ...browser ? [] : [BROWSER]],
    environment,
    // A failure repeats: fixed order, no retry that could hide a flaky test. Property seeds are FUZZ_SEED (properties.ts).
    sequence: { shuffle: false, seed: 1 },
    retry: 0,
    // Journeys start real servers and databases.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    ...browser && {
      // One page at a time in the one browser, so a journey never sees another file's storage or focus.
      fileParallelism: false,
      browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: "chromium" as const }], screenshotFailures: true, trace: "retain-on-failure" as const },
    },
  },
});
