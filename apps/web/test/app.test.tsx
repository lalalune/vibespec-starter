import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Layer, ManagedRuntime } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { afterEach, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { stored } from "../src/tasks.vibe";

/** The application as main.tsx starts it, on happy-dom's localStorage; the result closes it. */
const open = () => {
  const runtime = ManagedRuntime.make(Layer.provide(stored, KeyValueStore.layerStorage(() => localStorage)));
  const view = render(<App runtime={runtime} />);
  return async () => { view.unmount(); await runtime.dispose(); };
};
const storedList = (): unknown => JSON.parse(localStorage.getItem("tasks") ?? "null");

afterEach(() => { cleanup(); localStorage.clear(); });

// spec/index.md, "Story: Keep a short list"
it("Keep a short list", async () => {
  const user = userEvent.setup();
  const close = open();
  const title = await screen.findByRole("textbox", { name: "New task" });
  const addButton = screen.getByRole<HTMLButtonElement>("button", { name: "Add" });
  const add = async (name: string) => { await user.type(title, name); await user.click(addButton); };
  const box = (name: string) => screen.findByRole<HTMLButtonElement>("checkbox", { name: `Complete ${name}` });

  expect(addButton.disabled).toBe(true);
  for (const name of ["bread", "milk", "eggs"]) { await add(name); await box(name); }
  // spec/index.md, "A new task needs a title no other task has, and room among the open ones"
  await user.type(title, "tea");
  expect(addButton.disabled).toBe(true);

  // spec/index.md, "Only an open task can be completed, and it is then done"
  await user.click(await box("bread"));
  await expect.poll(async () => (await box("bread")).disabled).toBe(true);
  await user.click(addButton);
  await box("tea");

  // spec/index.md, "Any task on the list can be removed, open or done"
  await user.click(screen.getByRole("button", { name: "Remove milk" }));
  const list = { open: ["eggs", "tea"], done: ["bread"] };
  await expect.poll(storedList).toEqual(list);

  await close();
  const closeAgain = open();
  expect([(await box("eggs")).disabled, (await box("bread")).disabled, storedList()]).toEqual([false, true, list]);
  await closeAgain();
});
