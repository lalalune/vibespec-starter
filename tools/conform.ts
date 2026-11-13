// The traces stage: traces a running program wrote, and a driver of a program in any language fed simulated traces,
// each replayed through the generated `step` (AGENTS.md, "Checking a running program").
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { isDeepStrictEqual } from "node:util";
import type { Model } from "./gen.ts";
import { SENDER } from "./gen/classify.ts";
import { entry, remembered, type Memory } from "./cache.ts";
import { simulate, changes, STEPS } from "./simulate.ts";
import { indent } from "./util.ts";

/** One line of a trace: an event, who sent it, and the state the program reached. A line without an event is a start: from `state`, or from `initial`. */
export interface Line { event?: unknown; by?: unknown; state?: unknown }

const TRACES = "test/traces";
/** Simulated traces a driver is fed, and how long it may take to answer one line. */
const DRIVEN = 100;
const ANSWER_WITHIN = 10_000;
/** Events the spec refuses that a driver is also sent before each event of a trace, which then must change nothing. */
const REFUSED_PER_STEP = 2;

/** Where a trace first departs from the spec, counting lines from 1, and why; undefined if it never does. */
export function departure(domain: any, model: Model, lines: Line[]): { line: number; why: string } | undefined {
  const same = (a: unknown, b: unknown) => isDeepStrictEqual(model.canon(model.stateType, a), model.canon(model.stateType, b));
  let s = domain.initial;
  for (const [i, line] of lines.entries()) {
    const at = (why: string) => ({ line: i + 1, why });
    if (!line || typeof line !== "object" || Array.isArray(line) || Object.keys(line).some((k) => !["event", "by", "state"].includes(k))) return at(`${JSON.stringify(line)} is not {event, by?, state?}`);
    if (line.event === undefined) {
      if (line.by !== undefined) return at("a line without an event has no `by`");
      s = line.state === undefined ? domain.initial : domain.parseState(line.state);
      if (!s) return at(`the program started from ${JSON.stringify(line.state)}, which has not the state's shape or breaks an \`always\` rule`);
      continue;
    }
    const event = domain.parseEvent(line.event);
    if (!event) return at(`${JSON.stringify(line.event)} is not an event of the spec`);
    if ((line.by === undefined) === !!model.sender) return at(model.sender ? `the spec's events have a sender: give \`${SENDER}\`` : `the spec's events have no sender: leave out \`${SENDER}\``);
    const next = domain.step(s, event, line.by);
    const got = line.state === undefined ? next : domain.parseState(line.state);
    if (!got || !same(got, next)) {
      const guard = model.transitions.find((t) => t.name === event.type)?.guard;
      const spec = domain.enabled(s, event, line.by) ? changes(s, next).join(", ") || "changes nothing" : `refuses it here${guard ? ` (${guard} is false)` : ""}, so nothing changes`;
      return at(`after ${JSON.stringify(line.event)}${line.by === undefined ? "" : ` from ${JSON.stringify(line.by)}`} the spec ${spec}; the program's state differs at ${changes(next, line.state).join(", ")}${got ? "" : ", which has not the state's shape or breaks an `always` rule"}`);
    }
    s = next;
  }
}

/** A program that answers each line it is sent, `{}` or `{event, by?}`, with one line `{"state": …}`: the state it is in after it. */
function driver(root: string, command: string) {
  const child = spawn(command, { cwd: root, shell: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.on("error", () => {}); // a driver that has ended is reported by the answer it does not give
  const answers = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ask = async (request: Line): Promise<unknown> => {
    child.stdin.write(`${JSON.stringify(request)}\n`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([answers.next(), new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), ANSWER_WITHIN)))]);
    clearTimeout(timer);
    const fail = (why: string) => { throw new Error(`${why} to ${JSON.stringify(request)}${stderr.trim() ? `; it wrote:\n${stderr.trim()}` : ""}`); };
    if (!answer || answer.done) return fail(answer ? "it ended without an answer" : `it gave no answer within ${ANSWER_WITHIN / 1000} s`);
    try {
      return JSON.parse(answer.value).state;
    } catch {
      return fail(`it answered ${JSON.stringify(answer.value)}, which is not {"state": …},`);
    }
  };
  return { ask, end: () => child.kill() };
}

/**
 * Feed the driver the events of simulated traces, each after a start, and before each one up to REFUSED_PER_STEP
 * later events of the same trace that the spec refuses there; what it answers is a trace of the program.
 */
async function drive(root: string, memory: Memory, domain: any, model: Model, command: string): Promise<string | undefined> {
  const traces = await remembered(memory, entry(root, "simulate", [model.harness, "driven", String(DRIVEN), String(STEPS)]),
    async () => (await simulate(root, model, "inv", DRIVEN, DRIVEN)).traces.map((t) => t.flatMap(({ event }) => (event ? [event as Record<string, unknown>] : []))), () => true);
  const program = driver(root, command);
  try {
    for (const [k, events] of traces.entries()) {
      const lines: Line[] = [{}];
      const start = await program.ask({});
      const started = domain.parseState(start);
      if (!started || !isDeepStrictEqual(model.canon(model.stateType, started), model.canon(model.stateType, domain.initial))) return `trace ${k + 1}: it starts from ${JSON.stringify(start)}, not from \`initial\``;
      let s = domain.initial;
      const request = ({ [SENDER]: by, ...event }: Record<string, unknown>): Line => (model.sender ? { event, by } : { event });
      for (const [i, e] of events.entries()) {
        const refused = events.slice(i + 1).map(request).filter((r) => !domain.enabled(s, r.event, r.by)).slice(0, REFUSED_PER_STEP);
        const next = request(e);
        for (const r of [...refused, next]) lines.push({ ...r, state: await program.ask(r) });
        s = domain.step(s, next.event, next.by);
      }
      const off = departure(domain, model, lines);
      if (off) return `simulated trace ${k + 1}, line ${off.line}: ${off.why}\nwhat the driver was sent, to send it again:\n${indent(lines.slice(0, off.line).map(({ state, ...sent }) => JSON.stringify(sent)).join("\n"), 2)}`;
    }
  } finally {
    program.end();
  }
}

/** The traces stage, one result per trace file and per driver, each as `report` takes it; nothing if there are none. */
export async function conformance(root: string, memory: Memory, machines: Map<string, { domain: any; model: Model }>): Promise<[boolean, "traces", string, string, string][]> {
  const said: [boolean, "traces", string, string, string][] = [];
  const say = (where: string, problem: string | undefined, agrees: string) => said.push([!problem, "traces", problem ? `${where}: the program departs from the spec` : `${where}: ${agrees}`, problem ? indent(problem) : "", where]);
  const machine = (name: string) => machines.get(name) ?? { problem: `there is no spec/${name}.md with an \`initial\` state` };
  const dir = path.join(root, TRACES);
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : []) {
    const m = machine(f.split(".")[0]);
    // A line that is not JSON is kept as its text, which departure reports as not being a line of a trace.
    const lines = fs.readFileSync(path.join(dir, f), "utf8").replace(/\n$/, "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return l; } });
    const off = "domain" in m ? departure(m.domain, m.model, lines) : undefined;
    say(`${TRACES}/${f}`, "problem" in m ? m.problem : off && `${TRACES}/${f}:${off.line}: ${off.why}`, `${lines.length} lines agree with the spec`);
  }
  const manifest = path.join(root, "package.json");
  const scripts: Record<string, string> = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).scripts ?? {} : {};
  for (const [script, command] of Object.entries(scripts).filter(([s]) => s.startsWith("driver:"))) {
    const m = machine(script.slice("driver:".length));
    const problem = "problem" in m ? m.problem : await drive(root, memory, m.domain, m.model, command).catch((e: Error) => `the driver failed: ${e.message}`);
    say(`script ${script}`, problem, `agrees with the spec on ${DRIVEN} simulated traces and on events the spec refuses`);
  }
  return said;
}
