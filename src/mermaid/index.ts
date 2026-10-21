// <Mermaid> — Mermaid diagrams, compiled by ondine and drawn natively.
//
// **Why it is here now, when mermaid was dropped.** mermaid itself was 155
// MB of install closure for a grammar, and a DOM to lay out in. ondine
// (https://ondine.sh) is a separate compiler written in Rust that follows
// Mermaid's syntax, shipped as WebAssembly: some 13 ms to compile the
// module once, tens of microseconds a diagram after that, no DOM. It is
// an optional peer (`./ondine.ts` has the weights), so an app that draws no
// diagram installs none of it.
//
// **Why it draws rather than handing the SVG to core's `<svg>`.** ondine
// answers with an SVG document whose every colour is a CSS custom property,
// which ntk's `SvgView` does not read; and one opaque picture is what
// `<Formula>` retired ntk's `<tex>` for, since nothing in it selects.
// `scene.ts` reads the document into outlines and text runs, themed from
// the palette, and the `mermaid` element `node.ts` registers draws them
// and answers core's text accessors — the labels select with the
// document around them.
//
// **Streaming.** A fenced ```mermaid block in a streaming document arrives
// a few characters at a time. While `partial`, the last diagram that
// compiled keeps showing (each append compiles again and takes over the
// moment it can); before anything has compiled, the source shows as the
// muted code it textually is. When `partial` ends, an error is shown with
// the source under it rather than vanishing.
import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useTheme } from 'react-x11';
import type { DrawnNode, MouseEvent as X11MouseEvent } from 'react-x11';
import { registerElement, registeredElements } from 'react-x11/host';
import type {} from 'react-x11/jsx-runtime';
import type { Style } from 'react-x11/style';

import { hx } from '../internal/hx.js';
import { useLinkClicks } from '../richtext/links.js';
import { ELEMENT, MermaidNode } from './node.js';
import type { MermaidElementProps } from './node.js';
import { isRenderError, loadOndine } from './ondine.js';
import type {
  OndineEngine,
  OndineError,
  OndineRenderOptions,
  OndineResult,
} from './ondine.js';
import { parseScene } from './scene.js';
import type { MermaidScene, SceneVars } from './scene.js';

export { ELEMENT as MERMAID_ELEMENT, MermaidNode } from './node.js';
export type { MermaidElementProps } from './node.js';
export { parseScene } from './scene.js';
export type {
  MermaidScene,
  SceneItem,
  ScenePath,
  SceneText,
  SceneVars,
} from './scene.js';
export { loadOndine } from './ondine.js';
export type {
  OndineEngine,
  OndineError,
  OndineLink,
  OndineRenderOptions,
  OndineResult,
} from './ondine.js';

const h = React.createElement;

if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new MermaidNode(props, app),
    semanticNames: ['scene', 'links'],
    childrenAllowed: false,
  });
}

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      mermaid: MermaidElementProps & {
        style?: Style | Style[];
      };
    }
  }
}

// --- props -----------------------------------------------------------------

export interface MermaidProps {
  /** The diagram, in Mermaid's syntax. Append to it as chunks stream in. */
  source: string;
  /**
   * Whether more source may still arrive (default false). While true, a
   * source that does not compile shows the last diagram that did — or,
   * before anything has, the source as muted code. Set false when the
   * stream ends: from then on an error is shown.
   */
  partial?: boolean;
  /** Logical pixels per em that labels are laid out and drawn at. Default:
   *  theme `fontSize`. */
  fontSize?: number;
  /**
   * ondine's theme, as the custom properties its documentation names —
   * `--ondine-fg`, `--ondine-bg`, `--ondine-muted`, `--ondine-line`,
   * `--ondine-surface`, `--ondine-surface-alt`, `--ondine-border`,
   * `--ondine-accent`, `--ondine-stroke`, `--ondine-radius`,
   * `--ondine-font`, `--ondine-series-1`… Laid over the defaults taken
   * from the palette (`text`, `background`, `textMuted`, `monoFamily`).
   * Needs a stable identity, or every render reads the diagram again.
   */
  vars?: SceneVars;
  /** Passed to ondine's `render`. Needs a stable identity. */
  options?: Omit<OndineRenderOptions, 'fontSize'>;
  /** Follow a `click` link in the diagram. Without it, links are inert. */
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
  /** Told of each source that fails to compile once `partial` is false. */
  onError?: (error: OndineError) => void;
  /** The colour of the error line a failed diagram shows. Default
   *  `#cc0000`, as `<Formula>`'s. */
  errorColor?: string;
  /**
   * Make this diagram its own selection surface (mouse, Ctrl+A/C,
   * PRIMARY). Default false — inside a `selectable` document the
   * document's surface already reads the labels through their text
   * accessors.
   */
  selectable?: boolean;
  /** Selection band fill, when `selectable`. */
  selectionColor?: string;
  /** The root `<box>`'s style — margins, padding, `overflow`. */
  style?: Style | Style[];
  'data-testname'?: string;
}

// --- the engine, loaded once per process -----------------------------------

type EngineState = OndineEngine | 'unavailable' | null;

let resolved: EngineState = null;

/** The compiler, or `'unavailable'`, or `null` while loading. Exported for
 *  apps that want to gate their own UI on it. */
export function useOndine(): EngineState {
  const [engine, setEngine] = React.useState<EngineState>(resolved);
  React.useEffect(() => {
    if (engine && engine !== 'unavailable') return undefined;
    let live = true;
    loadOndine().then(
      (e) => {
        resolved = e;
        if (live) setEngine(e);
      },
      () => {
        // "ondine is not installed" is an ordinary state, and not
        // remembered: an app that installs it and re-mounts gets a try
        if (live) setEngine('unavailable');
      },
    );
    return () => {
      live = false;
    };
  }, [engine]);
  return engine;
}

type Compiled =
  { ok: true; result: OndineResult } | { ok: false; error: OndineError };

function compile(
  engine: OndineEngine,
  source: string,
  options: OndineRenderOptions,
): Compiled {
  try {
    return { ok: true, result: engine.render(source, options) };
  } catch (err) {
    if (isRenderError(err)) return { ok: false, error: err };
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { message } };
  }
}

/** The palette's say in ondine's theme. */
function themeVars(theme: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: string, value: unknown): void => {
    if (typeof value === 'string' && value) out[name] = value;
  };
  set('--ondine-fg', theme.text);
  set('--ondine-bg', theme.background);
  set('--ondine-muted', theme.textMuted);
  set('--ondine-font', theme.monoFamily ?? 'monospace');
  return out;
}

// --- the component ---------------------------------------------------------

/**
 * A Mermaid diagram. ondine (an optional peer) compiles the source; the
 * `mermaid` element this file registers draws it, themed from the palette,
 * with labels that select. Without `ondine` installed, the source renders
 * as muted code instead — an ordinary state, not an error.
 *
 * ```jsx
 * <Mermaid source={'flowchart LR\n  A --> B'} />
 * ```
 */
export function Mermaid(props: MermaidProps): ReactElement {
  const { source, partial = false, vars, options, onError } = props;
  const theme = useTheme() as unknown as Record<string, unknown>;
  const engine = useOndine();

  const fontSize = props.fontSize ?? Number(theme.fontSize ?? 14);
  const muted = String(theme.textMuted ?? '#7f8c8d');
  const mono = String(theme.monoFamily ?? 'monospace');

  const compiled: Compiled | null = React.useMemo(() => {
    if (!engine || engine === 'unavailable') return null;
    return compile(engine, source, { ...options, fontSize });
  }, [engine, source, options, fontSize]);

  const palette = themeVars(theme);
  const paletteKey = JSON.stringify(palette);
  const svg = compiled?.ok ? compiled.result.svg : null;
  const scene: MermaidScene | null = React.useMemo(
    () => (svg ? parseScene(svg, { ...palette, ...vars }) : null),
    // keyed on `paletteKey`, the palette's value: the object is new every
    // render
    [svg, paletteKey, vars],
  );

  const lastGood = React.useRef<MermaidScene | null>(null);
  if (scene) lastGood.current = scene;
  const shown = scene ?? (partial ? lastGood.current : null);

  const error = compiled && !compiled.ok && !partial ? compiled.error : null;
  React.useEffect(() => {
    if (error && onError) onError(error);
  }, [error, onError]);

  const links = useLinkClicks(props.onLink);

  let child: ReactNode;
  if (shown) {
    child = h(ELEMENT, {
      scene: shown,
      links: props.onLink != null,
    } as unknown as Record<string, unknown>);
  } else {
    // no ondine, nothing compiled yet, or an error once final: the source,
    // as the muted code it textually is — core's <text> selects natively
    const code = hx(
      'text',
      {
        key: 'source',
        style: {
          fontFamily: mono,
          fontSize: Math.max(8, Math.round(fontSize * 0.9)),
          color: muted,
        },
      },
      source,
    );
    child = error
      ? [
          hx(
            'text',
            {
              key: 'error',
              style: {
                fontFamily: mono,
                fontSize: Math.max(8, Math.round(fontSize * 0.9)),
                color: props.errorColor ?? '#cc0000',
              },
            },
            errorLine(error),
          ),
          code,
        ]
      : code;
  }

  // A column, so the diagram is measured across its cross axis — with the
  // width on offer as a limit, which is what lets one wider than its column
  // shrink to it. On a row's main axis it would be measured unbounded.
  const rootStyle: Style = shown
    ? { flexDirection: 'column', alignItems: 'flex-start' }
    : { flexDirection: 'column', gap: 4 };

  return hx(
    'box',
    {
      style: props.style
        ? [
            rootStyle,
            ...(Array.isArray(props.style) ? props.style : [props.style]),
          ]
        : rootStyle,
      // `selectable={false}` is the *exclusion* flag, so it is only ever
      // set when true — an unset prop leaves the diagram readable by an
      // enclosing surface
      ...(props.selectable
        ? { selectable: true, selectionColor: props.selectionColor }
        : null),
      // the press lands on the `mermaid` node under it, which answers
      // `hrefAtPoint`; `useLinkClicks` asks the target for it by name
      ...(props.onLink ? links : null),
      'data-testname': props['data-testname'],
    } as Record<string, unknown>,
    child,
  );
}

/** What went wrong. ondine's message is Mermaid's own — the line, the
 *  snippet with a caret under it, what it expected — so it is shown as it
 *  is, in the code face its caret lines up in. */
function errorLine(error: OndineError): string {
  return error.message.replace(/\n{2,}/g, '\n').trimEnd();
}
