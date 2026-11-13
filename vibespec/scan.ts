// How a spec's lines are read: shared by the parser (parse.ts) and the studio's page, so it imports nothing.

/** What one line of a spec is: a story or rule heading, a fence that opens or closes, a line inside a fence, or prose. */
export type LineKind = "story" | "rule" | "open" | "open quint" | "close" | "quint" | "fenced" | "prose";

/**
 * Every line of a spec with what it is. A fence of any kind (``` or ~~~, of any length) closes only with a fence of
 * the same character at least as long and nothing after it; `##` and `###` inside a fence are not headings.
 */
export function scanSpec(text: string): { text: string; kind: LineKind }[] {
  let fence: { mark: string; quint: boolean } | undefined;
  return text.split("\n").map((text) => {
    const marker = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence && marker && marker[1][0] === fence.mark[0] && marker[1].length >= fence.mark.length && !marker[2].trim()) {
      fence = undefined;
      return { text, kind: "close" };
    }
    if (fence) return { text, kind: fence.quint ? "quint" : "fenced" };
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = { mark: marker[1], quint: marker[2].trim().split(/\s+/)[0] === "quint" };
      return { text, kind: fence.quint ? "open quint" : "open" };
    }
    return { text, kind: text.startsWith("## ") ? "story" : text.startsWith("### ") ? "rule" : "prose" };
  });
}
