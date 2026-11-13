import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import vibelang from "vibelang-vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.join(import.meta.dirname, "src/web"),
  plugins: [react(), vibelang(), tailwind()],
  build: {
    outDir: path.join(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
    rolldownOptions: { output: { entryFileNames: "app.js" } },
  },
});
