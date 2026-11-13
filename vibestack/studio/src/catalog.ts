// The component catalog `vibestack/stories/cli.ts gen` writes (vibestack/stories/meta.ts declares the same shape),
// as the server (project.ts) collects it and the Components view (page/Components.tsx) shows it.
export interface ComponentIndex {
  version: 1;
  storybook: { url?: string };
  components: Component[];
}
export interface Component {
  id: string;
  name: string;
  package: string;
  title: string;
  description: string;
  source: { file: string; line: number };
  props: Prop[];
  stories: Story[];
  model?: { spec: string; module: string; state: string; events: string[] };
  design?: string[];
  diagnostics: string[];
}
export interface Prop {
  name: string;
  kind: "boolean" | "number" | "string" | "union" | "function" | "node" | "object" | "array" | "unknown";
  required: boolean;
  options?: (string | number | boolean)[];
  default?: unknown;
  description?: string;
}
export interface Story {
  id: string;
  name: string;
  kind: "default" | "prop" | "state" | "example" | "model";
  args: Record<string, unknown>;
}
