// Test helpers for what Effect leaves to the test. Effect already has the rest: `Layer.mock(Service, partial)` for a
// service from a partial implementation, `Random.withSeed(seed)` for fixed randomness, and the TestClock that
// `it.effect` provides, which `advance` and `interrupted` move.
import { Cause, Effect, Exit, Fiber, type Duration } from "effect";
import { TestClock } from "effect/testing";

export * from "./conformance.ts";
export * from "./properties.ts";

/** The value of a success; a failure throws with its whole cause. */
export function succeeded<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`expected a success, but got\n${Cause.pretty(exit.cause)}`);
}

/** The typed error of a failure; a success, a defect or an interruption throws, a cause with its whole text. */
export function failed<A, E>(exit: Exit.Exit<A, E>): E {
  if (Exit.isSuccess(exit)) throw new Error(`expected a typed failure, but it succeeded with ${JSON.stringify(exit.value)}`);
  const error = Cause.findErrorOption(exit.cause);
  if (error._tag === "Some") return error.value;
  throw new Error(`expected a typed failure, but got\n${Cause.pretty(exit.cause)}`);
}

/** `effect`, except that its first `times` runs fail with `error`: what a retry or a fallback must survive. */
export function failFirst<X>(times: number, error: X) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | X, R> => {
    let runs = 0;
    return Effect.suspend((): Effect.Effect<A, E | X, R> => runs++ < times ? Effect.fail(error) : effect);
  };
}

/** Start `effect`, move the TestClock by `duration`, and give its result: a timeout or schedule without waiting. */
export const advance = <A, E, R>(effect: Effect.Effect<A, E, R>, duration: Duration.Input) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust(duration);
    return yield* Fiber.join(fiber);
  });

/**
 * Start `effect`, move the TestClock by `after`, and interrupt it. Returns once its finalizers have run, so the test
 * asserts on what they left; fails if `effect` had already ended or its finalizers died.
 */
export const interrupted = <A, E, R>(effect: Effect.Effect<A, E, R>, after: Duration.Input = 0) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust(after);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Effect.exit(Fiber.join(fiber));
    if (Exit.isSuccess(exit)) throw new Error(`expected an interruption, but it had succeeded with ${JSON.stringify(exit.value)}`);
    if (!Cause.hasInterruptsOnly(exit.cause)) throw new Error(`expected only an interruption, but got\n${Cause.pretty(exit.cause)}`);
  });
