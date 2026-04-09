import { cn } from "@/lib/utils";

// Animated spinner ring
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-spin text-gray-400", className ?? "w-5 h-5")}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

// Gray pulsing block
interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded bg-gray-200",
        className
      )}
    />
  );
}

// A pre-shaped card skeleton
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "bg-white border border-gray-200 rounded-lg p-4 space-y-3",
        className
      )}
    >
      <div className="flex items-center gap-3">
        <Skeleton className="w-16 h-5 rounded" />
        <Skeleton className="w-32 h-5 rounded" />
      </div>
      <Skeleton className="w-full h-4 rounded" />
      <Skeleton className="w-3/4 h-4 rounded" />
      <div className="flex items-center gap-4 pt-1">
        <Skeleton className="w-12 h-3 rounded" />
        <Skeleton className="w-20 h-3 rounded" />
        <Skeleton className="w-16 h-3 rounded" />
      </div>
    </div>
  );
}

// Several skeleton rows — use for list views
interface SkeletonListProps {
  count?: number;
  className?: string;
}

export function SkeletonList({ count = 3, className }: SkeletonListProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

// Centered loading spinner for full-page loads
export function LoadingScreen({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3">
      <Spinner className="w-6 h-6 text-blue-500" />
      {message && (
        <p className="text-sm text-gray-500">{message}</p>
      )}
    </div>
  );
}
