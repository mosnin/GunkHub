import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonList } from "@/components/ui/loading";
import type { Agent } from "@afr/contracts";

// Stub — replace with Convex queries after npx convex dev
const stubAgents: Agent[] = [];

export default async function AgentsPage() {
  // TODO: replace with real Convex query after npx convex dev
  const agents = stubAgents;
  const isLoading = false;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Agents</h1>
          <p className="mt-1 text-sm text-gray-600">
            AI agents tracked in your organization
          </p>
        </div>
      </div>

      {isLoading ? (
        <SkeletonList count={4} />
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Agents appear here once you start ingesting runs via the API."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Card key={agent.id} className="hover:shadow-sm transition-shadow cursor-pointer">
              <CardHeader className="p-4">
                <CardTitle>{agent.name}</CardTitle>
                <CardDescription className="text-xs text-gray-400 font-mono">
                  {agent.id}
                </CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {agent.description && (
                  <p className="text-sm text-gray-600 mb-3">{agent.description}</p>
                )}
                <div className="flex items-center gap-4 text-xs text-gray-400">
                  <span>0 runs</span>
                  <span>
                    Created {new Date(agent.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
