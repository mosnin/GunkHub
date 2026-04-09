// Main class
export { FlightRecorder } from "./recorder.js";

// Event builders (convenience, not required but very useful)
export {
  lifecycleEvent,
  llmRequestEvent,
  llmResponseEvent,
  toolCallEvent,
  toolResultEvent,
  toolErrorEvent,
  errorEvent,
  customEvent,
  memoryReadEvent,
  memoryWriteEvent,
  retrievalEvent,
} from "./events.js";

// Transport interface (for custom implementations)
export type { Transport } from "./types.js";
export { HttpTransport, NotImplementedError } from "./transport.js";

// All public types
export type {
  FlightRecorderConfig,
  RetryConfig,
  Logger,
  RunHandle,
  RecordEventInput,
  StartRunInput,
  RunFailureInput,
  BatchBuffer,
  CreateRunTransportRequest,
  SendEventsTransportRequest,
  UpdateRunStatusRequest,
  TransportEvent,
} from "./types.js";
