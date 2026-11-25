import type { ComponentProps } from "react";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type SendButtonProps = Pick<ComponentProps<typeof Button>, "children" | "disabled" | "onClick" | "type"> & {
  pending?: boolean;
};

export function SendButton({ children, pending, type = "button", ...props }: SendButtonProps) {
  return (
    <Button type={type} size="sm" className="gap-1.5" {...props}>
      {pending
        ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        : <ArrowUp aria-hidden="true" className="size-3.5" />}
      {children}
    </Button>
  );
}
