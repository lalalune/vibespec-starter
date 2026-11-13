import assert from "node:assert/strict";
import { test } from "node:test";
import { type Tracker, create, debounce, handAddOwner, initial, notify, renameOwner, tick } from "../gen/tracker.ts";
import { send } from "../src/notify.ts";

const handles = new Map([["ana", "@ana"], ["ben", "@ben"], ["cal", "@cal"]]);

function pass(s: Tracker): Tracker {
  for (let i = 0; i < debounce; i++) s = tick(s);
  return notify(s);
}

async function sent(before: Tracker, after: Tracker): Promise<[string, string][]> {
  const out: [string, string][] = [];
  assert.equal(await send(before, after, handles, async (h, t) => { out.push([h, t]); }), out.length);
  return out;
}

// spec/tracker.md, "One pass of the notifier sends everything that is due and records that it was sent"; spec/tracker.md, "A person named twice in a cell is told once"
test("each pass tells each person with a handle once, of what is new", async () => {
  let s: Tracker = handAddOwner(handAddOwner(create(renameOwner(initial, "cal", "constructor"), "ben"), 1, "ana"), 1, "ana");
  s = handAddOwner(handAddOwner(create(s, "ben"), 2, "ana"), 2, "constructor");
  assert.deepEqual(s.tasks[0]!.owners, ["ana", "ana"]);
  const first = pass(s);
  assert.deepEqual(await sent(s, first), [["@ana", "✎ #1 changed\n✎ #2 changed"]]);

  const second = pass(handAddOwner(first, 1, "ben"));
  assert.deepEqual(await sent(first, second), [["@ana", "✎ #1 changed"], ["@ben", "✎ #1 changed"]]);
});
