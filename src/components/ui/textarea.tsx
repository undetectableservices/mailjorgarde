import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-24 w-full rounded-xl border border-input bg-black/20 px-3.5 py-3 text-base text-foreground shadow-[0_1px_0_rgba(255,255,255,0.025)_inset] transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-muted-foreground/75 focus-visible:border-primary/55 focus-visible:bg-black/25 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/12 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
