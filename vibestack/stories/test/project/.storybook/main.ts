import { fileURLToPath } from "node:url";
import { storybook } from "../../../../../packages/storybook/src/preset.ts";
export default storybook(fileURLToPath(new URL("..", import.meta.url)));
