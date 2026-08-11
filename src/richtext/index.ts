// Selectable styled text, as a shared module: the `<richtext>` element
// (wrapped runs + a paintable selection range), the cross-block
// `TextSelection` controller, and the gesture hook that wires a root box
// to it. `<Markdown>` and `<Code>` are compositions over this; an app can
// build its own selectable surface from the same parts.
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
export type { NtkApp, RichTextProps, TextRun } from './node.js';
export { TextSelection } from './selection.js';
export type { SelectableBlock, SelectionRegistry } from './selection.js';
export { useSelectionGestures } from './gestures.js';
export type {
  SelectionGestureHandlers,
  SelectionGestureOptions,
} from './gestures.js';
export { tint } from './internal.js';

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      richtext: RichTextProps & { key?: string | number; ref?: Ref<unknown> };
    }
  }
}
