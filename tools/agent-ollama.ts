#!/usr/bin/env node
// A minimal agent for `npm run sync` that needs no account: a local Ollama model.
//
//   SPEC_AGENT="node tools/agent-ollama.ts" npm run sync
//
// Small models cannot hold a whole repository in mind, so this adapter reads
// the brief that sync sends and asks one small question per item:
//   - a story with no rules      -> write its rules (prose and Quint)
//   - a rule whose model changed -> rewrite its prose to say what the Quint says
//   - a rule whose prose changed -> rewrite its Quint to say what the prose says
// Whatever the model writes is then judged by the same checks as anything else.
//   - a new rule that a trace breaks -> correct it or withdraw it
//   - a new transition whose trace breaks an established rule -> strengthen its guard
// It does not attempt to repair established rules or failed proofs; use a stronger agent for those.

import fs from "node:fs";
import path from "node:path";

const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const FENCE = "```";
const brief = fs.readFileSync(0, "utf8");

async function ask(prompt: string): Promise<string> {
  const response = await fetch(`${HOST}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { temperature: 0.1, num_ctx: 8192 } }),
  }).catch(() => {
    console.error(`no Ollama server at ${HOST}`);
    process.exit(1);
  });
  if (!response.ok) throw new Error(`Ollama at ${HOST} answered ${response.status}; is \`ollama serve\` running and ${MODEL} pulled?`);
  return ((await response.json()).response as string).trim();
}
const heading = (s: string) => s.replace(/^(#+ )+/gm, "### ").trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unfence = (s: string) => s.replace(/^```\w*\n/, "").replace(/\n```$/, "").trim();

const CONVENTIONS = `Conventions for the Quint:
- Only \`pure def\` and \`pure val\`. No var, no action.
- A transition is \`pure def name(o: Order, ...): Order = { ...o, field: value }\`.
- Its guard is \`pure def canName(o: Order, ...): bool = ...\` with the same parameters.
- A rule that must always hold is \`pure def alwaysSomething(o: Order): bool = ...\`.
- Operators: and, or, not(...), implies, ==, !=, <, <=, >, >=, +, -, *, if (c) a else b.
- Use only the fields and types that already exist.`;

let edits = 0;
for (const file of fs.readdirSync("spec").filter((f) => f.endsWith(".md")).map((f) => path.join("spec", f))) {
  let text = fs.readFileSync(file, "utf8");

  // Stories with no rules: the story's own lines, plus the existing spec as a style guide.
  for (const [, title] of brief.matchAll(/^ +\S+:\d+ {2}(.+)\n +story has no rules/gm)) {
    const at = text.indexOf(`## ${title}`);
    if (at < 0) continue;
    const next = text.indexOf("\n## ", at + 1);
    const end = next < 0 ? text.length : next;
    const rules = await ask(`This is a specification. Each story (##) has rules (###), and each rule is one sentence followed by a quint block.

${text.slice(0, at)}
The next story has no rules yet:

${text.slice(at, end).trim()}

${CONVENTIONS}

Write the one rule this story requires. Answer in exactly this shape, replacing the words in capitals and
keeping every other character, including the ${FENCE} lines:

### ONE SENTENCE STATING THE RULE

${FENCE}quint
pure def canVERB(o: Order): bool = CONDITION
pure def VERB(o: Order): Order = { ...o, FIELD: VALUE }
${FENCE}`);
    if (!rules.includes("### ") || !rules.includes(`${FENCE}quint`)) {
      console.log(`[agent-ollama] unusable answer for "${title}":\n${rules}`);
      continue;
    }
    text = `${text.slice(0, end).trimEnd()}\n\n${heading(rules.slice(rules.indexOf("### ")))}\n${text.slice(end)}`;
    edits++;
  }

  // A simulated trace breaks a rule. If the broken rule is new, correct or withdraw it. If instead the
  // event that got there is new, its guard is too weak: strengthen it and say what was discovered.
  // A break between established rules is beyond this adapter.
  const failure = brief.match(/✗ always +a reachable state breaks "(.+?)" \(\S+?\)[^\n]*\n((?: {6}.*\n)+?) {6}the last event is "(.+?)"/);
  const isNew = (key: string) => new RegExp(`  ${escape(key)}\\n +new:`).test(brief);
  const culprit = failure && (isNew(failure[1]) ? failure[1] : isNew(failure[3]) ? failure[3] : null);
  const at = culprit ? text.indexOf(`### ${culprit.split(" / ").pop()}\n`) : -1;
  if (failure && culprit && at >= 0) {
    const next = text.slice(at + 1).search(/\n##+ /);
    const end = next < 0 ? text.length : at + 1 + next;
    const section = text.slice(at, end).trim();
    const shape = `a line starting with "### ", then a ${FENCE}quint block`;
    const answer = await ask(culprit === failure[1]
      ? `This rule was just added to a specification of an order checkout, and it is false.\n\n${section}\n
This sequence of events reaches a state that breaks it:\n${failure[2]}\n${CONVENTIONS}\n
If the rule can be corrected so that it is true in every reachable state, answer with the corrected rule: ${shape}.
If the specification does not need this rule, answer with the single word DELETE.`
      : `This rule was just added to a specification of an order checkout.\n\n${section}\n
Its guard allows too much. This sequence of events is allowed, and its last state breaks the established rule
"${failure[1].split(" / ").pop()}":\n${failure[2]}\n${CONVENTIONS}\n
Rewrite the rule so that its guard also forbids that last event. Keep the heading and the transition. Add one
sentence of prose under the heading that starts with "Discovered by simulation:" and says what must not be allowed.
Answer with the whole rule: ${shape}.`);
    const replacement = answer.includes(`${FENCE}quint`) && answer.includes("### ") ? heading(answer.slice(answer.indexOf("### "))) + "\n" : "";
    if (replacement || culprit === failure[1]) {
      text = `${text.slice(0, at).trimEnd()}\n${replacement ? "\n" + replacement : ""}${text.slice(end)}`;
      edits++;
    }
  }

  // Rules with one half behind: show both halves, ask for the lagging one.
  for (const [, key, status, prose, quint] of brief.matchAll(/^RULE "(.+)" \((.+)\)\nits prose now:\n([\s\S]*?)\nits Quint now:\n([\s\S]*?)\nEND RULE/gm)) {
    const behind = status === "model changed" ? "prose" : status === "prose changed" ? "Quint" : null;
    const old = behind === "prose" ? prose : quint;
    if (!behind || !text.includes(old)) continue;
    const answer = unfence(await ask(`A rule in a specification is stated twice: in prose and in Quint. They must say the same thing.
The rule is "${key.split(" / ").pop()}".

Prose:
${prose}

Quint:
${quint}

The ${behind === "prose" ? "Quint" : "prose"} is correct and the ${behind} is out of date.
${behind === "prose" ? "Rewrite the prose so that every fact in it agrees with the Quint. Keep it as short as it is now." : `Rewrite the Quint so that it says what the prose says.\n${CONVENTIONS}`}
Answer with the new ${behind} only.`));
    if (!answer || answer === old) continue;
    text = text.replace(old, answer);
    edits++;
  }
  fs.writeFileSync(file, text);
}
console.log(`[agent-ollama] ${MODEL} made ${edits} edit(s)`);
