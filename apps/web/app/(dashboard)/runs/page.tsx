import { RunsClient } from "./runs-client";
import type { Run } from "@afr/contracts";

// Stub — replace with Convex queries after npx convex dev
const stubRuns: Run[] = [];

export default async function RunsPage() {
  // TODO: replace with real Convex query after npx convex dev
  const runs = stubRuns;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Runs</h1>
          <p className="mt-1 text-sm text-gray-600">
            All recorded agent execution runs
          </p>
        </div>
      </div>

      {/* Filters — UI only, no state hookup for foundation */}
      <div className="flex flex-wrap items-center gap-3 p-3 bg-white border border-gray-200 rounded-lg">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Status</label>
          <select className="text-sm border border-gray-200 rounded px-2 py-1 text-gray-700 bg-white">
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Agent</label>
          <select className="text-sm border border-gray-200 rounded px-2 py-1 text-gray-700 bg-white">
            <option value="">All agents</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">Project</label>
          <select className="text-sm border border-gray-200 rounded px-2 py-1 text-gray-700 bg-white">
            <option value="">All projects</option>
          </select>
        </div>
        <div className="ml-auto">
          <input
            type="text"
            placeholder="Search by tag or ID..."
            className="text-sm border border-gray-200 rounded px-3 py-1 text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 w-48"
          />
        </div>
      </div>

      {/* Client component handles routing and state */}
      <RunsClient runs={runs} />
    </div>
  );
}
