import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";
export default defineConfig({
  root: path.join(import.meta.dirname, "src/components-page"),
  base: "/components/",
  plugins: [react(), tailwind()],
  build: { outDir: path.join(import.meta.dirname, "src/public/components"), emptyOutDir: true },
});
