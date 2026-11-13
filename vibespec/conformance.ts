// Copied into gen/ by `spec gen`, beside each spec's <name>.conformance.ts: runs the real application against its
// spec, with the generated module as the oracle (AGENTS.md, "Conformance"). It needs no test runner: it throws.

/** What the application did with an event. Anything else (a crash, a 500, a timeout) must throw. */
export type Outcome = "accepted" | "refused";

/** The only hand-written part: how to reach the real application. It may import the spec's types, never its code. */
export interface Driver<E, V> {
  /** Start from a fresh application: empty storage, nothing created. */
  reset(): void | Promise<void>;
  /**
   * Send `event` for the entity `key` through the application's own entry point, and say what it did. `by` is who
   * sent it, when the spec's transitions take a sender: sign in or open a session as them.
   */
  dispatch(key: string, event: E, by?: unknown): Outcome | Promise<Outcome>;
  /** What the application now holds or shows for `key`, read back through its own storage or interface. */
  observe(key: string): V | Promise<V>;
  /** Effects exposed by the application after its most recent dispatch, when it exposes them. */
  observeOutput?(key: string): unknown | Promise<unknown>;
}

export interface Options<S, V> {
  /** What of the spec's state the driver can observe; without it, `observe` returns the whole state. */
  view?: (state: S) => V;
  /** Entities the walks interleave, so that one leaking into another shows; one key for an application of one. */
  keys?: string[];
  /** Random walks after the journeys; 0 runs the journeys only, as a slow driver (a browser) should. */
  walks?: number;
  steps?: number;
  seed?: number;
}

/** What the generated `gen/<name>.ts` gives the check. */
export interface Oracle<S, E> {
  initial: S;
  enabled(state: S, event: E, by?: any): boolean;
  step(state: S, event: E, by?: any): S | { state: S; out: unknown };
  parseState(raw: unknown): S | undefined;
  parseEvent(raw: unknown): E | undefined;
  parseSender?(raw: unknown): unknown;
}

/**
 * What `npm run check` found for one spec: the events the simulator took or tried a guard with, a shortest journey to
 * each `sometimes` rule, and where the state holds sets. An event that came from someone carries them as `by`.
 */
export interface Found<E> {
  spec: string;
  source: string;
  sender: boolean;
  events: Sent<E>[];
  journeys: { story: string; rule: string; events: Sent<E>[] }[];
  shape: ComparisonShape;
  outputShape?: ComparisonShape;
  traces?: Sent<E>[][];
}
export type Sent<E> = E & { by?: unknown };

type Trace<E> = [key: string, sent: Sent<E>][];

/** Run the journeys, then seeded random walks; throw at the first disagreement, shrunk to the fewest events that show it. */
export async function check<S, E, V>(oracle: Oracle<S, E>, found: Found<E>, driver: Driver<E, V>, options: Options<S, V> = {}) {
  const { view, keys = ["a", "b"], walks = 200, steps = 20, seed = 1 } = options;
  if (!found.events.length) throw new Error(`gen/${found.spec}.conformance.ts holds no events yet: \`npm run check\` writes them`);
  if (!keys.length || keys.some((key) => typeof key !== "string" || !key) || new Set(keys).size !== keys.length) throw new Error("conformance keys must be distinct nonempty strings");
  for (const [name, count] of Object.entries({ walks, steps, seed })) if (!Number.isSafeInteger(count) || count < 0) throw new Error(`conformance ${name} must be a nonnegative safe integer`);
  const seen = new Set<string>();
  const outcomes = new Set<Outcome>();

  /** The first way the application differs from the spec along `trace`, or undefined. */
  const differ = async (trace: Trace<E>): Promise<string | undefined> => {
    await driver.reset();
    const model = new Map<string, S>();
    for (const key of keys) {
      const raw = await driver.observe(key);
      const problem = compareObservation(oracle, found, oracle.initial, raw, view);
      if (problem) return `initial ${key}: ${problem}`;
    }
    for (const [i, [key, sent]] of trace.entries()) {
      const at = `event ${i + 1}, ${key} ${show(sent)}`;
      const { by, ...rawEvent } = sent as Sent<E> & Record<string, unknown>;
      const before = model.get(key) ?? oracle.initial;
      const applied = transition(oracle, found, before, rawEvent, by);
      if (typeof applied === "string") return `${at}: ${applied}`;
      const { event, allowed, after, out } = applied;
      const did = await driver.dispatch(key, event, by);
      if (did !== "accepted" && did !== "refused") return `${at}: dispatch returned ${show(did)}; it returns "accepted" or "refused" and throws otherwise`;
      outcomes.add(did);
      if (allowed !== (did === "accepted")) return `${at}: the spec ${allowed ? "allows" : "refuses"} it, the application ${did} it`;
      if (found.outputShape && driver.observeOutput) {
        const actual = await driver.observeOutput(key);
        if (canonical(actual, found.outputShape) !== canonical(out, found.outputShape)) return `${at}: emitted effects differ from the spec`;
      }
      model.set(key, after);
      for (const [k, state] of model) {
        const raw = await driver.observe(k);
        const problem = compareObservation(oracle, found, state, raw, view);
        if (problem) return `${at}: ${k} ${problem}`;
        seen.add(canonical(raw, view ? "scalar" : found.shape));
      }
    }
  };
  /** Drop events while the disagreement stays: any subsequence is still a test, since the spec also says what is refused. */
  const fail = async (what: string, trace: Trace<E>) => {
    for (let i = trace.length - 1; i >= 0; i--) {
      const shorter = trace.toSpliced(i, 1);
      if (await differ(shorter)) trace = shorter;
    }
    const lines = trace.map(([k, e]) => `  ${k} ${show(e)}`).join("\n");
    throw new Error(`conformance to ${found.source}: ${what}, shrunk to ${trace.length} events:\n${lines}\n${await differ(trace)}`);
  };

  for (const j of found.journeys) {
    const trace: Trace<E> = j.events.map((e) => [keys[0], e]);
    if (await differ(trace)) await fail(`journey "${j.story}" / "${j.rule}"`, trace);
  }
  // A walk mostly takes events the spec allows, so that it reaches deep states, and sometimes any event, so that refusals are tried.
  const random = rng(seed);
  for (let w = 0; w < walks; w++) {
    const model = new Map<string, S>();
    const trace: Trace<E> = [];
    for (let i = 0; i < steps; i++) {
      const key = keys[Math.floor(random() * keys.length)];
      const state = model.get(key) ?? oracle.initial;
      const allowed = found.events.filter(({ by, ...e }) => oracle.enabled(state, e as E, by));
      const pool = allowed.length && random() < 0.75 ? allowed : found.events;
      const sent = pool[Math.floor(random() * pool.length)];
      const { by, ...event } = sent;
      trace.push([key, sent]);
      const after = transition(oracle, found, state, event, by);
      if (typeof after === "string") throw new Error(after);
      model.set(key, after.after);
    }
    if (await differ(trace)) await fail(`walk ${w + 1} of seed ${seed}`, trace);
  }

  return { journeys: found.journeys.length, walks, observed: seen.size, outcomes: [...outcomes], effects: found.outputShape ? driver.observeOutput ? "checked" : "not observed" : "none" };
}

/** The state type, resolved by the generator so sets are sorted only in the variant that owns them. */
export type ComparisonShape = "scalar" | { set: ComparisonShape } | { list: ComparisonShape } | { map: ComparisonShape } | { fields: Record<string, ComparisonShape> } | { variants: Record<string, ComparisonShape> };

export function canonical(value: unknown, shape: ComparisonShape): string {
  const sort = (value: any, shape: ComparisonShape): any => {
    if (shape !== "scalar" && "variants" in shape) shape = shape.variants[value?.tag] ?? "scalar";
    if (Array.isArray(value)) {
      const element = shape !== "scalar" && "set" in shape ? shape.set : shape !== "scalar" && "list" in shape ? shape.list : "scalar";
      const items = value.map((item) => sort(item, element));
      return shape !== "scalar" && "set" in shape ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key,
      sort(value[key], shape !== "scalar" && "fields" in shape ? shape.fields[key] ?? "scalar" : shape !== "scalar" && "map" in shape ? shape.map : "scalar")]));
    return value;
  };
  const result = JSON.stringify(sort(value, shape));
  if (result === undefined) throw new Error("an observation must be a JSON value");
  return result;
}

const show = (x: unknown) => JSON.stringify(x) ?? String(x);

/** A small seeded generator, so that a walk repeats exactly. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** A recorded line either starts from a state or applies an event; state observations may be sparse. */
export interface Line { event?: unknown; by?: unknown; state?: unknown; out?: unknown }

/** Validate an input once for both driver and recorded-trace conformance. */
export function transition<S, E>(oracle: Oracle<S, E>, found: Found<E>, before: S, raw: unknown, by: unknown): { event: E; allowed: boolean; after: S; out?: unknown } | string {
  const event = oracle.parseEvent(raw);
  if (event === undefined) return `${show(raw)} is not an event of the spec`;
  if (found.sender ? by === undefined || !oracle.parseSender || oracle.parseSender(by) === undefined : by !== undefined)
    return found.sender ? "the event needs a valid sender" : "the spec's events have no sender";
  const result = oracle.step(before, event, by);
  return { event, allowed: oracle.enabled(before, event, by), after: found.outputShape ? (result as { state: S }).state : result as S, ...(found.outputShape ? { out: (result as { out: unknown }).out } : {}) };
}

/** Compare what the real application exposed, keeping sets independent of their iteration order. */
export function compareObservation<S, E, V>(oracle: Oracle<S, E>, found: Found<E>, expected: S, raw: unknown, view?: (state: S) => V): string | undefined {
  const actual = view ? raw : oracle.parseState(raw);
  if (actual === undefined) return `reads back as ${show(raw)}, which is not a state the spec allows`;
  const want = canonical(view ? view(expected) : expected, view ? "scalar" : found.shape);
  const have = canonical(actual, view ? "scalar" : found.shape);
  return want === have ? undefined : `should be ${want}, but the application has ${have}`;
}

/** The first disagreement in a recorded trace. At least one real state must have been observed. */
export function departure<S, E>(oracle: Oracle<S, E>, found: Found<E>, lines: unknown[]): { line: number; why: string } | undefined {
  let current = oracle.initial;
  let observed = 0;
  for (const [i, raw] of lines.entries()) {
    const fail = (why: string) => ({ line: i + 1, why });
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["event", "by", "state", "out"].includes(key)))
      return fail(`${show(raw)} is not {event?, by?, state?, out?}`);
    const line = raw as Line;
    if (line.event === undefined) {
      if (line.by !== undefined || Object.hasOwn(line, "out")) return fail("a start line has no sender or emitted effects");
      if (Object.hasOwn(line, "state")) {
        const state = oracle.parseState(line.state);
        if (state === undefined) return fail(`the program starts from an invalid state ${show(line.state)}`);
        current = state;
        observed++;
      } else current = oracle.initial;
      continue;
    }
    const applied = transition(oracle, found, current, line.event, line.by);
    if (typeof applied === "string") return fail(applied);
    current = applied.after;
    if (Object.hasOwn(line, "out")) {
      if (!found.outputShape) return fail("this spec does not emit effects");
      if (canonical(line.out, found.outputShape) !== canonical(applied.out, found.outputShape)) return fail("emitted effects differ from the spec");
    }
    if (Object.hasOwn(line, "state")) {
      observed++;
      const problem = compareObservation(oracle, found, current, line.state);
      if (problem) return fail(problem);
    }
  }
  if (!observed) return { line: Math.max(1, lines.length), why: "the trace contains no observed state" };
}
