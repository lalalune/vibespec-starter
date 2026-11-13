// AGENTS.md, "Conformance": spec/index.md against the shell of src/tasks.vibe, observed as the list its store holds.
import { Effect, Layer } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { effectDriver } from "vibestack/testing";
import type { Event, Tasks } from "../../gen/index.ts";
import { TaskList, load, stored } from "../../src/tasks.vibe";

export const driver = effectDriver<Event, Tasks, TaskList | KeyValueStore.KeyValueStore, never>(Layer.provideMerge(stored, KeyValueStore.layerMemory), {
  dispatch: (_key, event) => TaskList.use((list) => list.send(event)).pipe(Effect.as("accepted" as const), Effect.catchTag("Rejected", () => Effect.succeed("refused" as const))),
  observe: () => load(),
});

/** One list, so one key. */
export const options = { keys: ["tasks"] };
