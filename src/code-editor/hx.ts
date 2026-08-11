// `React.createElement`, typed against react-x11's host elements — a copy of
// `src/calendar/hx.ts`, duplicated on purpose: components in this package do
// not import each other (a lateral import welds two components into one
// tree-shaking unit — see AGENTS.md), and fifty shared lines are cheaper
// than that. See the calendar's copy for the full why of the shape.
import React from 'react';
import type { Key, ReactElement, ReactNode } from 'react';
import type { ReactX11Elements, Theme } from 'react-x11';

/** The host elements, by name. */
export type Host = ReactX11Elements;

interface CommonProps {
  key?: Key;
  /** Honoured by every node at runtime; declared only on `<window>` — the
   * same narrow declaration the calendar works around. */
  theme?: Theme | Record<string, string | number>;
}

export function hx<K extends keyof Host>(
  type: K,
  props?: (Omit<Host[K], 'theme'> & CommonProps) | null,
  ...children: ReactNode[]
): ReactElement {
  return React.createElement(type as string, props as never, ...children);
}
