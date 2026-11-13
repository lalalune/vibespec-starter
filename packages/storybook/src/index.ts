export { generateCatalog } from "./catalog.ts";
export type { ComponentIndex, Component, Prop, Story } from "./catalog.ts";

/** Optional renderable examples and model links beside a component; inferred props need no metadata. */
export interface ComponentMeta<P = Record<string, unknown>> {
  args?: Partial<P>;
  examples?: Record<string, Partial<P>>;
  snapshot?: string[];
  model?: { spec: string; module: string; state: string; events: string[] };
  design?: string[];
}
export { storybook } from "./preset.ts";
