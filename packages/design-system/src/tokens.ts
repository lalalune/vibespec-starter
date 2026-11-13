import { Schema } from "effect"

export const colorNames = [
  "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
  "primary", "primary-foreground", "secondary", "secondary-foreground", "muted", "muted-foreground",
  "accent", "accent-foreground", "destructive", "destructive-foreground", "border", "input", "ring", "ok", "warn",
] as const
export type ColorName = (typeof colorNames)[number]

const matching = (pattern: RegExp) => Schema.String.pipe(Schema.check(Schema.isPattern(pattern)))
/** Opaque `oklch(L C H)`: lightness 0..1, chroma, hue in degrees. */
const Color = matching(/^oklch\((?:0|1|0?\.\d+) (?:0|0?\.\d+) \d{1,3}(?:\.\d+)?\)$/)
const Length = matching(/^\d*\.?\d+(?:rem|px)$/)
const Theme = Schema.Record(Schema.Literals(colorNames), Color)
const named = <S extends Schema.Top>(value: S) => Schema.Record(Schema.String, value)

export const Tokens = Schema.Struct({
  color: Schema.Struct({ light: Theme, dark: Theme }),
  radius: Length,
  font: Schema.Struct({ sans: Schema.NonEmptyString, mono: Schema.NonEmptyString }),
  shadow: named(Schema.NonEmptyString),
  motion: Schema.Struct({ duration: named(matching(/^\d+ms$/)), ease: named(Schema.NonEmptyString) }),
  breakpoint: named(Length),
})
export type Tokens = typeof Tokens.Type

/** The only way a proposed change enters: a token's dotted path, its new value and why. */
export const TokenChange = Schema.Struct({ path: Schema.String, value: Schema.String, reason: Schema.NonEmptyString })
export type TokenChange = typeof TokenChange.Type

const strict = { onExcessProperty: "error", errors: "all" } as const
export const parseTokens = Schema.decodeUnknownSync(Tokens, strict)
const parseChanges = Schema.decodeUnknownSync(Schema.Array(TokenChange), strict)

const linear = (color: string) => {
  const [L, C, H] = color.slice(6, -1).split(" ").map(Number) as [number, number, number]
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel))) as [number, number, number]
}
const luminance = (color: string) => {
  const [r, g, b] = linear(color)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG 2 contrast ratio of two oklch colors. */
export const contrast = (one: string, other: string) => {
  const [dark, light] = [luminance(one), luminance(other)].sort((x, y) => x - y) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

/** Text color on surface: each `x-foreground` on `x`, and every color used as text on the page and on a card. */
export const contrastPairs: [ColorName, ColorName][] = [
  ["foreground", "background"],
  ...colorNames.filter((name) => name.endsWith("-foreground")).map((name): [ColorName, ColorName] => [name, name.slice(0, -11) as ColorName]),
  ...(["muted-foreground", "primary", "destructive", "ok", "warn"] as const).flatMap((name): [ColorName, ColorName][] => [[name, "background"], [name, "card"]]),
]

/** Every pair below WCAG AA (4.5:1), in both themes. */
export const contrastIssues = (tokens: Tokens) =>
  (["light", "dark"] as const).flatMap((theme) =>
    contrastPairs.flatMap(([text, surface]) => {
      const ratio = contrast(tokens.color[theme][text], tokens.color[theme][surface])
      return ratio < 4.5 ? [`color.${theme}.${text} on ${surface}: contrast ${ratio.toFixed(2)} is below 4.5`] : []
    }))

/** Validates changes against the schema and AA contrast; returns the new tokens and a before/after diff, or throws. */
export function applyChanges(tokens: Tokens, input: unknown): { tokens: Tokens; diff: string } {
  const next: unknown = structuredClone(tokens)
  const diff = parseChanges(input).map(({ path, value, reason }) => {
    const keys = path.split("."), leaf = keys.pop()!
    const parent = keys.reduce<unknown>((at, key) => (at instanceof Object && Object.hasOwn(at, key) ? (at as Record<string, unknown>)[key] : undefined), next) as Record<string, unknown> | undefined
    if (!(parent instanceof Object) || !Object.hasOwn(parent, leaf) || typeof parent[leaf] !== "string") throw new Error(`unknown token path: ${path}`)
    const line = `# ${reason}\n- ${path}: ${parent[leaf]}\n+ ${path}: ${value}`
    parent[leaf] = value
    return line
  })
  const result = parseTokens(next), issues = contrastIssues(result)
  if (issues.length) throw new Error(issues.join("\n"))
  return { tokens: result, diff: diff.join("\n") }
}
