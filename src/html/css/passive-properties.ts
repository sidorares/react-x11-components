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
    'break-after': own('auto', BREAKS),
    'break-before': own('auto', BREAKS),
    'column-height': own('auto', (v) =>
      /^auto$/i.test(v.trim()) ? 'auto' : lengthOf(v.trim(), false, true),
    ),
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
    hyphens: inherited('manual', keyword('none', 'manual', 'auto')),
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
    speak: inherited('auto', keyword('auto', 'never', 'always')),
    'text-decoration-skip': inherited('auto', keyword('none', 'auto')),
    'text-decoration-skip-ink': inherited(
      'auto',
      keyword('auto', 'none', 'all'),
    ),
    'text-emphasis-color': inherited('currentcolor', colorOf),
    'text-emphasis-position': inherited('over right', (v) => {
      const words = wordsOf(v);
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
