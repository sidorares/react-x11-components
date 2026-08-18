// `React.createElement`, typed against react-x11's host elements — the
// same private helper `src/calendar/hx.ts` is, cut down to the two elements
// this module renders. Copied rather than imported because components do
// not import each other (AGENTS.md); the argument for its existence — that
// `createElement`'s own overloads describe the DOM — is over there in full.
import React from 'react';
import type { Key, ReactElement, ReactNode } from 'react';
import type { ReactX11Elements } from 'react-x11';

type Host = Pick<ReactX11Elements, 'box' | 'glarea'>;

interface CommonProps {
  key?: Key;
}

export function hx<K extends keyof Host>(
  type: K,
  props: (Host[K] & CommonProps) | null,
  ...children: ReactNode[]
): ReactElement {
  return React.createElement(type, props, ...children);
}
