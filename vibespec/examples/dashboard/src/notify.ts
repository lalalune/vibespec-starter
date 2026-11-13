// spec/tracker.md, "One pass of the notifier sends everything that is due and records that it was sent"; test/notify.test.ts
import type { Note, Tracker } from "../gen/tracker.ts";

const LINE: Record<Note["kind"], (n: Note) => string> = {
  Update: (n) => `✎ #${n.task} changed`,
  Soon: (n) => `⏳ #${n.task} due day ${n.version}`,
  Today: (n) => `⚠ #${n.task} due today`,
};

export async function send(before: Tracker, after: Tracker, handles: Map<string, string>, post: (handle: string, text: string) => Promise<void>): Promise<number> {
  const byHandle = new Map<string, string[]>();
  for (const n of after.sent.slice(before.sent.length)) {
    const handle = handles.get(n.to);
    if (handle) byHandle.set(handle, [...(byHandle.get(handle) ?? []), LINE[n.kind](n)]);
  }
  for (const [handle, lines] of byHandle) await post(handle, lines.join("\n"));
  return byHandle.size;
}
