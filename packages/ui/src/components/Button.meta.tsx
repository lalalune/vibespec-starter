import type { ComponentMeta } from "vibestack/stories";
import type { ButtonProps } from "./Button.tsx";

export const meta: ComponentMeta<ButtonProps> = {
  examples: {
    // `asChild` needs an element to become, which no type can supply.
    AsChild: { asChild: true, children: <a href="#orders">Orders</a> },
    // A button without text is named by `aria-label`.
    Empty: { size: "icon", "aria-label": "Add", children: undefined },
  },
};
