import { Schema } from "effect";
import type { ComponentMeta } from "../../../../meta.ts";
import type { PriceProps } from "./Price.tsx";

export const meta: ComponentMeta<PriceProps> = {
  schema: Schema.Struct({ cents: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })), currency: Schema.Literals(["USD", "EUR"]) }),
  bounds: { cents: [0, 100_000] },
};
