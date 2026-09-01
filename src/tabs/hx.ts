// `React.createElement`, typed against react-x11's host elements — a copy of
// `src/timeline/hx.ts`, duplicated on purpose: components in this package do
// not import each other (a lateral import welds two components into one
// tree-shaking unit — see AGENTS.md), and fifty shared lines are cheaper than
// that. See `src/internal/hx.ts` for the full why of the shape.
import React from 'react';
import type { Key, ReactElement, ReactNode } from 'react';
import type { ReactX11Elements, Theme } from 'react-x11';

/** The host elements, by name. */
export type Host = ReactX11Elements;

interface CommonProps {
  key?: Key;
  /** Honoured by every node at runtime; declared only on `<window>` — the
   *  same narrow declaration the calendar works around. */
  theme?: Theme | Record<string, string | number>;
  /** The query hook every component forwards (docs/README.md,
   *  "Conventions"). react-x11 passes `data-*` through; the declarations
   *  just do not spell it, so it is added here rather than cast away at
   *  every call site. */
  'data-testname'?: string;
}

export function hx<K extends keyof Host>(
  type: K,
  props?: (Omit<Host[K], 'theme'> & CommonProps) | null,
  ...children: ReactNode[]
): ReactElement {
  return React.createElement(type as string, props as never, ...children);
}
