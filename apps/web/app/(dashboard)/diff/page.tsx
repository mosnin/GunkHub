import { DiffViewer } from "@/components/diff/diff-viewer";

interface DiffPageProps {
  searchParams: Promise<{ runA?: string; runB?: string }>;
}

export default async function DiffPage({ searchParams }: DiffPageProps) {
  const { runA, runB } = await searchParams;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Diff</h1>
        <p className="mt-1 text-sm text-gray-600">
          Compare two agent runs side by side
        </p>
      </div>
      <DiffViewer runAId={runA} runBId={runB} />
    </div>
  );
}
