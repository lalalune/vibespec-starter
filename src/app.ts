// The unverified shell: storage and error reporting around the verified core.
import { type Event, type Order, enabled, isEvent } from "../gen/order.ts";
import { balance, replay } from "./ledger.ts";

export class Rejected extends Error {}

/** An event-sourced order book. Only events the rules allow are ever stored. */
export class OrderBook {
  private logs = new Map<string, Event[]>();

  get(id: string): Order {
    return replay(this.logs.get(id) ?? []);
  }

  /** `event` may come straight from the network: it is validated before the rules see it. */
  dispatch(id: string, event: unknown): Order {
    if (!isEvent(event)) throw new Rejected(`not a well-formed event: ${JSON.stringify(event)}`);
    const order = this.get(id);
    if (!enabled(order, event)) throw new Rejected(`${event.type} is not allowed for a ${order.status} order`);
    this.logs.set(id, [...(this.logs.get(id) ?? []), event]);
    return this.get(id);
  }

  balance(id: string): number {
    return balance(this.get(id));
  }
}
