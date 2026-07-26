import { SDK_VERSION } from '@agent-flight-recorder/sdk'

import { CLI_VERSION } from '../version.js'

/** `afr version` — print CLI and SDK version. Always succeeds (exit 0). */
export function runVersion(log: (line: string) => void = console.log): number {
  log(`afr (Agent Flight Recorder CLI) v${CLI_VERSION}`)
  log(`sdk: v${SDK_VERSION}`)
  return 0
}
