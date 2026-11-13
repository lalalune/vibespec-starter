import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const tagVariants = cva("tag", {
  variants: { size: { sm: "s", md: "m", lg: "l" }, tone: { quiet: "q", loud: "l" } },
  defaultVariants: { size: "md", tone: "quiet" },
});

export type TagProps = ComponentProps<"span"> & VariantProps<typeof tagVariants>;

export function Tag({ size, tone, className, ...props }: TagProps) {
  return <span className={tagVariants({ size, tone, className })} {...props} />;
}
