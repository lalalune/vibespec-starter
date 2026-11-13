// The lamp application behind its spec's driver, written with Effect: each trace gets a fresh `lamps`, and the
// driver moves the TestClock past the second a switch takes to settle.
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { effectDriver } from "../../../../../index.ts";
import { Lamps, lamps, type Lamp } from "../../src/lamps.ts";

export const driver = effectDriver<{ type: "toggle" }, Lamp, Lamps | TestClock.TestClock, never>(Layer.mergeAll(lamps, TestClock.layer()), {
  dispatch: (key) => Effect.gen(function* () {
    const switching = yield* Effect.forkChild((yield* Lamps).toggle(key));
    yield* TestClock.adjust("1 second");
    return yield* Fiber.join(switching).pipe(Effect.as("accepted" as const), Effect.catchTag("Blown", () => Effect.succeed("refused" as const)));
  }),
  observe: (key) => Lamps.use((all) => all.get(key)),
});

export const options = { walks: 20, steps: 8 };
