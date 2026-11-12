// The unverified shell around the notifier. The model (`notify` in
// gen/tracker.ts) decides which notes are owed; this file reads owners cells
// as typed, turns one pass's notes into chat messages, one per person, and
// hands them to whatever posts to the chat app. It touches the outside world,
// so it is plain TypeScript without proof annotations and is tested, not
// proved.
import type { Note } from "../gen/tracker.ts";

/** The people named in an owners cell as typed by hand: `"Ana, ben,, ana"` is `["ana", "ben"]`. */
export function namesInCell(cell: string): string[] {
  const names = cell.split(",").map((n) => n.trim().toLowerCase()).filter((n) => n !== "");
  return [...new Set(names)];
}

export interface Message { to: string; handle: string; text: string }

function line(n: Note): string {
  switch (n.kind) {
    case "Update": return `Task #${n.task} was changed.`;
    case "Soon": return `Task #${n.task} is due on day ${n.version}.`;
    case "Today": return `Task #${n.task} is due today.`;
  }
}

/**
 * One message per person, in the order people first appear, each listing a
 * note once however often it was planned. People with no chat handle are
 * skipped.
 */
export function messages(notes: Note[], handles: Record<string, string>): Message[] {
  const byPerson = new Map<string, string[]>();
  for (const n of notes) {
    if (!handles[n.to]) continue;
    const lines = byPerson.get(n.to) ?? [];
    const text = line(n);
    if (!lines.includes(text)) lines.push(text);
    byPerson.set(n.to, lines);
  }
  return [...byPerson].map(([to, lines]) => ({ to, handle: handles[to]!, text: lines.join("\n") }));
}

/** Send one pass's notes; returns how many messages went out. */
export async function send(notes: Note[], handles: Record<string, string>, post: (handle: string, text: string) => Promise<void>): Promise<number> {
  const out = messages(notes, handles);
  for (const m of out) await post(m.handle, m.text);
  return out.length;
}
