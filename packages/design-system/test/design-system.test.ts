import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { expect, test } from "vitest"
import { designSystem } from "../src/eslint.ts"
import { type Tokens, applyChanges, check, syncDoc, themeCss, tokens, tokensCss } from "../src/index.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const primary = { path: "color.light.primary", value: "oklch(0.45 0.2 277)", reason: "deeper accent" }
const changedLines = (before: string, after: string) => {
  const old = before.split("\n")
  return after.split("\n").filter((line, index) => line !== old[index])
}

test("generated CSS is deterministic and a token change touches only that token's lines", () => {
  const copy = JSON.parse(JSON.stringify(tokens)) as Tokens
  expect([tokensCss(copy), themeCss(copy)]).toEqual([tokensCss(tokens), themeCss(tokens)])
  const next = applyChanges(tokens, [primary]).tokens
  expect(changedLines(tokensCss(tokens), tokensCss(next))).toEqual(["  --primary: oklch(0.45 0.2 277);"])
  expect(themeCss(next)).toBe(themeCss(tokens))
  const dark = applyChanges(tokens, [{ ...primary, path: "color.dark.primary", value: "oklch(0.75 0.15 282)" }]).tokens
  expect(changedLines(tokensCss(tokens), tokensCss(dark))).toEqual(["  --primary: oklch(0.75 0.15 282);", "    --primary: oklch(0.75 0.15 282);"])
})

test("apply accepts a valid change and rejects an unknown path, an invalid color and broken contrast", () => {
  const { tokens: next, diff } = applyChanges(tokens, [primary])
  expect(next.color.light.primary).toBe(primary.value)
  expect(tokens.color.light.primary).not.toBe(primary.value)
  expect(diff).toBe(`# deeper accent\n- color.light.primary: ${tokens.color.light.primary}\n+ color.light.primary: ${primary.value}`)
  expect(() => applyChanges(tokens, [{ ...primary, path: "color.light.brand" }])).toThrow("unknown token path: color.light.brand")
  expect(() => applyChanges(tokens, [{ ...primary, path: "constructor.name" }])).toThrow("unknown token path")
  expect(() => applyChanges(tokens, [{ ...primary, value: "#4f46e5" }])).toThrow(/oklch/)
  expect(() => applyChanges(tokens, [{ ...primary, value: "oklch(0.9 0.05 277)" }])).toThrow(/color\.light\.primary-foreground on primary: contrast .* is below 4\.5/)
  expect(() => applyChanges(tokens, [{ path: primary.path, value: primary.value }])).toThrow(/reason/)
  expect(() => applyChanges(tokens, [{ ...primary, reason: "" }])).toThrow(/reason/)
})

test("check passes on the committed tokens and design.md, and detects a stale design.md", () => {
  const doc = readFileSync(`${root}design.md`, "utf8")
  expect(check(tokens, doc)).toEqual([])
  const next = applyChanges(tokens, [primary]).tokens
  expect(check(next, doc)).toEqual(["design.md: the token table is stale; run `design-tokens build`"])
  expect(check(next, syncDoc(doc, next))).toEqual([])
})

test("the ESLint config flags values that bypass the tokens and accepts token classes", async () => {
  execFileSync("node", ["src/cli.ts", "build"], { cwd: root })
  const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: designSystem({ entryPoint: `${root}generated/theme.css` }) })
  const [bad, good] = await eslint.lintFiles(["test/fixtures/bad.tsx", "test/fixtures/good.tsx"])
  expect(bad!.messages.map(({ line, ruleId }) => [line, ruleId])).toEqual([
    [2, "better-tailwindcss/no-restricted-classes"],
    [3, "better-tailwindcss/no-restricted-classes"],
    [4, "design-system/no-literal-colors"],
    [5, "design-system/no-literal-colors"],
  ])
  expect(bad!.messages[0]!.message).toContain("primary, primary-foreground")
  expect(good!.messages).toEqual([])
})
