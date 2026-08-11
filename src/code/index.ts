// <Code> — a static, read-only code block: syntax highlighting through the
// same language seam `<CodeEditor>` tokenizes with (`../code-language/`),
// selection and copy through the same `<richtext>` element `<Markdown>`
// renders (`../richtext/`). For showing code, not editing it: no caret, no
// history, no completion — an app that wants those renders `<CodeEditor>`
// (readOnly or otherwise) and pays for them.
//
// The composition is one `<richtext>` for the whole text (unwrapped, in a
// horizontally scrolling viewport) plus an optional line-number gutter that
// is deliberately *not* registered for selection — copying code should
// never capture the numbering.
import React from 'react';
import type { ReactElement } from 'react';
import { useTheme } from 'react-x11';
import type { Style } from 'react-x11/style';

import {
  registerRichText,
  RICHTEXT_ELEMENT,
  TextSelection,
  tint,
  useSelectionGestures,
} from '../richtext/index.js';
import type { RichTextProps, TextRun } from '../richtext/index.js';
import { autoTokenStyles, codeRuns } from '../code-language/index.js';
import type { Language, TokenStyles } from '../code-language/index.js';
import { hx } from './hx.js';

const h = React.createElement;

// The shared-module registration, called at this component's module scope —
// see the note in `../richtext/node.ts`.
registerRichText();

export interface CodeProps {
  /** The code, verbatim. */
  source: string;
  /** A fence-style tag — `'js'`, `'tsx'`, `'bash'`, `'sql'`… Unknown tags
   *  fall back to ntk's highlighter when present, then to plain text. */
  lang?: string;
  /** An explicit `Language` (a Lezer or TextMate adapter, say). Takes
   *  precedence over `lang`. */
  language?: Language;
  /** A line-number gutter. Numbers are not part of the selection, so
   *  copied code pastes clean. Ignored when `wrap` is on — a wrapped
   *  source line would put the numbering out of register. */
  lineNumbers?: boolean;
  /** Wrap long lines instead of scrolling horizontally. Default false. */
  wrap?: boolean;
  /** Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true. */
  selectable?: boolean;
  /** Default: 0.9 × the theme `fontSize`, matching `<Markdown>`'s blocks. */
  fontSize?: number;
  /** Default `'monospace'` — there is no theme token for it. */
  monoFamily?: string;
  /** Token palette override; the default follows the theme background,
   *  and `'$token'` colours in it resolve against the theme. */
  tokenStyles?: TokenStyles;
  /** Selection band fill. Default: theme accent at 35% opacity. */
  selectionColor?: string;
  /** The root `<box>`'s style — width, margins, `flexGrow`. */
  style?: Style | Style[];
  'data-testname'?: string;
}

/**
 * A code block.
 *
 * ```jsx
 * <Code source={snippet} lang="ts" lineNumbers />
 * ```
 */
export function Code(props: CodeProps): ReactElement {
  const {
    source,
    lang = '',
    language,
    wrap = false,
    selectable = true,
    selectionColor,
  } = props;
  const lineNumbers = (props.lineNumbers ?? false) && !wrap;
  const theme = useTheme() as unknown as Record<string, unknown>;

  const selectionRef = React.useRef<TextSelection | null>(null);
  if (!selectionRef.current) selectionRef.current = new TextSelection();
  const gestures = useSelectionGestures(selectionRef.current, { selectable });

  const text = String(theme.text ?? '#2d3436');
  const dim = String(theme.dim ?? '#7f8c8d');
  const background = String(theme.background ?? 'white');
  const size = props.fontSize ?? Math.round(Number(theme.fontSize ?? 14) * 0.9);
  const family = props.monoFamily ?? 'monospace';
  const styles = props.tokenStyles ?? autoTokenStyles(background);

  const runs: TextRun[] = React.useMemo(
    () =>
      codeRuns(source, lang, {
        styles,
        color: text,
        language,
        resolveToken: (name) => {
          const v = theme[name];
          return typeof v === 'string' ? v : undefined;
        },
      }).map((r) => ({ ...r, family, size })),
    [source, lang, language, styles, text, family, size, theme],
  );

  const pad = Math.round(size * 0.65);
  const lineCount = React.useMemo(() => source.split('\n').length, [source]);

  const codeProps: RichTextProps = {
    runs,
    order: 0,
    registry: selectable ? selectionRef.current : undefined,
    joiner: '\n\n',
    style: { lineHeight: 1.25 },
  };
  if (!wrap) codeProps.wrap = false;
  if (selectionColor) codeProps.selectionColor = selectionColor;

  const gutter = lineNumbers
    ? h(RICHTEXT_ELEMENT, {
        // one unregistered richtext for all the numbers: same font, same
        // line height, so it stays in register with the code beside it
        runs: Array.from({ length: lineCount }, (_, i) => ({
          text: `${i + 1}\n`,
          family,
          size,
          color: dim,
        })),
        wrap: false,
        style: {
          lineHeight: 1.25,
          textAlign: 'right',
          minWidth:
            Math.max(String(lineCount).length, 2) * Math.ceil(size * 0.62),
          marginRight: pad,
          flexShrink: 0,
        },
      } as Record<string, unknown>)
    : null;

  const rootStyle: Style = {
    flexDirection: 'row',
    backgroundColor: tint(text, 0.06),
    borderRadius: 6,
    padding: pad,
    cursor: 'text',
    alignItems: 'stretch',
  };

  return hx(
    'box',
    {
      style: props.style
        ? [
            rootStyle,
            ...(Array.isArray(props.style) ? props.style : [props.style]),
          ]
        : rootStyle,
      focusable: selectable || undefined,
      'aria-label': 'Code block',
      ...gestures,
      'data-testname': props['data-testname'],
    } as Record<string, unknown>,
    gutter,
    hx(
      'box',
      { style: { overflow: 'scroll', flexDirection: 'column', flexGrow: 1 } },
      h(RICHTEXT_ELEMENT, codeProps as unknown as Record<string, unknown>),
    ),
  );
}
