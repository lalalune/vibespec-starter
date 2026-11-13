import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Button, Checkbox, Dialog, DialogContent, DialogTitle, DialogTrigger, Input, Label } from "../src/index.ts";

afterEach(cleanup);

it("a disabled or loading Button does not fire", async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  const { rerender } = render(<Button onClick={onClick}>Save</Button>);
  const button = screen.getByRole("button", { name: "Save" });
  await user.click(button);
  rerender(<Button onClick={onClick} disabled>Save</Button>);
  await user.click(button);
  rerender(<Button onClick={onClick} loading>Save</Button>);
  await user.click(button);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(button.getAttribute("aria-busy")).toBe("true");
});

it("a Dialog opens from the keyboard, holds focus, closes on Escape and gives focus back", async () => {
  const user = userEvent.setup();
  render(
    <Dialog>
      <DialogTrigger>Delete</DialogTrigger>
      <DialogContent>
        <DialogTitle>Delete the order?</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
  const trigger = screen.getByRole("button", { name: "Delete" });
  await user.tab();
  await user.keyboard("{Enter}");
  const dialog = screen.getByRole("dialog", { name: "Delete the order?" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("a Checkbox toggles from its Label and the keyboard, and not when disabled", async () => {
  const user = userEvent.setup();
  const onCheckedChange = vi.fn();
  const { rerender } = render(<Label><Checkbox onCheckedChange={onCheckedChange} />Gift</Label>);
  const box = screen.getByRole("checkbox", { name: "Gift" });
  await user.click(screen.getByText("Gift"));
  expect(box.getAttribute("aria-checked")).toBe("true");
  box.focus();
  await user.keyboard(" ");
  expect(box.getAttribute("aria-checked")).toBe("false");
  rerender(<Label><Checkbox onCheckedChange={onCheckedChange} disabled />Gift</Label>);
  await user.click(box);
  expect(onCheckedChange.mock.calls).toEqual([[true], [false]]);
});

it("an Input is reached through its Label, takes typing and reports invalid", async () => {
  const user = userEvent.setup();
  render(<><Label htmlFor="qty">Quantity</Label><Input id="qty" invalid /></>);
  await user.click(screen.getByText("Quantity"));
  await user.keyboard("12");
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Quantity" });
  expect([input.value, input.getAttribute("aria-invalid")]).toEqual(["12", "true"]);
});
