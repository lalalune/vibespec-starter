// Vitest runs this before the tests (vitest.config.ts), which fetch the page from the real server (served.vibe).
import { build } from "vite";

export default async function page(): Promise<void> {
  await build({ logLevel: "error" });
}
