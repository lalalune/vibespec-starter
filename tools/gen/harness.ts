// The Quint module that drives a spec for simulation: one action per transition, per law, and per definition
// whose arguments the simulator can supply.
import type { Law, Param, Roles, Transition } from "./classify.ts";
import { fail, type Json, type Types } from "./types.ts";

/** A definition the simulator evaluates so that its result can be compared with TypeScript's. */
export interface Eval { name: string; params: (Param & { from: "state" | "prev" | "pick" })[]; result: Json }

/** Values the simulator tries for a parameter of each scalar type (the proof covers all values). */
const TRIED: Record<string, string> = { int: "(-1).to(6)", bool: "Set(true, false)", str: 'Set("", "a", "b")' };

export function harness(
  module: string, source: string, imports: string[], funs: Json[], sig: (d: Json) => { params: Param[]; result: Json },
  sampleSets: Set<string>, { stateType, transitions, always, sometimes, steps, laws }: Roles, { fields, resolve, shape, tagged, qType }: Types,
): { text: string; evals: Eval[]; uncompared: string[] } {
  const stateShape = stateType && shape(stateType);
  /** A Quint set of values to try for a parameter. `<param>Values` in the spec overrides the default for its type. */
  const sample = (p: Param): string => {
    if (sampleSets.has(`${p.name}Values`)) return `M::${p.name}Values`;
    const byType = (t0: Json): string => {
      const t = resolve(t0);
      if (t.kind === "sum" && !tagged(t)) return `Set(${fields(t).map((f) => `M::${f.fieldName}`).join(", ")})`;
      if (t.kind === "set") return `${byType(t.elem)}.powerset()`;
      if (t.kind === "list") {
        const of = byType(t.elem);
        return `Set(List()).union(${of}.map(x => List(x))).union(tuples(${of}, ${of}).map(p => List(p._1, p._2)))`;
      }
      return TRIED[t.kind] ?? fail(`parameter ${p.name}: the simulator has no values to try for type ${t.kind}; define \`pure val ${p.name}Values = Set(...)\` in the spec`);
    };
    return byType(p.type);
  };
  const picks = (ps: Param[]) => ps.map((p) => `nondet ${p.name} = ${sample(p)}.oneOf() `).join("");
  const braces = (ps: Param[], inner: string) => (ps.length ? `{ ${picks(ps)}${inner} }` : inner);

  // Every definition whose arguments the simulator can supply is evaluated during simulation, on reachable states
  // and sampled values, so that TypeScript's result can be compared with Quint's. This is the main test of the
  // translation: it covers helpers, guards and rules, not just the states that events lead to.
  const uncompared: string[] = [];
  const evals: Eval[] = funs.flatMap((d): Eval[] => {
    try {
      const { params, result } = sig(d);
      const onStates = params.filter((p) => shape(p.type) === stateShape).length;
      if (onStates > 2) return [];
      let seen = 0;
      const sources = params.map((p) => {
        if (stateType && shape(p.type) === stateShape) return onStates === 2 && seen++ === 0 ? "prev" as const : "state" as const;
        sample(p);
        return "pick" as const;
      });
      qType(result);
      return [{ name: d.name, params: params.map((p, i) => ({ ...p, from: sources[i] })), result }];
    } catch {
      uncompared.push(d.name); // its arguments cannot be sampled, or its result has no name: it is compared only where events use it
      return [];
    }
  });

  // Harness variables: the state, the state before the last event, whether an event has happened, whether the
  // last law tried held, and the result of the last definition evaluated.
  const vars = [...(stateType ? ["state", "prev", "moved"] : []), "lawsHold", ...(evals.length ? ["out"] : [])];
  /** An action body: the given conditions and assignments, with every other variable left as it is. */
  const frame = (conditions: string[], set: Record<string, string>) =>
    `all { ${[...conditions, ...vars.map((v) => `${v}' = ${set[v] ?? v}`)].join(", ")} }`;
  const argsOf = (t: Transition) => ["state", ...t.params.map((p) => p.name)].join(", ");
  const action = (t: Transition) =>
    `  action ${t.name} = ${braces(t.params, frame(t.guard ? [`M::${t.guard}(${argsOf(t)})`] : [], { state: `M::${t.name}(${argsOf(t)})`, prev: "state", moved: "true" }))}`;
  const lawAction = (l: Law) =>
    `  action ${l.name} = ${braces(l.params, frame([], { lawsHold: `M::${l.name}(${l.params.map((p) => p.name).join(", ")})` }))}`;
  const evalAction = (v: Eval) => {
    const args = v.params.map((p) => (p.from === "pick" ? p.name : p.from)).join(", ");
    // A transition is only evaluated where its guard allows it, as it would be in use.
    const guard = transitions.find((t) => t.name === v.name)?.guard;
    return `  action eval_${v.name} = ${braces(v.params.filter((p) => p.from === "pick"), frame(guard ? [`M::${guard}(${args})`] : [], { out: `Out_${v.name}(M::${v.name}(${args}))` }))}`;
  };
  const events = [...transitions.map((t) => t.name), ...laws.map((l) => l.name)];
  const any = (actions: string[]) => `any { ${(actions.length ? actions : [frame([], {})]).join(", ")} }`;
  const text = [
    `// GENERATED from ${source}. Drives the spec's transitions, laws and definitions for simulation.`,
    `module ${module}_run {`,
    `  import ${module} as M from "./${module}"`,
    ...imports.map((i) => `  import ${i} as D_${i} from "./${i}"`),
    ...(evals.length ? [`  type Out = Nothing | ${evals.map((v) => `Out_${v.name}(${qType(v.result)})`).join(" | ")}`, `  var out: Out`] : []),
    ...(stateType ? [`  var state: ${qType(stateType)}`, `  var prev: ${qType(stateType)}`, `  var moved: bool`] : []),
    `  var lawsHold: bool`,
    `  action init = ${frame([], { state: "M::initial", prev: "M::initial", moved: "false", lawsHold: "true", out: "Nothing" })}`,
    ...transitions.map(action),
    ...laws.map(lawAction),
    ...evals.map(evalAction),
    `  action step = ${any(events)}`,
    // Half events, half evaluations, so that definitions are evaluated on states well into a trace and not just near its start.
    `  action probe = ${events.length && evals.length ? `any { step, ${any(evals.map((v) => `eval_${v.name}`))} }` : any([...events, ...evals.map((v) => `eval_${v.name}`)])}`,
    `  val inv = and { lawsHold, ${[...always.map((a) => `M::${a}(state)`), ...steps.map((r) => `(not(moved) or M::${r}(prev, state))`), "true"].join(", ")} }`,
    ...sometimes.map((w) => `  val never_${w} = not(M::${w}(state))`),
    // A guard's witnesses, for the `probe` step: breaking `never_allows_X` shows a reachable state and values for
    // which X allows its event, breaking `never_refuses_X` one for which it refuses it. Each reads the result the
    // last evaluation recorded, so a state costs the same however many values a parameter could take.
    ...transitions.flatMap((t) => (t.guard && evals.some((v) => v.name === t.guard) ? [
      `  val never_allows_${t.guard} = match out { | Out_${t.guard}(r) => not(r) | _ => true }`,
      `  val never_refuses_${t.guard} = match out { | Out_${t.guard}(r) => r | _ => true }`,
    ] : [])),
    `}`,
    ``,
  ].join("\n");
  return { text, evals, uncompared };
}
