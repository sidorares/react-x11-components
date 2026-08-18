// Minimal ambient typings for react-reconciler 0.33 — only what
// `reconciler.ts` calls. DefinitelyTyped's `@types/react-reconciler` still
// describes an older host-config contract (createContainer took fewer
// arguments before React 19), so depending on it would mean casting around
// its shape anyway; declaring the four entry points used here keeps the
// contract in one honest place. Ambient, so nothing is emitted into `dist/`
// and nothing leaks into a consumer's program — their types come from the
// exports map, which never references this file.
declare module 'react-reconciler' {
  import type { ReactNode } from 'react';

  export interface Reconciler {
    createContainer(
      containerInfo: unknown,
      tag: number,
      hydrationCallbacks: null,
      isStrictMode: boolean,
      concurrentUpdatesByDefaultOverride: null,
      identifierPrefix: string,
      onUncaughtError: (error: unknown, errorInfo?: unknown) => void,
      onCaughtError: (error: unknown, errorInfo?: unknown) => void,
      onRecoverableError: (error: unknown, errorInfo?: unknown) => void,
      transitionCallbacks: null,
    ): unknown;
    updateContainer(
      element: ReactNode,
      container: unknown,
      parentComponent?: unknown,
      callback?: (() => void) | null,
    ): void;
    flushSyncWork(): void;
  }

  export default function ReactReconciler(
    hostConfig: Record<string, unknown>,
  ): Reconciler;
}

declare module 'react-reconciler/constants.js' {
  const constants: {
    ConcurrentRoot: number;
    DefaultEventPriority: number;
    DiscreteEventPriority: number;
    ContinuousEventPriority: number;
    IdleEventPriority: number;
    NoEventPriority: number;
    LegacyRoot: number;
  };
  export default constants;
}
