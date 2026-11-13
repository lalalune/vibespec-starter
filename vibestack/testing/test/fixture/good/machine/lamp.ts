// A hand-written oracle in the shape of a generated gen/<name>.ts, for vibestack/fixtures/lamp.md with a fuse:
// the fixture's tests copy this directory to gen/, which Git ignores.
export interface Lamp { mode: "On" | "Off"; flips: number }
export type Event = { type: "toggle" };

export const initial: Lamp = { mode: "Off", flips: 0 };
export const enabled = (lamp: Lamp, _: Event) => lamp.flips < 3;
export const step = (lamp: Lamp, event: Event): Lamp => enabled(lamp, event) ? { mode: lamp.mode === "On" ? "Off" : "On", flips: lamp.flips + 1 } : lamp;

export function parseEvent(raw: unknown): Event | undefined {
  return typeof raw === "object" && raw !== null && "type" in raw && raw.type === "toggle" ? { type: "toggle" } : undefined;
}
export function parseState(raw: unknown): Lamp | undefined {
  const lamp = raw as Lamp | null;
  return typeof lamp === "object" && lamp !== null && (lamp.mode === "On" || lamp.mode === "Off") && Number.isSafeInteger(lamp.flips) && lamp.flips >= 0
    ? { mode: lamp.mode, flips: lamp.flips } : undefined;
}
