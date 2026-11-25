import type { ComponentProps } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function SearchInput({ className, clear, ...props }: ComponentProps<typeof Input> & {
  clear?: { label: string; onClick: () => void };
}) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.75 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input {...props} className={cn("h-auto border-[0.5px] border-sidebar-border/75 py-2 pl-8 text-[11px] leading-[1.5] focus-visible:border-ring focus-visible:ring-0 md:text-[11px] dark:bg-transparent", clear && "pr-8")} />
      {clear && <Button type="button" variant="ghost" size="icon-xs" aria-label={clear.label} className="absolute inset-y-0 right-1 my-auto text-muted-foreground" onClick={clear.onClick}>
        <X aria-hidden="true" className="size-3.5" />
      </Button>}
    </div>
  );
}
