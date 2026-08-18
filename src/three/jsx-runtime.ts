// An optional JSX source that types the whole scene vocabulary with this
// package's r3f-shaped props — refs to the mutable objects, `attach`,
// dashed transform props — while react-x11 core still declares its own,
// narrower 3D element types (they leave with its scene graph; an
// augmentation cannot replace an inherited member until then).
//
// Opt a file in with the per-file pragma:
//
//   /** @jsxImportSource @react-x11/components/three */
//
// Runtime-identical to `react-x11/jsx-runtime` — the functions are
// re-exports — so the pragma changes what type-checks, never what runs.
// Files without the pragma keep compiling against core's declarations, and
// this file becomes unnecessary the day core's 3D vocabulary is gone.
import type * as React from 'react';
import type { ReactX11Elements } from 'react-x11';

import type { ThreeElements } from './jsx.js';

export { Fragment, jsx, jsxs } from 'react-x11/jsx-runtime';

type CoreElements = Omit<ReactX11Elements, keyof ThreeElements>;

export namespace JSX {
  export type ElementType = React.JSX.ElementType;
  export type Element = React.JSX.Element;
  export type ElementClass = React.JSX.ElementClass;
  export type ElementAttributesProperty = React.JSX.ElementAttributesProperty;
  export type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute;
  export type LibraryManagedAttributes<C, P> =
    React.JSX.LibraryManagedAttributes<C, P>;
  export type IntrinsicAttributes = React.JSX.IntrinsicAttributes;
  export type IntrinsicClassAttributes<T> =
    React.JSX.IntrinsicClassAttributes<T>;

  /** Core's elements with the scene names replaced by this package's. */
  export interface IntrinsicElements extends CoreElements, ThreeElements {}
}
