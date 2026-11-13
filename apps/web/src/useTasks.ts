// AGENTS.md, "The React interface": the list a `TaskList` holds, and the events `enabled` allows, for a component.
import { Cause, Effect, Exit, type ManagedRuntime, Stream } from "effect";
import { useMemo, useSyncExternalStore } from "react";
import { type Event, type Tasks, enabled } from "../gen/index.effect.vibe";
import { TaskList } from "./tasks.vibe";

/** What `stored` of tasks.vibe provides, over any store. */
export type Runtime = ManagedRuntime.ManagedRuntime<TaskList, unknown>;

export function useTasks(runtime: Runtime) {
  const store = useMemo(() => {
    let tasks: Tasks | "unreadable" | undefined;
    const show = (next: typeof tasks, notify: () => void) => { tasks = next; notify(); };
    return {
      get: () => tasks,
      subscribe: (notify: () => void) => {
        const fiber = runtime.runFork(TaskList.use((list) => Stream.runForEach(list.changes, (next) => Effect.sync(() => show(next, notify)))));
        fiber.addObserver((exit) => { if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) show("unreadable", notify); });
        return () => fiber.interruptUnsafe();
      },
    };
  }, [runtime]);
  const tasks = useSyncExternalStore(store.subscribe, store.get);
  return {
    /** Undefined until the stored list has been read, "unreadable" if it cannot be. */
    tasks,
    can: (event: Event) => typeof tasks === "object" && enabled(tasks, event),
    send: (event: Event) => runtime.runPromiseExit(TaskList.use((list) => list.send(event))),
  };
}
