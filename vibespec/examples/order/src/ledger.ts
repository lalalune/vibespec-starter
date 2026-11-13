//@ backend dafny
// spec/index.md, "Story: Check out"; spec/index.md, "The amount paid is never negative and never more than is due"
import { type Event, type Order, initial, step } from "../gen/index.ts";

export function replay(events: Event[]): Order {
  //@ ensures inv(\result)
  let order: Order = initial;
  let i = 0;
  while (i < events.length) {
    //@ invariant 0 <= i && i <= events.length
    //@ invariant inv(order)
    order = step(order, events[i]);
    i = i + 1;
  }
  return order;
}

//@ pure
export function balance(order: Order): number {
  //@ requires inv(order)
  //@ ensures \result >= 0
  //@ ensures order.status === "Paid" ==> \result === 0
  return order.due - order.paid;
}
