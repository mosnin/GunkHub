"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface DiffViewerProps {
  runAId?: string;
  runBId?: string;
}

export function DiffViewer({ runAId, runBId }: DiffViewerProps) {
  const [runA, setRunA] = useState(runAId ?? "");
  const [runB, setRunB] = useState(runBId ?? "");
  const [isComparing, setIsComparing] = useState(false);

  const canCompare = runA.trim().length > 0 && runB.trim().length > 0;

  const handleCompare = () => {
    if (!canCompare) return;
    // TODO: trigger Convex query for diff when Convex is integrated
    setIsComparing(true);
  };

  return (
    <div className="space-y-4">
      {/* Run selector inputs */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5 uppercase tracking-wide">
                Run A (baseline)
              </label>
              <input
                type="text"
                value={runA}
                onChange={(e) => {
                  setRunA(e.target.value);
                  setIsComparing(false);
                }}
                placeholder="run_xxxxxxxxxxxxxxx"
                className="w-full text-sm font-mono border border-gray-200 rounded px-3 py-2 text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5 uppercase tracking-wide">
                Run B (comparison)
              </label>
              <input
                type="text"
                value={runB}
                onChange={(e) => {
                  setRunB(e.target.value);
                  setIsComparing(false);
                }}
                placeholder="run_xxxxxxxxxxxxxxx"
                className="w-full text-sm font-mono border border-gray-200 rounded px-3 py-2 text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handleCompare}
              disabled={!canCompare}
              className="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 transition-colors"
            >
              Compare runs
            </button>
            {runA && runB && runA === runB && (
              <p className="text-xs text-amber-600">
                Both run IDs are the same — comparison would show no diff.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Summary row — shown when comparing */}
      {isComparing && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-6">
              <div className="text-center">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Added</p>
                <div className="mt-1">
                  <Badge variant="success">—</Badge>
                </div>
              </div>
              <div className="text-center">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Removed</p>
                <div className="mt-1">
                  <Badge variant="error">—</Badge>
                </div>
              </div>
              <div className="text-center">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Changed</p>
                <div className="mt-1">
                  <Badge variant="warning">—</Badge>
                </div>
              </div>
              <div className="text-center">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Unchanged</p>
                <div className="mt-1">
                  <Badge variant="default">—</Badge>
                </div>
              </div>
              <div className="text-center">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Duration delta</p>
                <p className="mt-1 text-sm font-mono text-gray-600">—</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Diff list or placeholder */}
      <Card>
        <CardHeader className="p-4">
          <CardTitle>Event Diff</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {!isComparing ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-4">
                <svg
                  className="w-6 h-6 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                  />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-700">
                Enter two run IDs to compare
              </p>
              <p className="mt-1 text-xs text-gray-400 max-w-sm">
                The diff will show added, removed, and changed events between the two runs.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm font-medium text-gray-700">
                Diff not yet implemented
              </p>
              <p className="mt-1 text-xs text-gray-400 max-w-sm">
                {/* TODO: implement diff using DiffResult from @afr/contracts */}
                Full diff comparison will be available after Convex integration.
              </p>
              <div className="mt-4 text-xs text-gray-400 font-mono space-y-1">
                <p>Run A: {runA}</p>
                <p>Run B: {runB}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
