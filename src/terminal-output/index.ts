// <TerminalOutput> — a captured terminal session, rendered.
//
// The static, read-only sibling of `<Terminal>`, exactly as `<Code>` is the
// static sibling of `<CodeEditor>`: bytes a program wrote to a pty go in, and
// what the terminal would have drawn comes out. No pty, no process, no input,
// no `write()` — there is nothing on the other end to write to.
//
// The composition is `<Code>`'s: one `<richtext>` for the whole capture in a
// horizontally scrolling viewport, plus an optional line-number gutter, all
// inside a `selectable` root. Selection, copy, Ctrl+A and PRIMARY are core's
// since react-x11#291; what is left here is saying which parts are chrome, so
// the gutter is `selectable={false}` and a copied log carries no numbering.
//
// Registers no element of its own — `<richtext>` is the shared module's, and
// this calls `registerRichText()` at module scope the way every component
// that draws one does.
//
// **Why a log is a document rather than a grid** is the design decision
// behind the whole thing, and it is in `docs/prd-terminal-output.md` along
// with what this model can and cannot represent. The short version: a build
// log has lines, not rows, and no column count of its own, so rendering it on
// a grid means inventing a `cols` the capture never had and then wrapping at
// it. A capture that genuinely wanted a screen says so — `needsScreen` on the
// document `onDocument` hands over — and rendering *that* is phase 2.
import React from 'react';
import type { ReactElement } from 'react';
import { useTheme } from 'react-x11';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';
import type { Style } from 'react-x11/style';

import { ansiPalette, parseAnsi } from '../ansi/index.js';
import type {
  AnsiDocument,
  AnsiInput,
  AnsiPaletteOptions,
} from '../ansi/index.js';
import {
  registerRichText,
  RICHTEXT_ELEMENT,
  useLinkClicks,
  useSelectionMenu,
} from '../richtext/index.js';
import type { RichTextProps, TextRun } from '../richtext/index.js';
import {
  codeBlockLook,
  codeBlockStyle,
  codeTextStyle,
} from '../codeblock/index.js';
import { documentRuns } from './runs.js';
import { hx } from './hx.js';

const h = React.createElement;

// The shared-module registration, at this component's own module scope — see
// the note in `../richtext/node.ts`.
registerRichText();

/** What `data` accepts on top of raw bytes: a document parsed elsewhere. */
export type TerminalOutputSource = AnsiInput | AnsiDocument;

export interface TerminalOutputProps {
  /**
   * The capture.
   *
   * **Bytes are preferred over a string.** A `.toString()` on whatever
   * boundary a reader chose cuts a multi-byte character in half, and no care
   * downstream repairs it — the same rule `PtyHost.onData` carries for the
   * live terminal. A `Uint8Array` (a node `Buffer` is one) is decoded across
   * chunk boundaries, so passing an array of them is safe.
   *
   * An **array** is also the incremental path: when it grows and its existing
   * elements keep their identity, only the new ones are parsed. A growing
   * *string* is handled too, by prefix, which is cheaper than re-parsing but
   * not free — push chunks into an array for a live tail.
   *
   * An `AnsiDocument` is taken as-is, for an app that parsed off the render
   * path or is scrubbing a recording.
   */
  data: TerminalOutputSource;
  /**
   * Which renderer. `'auto'` (the default) and `'flow'` are the same today:
   * the capture is rendered as a document of styled spans.
   *
   * `'screen'` — a real cell grid, for a capture that addressed the cursor —
   * joins this union in phase 2, at which point `'auto'` starts following the
   * bytes. Pin `'flow'` if a log should stay a document whatever it contains.
   */
  mode?: 'auto' | 'flow';
  /**
   * The palette. `<Terminal>`'s `colors` minus `cursor`, which a static
   * render has no use for — the same object works for both.
   *
   * By default the ink is the theme's text colour and the block wears the
   * same faint tint a `<Code>` block does, so a log sits in a page rather
   * than punching a dark rectangle into it. Pass `background` and
   * `foreground` to get a terminal pane instead.
   */
  colors?: AnsiPaletteOptions;
  /** Default 8, the terminal's. */
  tabWidth?: number;
  /** Keep only the last N lines. Unbounded by default: the app read the
   *  file, so the app decided how big it is. */
  maxLines?: number;
  /** Wrap long lines instead of scrolling horizontally. Default false —
   *  a terminal's lines are the length they are. */
  wrap?: boolean;
  /** A line-number gutter. Numbers are not part of the selection, so a
   *  copied log pastes clean. Ignored when `wrap` is on, for the reason
   *  `<Code>` ignores it: a wrapped line puts the numbering out of register. */
  lineNumbers?: boolean;
  /** Mouse selection, Ctrl+A / Ctrl+C, PRIMARY. Default true. */
  selectable?: boolean;
  /** Selection band fill. Default: the theme accent at 35% opacity. */
  selectionColor?: string;
  /** Default: 0.9 × the theme `fontSize`, matching `<Code>` and
   *  `<Markdown>`'s fenced blocks. */
  fontSize?: number;
  /** Default `'monospace'` — there is no theme token for it, and a capture
   *  was made in a monospace font whatever the app is set in. */
  monoFamily?: string;
  /** An OSC 8 hyperlink was clicked. Without a handler the link text is
   *  styled and inert; this component never opens anything by itself. */
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
  /**
   * The parse, whenever it changes.
   *
   * This is where a capture reports what it could not say in a document:
   * `needsScreen` is true when the bytes addressed the cursor, entered the
   * alternate screen or scrolled a region, and `dropped` names every sequence
   * that went unhonoured with a count. `title` is the OSC 0/2 title, which is
   * usually what a tab should be called.
   */
  onDocument?: (document: AnsiDocument) => void;
  /** The root `<box>`'s style — width, margins, `flexGrow`. */
  style?: Style | Style[];
  'data-testname'?: string;
}

function isDocument(source: TerminalOutputSource): source is AnsiDocument {
  return (
    typeof source === 'object' &&
    source !== null &&
    !(source instanceof Uint8Array) &&
    !Array.isArray(source) &&
    'lines' in source
  );
}

/** How far into a new value the append check will look before giving up and
 *  re-parsing. A prefix compare is a memcmp and a parse is not, but neither
 *  is free, and past this the array form is the answer. */
const MAX_PREFIX_SCAN = 8 * 1024 * 1024;

interface ParseCache {
  source: TerminalOutputSource;
  document: AnsiDocument;
}

/**
 * Parse `data`, continuing the previous parse where the new value extends it.
 *
 * The two extendable shapes are the two ways a capture grows: an array whose
 * earlier chunks kept their identity, and a string the app appended to. Both
 * resume from the held reducer state, so a partial escape sequence or a
 * half-arrived UTF-8 character at the boundary is carried rather than mangled
 * — the same rule `<Markdown>` follows for an unterminated tail.
 */
function parseIncremental(
  data: TerminalOutputSource,
  previous: ParseCache | null,
  options: { tabWidth?: number; maxLines?: number },
): AnsiDocument {
  if (isDocument(data)) return data;
  const before = previous?.source;

  if (
    Array.isArray(data) &&
    Array.isArray(before) &&
    before.length < data.length
  ) {
    let shared = true;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== data[i]) {
        shared = false;
        break;
      }
    }
    if (shared) {
      return parseAnsi(data.slice(before.length), { from: previous!.document });
    }
  }

  if (
    typeof data === 'string' &&
    typeof before === 'string' &&
    before.length > 0 &&
    before.length < data.length &&
    before.length <= MAX_PREFIX_SCAN &&
    data.startsWith(before)
  ) {
    return parseAnsi(data.slice(before.length), { from: previous!.document });
  }

  return parseAnsi(data, options);
}

/**
 * A captured terminal session.
 *
 * ```jsx
 * <TerminalOutput data={log} lineNumbers />
 * ```
 */
export function TerminalOutput(props: TerminalOutputProps): ReactElement {
  const {
    data,
    colors,
    tabWidth,
    maxLines,
    wrap = false,
    selectable = true,
    selectionColor,
    onDocument,
  } = props;
  const lineNumbers = (props.lineNumbers ?? false) && !wrap;
  // `Theme` is an interface, so it has no implicit index signature — the same
  // widening `hx.ts` documents for the `theme` prop.
  const theme = useTheme() as unknown as Record<string, unknown>;
  const menu = useSelectionMenu(selectable);
  const links = useLinkClicks(props.onLink);

  const cache = React.useRef<ParseCache | null>(null);
  const document = React.useMemo(() => {
    const parsed = parseIncremental(data, cache.current, {
      tabWidth,
      maxLines,
    });
    cache.current = { source: data, document: parsed };
    return parsed;
  }, [data, tabWidth, maxLines]);

  // Reported off the render, and only when it changed: `dropped` and
  // `needsScreen` are what an app builds a "this recording wanted a screen"
  // notice out of, and a notice that re-fires every paint is a notice
  // nobody keeps.
  const report = React.useRef(onDocument);
  report.current = onDocument;
  React.useEffect(() => {
    report.current?.(document);
  }, [document]);

  const look = React.useMemo(
    () =>
      codeBlockLook(theme, {
        fontSize: props.fontSize,
        monoFamily: props.monoFamily,
      }),
    [theme, props.fontSize, props.monoFamily],
  );

  // The colour maths (dim, inverse, conceal) resolves against the *page*
  // rather than against the block's tint: the tint is translucent, and an
  // inverted run should read as a hole in the page, which is what it is.
  const palette = React.useMemo(
    () =>
      ansiPalette({
        ...colors,
        foreground: colors?.foreground ?? look.color,
        background: colors?.background ?? String(theme.background ?? '#ffffff'),
      }),
    [colors, look.color, theme.background],
  );

  const runs: TextRun[] = React.useMemo(
    () =>
      documentRuns(document, { family: look.family, size: look.size }, palette),
    [document, look.family, look.size, palette],
  );

  const outputProps: RichTextProps = { runs, style: codeTextStyle(look) };
  if (!wrap) outputProps.wrap = false;

  const lineCount = document.lines.length;
  const gutter = lineNumbers
    ? h(RICHTEXT_ELEMENT, {
        // One richtext for all the numbers: same font, same line height, so
        // it stays in register with the output beside it. `selectable={false}`
        // is what keeps it out of a drag and out of the copied text.
        selectable: false,
        runs: Array.from({ length: lineCount }, (_, i) => ({
          text: i === lineCount - 1 ? `${i + 1}` : `${i + 1}\n`,
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
    ...(colors?.background ? { backgroundColor: colors.background } : null),
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
      // click takes a word, Ctrl+C copies, PRIMARY follows the release.
      selectable,
      selectionColor,
      'aria-label': 'Terminal output',
      ...menu,
      ...links,
      'data-testname': props['data-testname'],
    } as Record<string, unknown>,
    gutter,
    hx(
      'box',
      { style: { overflow: 'scroll', flexDirection: 'column', flexGrow: 1 } },
      h(RICHTEXT_ELEMENT, outputProps as unknown as Record<string, unknown>),
    ),
  );
}
