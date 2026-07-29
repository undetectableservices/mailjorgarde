import { cn } from "@/lib/utils";

type BrandMarkProps = {
  className?: string;
  title?: string;
};

/** Compact routed-envelope mark. It intentionally stays legible at favicon size. */
export function BrandMark({ className, title }: BrandMarkProps) {
  return (
    <img
      src="/icon.svg"
      alt={title || ""}
      draggable={false}
      decoding="async"
      className={cn("shrink-0", className)}
    />
  );
}

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <BrandMark className={compact ? "size-9" : "size-11"} />
      <div className="min-w-0 leading-none">
        <div className={cn("brand-wordmark truncate", compact ? "text-lg" : "text-xl")}>
          JorgardeMail
        </div>
        {!compact && <div className="brand-caption mt-1.5">Messagerie personnelle</div>}
      </div>
    </div>
  );
}
