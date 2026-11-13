import vibelang from "vibelang-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({ plugins: [vibelang()], test: { include: ["test/**/*.test.vibe"], globalSetup: "bundle.ts", testTimeout: 60_000 } });
