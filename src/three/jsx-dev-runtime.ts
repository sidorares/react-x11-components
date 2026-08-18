// Development counterpart of jsx-runtime.ts — the same JSX namespace, over
// react-x11's dev runtime function. The `@jsxImportSource` pragma resolves
// to this module in development builds.
import type * as React from 'react';
import type { ReactX11Elements } from 'react-x11';

import type { ThreeElements } from './jsx.js';

export { Fragment, jsxDEV } from 'react-x11/jsx-dev-runtime';

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
