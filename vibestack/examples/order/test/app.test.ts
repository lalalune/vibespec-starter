import assert from "node:assert/strict";
import { test } from "node:test";
import { conformance } from "../gen/index.conformance.ts";
import { OrderBook, Rejected } from "../src/app.ts";

/** A book whose order A1 has been sent `events`, in order. */
function book(...events: object[]): OrderBook {
  const b = new OrderBook();
  for (const e of events) b.dispatch("A1", e);
  return b;
}
const submitted = (qty: number) => book({ type: "addItem", qty }, { type: "submit" });

// spec/index.md, "Story: Check out"; spec/index.md, "Story: Change my mind"; spec/index.md, "Story: Take back a payment"; spec/index.md, "Story: Cancel"; spec/index.md, "Story: Reopen a cancelled order"
test("an order is filled, paid in part, cancelled with a refund, reopened and paid off", () => {
  const b = book({ type: "addItem", qty: 3 });
  // spec/index.md, "No more can be removed than the order holds"
  assert.equal(b.dispatch("A1", { type: "removeItem", qty: 1 }).due, 10);
  assert.throws(() => b.dispatch("A1", { type: "removeItem", qty: 3 }), Rejected);
  b.dispatch("A1", { type: "submit" });
  b.dispatch("A1", { type: "pay", amount: 6 });
  // spec/index.md, "No more can be taken back than was paid"
  assert.equal(b.dispatch("A1", { type: "takeBack", amount: 2 }).paid, 4);
  assert.throws(() => b.dispatch("A1", { type: "takeBack", amount: 5 }), Rejected);
  // spec/index.md, "A pending order can be cancelled, refunding every payment"
  assert.deepEqual(b.dispatch("A1", { type: "cancel" }), { status: "Cancelled", units: 2, due: 10, paid: 0 });
  // spec/index.md, "A cancelled order can be reopened as a draft"
  assert.deepEqual(b.dispatch("A1", { type: "reopen" }), { status: "Draft", units: 2, due: 10, paid: 0 });
  b.dispatch("A1", { type: "submit" });
  b.dispatch("A1", { type: "pay", amount: 4 });
  assert.equal(b.balance("A1"), 6);
  assert.equal(b.dispatch("A1", { type: "pay", amount: 6 }).status, "Paid");
  assert.equal(b.balance("A1"), 0);
});

// spec/index.md, "Only a non-empty draft can be submitted"; spec/index.md, "A payment never exceeds the balance"
test("events the rules do not allow are rejected and not stored", () => {
  assert.throws(() => book({ type: "submit" }), Rejected);
  const b = submitted(1);
  assert.throws(() => b.dispatch("A1", { type: "pay", amount: 6 }), Rejected);
  assert.deepEqual(b.get("A1"), { status: "Pending", units: 1, due: 5, paid: 0 });
});

test("malformed input never reaches the verified core", () => {
  const b = book();
  assert.throws(() => b.dispatch("A1", { type: "addItem", qty: 1.5 }), Rejected);
  assert.throws(() => b.dispatch("A1", { type: "refund" }), Rejected);
  assert.deepEqual(b.get("A1"), { status: "Draft", units: 0, due: 0, paid: 0 });
});

test("an event is copied on the way in, so nothing the caller keeps can change it", () => {
  let reads = 0;
  const sly = { type: "pay", get amount() { return reads++ === 0 ? 1 : 1_000_000; }, extra: "ignored" };
  assert.deepEqual(submitted(2).dispatch("A1", sly), { status: "Pending", units: 2, due: 10, paid: 1 });
});

// Every story of spec/index.md through the real order book: a journey per `sometimes` rule, then random walks over
// two orders at once (AGENTS.md, "Conformance").
test("the order book does what spec/index.md says", async () => {
  let book = new OrderBook();
  await conformance({
    reset: () => { book = new OrderBook(); },
    dispatch: (id, event) => {
      try { book.dispatch(id, event); return "accepted"; } catch (e) { if (e instanceof Rejected) return "refused"; throw e; }
    },
    observe: (id) => book.get(id),
  });
});
