import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes, ComponentType } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant = "ghost" | "primary" | "secondary" | "tertiary";
export type ButtonSize = "icon" | "icon-lg" | "icon-sm" | "lg" | "md" | "sm";

interface IconProps {
  className?: string;
  size?: number;
  strokeWidth?: number;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  asChild?: boolean;
  leadingIcon?: ComponentType<IconProps>;
  loading?: boolean;
  size?: ButtonSize;
  trailingIcon?: ComponentType<IconProps>;
  variant?: ButtonVariant;
}

const sizeClasses: Record<ButtonSize, string> = {
  icon: "h-9 w-9 p-0",
  "icon-lg": "h-10 w-10 p-0",
  "icon-sm": "h-8 w-8 p-0",
  lg: "h-9 px-5 text-[14px]",
  md: "h-8 px-4 text-[13px]",
  sm: "h-7 px-3 text-[12px]",
};

const variantClasses: Record<ButtonVariant, string> = {
  ghost: "text-muted-foreground hover:text-foreground",
  primary: "text-background",
  secondary: "text-foreground",
  tertiary: "border border-border text-foreground",
};

const bgClasses: Record<ButtonVariant, string> = {
  ghost: "bg-transparent group-hover:bg-hover group-active:bg-active",
  primary:
    "bg-foreground group-hover:bg-foreground/90 group-active:bg-foreground/80",
  secondary: "bg-accent group-hover:bg-hover group-active:bg-active",
  tertiary: "bg-transparent group-hover:bg-hover group-active:bg-active",
};

const iconSizeFor = (size: ButtonSize) => {
  if (size === "lg" || size === "icon-lg") {
    return 20;
  }
  if (size === "sm" || size === "icon-sm") {
    return 14;
  }
  return 16;
};

export const Button = ({
  active = false,
  asChild = false,
  children,
  className,
  disabled,
  leadingIcon: LeadingIcon,
  loading = false,
  size = "md",
  trailingIcon: TrailingIcon,
  variant = "primary",
  ...props
}: ButtonProps) => {
  const Comp = asChild ? Slot : "button";
  const iconSize = iconSizeFor(size);

  return (
    <Comp
      className={cn(
        "group relative isolate inline-flex cursor-pointer items-center justify-center gap-1.5 overflow-hidden rounded-[20px] font-semibold outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-[#6b97ff] disabled:pointer-events-none disabled:opacity-50",
        sizeClasses[size],
        variantClasses[variant],
        active && "text-foreground",
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-0 rounded-[inherit] transition-colors duration-100",
          bgClasses[variant],
          active && "bg-active"
        )}
      />
      <span className="relative inline-flex items-center justify-center gap-[inherit]">
        {LeadingIcon ? <LeadingIcon size={iconSize} strokeWidth={1.8} /> : null}
        {children}
        {TrailingIcon ? (
          <TrailingIcon size={iconSize} strokeWidth={1.8} />
        ) : null}
      </span>
    </Comp>
  );
};
