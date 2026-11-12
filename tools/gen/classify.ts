// What each definition of a spec is, read off its name and its signature.
import { fail, type Json, type Types } from "./types.ts";

export interface Param { name: string; type: Json }
export interface Transition { name: string; params: Param[]; guard: string | undefined }
export interface Law { name: string; params: Param[] }
export interface Roles {
  /** The type of `initial`; undefined for a library, which has definitions and laws but no state machine. */
  stateType: Json | undefined;
  transitions: Transition[];
  always: string[];
  sometimes: string[];
  steps: string[];
  laws: Law[];
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * `funs` are the spec's `pure def`s in the order it gives them; `sig` gives a definition's parameters and result.
 * The convention: `initial` is the state; a definition from the state to the state is a transition and `can<Name>`
 * its guard; `alwaysX(state)`, `stepX(before, after)` and `sometimesX(state)` are rules; `lawX(...)` is a law.
 */
export function classify(funs: Json[], stateType: Json | undefined, sig: (d: Json) => { params: Param[]; result: Json }, { shape }: Types): Roles {
  const stateShape = stateType && shape(stateType);
  const onState = (d: Json, at = 0) => sig(d).params.length > at && shape(sig(d).params[at].type) === stateShape;
  const isBool = (d: Json) => sig(d).result.kind === "bool";
  // A rule whose name is nearly right would otherwise be an unchecked helper.
  for (const d of funs) {
    const role = d.name.match(/^(always|sometimes|step|law|can)/i)?.[1].toLowerCase();
    if (role && role !== "can" && !new RegExp(`^${role}[A-Z]`).test(d.name) && d.name.toLowerCase() !== role) fail(`${d.name}: write \`${role}\` rules as ${role}Something`);
    if (/^Can[A-Z]/.test(d.name)) fail(`${d.name}: write guards as can${d.name.slice(3)}`);
  }
  const named = (prefix: string) => funs.filter((d) => new RegExp(`^${prefix}[A-Z]`).test(d.name));
  const stateRule = (prefix: string, arity: number): string[] => named(prefix).map((d) => {
    if (!stateType) fail(`${d.name}: \`${prefix}\` rules need a state, so the spec must define \`pure val initial\``);
    const ok = isBool(d) && sig(d).params.length === arity && sig(d).params.every((_, i) => onState(d, i));
    return ok ? d.name : fail(`${d.name}: a \`${prefix}\` rule takes ${arity === 1 ? "the state" : "the state before and the state after"} and returns bool`);
  });
  const always = stateRule("always", 1);
  const sometimes = stateRule("sometimes", 1);
  const steps = stateRule("step", 2);
  const laws: Law[] = named("law").map((d) => (isBool(d) ? { name: d.name, params: sig(d).params } : fail(`${d.name}: a law returns bool`)));
  const rules = new Set([...always, ...sometimes, ...steps, ...laws.map((l) => l.name)]);
  const transitions: Transition[] = !stateType ? [] : funs
    .filter((d) => !rules.has(d.name) && onState(d) && shape(sig(d).result) === stateShape)
    .map((d) => {
      const guard = funs.find((g) => g.name === `can${cap(d.name)}`);
      const spelled = (x: Json) => sig(x).params.map((p) => p.name + shape(p.type)).join();
      if (guard && spelled(guard) !== spelled(d)) fail(`${guard.name} must take the same parameters as ${d.name}`);
      if (guard && !isBool(guard)) fail(`${guard.name}: a guard returns bool`);
      return { name: d.name, params: sig(d).params.slice(1), guard: guard?.name };
    });
  // In a library, `withdraw` and `canWithdraw` are a component's functions for a machine elsewhere to build on.
  for (const g of stateType ? funs.filter((d) => /^can[A-Z]/.test(d.name)) : [])
    if (!transitions.some((t) => t.guard === g.name)) fail(`${g.name}: no transition named ${g.name[3].toLowerCase()}${g.name.slice(4)}`);
  return { stateType, transitions, always, sometimes, steps, laws };
}
