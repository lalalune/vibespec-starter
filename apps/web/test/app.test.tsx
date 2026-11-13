import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { afterEach, expect, it } from "vitest";
import type { Tasks } from "../gen/index.ts";
import { App } from "../src/App.tsx";
import { TaskList, stored } from "../src/tasks.vibe";
import { limited } from "./storage.ts";

const browser = KeyValueStore.layerStorage(() => localStorage);
/**
 * The application as main.tsx starts it, on happy-dom's localStorage or a `store` over it. The result closes it:
 * a page taken down has stopped following the list (src/useTasks.ts).
 */
const open = (store = browser) => {
  let following = 0;
  const followed = (changes: Stream.Stream<Tasks>) => Stream.ensuring(Stream.onStart(changes, Effect.sync(() => following++)), Effect.sync(() => following--));
  const counted = Layer.effect(TaskList, Effect.gen(function* () {
    const list = yield* TaskList;
    return { send: (event) => list.send(event), changes: followed(list.changes) };
  }));
  const runtime = ManagedRuntime.make(Layer.provide(counted, Layer.provide(stored, store)));
  const view = render(<App runtime={runtime} />);
  return async () => { view.unmount(); await expect.poll(() => following).toBe(0); await runtime.dispose(); };
};
const storedList = (): unknown => JSON.parse(localStorage.getItem("tasks") ?? "null");
const box = (name: string) => screen.findByRole<HTMLButtonElement>("checkbox", { name: `Complete ${name}` });
/** Whether the task can still be completed, and whether it shows as done. */
const task = async (name: string) => { const its = await box(name); return [!its.disabled, its.getAttribute("aria-checked")]; };
/** The title and the Add button, once the list has been read. */
const form = async () => [await screen.findByRole("textbox", { name: "New task" }), screen.getByRole<HTMLButtonElement>("button", { name: "Add" })] as const;

afterEach(() => { cleanup(); localStorage.clear(); });

// spec/index.md, "Story: Keep a short list"
it("Keep a short list", async () => {
  const user = userEvent.setup();
  const close = open();
  const [title, addButton] = await form();
  const add = async (name: string) => { await user.type(title, name); await user.click(addButton); };

  expect(addButton.disabled).toBe(true);
  for (const name of ["bread", "milk", "eggs"]) { await add(name); await box(name); }
  // spec/index.md, "A new task needs a title that is not empty and no other task has, and room among the open ones"
  await user.type(title, "tea");
  expect(addButton.disabled).toBe(true);

  // spec/index.md, "Only an open task can be completed, and it is then done"
  expect(await task("bread")).toEqual([true, "false"]);
  await user.click(await box("bread"));
  await expect.poll(() => task("bread")).toEqual([false, "true"]);
  await user.click(addButton);
  await box("tea");

  // spec/index.md, "Any task on the list can be removed, open or done"
  await user.click(screen.getByRole("button", { name: "Remove milk" }));
  const list = { open: ["eggs", "tea"], done: ["bread"] };
  await expect.poll(storedList).toEqual(list);

  await close();
  const closeAgain = open();
  expect([await task("eggs"), await task("bread"), storedList()]).toEqual([[true, "false"], [false, "true"], list]);
  await closeAgain();
});

// spec/index.md, "Story: Keep a short list"
it("Keep a short list, in a store at its limits and beside another tab", async () => {
  const user = userEvent.setup();
  const close = open(limited(browser, { writes: 1 }));
  const [title, addButton] = await form();
  await user.type(title, "bread");
  await user.click(addButton);
  await box("bread");
  await user.type(title, "milk");
  await user.click(addButton);
  await screen.findByRole("alert");
  expect([screen.queryByRole("checkbox", { name: "Complete milk" }), storedList()]).toEqual([null, { open: ["bread"], done: [] }]);

  // spec/index.md, "A new task needs a title that is not empty and no other task has, and room among the open ones"
  // Another tab has added milk: adding it here is refused, which is no failure to store, and the page catches up.
  localStorage.setItem("tasks", JSON.stringify({ open: ["bread", "milk"], done: [] }));
  await user.click(addButton);
  await box("milk");
  await expect.poll(() => screen.queryByRole("alert")).toBeNull();
  await close();

  const closeUnreadable = open(limited(browser, { reads: 0 }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("textbox")).toBeNull();
  await closeUnreadable();
});
