import { defineConfig } from "vitest/config";

// The token tool's test lives with the tool; it runs here because this project has its dependencies.
export default defineConfig({ root: "../..", test: { include: ["vibestack/design/test/**/*.test.ts"] } });
