import { ReplayViewer } from "@/components/replay/replay-viewer";

interface ReplayPageProps {
  params: Promise<{ id: string }>;
}

export default async function ReplayPage({ params }: ReplayPageProps) {
  const { id } = await params;

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Replay</h1>
        <p className="mt-1 text-sm text-gray-600 font-mono">{id}</p>
      </div>
      <ReplayViewer runId={id} />
    </div>
  );
}
