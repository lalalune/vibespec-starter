import { createRoot } from "react-dom/client";
import { Components, type ComponentIndex } from "./components.tsx";
import "./components.css";

const project = new URLSearchParams(location.search).get("project") ?? "";
const query = new URLSearchParams({ project });
const root = createRoot(document.getElementById("root")!);
const response = await fetch(`/api/components?${query}`);
if (!response.ok) throw new Error(`Components: ${response.status}`);
const index = await response.json() as ComponentIndex;
const source = (file: string) => `/api/component-source?${new URLSearchParams({ project, file })}`;
root.render(<main className="flex h-screen flex-col gap-4 p-6">
  <a className="text-sm text-primary underline" href={`/?${query}`}>Specs</a>
  <Components index={index} openSpec={(file) => {
    if (file.startsWith("spec/")) location.href = `/?${new URLSearchParams({ project, spec: file })}`;
    else window.open(source(file), "_blank", "noopener");
  }} openSource={(file) => window.open(source(file), "_blank", "noopener")} />
</main>);
