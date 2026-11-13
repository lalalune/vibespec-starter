import type { ComponentMeta } from "vibestack/stories";
import { Button } from "./Button.tsx";
import { DialogClose, DialogContent, type DialogProps, DialogTitle, DialogTrigger } from "./Dialog.tsx";
import { CardFooter } from "./Card.tsx";

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
};
