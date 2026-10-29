// The CSS the Styles pane reads and writes, apart from how it is drawn: an
// element's `style` attribute as declarations — those switched off kept in
// it as comments, as a browser's tools keep them — the properties whose
// values are a few keywords, the values an editor takes apart and puts back
// together, and which declarations of the matched rules lose to another.
import type { HtmlMatchedRule } from '../../../src/html/index.js';
import { parseColor, splitValue } from '../../../src/html/css/values.js';

// --- an element's own style ----------------------------------------------------

export interface InlineDeclaration {
  name: string;
  value: string;
  important: boolean;
  /** False for one switched off: kept in the attribute as a comment. */
  enabled: boolean;
}

/** The declarations of a `style` attribute, a comment of the shape
 *  `/* name: value; *\/` one switched off. */
export function parseInlineStyle(text: string): InlineDeclaration[] {
  const out: InlineDeclaration[] = [];
  const take = (part: string, enabled: boolean) => {
    for (const piece of splitTop(part, ';')) {
      const at = piece.indexOf(':');
      if (at <= 0) continue;
      const name = piece.slice(0, at).trim();
      let value = piece.slice(at + 1).trim();
      const important = /!\s*important\s*$/i.test(value);
      if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
      if (name) out.push({ name, value, important, enabled });
    }
  };
  let i = 0;
  let start = 0;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      take(text.slice(start, i), true);
      const end = text.indexOf('*/', i + 2);
      take(text.slice(i + 2, end < 0 ? text.length : end), false);
      i = end < 0 ? text.length : end + 2;
      start = i;
    } else i += 1;
  }
  take(text.slice(start), true);
  return out;
}

export function serializeInlineStyle(
  declarations: readonly InlineDeclaration[],
): string {
  return declarations
    .filter((d) => d.name.trim())
    .map((d) => {
      const text = `${d.name}: ${d.value}${d.important ? ' !important' : ''};`;
      return d.enabled ? text : `/* ${text} */`;
    })
    .join(' ');
}

/** `text` split at `separator` where it is not inside brackets or quotes. */
export function splitTop(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}

// --- the properties a few keywords say all of ---------------------------------

const WIDE = ['initial', 'inherit', 'unset', 'revert'];
const BORDER_STYLES = [
  'none',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
  'hidden',
];
const OVERFLOW = ['visible', 'hidden', 'clip', 'scroll', 'auto'];
const ALIGN = [
  'normal',
  'stretch',
  'flex-start',
  'flex-end',
  'center',
  'start',
  'end',
  'baseline',
];
const JUSTIFY = [
  'normal',
  'flex-start',
  'flex-end',
  'center',
  'start',
  'end',
  'space-between',
  'space-around',
  'space-evenly',
  'stretch',
];

/** The properties whose value is one of a few keywords, and those keywords:
 *  what the pane offers a drop-down for rather than a field. */
export const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  display: [
    'block',
    'inline',
    'inline-block',
    'flex',
    'inline-flex',
    'grid',
    'inline-grid',
    'flow-root',
    'contents',
    'list-item',
    'table',
    'table-row',
    'table-cell',
    'none',
  ],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
  float: ['none', 'left', 'right', 'inline-start', 'inline-end'],
  clear: ['none', 'left', 'right', 'both'],
  visibility: ['visible', 'hidden', 'collapse'],
  overflow: OVERFLOW,
  'overflow-x': OVERFLOW,
  'overflow-y': OVERFLOW,
  'box-sizing': ['content-box', 'border-box'],
  'text-align': ['left', 'right', 'center', 'justify', 'start', 'end'],
  'text-transform': ['none', 'capitalize', 'uppercase', 'lowercase'],
  'font-style': ['normal', 'italic', 'oblique'],
  'font-weight': [
    'normal',
    'bold',
    'lighter',
    'bolder',
    '100',
    '200',
    '300',
    '400',
    '500',
    '600',
    '700',
    '800',
    '900',
  ],
  'white-space': [
    'normal',
    'nowrap',
    'pre',
    'pre-wrap',
    'pre-line',
    'break-spaces',
  ],
  'word-break': ['normal', 'break-all', 'keep-all', 'break-word'],
  'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
  'flex-wrap': ['nowrap', 'wrap', 'wrap-reverse'],
  'justify-content': JUSTIFY,
  'align-content': JUSTIFY,
  'align-items': ALIGN,
  'align-self': ['auto', ...ALIGN],
  'justify-items': ['legacy', ...ALIGN],
  'justify-self': ['auto', ...ALIGN],
  cursor: [
    'auto',
    'default',
    'pointer',
    'text',
    'move',
    'grab',
    'grabbing',
    'not-allowed',
    'wait',
    'progress',
    'crosshair',
    'help',
    'none',
  ],
  'pointer-events': ['auto', 'none'],
  'user-select': ['auto', 'none', 'text', 'all'],
  'list-style-type': [
    'disc',
    'circle',
    'square',
    'decimal',
    'decimal-leading-zero',
    'lower-alpha',
    'upper-alpha',
    'lower-roman',
    'upper-roman',
    'none',
  ],
  'list-style-position': ['outside', 'inside'],
  'border-style': BORDER_STYLES,
  'border-top-style': BORDER_STYLES,
  'border-right-style': BORDER_STYLES,
  'border-bottom-style': BORDER_STYLES,
  'border-left-style': BORDER_STYLES,
  'outline-style': ['auto', ...BORDER_STYLES],
  'text-decoration-line': ['none', 'underline', 'overline', 'line-through'],
  'text-decoration-style': ['solid', 'double', 'dotted', 'dashed', 'wavy'],
  'object-fit': ['fill', 'contain', 'cover', 'none', 'scale-down'],
  resize: ['none', 'both', 'horizontal', 'vertical'],
  direction: ['ltr', 'rtl'],
  'writing-mode': ['horizontal-tb', 'vertical-rl', 'vertical-lr'],
  'table-layout': ['auto', 'fixed'],
  'border-collapse': ['separate', 'collapse'],
  isolation: ['auto', 'isolate'],
  'mix-blend-mode': [
    'normal',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'difference',
    'exclusion',
  ],
  'background-repeat': [
    'repeat',
    'no-repeat',
    'repeat-x',
    'repeat-y',
    'space',
    'round',
  ],
  'background-attachment': ['scroll', 'fixed', 'local'],
  'background-size': ['auto', 'cover', 'contain'],
  'text-overflow': ['clip', 'ellipsis'],
  'content-visibility': ['visible', 'auto', 'hidden'],
  'scroll-behavior': ['auto', 'smooth'],
  appearance: ['auto', 'none'],
};

/** The keywords of a property the drop-down offers, the CSS-wide ones
 *  after them; null for a property a field edits. */
export function keywordsOf(property: string): readonly string[] | null {
  const own = KEYWORDS[property.toLowerCase()];
  return own ? [...own, ...WIDE] : null;
}

// --- what an editor takes apart ------------------------------------------------

export const isColor = (token: string): boolean => parseColor(token) !== null;

/** A length as the editors step it: its number and its unit. */
export function lengthParts(text: string): { n: number; unit: string } | null {
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/i.exec(text.trim());
  return m
    ? { n: Number(m[1]), unit: m[2] || (Number(m[1]) === 0 ? '' : 'px') }
    : null;
}

export interface Shadow {
  inset: boolean;
  x: string;
  y: string;
  blur: string;
  spread: string;
  color: string;
}

export function parseShadows(value: string): Shadow[] {
  if (value.trim().toLowerCase() === 'none') return [];
  return splitTop(value, ',').map((one) => {
    const words = splitValue(one);
    const lengths: string[] = [];
    let color = '';
    let inset = false;
    for (const w of words) {
      if (w.toLowerCase() === 'inset') inset = true;
      else if (lengthParts(w)) lengths.push(w);
      else color = color ? `${color} ${w}` : w;
    }
    return {
      inset,
      x: lengths[0] ?? '0',
      y: lengths[1] ?? '0',
      blur: lengths[2] ?? '0',
      spread: lengths[3] ?? '0',
      color: color || 'rgba(0, 0, 0, 0.25)',
    };
  });
}

export function serializeShadows(
  shadows: readonly Shadow[],
  spread = true,
): string {
  if (!shadows.length) return 'none';
  return shadows
    .map((s) =>
      [
        s.inset ? 'inset' : '',
        s.x,
        s.y,
        s.blur,
        spread && s.spread !== '0' ? s.spread : '',
        s.color,
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join(', ');
}

export interface Flex {
  grow: string;
  shrink: string;
  basis: string;
}

export function parseFlex(value: string): Flex {
  const v = value.trim().toLowerCase();
  if (v === 'none') return { grow: '0', shrink: '0', basis: 'auto' };
  if (v === 'auto') return { grow: '1', shrink: '1', basis: 'auto' };
  if (v === 'initial' || !v) return { grow: '0', shrink: '1', basis: 'auto' };
  const words = splitValue(value);
  const numbers = words.filter((w) => /^\d*\.?\d+$/.test(w));
  const basis = words.find((w) => !/^\d*\.?\d+$/.test(w));
  return {
    grow: numbers[0] ?? '1',
    shrink: numbers[1] ?? '1',
    basis: basis ?? (numbers.length ? '0%' : 'auto'),
  };
}

export const serializeFlex = (f: Flex): string =>
  `${f.grow} ${f.shrink} ${f.basis}`;

export interface Border {
  width: string;
  style: string;
  color: string;
}

export function parseBorder(value: string): Border {
  const out: Border = { width: 'medium', style: 'none', color: 'currentcolor' };
  for (const w of splitValue(value)) {
    if (BORDER_STYLES.includes(w.toLowerCase())) out.style = w;
    else if (isColor(w)) out.color = w;
    else out.width = w;
  }
  return out;
}

export const serializeBorder = (b: Border): string =>
  [b.width, b.style, b.color].filter(Boolean).join(' ');

export interface Background {
  color: string;
  image: string;
  position: string;
  size: string;
  repeat: string;
}

/** A `background` of one layer, its parts as the editor shows them; null
 *  for more layers than one, which the field edits as written. */
export function parseBackground(value: string): Background | null {
  if (splitTop(value, ',').length > 1) return null;
  const out: Background = {
    color: '',
    image: '',
    position: '',
    size: '',
    repeat: '',
  };
  const [placing, sizing] = splitTop(value, '/');
  const words = splitValue(placing ?? '');
  const position: string[] = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (
      /^(?:url|(?:repeating-)?(?:linear|radial|conic)-gradient|image-set)\(/i.test(
        w,
      )
    ) {
      out.image = w;
    } else if (KEYWORDS['background-repeat'].includes(lower)) {
      out.repeat = out.repeat ? `${out.repeat} ${w}` : w;
    } else if (isColor(w)) out.color = w;
    else if (lower !== 'scroll' && lower !== 'fixed' && lower !== 'local') {
      position.push(w);
    }
  }
  out.position = position.join(' ');
  if (sizing) {
    const rest = splitValue(sizing);
    const sizeWords: string[] = [];
    for (const w of rest) {
      if (isColor(w)) out.color = w;
      else if (KEYWORDS['background-repeat'].includes(w.toLowerCase()))
        out.repeat = w;
      else sizeWords.push(w);
    }
    out.size = sizeWords.join(' ');
  }
  return out;
}

export function serializeBackground(b: Background): string {
  const place = b.position || (b.size ? 'center' : '');
  const parts = [
    b.image,
    place && b.size ? `${place} / ${b.size}` : place,
    b.repeat,
    b.color,
  ].filter(Boolean);
  return parts.join(' ') || 'none';
}

/** A track list's tracks: what `grid-template-columns` lists, each whole. */
export const parseTracks = (value: string): string[] =>
  value.trim().toLowerCase() === 'none' ? [] : splitValue(value);

export const serializeTracks = (tracks: readonly string[]): string =>
  tracks.filter(Boolean).join(' ') || 'none';

/** Which editor a declaration's value is opened in, where it has one. */
export type EditorKind =
  | 'shadow'
  | 'text-shadow'
  | 'flex'
  | 'tracks'
  | 'border'
  | 'background'
  | 'color';

export function editorFor(property: string, value: string): EditorKind | null {
  const p = property.toLowerCase();
  if (p === 'box-shadow') return 'shadow';
  if (p === 'text-shadow') return 'text-shadow';
  if (p === 'flex') return 'flex';
  if (p === 'grid-template-columns' || p === 'grid-template-rows')
    return 'tracks';
  if (/^(?:border|outline)(?:-(?:top|right|bottom|left))?$/.test(p))
    return 'border';
  if (p === 'background' && parseBackground(value)) return 'background';
  if (p.endsWith('color') || p === 'fill' || p === 'stroke') return 'color';
  if (p === 'background') return null;
  return isColor(value) ? 'color' : null;
}

// --- which declaration wins -----------------------------------------------------

const SIDES = ['top', 'right', 'bottom', 'left'];
const sides = (pattern: (side: string) => string) => SIDES.map(pattern);

/** What a shorthand sets: the longhands a declaration of it competes for. */
const SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
  margin: sides((s) => `margin-${s}`),
  padding: sides((s) => `padding-${s}`),
  inset: SIDES,
  border: SIDES.flatMap((s) => [
    `border-${s}-width`,
    `border-${s}-style`,
    `border-${s}-color`,
  ]),
  'border-width': sides((s) => `border-${s}-width`),
  'border-style': sides((s) => `border-${s}-style`),
  'border-color': sides((s) => `border-${s}-color`),
  ...Object.fromEntries(
    SIDES.map((s) => [
      `border-${s}`,
      [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`],
    ]),
  ),
  'border-radius': [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  background: [
    'background-color',
    'background-image',
    'background-position',
    'background-size',
    'background-repeat',
    'background-attachment',
    'background-origin',
    'background-clip',
  ],
  font: [
    'font-style',
    'font-variant',
    'font-weight',
    'font-stretch',
    'font-size',
    'line-height',
    'font-family',
  ],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'grid-template': [
    'grid-template-rows',
    'grid-template-columns',
    'grid-template-areas',
  ],
  grid: [
    'grid-template-rows',
    'grid-template-columns',
    'grid-template-areas',
    'grid-auto-rows',
    'grid-auto-columns',
    'grid-auto-flow',
  ],
  'grid-area': [
    'grid-row-start',
    'grid-column-start',
    'grid-row-end',
    'grid-column-end',
  ],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'text-decoration': [
    'text-decoration-line',
    'text-decoration-style',
    'text-decoration-color',
    'text-decoration-thickness',
  ],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  transition: [
    'transition-property',
    'transition-duration',
    'transition-timing-function',
    'transition-delay',
  ],
  columns: ['column-width', 'column-count'],
};

const longhandsOf = (property: string): readonly string[] => {
  const p = property.startsWith('--') ? property : property.toLowerCase();
  return SHORTHANDS[p] ?? [p];
};

/**
 * Which declarations of the matched rules lose, rule by rule: one loses
 * where every longhand it sets is won by another. Normal declarations are
 * won in the rules' order — the element's own style first — and, in one
 * rule, by the last; an `!important` one wins over every normal one, the
 * user agent's over the element's own over the author's, as the cascade
 * turns them round (CSS Cascade 5, 6.1).
 */
export function overridden(rules: readonly HtmlMatchedRule[]): boolean[][] {
  const winners = new Map<string, string>();
  const rank = (rule: HtmlMatchedRule) =>
    rule.origin === 'user-agent' ? 0 : rule.origin === 'inline' ? 1 : 2;
  const importantFirst = rules
    .map((rule, i) => ({ rule, i }))
    .sort((a, b) => rank(a.rule) - rank(b.rule));
  const claim = (i: number, j: number, property: string) => {
    for (const longhand of longhandsOf(property)) {
      if (!winners.has(longhand)) winners.set(longhand, `${i}:${j}`);
    }
  };
  for (const { rule, i } of importantFirst) {
    for (let j = rule.declarations.length - 1; j >= 0; j -= 1) {
      const d = rule.declarations[j];
      if (d.important) claim(i, j, d.property);
    }
  }
  rules.forEach((rule, i) => {
    for (let j = rule.declarations.length - 1; j >= 0; j -= 1) {
      const d = rule.declarations[j];
      if (!d.important) claim(i, j, d.property);
    }
  });
  return rules.map((rule, i) =>
    rule.declarations.map(
      (d, j) =>
        !longhandsOf(d.property).some((l) => winners.get(l) === `${i}:${j}`),
    ),
  );
}
