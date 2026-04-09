"use client";

import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";

const routeLabels: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/projects": "Projects",
  "/agents": "Agents",
  "/runs": "Runs",
  "/diff": "Diff",
  "/settings": "Settings",
};

function getPageTitle(pathname: string): string {
  // Exact match first
  if (routeLabels[pathname]) {
    return routeLabels[pathname];
  }

  // Prefix match for dynamic routes
  for (const [route, label] of Object.entries(routeLabels)) {
    if (pathname.startsWith(route + "/")) {
      // Sub-routes: e.g. /runs/[id]/replay
      const rest = pathname.slice(route.length + 1);
      if (rest.includes("/replay")) return `${label} / Replay`;
      return label;
    }
  }

  return "Agent Flight Recorder";
}

function getBreadcrumbs(pathname: string): { label: string; href?: string }[] {
  const parts = pathname.split("/").filter(Boolean);
  const crumbs: { label: string; href?: string }[] = [];

  if (parts.length === 0) return crumbs;

  const base = `/${parts[0]}`;
  const baseLabel = routeLabels[base];

  if (baseLabel) {
    crumbs.push({ label: baseLabel, href: base });
  }

  if (parts.length > 1) {
    const segment = parts[1];
    if (segment && segment.length > 12) {
      // Looks like an ID — truncate it
      crumbs.push({ label: `${segment.slice(0, 8)}…` });
    } else if (segment) {
      crumbs.push({ label: segment });
    }
  }

  if (parts.length > 2) {
    const last = parts[parts.length - 1];
    if (last && last !== parts[1]) {
      const label = last.charAt(0).toUpperCase() + last.slice(1);
      crumbs.push({ label });
    }
  }

  return crumbs;
}

export function Header() {
  const pathname = usePathname();
  const title = getPageTitle(pathname);
  const breadcrumbs = getBreadcrumbs(pathname);

  return (
    <div className="h-full flex items-center justify-between px-4">
      {/* Left: title + breadcrumbs */}
      <div className="flex items-center gap-2 min-w-0">
        {breadcrumbs.length > 1 ? (
          <nav className="flex items-center gap-1.5 text-sm">
            {breadcrumbs.map((crumb, index) => (
              <span key={index} className="flex items-center gap-1.5">
                {index > 0 && (
                  <span className="text-gray-400">/</span>
                )}
                {crumb.href && index < breadcrumbs.length - 1 ? (
                  <a
                    href={crumb.href}
                    className="text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    {crumb.label}
                  </a>
                ) : (
                  <span className="text-gray-900 font-medium truncate max-w-xs">
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
        ) : (
          <h1 className="text-sm font-semibold text-gray-900">{title}</h1>
        )}
      </div>

      {/* Right: user button */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <UserButton
          appearance={{
            elements: {
              avatarBox: "w-7 h-7",
            },
          }}
        />
      </div>
    </div>
  );
}
