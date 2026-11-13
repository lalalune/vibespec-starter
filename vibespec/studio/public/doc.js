// What the page (app.js) and the server (../doc.ts) read and write alike; the types are in doc.d.ts.

/** The review keys of a story and a rule (review.ts, `pending`), and the id of either in one spec. */
export const storyKey = (title) => (title === null ? "" : `## ${title.trim()}`);
export const ruleKey = (section, title) => `${section?.trim() ?? ""} / ${title.trim()}`;
export const nodeId = (file, key) => `${file}\0${key}`;

/** A spec's text. Untidy it is lossless: writeDoc(parseDoc(text)) === text. Tidy, for a spec that was edited, it puts a
 * blank line before every heading, since a story or rule moved to the end of another may have had nothing after it,
 * and ends in a single newline. */
export function writeDoc(doc, tidy = false) {
  let text = (doc.title === null ? "" : `# ${doc.title}\n`) + doc.body;
  const heading = (line) => { if (tidy && text && !text.endsWith("\n\n")) text += text.endsWith("\n") ? "\n" : "\n\n"; text += line; };
  for (const s of doc.sections) {
    if (s.title !== null) heading(`## ${s.title}\n`);
    text += s.body;
    for (const r of s.rules) { heading(`### ${r.title}\n`); text += r.body; }
  }
  return tidy ? text.replace(/\n*$/, "\n") : doc.newline ? text : text.replace(/\n$/, "");
}

/** The longest common subsequence of two lists, as the steps from `a` to `b`: kept, removed or added. */
export function diffOps(a, b) {
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const ops = [];
  for (let i = 0, j = 0; i < n || j < m; ) {
    if (i < n && j < m && a[i] === b[j]) { ops.push([" ", a[i++]]); j++; }
    else if (i < n && (j >= m || t[i + 1][j] >= t[i][j + 1])) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  return ops;
}

/** The order of specs in the rail: an index before the specs beside it. */
const rank = (file) => file.replace(/(?:^spec\/|\/)index\.md$/, "/");
export const specOrder = (a, b) => rank(a).localeCompare(rank(b));
