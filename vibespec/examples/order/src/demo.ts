import type { Event, Order } from "../gen/index.ts";
import { OrderBook, Rejected } from "./app.ts";

const book = new OrderBook();
const events: Event[] = [
  { type: "submit" }, // the draft is empty
  { type: "addItem", qty: 2 },
  { type: "submit" },
  { type: "pay", amount: 4 },
  { type: "pay", amount: 7 }, // more than the balance
  { type: "pay", amount: 6 },
  { type: "cancel" }, // already paid
];
const paidBar = (o: Order) => {
  const filled = o.due ? Math.round((10 * o.paid) / o.due) : 0;
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${o.paid}/${o.due}`;
};
for (const event of events) {
  const shown = Object.values(event).join(" ").padEnd(10);
  try {
    const order = book.dispatch("A1", event);
    console.log("✓", shown, order.status.padEnd(9), paidBar(order));
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    console.log("✗", shown, e.message);
  }
}
