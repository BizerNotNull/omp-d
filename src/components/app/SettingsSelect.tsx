import type { ComponentProps, ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type SettingsSelectProps<Value extends string> = Pick<ComponentProps<typeof SelectTrigger>, "id" | "aria-label" | "aria-describedby"> & {
  value: Value;
  label: string;
  className?: string;
  disabled?: boolean;
  onValueChange: (value: Value) => void;
  children: ReactNode;
};

export function SettingsSelect<Value extends string>({ value, label, disabled, onValueChange, children, className, ...triggerProps }: SettingsSelectProps<Value>) {
  return (
    <Select<Value> value={value} disabled={disabled} onValueChange={(next) => {
      if (next !== null) onValueChange(next);
    }}>
      <SelectTrigger size="sm" {...triggerProps}
        className={cn("w-40 max-w-full min-w-0 gap-2 bg-background text-xs data-popup-open:bg-muted [&>svg]:size-3.5 [&>svg]:shrink-0", className)}>
        <SelectValue className="min-w-0"><span className="min-w-0 truncate">{label}</span></SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="scroll-thin p-1 motion-reduce:animate-none">
        {children}
      </SelectContent>
    </Select>
  );
}

export function SettingsSelectOption({ value, children }: { value: string; children: ReactNode }) {
  return (
    <SelectItem value={value} className="min-h-7 px-2 pr-7 text-xs">
      <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{children}</span>
    </SelectItem>
  );
}
