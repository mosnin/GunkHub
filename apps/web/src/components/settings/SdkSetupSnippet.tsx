import { Card } from '@/components/ui/Card'
import { CodeBlock } from '@/components/ui/CodeBlock'

const installCommand = 'pnpm add @agent-flight-recorder/sdk'

const usageSnippet = `import { FlightRecorder } from '@agent-flight-recorder/sdk'

const recorder = new FlightRecorder({
  apiKey: 'YOUR_API_KEY',
  projectId: 'YOUR_PROJECT_ID',
  agentId: 'YOUR_AGENT_ID',
})

const run = await recorder.startRun({
  agentId: 'YOUR_AGENT_ID',
  agentVersionId: 'YOUR_VERSION_ID',  // optional: from the Versions tab on your agent page
})
await run.recordEvent({ type: 'agent.step', payload: { ... } })
await run.complete()`

export function SdkSetupSnippet() {
  return (
    <Card>
      <div className="px-5 py-4 border-b border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-200">SDK Setup</h2>
        <p className="mt-0.5 text-xs text-pewter">
          Install the SDK and start recording runs from your agent code.
        </p>
      </div>

      <div className="px-5 py-4 flex flex-col gap-4">
        <div>
          <p className="text-xs font-medium text-pewter mb-1.5 uppercase tracking-wider">
            Installation
          </p>
          <CodeBlock content={installCommand} language="shell" maxHeight="60px" />
        </div>

        <div>
          <p className="text-xs font-medium text-pewter mb-1.5 uppercase tracking-wider">
            Basic usage
          </p>
          <CodeBlock content={usageSnippet} language="typescript" />
        </div>

        <p className="text-xs text-pewter leading-relaxed">
          Get your API key from the API Keys section below. Find your project and agent IDs on the{' '}
          <span className="text-neutral-400">Projects</span> page.
        </p>
      </div>
    </Card>
  )
}
