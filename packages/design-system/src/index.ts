import raw from "../tokens.json" with { type: "json" }
import { parseTokens } from "./tokens.ts"

export * from "./tokens.ts"
export * from "./generate.ts"
export const tokens = parseTokens(raw)
