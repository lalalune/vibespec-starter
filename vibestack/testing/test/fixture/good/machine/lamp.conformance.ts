// What `spec gen` writes as gen/lamp.conformance.ts (vibestack/conform.ts, writeConformance), over the tool's own runtime.
import { check, replay as replayTrace, type Driver, type Found, type Options, type Trace } from "../../../../../conformance.ts";
import * as oracle from "./lamp.ts";
export { ConformanceError } from "../../../../../conformance.ts";

export const found: Found<oracle.Event> = {
  spec: "lamp", source: "spec/lamp.md", sender: false, events: [{ type: "toggle" }],
  journeys: [{ story: "Story: Switch a lamp", rule: "A lamp is on or off, and counts how often it was switched", events: [{ type: "toggle" }] }],
  shape: { fields: { mode: "scalar", flips: "scalar" } },
};
export const conformance = <V = oracle.Lamp>(driver: Driver<oracle.Event, V>, options?: Options<oracle.Lamp, V>) => check(oracle, found, driver, options);
export const replay = <V = oracle.Lamp>(driver: Driver<oracle.Event, V>, trace: Trace<oracle.Event>, options?: Options<oracle.Lamp, V>) => replayTrace(oracle, found, driver, trace, options);
