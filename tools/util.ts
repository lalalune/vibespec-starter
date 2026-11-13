// Small helpers that more than one reader of the user's files shares.

/**
 * `text` with `\r\n` read as `\n`, or a refusal naming the file and line if it holds NUL or a line break other than
 * `\n`. Quint, TypeScript, Dafny and these tools do not all agree on where a line ends at `\r`, `\v`, `\f`, U+0085,
 * U+2028 or U+2029, so a reviewer could see lines that differ from what a compiler reads, and prose could end a
 * comment early. No source needs NUL.
 */
export function plainText(file: string, text: string): string {
  const plain = text.replace(/\r\n/g, "\n");
  const lineOf = (at: number) => plain.slice(0, at).split("\n").length;
  const nul = plain.indexOf("\0");
  if (nul >= 0) throw new Error(`${file}:${lineOf(nul)}: NUL characters are not allowed`);
  const odd = plain.search(/[\r\v\f\u0085\u2028\u2029]/);
  if (odd >= 0) throw new Error(`${file}:${lineOf(odd)}: a line break other than \\n; save the file with plain line endings`);
  return plain;
}
