import { fileURLToPath } from "node:url"
import type { Linter, Rule } from "eslint"
import tailwind from "eslint-plugin-better-tailwindcss"
import palette from "tailwindcss/colors"
import { parser } from "typescript-eslint"
import { colorNames, tokens } from "./index.ts"

// A hex or functional color that is not inside a Tailwind arbitrary value, which no-restricted-classes reports.
const literalColor = /(?<![\w&[/-])(?:#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})\b|(?:rgba?|hsla?|oklch|oklab|lab|lch)\()/i

const noLiteralColors: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      literal: "Literal color in \"{{value}}\". Use a token: var(--primary), bg-primary, text-muted-foreground …",
      reason: "Say why the tokens do not fit: eslint-disable-next-line design-system/no-literal-colors -- <reason>",
    },
  },
  create(context) {
    const report = (node: Rule.Node, value: unknown) => {
      if (typeof value === "string" && literalColor.test(value)) context.report({ node, messageId: "literal", data: { value } })
    }
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments())
          if (/eslint-disable.*design-system\/no-literal-colors(?!.* -- \S)/.test(comment.value) && comment.loc) context.report({ loc: comment.loc, messageId: "reason" })
      },
      Literal: (node) => report(node, node.value),
      TemplateElement: (node) => report(node, node.value.cooked),
    }
  },
}

const variants = "^(?:.+:)?"
const palettes = Object.entries(palette).flatMap(([name, shades]) => (typeof shades === "object" ? [name] : []))
const radii = "rounded-sm, rounded-md, rounded-lg, rounded-xl"
const shadows = Object.keys(tokens.shadow).map((name) => `shadow-${name}`).join(", ")
const colors = `Use a color token: ${colorNames.join(", ")}.`
const restrict = [
  { pattern: `${variants}[a-z-]+-(?:${palettes.join("|")})-\\d{2,3}(?:/.+)?$`, message: `"$0" is a palette color. ${colors}` },
  { pattern: `${variants}[a-z-]+-\\[(?:#[\\da-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\\().*\\]$`, message: `"$0" is an arbitrary color. ${colors}` },
  { pattern: `${variants}rounded(?:-[a-z]{1,2})?-\\[.+\\]$`, message: `"$0" is an arbitrary radius. Use the radius token: ${radii}.` },
  { pattern: `${variants}shadow-\\[.+\\]$`, message: `"$0" is an arbitrary shadow. Use a shadow token: ${shadows}.` },
]

/** Flat config that holds `.ts`/`.tsx` to the tokens. `entryPoint` is the Tailwind CSS entry that imports the theme. */
export function designSystem({ entryPoint = fileURLToPath(new URL("../generated/theme.css", import.meta.url)) } = {}): Linter.Config[] {
  return [{
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "better-tailwindcss": tailwind, "design-system": { rules: { "no-literal-colors": noLiteralColors } } },
    settings: { "better-tailwindcss": { entryPoint } },
    rules: {
      "better-tailwindcss/no-unknown-classes": "error",
      "better-tailwindcss/no-conflicting-classes": "error",
      "better-tailwindcss/no-restricted-classes": ["error", { restrict }],
      "design-system/no-literal-colors": "error",
    },
  }]
}
