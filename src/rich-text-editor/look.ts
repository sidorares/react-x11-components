// What the document looks like: the theme, read once per render, into the
// styles every block and mark is drawn with.
//
// The numbers are `<Markdown>`'s (src/markdown/index.ts, `deriveLook`) — the
// heading scales, the block gap, the chip behind inline code — and a fenced
// block's whole look comes from the same shared module both use
// (`src/codeblock/`). A component never imports another, so the two are kept
// in step by value: a note edited here and rendered there should look like
// one document, and a change to one of these numbers belongs in both.
//
// A schema this file has never heard of still gets a look. A node or mark is
// recognised by name first (the reference schema's, then TipTap's), and then
// by the tag its own `toDOM` writes: an unknown node that says `['h2', 0]` is
// a second-level heading, an unknown mark that says `['u', 0]` underlines, and
// a `style` attribute on either is read for the few properties text can
// carry. The app's `markStyles` has the last word.
import { tint } from 'react-x11/style';
import type { Mark, Node as PMNode } from 'prosemirror-model';

import { codeBlockLook, codeBlockRuns } from '../codeblock/index.js';
import type { CodeBlockLook } from '../codeblock/index.js';
import type { Language } from '../code-language/index.js';
import type { InlineLook, RunStyle } from './inline.js';

/** How a mark looks: a fixed style, or one worked out from what it covers. */
export type MarkStyle = RunStyle | ((mark: Mark, under: RunStyle) => RunStyle);

export interface LookOptions {
  fontSize?: number;
  fontFamily?: string;
  monoFamily?: string;
  markStyles?: Readonly<Record<string, MarkStyle>>;
  resolveLanguage?: (tag: string) => Language | null;
  highlight?: boolean;
  /** A disabled editor: the document is set in the muted ink. (react-x11
   *  styles have no opacity to fade a subtree with.) */
  dim?: boolean;
}

/** Where a textblock sits, as far as its look is concerned. */
export interface BlockContext {
  /** Inside a blockquote: set in the muted ink, as `<Markdown>` sets it. */
  quote: boolean;
  /** A table's header row. */
  header: boolean;
}

export interface EditorLook {
  size: number;
  family: string;
  mono: string;
  text: string;
  muted: string;
  link: string;
  accent: string;
  accentText: string;
  border: string;
  background: string;
  surface: string;
  selection: string;
  /** The selection while focus is elsewhere — still there, but quieter. */
  selectionBlurred: string;
  caret: string;
  codeBg: string;
  headerBg: string;
  highlight: string;
  radius: number;
  blockGap: number;
  headingScales: readonly number[];
  code: CodeBlockLook;
  /** Two looks with the same key draw identically — the render cache's epoch. */
  key: string;
  /** A textblock's inline look. Cached: the same node type in the same
   *  context is the same object, which is what lets a block that did not
   *  change skip its layout. */
  inline(node: PMNode, context: BlockContext): InlineLook;
}

const HEADING_SCALES = [1.75, 1.4, 1.2, 1.05, 0.95, 0.85] as const;

type Role =
  | 'strong'
  | 'em'
  | 'code'
  | 'strike'
  | 'link'
  | 'underline'
  | 'highlight'
  | 'sub'
  | 'sup'
  | 'textStyle';

const MARK_ROLES: Record<string, Role> = {
  strong: 'strong',
  bold: 'strong',
  b: 'strong',
  em: 'em',
  italic: 'em',
  i: 'em',
  code: 'code',
  strike: 'strike',
  strikethrough: 'strike',
  s: 'strike',
  del: 'strike',
  link: 'link',
  a: 'link',
  underline: 'underline',
  u: 'underline',
  highlight: 'highlight',
  mark: 'highlight',
  subscript: 'sub',
  sub: 'sub',
  superscript: 'sup',
  sup: 'sup',
  textStyle: 'textStyle',
  span: 'textStyle',
};

/** The tag and attributes a node's or mark's `toDOM` writes, if it writes an
 *  array — the one shape readable without a DOM. */
export function domTagOf(
  spec: { toDOM?: unknown } | undefined,
  value: unknown,
): { tag: string; attrs: Record<string, unknown> } | null {
  const toDOM = spec?.toDOM as
    ((v: unknown, inline?: boolean) => unknown) | undefined;
  if (typeof toDOM !== 'function') return null;
  try {
    const out = toDOM(value, true);
    if (!Array.isArray(out) || typeof out[0] !== 'string') return null;
    const second = out[1];
    const attrs =
      second && typeof second === 'object' && !Array.isArray(second)
        ? (second as Record<string, unknown>)
        : {};
    return { tag: out[0].replace(/^.*\s/, '').toLowerCase(), attrs };
  } catch {
    // a `toDOM` that builds real DOM nodes has no document to build them in
    return null;
  }
}

/**
 * The part of a CSS declaration block text can carry — colour, background,
 * weight, style, decoration, family, pixel size. What a decoration's
 * `style` attribute and an unknown mark's `toDOM` attributes are read
 * through; everything else in them is ignored.
 */
export function styleFromCSS(css: string, under: RunStyle): RunStyle {
  const out: RunStyle = {};
  for (const decl of css.split(';')) {
    const colon = decl.indexOf(':');
    if (colon <= 0) continue;
    const name = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (!value) continue;
    switch (name) {
      case 'color':
        out.color = value;
        break;
      case 'background':
      case 'background-color':
        out.bg = value;
        break;
      case 'font-weight': {
        const n = Number(value);
        if (value === 'bold' || value === 'bolder' || n >= 600)
          out.weight = 700;
        else if (value === 'normal' || (Number.isFinite(n) && n < 600))
          out.weight = 'normal';
        break;
      }
      case 'font-style':
        out.style =
          value === 'italic' || value === 'oblique' ? 'italic' : 'normal';
        break;
      case 'text-decoration':
      case 'text-decoration-line':
        if (/line-through/.test(value))
          out.strike = out.color ?? under.color ?? 'currentColor';
        if (/underline/.test(value))
          out.underline = out.color ?? under.color ?? 'currentColor';
        break;
      case 'font-family':
        out.family = value;
        break;
      case 'font-size': {
        const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
        if (px) out.size = Number(px[1]);
        break;
      }
    }
  }
  return out;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback;
}

/** The first word of a code block's info string — its language. */
function languageOf(node: PMNode): string {
  const info = node.attrs.params ?? node.attrs.language ?? '';
  return String(info).trim().split(/\s/, 1)[0].toLowerCase();
}

/** What kind of textblock this is, for its look: its name, then its tag. */
function blockKind(node: PMNode): {
  kind: 'paragraph' | 'heading' | 'code';
  level: number;
} {
  const name = node.type.name;
  if (node.type.spec.code || name === 'code_block' || name === 'codeBlock') {
    return { kind: 'code', level: 0 };
  }
  if (name === 'heading') {
    return { kind: 'heading', level: Number(node.attrs.level ?? 1) };
  }
  const dom = domTagOf(node.type.spec, node);
  const h = dom && /^h([1-6])$/.exec(dom.tag);
  if (h) return { kind: 'heading', level: Number(h[1]) };
  if (dom?.tag === 'pre') return { kind: 'code', level: 0 };
  return { kind: 'paragraph', level: 0 };
}

export function deriveLook(
  theme: Record<string, unknown>,
  options: LookOptions,
): EditorLook {
  const muted = str(theme.textMuted, '#7f8c8d');
  const text = options.dim ? muted : str(theme.text, '#2d3436');
  const accent = str(theme.accent, '#2980b9');
  const accentText = str(theme.accentText, '#ffffff');
  const link = str(theme.link, accent);
  const border = str(theme.border, '#b2bec3');
  const background = str(theme.background, '#ffffff');
  const surface = str(theme.surface, background);
  const size = options.fontSize ?? Number(theme.fontSize ?? 14);
  const family = options.fontFamily ?? str(theme.fontFamily, 'sans-serif');
  const mono = options.monoFamily ?? 'monospace';
  const selection = str(theme.selection, tint(accent, 0.35));
  const caret = str(theme.caret, text);
  const code = codeBlockLook(theme, { baseSize: size, monoFamily: mono });
  const codeBg = tint(text, 0.08);
  const highlight = tint('#f5c400', 0.45);
  const radius = Number(theme.radius ?? 6);

  const markStyles = options.markStyles;
  const resolveLanguage = options.resolveLanguage;
  const highlightCode = options.highlight !== false;

  const markStyle = (mark: Mark, under: RunStyle): RunStyle => {
    const role =
      MARK_ROLES[mark.type.name] ??
      MARK_ROLES[domTagOf(mark.type.spec, mark)?.tag ?? ''];
    let out: RunStyle = {};
    switch (role) {
      case 'strong':
        out = { weight: 700 };
        break;
      case 'em':
        out = { style: 'italic' };
        break;
      case 'code':
        out = {
          family: mono,
          size: Math.round((under.size ?? size) * 0.9),
          color: under.color === muted ? muted : text,
          bg: codeBg,
        };
        break;
      case 'strike':
        out = { strike: under.color ?? text };
        break;
      case 'link': {
        const href = mark.attrs.href;
        out = {
          color: link,
          underline: link,
          href: typeof href === 'string' ? href : null,
        };
        break;
      }
      case 'underline':
        out = { underline: under.color ?? text };
        break;
      case 'highlight':
        out = { bg: str(mark.attrs.color, highlight) };
        break;
      case 'sub':
      case 'sup':
        out = { size: Math.round((under.size ?? size) * 0.8) };
        break;
      case 'textStyle': {
        const a = mark.attrs as Record<string, unknown>;
        if (typeof a.color === 'string') out.color = a.color;
        if (typeof a.fontFamily === 'string') out.family = a.fontFamily;
        if (typeof a.fontSize === 'string') {
          const px = /^(\d+(?:\.\d+)?)px$/.exec(a.fontSize);
          if (px) out.size = Number(px[1]);
        }
        break;
      }
    }
    // an unknown mark's own `style` attribute, and a known one's too
    const dom = domTagOf(mark.type.spec, mark);
    if (dom && typeof dom.attrs.style === 'string') {
      out = { ...out, ...styleFromCSS(dom.attrs.style, { ...under, ...out }) };
    }
    const custom = markStyles?.[mark.type.name];
    if (custom) {
      const merged = { ...under, ...out };
      out = {
        ...out,
        ...(typeof custom === 'function' ? custom(mark, merged) : custom),
      };
    }
    return out;
  };

  const atom = (node: PMNode): { text: string; style?: RunStyle } => {
    const name = node.type.name;
    if (
      name === 'hard_break' ||
      name === 'hardBreak' ||
      domTagOf(node.type.spec, node)?.tag === 'br'
    ) {
      return { text: '\n' };
    }
    if (name === 'image') {
      const src = String(node.attrs.src ?? '');
      const label =
        str(node.attrs.alt, '') ||
        str(node.attrs.title, '') ||
        src.split(/[/\\]/).pop() ||
        'image';
      return { text: label, style: { color: muted, bg: codeBg } };
    }
    const leaf = node.type.spec.leafText?.(node) ?? '';
    return { text: leaf || name, style: { color: muted, bg: codeBg } };
  };

  const cache = new Map<string, InlineLook>();
  const inline = (node: PMNode, context: BlockContext): InlineLook => {
    const { kind, level } = blockKind(node);
    const lang = kind === 'code' ? languageOf(node) : '';
    const key = `${node.type.name}|${kind}|${level}|${lang}|${context.quote ? 'q' : ''}${context.header ? 'h' : ''}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const ink = context.quote ? muted : text;
    let base: RunStyle;
    if (kind === 'heading') {
      const scale = HEADING_SCALES[Math.max(1, Math.min(6, level)) - 1];
      base = {
        family,
        size: Math.round(size * scale),
        weight: 700,
        color: ink,
      };
    } else if (kind === 'code') {
      base = { family: code.family, size: code.size, color: code.color };
    } else {
      base = {
        family,
        size,
        color: ink,
        ...(context.header ? { weight: 700 } : null),
      };
    }
    const look: InlineLook = {
      base,
      mark: markStyle,
      atom,
      ...(kind === 'code'
        ? {
            code: (source: string) =>
              codeBlockRuns(source, code, {
                lang,
                highlight: highlightCode,
                ...(resolveLanguage ? { resolveLanguage } : null),
              }),
          }
        : null),
    };
    cache.set(key, look);
    return look;
  };

  return {
    size,
    family,
    mono,
    text,
    muted,
    link,
    accent,
    accentText,
    border,
    background,
    surface,
    selection,
    selectionBlurred: tint(text, 0.14),
    caret,
    codeBg,
    headerBg: tint(text, 0.05),
    highlight,
    radius,
    blockGap: Math.round(size * 0.7),
    headingScales: HEADING_SCALES,
    code,
    key: [
      text,
      muted,
      link,
      accent,
      border,
      background,
      size,
      family,
      mono,
      selection,
      caret,
      highlightCode,
    ].join('|'),
    inline,
  };
}
