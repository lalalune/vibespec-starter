// A deliberately wrong application: one lamp shared by every key, so the conformance run must find and save a counterexample.
import type { Driver } from "../../../../../../conformance.ts";

let shared = { mode: "Off", flips: 0 };
export const driver: Driver<{ type: "toggle" }, typeof shared> = {
  reset: () => { shared = { mode: "Off", flips: 0 }; },
  dispatch: () => {
    if (shared.flips >= 3) return "refused";
    shared = { mode: shared.mode === "On" ? "Off" : "On", flips: shared.flips + 1 };
    return "accepted";
  },
  observe: () => shared,
};
