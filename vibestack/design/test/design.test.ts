// Runs against the project in the current directory: its tokens.json, design.md and installed Tailwind and ESLint.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, test } from "vitest"
import { designSystem } from "../eslint.ts"
import { check, syncDoc, themeCss, tokensCss } from "../generate.ts"
import { type Tokens, applyChanges, parseTokens } from "../tokens.ts"

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url))
// ESLint and its plugins belong to the project, so they resolve from there, not from the tool's directory.
const project = createRequire(`${process.cwd()}/`)
const load = (name: string) => import(pathToFileURL(project.resolve(name)).href)
const tokens = parseTokens(JSON.parse(readFileSync("tokens.json", "utf8")))
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
  expect(() => applyChanges(tokens, [{ ...primary, value: "#4f46e5" }])).toThrow(/expected oklch/)
  expect(() => applyChanges(tokens, [{ ...primary, value: "oklch(0.9 0.05 277)" }])).toThrow(/color\.light\.primary-foreground on primary: contrast .* is below 4\.5/)
  expect(() => applyChanges(tokens, [{ path: primary.path, value: primary.value }])).toThrow(/reason/)
  const { radius: _, ...rest } = tokens
  expect(() => parseTokens({ ...rest, spacing: "1rem" })).toThrow("unknown token path: spacing\nradius: missing")
})

test("check passes on the project's tokens and design.md, and detects a stale design.md", () => {
  const doc = readFileSync("design.md", "utf8")
  expect(check(tokens, doc)).toEqual([])
  const next = applyChanges(tokens, [primary]).tokens
  expect(check(next, doc)).toEqual([expect.stringContaining("design.md: the token table is stale")])
  expect(check(next, syncDoc(doc, next))).toEqual([])
})

test("the ESLint config flags values that bypass the tokens and accepts token classes", async () => {
  execFileSync("node", [here("../cli.ts"), "build"])
  const [{ ESLint }, { default: tailwind }, { parser }] = await Promise.all(["eslint", "eslint-plugin-better-tailwindcss", "typescript-eslint"].map(load))
  const config = designSystem({ tailwind, tokens, entryPoint: `${process.cwd()}/generated/theme.css` })
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ["**/*.tsx"], languageOptions: { parser } }, ...config] })
  const lint = async (name: string) => (await eslint.lintText(readFileSync(here(`fixtures/${name}`), "utf8"), { filePath: name }))[0]!.messages
  expect((await lint("bad.tsx")).map(({ line, ruleId, message }: { line: number; ruleId: string; message: string }) => [line, ruleId, message.includes("primary, primary-foreground")])).toEqual([
    [2, "better-tailwindcss/no-restricted-classes", true],
    [3, "better-tailwindcss/no-restricted-classes", true],
    [4, "design-system/no-literal-colors", false],
    [5, "design-system/no-literal-colors", false],
  ])
  expect(await lint("good.tsx")).toEqual([])
}, 60_000)
