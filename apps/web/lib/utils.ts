import type { RunStatus } from "@afr/contracts";

/**
 * Merges class names, filtering out falsy values.
 * Lightweight alternative to clsx for this project.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * Examples: "45ms", "1.2s", "1m 23s", "2h 5m"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0
    ? `${hours}h ${remainingMinutes}m`
    : `${hours}h`;
}

/**
 * Formats a Unix timestamp (ms) to a relative time string.
 * Examples: "just now", "2 minutes ago", "3 hours ago", "Jan 5"
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const deltaMs = now - timestamp;
  const deltaSec = Math.floor(deltaMs / 1000);

  if (deltaSec < 30) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;

  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin} minute${deltaMin === 1 ? "" : "s"} ago`;

  const deltaHours = Math.floor(deltaMin / 60);
  if (deltaHours < 24)
    return `${deltaHours} hour${deltaHours === 1 ? "" : "s"} ago`;

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return `${deltaDays} day${deltaDays === 1 ? "" : "s"} ago`;

  // Fall back to locale date for older timestamps
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: deltaDays > 365 ? "numeric" : undefined,
  });
}

/**
 * Formats a byte count to a human-readable string.
 * Examples: "512 B", "1.2 KB", "4.8 MB", "1.1 GB"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Returns a Tailwind text color class for a given run status.
 */
export function getStatusColor(status: RunStatus): string {
  switch (status) {
    case "pending":
      return "text-gray-500";
    case "running":
      return "text-blue-600";
    case "completed":
      return "text-green-600";
    case "failed":
      return "text-red-600";
    case "cancelled":
      return "text-amber-600";
    default: {
      const _exhaustive: never = status;
      return "text-gray-500";
    }
  }
}
