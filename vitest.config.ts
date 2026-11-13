// The tools' own tests: vibestack/testing/test and vibestack/stories/test.
import { project } from "./vibestack/testing/vitest.ts";

export default project({ root: import.meta.dirname, environment: "node", tests: ["vibestack/testing/test/*.test.ts", "vibestack/stories/test/*.test.ts"] });
