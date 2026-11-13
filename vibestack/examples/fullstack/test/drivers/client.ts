// How `pnpm check` reaches a browser tab to compare it with spec/client.md (AGENTS.md, "Conformance"): every journey
// and random walks through the tab's own `dispatch`, each trace with a fresh tab. Nothing here reaches the server.
import { Effect, Layer, ManagedRuntime } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { Driver, Options } from "../../gen/client.conformance.ts";
import { Tab, open } from "../../src/web/sync.vibe";

const fresh = () => ManagedRuntime.make(Layer.provide(Layer.effect(Tab, open("http://localhost", "ann")), FetchHttpClient.layer));
let tab = fresh();

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await tab.dispose();
    tab = fresh();
  },
  dispatch: (_key, event) => tab.runPromise(Tab.use((t) => t.dispatch(event)).pipe(Effect.map((allowed) => (allowed ? "accepted" : "refused")))),
  observe: () => tab.runPromise(Tab.use((t) => t.get())),
  [Symbol.asyncDispose]: () => tab.dispose(),
};

/** One tab, so one key. */
export const options: Options = { keys: ["tab"] };
