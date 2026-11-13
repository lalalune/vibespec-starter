#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { type Tokens, applyChanges, check, parseTokens, syncDoc, themeCss, tokensCss } from "./index.ts"

const at = (file: string) => new URL(`../${file}`, import.meta.url)
const read = (file: string) => readFileSync(at(file), "utf8")
const load = () => parseTokens(JSON.parse(read("tokens.json")))
const build = (tokens: Tokens) => {
  mkdirSync(at("generated"), { recursive: true })
  writeFileSync(at("generated/tokens.css"), tokensCss(tokens))
  writeFileSync(at("generated/theme.css"), themeCss(tokens))
  writeFileSync(at("design.md"), syncDoc(read("design.md"), tokens))
}

const [command, file, flag] = process.argv.slice(2)
try {
  if (command === "build") build(load())
  else if (command === "check") {
    const tokens = load()
    const issues = check(tokens, read("design.md"))
    for (const [file, expected] of [["generated/tokens.css", tokensCss(tokens)], ["generated/theme.css", themeCss(tokens)]])
      if (!existsSync(at(file!)) || read(file!) !== expected) issues.push(`${file}: missing or stale; run design-tokens build`)
    if (issues.length) throw new Error(issues.join("\n"))
  } else if (command === "apply" && file) {
    const { tokens, diff } = applyChanges(load(), JSON.parse(readFileSync(file, "utf8")))
    console.log(diff)
    if (flag === "--write") {
      writeFileSync(at("tokens.json"), `${JSON.stringify(tokens, null, 2)}\n`)
      build(tokens)
    } else console.log("Not written. Pass --write to apply.")
  } else throw new Error("usage: design-tokens build | check | apply <changes.json> [--write]")
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
