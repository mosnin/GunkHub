"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface ReplayViewerProps {
  runId: string;
}

type PlaybackState = "idle" | "playing" | "paused";
type PlaybackSpeed = 0.5 | 1 | 2 | 4;

export function ReplayViewer({ runId }: ReplayViewerProps) {
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [currentSeq, setCurrentSeq] = useState(0);
  const totalEvents = 0; // TODO: replace with real event count

  const handlePlay = () => setPlaybackState("playing");
  const handlePause = () => setPlaybackState("paused");
  const handleStop = () => {
    setPlaybackState("idle");
    setCurrentSeq(0);
  };

  const progressPercent =
    totalEvents > 0 ? (currentSeq / totalEvents) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Playback controls bar */}
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-3">
            {/* Play/Pause/Stop buttons */}
            <div className="flex items-center gap-1.5">
              {playbackState === "playing" ? (
                <Button variant="secondary" size="sm" onClick={handlePause}>
                  <PauseIcon />
                  Pause
                </Button>
              ) : (
                <Button size="sm" onClick={handlePlay}>
                  <PlayIcon />
                  {playbackState === "paused" ? "Resume" : "Play"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStop}
                disabled={playbackState === "idle"}
              >
                <StopIcon />
                Stop
              </Button>
            </div>

            {/* Progress indicator */}
            <div className="flex-1 flex items-center gap-3">
              <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-200"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <span className="text-xs text-gray-400 font-mono flex-shrink-0">
                {currentSeq} / {totalEvents}
              </span>
            </div>

            {/* Speed selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">Speed</span>
              <select
                value={speed}
                onChange={(e) =>
                  setSpeed(Number(e.target.value) as PlaybackSpeed)
                }
                className="text-xs border border-gray-200 rounded px-2 py-1 text-gray-700 bg-white"
              >
                <option value={0.5}>0.5x</option>
                <option value={1}>1x</option>
                <option value={2}>2x</option>
                <option value={4}>4x</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main replay content area */}
      <Card>
        <CardHeader className="p-4">
          <CardTitle>Event Timeline</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-4">
              <PlayIcon className="w-6 h-6 text-gray-400" />
            </div>
            <p className="text-sm font-medium text-gray-700">
              Replay not yet implemented
            </p>
            <p className="mt-1 text-xs text-gray-400 max-w-sm">
              Real-time event replay will be available after Convex integration.
              Run ID: <span className="font-mono">{runId}</span>
            </p>
            <p className="mt-3 text-xs text-gray-400">
              {/* TODO: implement replay using ReplayState and ReplayConfig from @afr/contracts */}
              Use the Events tab to inspect individual events.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "w-4 h-4"}
      fill="currentColor"
      viewBox="0 0 20 20"
    >
      <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z"
        clipRule="evenodd"
      />
    </svg>
  );
}
