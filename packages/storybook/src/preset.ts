import path from "node:path";
import type { Plugin, UserConfig } from "vite";
import { generateCatalog } from "./catalog.ts";

/** Storybook discovers disposable CSF files; Vite refreshes them when a component or metadata file changes. */
export function storybook(directory: string) {
  const root = path.resolve(directory);
  generateCatalog(root);
  const watch: Plugin = {
    name: "component-catalog",
    configureServer(server) {
      const src = path.join(root, "src") + path.sep;
      server.watcher.add(src);
      const changed = (file: string) => {
        if (file.startsWith(src) && file.endsWith(".tsx")) generateCatalog(root);
      };
      server.watcher.on("add", changed).on("change", changed).on("unlink", changed);
      server.httpServer?.once("close", () => {
        server.watcher.off("add", changed).off("change", changed).off("unlink", changed);
      });
    },
  };
  return {
    stories: [path.join(root, ".storybook/generated/*.stories.tsx")],
    framework: { name: "@storybook/react-vite", options: {} },
    addons: ["@storybook/addon-a11y"],
    viteFinal(config: UserConfig): UserConfig { return { ...config, plugins: [...(config.plugins ?? []), watch] }; },
  };
}
