// Text layouts kept from one layout pass to the next, by what they lay out.
//
// An edit runs the whole pipeline again — parse, cascade, boxes, layout —
// because an HTML document is one string and any character of it can change
// any box. Most of a pass over a long document was the text engine laying
// every paragraph out again: three quarters of an edit to 600 KB, identical
// to the last time for all but the paragraph that changed.
//
// So a layout is kept under what went into it — the runs' text and styles,
// the block's style and the options — and a pass that asks for the same
// again gets the same layout back. Nothing in the key names a box or an
// element, which is what makes it survive a re-parse: the runs carry no
// element (hit testing finds a run's element through the document's text
// index, `LineText.spans`), so a layout says nothing about which parse it
// was made for.
//
// Two generations bound it: a pass may take what the pass before used, and
// what neither used is dropped. A long document costs one pass's layouts
// and the layouts an edit replaced, never the history of every edit.
import type { TextRun } from '../../richtext/index.js';
import type { TextLayoutLike } from './boxes.js';
import type { FontsLike } from './inline.js';

export class TextLayoutCache {
  /** The fonts to lay out with: the engine's, answered from here when a
   *  layout is already on hand. One object for the cache's life, since the
   *  measurements keyed on the fonts (a space's advance) are kept per
   *  object. */
  readonly fonts: FontsLike;
  private _now = new Map<string, TextLayoutLike>();
  private _before = new Map<string, TextLayoutLike>();

  constructor(readonly engine: FontsLike) {
    this.fonts = {
      layout: (content, style, options) =>
        this._layout(content, style, options),
      match: (family, style) => engine.match(family, style),
    };
  }

  /** A pass is starting: what the last one used, this one may reuse. */
  begin(): void {
    this._before = this._now;
    this._now = new Map();
  }

  private _layout(
    content: TextRun[],
    style: Record<string, unknown>,
    options: Parameters<FontsLike['layout']>[2],
  ): TextLayoutLike {
    const key = layoutKey(content, style, options);
    let layout = this._now.get(key) ?? this._before.get(key);
    if (!layout) layout = this.engine.layout(content, style, options);
    this._now.set(key, layout);
    return layout;
  }
}

/** Everything a layout is made from, as one string. */
function layoutKey(
  content: readonly TextRun[],
  style: Record<string, unknown>,
  options: object,
): string {
  let key = fieldsOf(options) + '\u0001' + fieldsOf(style);
  for (const run of content) key += '\u0001' + fieldsOf(run);
  return key;
}

/**
 * An object's fields, name and value. Every field, so that one added to a
 * run later cannot be left out of the key by accident; strings carry their
 * length, so no text can read as another field's boundary. The values are
 * primitives throughout — a run is text and the paint it asks for.
 */
function fieldsOf(value: object): string {
  let out = '';
  for (const [name, field] of Object.entries(value)) {
    out +=
      typeof field === 'string'
        ? `${name}=${field.length}:${field};`
        : `${name}=${String(field)};`;
  }
  return out;
}
