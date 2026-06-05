import { ChevronDown } from "lucide-react";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SelectContextValue {
  disabled: boolean;
  label: string;
  open: boolean;
  setLabel: (value: string) => void;
  setOpen: (value: boolean) => void;
  setValue: (value: string) => void;
  value: string;
}

const SelectContext = createContext<SelectContextValue | null>(null);

const useSelectContext = () => {
  const context = useContext(SelectContext);
  if (!context) {
    throw new Error("Select compound components must be inside Select");
  }
  return context;
};

interface SelectProps {
  children: ReactNode;
  defaultValue?: string;
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  value?: string;
}

export const Select = ({
  children,
  defaultValue = "",
  disabled = false,
  onValueChange,
  value,
}: SelectProps) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [label, setLabel] = useState("");
  const [open, setOpen] = useState(false);
  const currentValue = value ?? internalValue;

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  const setValue = (nextValue: string) => {
    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onValueChange?.(nextValue);
    setOpen(false);
  };

  return (
    <SelectContext.Provider
      value={{
        disabled,
        label,
        open,
        setLabel,
        setOpen,
        setValue,
        value: currentValue,
      }}
    >
      <div className="relative" ref={rootRef}>
        {children}
      </div>
    </SelectContext.Provider>
  );
};

interface SelectTriggerProps extends HTMLAttributes<HTMLButtonElement> {
  placeholder?: string;
}

export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  ({ className, placeholder = "Select", ...props }, ref) => {
    const { disabled, label, open, setOpen } = useSelectContext();
    return (
      <button
        aria-expanded={open}
        className={cn(
          "group inline-flex h-9 w-full min-w-[160px] items-center justify-between gap-2 rounded-[14px] border border-border bg-accent px-3 text-[13px] font-semibold text-foreground outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-1 focus-visible:ring-[#6b97ff] disabled:pointer-events-none disabled:opacity-50",
          className
        )}
        disabled={disabled}
        ref={ref}
        type="button"
        onClick={() => setOpen(!open)}
        {...props}
      >
        <span className="min-w-0 truncate text-left">
          {label || placeholder}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180"
          )}
        />
      </button>
    );
  }
);

SelectTrigger.displayName = "SelectTrigger";

interface SelectContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export const SelectContent = forwardRef<HTMLDivElement, SelectContentProps>(
  ({ children, className, ...props }, ref) => {
    const { open } = useSelectContext();
    if (!open) {
      return null;
    }
    return (
      <div
        className={cn(
          "absolute left-0 top-[calc(100%+6px)] z-[80] grid max-h-[260px] w-full min-w-[180px] gap-1 overflow-auto rounded-[16px] border border-border bg-surface-5 p-1 text-foreground shadow-surface-6",
          className
        )}
        ref={ref}
        {...props}
      >
        {children}
      </div>
    );
  }
);

SelectContent.displayName = "SelectContent";

interface SelectItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  index: number;
  value: string;
}

export const SelectItem = forwardRef<HTMLButtonElement, SelectItemProps>(
  ({ children, className, index: _index, value, ...props }, ref) => {
    const context = useSelectContext();
    const isActive = context.value === value;
    const label = typeof children === "string" ? children : value;

    useEffect(() => {
      if (isActive) {
        context.setLabel(label);
      }
    }, [context, isActive, label]);

    return (
      <button
        className={cn(
          "rounded-[12px] px-2.5 py-2 text-left text-[13px] font-semibold transition-colors duration-100 hover:bg-hover",
          isActive
            ? "bg-active text-foreground"
            : "text-muted-foreground hover:text-foreground",
          className
        )}
        ref={ref}
        type="button"
        onClick={() => context.setValue(value)}
        {...props}
      >
        {children}
      </button>
    );
  }
);

SelectItem.displayName = "SelectItem";

export const SelectGroup = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={className} {...props}>
    {children}
  </div>
);

export const SelectLabel = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    className={cn("px-2 py-1.5 text-[11px] text-muted-foreground", className)}
    ref={ref}
    {...props}
  />
));

SelectLabel.displayName = "SelectLabel";

export const SelectSeparator = forwardRef<
  HTMLHRElement,
  HTMLAttributes<HTMLHRElement>
>(({ className, ...props }, ref) => (
  <hr className={cn("my-1 border-border/60", className)} ref={ref} {...props} />
));

SelectSeparator.displayName = "SelectSeparator";
