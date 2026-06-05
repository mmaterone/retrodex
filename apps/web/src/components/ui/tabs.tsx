import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface TabsContextValue {
  setValue: (value: string) => void;
  value: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

const useTabsContext = () => {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error("Tabs components must be rendered inside Tabs");
  }
  return context;
};

export const Tabs = ({
  children,
  className,
  defaultValue,
}: {
  children: ReactNode;
  className?: string;
  defaultValue: string;
}) => {
  const [value, setValue] = useState(defaultValue);

  return (
    <TabsContext.Provider value={{ setValue, value }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
};

export const TabsList = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      "inline-flex rounded-[18px] border border-border bg-accent p-1",
      className
    )}
  >
    {children}
  </div>
);

export const TabsTrigger = ({
  children,
  className,
  value,
}: {
  children: ReactNode;
  className?: string;
  value: string;
}) => {
  const context = useTabsContext();
  const active = context.value === value;

  return (
    <button
      className={cn(
        "rounded-[14px] px-3 py-1.5 text-sm font-semibold text-muted-foreground transition-colors duration-100 hover:text-foreground",
        active && "bg-active text-foreground",
        className
      )}
      type="button"
      onClick={() => context.setValue(value)}
    >
      {children}
    </button>
  );
};

export const TabsContent = ({
  children,
  className,
  value,
}: {
  children: ReactNode;
  className?: string;
  value: string;
}) => {
  const context = useTabsContext();

  if (context.value !== value) {
    return null;
  }

  return <div className={className}>{children}</div>;
};
