// AGENTS.md, "The React interface": the list a `Machine` holds, and the events `enabled` allows, for a component.
import { Effect, Fiber, type ManagedRuntime, Stream } from "effect";
import { useMemo, useSyncExternalStore } from "react";
import { type Event, type Tasks, Machine, enabled } from "../gen/index.effect.vibe";
import { TaskList } from "./tasks.vibe";

/** What `stored` of tasks.vibe provides, over any store. */
export type Runtime = ManagedRuntime.ManagedRuntime<Machine | TaskList, never>;

export function useTasks(runtime: Runtime) {
  const store = useMemo(() => {
    let tasks: Tasks | undefined;
    return {
      get: () => tasks,
      subscribe: (notify: () => void) => {
        const fiber = runtime.runFork(Machine.use((held) => Stream.runForEach(held.changes, (next) => Effect.sync(() => { tasks = next; notify(); }))));
        return () => void runtime.runFork(Fiber.interrupt(fiber));
      },
    };
  }, [runtime]);
  const tasks = useSyncExternalStore(store.subscribe, store.get);
  return {
    /** Undefined until the stored list has been read. */
    tasks,
    can: (event: Event) => tasks !== undefined && enabled(tasks, event),
    send: (event: Event) => runtime.runPromiseExit(TaskList.use((list) => list.send(event))),
  };
}
