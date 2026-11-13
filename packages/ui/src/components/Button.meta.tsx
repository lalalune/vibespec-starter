import { expect, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { ButtonProps } from "./Button.tsx";

const link = <a href="#orders">Orders</a>;

export const meta: ComponentMeta<ButtonProps> = {
  examples: {
    // `asChild` needs an element to become, which no type can supply.
    AsChild: { asChild: true, children: link },
    "Disabled link": { asChild: true, disabled: true, children: link },
    // A button without text is named by `aria-label`.
    Empty: { size: "icon", "aria-label": "Add", children: undefined },
  },
  // The generated play of a disabled or loading story checks that it refuses clicks and keys; these check what a person is told.
  play: {
    Loading: ({ canvasElement }: { canvasElement: HTMLElement }) => expect(within(canvasElement).getByRole("button").getAttribute("aria-busy")).toBe("true"),
    // A link has no `disabled`: it says so and leaves the tab order.
    "Disabled link": ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const anchor = within(canvasElement).getByRole("link");
      return expect([anchor.getAttribute("aria-disabled"), anchor.tabIndex]).toEqual(["true", -1]);
    },
  },
};
