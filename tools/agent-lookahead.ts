#!/usr/bin/env node
// An agent for `npm run sync` that uses no model. It can do one thing: when the
// check reports a trace in which an event breaks an `always` rule, and proposes
// "refuse <event> when its result would break <rule>", it writes that rule into
// the spec, in prose and Quint, and adds it to the event's guard.
//
//   SPEC_AGENT="node tools/agent-lookahead.ts" npm run sync
//
// The repair is always sound, because the guard tests the very rule that broke.
// It is also the bluntest repair there is: it says what must not happen, not
// why. A person or a model can usually state a better rule; this one keeps the
// model consistent until they do. It cannot turn a story into rules.

import fs from "node:fs";
import path from "node:path";

const brief = fs.readFileSync(0, "utf8");
const proposal = brief.match(/a rule that would forbid it: refuse (\w+) when its result would break (\w+)/);
const where = brief.match(/the last event is "[^"]*" \((spec\/\w+\.md):\d+\)/);
if (!proposal || !where) {
  console.log("[agent-lookahead] nothing in this report that I can repair; it needs a person or a model");
  process.exit(0);
}
const [, event, rule] = proposal;
const file = where[1];
let text = fs.readFileSync(file, "utf8");
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const words = (s: string) => s.replace(/^always/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase();

// The event's own signature gives the parameters, with their Quint types.
const signature = text.match(new RegExp(`pure def ${event}\\(([^)]*)\\)`));
if (!signature) throw new Error(`${file}: cannot find \`pure def ${event}(\``);
const params = signature[1].replace(/\s+/g, " ").trim();
const args = params.split(",").map((p) => p.split(":")[0].trim()).join(", ");
const helper = `${event}Keeps${rule.replace(/^always/, "")}`;
if (text.includes(`pure def ${helper}(`)) {
  console.log(`[agent-lookahead] ${helper} is already in ${file}; the trace needs a person or a model`);
  process.exit(0);
}

// Strengthen the guard, or give the event one.
const guard = `can${cap(event)}`;
const guardAt = text.indexOf(`pure def ${guard}(`);
let newGuard = "";
if (guardAt >= 0) {
  const bodyAt = text.indexOf("=", text.indexOf("): bool", guardAt)) + 1;
  const end = bodyAt + text.slice(bodyAt).search(/\n\s*\n|\n```|\npure /);
  text = `${text.slice(0, bodyAt)} (${text.slice(bodyAt, end).trim()}) and ${helper}(${args})${text.slice(end)}`;
} else newGuard = `\npure def ${guard}(${params}): bool = ${helper}(${args})\n`;

// The new rule goes at the end of the story that holds the event.
const eventAt = text.indexOf(`pure def ${event}(`);
const nextStory = text.indexOf("\n## ", eventAt);
const end = nextStory < 0 ? text.length : nextStory;
const section = `
### ${cap(words(event))} is refused when it would break "${words(rule)}"

Discovered by simulation: a sequence of events ending in this one reached a
state that broke the rule. Until someone states the reason more precisely, the
event is refused whenever its result would break it.

\`\`\`quint
pure def ${helper}(${params}): bool = ${rule}(${event}(${args}))
${newGuard}\`\`\`
`;
text = `${text.slice(0, end).trimEnd()}\n${section}${text.slice(end)}`;
fs.writeFileSync(file, text);
console.log(`[agent-lookahead] added the rule ${helper} to ${path.basename(file)} and to the guard of ${event}`);
