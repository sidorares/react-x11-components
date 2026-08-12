// <Code> — a static, read-only code block: syntax highlighting through the
// same language seam `<CodeEditor>` tokenizes with (`../code-language/`), a
// look shared with `<Markdown>`'s fenced blocks (`../codeblock/`), and text
// laid out in the same `<richtext>` element `<Markdown>` renders
// (`../richtext/`). For showing code, not editing it: no caret, no history,
// no completion — an app that wants those renders `<CodeEditor>` (readOnly
// or otherwise) and pays for them.
//
// The composition is one `<richtext>` for the whole text (unwrapped, in a
// horizontally scrolling viewport) plus an optional line-number gutter,
// inside a `selectable` root. Selection, copy, Ctrl+A and PRIMARY are all
// core's since react-x11#291; what is left here is saying which parts of the
// block are text a reader would want — the gutter is `selectable={false}`,
// so copied code never carries the numbering.
import React from 'react';
import type { ReactElement } from 'react';
import { useTheme } from 'react-x11';
import type { Style } from 'react-x11/style';

import {
  registerRichText,
  RICHTEXT_ELEMENT,
  useSelectionMenu,
} from '../richtext/index.js';
import type { RichTextProps, TextRun } from '../richtext/index.js';
import {
  codeBlockLook,
  codeBlockRuns,
  codeBlockStyle,
  codeTextStyle,
} from '../codeblock/index.js';
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
  // `Theme` is an interface, so it has no implicit index signature — the
  // same widening `hx.ts` documents for the `theme` prop.
  const theme = useTheme() as unknown as Record<string, unknown>;
  const menu = useSelectionMenu(selectable);

  const look = React.useMemo(
    () =>
      codeBlockLook(theme, {
        fontSize: props.fontSize,
        monoFamily: props.monoFamily,
        tokenStyles: props.tokenStyles,
      }),
    [theme, props.fontSize, props.monoFamily, props.tokenStyles],
  );

  const runs: TextRun[] = React.useMemo(
    () => codeBlockRuns(source, look, { lang, language }),
    [source, lang, language, look],
  );

  const lineCount = React.useMemo(() => source.split('\n').length, [source]);

  const codeProps: RichTextProps = { runs, style: codeTextStyle(look) };
  if (!wrap) codeProps.wrap = false;

  const gutter = lineNumbers
    ? h(RICHTEXT_ELEMENT, {
        // one richtext for all the numbers: same font, same line height, so
        // it stays in register with the code beside it. `selectable={false}`
        // is what keeps it out of a drag and out of the copied text — the
        // numbering is chrome, and CSS spells that `user-select: none`.
        selectable: false,
        runs: Array.from({ length: lineCount }, (_, i) => ({
          text: `${i + 1}\n`,
          family: look.family,
          size: look.size,
          color: look.dim,
        })),
        wrap: false,
        style: {
          lineHeight: look.lineHeight,
          textAlign: 'right',
          minWidth:
            Math.max(String(lineCount).length, 2) * Math.ceil(look.size * 0.62),
          marginRight: look.padding,
          flexShrink: 0,
        },
      } as Record<string, unknown>)
    : null;

  const rootStyle: Style = {
    ...codeBlockStyle(look),
    flexDirection: 'row',
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
      // The whole feature: a drag selects across everything below, a double
      // click takes a word, Ctrl+C copies, PRIMARY follows the release. The
      // surface is a focus target and shows an I-beam because it said this.
      selectable,
      selectionColor,
      'aria-label': 'Code block',
      ...menu,
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
