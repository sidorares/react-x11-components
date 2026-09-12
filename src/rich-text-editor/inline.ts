// A textblock's inline content as the runs `<richtext>` lays out, and the map
// between the two coordinate systems that meet there.
//
// ProseMirror counts a position in UTF-16 units of document text, with every
// inline node that is not text counting one. `<richtext>` counts code points
// of the string it draws. The two differ exactly where the editor draws
// something the document does not hold one for one: an image drawn as its
// alt text, a hard break drawn as a line feed, a widget — the placeholder, a
// composition's preedit, a plugin's decoration — drawn with no document
// width at all, and the space an empty paragraph is drawn with so it has a
// line to put a caret on. `InlineMap` is the one bridge, total and monotonic
// both ways, the way `<CodeEditor>`'s tab map is (src/code-editor/doc.ts):
// getting it right once is the whole game.
//
// Pure: no React, no react-x11 — so every rule in it is asserted with no
// display (test/rich-text-editor-model.test.ts).
import type { Mark, Node as PMNode } from 'prosemirror-model';

import type { TextRun } from '../richtext/node.js';
import { codePointAtOffset, codeUnitOffsets } from '../internal/text.js';

/** A run's look, without its text. */
export type RunStyle = Omit<TextRun, 'text'>;

export type SegmentKind = 'text' | 'atom' | 'widget' | 'filler';

/** One stretch of the drawn string and the document offsets it stands for. */
export interface InlineSegment {
  kind: SegmentKind;
  /** Offsets inside the textblock's content. `to - from` is the text's
   *  length, 1 for an atom, 0 for a widget or the filler. */
  from: number;
  to: number;
  /** Where it is in the drawn string, in UTF-16 units. */
  dFrom: number;
  dTo: number;
  /** A widget's ProseMirror `side`: negative draws it before a caret at its
   *  position, zero or positive after. */
  side: number;
}

export class InlineMap {
  private offsets: number[] | null = null;

  constructor(
    /** The drawn string — the runs' texts, concatenated. */
    readonly text: string,
    /** The textblock's `content.size`. */
    readonly size: number,
    readonly segments: readonly InlineSegment[],
  ) {}

  private units(): number[] {
    return (this.offsets ??= codeUnitOffsets(this.text));
  }

  /** How many code points are drawn. */
  get length(): number {
    return this.units().length - 1;
  }

  /** A code point index as a UTF-16 offset into `text`. */
  unitOf(cp: number): number {
    const units = this.units();
    return units[Math.max(0, Math.min(Math.round(cp), units.length - 1))];
  }

  /** A UTF-16 offset as a code point index, rounded down to a character. */
  cpOf(unit: number): number {
    return codePointAtOffset(this.units(), unit);
  }

  /**
   * Where a caret at document offset `pos` is drawn, as a code point index.
   * Widgets at `pos` with a negative side are drawn before the caret and the
   * rest after it — ProseMirror's rule, which is what puts the caret of an
   * empty document before its placeholder.
   */
  toDisplay(pos: number): number {
    const p = Math.max(0, Math.min(pos, this.size));
    let d = 0;
    for (const seg of this.segments) {
      if (seg.kind === 'widget' || seg.kind === 'filler') {
        if (seg.from < p) {
          d = seg.dTo;
          continue;
        }
        if (seg.from > p) break;
        if (seg.kind === 'widget' && seg.side < 0) {
          d = seg.dTo;
          continue;
        }
        break;
      }
      if (seg.to <= p) {
        d = seg.dTo;
        continue;
      }
      if (seg.from >= p) break;
      // strictly inside: only text is wider than one position
      d = seg.dFrom + (p - seg.from);
      break;
    }
    return this.cpOf(d);
  }

  /**
   * The document offset a drawn code point stands for: inside text, the
   * character's own offset; inside an atom's label, its nearer edge; inside
   * a widget or the filler, the position it is drawn at.
   */
  toDoc(cp: number): number {
    const d = this.unitOf(cp);
    for (const seg of this.segments) {
      if (d > seg.dTo) continue;
      if (d === seg.dTo) return seg.to;
      switch (seg.kind) {
        case 'text':
          return seg.from + (d - seg.dFrom);
        case 'atom':
          return d - seg.dFrom < (seg.dTo - seg.dFrom) / 2 ? seg.from : seg.to;
        default:
          return seg.from;
      }
    }
    return this.size;
  }
}

/** How a textblock's content looks: derived by the component from the
 *  theme, the node's type and the `markStyles` seam. */
export interface InlineLook {
  /** The block's own text — family, size, weight, colour. */
  base: RunStyle;
  /** A mark's contribution, merged over what is under it in rank order. */
  mark(mark: Mark, under: RunStyle): RunStyle;
  /** What an inline leaf that is not text is drawn as. A hard break is
   *  `'\n'`; an image, its alt text in a chip. */
  atom(node: PMNode): { text: string; style?: RunStyle };
  /** A code block's text as runs — tokenized, when there is a language. */
  code?(text: string): TextRun[];
}

/** An inline decoration, in offsets inside the textblock. */
export interface InlineDecoration {
  from: number;
  to: number;
  style: RunStyle;
}

/** A widget: text drawn at a position with no document width. */
export interface InlineWidget {
  pos: number;
  side: number;
  text: string;
  style?: RunStyle;
}

interface Piece {
  dFrom: number;
  dTo: number;
  style: RunStyle;
}

const STYLE_KEYS = [
  'family',
  'size',
  'weight',
  'style',
  'color',
  'bg',
  'bgFill',
  'underline',
  'underlineStyle',
  'strike',
  'href',
] as const;

function sameStyle(a: RunStyle, b: RunStyle): boolean {
  for (const key of STYLE_KEYS) if (a[key] !== b[key]) return false;
  return true;
}

function overlay(
  pieces: Piece[],
  a: number,
  b: number,
  style: RunStyle,
): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (p.dTo <= a || p.dFrom >= b) {
      out.push(p);
      continue;
    }
    if (p.dFrom < a) out.push({ dFrom: p.dFrom, dTo: a, style: p.style });
    out.push({
      dFrom: Math.max(p.dFrom, a),
      dTo: Math.min(p.dTo, b),
      style: { ...p.style, ...style },
    });
    if (p.dTo > b) out.push({ dFrom: b, dTo: p.dTo, style: p.style });
  }
  return out;
}

/**
 * The runs for a textblock, and the map from them back to the document.
 *
 * Decorations style text and atoms and never widgets, which is
 * ProseMirror's rule too: a widget is somebody else's drawing. Adjacent
 * runs that come out looking the same are merged, so an ordinary paragraph
 * is one run however many decorations touched it.
 */
export function buildInline(
  block: PMNode,
  look: InlineLook,
  decorations: readonly InlineDecoration[] = [],
  widgets: readonly InlineWidget[] = [],
): { runs: TextRun[]; map: InlineMap } {
  const size = block.content.size;
  const segments: InlineSegment[] = [];
  let pieces: Piece[] = [];
  let display = '';

  const push = (
    kind: SegmentKind,
    from: number,
    to: number,
    text: string,
    style: RunStyle,
    side = 0,
  ): void => {
    const dFrom = display.length;
    display += text;
    segments.push({ kind, from, to, dFrom, dTo: display.length, side });
    pieces.push({ dFrom, dTo: display.length, style });
  };

  const pending = widgets
    .filter((w) => w.text !== '')
    .map((w) => ({ ...w, pos: Math.max(0, Math.min(w.pos, size)) }))
    .sort((a, b) => a.pos - b.pos || a.side - b.side);
  let next = 0;
  const widgetsUpTo = (pos: number): void => {
    while (next < pending.length && pending[next].pos <= pos) {
      const w = pending[next++];
      push(
        'widget',
        w.pos,
        w.pos,
        w.text,
        { ...look.base, ...w.style },
        w.side,
      );
    }
  };

  const styleOf = (marks: readonly Mark[]): RunStyle => {
    let style = look.base;
    for (const mark of marks) style = { ...style, ...look.mark(mark, style) };
    return style;
  };

  const tokens =
    look.code && block.type.spec.code && pending.length === 0
      ? look.code(block.textContent)
      : null;
  if (tokens) {
    // A code block holds text and nothing else, so its tokens are its
    // pieces and the whole of it is one segment.
    display = block.textContent;
    if (display) {
      segments.push({
        kind: 'text',
        from: 0,
        to: size,
        dFrom: 0,
        dTo: display.length,
        side: 0,
      });
    }
    let d = 0;
    for (const run of tokens) {
      const { text, ...style } = run;
      pieces.push({ dFrom: d, dTo: d + text.length, style });
      d += text.length;
    }
  } else {
    block.forEach((child, offset) => {
      widgetsUpTo(offset);
      if (child.isText) {
        // a widget can sit inside a text node — a preedit mid-word — so the
        // text is cut at every widget position it spans
        const text = child.text ?? '';
        const style = styleOf(child.marks);
        const end = offset + child.nodeSize;
        let at = offset;
        while (next < pending.length && pending[next].pos < end) {
          const cut = pending[next].pos;
          if (cut > at)
            push('text', at, cut, text.slice(at - offset, cut - offset), style);
          at = Math.max(at, cut);
          widgetsUpTo(cut);
        }
        if (end > at) push('text', at, end, text.slice(at - offset), style);
      } else {
        const atom = look.atom(child);
        push('atom', offset, offset + 1, atom.text || '￼', {
          ...styleOf(child.marks),
          ...atom.style,
        });
      }
    });
  }
  widgetsUpTo(size);

  // A line needs something on it to have a height, and a caret needs a
  // line: an empty block is drawn as one space, and so is the line a
  // trailing hard break opens. Both map back to the position they follow.
  if (display === '') push('filler', 0, 0, ' ', look.base);
  else if (display.endsWith('\n')) push('filler', size, size, ' ', look.base);

  for (const deco of decorations) {
    for (const seg of segments) {
      if (seg.kind !== 'text' && seg.kind !== 'atom') continue;
      const from = Math.max(deco.from, seg.from);
      const to = Math.min(deco.to, seg.to);
      if (to <= from) continue;
      const a = seg.kind === 'text' ? seg.dFrom + (from - seg.from) : seg.dFrom;
      const b = seg.kind === 'text' ? seg.dFrom + (to - seg.from) : seg.dTo;
      pieces = overlay(pieces, a, b, deco.style);
    }
  }

  const runs: TextRun[] = [];
  for (const p of pieces) {
    if (p.dTo <= p.dFrom) continue;
    const text = display.slice(p.dFrom, p.dTo);
    const prev = runs[runs.length - 1];
    if (prev && sameStyle(prev, p.style)) prev.text += text;
    else runs.push({ ...p.style, text });
  }
  return { runs, map: new InlineMap(display, size, segments) };
}
