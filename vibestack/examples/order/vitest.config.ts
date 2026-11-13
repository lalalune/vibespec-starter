import vibelang from "vibelang-vite";
import { defineConfig } from "vitest/config";

// A journey fails by its assertions, not by the clock: Vitest's default limit of 5 s is less than the first import of
// Effect can take on a busy machine.
export default defineConfig({ plugins: [vibelang()], test: { include: ["test/**/*.test.vibe"], testTimeout: 60_000 } });
