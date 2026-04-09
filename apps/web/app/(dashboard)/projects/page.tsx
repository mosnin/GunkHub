import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonList } from "@/components/ui/loading";
import type { Project } from "@afr/contracts";

// Stub — replace with Convex queries after npx convex dev
const stubProjects: Project[] = [];

export default async function ProjectsPage() {
  // TODO: replace with real Convex query after npx convex dev
  const projects = stubProjects;
  const isLoading = false;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Projects</h1>
          <p className="mt-1 text-sm text-gray-600">
            Organize agents and runs by project
          </p>
        </div>
        <button
          className="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
          disabled
        >
          New Project
        </button>
      </div>

      {isLoading ? (
        <SkeletonList count={4} />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create a project to organize your agents and runs."
          action={
            <button className="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors">
              Create your first project
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card key={project.id} className="hover:shadow-sm transition-shadow cursor-pointer">
              <CardHeader className="p-4">
                <CardTitle>{project.name}</CardTitle>
                <CardDescription className="text-xs text-gray-400 font-mono">
                  /{project.slug}
                </CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                {project.description && (
                  <p className="text-sm text-gray-600 mb-3">{project.description}</p>
                )}
                <div className="flex items-center gap-4 text-xs text-gray-400">
                  <span>0 agents</span>
                  <span>0 runs</span>
                  <span>
                    Created {new Date(project.createdAt).toLocaleDateString()}
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
