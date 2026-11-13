// The page as the browser gets it: src/web/app.ts and what it imports, `.vibe`
// included, as one module in dist/web beside index.html. `pnpm build` runs
// this file, and so does Vitest before the tests (vitest.config.ts), which
// fetch the page from the real server.
import { build } from "esbuild";
import vibelang from "vibelang-unplugin/esbuild";

export default async function bundle(): Promise<void> {
  await build({
    absWorkingDir: import.meta.dirname,
    entryPoints: ["src/web/app.ts", "src/web/index.html"],
    outdir: "dist/web",
    bundle: true,
    format: "esm",
    minify: true,
    loader: { ".html": "copy" },
    plugins: [vibelang()],
  });
}

if (import.meta.main) await bundle();
