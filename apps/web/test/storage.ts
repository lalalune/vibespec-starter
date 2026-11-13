// The one fake of the tests: a store at its limits, which no real localStorage can be brought to on request.
import { Effect, Layer } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";

/**
 * `store`, answering a turn later, as a store over a network does, and only its first `reads` reads and `writes`
 * writes: every later one fails, as an unreadable or a full localStorage does.
 */
export const limited = (store: Layer.Layer<KeyValueStore.KeyValueStore>, { reads = Infinity, writes = Infinity }) =>
  Layer.provide(Layer.effect(KeyValueStore.KeyValueStore, Effect.gen(function* () {
    const real = yield* KeyValueStore.KeyValueStore;
    const within = <A>(left: number, method: string, key: string, answer: Effect.Effect<A, KeyValueStore.KeyValueStoreError>) =>
      Effect.andThen(Effect.yieldNow, left > 0 ? answer : Effect.fail(new KeyValueStore.KeyValueStoreError({ message: "at its limit", method, key })));
    return { ...real, get: (key) => within(reads--, "get", key, real.get(key)), set: (key, value) => within(writes--, "set", key, real.set(key, value)) };
  })), store);
