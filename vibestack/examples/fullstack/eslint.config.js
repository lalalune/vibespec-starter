// The tokens only (design.md): no palette class, arbitrary color or literal color in the page.
import { readFileSync } from "node:fs";
import tailwind from "eslint-plugin-better-tailwindcss";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { designSystem } from "../../design/eslint.ts";
import { parseTokens } from "../../design/tokens.ts";

export default defineConfig({
  files: ["src/web/**/*.tsx"],
  languageOptions: { parser: tseslint.parser },
  extends: [designSystem({ tailwind, tokens: parseTokens(JSON.parse(readFileSync("tokens.json", "utf8"))), entryPoint: "generated/theme.css" })],
});
