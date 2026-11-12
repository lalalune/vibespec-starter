import type { Event } from "../gen/order.ts";
import { OrderBook, Rejected } from "./app.ts";

const book = new OrderBook();
const events: Event[] = [
  { type: "submit" }, // rejected: the draft is empty
  { type: "addItem", qty: 2 },
  { type: "submit" },
  { type: "pay", amount: 4 },
  { type: "pay", amount: 7 }, // rejected: more than the balance
  { type: "pay", amount: 6 },
  { type: "cancel" }, // rejected: already paid
];
for (const event of events) {
  try {
    console.log(JSON.stringify(event).padEnd(32), "->", JSON.stringify(book.dispatch("A1", event)));
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    console.log(JSON.stringify(event).padEnd(32), "-> rejected:", e.message);
  }
}
console.log("balance:", book.balance("A1"));
