// Conformance adapters: generated test helpers and real JSONL/program traces share conformance.ts.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { compareObservation, departure, transition, type Found, type Line, type Oracle, type Sent } from "./conformance.ts";
import type { Model } from "./gen.ts";
import type { Spec } from "./parse.ts";
import type { Step } from "./simulate.ts";
import { indent } from "./util.ts";

/** What `driver:` scripts replay besides the journeys: the simulator's own traces, kept out of the generated Found. */
export interface Tested { found: Found<any>; traces: Sent<any>[][] }
export interface Machine extends Tested { domain: Oracle<any, any>; model: Model }
type Reported = [ok: boolean, stage: "traces", summary: string, detail: string, where: string];

const header = (model: Model) => ({ spec: model.name, source: model.source, sender: !!model.sender, shape: model.shape!, outputShape: model.outputShape });
const eventsOf = (trace: Step[]) => trace.flatMap((step) => step.event ? [step.event] : []);

/** The events and witnessed journeys already examined by the simulator. */
export function conformanceFound(model: Model, spec: Spec, traces: Step[][], witnesses: { w: string; trace: Step[] }[]): Tested {
  const events = new Map<string, any>();
  for (const { event } of traces.flat()) if (event) events.set(JSON.stringify(event), event);
  for (const { evaluated } of traces.flat()) {
    if (!evaluated) continue;
    const transition = model.transitions.find((t) => t.guard === evaluated.name);
    const sample = [...events.values()].find((event) => event.type === transition?.name);
    if (transition && sample) {
      const event = { ...sample, ...evaluated.picks };
      events.set(JSON.stringify(event), event);
    }
  }
  return {
    found: {
      ...header(model),
      events: [...events.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      journeys: witnesses.map(({ w, trace }) => {
        const { story, key } = spec.rules.find((rule) => rule.defs.includes(w))!;
        return { story, rule: key.slice(story.length + 3), events: eventsOf(trace) };
      }),
    },
    traces: traces.slice(0, 100).map(eventsOf),
  };
}

/** Write the typed helper before typechecking, then fill it with simulation results before running tests. */
export function writeConformance(root: string, model: Model, found?: Found<any>) {
  if (!model.stateType || !model.transitions.length) return;
  const dir = path.join(root, "gen");
  fs.copyFileSync(path.join(import.meta.dirname, "conformance.ts"), path.join(dir, "_conformance.ts"));
  const data: Found<any> = found ?? { ...header(model), events: [], journeys: [] };
  fs.writeFileSync(path.join(dir, `${model.name}.conformance.ts`), [
    `// Generated from ${model.source}; do not edit.`,
    `import * as oracle from "./${model.name}.ts";`,
    `import { check, type Driver, type Found, type Options } from "./_conformance.ts";`,
    `type State = typeof oracle.initial;`,
    `type Event = Parameters<typeof oracle.step>[1];`,
    `export const found: Found<Event> = ${JSON.stringify(data)};`,
    `export const conformance = <V = State>(driver: Driver<Event, V>, options?: Options<State, V>) => check(oracle, found, driver, options);`,
    "",
  ].join("\n"));
}

const TRACES = "test/traces";
const ANSWER_WITHIN = 10_000;

/** A real program, one JSON answer for each reset/event request. */
function driver(root: string, command: string) {
  const child = spawn(command, { cwd: root, shell: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let launchError: Error | undefined;
  child.on("error", (error) => { launchError = error; });
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-65_536); });
  child.stdin.on("error", () => {});
  const lines = readline.createInterface({ input: child.stdout });
  const answers = lines[Symbol.asyncIterator]();
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  const ask = async (request: Line): Promise<Pick<Line, "state" | "out">> => {
    if (launchError) throw launchError;
    child.stdin.write(`${JSON.stringify(request)}\n`);
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([answers.next(), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ANSWER_WITHIN); })]);
    clearTimeout(timer);
    const fail = (message: string): never => { throw new Error(`${message} to ${JSON.stringify(request)}${stderr ? `; stderr: ${stderr}` : ""}`); };
    if (!answer || answer.done) return fail((launchError as Error | undefined)?.message ?? (answer ? "the driver ended without an answer" : "the driver did not answer within 10 seconds"));
    let value: any;
    try { value = JSON.parse(answer.value); } catch { return fail("the driver did not answer with JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "state") || Object.keys(value).some((key) => key !== "state" && key !== "out"))
      return fail("the driver must answer with {state: ..., out?: ...}");
    return value;
  };
  const stop = (signal: NodeJS.Signals) => {
    try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
  };
  return { ask, end: async () => { lines.close(); stop("SIGTERM"); const timer = setTimeout(() => stop("SIGKILL"), 1000); await closed; clearTimeout(timer); } };
}

async function drive(root: string, machine: Machine, command: string): Promise<string | undefined> {
  const { domain, model, found } = machine;
  // Journeys first, as `check` in conformance.ts runs them; `departure` needs an event in each trace.
  const traces = [...found.journeys.map((journey) => journey.events), ...machine.traces].filter((events) => events.length);
  if (!traces.length) return "the simulator produced no traces for this driver";
  const request = ({ by, ...event }: any): Line => model.sender ? { event, by } : { event };
  const program = driver(root, command);
  try {
    for (const [n, events] of traces.entries()) {
      const initial = await program.ask({});
      const lines: Line[] = [{ state: initial.state }];
      const resetProblem = compareObservation(domain, found, domain.initial, initial.state);
      if (resetProblem) return `trace ${n + 1}: reset ${resetProblem}`;
      let current = domain.initial;
      for (const sent of events) {
        const next = request(sent);
        const refused = found.events.map(request).filter((line) => !domain.enabled(current, line.event, line.by)).slice(0, 2);
        for (const input of [...refused, next]) lines.push({ ...input, ...await program.ask(input) });
        const applied = transition(domain, found, current, next.event, next.by);
        if (typeof applied === "string") return applied;
        current = applied.after;
      }
      const off = departure(domain, found, lines);
      if (off) return `trace ${n + 1}, line ${off.line}: ${off.why}\n${lines.map((line) => JSON.stringify(line)).join("\n")}`;
    }
  } finally { await program.end(); }
}

/** Every configured trace and program is run afresh; outside service state is not part of a source-code cache key. */
export async function conformance(root: string, machines: Map<string, Machine>): Promise<Reported[]> {
  const results: Reported[] = [];
  const add = (where: string, problem: string | undefined, summary: string) => results.push([!problem, "traces", problem ? `${where}: the program departs from the spec` : `${where}: ${summary}`, problem ? indent(problem) : "", where]);
  const dir = path.join(root, TRACES);
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort() : []) {
    const machine = machines.get(file.split(".")[0]);
    const lines = fs.readFileSync(path.join(dir, file), "utf8").trimEnd().split("\n").map((line) => { try { return JSON.parse(line); } catch { return line; } });
    const off = machine && departure(machine.domain, machine.found, lines);
    add(`${TRACES}/${file}`, machine ? off && `line ${off.line}: ${off.why}` : "no state-machine spec has this name", `${lines.length} recorded lines agree with ${machine?.model.source}${machine?.found.outputShape ? "; effects checked where out is reported" : ""}`);
  }
  const manifest = path.join(root, "package.json");
  const scripts = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).scripts ?? {} : {};
  for (const [name, command] of Object.entries(scripts).filter(([name]) => name.startsWith("driver:"))) {
    const machine = machines.get(name.slice("driver:".length));
    const problem = machine && typeof command === "string" ? await drive(root, machine, command).catch((error: Error) => error.message) : "no state-machine spec has this name, or its driver is not a command";
    add(`script ${name}`, problem, `simulated states and refused events agree with ${machine?.model.source}${machine?.found.outputShape ? "; effects checked where out is reported" : ""}`);
  }
  return results;
}
