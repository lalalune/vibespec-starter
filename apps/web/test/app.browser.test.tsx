import { cleanup, render, screen } from "@testing-library/react";
import { Layer, ManagedRuntime } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { App } from "../src/App.tsx";
import { stored } from "../src/tasks.vibe";

afterEach(() => { cleanup(); localStorage.clear(); });

// spec/index.md, "Story: Keep a short list"
// Adding disables the button that was clicked, and a browser then drops its focus: the application hands it to the
// title, so the next task is typed without reaching for it. The list is in the browser's own localStorage.
it("after a task is added, the next one can be typed at once", async () => {
  const runtime = ManagedRuntime.make(Layer.provide(stored, KeyValueStore.layerStorage(() => localStorage)));
  render(<App runtime={runtime} />);
  const title = await screen.findByRole("textbox", { name: "New task" });
  await userEvent.type(title, "bread");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await screen.findByRole("checkbox", { name: "Complete bread" });
  await expect.poll(() => document.activeElement).toBe(title);
  await userEvent.keyboard("milk{Enter}");
  await screen.findByRole("checkbox", { name: "Complete milk" });
  expect(JSON.parse(localStorage.getItem("tasks") ?? "null")).toEqual({ open: ["bread", "milk"], done: [] });
  await runtime.dispose();
});
