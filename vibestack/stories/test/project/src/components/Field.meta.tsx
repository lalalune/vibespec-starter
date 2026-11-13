import { expect, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "../../../../meta.ts";
import type { FieldProps } from "./Field.tsx";

export const meta: ComponentMeta<FieldProps> = {
  args: { label: "Name" },
  examples: { Typed: {} },
  decorator: (story) => <form>{story()}</form>,
  play: {
    Typed: async ({ canvasElement, args }) => {
      await userEvent.type(within(canvasElement).getByLabelText("Name"), "Ada");
      await expect(args.onChange).toHaveBeenLastCalledWith("Ada");
    },
  },
};
