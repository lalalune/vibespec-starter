import assert from "node:assert/strict";
import { test } from "node:test";
import { OrderBook, Rejected } from "../src/app.ts";

test("an order is filled, submitted and paid off in instalments", () => {
  const book = new OrderBook();
  book.dispatch("A1", { type: "addItem", qty: 2 });
  book.dispatch("A1", { type: "submit" });
  assert.equal(book.dispatch("A1", { type: "pay", amount: 4 }).status, "Pending");
  assert.equal(book.balance("A1"), 6);
  assert.equal(book.dispatch("A1", { type: "pay", amount: 6 }).status, "Paid");
  assert.equal(book.balance("A1"), 0);
});

test("events the rules do not allow are rejected and not stored", () => {
  const book = new OrderBook();
  assert.throws(() => book.dispatch("A1", { type: "submit" }), Rejected);
  book.dispatch("A1", { type: "addItem", qty: 1 });
  book.dispatch("A1", { type: "submit" });
  assert.throws(() => book.dispatch("A1", { type: "pay", amount: 6 }), Rejected);
  assert.deepEqual(book.get("A1"), { status: "Pending", units: 1, due: 5, paid: 0 });
});

test("cancelling refunds what was paid", () => {
  const book = new OrderBook();
  book.dispatch("A1", { type: "addItem", qty: 1 });
  book.dispatch("A1", { type: "submit" });
  book.dispatch("A1", { type: "pay", amount: 3 });
  assert.deepEqual(book.dispatch("A1", { type: "cancel" }), { status: "Cancelled", units: 1, due: 5, paid: 0 });
});

test("malformed input never reaches the verified core", () => {
  const book = new OrderBook();
  assert.throws(() => book.dispatch("A1", { type: "addItem", qty: 1.5 }), Rejected);
  assert.throws(() => book.dispatch("A1", { type: "refund" }), Rejected);
  assert.deepEqual(book.get("A1"), { status: "Draft", units: 0, due: 0, paid: 0 });
});

test("items can be taken back out of a draft, but never more than it holds", () => {
  const book = new OrderBook();
  book.dispatch("A1", { type: "addItem", qty: 3 });
  assert.equal(book.dispatch("A1", { type: "removeItem", qty: 2 }).due, 5);
  assert.throws(() => book.dispatch("A1", { type: "removeItem", qty: 2 }), Rejected);
});

test("a cancelled order can be reopened, and a payment partly taken back", () => {
  const book = new OrderBook();
  book.dispatch("A1", { type: "addItem", qty: 2 });
  book.dispatch("A1", { type: "submit" });
  book.dispatch("A1", { type: "pay", amount: 6 });
  assert.equal(book.dispatch("A1", { type: "takeBack", amount: 2 }).paid, 4);
  assert.throws(() => book.dispatch("A1", { type: "takeBack", amount: 5 }), Rejected);
  book.dispatch("A1", { type: "cancel" });
  assert.deepEqual(book.dispatch("A1", { type: "reopen" }), { status: "Draft", units: 2, due: 10, paid: 0 });
});

test("an event is copied on the way in, so nothing the caller keeps can change it", () => {
  const book = new OrderBook();
  book.dispatch("A1", { type: "addItem", qty: 2 });
  book.dispatch("A1", { type: "submit" });
  let reads = 0;
  const sly = { type: "pay", get amount() { return reads++ === 0 ? 1 : 1_000_000; }, extra: "ignored" };
  assert.deepEqual(book.dispatch("A1", sly), { status: "Pending", units: 2, due: 10, paid: 1 });
});
