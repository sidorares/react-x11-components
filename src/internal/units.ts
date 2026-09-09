// One logical pixel is `scale` device pixels — react-x11's docs/scale.md.
//
// **Shared between `<Tree>` and `<Table>`** like the rest of this directory;
// see the header of `./heights.ts` for why it is internal rather than a
// shared module with a subpath.
//
// The virtualizers keep their whole model in logical pixels: style lengths,
// the `onScroll`/`onViewport` payloads, the height index, and the props
// (`rowHeight`, `estimatedRowHeight`) are all logical. But the **raw node
// properties** they read back between events — `scrollY`, `contentHeight`,
// `abs` — are device pixels. At scale 1 the two units coincide, which is how
// every harness test and every Xvfb check passed while a retina display
// doubled every raw read: the offset re-read after layout landed at twice
// the logical value, the slice was rebuilt a viewport below where the user
// was looking, and the table example went blank on a flick (and stayed
// blank after an append-and-reveal). Every raw read goes through this
// divisor so the arithmetic stays in one unit.
//
// `scale` is on every retained node at run time but not on the public
// `DrawnNode` type — hence the structural read, and `object` rather than
// `{ scale?: unknown }` in the signature: a weak type with no property in
// common with `DrawnNode` fails TS2559 at every call site.
export function scaleOf(node: object | null | undefined): number {
  const s = node ? (node as { scale?: unknown }).scale : undefined;
  return typeof s === 'number' && s > 0 ? s : 1;
}
