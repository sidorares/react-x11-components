// Collaboration: what the editor draws for a collaborator's caret.
//
// y-prosemirror's cursor plugin — the one a Yjs-backed ProseMirror editor
// runs — shows another user's caret as a *widget decoration* whose `toDOM`
// builds an element: its `cursorBuilder` option, which by default makes a
// `<span>` with the user's name in it. A widget is DOM, and this view has no
// DOM to draw it with (./view.ts, "what a DOM view would draw that this one
// cannot"). So the editor supplies a builder of its own, `remoteCaret`, that
// returns not an element but a description of one — whose caret it is, and
// in what colour — and the view, meeting a widget with no `text` to draw,
// asks its `toDOM` once and draws what comes back as a caret beside the
// editor's own: a bar and a flag, set on the textblock's element the way the
// local caret is, re-rendering nothing.
//
// The other half of y-prosemirror's cursor plugin, the collaborator's
// selection, is an inline decoration with a `style` — a background colour —
// and the view draws that already.
import type { Decoration, EditorView } from 'prosemirror-view';

// a registered symbol, so two copies of this package in one app agree
const CARET = Symbol.for('@react-x11/components/rich-text-editor:remote-caret');

/** A collaborator's caret, as `remoteCaret` describes it. */
export interface RemoteCaret {
  /** The bar's and the flag's colour — the awareness state's `user.color`. */
  readonly color: string;
  /** Whose caret it is — carried along; the caret is drawn without it. */
  readonly name: string;
}

/**
 * y-prosemirror's `cursorBuilder`, for this editor:
 *
 * ```ts
 * yCursorPlugin(awareness, { cursorBuilder: remoteCaret })
 * ```
 *
 * `user` is the awareness state's `user` field, `{ name, color }`, with the
 * colour a `#rrggbb` (y-prosemirror's own requirement). Typed as the
 * `HTMLElement` y-prosemirror asks a builder for; what it returns is a
 * description only this editor's view reads.
 */
export function remoteCaret(
  user?: { name?: unknown; color?: unknown } | null,
): HTMLElement {
  const caret = {
    [CARET]: true,
    color: typeof user?.color === 'string' ? user.color : '#ffa500',
    name: typeof user?.name === 'string' ? user.name : '',
  };
  return caret as unknown as HTMLElement;
}

function isRemoteCaret(value: unknown): value is RemoteCaret {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[CARET] === true
  );
}

/** What a widget's `toDOM` made, by the widget's type — which a mapped
 *  decoration keeps, so a caret that only moved is not asked again. */
const made = new WeakMap<object, RemoteCaret | null>();

/**
 * The caret a widget decoration stands for, when its `toDOM` is
 * `remoteCaret`'s — or null for any other widget, which has nothing here to
 * draw it with. A `toDOM` that reaches for `document` throws under this view:
 * that is a widget written for a browser, skipped like the rest.
 */
export function caretOf(
  deco: Decoration,
  view: EditorView,
): RemoteCaret | null {
  const type = (deco as unknown as { type?: { toDOM?: unknown } }).type;
  if (!type || typeof type.toDOM !== 'function') return null;
  const known = made.get(type);
  if (known !== undefined) return known;
  let caret: RemoteCaret | null = null;
  try {
    const out = (
      type.toDOM as (view: EditorView, getPos: () => number) => unknown
    )(view, () => deco.from);
    caret = isRemoteCaret(out) ? out : null;
  } catch {
    caret = null;
  }
  made.set(type, caret);
  return caret;
}
