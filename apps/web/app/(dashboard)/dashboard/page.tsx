import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { RunStatusBadge } from "@/components/ui/badge";
import type { Run } from "@afr/contracts";

// Stub data — replace with Convex queries after npx convex dev
const stubRuns: Run[] = [];

const statsCards = [
  { label: "Total Runs", value: "—", subtext: "All time" },
  { label: "Failed Runs", value: "—", subtext: "Last 7 days" },
  { label: "Agents", value: "—", subtext: "Active" },
  { label: "Avg Duration", value: "—", subtext: "Last 7 days" },
];

export default async function DashboardPage() {
  // TODO: replace with real Convex queries after npx convex dev
  const recentRuns = stubRuns;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-600">
          Overview of your agent executions
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {statsCards.map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {stat.label}
              </p>
              <p className="mt-2 text-2xl font-semibold text-gray-900 font-mono">
                {stat.value}
              </p>
              <p className="mt-1 text-xs text-gray-400">{stat.subtext}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent runs */}
      <div>
        <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide mb-3">
          Recent Runs
        </h2>

        {recentRuns.length === 0 ? (
          <EmptyState
            title="No runs yet"
            description="Start recording agent executions to see them here."
          />
        ) : (
          <div className="space-y-2">
            {recentRuns.map((run) => (
              <Card key={run.id}>
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <RunStatusBadge status={run.status} />
                    <span className="text-sm font-mono text-gray-600">{run.id}</span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Quick links */}
      <div>
        <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide mb-3">
          Quick Access
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader className="p-4">
              <CardTitle>Runs</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-sm text-gray-600">
                Browse and inspect all agent execution runs.
              </p>
              <a
                href="/runs"
                className="mt-3 inline-block text-sm text-blue-600 hover:text-blue-700 font-medium"
              >
                View runs →
              </a>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-4">
              <CardTitle>Replay</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-sm text-gray-600">
                Step through agent events to understand behavior.
              </p>
              <a
                href="/runs"
                className="mt-3 inline-block text-sm text-blue-600 hover:text-blue-700 font-medium"
              >
                Start replay →
              </a>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-4">
              <CardTitle>Diff</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-sm text-gray-600">
                Compare two runs side by side to spot differences.
              </p>
              <a
                href="/diff"
                className="mt-3 inline-block text-sm text-blue-600 hover:text-blue-700 font-medium"
              >
                Compare runs →
              </a>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
