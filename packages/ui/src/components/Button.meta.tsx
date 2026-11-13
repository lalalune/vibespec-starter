import type { ComponentMeta } from "vibestack/stories";
import type { ButtonProps } from "./Button.tsx";

export const meta: ComponentMeta<ButtonProps> = {
  // `asChild` needs an element to become, which no type can supply.
  examples: { AsChild: { asChild: true, children: <a href="#orders">Orders</a> } },
};
