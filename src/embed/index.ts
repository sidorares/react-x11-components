// `@react-x11/components/embed` — running somebody else's program inside a
// `<foreign>`, without the vocabulary of any particular program.
//
// A **shared module**, not a component: it registers no element, renders
// nothing at import time, and exists because `<Terminal>` and `<MediaPlayer>`
// are the same lifecycle with different argv (AGENTS.md, "Shared modules are
// directories too"). It is exported rather than kept private for two
// reasons — `ProcessHost` is the seam an app needs to run the child somewhere
// else (a container, an ssh host, a sandbox), and a fourth wrapper around some
// other `-into WID` program should not have to copy this file to exist.
export {
  BackendUnavailableError,
  resolveBackend,
  useEmbeddedClient,
} from './client.js';
export type {
  EmbedStatus,
  EmbeddedClient,
  LaunchPlan,
  PlanContext,
  PlanFactory,
  UseEmbeddedClientOptions,
} from './client.js';

export { IpcConnectError, connectWhenReady, nodeProcessHost } from './host.js';
export type {
  ExitInfo,
  IpcSocket,
  ProcessHost,
  ScratchSocket,
  SpawnOptions,
  SpawnedProcess,
} from './host.js';
