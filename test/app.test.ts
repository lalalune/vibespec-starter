import assert from "node:assert/strict";
import { test } from "node:test";
import { conformance } from "../gen/order.conformance.ts";
import { OrderBook, Rejected } from "../src/app.ts";

// Every story of spec/order.md through the real order book: a journey per `sometimes` rule, then random walks over
// two orders at once (AGENTS.md, "Conformance").
test("the order book does what spec/order.md says", async () => {
  let book = new OrderBook();
  await conformance({
    reset: () => { book = new OrderBook(); },
    dispatch: (id, event) => {
      try { book.dispatch(id, event); return "accepted"; } catch (e) { if (e instanceof Rejected) return "refused"; throw e; }
    },
    observe: (id) => book.get(id),
  });
});

// What the spec cannot see: input that is not an event at all.
test("malformed input never reaches the verified core, and nothing the caller keeps can change an event", () => {
  const book = new OrderBook();
  assert.throws(() => book.dispatch("A1", { type: "addItem", qty: 1.5 }), Rejected);
  assert.throws(() => book.dispatch("A1", { type: "refund" }), Rejected);
  book.dispatch("A1", { type: "addItem", qty: 2 });
  book.dispatch("A1", { type: "submit" });
  let reads = 0;
  const sly = { type: "pay", get amount() { return reads++ === 0 ? 1 : 1_000_000; }, extra: "ignored" };
  assert.deepEqual(book.dispatch("A1", sly), { status: "Pending", units: 2, due: 10, paid: 1 });
});
