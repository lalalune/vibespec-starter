import type { Order } from "../../gen/index.ts";
import { Badge } from "./Badge.tsx";

/**
 * An order at a glance.
 * @model spec/index.md
 * @design design.md#order-card
 */
export function OrderCard({ order, onPay }: { order: Order; onPay?: () => void }) {
  return (
    <article>
      <Badge tone={order.status === "Paid" ? "ok" : "info"}>{order.status}</Badge>
      <p>{order.units} units</p>
      <button type="button" onClick={onPay}>Pay</button>
    </article>
  );
}
