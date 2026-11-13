// A project's `.storybook/main.ts` is `export default defineMain()`. Storybook and Vite are the project's
// own: this file names them as strings and hands Vite a plain object, so the tool installs neither.
import { join, relative, resolve } from "node:path";
import { type Options, generator, outOf, watched } from "./emit.ts";

export interface MainOptions extends Options {
  /** Hand-written stories, as globs relative to `.storybook/`. */
  stories?: string[];
}
interface Watcher { on(event: string, listener: (file: string) => void): unknown }

/** Storybook's main config: the generated stories and the hand-written ones, regenerated as components change. */
export function defineMain({ stories = ["../src/**/*.stories.@(ts|tsx)"], ...options }: MainOptions = {}) {
  const root = options.root ?? process.cwd();
  const generate = generator({ ...options, root });
  const run = () => {
    for (const line of generate().diagnostics) console.warn(`stories: ${line}`);
  };
  // Storybook lists stories before Vite starts, so they are written now.
  run();
  return {
    framework: "@storybook/react-vite",
    stories: [`${relative(join(root, ".storybook"), resolve(root, options.out ?? outOf(root))).replaceAll("\\", "/")}/*.stories.tsx`, ...stories],
    addons: ["@storybook/addon-a11y", "@storybook/addon-vitest"],
    core: { disableTelemetry: true },
    viteFinal: <Config extends { plugins?: unknown[] }>(config: Config) => ({
      ...config,
      plugins: [
        ...(config.plugins ?? []),
        {
          name: "vibestack-stories",
          configureServer(server: { watcher: Watcher }) {
            for (const event of ["add", "change", "unlink"]) server.watcher.on(event, (file) => watched(relative(root, file)) && run());
          },
        },
      ],
    }),
  };
}
