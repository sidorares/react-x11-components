// `React.createElement`, typed against react-x11's host elements — a copy
// of `src/calendar/hx.ts`, and deliberately a copy: a component importing
// another component's private module makes the two one unit for a bundler
// (AGENTS.md, "No component imports another component").
//
// `React.createElement`'s own overloads are `@types/react`'s and describe
// the DOM, so a `<box onMouseMove>` handler would be checked against
// React's MouseEvent rather than react-x11's. `hx('box', …)` looks the
// name up in react-x11's element table instead, and `hx('div', …)` is an
// error.
import React from 'react';
import type { Key, ReactElement, ReactNode, Ref } from 'react';
import type { ReactX11Elements, Theme } from 'react-x11';

/** The host elements, by name. */
export type Host = ReactX11Elements;

/**
 * What every element takes on top of its own props. `theme` is honoured by
 * every node at runtime; react-x11's declarations only put it on
 * `<window>`, so it is re-declared here the way the calendar does.
 * `data-testname` is the query hook every component forwards
 * (docs/README.md, "Conventions"); react-x11 passes `data-*` through, the
 * declarations just do not spell it.
 */
interface CommonProps {
  key?: Key;
  ref?: Ref<unknown>;
  theme?: Theme | Record<string, string | number>;
  'data-testname'?: string;
}

export function hx<K extends keyof Host>(
  type: K,
  props?: (Omit<Host[K], 'theme'> & CommonProps) | null,
  ...children: ReactNode[]
): ReactElement {
  return React.createElement(type as string, props as never, ...children);
}
