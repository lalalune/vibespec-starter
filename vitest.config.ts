// The tool's own tests: vibestack/testing/test and the root's generated tests (vibestack/testing/generate.ts).
import { project } from "./vibestack/testing/vitest.ts";

export default project({ root: import.meta.dirname, environment: "node", generated: true, tests: ["vibestack/testing/test/*.test.ts"] });
