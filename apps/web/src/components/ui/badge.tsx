import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-[0.06em]",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "border-zinc-950 bg-zinc-950 text-zinc-50",
        destructive: "border-red-300 bg-red-50 text-red-800",
        secondary: "border-zinc-300 bg-zinc-100 text-zinc-700",
        success: "border-emerald-300 bg-emerald-50 text-emerald-800",
      },
    },
  }
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, variant, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ className, variant }))} {...props} />
);
