// <Formula> — TeX mathematics, rendered natively and selectable.
//
// **Why not ntk's `layoutTex`** (being decommissioned with the rest of
// ntk's document widgets): it renders a formula as one opaque drawing —
// nothing inside it is reachable, so nothing inside it selects. This is a
// from-scratch successor on the same public seams every component here
// uses: KaTeX parses TeX into its virtual DOM, `layout.ts` lays that tree
// out in pixels, and one registered element draws the result through the
// app's font manager — with KaTeX's own faces, loaded from the `katex`
// package — while answering core's four text accessors, so the mathematics
// joins any `selectable` document the way a `<richtext>` run does.
//
// **Why the name is `Formula`, not `Math` or `Tex`.** `Math` is a JavaScript
// global: `import { Math } from …` would shadow it in every module that
// uses both, which is a trap no component name should set. `Tex` names the
// input syntax, and the input syntax is a prop (`tex`) — if a MathML or
// AsciiMath source ever arrives, it arrives as a sibling prop on the same
// element rather than as a second component.
//
// **Streaming.** A fenced ```math block in a streaming document arrives a
// few characters at a time, and half a formula does not parse. While
// `partial`, the last tree that parsed keeps rendering (the arrived tail
// re-parses on every append and takes over the moment it can); before
// anything has parsed, the raw source shows as muted code — a fence *is* a
// code block until its content can be read. When `partial` ends, parse
// errors render KaTeX's own error text instead of vanishing.
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useTheme } from 'react-x11';
import { registerElement, registeredElements } from 'react-x11/host';
import type {} from 'react-x11/jsx-runtime';
import type { Style } from 'react-x11/style';

import { loadKatex } from './katex.js';
import type { KatexEngine, KatexNode } from './katex.js';
import { ELEMENT, FormulaNode } from './node.js';
import type { FormulaElementProps } from './node.js';
import { hx } from './hx.js';

export { ELEMENT as FORMULA_ELEMENT, FormulaNode } from './node.js';
export type { FormulaElementProps } from './node.js';
export { layoutFormula } from './layout.js';
export type {
  FormulaGlyph,
  FormulaLayout,
  FormulaRule,
  FormulaShaper,
} from './layout.js';
export type { KatexEngine, KatexNode } from './katex.js';

const h = React.createElement;

if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new FormulaNode(props, app),
    // `color` is a style name and `size` reads like one — everything the
    // element owns is declared, so the DEV flat-style assertion stays honest
    semanticNames: ['tree', 'size', 'color', 'fontData'],
    childrenAllowed: false,
  });
}

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      formula: FormulaElementProps & {
        style?: Style | Style[];
      };
    }
  }
}

// --- props -----------------------------------------------------------------

export interface FormulaProps {
  /** The TeX source. Append to it as chunks stream in. */
  tex: string;
  /**
   * Display style: centered on its own line, large operators with limits
   * above and below — KaTeX's `displayMode`. Default false (inline style,
   * left-aligned).
   */
  display?: boolean;
  /**
   * Whether more source may still arrive (default false). While true, a
   * source that does not parse renders the last tree that did — or, before
   * anything has, the raw source as muted code. Set false when the stream
   * ends: from then on a parse error renders KaTeX's error text.
   */
  partial?: boolean;
  /** Logical pixels per em — the unit a `fontSize` is written in; on a
   *  retina panel the element shapes at `size` × the display scale, like
   *  any style length. Default: theme `fontSize` × 1.21, which is the
   *  ratio katex.css uses so mathematics holds its own beside body text. */
  size?: number;
  /** Ink color. Default: theme `text`. */
  color?: string;
  /** What `\color` cannot recolor: the error text a failed parse renders
   *  once the stream is final. Default KaTeX's `#cc0000`. */
  errorColor?: string;
  /** KaTeX macros, e.g. `{ '\\RR': '\\mathbb{R}' }`. */
  macros?: Record<string, string>;
  /**
   * Make this formula its own selection surface (mouse, Ctrl+A/C, PRIMARY).
   * Default false — inside a `selectable` document (a `<Markdown>` math
   * fence) the document's surface already reads the formula through its
   * text accessors, and a second surface underneath it would capture the
   * drag instead of joining it.
   */
  selectable?: boolean;
  /** Selection band fill, when `selectable`. */
  selectionColor?: string;
  /** The root `<box>`'s style — margins, padding, `overflow`. */
  style?: Style | Style[];
  'data-testname'?: string;
}

// --- the engine, loaded once per process -----------------------------------

type EngineState = KatexEngine | 'unavailable' | null;

let resolved: EngineState = null;

function requestEngine(onReady: (e: EngineState) => void): () => void {
  let live = true;
  loadKatex().then(
    (engine) => {
      resolved = engine;
      if (live) onReady(engine);
    },
    () => {
      // "katex is not installed" is an ordinary state, and deliberately not
      // remembered here — `loadKatex` does not cache rejections, so an app
      // that installs it and re-mounts gets a fresh try.
      if (live) onReady('unavailable');
    },
  );
  return () => {
    live = false;
  };
}

/** The KaTeX module and fonts, or `'unavailable'`, or `null` while
 *  loading. Exported for apps that want to gate their own UI on it. */
export function useKatex(): EngineState {
  const [engine, setEngine] = React.useState<EngineState>(resolved);
  React.useEffect(() => {
    if (engine && engine !== 'unavailable') return undefined;
    return requestEngine(setEngine);
  }, [engine]);
  return engine;
}

// --- the component ---------------------------------------------------------

/**
 * A TeX formula. KaTeX (an optional dependency) parses the source; the
 * `formula` element this file registers lays it out and draws it with the
 * KaTeX faces. Without `katex` installed, the source renders as muted code
 * instead — an ordinary state, not an error.
 *
 * ```jsx
 * <Formula tex="x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}" display selectable />
 * ```
 */
export function Formula(props: FormulaProps): ReactElement {
  const { tex, display = false, partial = false } = props;
  const theme = useTheme() as unknown as Record<string, unknown>;
  const engine = useKatex();

  const size = props.size ?? Math.round(Number(theme.fontSize ?? 14) * 1.21);
  const color = props.color ?? String(theme.text ?? '#2d3436');
  const muted = String(theme.textMuted ?? '#7f8c8d');

  const katex = engine && engine !== 'unavailable' ? engine.katex : null;
  const tree: KatexNode | null = React.useMemo(() => {
    if (!katex) return null;
    try {
      return katex.__renderToDomTree(tex, {
        displayMode: display,
        output: 'html',
        // While streaming, an error means "not finished" and the last good
        // tree stands in. Once final, KaTeX's error rendering is the
        // honest answer.
        throwOnError: partial,
        errorColor: props.errorColor ?? '#cc0000',
        macros: props.macros,
      });
    } catch {
      return null;
    }
  }, [katex, tex, display, partial, props.errorColor, props.macros]);

  const lastGood = React.useRef<KatexNode | null>(null);
  if (tree) lastGood.current = tree;
  const shown = tree ?? (partial ? lastGood.current : null);

  const rootStyle: Style = display
    ? { flexDirection: 'row', justifyContent: 'center' }
    : { flexDirection: 'row', alignSelf: 'flex-start' };

  let child: ReactNode;
  if (shown) {
    child = h(ELEMENT, {
      tree: shown,
      size,
      color,
      fontData: engine && engine !== 'unavailable' ? engine.fonts : null,
    } as unknown as Record<string, unknown>);
  } else {
    // no katex, or nothing parseable yet: the source, as the muted code
    // it textually is (core's <text> selects natively, so nothing is lost)
    child = hx(
      'text',
      {
        style: {
          fontFamily: 'monospace',
          fontSize: Math.max(8, Math.round(size * 0.85)),
          color: muted,
        },
      },
      tex,
    );
  }

  return hx(
    'box',
    {
      style: props.style
        ? [
            rootStyle,
            ...(Array.isArray(props.style) ? props.style : [props.style]),
          ]
        : rootStyle,
      // `selectable={false}` is the *exclusion* flag (what a list marker
      // uses to stay out of a copy), so it is only ever set when true —
      // an unset prop leaves the formula readable by an enclosing surface.
      ...(props.selectable
        ? { selectable: true, selectionColor: props.selectionColor }
        : null),
      'data-testname': props['data-testname'],
    } as Record<string, unknown>,
    child,
  );
}
