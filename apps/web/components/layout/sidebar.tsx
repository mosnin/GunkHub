"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOrganization } from "@clerk/nextjs";
import {
  LayoutDashboard,
  FolderOpen,
  Bot,
  Play,
  GitCompare,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Projects", href: "/projects", icon: FolderOpen },
  { label: "Agents", href: "/agents", icon: Bot },
  { label: "Runs", href: "/runs", icon: Play },
  { label: "Diff", href: "/diff", icon: GitCompare },
  { label: "Settings", href: "/settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { organization } = useOrganization();

  return (
    <div className="flex flex-col h-full">
      {/* Logo / wordmark */}
      <div className="h-12 flex items-center px-4 border-b border-gray-200 flex-shrink-0">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center flex-shrink-0">
            <span className="text-white text-xs font-bold">AFR</span>
          </div>
          <span className="text-sm font-semibold text-gray-900 truncate">
            Flight Recorder
          </span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors",
                isActive
                  ? "bg-blue-50 text-blue-700 font-medium"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              )}
            >
              <Icon
                className={cn(
                  "w-4 h-4 flex-shrink-0",
                  isActive ? "text-blue-600" : "text-gray-400"
                )}
              />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Org name at bottom */}
      <div className="flex-shrink-0 px-3 py-3 border-t border-gray-200">
        <div className="flex items-center gap-2 px-1">
          <div className="w-6 h-6 rounded bg-gray-200 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-medium text-gray-600">
              {organization?.name?.[0]?.toUpperCase() ?? "O"}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-700 truncate">
              {organization?.name ?? "Organization"}
            </p>
            <p className="text-xs text-gray-400 truncate">
              {organization?.slug ?? "—"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
