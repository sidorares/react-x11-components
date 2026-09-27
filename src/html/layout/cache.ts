// Text layouts kept from one layout pass to the next, by what they lay out.
//
// An edit runs the whole pipeline again — parse, cascade, boxes, layout —
// because an HTML document is one string and any character of it can change
// any box. Most of a pass over a long document was the text engine laying
// every paragraph out again: three quarters of an edit to 600 KB, identical
// to the last time for all but the paragraph that changed.
//
// So a layout is kept with what went into it — the runs' text and styles,
// the block's style and the options — and a pass that asks for the same
// again gets the same layout back. Nothing a layout is found by names a box or
// an element, which is what makes it survive a re-parse: the runs carry no
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
  private _now = new Map<string, Kept[]>();
  private _before = new Map<string, Kept[]>();

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

  /**
   * The layout for these inputs: one this pass has already made or used,
   * else one the pass before used, else the engine's.
   *
   * A layout is filed under its width and a summary of its text (`keyOf`),
   * and found by comparing everything it was made from, field by field,
   * text and all. The first version spelled all of it into one string key,
   * every field of every run, and that string was the cost: a pass over a
   * 600 KB document asks for 8,800 layouts of 15,400 runs. The text alone
   * as the key was still the whole document built, flattened and hashed a
   * pass; the comparison that finds the layout reads it once.
   */
  private _layout(
    content: TextRun[],
    style: Record<string, unknown>,
    options: Parameters<FontsLike['layout']>[2],
  ): TextLayoutLike {
    const key = keyOf(content, options.maxWidth);
    const now = this._now.get(key);
    let kept = now && find(now, content, style, options);
    if (kept) return kept.layout;
    kept = find(this._before.get(key), content, style, options) ?? {
      // copies, so that nothing done to the inputs afterwards can change
      // what this layout is found by
      content: content.map((run) => ({ ...run })),
      style: { ...style },
      options: { ...options },
      layout: this.engine.layout(content, style, options),
    };
    if (now) now.push(kept);
    else this._now.set(key, [kept]);
    return kept.layout;
  }
}

/** How many characters of a text's start and of its end go into its key. */
const KEY_EDGE = 16;

/**
 * What a layout is filed under: its width, its runs' count, its text's
 * length, and the text's first and last few characters. Paragraphs that
 * share all of that are told apart by `find`; a key of the whole text was
 * the text copied and hashed for every layout of every pass.
 */
function keyOf(content: readonly TextRun[], maxWidth: unknown): string {
  let length = 0;
  for (const run of content) length += run.text.length;
  let head = '';
  for (let i = 0; i < content.length && head.length < KEY_EDGE; i += 1) {
    head += content[i].text.slice(0, KEY_EDGE - head.length);
  }
  let tail = '';
  for (let i = content.length - 1; i >= 0 && tail.length < KEY_EDGE; i -= 1) {
    const text = content[i].text;
    tail =
      text.slice(Math.max(0, text.length - (KEY_EDGE - tail.length))) + tail;
  }
  return `${maxWidth}\u0001${content.length}\u0001${length}\u0001${head}\u0001${tail}`;
}

/** A layout, and a copy of everything it was made from. */
interface Kept {
  content: TextRun[];
  style: Record<string, unknown>;
  options: object;
  layout: TextLayoutLike;
}

/** The layout among `kept` made from exactly these inputs. */
function find(
  kept: Kept[] | undefined,
  content: readonly TextRun[],
  style: Record<string, unknown>,
  options: object,
): Kept | undefined {
  if (!kept) return undefined;
  outer: for (const candidate of kept) {
    if (candidate.content.length !== content.length) continue;
    if (!sameFields(candidate.options, options)) continue;
    if (!sameFields(candidate.style, style)) continue;
    for (let i = 0; i < content.length; i += 1) {
      if (!sameFields(candidate.content[i], content[i])) continue outer;
    }
    return candidate;
  }
  return undefined;
}

/**
 * Whether two objects have the same fields with the same values. Every
 * field, so that one added to a run later cannot be left out of the
 * comparison by accident. The values are primitives throughout — a run is
 * text and the paint it asks for — so `Object.is` is equality.
 */
function sameFields(a: object, b: object): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  let fields = 0;
  for (const name in x) {
    if (!(name in y) || !Object.is(x[name], y[name])) return false;
    fields += 1;
  }
  for (const _ in y) fields -= 1;
  return fields === 0;
}
