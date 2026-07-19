/**
 * Commands whose real implementation depends on the read API
 * (`GET /api/runs`, `GET /api/runs/:id`, replay/tail/export endpoints), which
 * lands in cycle 2 after coordination with the ui/data teams. Scaffolded now
 * so the command tree and dispatch structure exist and cycle 2 only has to
 * fill in the body of each handler.
 */
export interface ScaffoldedResult {
  command: string
  message: string
}

export function scaffoldedCommand(command: string): ScaffoldedResult {
  return {
    command,
    message: `'afr ${command}' requires the read API, which lands in cycle 2. This command is scaffolded but not yet implemented.`,
  }
}

export function printScaffolded(result: ScaffoldedResult, log: (line: string) => void = console.error): void {
  log(`Error: ${result.message}`)
}
