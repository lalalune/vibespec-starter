import { screen, userEvent } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import { CardFooter } from "./Card.tsx";
import { DialogClose, DialogContent, type DialogProps, DialogTitle, DialogTrigger } from "./Dialog.tsx";

const children = (
  <>
    <DialogTrigger asChild>
      <Button variant="destructive">Delete</Button>
    </DialogTrigger>
    <DialogContent>
      <DialogTitle>Delete the order?</DialogTitle>
      <CardFooter>
        <DialogClose asChild>
          <Button variant="outline">Keep</Button>
        </DialogClose>
        <Button variant="destructive">Delete</Button>
      </CardFooter>
    </DialogContent>
  </>
);

export const meta: ComponentMeta<DialogProps> = {
  args: { children },
  examples: { Open: { defaultOpen: true } },
  snapshot: ["Open"],
  play: {
    // The panel the trigger opens is checked like any other story.
    Default: async () => {
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      await screen.findByRole("dialog", { name: "Delete the order?" });
    },
  },
};
