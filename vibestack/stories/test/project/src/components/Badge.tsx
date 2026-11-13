import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva("badge", {
  variants: { tone: { info: "info", ok: "ok", warn: "warn" } },
  defaultVariants: { tone: "info" },
});

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants> & {
  /** Draws the eye to something new. */
  pulse?: boolean;
};

/** A short label for a status. */
export function Badge({ tone, pulse = false, className, children, ...props }: BadgeProps) {
  return (
    <span data-pulse={pulse || undefined} className={badgeVariants({ tone, className })} {...props}>
      {children}
    </span>
  );
}
