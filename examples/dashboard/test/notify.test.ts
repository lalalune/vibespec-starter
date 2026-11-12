import assert from "node:assert/strict";
import { test } from "node:test";
import { type Note, type Tracker, create, debounce, handAddOwner, initial, notify, tick } from "../gen/tracker.ts";
import { messages, namesInCell, send } from "../src/notify.ts";

const handles = { ana: "@ana", ben: "@ben", cal: "@cal" };

test("a name typed twice is told once", async () => {
  // Ben creates task 1; then the same name is typed into its owners cell twice.
  let s: Tracker = create(initial, "ben");
  s = handAddOwner(s, 1, "ana");
  s = handAddOwner(s, 1, "ana");
  assert.deepEqual(s.tasks[0]!.owners, ["ana", "ana"]);
  for (let i = 0; i < debounce; i++) s = tick(s);
  s = notify(s);

  const sent: [string, string][] = [];
  const count = await send(s.sent, handles, async (handle, text) => { sent.push([handle, text]); });
  assert.equal(count, 1);
  assert.deepEqual(sent, [["@ana", "Task #1 was changed."]]);
});

test("the shell tells a person once even if the same note is planned twice", () => {
  const note: Note = { kind: "Update", task: 1, to: "ana", version: 0, at: 3 };
  assert.deepEqual(messages([note, note], handles), [{ to: "ana", handle: "@ana", text: "Task #1 was changed." }]);
});

test("each person gets one message listing all their notes", () => {
  const notes: Note[] = [
    { kind: "Update", task: 1, to: "ana", version: 0, at: 3 },
    { kind: "Soon", task: 2, to: "ben", version: 4, at: 3 },
    { kind: "Today", task: 2, to: "ana", version: 1, at: 3 },
  ];
  assert.deepEqual(messages(notes, handles), [
    { to: "ana", handle: "@ana", text: "Task #1 was changed.\nTask #2 is due today." },
    { to: "ben", handle: "@ben", text: "Task #2 is due on day 4." },
  ]);
});

test("people without a chat handle are skipped", () => {
  assert.deepEqual(messages([{ kind: "Update", task: 1, to: "ama", version: 0, at: 3 }], handles), []);
});

test("an owners cell is read as distinct names", () => {
  assert.deepEqual(namesInCell("Ana, ben,, ana "), ["ana", "ben"]);
  assert.deepEqual(namesInCell(""), []);
});
