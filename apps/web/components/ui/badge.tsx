import { cn } from "@/lib/utils";
import type { RunStatus } from "@afr/contracts";

type BadgeVariant =
  | "default"
  | "success"
  | "error"
  | "warning"
  | "info"
  | "pending";

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-gray-100 text-gray-700",
  success: "bg-green-50 text-green-700 border border-green-200",
  error: "bg-red-50 text-red-700 border border-red-200",
  warning: "bg-amber-50 text-amber-700 border border-amber-200",
  info: "bg-blue-50 text-blue-700 border border-blue-200",
  pending: "bg-gray-100 text-gray-500 border border-gray-200",
};

interface BadgeProps {
  variant?: BadgeVariant;
  className?: string;
  children: React.ReactNode;
}

export function Badge({
  variant = "default",
  className,
  children,
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
        variantClasses[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

const statusVariantMap: Record<RunStatus, BadgeVariant> = {
  pending: "pending",
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "warning",
};

const statusDotMap: Record<RunStatus, string> = {
  pending: "bg-gray-400",
  running: "bg-blue-500 animate-pulse",
  completed: "bg-green-500",
  failed: "bg-red-500",
  cancelled: "bg-amber-500",
};

interface RunStatusBadgeProps {
  status: RunStatus;
  className?: string;
}

export function RunStatusBadge({ status, className }: RunStatusBadgeProps) {
  return (
    <Badge variant={statusVariantMap[status]} className={className}>
      <span
        className={cn("w-1.5 h-1.5 rounded-full mr-1.5", statusDotMap[status])}
      />
      {status}
    </Badge>
  );
}
