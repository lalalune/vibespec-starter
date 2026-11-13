// Vitest serves the same Vite build as the application's build command.
import { build } from "vite";
export default async function bundle(): Promise<void> {
  await build({ configFile: new URL("./vite.config.ts", import.meta.url).pathname });
}
if (import.meta.main) await bundle();
