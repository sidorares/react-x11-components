// The boxes a frame's document is mounted in by `renderEmbedded`
// (`embedded.ts`): each is that document's viewport, as an `<iframe>` is
// in a browser, which a `vh` in it is a share of (`HtmlViewNode`'s
// `_viewportHeight`). Kept apart from `embedded.ts` so the node reads it
// without the React half.

/** The mount boxes that stand for their document's viewport. */
export const FRAME_VIEWPORTS = new WeakSet<object>();

/** A `ref` that marks the box it is set on as a frame's viewport. */
export function markFrameViewport(node: object | null): void {
  if (node) FRAME_VIEWPORTS.add(node);
}
