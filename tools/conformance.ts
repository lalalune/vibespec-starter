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
  step(state: S, event: E, by?: any): S;
  parseState(raw: unknown): S | undefined;
}

/**
 * What `npm run check` found for one spec: the events the simulator took or tried a guard with, a shortest journey to
 * each `sometimes` rule, and where the state holds sets. An event that came from someone carries them as `by`.
 */
export interface Found<E> {
  spec: string;
  events: Sent<E>[];
  journeys: { story: string; rule: string; events: Sent<E>[] }[];
  sets: string[][];
}
export type Sent<E> = E & { by?: unknown };

type Trace<E> = [key: string, sent: Sent<E>][];

/** Run the journeys, then seeded random walks; throw at the first disagreement, shrunk to the fewest events that show it. */
export async function check<S, E, V>(oracle: Oracle<S, E>, found: Found<E>, driver: Driver<E, V>, options: Options<S, V> = {}) {
  const { view, keys = ["a", "b"], walks = 200, steps = 20, seed = 1 } = options;
  if (!found.events.length) throw new Error(`gen/${found.spec}.conformance.ts holds no events yet: \`npm run check\` writes them`);
  const seen = new Set<string>();
  const outcomes = new Set<Outcome>();

  /** The first way the application differs from the spec along `trace`, or undefined. */
  const differ = async (trace: Trace<E>): Promise<string | undefined> => {
    await driver.reset();
    const model = new Map<string, S>();
    for (const [i, [key, sent]] of trace.entries()) {
      const at = `event ${i + 1}, ${key} ${show(sent)}`;
      const { by, ...event } = sent as Sent<E> & Record<string, unknown>;
      const before = model.get(key) ?? oracle.initial;
      const allowed = oracle.enabled(before, event as E, by);
      const did = await driver.dispatch(key, event as E, by);
      if (did !== "accepted" && did !== "refused") return `${at}: dispatch returned ${show(did)}; it returns "accepted" or "refused" and throws otherwise`;
      outcomes.add(did);
      if (allowed !== (did === "accepted")) return `${at}: the spec ${allowed ? "allows" : "refuses"} it, the application ${did} it`;
      model.set(key, oracle.step(before, event as E, by));
      for (const [k, state] of model) {
        const raw = await driver.observe(k);
        const got = view ? raw : oracle.parseState(raw);
        if (got === undefined) return `${at}: ${k} reads back as ${show(raw)}, which is not a state the spec allows`;
        const [want, have] = [canonical(view ? view(state) : state, view ? [] : found.sets), canonical(got, view ? [] : found.sets)];
        seen.add(have);
        if (want !== have) return `${at}: the spec has ${k} = ${want}, the application ${have}`;
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
    throw new Error(`conformance to spec/${found.spec}.md: ${what}, shrunk to ${trace.length} events:\n${lines}\n${await differ(trace)}`);
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
      model.set(key, oracle.step(state, event as E, by));
    }
    if (await differ(trace)) await fail(`walk ${w + 1} of seed ${seed}`, trace);
  }
  // A driver that cannot see the application passes everything; one that saw nothing change, or never saw a refusal, is refused.
  if (seen.size < 2) throw new Error(`conformance to spec/${found.spec}.md: observe returned the same value every time, so the driver cannot see the application`);
  if (walks && outcomes.size < 2) throw new Error(`conformance to spec/${found.spec}.md: dispatch never reported both outcomes`);
  return { journeys: found.journeys.length, walks, observed: seen.size };
}

/** JSON with object keys sorted, and the arrays at `sets` (paths; `*` is any element or key) sorted too, so that two sets compare equal however they were built. */
function canonical(value: unknown, sets: string[][]): string {
  const sort = (v: unknown, path: string[]): unknown => {
    const here = sets.some((p) => p.length === path.length && p.every((s, i) => s === "*" || s === path[i]));
    if (Array.isArray(v)) {
      const items = v.map((x) => sort(x, [...path, "*"]));
      return here ? items.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)) : items;
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k], [...path, k])]));
    return v;
  };
  return JSON.stringify(sort(value, []));
}

const show = (x: unknown) => JSON.stringify(x) ?? String(x);

/** A small seeded generator, so that a walk repeats exactly. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
