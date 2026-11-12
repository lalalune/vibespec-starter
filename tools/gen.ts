// Quint IR -> TypeScript. Reads the JSON that `quint typecheck --out` writes for a
// pure module and emits one TypeScript module annotated for LemmaScript, plus a
// Quint harness module that drives the same transitions for simulation.
//
// The supported Quint subset is deliberately small; anything outside it throws
// with the name of the construct, so a spec can never be silently mistranslated.

type Json = any;

export interface Param { name: string; type: Json }
export interface Transition { name: string; params: Param[]; guard: string | undefined }
export interface Model {
  state: string;
  transitions: Transition[];
  always: string[];
  sometimes: string[];
  ts: string;
  harness: string;
}

/** Where a definition came from in the spec, for doc comments and ordering. */
export interface Origin { rule: string; line: number }

// Operator precedence, loosest first. Mixed `&&`/`||` is always parenthesised.
const [TERNARY, OR, AND, EQ, COMPARE, ADD, MULTIPLY, UNARY, ATOM] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const BINARY: Record<string, [string, number]> = {
  iadd: ["+", ADD], isub: ["-", ADD], imul: ["*", MULTIPLY],
  ilt: ["<", COMPARE], ilte: ["<=", COMPARE], igt: [">", COMPARE], igte: [">=", COMPARE],
  eq: ["===", EQ], neq: ["!==", EQ],
};
const RESERVED = ["init", "step", "inv", "enabled", "isEvent", "Event", "initialHolds"];
/** Values the simulator tries for each event parameter (the proof covers all values). */
const SAMPLES: Record<string, string> = { int: "(-1).to(6)", bool: "Set(true, false)", str: 'Set("", "a", "b")' };
// Words that cannot be used as names in the generated TypeScript or its harness.
const JS_WORDS = "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await state".split(" ");

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const fail = (msg: string): never => { throw new Error(msg); };

export function generate(ir: Json, name: string, source: string, origin: (def: string) => Origin | undefined): Model {
  const decls: Json[] = ir.modules[0].declarations;
  const typedefs = decls.filter((d) => d.kind === "typedef");
  const variants = new Set<string>();
  for (const t of typedefs) if (t.type.kind === "sum") for (const f of t.type.fields.fields) variants.add(f.fieldName);
  const defs = decls.filter((d) => d.kind !== "typedef" && !variants.has(d.name));
  for (const d of defs) {
    if (d.qualifier !== "puredef" && d.qualifier !== "pureval")
      fail(`${d.name}: only types, \`pure val\` and \`pure def\` belong in a spec (state and actions are generated)`);
    if (RESERVED.includes(d.name)) fail(`${d.name}: this name is reserved for generated code`);
  }
  /** A name the spec binds (definition, parameter or local `val`) must survive translation unchanged. */
  const bind = (n: string): string =>
    JS_WORDS.includes(n) ? fail(`\`${n}\` cannot be used as a name: it is a word in TypeScript or in the generated harness`)
    : variants.has(n) ? fail(`\`${n}\` is a variant of a type and cannot also name a parameter or value`) : n;
  defs.forEach((d) => bind(d.name));
  const defNames = new Set(defs.map((d) => d.name));

  // --- types ---------------------------------------------------------------
  const fields = (t: Json): Json[] => t.fields.fields;
  const resolve = (t: Json): Json =>
    t.kind === "const" ? resolve(typedefs.find((d) => d.name === t.name)?.type ?? fail(`unknown type ${t.name}`)) : t;
  /** Structural identity, so inferred types can be matched back to their names. */
  const shape = (t0: Json): string => {
    const t = resolve(t0);
    if (t.kind === "rec") return `{${fields(t).map((f) => `${f.fieldName}:${shape(f.fieldType)}`).sort()}}`;
    if (t.kind === "sum") return `<${fields(t).map((f) => f.fieldName).sort()}>`;
    return t.kind;
  };
  const PRIMITIVE: Record<string, string> = { int: "number", bool: "boolean", str: "string" };
  const tsType = (t: Json): string => {
    if (t.kind === "const") return t.name;
    if (PRIMITIVE[t.kind]) return PRIMITIVE[t.kind];
    const named = typedefs.find((d) => shape(d.type) === shape(t));
    return named ? named.name : fail(`unsupported type ${t.kind}: name it with \`type\`, or extend tsType in tools/gen.ts`);
  };
  const typeOf = (id: number): Json => ir.types[id]?.type ?? fail(`no inferred type for expression ${id}`);
  const isScalar = (t: Json) => resolve(t).kind !== "rec";

  const emitTypedef = (d: Json): string => {
    const t = d.type;
    if (t.kind === "sum") {
      for (const f of fields(t))
        if (fields(f.fieldType).length) fail(`${d.name}.${f.fieldName}: variants with payloads are not supported yet`);
      return `export type ${d.name} = ${fields(t).map((f) => JSON.stringify(f.fieldName)).join(" | ")};`;
    }
    if (t.kind === "rec")
      return `export interface ${d.name} { ${fields(t).map((f) => `${f.fieldName}: ${tsType(f.fieldType)}`).join("; ")} }`;
    return `export type ${d.name} = ${tsType(t)};`;
  };

  // --- expressions ---------------------------------------------------------
  // `ex(e, min)` prints `e`, parenthesised only if it binds looser than `min`.
  const flat = (e: Json, op: string): Json[] => (e.kind === "app" && e.opcode === op ? e.args.flatMap((x: Json) => flat(x, op)) : [e]);
  const ex = (e: Json, min = 0): string => {
    const [text, prec] = print(e);
    return prec < min ? `(${text})` : text;
  };
  const print = (e: Json): [string, number] => {
    switch (e.kind) {
      case "int":
        if (!Number.isSafeInteger(e.value)) fail(`integer literal ${e.value} is beyond 2^53 and would lose precision in TypeScript`);
        return [String(e.value), e.value < 0 ? UNARY : ATOM];
      case "bool": return [String(e.value), ATOM];
      case "str": return [JSON.stringify(e.value), ATOM];
      case "name": return [variants.has(e.name) ? JSON.stringify(e.name) : e.name, ATOM];
      case "let": return fail(`\`val ${e.opdef.name}\` must be at the top of a definition, not inside an expression`);
      case "app": break;
      default: return fail(`unsupported expression kind ${e.kind}`);
    }
    const a: Json[] = e.args;
    const op: string = e.opcode;
    if (BINARY[op]) {
      const [symbol, prec] = BINARY[op];
      if ((op === "eq" || op === "neq") && !a.every((x) => isScalar(typeOf(x.id))))
        fail("== and != on records are not supported (compare fields instead)");
      return [`${ex(a[0], prec)} ${symbol} ${ex(a[1], prec + 1)}`, prec];
    }
    switch (op) {
      case "iuminus": return [`-${ex(a[0], ATOM)}`, UNARY];
      case "not": return [`!${ex(a[0], ATOM)}`, UNARY];
      case "and": return [flat(e, "and").map((x) => ex(x, AND + 1)).join(" && "), AND];
      case "or": return [flat(e, "or").map((x) => ex(x, AND + 1)).join(" || "), OR];
      case "implies": return [`!${ex(a[0], ATOM)} || ${ex(a[1], AND + 1)}`, OR];
      case "iff": return [`${ex(a[0], EQ + 1)} === ${ex(a[1], EQ + 1)}`, EQ];
      case "ite": return [`${ex(a[0], OR)} ? ${ex(a[1], OR)} : ${ex(a[2], OR)}`, TERNARY];
      case "field": return [`${ex(a[0], ATOM)}.${a[1].value}`, ATOM];
      case "Rec": {
        const pairs = [];
        for (let i = 0; i < a.length; i += 2) pairs.push(`${a[i].value}: ${ex(a[i + 1])}`);
        return [`{ ${pairs.join(", ")} }`, ATOM];
      }
      case "with": {
        const updates: string[] = [];
        let base = e;
        while (base.kind === "app" && base.opcode === "with") {
          updates.unshift(`${base.args[1].value}: ${ex(base.args[2])}`);
          base = base.args[0];
        }
        return [`{ ...${ex(base, ATOM)}, ${updates.join(", ")} }`, ATOM];
      }
    }
    if (defNames.has(op)) return [`${op}(${a.map((x) => ex(x)).join(", ")})`, ATOM];
    return fail(`unsupported Quint operator \`${op}\`: extend print() in tools/gen.ts`);
  };
  /** A definition body: leading `val`s become `const`s, the rest is returned. */
  const body = (e: Json): string[] => {
    const lines: string[] = [];
    while (e.kind === "let") {
      if (e.opdef.expr.kind === "lambda") fail(`local def ${e.opdef.name} is not supported`);
      lines.push(`const ${bind(e.opdef.name)} = ${ex(e.opdef.expr)};`);
      e = e.expr;
    }
    return [...lines, `return ${ex(e)};`];
  };

  // --- classify definitions by the naming convention ------------------------
  const sig = (d: Json) => {
    const t = typeOf(d.id);
    const params: Param[] = d.expr.params.map((p: Json, i: number) => ({ name: bind(p.name), type: t.args[i] }));
    return { params, result: t.res };
  };
  const vals = defs.filter((d) => d.qualifier === "pureval");
  const funs = defs.filter((d) => d.qualifier === "puredef");
  const initial = vals.find((d) => d.name === "initial") ?? fail("a spec must define `pure val initial`");
  const stateShape = shape(typeOf(initial.id));
  const state = tsType(typeOf(initial.id));
  const onState = (d: Json) => sig(d).params.length > 0 && shape(sig(d).params[0].type) === stateShape;
  const predicate = (prefix: string) =>
    funs.filter((d) => d.name.startsWith(prefix) && /[A-Z]/.test(d.name[prefix.length] ?? "")).map((d) => {
      if (!(onState(d) && sig(d).params.length === 1 && sig(d).result.kind === "bool"))
        fail(`${d.name}: an \`${prefix}\` rule takes the state and returns bool`);
      return d.name as string;
    });
  // A rule whose name is nearly right would otherwise be an unchecked helper.
  for (const d of funs) {
    const role = d.name.match(/^(always|sometimes|can)/i)?.[1].toLowerCase();
    if (role && role !== "can" && !new RegExp(`^${role}[A-Z]`).test(d.name)) fail(`${d.name}: write \`${role}\` rules as ${role}Something`);
    if (/^Can[A-Z]/.test(d.name)) fail(`${d.name}: write guards as can${d.name.slice(3)}`);
  }
  const always = predicate("always");
  const sometimes = predicate("sometimes");
  const line = (d: string) => origin(d)?.line ?? 0;
  const bySpecOrder = (x: Json, y: Json) => line(x.name) - line(y.name);
  const transitions: Transition[] = [...funs].sort(bySpecOrder)
    .filter((d) => onState(d) && shape(sig(d).result) === stateShape)
    .map((d) => {
      const params = sig(d).params.slice(1);
      const guard = funs.find((g) => g.name === `can${cap(d.name)}`);
      if (guard && sig(guard).params.map((p) => p.name + shape(p.type)).join() !== sig(d).params.map((p) => p.name + shape(p.type)).join())
        fail(`${guard.name} must take the same parameters as ${d.name}`);
      return { name: d.name, params, guard: guard?.name };
    });
  for (const g of funs.filter((d) => /^can[A-Z]/.test(d.name)))
    if (!transitions.some((t) => t.guard === g.name)) fail(`${g.name}: no transition named ${g.name[3].toLowerCase()}${g.name.slice(4)}`);

  // --- TypeScript ----------------------------------------------------------
  const doc = (d: string) => (origin(d) ? `/** ${origin(d)!.rule} (${source}:${origin(d)!.line}) */\n` : "");
  const sVar = "s";
  const out: string[] = [
    `// GENERATED from ${source} by tools/spec.ts. Do not edit: change the spec and run \`npm run gen\`.`,
    `//@ backend dafny`,
    ``,
    ...[...typedefs].sort(bySpecOrder).map((d) => doc(d.name) + emitTypedef(d)),
    ``,
    `/** One variant per transition in the spec. */`,
    `export type Event =`,
    ...transitions.map((t) => `  | { type: ${JSON.stringify(t.name)}${t.params.map((p) => `; ${p.name}: ${tsType(p.type)}`).join("")} }`).map((l, i, all) => (i === all.length - 1 ? l + ";" : l)),
    ``,
    ...vals.map((d) => `${doc(d.name)}export const ${d.name}: ${tsType(typeOf(d.id))} = ${ex(d.expr)};`),
    ``,
    `/** Every \`always\` rule at once. Proved to hold initially and after every transition. */`,
    `//@ pure`,
    `export function inv(${sVar}: ${state}): boolean {`,
    `  return ${always.length ? always.map((a) => `${a}(${sVar})`).join(" && ") : "true"};`,
    `}`,
  ];
  for (const d of [...funs].sort(bySpecOrder)) {
    const { params, result } = sig(d);
    const t = transitions.find((t) => t.name === d.name);
    const args = params.map((p) => p.name).join(", ");
    out.push(
      ``,
      `${doc(d.name)}//@ pure`,
      `export function ${d.name}(${params.map((p) => `${p.name}: ${tsType(p.type)}`).join(", ")}): ${tsType(result)} {`,
      // One `ensures` per rule, so a failed proof names the rule that the transition breaks.
      ...(t ? [`  //@ requires inv(${params[0].name})${t.guard ? ` && ${t.guard}(${args})` : ""}`, ...always.map((a) => `  //@ ensures ${a}(\\result)`)] : []),
      ...body(d.expr.expr).map((l) => `  ${l}`),
      `}`,
    );
  }
  /** A runtime test that an untrusted value inhabits a parameter type. */
  const wellFormed = (v: string, t0: Json): string => {
    const t = resolve(t0);
    if (t.kind === "int") return `Number.isSafeInteger(${v})`;
    if (t.kind === "bool") return `typeof ${v} === "boolean"`;
    if (t.kind === "str") return `typeof ${v} === "string"`;
    if (t.kind === "sum") return `(${fields(t).map((f) => `${v} === ${JSON.stringify(f.fieldName)}`).join(" || ")})`;
    return fail(`event parameter of type ${t.kind} is not supported`);
  };
  const call = (t: Transition, fn: string) => `${fn}(${[sVar, ...t.params.map((p) => `e.${p.name}`)].join(", ")})`;
  const when = (t: Transition) => `e.type === ${JSON.stringify(t.name)}`;
  out.push(
    ``,
    `/** Do the rules allow this event in this state? */`,
    `//@ pure`,
    `export function enabled(${sVar}: ${state}, e: Event): boolean {`,
    ...transitions.map((t) => `  if (${when(t)}) return ${t.guard ? call(t, t.guard) : "true"};`),
    `  return false;`,
    `}`,
    ``,
    `/** Apply an event. An event the rules do not allow leaves the state unchanged. */`,
    `//@ pure`,
    `export function step(${sVar}: ${state}, e: Event): ${state} {`,
    `  //@ requires inv(${sVar})`,
    `  //@ ensures inv(\\result)`,
    ...transitions.map((t) => `  if (${when(t)}${t.guard ? ` && ${call(t, t.guard)}` : ""}) return ${call(t, t.name)};`),
    `  return ${sVar};`,
    `}`,
    ``,
    `/** Is this untrusted value a well-formed event? Use it where events enter the program. */`,
    `//@ skip`,
    `export function isEvent(x: unknown): x is Event {`,
    `  const e = x as Record<string, unknown> | null;`,
    `  if (typeof e !== "object" || e === null) return false;`,
    ...transitions.map((t) => `  if (e.type === ${JSON.stringify(t.name)}) return ${t.params.map((p) => wellFormed(`e.${p.name}`, p.type)).join(" && ") || "true"};`),
    `  return false;`,
    `}`,
    ``,
    `/** Proof obligation: the initial state satisfies every \`always\` rule. */`,
    `export function initialHolds(): ${state} {`,
    `  //@ ensures inv(\\result)`,
    `  return initial;`,
    `}`,
    ``,
  );

  // --- Quint harness: one action per transition, guards applied -------------
  const sample = (p: Param): string => {
    const t = resolve(p.type);
    if (t.kind === "sum") return `Set(${fields(t).map((f) => `M::${f.fieldName}`).join(", ")})`;
    return SAMPLES[t.kind] ?? fail(`event parameter ${p.name}: no sample values for type ${t.kind} (extend SAMPLES in tools/gen.ts)`);
  };
  const action = (t: Transition) => {
    const args = ["state", ...t.params.map((p) => p.name)].join(", ");
    const picks = t.params.map((p) => `nondet ${p.name} = ${sample(p)}.oneOf() `).join("");
    const effect = `state' = M::${t.name}(${args})`;
    const guarded = t.guard ? `all { M::${t.guard}(${args}), ${effect} }` : effect;
    return `  action ${t.name} = ${picks ? `{ ${picks}${guarded} }` : guarded}`;
  };
  const harness = [
    `// GENERATED from ${source}. Drives the spec's transitions for simulation.`,
    `module ${name}_run {`,
    `  import ${name} as M from "./${name}"`,
    `  var state: M::${state}`,
    `  action init = state' = M::initial`,
    ...transitions.map(action),
    `  action step = any { ${transitions.map((t) => t.name).join(", ")} }`,
    `  val inv = and { true, ${always.map((a) => `M::${a}(state)`).join(", ")} }`,
    ...sometimes.map((w) => `  val never_${w} = not(M::${w}(state))`),
    `}`,
    ``,
  ].join("\n");

  return { state, transitions, always, sometimes, ts: out.join("\n"), harness };
}
