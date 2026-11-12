// Quint types as the type checker reports them, and everything that is decided by walking one: how TypeScript and
// the harness spell it, how an untrusted value is tested and copied, and how a value in a simulated trace is read.

export type Json = any;
export const fail = (msg: string): never => { throw new Error(msg); };

const PRIMITIVE: Record<string, string> = { int: "number", bool: "boolean", str: "string" };

/**
 * `typedefs` are the types a module can name: its own and those of the specs it imports. A type the module defines
 * is spelled with `prefix` in TypeScript; one from another module is spelled <module>_<name>.
 */
export function typeWalks(typedefs: Json[], module: string, prefix = "") {
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
    const carried = resolve(t).kind === "rec" ? resolve(t) : fail(`variant ${variant.fieldName}: a variant may carry a record, as in ${variant.fieldName}({ amount: int }), and nothing else`);
    if (fields(carried).some((f) => f.fieldName === "tag")) fail(`variant ${variant.fieldName}: a field cannot be called \`tag\`, which is how the variant itself is recorded`);
    return carried;
  }
  /** A sum type is a plain string union unless some variant carries data; then it is a tagged union. */
  const tagged = (t: Json) => t.kind === "sum" && fields(t).some((f) => payload(f));
  const isScalar = (t: Json) => ["int", "bool", "str"].includes(resolve(t).kind) || (resolve(t).kind === "sum" && !tagged(resolve(t)));
  /** The declared type with this structure, if there is one. */
  const named = (t: Json, kind?: string): Json | undefined => typedefs.find((d) => (!kind || d.type.kind === kind) && shape(d.type) === shape(t));
  /** The type a variant belongs to. */
  const ownerOf = (variant: string): Json => {
    const [base, alias] = variant.split("::").reverse();
    return typedefs.find((d) => d.type.kind === "sum" && d.alias === alias && fields(d.type).some((f: Json) => f.fieldName === base)) ?? fail(`unknown variant ${variant}`);
  };

  // --- spellings -------------------------------------------------------------
  const typeName = (d: Json): string => (d.module === module ? prefix + d.name : `${d.module}_${d.base}`);
  const tsType = (t: Json): string => {
    if (t.kind === "const") return typeName(typedef(t.name));
    if (PRIMITIVE[t.kind]) return PRIMITIVE[t.kind];
    if (t.kind === "list" || t.kind === "set") return `${tsType(t.elem)}[]`;
    if (t.kind === "fun") return resolve(t.arg).kind === "str" ? `Record<string, ${tsType(t.res)}>` : fail("a map's keys must be strings");
    const d = named(t);
    return d ? typeName(d) : fail(`unsupported type ${t.kind}: name it with \`type\`, or extend tsType in tools/gen/types.ts`);
  };
  /** The TypeScript declaration of one of the module's own types. */
  const declaration = (d: Json): string => {
    const t = d.type;
    if (tagged(t)) {
      const variant = (f: Json) => `{ ${[`tag: ${JSON.stringify(f.fieldName)}`, ...(payload(f) ? fields(payload(f)).map((x: Json) => `${x.fieldName}: ${tsType(x.fieldType)}`) : [])].join("; ")} }`;
      return `export type ${prefix}${d.name} =\n${fields(t).map((f) => `  | ${variant(f)}`).join("\n")};`;
    }
    if (t.kind === "sum") return `export type ${prefix}${d.name} = ${fields(t).map((f) => JSON.stringify(f.fieldName)).join(" | ")};`;
    if (t.kind === "rec")
      return `export interface ${prefix}${d.name} { ${fields(t).map((f) => `${f.fieldName}: ${tsType(f.fieldType)}`).join("; ")} }`;
    return `export type ${prefix}${d.name} = ${tsType(t)};`;
  };
  /** A type as the harness writes it: named types by the module that defines them. */
  const qType = (t: Json): string => {
    if (PRIMITIVE[t.kind]) return t.kind;
    if (t.kind === "list") return `List[${qType(t.elem)}]`;
    if (t.kind === "set") return `Set[${qType(t.elem)}]`;
    if (t.kind === "fun") return `(${qType(t.arg)} -> ${qType(t.res)})`;
    const d = t.kind === "const" ? typedef(t.name) : named(t);
    return d ? `${d.module === module ? "M" : `D_${d.module}`}::${d.base ?? d.name}` : fail("a type with no name");
  };

  // --- untrusted values --------------------------------------------------------
  /**
   * A runtime test that an untrusted value inhabits a type. `exact` is for a whole state: a record or variant may have
   * no field beyond those its type names, and a map is allowed, as a record whose keys all carry the "$" that every
   * key in generated code carries.
   */
  const wellFormed = (v: string, t0: Json, depth = 0, exact = false): string => {
    const t = resolve(t0);
    if (t.kind === "int") return `Number.isSafeInteger(${v})`;
    if (t.kind === "bool") return `typeof ${v} === "boolean"`;
    if (t.kind === "str") return `typeof ${v} === "string"`;
    const x = `x${depth}`;
    const object = `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v})`;
    const sized = (n: number) => (exact ? [`Object.keys(${v}).length === ${n}`] : []);
    const record = (r: Json) => fields(r).map((f) => wellFormed(`${v}.${f.fieldName}`, f.fieldType, depth + 1, exact));
    if (tagged(t)) return `${object} && (${fields(t).map((f) => [`${v}.tag === ${JSON.stringify(f.fieldName)}`, ...(payload(f) ? record(payload(f)!) : []), ...sized(1 + (payload(f) ? fields(payload(f)!).length : 0))].join(" && ")).join(" || ")})`;
    if (t.kind === "sum") return `(${fields(t).map((f) => `${v} === ${JSON.stringify(f.fieldName)}`).join(" || ")})`;
    if (t.kind === "list" || t.kind === "set")
      return `Array.isArray(${v}) && ${v}.every((${x}: any) => ${wellFormed(x, t.elem, depth + 1, exact)})${t.kind === "set" ? ` && new Set(${v}).size === ${v}.length` : ""}`;
    if (t.kind === "rec") return [object, ...record(t), ...sized(fields(t).length)].join(" && ");
    if (t.kind === "fun") {
      if (!exact) return fail("an event cannot carry a map; send a list of records instead");
      return `${object} && Object.entries(${v}).every(([k${depth}, ${x}]: [string, any]) => k${depth}.startsWith("$") && ${wellFormed(x, t.res, depth + 1, exact)})`;
    }
    return fail(`a parameter of type ${t.kind} is not supported`);
  };
  /** A copy of a checked value that has the fields its type names and no others. */
  const copy = (v: string, t0: Json, depth = 0): string => {
    const t = resolve(t0);
    const x = `x${depth}`;
    const record = (r: Json) => fields(r).map((f) => `${f.fieldName}: ${copy(`${v}.${f.fieldName}`, f.fieldType, depth + 1)}`);
    const variant = (f: Json) => `{ ${[`tag: ${v}.tag`, ...(payload(f) ? record(payload(f)!) : [])].join(", ")} }`;
    if (tagged(t)) return `(${fields(t).slice(0, -1).map((f) => `${v}.tag === ${JSON.stringify(f.fieldName)} ? ${variant(f)} : `).join("")}${variant(fields(t).at(-1)!)})`;
    if (t.kind === "list" || t.kind === "set") return `${v}.map((${x}: any) => ${copy(x, t.elem, depth + 1)})`;
    if (t.kind === "rec") return `({ ${record(t).join(", ")} })`;
    if (t.kind === "fun") return `Object.fromEntries(Object.entries(${v}).map(([k${depth}, ${x}]: [string, any]) => [k${depth}, ${copy(x, t.res, depth + 1)}]))`;
    return v;
  };

  // --- values in a simulated trace -----------------------------------------------
  /** A value from a Quint trace (ITF) as the generated TypeScript represents it. */
  const decode = (t0: Json, v: any): any => {
    const t = resolve(t0);
    if (t.kind === "int") return Number(v["#bigint"] ?? v);
    if (t.kind === "list") return v.map((x: any) => decode(t.elem, x));
    if (t.kind === "set") return v["#set"].map((x: any) => decode(t.elem, x));
    if (t.kind === "rec") return Object.fromEntries(fields(t).map((f) => [f.fieldName, decode(f.fieldType, v[f.fieldName])]));
    if (t.kind === "fun") return Object.fromEntries(v["#map"].map(([k, x]: [any, any]) => ["$" + decode(t.arg, k), decode(t.res, x)]));
    if (tagged(t)) {
      const carried = payload(fields(t).find((f) => f.fieldName === v.tag)!);
      return { tag: v.tag, ...(carried ? decode(carried, v.value) : {}) };
    }
    return t.kind === "sum" ? v.tag : v;
  };
  /** The same value with every set in a fixed order, so that two sets compare equal however they were built. */
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

  return { fields, resolve, shape, payload, tagged, isScalar, named, ownerOf, typeName, tsType, declaration, qType, wellFormed, copy, decode, canon };
}
export type Types = ReturnType<typeof typeWalks>;
