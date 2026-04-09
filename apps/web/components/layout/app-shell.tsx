"use client";

import { Sidebar } from "./sidebar";
import { Header } from "./header";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Fixed sidebar — 240px wide */}
      <aside className="w-60 flex-shrink-0 flex flex-col bg-white border-r border-gray-200 h-full">
        <Sidebar />
      </aside>

      {/* Main content area */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Top header — 48px tall */}
        <header className="h-12 flex-shrink-0 bg-white border-b border-gray-200">
          <Header />
        </header>

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
