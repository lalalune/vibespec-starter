// Properties of an Effect Schema, and of a function under a declared contract, checked by Effect's own Arbitrary
// runner. generate.ts writes a test for each from `src/**/*.schema.ts` and `src/**/*.contract.ts`.
import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Equal, Schema } from "effect";

function budget(name: string, fallback: number) {
  const n = Number(globalThis.process?.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a nonnegative whole number`);
  return n;
}

/** How many values a property sees and the seed they come from: `FUZZ_RUNS` and `FUZZ_SEED`. */
export const fuzz = { runs: budget("FUZZ_RUNS", 100), seed: budget("FUZZ_SEED", 1) };

/** Where a property's values come from. */
export type Source<A> = Schema.Schema<A> | Arbitrary.Arbitrary<A>;

/**
 * Check `property` on `fuzz.runs` values of `source`, in an `it.effect`. A failure carries the shrunk counterexample,
 * the seed and the command that repeats it.
 */
export const holds = <A>(source: Source<A>, property: (value: A) => boolean, options: Arbitrary.CheckOptions = fuzz) =>
  Arbitrary.checkEffect(
    Arbitrary.isArbitrary(source) ? source : Arbitrary.schema(source),
    // A property that throws is falsified by its cause, as in @effect/vitest's it.prop.
    (value) => Effect.catchCause(Effect.sync(() => property(value)), (cause) => Effect.fail(cause)),
    options,
  ).pipe(Effect.flatMap((result) => {
    const failure = Arbitrary.formatCheckFailure(result);
    if (failure === undefined) return Effect.void;
    const { runs = fuzz.runs, seed = fuzz.seed } = options;
    return Effect.die(new Error(`${failure}\nSeed: ${seed}\nRerun: FUZZ_SEED=${seed} FUZZ_RUNS=${runs} pnpm vitest run ${expect.getState().testPath ?? ""}`));
  }));

/** Every generated value passes the schema's own checks. */
export const validates = <A>(schema: Schema.Schema<A>) => Schema.is(schema);

/** Decoding what was encoded gives the value back. */
export function roundTrips<A, I>(schema: Schema.Codec<A, I>) {
  const same = Schema.toEquivalence(schema), encode = Schema.encodeSync(schema), decode = Schema.decodeUnknownSync(schema);
  return (value: A) => same(decode(encode(value)), value);
}

/** Encoding is stable: a value that went through its encoding and back encodes as it did before. */
export function encodesStably<A, I>(schema: Schema.Codec<A, I>) {
  const encode = Schema.encodeSync(schema), decode = Schema.decodeUnknownSync(schema);
  return (value: A) => { const once = encode(value); return Equal.equals(encode(decode(once)), once); };
}

/** Applying `f` twice is applying it once. */
export const idempotent = <A>(f: (input: A) => A) => (input: A) => { const once = f(input); return Equal.equals(f(once), once); };

/** `f` gives equal outputs for the same input. */
export const deterministic = <A, B>(f: (input: A) => B) => (input: A) => Equal.equals(f(input), f(input));

/** `rule` holds of every input and what `f` makes of it. */
export const invariant = <A, B>(f: (input: A) => B, rule: (input: A, output: B) => boolean) => (input: A) => rule(input, f(input));

/** `back` undoes `f`. */
export const inverse = <A, B>(f: (input: A) => B, back: (output: B) => A) => (input: A) => Equal.equals(back(f(input)), input);

/** What a `*.contract.ts` module says of one function: its inputs and the properties that must hold of it. */
export interface Contract<A, B> {
  input: Source<A>;
  run: (input: A) => B;
  deterministic?: boolean;
  /** Only where `run` returns what it takes. */
  idempotent?: boolean;
  invariant?: (input: A, output: B) => boolean;
  inverse?: (output: B) => A;
}

const CONTRACT = "~vibestack/testing/Contract";
export const contract = <A, B>(declared: Contract<A, B>) => ({ ...declared, [CONTRACT]: true }) as Contract<A, B>;
export const isContract = (u: unknown): u is Contract<any, any> => typeof u === "object" && u !== null && CONTRACT in u;

/** The properties `c` declares, by name: generate.ts writes one `contractTest` for each. */
export const declared = <A, B>(c: Contract<A, B>): Record<string, ((input: A) => boolean) | undefined> => ({
  deterministic: c.deterministic ? deterministic(c.run) : undefined,
  idempotent: c.idempotent ? idempotent(c.run as unknown as (input: A) => A) : undefined,
  invariant: c.invariant && invariant(c.run, c.invariant),
  inverse: c.inverse && inverse(c.run, c.inverse),
});

export function contractTest<A, B>(name: string, c: Contract<A, B>, property: string) {
  it.effect(`${name} is ${property}`, () => holds(c.input, declared(c)[property] ?? (() => { throw new Error(`${name} declares no ${property} property`); })));
}

export function schemaTests<A, I>(name: string, schema: Schema.Codec<A, I>) {
  it.effect(`${name}: every generated value validates`, () => holds(schema, validates(schema)));
  it.effect(`${name}: decoding what was encoded gives the value back`, () => holds(schema, roundTrips(schema)));
  it.effect(`${name}: encoding is stable`, () => holds(schema, encodesStably(schema)));
}
