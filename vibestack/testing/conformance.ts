// Vitest tests over a spec's generated gen/<name>.conformance.ts (AGENTS.md, "Conformance"): every saved
// counterexample first, as regressions, then the journeys and seeded walks. generate.ts writes the call.
import { afterAll, describe, it } from "@effect/vitest";
import { ManagedRuntime, type Effect, type Layer } from "effect";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ConformanceError, Driver, Options, Outcome, Trace } from "../conformance.ts";
import { fuzz } from "./properties.ts";

/** What gen/<name>.conformance.ts exports. */
export interface Machine<E, V, S> {
  /** Empty until `check` has simulated the spec: `gen` alone writes no events. */
  found: { events: unknown[] };
  conformance(driver: Driver<E, V>, options?: Options<S, V>): Promise<unknown>;
  replay(driver: Driver<E, V>, trace: Trace<E>, options?: Options<S, V>): Promise<void>;
}

export interface Suite<S, V> extends Options<S, V> {
  /** Where counterexamples are kept: the package's `test/counterexamples/<spec>`. */
  dir: string;
}

/**
 * Replay each `dir/*.json`, then run `machine.conformance` with seed `FUZZ_SEED` and, unless `walks` says how many,
 * `FUZZ_RUNS` walks. A disagreement is saved to `dir` under a name made from its shrunk trace, so the same one is
 * saved once and replayed from then on.
 */
export function conformanceTests<E, V, S>(spec: string, machine: Machine<E, V, S>, driver: Driver<E, V> & Partial<AsyncDisposable>, { dir, ...options }: Suite<S, V>) {
  dir = path.resolve(dir);
  const seed = options.seed ?? fuzz.seed, walks = options.walks ?? fuzz.runs;
  // `check` runs the tests again after it has written the events (vibestack/util.ts, tests), so nothing is lost.
  const simulated = it.skipIf(!machine.found.events.length), needs = machine.found.events.length ? "" : ": needs the events `pnpm check` writes";
  describe(`${spec} conforms to its spec`, () => {
    afterAll(() => driver[Symbol.asyncDispose]?.());
    for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [])
      simulated(`counterexample ${file}${needs}`, () => machine.replay(driver, JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).trace, options));
    simulated(`journeys and ${walks} walks of seed ${seed}${needs}`, async () => {
      try {
        await machine.conformance(driver, { ...options, seed, walks });
      } catch (error) {
        // The generated module throws its own copy of the class (gen/_conformance.ts), so it is known by name.
        if (!(error instanceof Error) || error.name !== "ConformanceError") throw error;
        const { trace, origin } = error as ConformanceError<E>;
        const file = path.join(dir, `${createHash("sha256").update(JSON.stringify(trace)).digest("hex").slice(0, 12)}.json`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify({ origin, seed, trace }, null, 2)}\n`);
        throw new Error(`${error.message}\nSeed: ${seed}\nSaved as ${file}, which is replayed first from now on.`, { cause: error });
      }
    });
  });
}

/** How an application written with Effect is reached; `R` is what `layer` provides. */
export interface EffectDriver<E, V, R> {
  dispatch(key: string, event: E, by?: unknown): Effect.Effect<Outcome, unknown, R>;
  observe(key: string): Effect.Effect<V, unknown, R>;
  observeOutput?(key: string): Effect.Effect<unknown, unknown, R>;
}

/**
 * A driver from Effect code. Each `reset` releases the runtime and builds `layer` again, so every trace starts from
 * a fresh application and its finalizers run; a layer with `TestClock.layer()` lets the driver move time.
 */
export function effectDriver<E, V, R, LE>(layer: Layer.Layer<R, LE>, app: EffectDriver<E, V, R>): Driver<E, V> & AsyncDisposable {
  let runtime = ManagedRuntime.make(layer);
  const observeOutput = app.observeOutput?.bind(app);
  return {
    reset: async () => { await runtime.dispose(); runtime = ManagedRuntime.make(layer); },
    dispatch: (key, event, by) => runtime.runPromise(app.dispatch(key, event, by)),
    observe: (key) => runtime.runPromise(app.observe(key)),
    ...observeOutput && { observeOutput: (key: string) => runtime.runPromise(observeOutput(key)) },
    [Symbol.asyncDispose]: () => runtime.dispose(),
  };
}
