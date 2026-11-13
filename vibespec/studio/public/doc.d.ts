// The types of doc.js, for ../doc.ts and ../server.ts.

/** A run of prose, or the code of one quint block. */
export interface Item { quint: boolean; text: string }
/** A `###` rule: its heading text and everything up to the next heading, raw; `items` is the same body read for display. */
export interface DocRule { title: string; body: string; items: Item[] }
/** A `##` story or group of rules. `title` is null for rules that come before any `##`. */
export interface DocSection { title: string | null; body: string; rules: DocRule[] }
/** `title` is the `# ` line, if the file starts with one; `body` runs to the first heading; `newline` is whether the text ends in one. */
export interface Doc { title: string | null; body: string; sections: DocSection[]; newline: boolean }

export function storyKey(title: string | null): string;
export function ruleKey(section: string | null, title: string): string;
export function nodeId(file: string, key: string): string;
export function diffOps<T>(a: readonly T[], b: readonly T[]): [" " | "-" | "+", T][];
export function specOrder(a: string, b: string): number;
