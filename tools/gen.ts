// Quint IR -> TypeScript. Reads the JSON that `quint typecheck --out` writes for a
// pure module and emits one TypeScript module annotated for LemmaScript, plus a
// Quint harness module that drives the same definitions for simulation.
//
// The supported Quint subset is deliberately small; anything outside it throws
// with the name of the construct, so a spec can never be silently mistranslated.

type Json = any;

export interface Param { name: string; type: Json }
export interface Transition { name: string; params: Param[]; guard: string | undefined }
export interface Law { name: string; params: Param[] }
export interface Model {
  name: string;
  imports: string[]; // other specs this one imports, in order
  state: string | undefined; // undefined for a library: definitions and laws, no state machine
  transitions: Transition[];
  always: string[];
  sometimes: string[];
  steps: string[];
  laws: Law[];
  /** What importers may refer to. */
  exports: { types: string[]; values: string[]; variants: string[]; typedefs: Json[] };
  ts: string;
  harness: string;
}

/** Where a definition came from in the spec, for doc comments and ordering. */
export interface Origin { rule: string; line: number }

/**
 * `every`, `some`, `includes` and `listMap` are not Quint: the tangler expands
 * them into Quint's built-in `foldl` (see expandListHelpers in spec.ts), marking
 * the accumulator with one of these prefixes so that they come out here as the
 * native array methods. They cannot be Quint definitions that take a lambda,
 * because Quint evaluates such a definition wrongly when it is used inside its
 * own argument, as in `tasks.some(t => t.parents.some(...))`.
 */
export const LIST_HELPERS: Record<string, { init: string; step: (acc: string, body: string) => string }> = {
  every: { init: "true", step: (acc, body) => `${acc} and (${body})` },
  some: { init: "false", step: (acc, body) => `${acc} or (${body})` },
  listMap: { init: "List()", step: (acc, body) => `${acc}.append(${body})` },
  includes: { init: "false", step: (acc, body) => `${acc} or ${body}` },
};

// Operator precedence, loosest first. Mixed `&&`/`||` is always parenthesised.
const [ARROW, TERNARY, OR, AND, EQ, COMPARE, ADD, MULTIPLY, UNARY, ATOM] = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const BINARY: Record<string, [string, number]> = {
  iadd: ["+", ADD], isub: ["-", ADD], imul: ["*", MULTIPLY],
  ilt: ["<", COMPARE], ilte: ["<=", COMPARE], igt: [">", COMPARE], igte: [">=", COMPARE],
  eq: ["===", EQ], neq: ["!==", EQ],
};
const RESERVED = ["init", "step", "inv", "enabled", "isEvent", "Event", "initialHolds"];
/** Values the simulator tries for a parameter of each scalar type (the proof covers all values). */
const SAMPLES: Record<string, string> = { int: "(-1).to(6)", bool: "Set(true, false)", str: 'Set("", "a", "b")' };
// Words that cannot be used as names in the generated TypeScript or its harness.
const JS_WORDS = "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await state prev moved lawsHold".split(" ");

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const fail = (msg: string): never => { throw new Error(msg); };

export function generate(ir: Json, name: string, source: string, origin: (def: string) => Origin | undefined, deps: Map<string, Model>): Model {
  const decls: Json[] = (ir.modules.find((m: Json) => m.name === name) ?? fail(`module ${name} not found`)).declarations;
  const imports: string[] = decls.filter((d) => d.kind === "import").map((d) => {
    if (!deps.has(d.protoName)) fail(`import of ${d.protoName}: there is no spec/${d.protoName}.md`);
    if (d.defName !== "*") fail(`import ${d.protoName}: write \`import ${d.protoName}.* from "./${d.protoName}"\``);
    if (deps.get(d.protoName)!.state) fail(`import of ${d.protoName}: only a library (a spec without \`initial\`) can be imported; move the shared definitions into one`);
    return d.protoName as string;
  });
  const imported = imports.map((i) => deps.get(i)!);
  const localTypedefs = decls.filter((d) => d.kind === "typedef");
  const typedefs = [...imported.flatMap((m) => m.exports.typedefs), ...localTypedefs];
  const localVariants = new Set<string>();
  for (const t of localTypedefs) if (t.type.kind === "sum") for (const f of t.type.fields.fields) localVariants.add(f.fieldName);
  const variants = new Set([...localVariants, ...imported.flatMap((m) => m.exports.variants)]);
  const defs = decls.filter((d) => d.kind === "def" && !localVariants.has(d.name));
  for (const d of decls.filter((d) => !["def", "typedef", "import"].includes(d.kind)))
    fail(`${d.name ?? d.kind}: only types, imports, \`pure val\` and \`pure def\` belong in a spec (state and actions are generated)`);
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
  // `<param>Values` tells the simulator what to try for a parameter. It never reaches TypeScript, so any Quint is allowed in it.
  const isSampleSet = (d: Json) => d.qualifier === "pureval" && d.name.endsWith("Values");
  const sampleSets = new Set(defs.filter(isSampleSet).map((d) => d.name as string));
  const code = defs.filter((d) => !isSampleSet(d));
  const defNames = new Set([...code.map((d) => d.name as string), ...imported.flatMap((m) => m.exports.values)]);

  // --- types ---------------------------------------------------------------
  const fields = (t: Json): Json[] => t.fields.fields;
  const resolve = (t: Json): Json =>
    t.kind === "const" ? resolve(typedefs.find((d) => d.name === t.name)?.type ?? fail(`unknown type ${t.name}`)) : t;
  /** Structural identity, so inferred types can be matched back to their names. */
  const shape = (t0: Json): string => {
    const t = resolve(t0);
    if (t.kind === "rec") return `{${fields(t).map((f) => `${f.fieldName}:${shape(f.fieldType)}`).sort()}}`;
    if (t.kind === "sum") return `<${fields(t).map((f) => f.fieldName).sort()}>`;
    if (t.kind === "list") return `[${shape(t.elem)}]`;
    return t.kind;
  };
  const PRIMITIVE: Record<string, string> = { int: "number", bool: "boolean", str: "string" };
  const tsType = (t: Json): string => {
    if (t.kind === "const") return t.name;
    if (PRIMITIVE[t.kind]) return PRIMITIVE[t.kind];
    if (t.kind === "list") return `${tsType(t.elem)}[]`;
    const named = typedefs.find((d) => shape(d.type) === shape(t));
    return named ? named.name : fail(`unsupported type ${t.kind}: name it with \`type\`, or extend tsType in tools/gen.ts`);
  };
  const typeOf = (id: number): Json => ir.types[id]?.type ?? fail(`no inferred type for expression ${id}`);
  const isScalar = (t: Json) => ["int", "bool", "str", "sum"].includes(resolve(t).kind);

  const emitTypedef = (d: Json): string => {
    const t = d.type;
    if (t.kind === "sum") {
      for (const f of fields(t))
        if (fields(f.fieldType).length) fail(`${d.name}.${f.fieldName}: variants with payloads are not supported; use a record with a tag field`);
      return `export type ${d.name} = ${fields(t).map((f) => JSON.stringify(f.fieldName)).join(" | ")};`;
    }
    if (t.kind === "rec")
      return `export interface ${d.name} { ${fields(t).map((f) => `${f.fieldName}: ${tsType(f.fieldType)}`).join("; ")} }`;
    return `export type ${d.name} = ${tsType(t)};`;
  };

  // --- expressions ---------------------------------------------------------
  // `ex(e, min)` prints `e`, parenthesised only if it binds looser than `min`.
  const flat = (e: Json, op: string): Json[] => (e.kind === "app" && e.opcode === op ? e.args.flatMap((x: Json) => flat(x, op)) : [e]);
  let nesting = 0;
  const ex = (e: Json, min = ARROW): string => {
    nesting++;
    const [text, prec] = print(e);
    nesting--;
    return prec < min ? `(${text})` : text;
  };
  /** Inside another expression a record literal has no declared type to check against, so it states its own. */
  const typed = (text: string, e: Json): string => {
    const named = nesting > 1 ? typedefs.find((d) => d.type.kind === "rec" && shape(d.type) === shape(typeOf(e.id))) : undefined;
    return named ? `(${text} as ${named.name})` : text;
  };
  const scalarOnly = (what: string, xs: Json[]) =>
    xs.every((x) => isScalar(typeOf(x.id))) || fail(`${what} on records or lists is not supported: compare fields, or use every/some`);
  /** A lambda. Its parameters carry their types, which LemmaScript cannot always infer. */
  const arrow = (params: Json[], result: Json): string => {
    const text = ex(result, TERNARY);
    const param = (p: Json) => (ir.types[p.id] ? `${bind(p.name)}: ${tsType(typeOf(p.id))}` : bind(p.name));
    return `(${params.map(param).join(", ")}) => ${text.startsWith("{") ? `(${text})` : text}`;
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
      case "lambda": return [arrow(e.params, e.expr), ARROW];
      case "app": break;
      default: return fail(`unsupported expression kind ${e.kind}`);
    }
    const a: Json[] = e.args;
    const op: string = e.opcode;
    if (BINARY[op]) {
      const [symbol, prec] = BINARY[op];
      if (op === "eq" || op === "neq") scalarOnly("== and !=", a);
      return [`${ex(a[0], prec)} ${symbol} ${ex(a[1], prec + 1)}`, prec];
    }
    const recv = () => ex(a[0], ATOM);
    switch (op) {
      case "iuminus": return [`-${ex(a[0], ATOM)}`, UNARY];
      // Whole-number division and remainder agree between Quint, JavaScript and Dafny only for non-negative operands.
      case "idiv": return [`Math.floor(${ex(a[0], MULTIPLY)} / ${ex(a[1], MULTIPLY + 1)})`, ATOM];
      case "imod": return [`${ex(a[0], MULTIPLY)} % ${ex(a[1], MULTIPLY + 1)}`, MULTIPLY];
      case "not": return [`!${ex(a[0], ATOM)}`, UNARY];
      case "and": return [flat(e, "and").map((x) => ex(x, AND + 1)).join(" && "), AND];
      case "or": return [flat(e, "or").map((x) => ex(x, AND + 1)).join(" || "), OR];
      case "implies": return [`!${ex(a[0], ATOM)} || ${ex(a[1], AND + 1)}`, OR];
      case "iff": return [`${ex(a[0], EQ + 1)} === ${ex(a[1], EQ + 1)}`, EQ];
      case "ite": return [`${ex(a[0], OR)} ? ${ex(a[1], OR)} : ${ex(a[2], OR)}`, TERNARY];
      case "field": return [`${recv()}.${a[1].value}`, ATOM];
      case "Rec": {
        const pairs = [];
        for (let i = 0; i < a.length; i += 2) pairs.push(`${a[i].value}: ${ex(a[i + 1], TERNARY)}`);
        return [typed(`{ ${pairs.join(", ")} }`, e), ATOM];
      }
      case "with": {
        const updates: string[] = [];
        let base = e;
        while (base.kind === "app" && base.opcode === "with") {
          updates.unshift(`${base.args[1].value}: ${ex(base.args[2], TERNARY)}`);
          base = base.args[0];
        }
        return [typed(`{ ...${ex(base, ATOM)}, ${updates.join(", ")} }`, e), ATOM];
      }
      // Lists are arrays.
      // An empty list carries its type, which TypeScript cannot infer where it is a fold's starting value.
      case "List": return [a.length ? `[${a.map((x) => ex(x, TERNARY)).join(", ")}]` : `([] as ${tsType(typeOf(e.id))})`, ATOM];
      case "append": return [`[...${recv()}, ${ex(a[1], TERNARY)}]`, ATOM];
      case "concat": return [`[...${recv()}, ...${ex(a[1], ATOM)}]`, ATOM];
      case "length": return [`${recv()}.length`, ATOM];
      case "nth": return [`${recv()}[${ex(a[1])}]`, ATOM];
      case "head": return [`${recv()}[0]`, ATOM];
      case "tail": return [`${recv()}.slice(1)`, ATOM];
      case "select": return [`${recv()}.filter(${ex(a[1])})`, ATOM];
      case "foldl": {
        // A fold whose accumulator is marked is one of the list helpers, expanded by the tangler.
        const [acc, item] = a[2].kind === "lambda" ? a[2].params : [];
        const helper = acc?.name.match(/^std_(every|some|listMap|includes)_/)?.[1];
        const inner = a[2].expr?.args?.[1];
        if (helper === "every") return [`${recv()}.every(${arrow([item], inner)})`, ATOM];
        if (helper === "some") return [`${recv()}.some(${arrow([item], inner)})`, ATOM];
        if (helper === "listMap") return [`${recv()}.map(${arrow([item], inner)})`, ATOM];
        if (helper === "includes") { scalarOnly("includes", [inner.args[1]]); return [`${recv()}.includes(${ex(inner.args[1], TERNARY)})`, ATOM]; }
        return [`${recv()}.reduce(${ex(a[2])}, ${ex(a[1], TERNARY)})`, ATOM];
      }
    }
    if (defNames.has(op)) return [`${op}(${a.map((x) => ex(x, TERNARY)).join(", ")})`, ATOM];
    if (sampleSets.has(op)) return fail(`${op} is a sample set for the simulator and cannot be used in a definition`);
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
  const line = (d: string) => origin(d)?.line ?? 0;
  const bySpecOrder = (x: Json, y: Json) => line(x.name) - line(y.name);
  const vals = code.filter((d) => d.qualifier === "pureval");
  const funs = code.filter((d) => d.qualifier === "puredef").sort(bySpecOrder);
  const initial = vals.find((d) => d.name === "initial");
  const stateShape = initial && shape(typeOf(initial.id));
  const state = initial && tsType(typeOf(initial.id));
  const onState = (d: Json, at = 0) => sig(d).params.length > at && shape(sig(d).params[at].type) === stateShape;
  const isBool = (d: Json) => sig(d).result.kind === "bool";
  // A rule whose name is nearly right would otherwise be an unchecked helper.
  for (const d of funs) {
    const role = d.name.match(/^(always|sometimes|step|law|can)/i)?.[1].toLowerCase();
    if (role && role !== "can" && !new RegExp(`^${role}[A-Z]`).test(d.name) && d.name.toLowerCase() !== role) fail(`${d.name}: write \`${role}\` rules as ${role}Something`);
    if (/^Can[A-Z]/.test(d.name)) fail(`${d.name}: write guards as can${d.name.slice(3)}`);
  }
  const named = (prefix: string) => funs.filter((d) => new RegExp(`^${prefix}[A-Z]`).test(d.name));
  const needsState = (prefix: string) => named(prefix).length && !initial && fail(`${named(prefix)[0].name}: \`${prefix}\` rules need a state, so the spec must define \`pure val initial\``);
  ["always", "sometimes", "step"].forEach(needsState);
  const stateRule = (prefix: string, arity: number) => named(prefix).map((d) => {
    const ok = isBool(d) && sig(d).params.length === arity && sig(d).params.every((_, i) => onState(d, i));
    if (!ok) fail(`${d.name}: a \`${prefix}\` rule takes ${arity === 1 ? "the state" : "the state before and the state after"} and returns bool`);
    return d.name as string;
  });
  const always = stateRule("always", 1);
  const sometimes = stateRule("sometimes", 1);
  const steps = stateRule("step", 2);
  const laws: Law[] = named("law").map((d) => (isBool(d) ? { name: d.name, params: sig(d).params } : fail(`${d.name}: a law returns bool`)));
  const ruleNames = new Set([...always, ...sometimes, ...steps, ...laws.map((l) => l.name)]);
  const transitions: Transition[] = !initial ? [] : funs
    .filter((d) => !ruleNames.has(d.name) && onState(d) && shape(sig(d).result) === stateShape)
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
    ...imported.map((m) => `import { ${[...m.exports.types.map((t) => `type ${t}`), ...m.exports.values].join(", ")} } from "./${m.name}.ts";`),
    ``,
    ...[...localTypedefs].sort(bySpecOrder).map((d) => doc(d.name) + emitTypedef(d)),
  ];
  if (state) out.push(
    ``,
    `/** One variant per transition in the spec. */`,
    `export type Event =`,
    ...transitions.map((t) => `  | { type: ${JSON.stringify(t.name)}${t.params.map((p) => `; ${p.name}: ${tsType(p.type)}`).join("")} }`).map((l, i, all) => (i === all.length - 1 ? l + ";" : l)),
  );
  out.push(``, ...vals.map((d) => `${doc(d.name)}export const ${d.name}: ${tsType(typeOf(d.id))} = ${ex(d.expr)};`));
  if (state) out.push(
    ``,
    `/** Every \`always\` rule at once. Holds initially and after every transition. */`,
    `//@ pure`,
    `export function inv(${sVar}: ${state}): boolean {`,
    `  return ${always.length ? always.map((a) => `${a}(${sVar})`).join(" && ") : "true"};`,
    `}`,
  );
  for (const d of funs) {
    const { params, result } = sig(d);
    const t = transitions.find((t) => t.name === d.name);
    const args = params.map((p) => p.name).join(", ");
    // One `ensures` per rule, so a failed proof names the rule that the transition breaks.
    const contract = t ? [
      `  //@ requires inv(${params[0].name})${t.guard ? ` && ${t.guard}(${args})` : ""}`,
      ...always.map((a) => `  //@ ensures ${a}(\\result)`),
      ...steps.map((r) => `  //@ ensures ${r}(${params[0].name}, \\result)`),
    ] : laws.some((l) => l.name === d.name) ? [`  //@ ensures \\result === true`] : [];
    out.push(
      ``,
      `${doc(d.name)}//@ pure`,
      `export function ${d.name}(${params.map((p) => `${p.name}: ${tsType(p.type)}`).join(", ")}): ${tsType(result)} {`,
      ...contract,
      ...body(d.expr.expr).map((l) => `  ${l}`),
      `}`,
    );
  }
  /** A runtime test that an untrusted value inhabits a type. */
  const wellFormed = (v: string, t0: Json, depth = 0): string => {
    const t = resolve(t0);
    if (t.kind === "int") return `Number.isSafeInteger(${v})`;
    if (t.kind === "bool") return `typeof ${v} === "boolean"`;
    if (t.kind === "str") return `typeof ${v} === "string"`;
    if (t.kind === "sum") return `(${fields(t).map((f) => `${v} === ${JSON.stringify(f.fieldName)}`).join(" || ")})`;
    const x = `x${depth}`;
    if (t.kind === "list") return `Array.isArray(${v}) && ${v}.every((${x}: any) => ${wellFormed(x, t.elem, depth + 1)})`;
    if (t.kind === "rec") return `typeof ${v} === "object" && ${v} !== null && ${fields(t).map((f) => wellFormed(`(${v} as any).${f.fieldName}`, f.fieldType, depth + 1)).join(" && ")}`;
    return fail(`a parameter of type ${t.kind} is not supported`);
  };
  const call = (t: Transition, fn: string) => `${fn}(${[sVar, ...t.params.map((p) => `e.${p.name}`)].join(", ")})`;
  const when = (t: Transition) => `e.type === ${JSON.stringify(t.name)}`;
  if (state) out.push(
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
    `  const e = x as Record<string, any> | null;`,
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
  );
  out.push(``);

  // --- Quint harness: one action per transition and per law ------------------
  /** A Quint set of values to try for a parameter. `<param>Values` in the spec overrides the default for its type. */
  const sample = (p: Param): string => {
    if (sampleSets.has(`${p.name}Values`)) return `M::${p.name}Values`;
    const byType = (t0: Json): string => {
      const t = resolve(t0);
      if (t.kind === "sum") return `Set(${fields(t).map((f) => `M::${f.fieldName}`).join(", ")})`;
      if (t.kind === "list") {
        const of = byType(t.elem);
        return `Set(List()).union(${of}.map(x => List(x))).union(tuples(${of}, ${of}).map(p => List(p._1, p._2)))`;
      }
      return SAMPLES[t.kind] ?? fail(`parameter ${p.name}: the simulator has no values to try for type ${t.kind}; define \`pure val ${p.name}Values = Set(...)\` in the spec`);
    };
    return byType(p.type);
  };
  const picks = (ps: Param[]) => ps.map((p) => `nondet ${p.name} = ${sample(p)}.oneOf() `).join("");
  const braces = (ps: Param[], inner: string) => (ps.length ? `{ ${picks(ps)}${inner} }` : inner);
  const frame = (changes: string[]) => `all { ${changes.join(", ")} }`;
  const action = (t: Transition) => {
    const args = ["state", ...t.params.map((p) => p.name)].join(", ");
    return `  action ${t.name} = ${braces(t.params, frame([...(t.guard ? [`M::${t.guard}(${args})`] : []), `state' = M::${t.name}(${args})`, `prev' = state`, `moved' = true`, `lawsHold' = lawsHold`]))}`;
  };
  const lawAction = (l: Law) =>
    `  action ${l.name} = ${braces(l.params, frame([`lawsHold' = M::${l.name}(${l.params.map((p) => p.name).join(", ")})`, ...(state ? [`state' = state`, `prev' = prev`, `moved' = moved`] : [])]))}`;
  const harness = [
    `// GENERATED from ${source}. Drives the spec's transitions and laws for simulation.`,
    `module ${name}_run {`,
    `  import ${name} as M from "./${name}"`,
    ...(state ? [`  var state: M::${state}`, `  var prev: M::${state}`, `  var moved: bool`] : []),
    `  var lawsHold: bool`,
    `  action init = ${frame([`lawsHold' = true`, ...(state ? [`state' = M::initial`, `prev' = M::initial`, `moved' = false`] : [])])}`,
    ...transitions.map(action),
    ...laws.map(lawAction),
    `  action step = any { ${[...transitions.map((t) => t.name), ...laws.map((l) => l.name), ...(transitions.length + laws.length ? [] : [`lawsHold' = lawsHold`])].join(", ")} }`,
    `  val inv = and { lawsHold, ${[...always.map((a) => `M::${a}(state)`), ...steps.map((r) => `(not(moved) or M::${r}(prev, state))`), "true"].join(", ")} }`,
    ...sometimes.map((w) => `  val never_${w} = not(M::${w}(state))`),
    `}`,
    ``,
  ].join("\n");

  const exports = {
    types: localTypedefs.map((d) => d.name as string),
    values: code.map((d) => d.name as string),
    variants: [...localVariants],
    typedefs: localTypedefs,
  };
  return { name, imports, state, transitions, always, sometimes, steps, laws, exports, ts: out.join("\n"), harness };
}
