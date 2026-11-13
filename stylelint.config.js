const tailwind = ["theme", "utility", "variant", "custom-variant", "source", "plugin", "apply", "reference", "config"]

export default {
  extends: ["stylelint-config-standard"],
  // Other checkouts of this repository, then what is generated or outside the workspace.
  ignoreFiles: [".claude/**", "**/node_modules/**", "**/gen/**", "**/dist/**", "**/.cache/**", "**/.spec-cache/**", "**/generated/**", "**/storybook-static/**", "vibestack/examples/**", "vibestack/fixtures/**"],
  rules: {
    "at-rule-no-unknown": [true, { ignoreAtRules: tailwind }],
    "at-rule-no-deprecated": [true, { ignoreAtRules: ["apply"] }],
    "function-no-unknown": [true, { ignoreFunctions: ["theme", "--spacing", "--alpha"] }],
    "import-notation": "string",
    "alpha-value-notation": "number",
    // Tokens are written as shadcn/ui writes them: oklch(0.21 0.006 285.9).
    "lightness-notation": "number",
    "hue-degree-notation": "number",
    "media-feature-range-notation": "prefix",
    // Custom properties hold font stacks, whose family names are capitalized.
    "value-keyword-case": ["lower", { ignoreProperties: ["/^--/"] }],
    // Studio's sheet writes one rule to a line, grouped by component, with six-digit colors throughout.
    "color-hex-length": null,
    "declaration-empty-line-before": null,
    "at-rule-empty-line-before": null,
    "no-descending-specificity": null,
  },
}
