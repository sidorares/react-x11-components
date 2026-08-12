// Styled text that a document can select across, as a shared module: the
// `<richtext>` element (wrapped runs, per-run decoration, and the four text
// accessors core's selection asks for), plus the right-click menu a
// read-only surface offers. `<Markdown>` and `<Code>` are compositions over
// this; an app can build its own surface from the same parts.
//
// The selection itself is core's since react-x11#291 — a `selectable` prop
// on the root box, and the anchor/focus, granularity, PRIMARY, Ctrl+A/Ctrl+C
// and the one-visible-selection rule that come with it. This module used to
// carry all of that (a `TextSelection` controller and a `useSelectionGestures`
// hook); both are gone, and so are the `order`/`registry`/`joiner` props the
// element took to feed them — a copy's separators now come from the layout.
//
// Importing this barrel registers nothing. A component that renders
// `<richtext>` calls `registerRichText()` at its own module scope — see
// the note in node.ts.
import type { Ref } from 'react';

import type { RichTextProps } from './node.js';

// The augmentation needs its target module resolved (same note as
// `sparkline/index.ts`): nothing in `src/` writes JSX.
import type {} from 'react-x11/jsx-runtime';

export {
  ELEMENT as RICHTEXT_ELEMENT,
  registerRichText,
  RichTextNode,
} from './node.js';
export type { NtkApp, RichTextProps, TextLayoutLike, TextRun } from './node.js';
export { useSelectionMenu } from './menu.js';
export type { SelectionMenuHandlers } from './menu.js';
export { tint } from './internal.js';

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      richtext: RichTextProps & { key?: string | number; ref?: Ref<unknown> };
    }
  }
}
