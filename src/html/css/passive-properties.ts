// Properties a style holds and reads back that nothing here lays out or
// paints by yet: a page sets them, `el.style` keeps them as their grammars
// have them, `getComputedStyle` and Typed OM read them, and an inherited one
// passes to the children, as a browser has them all. What each draws —
// a resize handle, a palette, a hyphen — is a change to the layout or the
// paint of its own, and these leave every box as it was.
//
// A style holds what was set of them in two records, the inherited ones'
// and the rest's (`passiveInherited` and `passive`), a property missing
// from its record being at its initial value. Both are kept as they were
// set, and a change makes a new record, so a style that shares one with
// its parent or the initial style changes neither.

/** A value of a property in its canonical form, or null for none. */
type Take = (value: string) => string | null;

/** One keyword of a list, in lower case. */
const keyword =
  (...words: string[]): Take =>
  (value) => {
    const v = value.trim().toLowerCase();
    return words.includes(v) ? v : null;
  };

/** The words of a value, in lower case. */
const wordsOf = (value: string): string[] =>
  value.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** Words taken in any order, each from one of the groups and each group
 *  at most once, at least one, said in the groups' order. */
const anyOrder =
  (...groups: string[][]): Take =>
  (value) => {
    const words = wordsOf(value);
    const picked: (string | null)[] = groups.map(() => null);
    for (const w of words) {
      const g = groups.findIndex((group, i) => group.includes(w) && !picked[i]);
      if (g < 0) return null;
      picked[g] = w;
    }
    return words.length ? picked.filter(Boolean).join(' ') : null;
  };

const LENGTH_UNIT =
  /^(?:px|cm|mm|q|in|pt|pc|em|rem|ex|rex|ch|rch|ic|ric|cap|rcap|lh|rlh|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/;

/** A length, a percentage where `percent`, or a unitless zero as `0px`;
 *  a math function as written. */
const lengthOf = (
  token: string,
  percent: boolean,
  nonNegative = false,
): string | null => {
  if (/^(?:calc|min|max|clamp)\(/i.test(token)) return token;
  const m = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i.exec(
    token,
  );
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (nonNegative && n < 0) return null;
  if (!unit) return n === 0 ? '0px' : null;
  if (unit === '%' ? !percent : !LENGTH_UNIT.test(unit)) return null;
  return `${Object.is(n, -0) ? 0 : n}${unit}`;
};

/** A `<position>` of one to four words as written, in lower case. */
const positionOf = (value: string): string | null => {
  const words = wordsOf(value);
  if (!words.length || words.length > 4) return null;
  const ok = words.every(
    (w) =>
      /^(?:left|right|top|bottom|center)$/.test(w) ||
      lengthOf(w, true) !== null,
  );
  return ok ? words.map((w) => lengthOf(w, true) ?? w).join(' ') : null;
};

const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'plus-darker',
  'plus-lighter',
];

const BREAKS = keyword(
  'auto',
  'avoid',
  'avoid-page',
  'page',
  'left',
  'right',
  'recto',
  'verso',
  'avoid-column',
  'column',
  'avoid-region',
  'region',
);

/** A colour as written, in lower case where it is a keyword: what the
 *  cascade's colours would compute it to is no record's. */
const colorOf: Take = (value) => {
  const v = value.trim();
  if (!v) return null;
  if (/^[a-z-]+$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v.toLowerCase();
  return /^[a-z-]+\(.*\)$/is.test(v) ? v : null;
};

/** What a passive property is: its initial value, whether it inherits,
 *  and what it takes. */
export interface PassiveProperty {
  initial: string;
  inherited: boolean;
  take: Take;
}

const own = (initial: string, take: Take): PassiveProperty => ({
  initial,
  inherited: false,
  take,
});
const inherited = (initial: string, take: Take): PassiveProperty => ({
  initial,
  inherited: true,
  take,
});

/** Each passive property by name. */
export const PASSIVE: Record<string, PassiveProperty> = Object.assign(
  Object.create(null),
  {
    'accent-color': inherited('auto', (v) =>
      /^auto$/i.test(v.trim()) ? 'auto' : colorOf(v),
    ),
    'background-blend-mode': own('normal', (v) => {
      const items = v.split(',').map((x) => x.trim().toLowerCase());
      return items.every((x) => BLEND_MODES.includes(x))
        ? items.join(', ')
        : null;
    }),
    'baseline-shift': own('0px', (v) => {
      const w = v.trim().toLowerCase();
      if (/^(?:sub|super|baseline|top|center|bottom)$/.test(w)) return w;
      return lengthOf(w, true);
    }),
    // read by the columns as well, for a forced break (`forces` in
    // layout/multicol.ts): a change of one is a change of the style, which
    // lays the columns out again as any other does
    'break-after': own('auto', BREAKS),
    'break-before': own('auto', BREAKS),
    'column-height': own('auto', (v) =>
      /^auto$/i.test(v.trim()) ? 'auto' : lengthOf(v.trim(), false, true),
    ),
    'column-wrap': own('auto', keyword('auto', 'nowrap', 'wrap')),
    'scroll-marker-group': own('none', keyword('none', 'before', 'after')),
    'font-palette': inherited('normal', (v) => {
      const w = v.trim();
      if (/^(?:normal|light|dark)$/i.test(w)) return w.toLowerCase();
      return /^--[\w-]+$/.test(w) ? w : null;
    }),
    'font-synthesis-weight': inherited('auto', keyword('auto', 'none')),
    'font-synthesis-style': inherited(
      'auto',
      keyword('auto', 'none', 'oblique-only'),
    ),
    'font-synthesis-small-caps': inherited('auto', keyword('auto', 'none')),
    // `none` is read as the boxes are built, and takes a soft hyphen's
    // break away (`heldText`); no hyphen is drawn at a break
    hyphens: inherited('manual', keyword('none', 'manual', 'auto')),
    // read where an image is sized and drawn (`storedAsWritten`): `none`
    // is the image as its file stores it, with no EXIF turn (CSS Images
    // 3, 5.3)
    'image-orientation': inherited('from-image', keyword('from-image', 'none')),
    'offset-anchor': own('auto', (v) =>
      /^auto$/i.test(v.trim()) ? 'auto' : positionOf(v),
    ),
    'offset-distance': own('0px', (v) => lengthOf(v.trim(), true)),
    'offset-path': own('none', (v) => {
      const w = v.trim();
      if (/^none$/i.test(w)) return 'none';
      return /^[a-z-]+\(.*\)(?:\s+[a-z-]+)?$/is.test(w) ? w : null;
    }),
    'offset-position': own('normal', (v) =>
      /^(?:normal|auto)$/i.test(v.trim())
        ? v.trim().toLowerCase()
        : positionOf(v),
    ),
    'offset-rotate': own('auto', (v) => {
      const words = wordsOf(v);
      if (!words.length || words.length > 2) return null;
      let mode: string | null = null;
      let angle: string | null = null;
      for (const w of words) {
        if (!mode && /^(?:auto|reverse)$/.test(w)) mode = w;
        else if (
          !angle &&
          /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|grad|rad|turn)$/.test(w)
        ) {
          angle = w;
        } else if (!angle && w === '0') angle = '0deg';
        else return null;
      }
      return [mode, angle].filter(Boolean).join(' ');
    }),
    // which edges of a container trim the margins of what it holds (CSS
    // Box 4, 3.3): read by layout (`marginTrimOf`), which is why it is no
    // longer only passive
    'margin-trim': own('none', (v) => {
      const words = wordsOf(v);
      if (words.length === 1 && words[0] === 'none') return 'none';
      return (
        anyOrder(['block'], ['inline'])(v) ??
        anyOrder(
          ['block-start'],
          ['inline-start'],
          ['block-end'],
          ['inline-end'],
        )(v)
      );
    }),
    'overflow-anchor': own('auto', keyword('auto', 'none')),
    'overscroll-behavior-x': own('auto', keyword('contain', 'none', 'auto')),
    'overscroll-behavior-y': own('auto', keyword('contain', 'none', 'auto')),
    page: own('auto', (v) => {
      const w = v.trim();
      if (/^auto$/i.test(w)) return 'auto';
      return /^-?[a-z_][\w-]*$/i.test(w) &&
        !/^(?:inherit|initial|unset|revert|revert-layer|default)$/i.test(w)
        ? w
        : null;
    }),
    resize: own(
      'none',
      keyword('none', 'both', 'horizontal', 'vertical', 'block', 'inline'),
    ),
    'scroll-behavior': own('auto', keyword('auto', 'smooth')),
    'scrollbar-gutter': own('auto', (v) => {
      const words = wordsOf(v);
      if (
        words.length === 1 &&
        (words[0] === 'auto' || words[0] === 'stable')
      ) {
        return words[0];
      }
      return words.length === 2 &&
        words.includes('stable') &&
        words.includes('both-edges')
        ? 'stable both-edges'
        : null;
    }),
    // ruby (CSS Ruby 1), which `fixUpRuby` and `placeRuby` lay out by
    'ruby-align': inherited(
      'space-around',
      keyword('start', 'center', 'space-between', 'space-around'),
    ),
    // whether an annotation wider than its base may hang over the spaces
    // beside its ruby (CSS Ruby 1, 4.2), which `rubyOverhang` reads
    'ruby-overhang': inherited('auto', keyword('auto', 'none', 'spaces')),
    'ruby-position': inherited('alternate', (v) => {
      const words = wordsOf(v);
      if (words.length === 1 && words[0] === 'inter-character') {
        return words[0];
      }
      return anyOrder(['alternate'], ['over', 'under'])(v);
    }),
    speak: inherited('auto', keyword('auto', 'never', 'always')),
    'text-decoration-skip': inherited('auto', keyword('none', 'auto')),
    // where an underline or a line through leaves a space out (CSS Text
    // Decoration 4, 2.4): at a line's start and end, or every one;
    // `paintRules` reads it, written back `start end` in that order
    'text-decoration-skip-spaces': inherited('start end', (v) => {
      const words = wordsOf(v);
      if (words.length === 1 && (words[0] === 'none' || words[0] === 'all')) {
        return words[0];
      }
      return anyOrder(['start'], ['end'])(v);
    }),
    'text-decoration-skip-ink': inherited(
      'auto',
      keyword('auto', 'none', 'all'),
    ),
    'text-emphasis-color': inherited('currentcolor', colorOf),
    // the marks `paintEmphasis` draws: `none`, a fill and a shape, either
    // left out where the other is said, or a string of one character
    'text-emphasis-style': inherited('none', (v) => {
      const t = v.trim();
      const quoted = /^(["'])(.*)\1$/s.exec(t);
      if (quoted) return JSON.stringify(quoted[2]);
      const words = wordsOf(t);
      if (words.length === 1 && words[0] === 'none') return 'none';
      const fill = words.filter((w) => w === 'filled' || w === 'open');
      const shape = words.filter((w) =>
        ['dot', 'circle', 'double-circle', 'triangle', 'sesame'].includes(w),
      );
      if (
        fill.length > 1 ||
        shape.length > 1 ||
        fill.length + shape.length !== words.length ||
        !words.length
      ) {
        return null;
      }
      return [fill[0] ?? 'filled', shape[0]].filter(Boolean).join(' ');
    }),
    'text-emphasis-position': inherited('over right', (v) => {
      const words = wordsOf(v);
      if (words.length === 1 && words[0] === 'auto') return 'auto';
      const side = words.find((w) => w === 'over' || w === 'under');
      const edge = words.find((w) => w === 'right' || w === 'left');
      if (!side || words.length > 2 || (words.length === 2 && !edge))
        return null;
      return edge ? `${side} ${edge}` : side;
    }),
    'text-size-adjust': inherited('auto', (v) => {
      const w = v.trim().toLowerCase();
      if (w === 'auto' || w === 'none') return w;
      return /^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(w)
        ? `${Number(w.slice(0, -1))}%`
        : null;
    }),
    'text-underline-position': inherited('auto', (v) => {
      const words = wordsOf(v);
      if (
        words.length === 1 &&
        (words[0] === 'auto' || words[0] === 'from-font')
      ) {
        return words[0];
      }
      return anyOrder(['under', 'from-font'], ['left', 'right'])(v);
    }),
    'transform-box': own(
      'view-box',
      keyword(
        'content-box',
        'border-box',
        'fill-box',
        'stroke-box',
        'view-box',
      ),
    ),
    'transform-style': own('flat', keyword('flat', 'preserve-3d')),
    'white-space-trim': own('none', (v) =>
      /^none$/i.test(v.trim())
        ? 'none'
        : anyOrder(['discard-before'], ['discard-after'], ['discard-inner'])(v),
    ),
  },
);

/** A record of passive properties, of none of them. */
export const NO_PASSIVE: Readonly<Record<string, string>> = Object.freeze(
  Object.create(null),
);

/** A passive property's value in a style's record, or its initial value. */
export function passiveValue(
  record: Readonly<Record<string, string>>,
  name: string,
): string {
  return record[name] ?? PASSIVE[name].initial;
}

/** Whether a style draws its images as their files store them, with no
 *  turn for their EXIF orientation: `image-orientation: none`. */
export function storedAsWritten(style: {
  passiveInherited: Readonly<Record<string, string>>;
}): boolean {
  return style.passiveInherited['image-orientation'] === 'none';
}

/** A box's `margin-trim` as which of its edges trim: block-start (1),
 *  block-end (2), inline-start (4) and inline-end (8). */
export function marginTrimOf(
  passive: Readonly<Record<string, string>>,
): number {
  const v = passive['margin-trim'];
  if (v === undefined || v === 'none') return 0;
  let bits = 0;
  for (const w of v.split(' ')) {
    if (w === 'block') bits |= 3;
    else if (w === 'inline') bits |= 12;
    else if (w === 'block-start') bits |= 1;
    else if (w === 'block-end') bits |= 2;
    else if (w === 'inline-start') bits |= 4;
    else if (w === 'inline-end') bits |= 8;
  }
  return bits;
}
