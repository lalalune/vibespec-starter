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
/** A definition the simulator evaluates so that its result can be compared with TypeScript's. */
export interface Eval { name: string; params: (Param & { from: "state" | "prev" | "pick" })[]; result: Json }
export interface Model {
  name: string;
  imports: string[]; // other specs this one imports, in order
  /** The same, with the name each was imported under: `import order as O` gives O; `import kernel.*` gives none. */
  links: { module: string; alias?: string }[];
  /** The TypeScript with every top-level name prefixed, for placing beside another module in one proof. */
  render: (prefix: string) => string;
  state: string | undefined; // undefined for a library: definitions and laws, no state machine
  transitions: Transition[];
  always: string[];
  sometimes: string[];
  steps: string[];
  laws: Law[];
  evals: Eval[];
  /** A value from a Quint trace (ITF) as the generated TypeScript represents it. */
  decode: (type: Json, itf: any) => any;
  /** The same value with every set in a fixed order, so that two sets compare equal however they were built. */
  canon: (type: Json, value: any) => any;
  stateType: Json | undefined;
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
/** Quint's set operations, as array expressions that keep the "no value twice" property. */
type SetArgs = { a: string; b: string; el: string; out: string };
const SET_OPS: Record<string, (x: SetArgs) => string> = {
  contains: ({ a, b }) => `${a}.includes(${b})`,
  in: ({ a, b }) => `${a}.includes(${b})`,
  size: ({ a }) => `${a}.length`,
  union: ({ a, b, el }) => `[...${a}, ...${b}.filter((set_x: ${el}) => !${a}.includes(set_x))]`,
  intersect: ({ a, b, el }) => `${a}.filter((set_x: ${el}) => ${b}.includes(set_x))`,
  exclude: ({ a, b, el }) => `${a}.filter((set_x: ${el}) => !${b}.includes(set_x))`,
  subseteq: ({ a, b, el }) => `${a}.every((set_x: ${el}) => ${b}.includes(set_x))`,
  filter: ({ a, b }) => `${a}.filter(${b})`,
  forall: ({ a, b }) => `${a}.every(${b})`,
  exists: ({ a, b }) => `${a}.some(${b})`,
  map: ({ a, b, out }) => `${a}.map(${b}).reduce((set_acc: ${out}[], set_x: ${out}) => set_acc.includes(set_x) ? set_acc : [...set_acc, set_x], ([] as ${out}[]))`,
};
const RESERVED = ["init", "step", "probe", "inv", "enabled", "isEvent", "Event", "initialHolds"];
/** Values the simulator tries for a parameter of each scalar type (the proof covers all values). */
const SAMPLES: Record<string, string> = { int: "(-1).to(6)", bool: "Set(true, false)", str: 'Set("", "a", "b")' };
// Words that cannot be used as names in the generated TypeScript or its harness.
const JS_WORDS = "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await state prev moved out lawsHold".split(" ");

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const fail = (msg: string): never => { throw new Error(msg); };

export function generate(ir: Json, name: string, source: string, origin: (def: string) => Origin | undefined, deps: Map<string, Model>): Model {
  const decls: Json[] = (ir.modules.find((m: Json) => m.name === name) ?? fail(`module ${name} not found`)).declarations;
  // `import kernel.* from "./kernel"` brings a library's names in as they are. `import order as O from "./order"`
  // brings any spec in, a state machine included, under the names O::pay, O::Order and so on.
  const links = decls.filter((d) => d.kind === "import").map((d) => {
    const dep = deps.get(d.protoName) ?? fail(`import of ${d.protoName}: there is no spec/${d.protoName}.md`);
    if (d.qualifiedName) return { module: dep.name, alias: d.qualifiedName as string };
    if (d.defName !== "*") fail(`import ${d.protoName}: write \`import ${d.protoName}.* from "./${d.protoName}"\` or \`import ${d.protoName} as X from "./${d.protoName}"\``);
    if (dep.state) fail(`import of ${d.protoName}: a spec with a state of its own is imported under a name, as in \`import ${d.protoName} as X from "./${d.protoName}"\``);
    return { module: dep.name, alias: undefined as string | undefined };
  });
  const imports = [...new Set(links.map((l) => l.module))];
  const qualify = (alias: string | undefined, n: string) => (alias ? `${alias}::${n}` : n);
  const localTypedefs = decls.filter((d) => d.kind === "typedef");
  for (const d of localTypedefs) d.module = name; // so that the harness can name a type by the module that defines it
  /** A type from a module imported under a name, with the types it mentions renamed the same way. */
  const requalify = (t: Json, alias: string | undefined): Json =>
    !alias || t === null || typeof t !== "object" ? t
    : Array.isArray(t) ? t.map((x) => requalify(x, alias))
    : t.kind === "const" ? { ...t, name: qualify(alias, t.name) }
    : Object.fromEntries(Object.entries(t).map(([k, v]) => [k, requalify(v, alias)]));
  const typedefs = [
    ...links.flatMap((l) => deps.get(l.module)!.exports.typedefs.map((d) => ({ ...d, type: requalify(d.type, l.alias), name: qualify(l.alias, d.name), alias: l.alias, base: d.name }))),
    ...localTypedefs,
  ];
  const localVariants = new Set<string>();
  for (const t of localTypedefs) if (t.type.kind === "sum") for (const f of t.type.fields.fields) localVariants.add(f.fieldName);
  const variants = new Set([...localVariants, ...links.flatMap((l) => deps.get(l.module)!.exports.variants.map((v) => qualify(l.alias, v)))]);
  /** A top-level name of this module as the TypeScript spells it: prefixed when the module is rendered for a proof bundle. */
  let prefix = "";
  const L = (n: string) => prefix + n;
  /** A reference to a definition: this module's, a library's, or one imported under a name. */
  const ref = (n: string) => (n.includes("::") ? n.replace("::", "_") : localNames.has(n) ? L(n) : n);
  const typeName = (d: Json): string => (d.alias ? `${d.alias}_${d.base}` : d.module === name ? L(d.name) : d.name);
  const tag = (variant: string) => JSON.stringify(variant.split("::").pop());
  const defs = decls.filter((d) => d.kind === "def" && !localVariants.has(d.name));
  for (const d of decls.filter((d) => !["def", "typedef", "import"].includes(d.kind)))
    fail(`${d.name ?? d.kind}: only types, imports, \`pure val\` and \`pure def\` belong in a spec (state and actions are generated)`);
  for (const d of defs) {
    if (d.qualifier !== "puredef" && d.qualifier !== "pureval")
      fail(`${d.name}: only types, \`pure val\` and \`pure def\` belong in a spec (state and actions are generated)`);
    if (RESERVED.includes(d.name) || /^(eval|quotient|remainder)_/.test(d.name)) fail(`${d.name}: this name is reserved for generated code`);
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
  const localNames = new Set(code.map((d) => d.name as string));
  const defNames = new Set([...localNames, ...links.flatMap((l) => deps.get(l.module)!.exports.values.map((v) => qualify(l.alias, v)))]);

  // --- types ---------------------------------------------------------------
  const fields = (t: Json): Json[] => t.fields.fields;
  // Quint sometimes names a type from a module imported under a name without that name; `base` finds it.
  const typedef = (n: string): Json => typedefs.find((d) => d.name === n) ?? typedefs.find((d) => d.base === n) ?? fail(`unknown type ${n}`);
  const resolve = (t: Json): Json => (t.kind === "const" ? resolve(typedef(t.name).type) : t);
  /** Structural identity, so inferred types can be matched back to their names. */
  const shape = (t0: Json): string => {
    const t = resolve(t0);
    if (t.kind === "rec") return `{${fields(t).map((f) => `${f.fieldName}:${shape(f.fieldType)}`).sort()}}`;
    if (t.kind === "sum") return `<${fields(t).map((f) => f.fieldName + (payload(f) ? shape(payload(f)) : "")).sort()}>`;
    if (t.kind === "list") return `[${shape(t.elem)}]`;
    if (t.kind === "set") return `(${shape(t.elem)})`;
    if (t.kind === "fun") return `${shape(t.arg)}=>${shape(t.res)}`;
    return t.kind;
  };
  /** The record a variant carries, if it carries one. */
  function payload(variant: Json): Json | undefined {
    const t = variant.fieldType;
    if (t.kind === "tup" && !(t.fields.fields ?? []).length) return undefined;
    return resolve(t).kind === "rec" ? resolve(t) : fail(`variant ${variant.fieldName}: a variant may carry a record, as in ${variant.fieldName}({ amount: int }), and nothing else`);
  }
  /** A sum type is a plain string union unless some variant carries data; then it is a tagged union. */
  const tagged = (t: Json) => t.kind === "sum" && fields(t).some((f) => payload(f));
  const PRIMITIVE: Record<string, string> = { int: "number", bool: "boolean", str: "string" };
  const tsType = (t: Json): string => {
    if (t.kind === "const") return typeName(typedef(t.name));
    if (PRIMITIVE[t.kind]) return PRIMITIVE[t.kind];
    if (t.kind === "list" || t.kind === "set") return `${tsType(t.elem)}[]`;
    if (t.kind === "fun") return resolve(t.arg).kind === "str" ? `Record<string, ${tsType(t.res)}>` : fail("a map's keys must be strings");
    const named = typedefs.find((d) => shape(d.type) === shape(t));
    return named ? typeName(named) : fail(`unsupported type ${t.kind}: name it with \`type\`, or extend tsType in tools/gen.ts`);
  };
  const typeOf = (id: number): Json => ir.types[id]?.type ?? fail(`no inferred type for expression ${id}`);
  const isScalar = (t: Json) => ["int", "bool", "str"].includes(resolve(t).kind) || (resolve(t).kind === "sum" && !tagged(resolve(t)));

  const emitTypedef = (d: Json): string => {
    const t = d.type;
    if (tagged(t)) {
      const variant = (f: Json) => `{ ${[`tag: ${JSON.stringify(f.fieldName)}`, ...(payload(f) ? fields(payload(f)).map((x: Json) => `${x.fieldName}: ${tsType(x.fieldType)}`) : [])].join("; ")} }`;
      return `export type ${L(d.name)} =\n${fields(t).map((f) => `  | ${variant(f)}`).join("\n")};`;
    }
    if (t.kind === "sum") return `export type ${L(d.name)} = ${fields(t).map((f) => JSON.stringify(f.fieldName)).join(" | ")};`;
    if (t.kind === "rec")
      return `export interface ${L(d.name)} { ${fields(t).map((f) => `${f.fieldName}: ${tsType(f.fieldType)}`).join("; ")} }`;
    return `export type ${L(d.name)} = ${tsType(t)};`;
  };

  // --- expressions ---------------------------------------------------------
  // `ex(e, min)` prints `e`, parenthesised only if it binds looser than `min`.
  const flat = (e: Json, op: string): Json[] => (e.kind === "app" && e.opcode === op ? e.args.flatMap((x: Json) => flat(x, op)) : [e]);
  /** Names that stand for something else while a `match` arm is printed: the arm's binder is the matched value. */
  const renamed = new Map<string, string>();
  const matchedAs = new Map<string, string>(); // binder -> the variant its arm matched
  const ownerOf = (variant: string): Json => {
    const [base, alias] = variant.split("::").reverse();
    return typedefs.find((d) => d.type.kind === "sum" && d.alias === alias && fields(d.type).some((f: Json) => f.fieldName === base)) ?? fail(`unknown variant ${variant}`);
  };
  /** Which arithmetic helpers this module needs. They are emitted once, under names of its own. */
  const arithmetic = new Set<string>();
  const helper = (which: string) => L(`${which}_${name}`);
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
    return named ? `(${text} as ${typeName(named)})` : text;
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
      case "name": {
        if (renamed.has(e.name)) return [renamed.get(e.name)!, ATOM];
        if (!variants.has(e.name)) return [ref(e.name), ATOM];
        const owner = ownerOf(e.name);
        return [tagged(owner.type) ? `({ tag: ${tag(e.name)} } as ${typeName(owner)})` : tag(e.name), ATOM];
      }
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
      // Quint divides towards zero, and its remainder takes the sign of the dividend. JavaScript's floor and Dafny's
      // division do neither for negative numbers, so both go through helpers that are exact in all three.
      case "idiv": arithmetic.add("quotient"); return [`${helper("quotient")}(${ex(a[0], TERNARY)}, ${ex(a[1], TERNARY)})`, ATOM];
      case "imod": arithmetic.add("quotient").add("remainder"); return [`${helper("remainder")}(${ex(a[0], TERNARY)}, ${ex(a[1], TERNARY)})`, ATOM];
      // A map is a record keyed by strings. Looking a key up is only safe where the same definition has tested for it.
      case "Map": return [a.reduce((m, pair) => `{ ...${m}, [${ex(pair.args[0], TERNARY)}]: ${ex(pair.args[1], TERNARY)} }`, `({} as ${tsType(typeOf(e.id))})`), ATOM];
      case "put": case "set": return [`{ ...${recv()}, [${ex(a[1], TERNARY)}]: ${ex(a[2], TERNARY)} }`, ATOM];
      case "get": return [`${recv()}[${ex(a[1])}]`, ATOM];
      case "keys": return fail("a map cannot be listed or iterated, only asked about one key: write `m.keys().contains(k)`, and keep a list of keys beside the map if you need to go through them");
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
    if (variants.has(op)) {
      // A variant that carries a record: Paid({ receipt: 7 }) is { tag: "Paid", receipt: 7 }.
      const owner = ownerOf(op);
      const parts: string[] = [];
      // Updating the matched value in place: Packed({ ...x, labels: … }) inside the Packed arm keeps the tag it has.
      let base = a[0];
      const updates: string[] = [];
      while (base.kind === "app" && base.opcode === "with") {
        updates.unshift(`${base.args[1].value}: ${ex(base.args[2], TERNARY)}`);
        base = base.args[0];
      }
      if (base.kind === "name" && matchedAs.get(base.name) === op.split("::").pop())
        return [updates.length ? `({ ...${renamed.get(base.name)}, ${updates.join(", ")} } as ${typeName(owner)})` : renamed.get(base.name)!, ATOM];
      if (a[0].kind !== "app" || a[0].opcode !== "Rec") fail(`${op}(…): give the record field by field, or update the value matched in the ${op} arm`);
      for (let i = 0; i < a[0].args.length; i += 2) parts.push(`${a[0].args[i].value}: ${ex(a[0].args[i + 1], TERNARY)}`);
      return [`({ ${[`tag: ${tag(op)}`, ...parts].join(", ")} } as ${typeName(owner)})`, ATOM];
    }
    if (op === "matchVariant") {
      // match o { | Draft(d) => … | _ => … } becomes a chain of tests on the tag, with d standing for o itself.
      if (a[0].kind !== "name") fail("`match` must be on a name; bind the value with `val` first");
      const subject = ex(a[0], ATOM);
      const isTagged = tagged(resolve(typeOf(a[0].id)));
      const arms: { test?: string; result: string }[] = [];
      for (let i = 1; i < a.length; i += 2) {
        const binder = a[i + 1].params[0]?.name;
        if (binder && binder !== "_") { renamed.set(binder, subject); matchedAs.set(binder, a[i].value); }
        const result = ex(a[i + 1].expr, OR);
        if (binder) { renamed.delete(binder); matchedAs.delete(binder); }
        arms.push({ test: a[i].value === "_" ? undefined : `${subject}${isTagged ? ".tag" : ""} === ${JSON.stringify(a[i].value)}`, result });
      }
      const last = arms.pop()!;
      return [arms.reduceRight((rest, arm) => `${arm.test} ? ${arm.result} : ${rest}`, last.result), arms.length ? TERNARY : OR];
    }
    if ((op === "contains" || op === "in") && (op === "in" ? a[1] : a[0]).opcode === "keys") {
      const [keys, key] = op === "in" ? [a[1], a[0]] : [a[0], a[1]];
      return [`${ex(key, COMPARE + 1)} in ${ex(keys.args[0], COMPARE + 1)}`, COMPARE];
    }
    if (SET_OPS[op]) {
      // A set is an array that never holds the same value twice. Only simple values can be in one.
      const t = resolve(typeOf(op === "in" ? a[1].id : a[0].id));
      if (t.kind !== "set") return fail(`\`${op}\` is supported on sets only`);
      if (!isScalar(t.elem)) fail("sets of records or lists are not supported; use a list");
      const el = tsType(t.elem);
      const [x, y] = op === "in" ? [a[1], a[0]] : [a[0], a[1]];
      return [SET_OPS[op]({ a: ex(x, ATOM), b: y && ex(y, y.kind === "lambda" ? ARROW : ATOM), el, out: op === "map" ? tsType(resolve(typeOf(e.id)).elem) : el }), ATOM];
    }
    if (op === "Set") {
      const t = resolve(typeOf(e.id));
      if (!isScalar(t.elem)) fail("sets of records or lists are not supported; use a list");
      const items = [...new Set(a.map((x) => ex(x, TERNARY)))];
      if (a.some((x) => !["int", "str", "bool", "name"].includes(x.kind)) && a.length > 1) fail("Set(…) with several computed members could hold the same value twice; write Set(a).union(Set(b))");
      return [items.length ? `[${items.join(", ")}]` : `([] as ${tsType(t.elem)}[])`, ATOM];
    }
    if (defNames.has(op)) return [`${ref(op)}(${a.map((x) => ex(x, TERNARY)).join(", ")})`, ATOM];
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
  // In a library, `withdraw` and `canWithdraw` are a component's functions for a machine elsewhere to build on.
  for (const g of initial ? funs.filter((d) => /^can[A-Z]/.test(d.name)) : [])
    if (!transitions.some((t) => t.guard === g.name)) fail(`${g.name}: no transition named ${g.name[3].toLowerCase()}${g.name.slice(4)}`);

  // --- TypeScript ----------------------------------------------------------
  const doc = (d: string) => (origin(d) ? `/** ${origin(d)!.rule} (${source}:${origin(d)!.line}) */\n` : "");
  const sVar = "s";
  /** The module's TypeScript, with its own top-level names under the given prefix. */
  const render = (as: string): string => {
  prefix = as;
  arithmetic.clear();
  const stateName = initial ? tsType(typeOf(initial.id)) : "";
  const importLine = (l: { module: string; alias?: string }) => {
    const x = deps.get(l.module)!.exports;
    const item = (n: string, isType: boolean) => `${isType ? "type " : ""}${n}${l.alias ? ` as ${l.alias}_${n}` : ""}`;
    return `import { ${[...x.types.map((t) => item(t, true)), ...x.values.map((v) => item(v, false))].join(", ")} } from "./${l.module}.ts";`;
  };
  const out: string[] = [
    `// GENERATED from ${source} by tools/spec.ts. Do not edit: change the spec and run \`npm run gen\`.`,
    `//@ backend dafny`,
    ...links.map(importLine),
    ``,
    ...[...localTypedefs].sort(bySpecOrder).map((d) => doc(d.name) + emitTypedef(d)),
  ];
  if (state) out.push(
    ``,
    `/** One variant per transition in the spec. */`,
    `export type ${L("Event")} =`,
    ...transitions.map((t) => `  | { type: ${JSON.stringify(t.name)}${t.params.map((p) => `; ${p.name}: ${tsType(p.type)}`).join("")} }`).map((l, i, all) => (i === all.length - 1 ? l + ";" : l)),
  );
  out.push(``, ...vals.map((d) => `${doc(d.name)}export const ${L(d.name)}: ${tsType(typeOf(d.id))} = ${ex(d.expr)};`));
  if (state) out.push(
    ``,
    `/** Every \`always\` rule at once. Holds initially and after every transition. */`,
    `//@ pure`,
    `export function ${L("inv")}(${sVar}: ${stateName}): boolean {`,
    `  return ${always.length ? always.map((a) => `${L(a)}(${sVar})`).join(" && ") : "true"};`,
    `}`,
  );
  for (const d of funs) {
    const { params, result } = sig(d);
    const t = transitions.find((t) => t.name === d.name);
    const args = params.map((p) => p.name).join(", ");
    // One `ensures` per rule, so a failed proof names the rule that the transition breaks. The transition has no
    // precondition: its guarantees are conditional instead, so that a guard may itself look at the transition's result.
    const given = t && `(${L("inv")}(${params[0].name})${t.guard ? ` && ${L(t.guard)}(${args})` : ""}) ==> `;
    const contract = t ? [
      ...always.map((a) => `  //@ ensures ${given}${L(a)}(\\result)`),
      ...steps.map((r) => `  //@ ensures ${given}${L(r)}(${params[0].name}, \\result)`),
    ] : laws.some((l) => l.name === d.name) ? [`  //@ ensures \\result === true`] : [];
    out.push(
      ``,
      `${doc(d.name)}//@ pure`,
      `export function ${L(d.name)}(${params.map((p) => `${p.name}: ${tsType(p.type)}`).join(", ")}): ${tsType(result)} {`,
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
    const x = `x${depth}`;
    const record = (r: Json) => fields(r).map((f) => wellFormed(`(${v} as any).${f.fieldName}`, f.fieldType, depth + 1));
    if (tagged(t)) return `typeof ${v} === "object" && ${v} !== null && (${fields(t).map((f) => [`(${v} as any).tag === ${JSON.stringify(f.fieldName)}`, ...(payload(f) ? record(payload(f)!) : [])].join(" && ")).join(" || ")})`;
    if (t.kind === "sum") return `(${fields(t).map((f) => `${v} === ${JSON.stringify(f.fieldName)}`).join(" || ")})`;
    if (t.kind === "list" || t.kind === "set") return `Array.isArray(${v}) && ${v}.every((${x}: any) => ${wellFormed(x, t.elem, depth + 1)})`;
    if (t.kind === "rec") return `typeof ${v} === "object" && ${v} !== null && ${record(t).join(" && ")}`;
    if (t.kind === "fun") return `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v}) && Object.values(${v}).every((${x}: any) => ${wellFormed(x, t.res, depth + 1)})`;
    return fail(`a parameter of type ${t.kind} is not supported`);
  };
  const call = (t: Transition, fn: string) => `${L(fn)}(${[sVar, ...t.params.map((p) => `e.${p.name}`)].join(", ")})`;
  const when = (t: Transition) => `e.type === ${JSON.stringify(t.name)}`;
  if (state) out.push(
    ``,
    `/** Do the rules allow this event in this state? */`,
    `//@ pure`,
    `export function ${L("enabled")}(${sVar}: ${stateName}, e: ${L("Event")}): boolean {`,
    ...transitions.map((t) => `  if (${when(t)}) return ${t.guard ? call(t, t.guard) : "true"};`),
    `  return false;`,
    `}`,
    ``,
    `/** Apply an event. An event the rules do not allow leaves the state unchanged. */`,
    `//@ pure`,
    `export function ${L("step")}(${sVar}: ${stateName}, e: ${L("Event")}): ${stateName} {`,
    `  //@ requires ${L("inv")}(${sVar})`,
    `  //@ ensures ${L("inv")}(\\result)`,
    ...transitions.map((t) => `  if (${when(t)}${t.guard ? ` && ${call(t, t.guard)}` : ""}) return ${call(t, t.name)};`),
    `  return ${sVar};`,
    `}`,
    ``,
    `/** Is this untrusted value a well-formed event? Use it where events enter the program. */`,
    `//@ skip`,
    `export function ${L("isEvent")}(x: unknown): x is ${L("Event")} {`,
    `  const e = x as Record<string, any> | null;`,
    `  if (typeof e !== "object" || e === null) return false;`,
    ...transitions.map((t) => `  if (e.type === ${JSON.stringify(t.name)}) return ${t.params.map((p) => wellFormed(`e.${p.name}`, p.type)).join(" && ") || "true"};`),
    `  return false;`,
    `}`,
    ``,
    `/** Proof obligation: the initial state satisfies every \`always\` rule. */`,
    `export function ${L("initialHolds")}(): ${stateName} {`,
    `  //@ ensures ${L("inv")}(\\result)`,
    `  return ${L("initial")};`,
    `}`,
  );
  if (arithmetic.has("quotient")) out.push(
    ``,
    `/** Whole-number division as Quint does it: towards zero. */`,
    `//@ pure`,
    `export function ${helper("quotient")}(a: number, b: number): number {`,
    `  //@ requires b !== 0`,
    `  return (a < 0 === b < 0 ? 1 : -1) * Math.floor(Math.abs(a) / Math.abs(b)) + 0;`,
    `}`,
  );
  if (arithmetic.has("remainder")) out.push(
    ``,
    `/** The remainder of that division; it has the sign of the dividend. */`,
    `//@ pure`,
    `export function ${helper("remainder")}(a: number, b: number): number {`,
    `  //@ requires b !== 0`,
    `  return a - b * ${helper("quotient")}(a, b);`,
    `}`,
  );
  out.push(``);
  prefix = "";
  return out.join("\n");
  };
  const ts = render("");

  // --- Quint harness: one action per transition and per law ------------------
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
      return SAMPLES[t.kind] ?? fail(`parameter ${p.name}: the simulator has no values to try for type ${t.kind}; define \`pure val ${p.name}Values = Set(...)\` in the spec`);
    };
    return byType(p.type);
  };
  const picks = (ps: Param[]) => ps.map((p) => `nondet ${p.name} = ${sample(p)}.oneOf() `).join("");
  const braces = (ps: Param[], inner: string) => (ps.length ? `{ ${picks(ps)}${inner} }` : inner);
  /** A type as the harness writes it: named types by the module that defines them. */
  const qType = (t: Json): string => {
    if (["int", "bool", "str"].includes(t.kind)) return t.kind;
    if (t.kind === "list") return `List[${qType(t.elem)}]`;
    if (t.kind === "set") return `Set[${qType(t.elem)}]`;
    if (t.kind === "fun") return `(${qType(t.arg)} -> ${qType(t.res)})`;
    const named = t.kind === "const" ? typedef(t.name) : typedefs.find((d) => shape(d.type) === shape(t));
    return named ? `${named.module === name ? "M" : `D_${named.module}`}::${named.base ?? named.name}` : fail("a type with no name");
  };
  // Every definition whose arguments the simulator can supply is evaluated during simulation, on reachable states
  // and sampled values, so that TypeScript's result can be compared with Quint's. This is the main test of the
  // translation: it covers helpers, guards and rules, not just the states that events lead to.
  const evals: Eval[] = funs.flatMap((d): Eval[] => {
    try {
      const { params, result } = sig(d);
      const onStates = params.filter((p) => shape(p.type) === stateShape).length;
      if (onStates > 2) return [];
      let seen = 0;
      const sources = params.map((p) => {
        if (state && shape(p.type) === stateShape) return onStates === 2 && seen++ === 0 ? "prev" as const : "state" as const;
        sample(p);
        return "pick" as const;
      });
      qType(result);
      return [{ name: d.name, params: params.map((p, i) => ({ ...p, from: sources[i] })), result }];
    } catch {
      return []; // its arguments cannot be sampled, or its result has no name: it is compared only where events use it
    }
  });
  // Harness variables: the state, the state before the last event, whether an event has happened, whether the
  // last law tried held, and the result of the last definition evaluated.
  const vars = [...(state ? ["state", "prev", "moved"] : []), "lawsHold", ...(evals.length ? ["out"] : [])];
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
  const harness = [
    `// GENERATED from ${source}. Drives the spec's transitions, laws and definitions for simulation.`,
    `module ${name}_run {`,
    `  import ${name} as M from "./${name}"`,
    ...imports.map((i) => `  import ${i} as D_${i} from "./${i}"`),
    ...(evals.length ? [`  type Out = Nothing | ${evals.map((v) => `Out_${v.name}(${qType(v.result)})`).join(" | ")}`, `  var out: Out`] : []),
    ...(state ? [`  var state: M::${state}`, `  var prev: M::${state}`, `  var moved: bool`] : []),
    `  var lawsHold: bool`,
    `  action init = ${frame([], { state: "M::initial", prev: "M::initial", moved: "false", lawsHold: "true", out: "Nothing" })}`,
    ...transitions.map(action),
    ...laws.map(lawAction),
    ...evals.map(evalAction),
    `  action step = ${any(events)}`,
    `  action probe = ${any([...events, ...evals.map((v) => `eval_${v.name}`)])}`,
    `  val inv = and { lawsHold, ${[...always.map((a) => `M::${a}(state)`), ...steps.map((r) => `(not(moved) or M::${r}(prev, state))`), "true"].join(", ")} }`,
    ...sometimes.map((w) => `  val never_${w} = not(M::${w}(state))`),
    `}`,
    ``,
  ].join("\n");

  const decode = (t0: Json, v: any): any => {
    const t = resolve(t0);
    if (t.kind === "int") return Number(v["#bigint"] ?? v);
    if (t.kind === "list") return v.map((x: any) => decode(t.elem, x));
    if (t.kind === "set") return v["#set"].map((x: any) => decode(t.elem, x));
    if (t.kind === "rec") return Object.fromEntries(fields(t).map((f) => [f.fieldName, decode(f.fieldType, v[f.fieldName])]));
    if (t.kind === "fun") return Object.fromEntries(v["#map"].map(([k, x]: [any, any]) => [decode(t.arg, k), decode(t.res, x)]));
    if (tagged(t)) {
      const carried = payload(fields(t).find((f) => f.fieldName === v.tag)!);
      return { tag: v.tag, ...(carried ? decode(carried, v.value) : {}) };
    }
    return t.kind === "sum" ? v.tag : v;
  };
  const canon = (t0: Json, v: any): any => {
    const t = resolve(t0);
    if (t.kind === "list") return v.map((x: any) => canon(t.elem, x));
    if (t.kind === "set") return [...v].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
    if (t.kind === "rec") return Object.fromEntries(fields(t).map((f) => [f.fieldName, canon(f.fieldType, v[f.fieldName])]));
    if (t.kind === "fun") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(t.res, x)]));
    if (tagged(t)) {
      const carried = payload(fields(t).find((f) => f.fieldName === v.tag)!);
      return carried ? { tag: v.tag, ...canon(carried, v) } : v;
    }
    return v;
  };
  const exports = {
    types: localTypedefs.map((d) => d.name as string),
    values: [...code.map((d) => d.name as string), ...[...arithmetic].map(helper)],
    variants: [...localVariants],
    typedefs: localTypedefs,
  };
  return { name, imports, links, render, state, transitions, always, sometimes, steps, laws, evals, exports, ts, harness, decode, canon, stateType: initial && typeOf(initial.id) };
}
