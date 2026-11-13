// The simulation stages of one spec: Quint simulates the harness (gen/harness.ts), every trace is checked against the
// rules, `sometimes` goals and guards are searched for, and the generated TypeScript must agree with Quint on all of
// it (README, "What `npm run check` does").

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Model } from "./gen.ts";
import { SENDER } from "./gen/classify.ts";
import { digest, indent, runAsync, type Result } from "./util.ts";

const STEPS = 20; // events per trace
/** Trace lengths a search for something reachable tries in turn, the longer ones only if the shorter found nothing. */
const DEPTHS = [STEPS, 2 * STEPS, 5 * STEPS];

/** How much is simulated. SPEC_QUICK=1 simulates a tenth as much, for iterating; `accept` never does (spec.ts). */
export interface Budget {
  quick: boolean;
  /** Simulated traces per check. */
  samples: number;
  /** Traces tried when looking for a state a `sometimes` rule says is reachable. */
  witness: number;
  /** Traces simulated with definitions evaluated along the way. */
  compared: number;
  /** Traces of each kind replayed through the generated TypeScript. */
  replayed: number;
}
export function budget(quick: boolean): Budget {
  const [samples, compared, replayed] = quick ? [1000, 200, 50] : [10000, 2000, 200];
  return { quick, samples, witness: 20 * samples, compared, replayed };
}
/** Everything about a budget that changes what is simulated, for a cache key. */
export const budgetKey = (b: Budget) => String([b.samples, b.witness, b.compared, b.replayed, STEPS]);

/** One state of a simulated trace, and what led to it. */
export interface Step {
  event?: { type: string };
  law?: { name: string; args: Record<string, unknown> };
  /** A definition the simulator evaluated: what was picked for its sampled parameters, and what Quint got. */
  evaluated?: { name: string; picks: Record<string, unknown>; result: unknown };
  state?: unknown;
  lawsHold?: boolean;
}

function readTrace(file: string, model: Model): Step[] {
  return JSON.parse(fs.readFileSync(file, "utf8")).states.map((st: any): Step => {
    // Values are decoded by their type, and sets put in a fixed order, so that they compare equal to TypeScript's.
    const read = (type: any, itf: any) => model.canon(type, model.decode(type, itf));
    const picked = (ps: { name: string; type: any }[]) => Object.fromEntries(ps.map((p) => [p.name, read(p.type, st["mbt::nondetPicks"][p.name].value)]));
    const taken: string = st["mbt::actionTaken"];
    const t = model.transitions.find((t) => t.name === taken);
    const v = model.evals.find((v) => `eval_${v.name}` === taken);
    const l = model.laws.find((l) => l.name === taken);
    return {
      event: t && { type: t.name, ...picked(t.params) },
      evaluated: v && { name: v.name, picks: picked(v.params.filter((p) => p.from === "pick")), result: read(v.result, st.out.value) },
      law: l && { name: l.name, args: picked(l.params) },
      state: model.stateType ? read(model.stateType, st.state) : undefined,
      lawsHold: st.lawsHold,
    };
  });
}

/**
 * The simulator's seed: SPEC_SEED if it is set, otherwise one derived from what is simulated, so that the same
 * harness always gives the same traces and a counterexample can be had again.
 */
const seedFor = (...what: string[]) => process.env.SPEC_SEED?.trim() || String(parseInt(digest(what.join("\0")).slice(0, 12), 16));

type Run = { broken: boolean; traces: Step[][]; again: string };

/**
 * Simulate the harness until `invariant` breaks; returns the traces Quint wrote, and the command that runs the same
 * simulation again.
 */
async function simulate(root: string, model: Model, invariant: string, traces: number, samples: number, step = "step", steps = STEPS): Promise<Run> {
  const dir = path.join(root, "gen/traces", `${model.name}.${invariant}.${step}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const seed = seedFor(model.harness, invariant, step, String(samples), String(steps));
  const args = ["run", `gen/${model.name}.run.qnt`, "--main", `${model.name}_run`, "--step", step, "--invariant", invariant,
    "--max-samples", String(samples), "--max-steps", String(steps), "--mbt", "--seed", seed];
  const r = await runAsync("quint", [...args, "--n-traces", String(traces), "--out-itf", path.join(dir, "{seq}.itf.json")], root);
  const broken = r.out.includes("[violation]");
  const files = fs.readdirSync(dir);
  const again = `seed ${seed}; to simulate again: npx quint ${args.join(" ")}`;
  // Anything other than "held" or "violated", each with a trace, is Quint failing to run.
  if ((!r.ok && !broken) || !files.length) throw new Error(`quint run did not complete (${again}):\n${r.out.trim()}`);
  return { broken, traces: files.map((f) => readTrace(path.join(dir, f), model)), again };
}

/**
 * Look for a state that breaks `invariant`, which is how a goal is shown reachable: in longer traces while none is
 * found, fewer of them as they lengthen, so each depth costs about as many events as the first.
 */
async function search(root: string, model: Model, invariant: string, witness: number, step = "step", depths = DEPTHS): Promise<Run> {
  let run!: Run;
  for (const steps of depths) if ((run = await simulate(root, model, invariant, 1, Math.ceil(witness * STEPS / steps), step, steps)).broken) break;
  return run;
}

/**
 * Replay one Quint trace through the TypeScript domain; throws at the first difference. With the model, sets are
 * compared whatever their order and every definition the simulator evaluated is evaluated here too.
 */
export function replay(domain: any, trace: Step[], model?: Model) {
  const differ = (what: string) => new Error(`TypeScript and Quint disagree ${what}`);
  const canon = (type: any, value: unknown) => (model ? model.canon(type, value) : value);
  let s = domain.initial;
  let before = s;
  for (const { event, evaluated, law, state, lawsHold } of trace) {
    if (event) {
      // Who sent the event travels beside it, as the program passes it (gen/typescript.ts).
      const { [SENDER]: by, ...carried } = event as Record<string, unknown>;
      if (!domain.enabled(s, carried, by)) throw differ(`on whether ${JSON.stringify(event)} is allowed in ${JSON.stringify(s)}`);
      [before, s] = [s, domain.step(s, carried, by)];
    } else if (evaluated && model) {
      const v = model.evals.find((v) => v.name === evaluated.name)!;
      const args = v.params.map((p) => (p.from === "state" ? s : p.from === "prev" ? before : evaluated.picks[p.name]));
      const got = canon(v.result, domain[v.name](...args));
      if (!isDeepStrictEqual(got, evaluated.result)) throw differ(`on ${v.name}(${args.map((a) => JSON.stringify(a)).join(", ")}): TypeScript gives ${JSON.stringify(got)}, Quint gives ${JSON.stringify(evaluated.result)}`);
    } else if (law && domain[law.name](...Object.values(law.args)) !== lawsHold)
      throw differ(`on ${law.name}${JSON.stringify(law.args)}: Quint says ${lawsHold}`);
    if (state !== undefined && !isDeepStrictEqual(canon(model?.stateType, s), state)) throw differ(`after ${JSON.stringify(event ?? "init")}: TypeScript reached ${JSON.stringify(s)}, Quint reached ${JSON.stringify(state)}`);
  }
}

/** The first rule a trace breaks, in the spec's words, and how many steps it took; undefined if it breaks none. */
function firstBreak(domain: any, model: Model, trace: Step[], cite: (def: string) => string): { why: string; steps: number } | undefined {
  let before: unknown;
  for (const [i, { event, law, state, lawsHold }] of trace.entries()) {
    const found = (why: string) => ({ why, steps: i + 1 });
    if (law && lawsHold === false) return found(`the law ${cite(law.name)} is false for ${JSON.stringify(law.args)}`);
    const always = model.always.filter((a) => !domain[a](state)).map(cite);
    if (always.length) return found(`a reachable state breaks ${always.join(", ")}`);
    const steps = event ? model.steps.filter((r) => !domain[r.name](before, ...(r.via ? [event.type] : []), state)).map((r) => cite(r.name)) : [];
    if (steps.length) return found(`a step breaks ${steps.join(", ")}`);
    before = state;
  }
}

/**
 * What differs between two values, as `path = value` for each part that changed. Records and maps are compared
 * entry by entry; a variant whose tag changed, a list or a scalar is shown whole.
 */
const changes = (a: any, b: any, at = ""): string[] =>
  isDeepStrictEqual(a, b) ? []
  : b === undefined ? [`${at} removed`]
  : [a, b].every((x) => x && typeof x === "object" && !Array.isArray(x)) && a.tag === b.tag
    ? [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => changes(a[k], b[k], at ? `${at}.${k}` : k))
    : [`${at || "state"} = ${JSON.stringify(b)}`];

/** A trace as the initial state, then each event with only what it changed. */
const showTrace = (trace: Step[]) =>
  trace.filter((s, i) => i === 0 || s.event || s.lawsHold === false).map(({ event, law, state, lawsHold }, i, shown) => {
    const { type, ...args } = event ?? { type: "" };
    const what = event ? type + (Object.keys(args).length ? JSON.stringify(args) : "") : law ? `${law.name}${JSON.stringify(law.args)}` : "initial";
    const result = law && !event ? String(lawsHold) : i ? changes(shown[i - 1].state, state).join(", ") || "no change" : JSON.stringify(state);
    return `      ${what.padEnd(30)} -> ${result}`;
  }).join("\n");

/**
 * The always, sometimes and replay stages of one spec, whose generated module is loaded as `domain`; `cite` names a
 * definition by the rule it is in. What they found, in order; a failure ends the stages early.
 */
export async function simulateSpec(root: string, model: Model, domain: any, cite: (def: string) => string, b: Budget): Promise<Result[]> {
  const said: Result[] = [];
  const say = (ok: boolean, stage: Result["stage"], summary: string, detail = "") => said.push({ ok, stage, summary, detail });
  const searched = `${b.witness} traces of ${STEPS} events and longer ones up to ${DEPTHS.at(-1)}`;
  try {
    /**
     * Report the shortest trace of these runs that breaks a rule, cut at the break, with the command that runs
     * the simulation it came from again; false if none breaks one.
     */
    const broke = (runs: Run[]): boolean => {
      const bad = runs.flatMap((run) => run.traces.flatMap((t) => { const f = firstBreak(domain, model, t, cite); return f ? [{ t: t.slice(0, f.steps), why: f.why, again: run.again }] : []; }))
        .sort((x, y) => x.t.length - y.t.length)[0];
      if (!bad) return false;
      const lastEvent = bad.t.findLast((s) => s.event)?.event?.type;
      const guard = model.transitions.find((t) => t.name === lastEvent)?.guard;
      // One repair is always available: refuse the event when its result would break the rule. A reason is better.
      const brokenRule = lastEvent ? model.always.find((a) => !domain[a](bad.t[bad.t.length - 1].state)) : undefined;
      const hint = lastEvent && !bad.why.startsWith("the law") ? `\n      the last event is ${cite(lastEvent)}${guard ? `; its guard ${guard} let it through` : "; it has no guard"}`
        + (brokenRule ? `\n      if no better reason can be found: refuse ${lastEvent} when its result would break ${brokenRule}` : "") : "";
      say(false, "always", `${bad.why}: fix the model, or add the rule that forbids this trace`, `${showTrace(bad.t)}${hint}\n      ${bad.again}`);
      return true;
    };
    // The first run goes alone: Quint installs its evaluator on first use, and runs started together would race to.
    // The rest are independent and overlap. The probe, in which the simulator also evaluates every definition it
    // can, supplies more traces to replay. Each witness search stops at its goal or at a broken rule, whichever
    // comes first (see the harness). All of them finish before anything is reported, failures included.
    const sim = await simulate(root, model, "inv", b.replayed, b.samples);
    const settled = await Promise.allSettled([
      simulate(root, model, "inv", b.replayed, b.compared, "probe"),
      ...model.sometimes.map((w) => search(root, model, `never_${w}`, b.witness)),
    ]);
    const failure = settled.find((r) => r.status === "rejected");
    if (failure) throw failure.reason;
    const [probe, ...searches] = settled.map((r) => (r as PromiseFulfilledResult<Run>).value);
    const witnesses = model.sometimes.map((w, i) => ({ w, run: searches[i] }));
    const runs = [sim, probe, ...searches.filter((run) => run.broken)];
    if (broke(runs)) return said;
    if (sim.broken || probe.broken) throw new Error(`the simulator reports a broken rule that no trace shows (${sim.again})`);
    const traces = runs.flatMap((run) => run.traces);
    // Each guard should allow its event in some reachable state and refuse it in another. One that never allows it
    // makes the event impossible, and every rule then holds of it trivially, so nothing else would notice: that
    // fails, as an unreached `sometimes` goal does. One that never refuses it may restate a rule, guard against
    // input from outside, or refuse only beyond the simulator's reach: that is reported, not failed.
    // The traces so far usually show both sides; the simulator searches only for what they do not, and each such
    // search also stops at a broken rule (see the harness), which is then reported as any other.
    const guarded = model.transitions.filter((t) => t.guard);
    const seen = new Map(guarded.map((t) => [t.guard!, { allows: false, refuses: false }]));
    for (const { event, evaluated } of traces.flat()) {
      const fired = event && guarded.find((g) => g.name === event.type);
      if (fired) seen.get(fired.guard!)!.allows = true;
      if (evaluated && seen.has(evaluated.name)) seen.get(evaluated.name)![evaluated.result ? "allows" : "refuses"] = true;
    }
    const neverAllowed: { t: (typeof guarded)[number]; again?: string }[] = [];
    const neverRefused: string[] = [];
    for (const t of guarded) {
      const g = t.guard!;
      // The harness has a witness invariant for every guard whose arguments the simulator can supply. Only a
      // guard that never allows its event fails the check, so only that search goes deeper.
      const searchable = model.evals.some((v) => v.name === g);
      for (const side of ["allows", "refuses"] as const) {
        if (seen.get(g)![side]) continue;
        const found = searchable ? await search(root, model, `never_${side}_${g}`, b.witness, "probe", side === "allows" ? DEPTHS : [STEPS]) : undefined;
        if (found?.broken) {
          if (broke([found])) return said;
          seen.get(g)![side] = true;
          traces.push(...found.traces);
        } else if (side === "refuses") neverRefused.push(g);
        else neverAllowed.push({ t, again: found?.again });
      }
    }
    say(true, "always", `no rule broken in ${b.samples + b.compared} simulated traces${b.quick ? " (SPEC_QUICK: a tenth of a full check; `npm run accept` simulates in full)" : ""}`);
    for (const { w, run } of witnesses) {
      const reached = run.broken && run.traces.some((t) => domain[w](t.at(-1)?.state));
      say(reached, "sometimes", reached ? `${w} is reachable`
        : `${cite(w)} was not reached in ${searched}: a guard is too strict, a transition is missing, or the goal needs values the simulator does not try`, reached ? "" : `      ${run.again}`);
    }
    for (const { t, again } of neverAllowed) {
      const causes = ["the guard is too strict", "a transition that leads to the states it needs is missing", `the event becomes possible only after more than ${DEPTHS.at(-1)} events`,
        ...(t.guardParams.length ? [`it needs values the simulator does not try (define ${t.guardParams.map((p) => `${p}Values`).join(" or ")})`] : [])];
      say(false, "sometimes", `${t.name} in ${cite(t.name)} never happened: its guard ${t.guard} refused it in every state reached${again ? ` in ${searched}` : ""}, so every rule holds of it trivially. Either ${causes.slice(0, -1).join(", ")} or ${causes.at(-1)}`, again ? `      ${again}` : "");
    }
    if (guarded.some((t) => seen.get(t.guard!)!.allows))
      say(true, "sometimes", `${guarded.filter((t) => seen.get(t.guard!)!.allows).length} of ${guarded.length} guards allow their event in some reachable state`
        + (neverRefused.length ? `; never seen to refuse it within ${STEPS} events or for any value tried, so check that each restricts what its rule says: ${neverRefused.join(", ")}` : ", and refuse it in another"));
    for (const t of traces) replay(domain, t, model);
    const compared = new Set(traces.flatMap((t) => t.flatMap((s) => (s.evaluated ? [s.evaluated.name] : []))));
    const missed = [...model.evals.map((v) => v.name).filter((n) => !compared.has(n)), ...model.uncompared];
    say(true, "replay", `generated TypeScript agrees with Quint on ${traces.length} traces: every state${model.laws.length ? ", every law" : ""}, and ${compared.size} definitions evaluated on them`
      + (missed.length ? `; not compared on their own, because the simulator had no arguments for them: ${missed.join(", ")}` : ""));
  } catch (e) {
    const mismatch = (e as Error).message.startsWith("TypeScript and Quint disagree");
    say(false, mismatch ? "replay" : "always", mismatch ? "this is a bug in the generator (tools/gen.ts, tools/gen/), not in the spec" : "the simulator could not run", indent((e as Error).message));
  }
  return said;
}
