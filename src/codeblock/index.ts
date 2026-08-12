// The look of a block of code, as a shared module.
//
// `<Code>` and `<Markdown>`'s fenced blocks are the same widget seen twice:
// mono runs tokenized through `../code-language/`, laid out unwrapped in a
// `<richtext>`, on a faint tint of the ink colour with a small radius. They
// were written twice and had already drifted (one padded from the document's
// base size, the other from the mono size — the same number at 14px and not
// at 20), which is what a look shared by two components does when it lives
// in both of them.
//
// So: the palette derivation, the runs and the chrome are here, and the two
// components keep only what is actually theirs — a gutter and a horizontal
// viewport for `<Code>`, the surrounding document for `<Markdown>`.
//
// A shared module, not a component: no element registration, no React, and
// nothing imported from either of its consumers (a component never imports
// another component).
import { codeRuns, autoTokenStyles } from '../code-language/index.js';
import type { Language, TokenStyles } from '../code-language/index.js';
import { tint } from '../richtext/index.js';
import type { TextRun } from '../richtext/index.js';
import type { Style } from 'react-x11/style';

/** Code is set tighter than prose: the lines are short and the shapes are
 *  what is being read. One value, so a fenced block and a `<Code>` in the
 *  same window sit on the same rhythm. */
export const CODE_LINE_HEIGHT = 1.25;

/** Everything both components derive from the theme before drawing. */
export interface CodeBlockLook {
  /** The mono size, in pixels. */
  size: number;
  family: string;
  /** The ink: unstyled tokens, and the gaps between styled ones. */
  color: string;
  /** Secondary ink — the line-number gutter. */
  dim: string;
  /** The block's own fill. */
  fill: string;
  padding: number;
  radius: number;
  lineHeight: number;
  /** Token palette, picked against the theme background unless overridden. */
  styles: TokenStyles;
  /** Resolves `'$token'` colours a custom palette may use. */
  resolveToken: (name: string) => string | undefined;
}

export interface CodeBlockLookOptions {
  /** The mono size outright — `<Code>`'s `fontSize`. */
  fontSize?: number;
  /** The document's base text size, when there is one: the mono size is
   *  0.9 of it. Ignored when `fontSize` is given. */
  baseSize?: number;
  /** Default `'monospace'` — there is no theme token for it. */
  monoFamily?: string;
  /** Token palette override. */
  tokenStyles?: TokenStyles;
}

/** Resolve a `'$token'` colour against a theme. Both components need the
 *  same four lines, and a custom token palette is the only thing that asks
 *  for it. */
export function themeTokenResolver(
  theme: Record<string, unknown>,
): (name: string) => string | undefined {
  return (name) => {
    const value = theme[name];
    return typeof value === 'string' ? value : undefined;
  };
}

/**
 * What a block of code looks like against this theme.
 *
 * The fill is a tint of the *ink* rather than a colour of its own, so it
 * works out to a slightly-darker patch on a light palette and a
 * slightly-lighter one on a dark palette without either being named.
 */
export function codeBlockLook(
  theme: Record<string, unknown>,
  options: CodeBlockLookOptions = {},
): CodeBlockLook {
  const color = String(theme.text ?? '#2d3436');
  const background = String(theme.background ?? 'white');
  const base = options.baseSize ?? Number(theme.fontSize ?? 14);
  const size = options.fontSize ?? Math.round(base * 0.9);
  return {
    size,
    family: options.monoFamily ?? 'monospace',
    color,
    dim: String(theme.dim ?? '#7f8c8d'),
    fill: tint(color, 0.06),
    padding: Math.round(size * 0.65),
    radius: 6,
    lineHeight: CODE_LINE_HEIGHT,
    // the same palettes the editor uses, picked by background luminance — a
    // fenced block, a `<Code>` and a `<CodeEditor>` in one window agree
    styles: options.tokenStyles ?? autoTokenStyles(background),
    resolveToken: themeTokenResolver(theme),
  };
}

export interface CodeBlockRunOptions {
  /** A fence-style tag — `'js'`, `'tsx'`, `'bash'`… */
  lang?: string;
  /** An explicit `Language`; takes precedence over `lang`. */
  language?: Language;
  /** False leaves the code unhighlighted, tag or no tag. */
  highlight?: boolean;
}

/** The source as `<richtext>` runs: tokenized, then given the mono font.
 *  The runs concatenate back to exactly `source`. */
export function codeBlockRuns(
  source: string,
  look: CodeBlockLook,
  options: CodeBlockRunOptions = {},
): TextRun[] {
  const { lang = '', language, highlight = true } = options;
  return codeRuns(source, highlight ? lang : '', {
    styles: look.styles,
    color: look.color,
    ...(highlight && language ? { language } : null),
    resolveToken: look.resolveToken,
  }).map((run) => ({ ...run, family: look.family, size: look.size }));
}

/** The block's own box: fill, radius, padding. What surrounds it — a row
 *  with a gutter, a column in a document — is the component's. */
export function codeBlockStyle(look: CodeBlockLook): Style {
  return {
    backgroundColor: look.fill,
    borderRadius: look.radius,
    padding: look.padding,
  };
}

/** The style the runs are laid out with, in both components. */
export function codeTextStyle(look: CodeBlockLook): Style {
  return { lineHeight: look.lineHeight };
}
