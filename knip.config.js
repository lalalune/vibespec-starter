// Knip reads .vibe files through VibeLang's own compiler. Each ignore below names something Knip cannot follow:
// standalone examples and fixtures, disposable generated directories, and dependencies resolved at run time
// (Tailwind and the design-system theme by CSS and the lint plugin, Quint and LemmaScript as executables).
import vibelang from "vibelang/knip"

export default {
  compilers: { vibe: vibelang, vibex: vibelang },
  "ignore": [
    "vibestack/examples/**",
    "vibestack/fixtures/**",
    "**/gen/**",
    "**/dist/**",
    "**/generated/**",
    "**/test/fixtures/**",
    "vibestack/stories/test/project/**",
    "**/*.d.vibe.ts",
    "**/.vibe/**"
  ],
  "ignoreExportsUsedInFile": true,
  "workspaces": {
    ".": {
      "entry": [
        "vibestack/design/cli.ts",
        "vibestack/stories/cli.ts",
        "vibestack/*/test/*.test.ts"
      ],
      "project": [
        "vibestack/**/*.{ts,tsx}",
        "!vibestack/studio/**"
      ],
      "ignoreDependencies": [
        "@informalsystems/quint",
        "lemmascript",
        "@vitest/browser"
      ]
    },
    "packages/ui": {
      "entry": [
        "src/**/*.{meta,stories}.tsx",
        "test/**/*.test.{ts,tsx}"
      ],
      "project": [
        "**/*.{ts,tsx}"
      ],
      "ignoreDependencies": [
        "tailwindcss"
      ]
    },
    "packages/design-system": {
      "ignoreDependencies": [
        "eslint",
        "eslint-plugin-better-tailwindcss",
        "tailwindcss",
        "typescript-eslint"
      ]
    },
    "vibestack/studio": {
      "entry": [
        "src/server.ts",
        "src/page.ts",
        "test/*.test.ts",
        "src/components.ts"
      ],
      "project": [
        "src/**/*.ts",
        "test/**/*.ts"
      ]
    },
    "apps/*": {
      "entry": [
        "src/main.tsx",
        "test/**/*.test.{ts,tsx,vibe}",
        "test/drivers/*.ts",
        "src/**/*.schema.ts",
        "src/**/*.contract.ts"
      ],
      "project": [
        "src/**/*.{ts,tsx,vibe}",
        "test/**/*.{ts,tsx,vibe}"
      ],
      "ignoreDependencies": [
        "tailwindcss",
        "@repo/design-system"
      ]
    }
  }
}
