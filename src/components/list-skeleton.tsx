import { Skeleton } from "@/components/ui/skeleton";

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-label="Loading content" aria-busy="true" className="divide-y divide-border">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex min-h-[4.6rem] items-center gap-4 px-5 py-3.5">
          <Skeleton className="size-2 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-[min(18rem,72%)]" />
            <Skeleton className="h-2.5 w-[min(12rem,48%)]" />
          </div>
          <Skeleton className="hidden h-6 w-28 rounded-full sm:block" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
