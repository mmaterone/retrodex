import type * as React from "react";

import { cn } from "@/lib/utils";

export const Separator = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLHRElement>) => (
  <hr
    className={cn("h-px w-full border-0 bg-zinc-200", className)}
    {...props}
  />
);
