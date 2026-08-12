// The vt backend: a pty, `@xterm/headless` as the escape-sequence state
// machine, and `<vtterm>` as the renderer.
//
// **This module is the one with the side effect** — `registerElement` at
// module scope — and it is reached only through the dynamic `import()` in
// `../index.ts`, taken when `backend="vt"` is actually selected. An app that
// renders `<Terminal backend="xterm">`, or that imports the barrel and never
// mounts a terminal, loads neither this module nor `@xterm/headless`; the
// tree-shaking guard asserts exactly that.
//
// What lives here versus in `./node.ts`: this file owns the *process* — the
// optional dependencies, the emulator, the pty, flow control, restart and
// exit, the imperative surface — and the node owns pixels and input. That is
// the same split `<CodeEditor>` has, and it is what lets the whole renderer be
// driven by a fake pty in CI.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, Ref } from 'react';
import { registerElement, registeredElements } from 'react-x11/host';
import type { WheelEvent } from 'react-x11';
import type { Style } from 'react-x11/style';

// Loads the module the JSX augmentation at the bottom targets — nothing in
// `src/` writes JSX, so the build has no other reason to resolve it.
import type {} from 'react-x11/jsx-runtime';

import type { EmbedStatus, ExitInfo } from '../../embed/index.js';
import type { TerminalColors } from '../backends.js';
import { ELEMENT, VtTermNode } from './node.js';
import type { VtTermProps } from './node.js';
import { defaultShell, nodePtyHost } from './pty.js';
import type { PtyHost, PtySession } from './pty.js';
import { startTimeout, stopTimeout } from '../../embed/timers.js';
import type { TimerId } from '../../embed/timers.js';
import { loadXterm } from './xterm.js';
import type { XtermTerminal } from './xterm.js';

export { ELEMENT as VT_TERMINAL_ELEMENT, VtTermNode };
export type { VtTermProps };
export { nodePtyHost, defaultShell } from './pty.js';
export type { PtyHost, PtyOptions, PtySession } from './pty.js';

if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new VtTermNode(props, app),
    // `colors` is the terminal's own vocabulary and not a style name today,
    // but it is close enough to one that an audit flagged it: declared, so a
    // future style property of that name fails loudly here rather than
    // silently in somebody's app.
    semanticNames: ['colors', 'cursorStyle'],
    childrenAllowed: false,
  });
}

/** Bytes buffered in the emulator before the pty is told to stop. */
const HIGH_WATER = 512 * 1024;
const LOW_WATER = 128 * 1024;
/** How long the screen stays inverted for a visual bell. */
const BELL_FLASH_MS = 80;

/** What the vt backend's own handle can do. `<Terminal>` widens it. */
export interface VtHandle {
  /** Towards the program. The reserved method, real at last. */
  write(data: string): boolean;
  restart(): void;
  signal(signal?: string): boolean;
  resizeToFit(): void;
  selection(): string | null;
  clearSelection(): void;
  scrollToBottom(): void;
  scrollLines(n: number): void;
  serialize(): string | null;
  readonly pid: number | null;
  readonly status: EmbedStatus;
  readonly cols: number | null;
  readonly rows: number | null;
}

export interface VtTerminalProps {
  command?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  colors?: TerminalColors;
  fontFamily?: string;
  fontSize?: number;
  scrollback?: number;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  bell?: 'none' | 'visual';
  onBell?: () => void;
  allowClipboardWrite?: boolean;
  onSelectionChange?: (text: string) => void;
  /** Where the pty comes from. The `processes` prop's counterpart. */
  pty?: PtyHost;
  enabled?: boolean;
  stopSignal?: string;
  focusable?: boolean;
  onExit?: (info: ExitInfo) => void;
  onTitleChange?: (title: string) => void;
  onError?: (err: Error) => void;
  /** Reported as it changes, so `<Terminal>` can render its `fallback`. */
  onStatus?: (status: EmbedStatus) => void;
  style?: Style | Style[];
  ref?: Ref<VtHandle | null>;
  'data-testname'?: string;
}

/**
 * A terminal drawn by this process.
 *
 * Not exported from the package root: `<Terminal backend="vt">` is the API,
 * and this is what it renders once the dynamic import lands.
 */
export function VtTerminal(props: VtTerminalProps): ReactElement {
  const {
    enabled = true,
    stopSignal = 'SIGTERM',
    scrollback = 1000,
    bell = 'none',
  } = props;

  const [term, setTerm] = useState<XtermTerminal | null>(null);
  const [status, setStatus] = useState<EmbedStatus>('idle');
  const [inverted, setInverted] = useState(false);
  const [generation, setGeneration] = useState(0);

  const nodeRef = useRef<VtTermNode | null>(null);
  const sessionRef = useRef<PtySession | null>(null);
  const termRef = useRef<XtermTerminal | null>(null);
  // The grid the node last measured. Read when the emulator is created —
  // layout usually beats the dynamic imports, and when it does not, 80×24 is
  // corrected by the first `onGridResize` a frame later.
  const gridRef = useRef({ cols: 80, rows: 24 });
  const flashRef = useRef<TimerId>(null);

  // Handlers are read when they fire, so an inline arrow function in the
  // parent does not restart the shell.
  const handlers = useRef(props);
  handlers.current = props;

  const report = useCallback((next: EmbedStatus) => {
    setStatus(next);
    handlers.current.onStatus?.(next);
  }, []);

  // Everything that decides *which* program runs, as one string: the restart
  // key, for the reason `../index.ts` documents — `command={['bash']}` is a
  // new array on every paint and an effect keyed on it never settles.
  const launchKey = useMemo(
    () =>
      JSON.stringify([
        props.command ?? null,
        props.cwd ?? null,
        props.env ?? null,
        scrollback,
      ]),
    [props.command, props.cwd, props.env, scrollback],
  );

  useEffect(() => {
    if (!enabled) {
      report('idle');
      return undefined;
    }
    let live = true;
    let session: PtySession | null = null;
    let emulator: XtermTerminal | null = null;

    const fail = (err: unknown, next: EmbedStatus): void => {
      if (!live) return;
      const wrapped = err instanceof Error ? err : new Error(String(err));
      report(next);
      handlers.current.onError?.(wrapped);
    };

    void (async () => {
      report('starting');
      const mod = await loadXterm();
      if (!live) return;
      if (!mod) {
        // An ordinary state of a healthy machine — `npm install --no-optional`
        // — so it is a status and a fallback, never a throw (AGENTS.md).
        report('unavailable');
        return;
      }
      const host = handlers.current.pty ?? nodePtyHost();
      if (!(await host.available())) {
        if (live) report('unavailable');
        return;
      }
      if (!live) return;

      const { cols, rows } = gridRef.current;
      emulator = new mod.Terminal({
        cols,
        rows,
        scrollback,
        // The buffer, the parser and the mode flags are all behind this
        // flag in 6.0 — `term.buffer` throws without it. Everything this
        // component reads is *published* API (it is in the typings and in
        // the docs); "proposed" is xterm.js's word for "may change in a
        // major", which is why the slice we use is written out
        // structurally in `./xterm.ts` and pinned in CI.
        allowProposedApi: true,
        cursorStyle: handlers.current.cursorStyle,
        cursorBlink: handlers.current.cursorBlink,
      });

      // The reply channel: DA, DSR, mouse reports the core encodes itself. A
      // terminal that does not pipe this back is a terminal that hangs the
      // first program to ask it a question.
      emulator.onData((data) => sessionRef.current?.write(data));
      emulator.onBinary((data) => sessionRef.current?.write(data));
      emulator.onTitleChange((title) =>
        handlers.current.onTitleChange?.(title),
      );
      emulator.onBell(() => {
        handlers.current.onBell?.();
        if (handlers.current.bell !== 'visual') return;
        setInverted(true);
        stopTimeout(flashRef.current);
        flashRef.current = startTimeout(
          () => setInverted(false),
          BELL_FLASH_MS,
        );
      });

      const ambient = host.environment?.() ?? {};
      try {
        session = await host.openPty(
          handlers.current.command && handlers.current.command.length
            ? handlers.current.command
            : [defaultShell(ambient)],
          {
            cols,
            rows,
            cwd: handlers.current.cwd,
            env: {
              // The honest advertisement: the core is xterm-compatible and
              // this renderer does 24-bit colour.
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
              ...handlers.current.env,
            },
          },
        );
      } catch (err) {
        emulator.dispose();
        emulator = null;
        fail(err, 'unavailable');
        return;
      }
      if (!live) {
        session.kill(stopSignal);
        emulator.dispose();
        return;
      }

      // Flow control. `yes` fills a pipe faster than anything can parse it,
      // and the watermarks are what keep the queue — and the memory behind
      // it — bounded rather than the UI starved.
      let buffered = 0;
      let paused = false;
      session.onData((chunk) => {
        const current = emulator;
        if (!current) return;
        buffered += chunk.length;
        if (!paused && buffered > HIGH_WATER && session?.pause) {
          paused = true;
          session.pause();
        }
        current.write(chunk, () => {
          buffered -= chunk.length;
          if (paused && buffered < LOW_WATER && session?.resume) {
            paused = false;
            session.resume();
          }
        });
      });
      session.onExit((info) => {
        if (!live) return;
        sessionRef.current = null;
        report('exited');
        handlers.current.onExit?.(info);
      });

      sessionRef.current = session;
      termRef.current = emulator;
      setTerm(emulator);
      report('running');
    })();

    return () => {
      live = false;
      stopTimeout(flashRef.current);
      sessionRef.current = null;
      termRef.current = null;
      setTerm(null);
      session?.kill(stopSignal);
      // Order: the pty first, then the emulator — disposing the parser while
      // a chunk is still on its way in is how a write lands on a dead core.
      emulator?.dispose();
    };
  }, [enabled, launchKey, generation, stopSignal, scrollback, report]);

  const fontStyle = useMemo<Style[]>(() => {
    const font: Style = {};
    if (props.fontFamily !== undefined) font.fontFamily = props.fontFamily;
    if (props.fontSize !== undefined) font.fontSize = props.fontSize;
    const extra = props.style
      ? Array.isArray(props.style)
        ? props.style
        : [props.style]
      : [];
    return [font, ...extra];
  }, [props.fontFamily, props.fontSize, props.style]);

  const setNode = useCallback((node: unknown) => {
    nodeRef.current = (node as VtTermNode | null) ?? null;
  }, []);

  const onInput = useCallback((data: string) => {
    sessionRef.current?.write(data);
  }, []);

  const onGridResize = useCallback((cols: number, rows: number) => {
    gridRef.current = { cols, rows };
    const emulator = termRef.current;
    if (emulator && (emulator.cols !== cols || emulator.rows !== rows)) {
      // xterm reflows its own wrapped lines; the pty gets the SIGWINCH.
      emulator.resize(cols, rows);
    }
    sessionRef.current?.resize(cols, rows);
  }, []);

  React.useImperativeHandle(
    props.ref,
    (): VtHandle => ({
      write(data: string) {
        const session = sessionRef.current;
        if (!session || !data) return false;
        session.write(data);
        return true;
      },
      restart: () => setGeneration((n) => n + 1),
      signal: (signal = 'SIGTERM') => sessionRef.current?.kill(signal) ?? false,
      resizeToFit: () => nodeRef.current?.resizeToFit(),
      selection: () => nodeRef.current?.selectionText() ?? null,
      clearSelection: () => nodeRef.current?.clearSelection(),
      scrollToBottom: () => nodeRef.current?.scrollToBottom(),
      scrollLines: (n: number) => nodeRef.current?.scrollLines(n),
      serialize: () => nodeRef.current?.serialize() ?? null,
      get pid() {
        return sessionRef.current?.pid ?? null;
      },
      get status() {
        return status;
      },
      get cols() {
        return termRef.current?.cols ?? null;
      },
      get rows() {
        return termRef.current?.rows ?? null;
      },
    }),
    [status],
  );

  return React.createElement(ELEMENT, {
    term,
    onInput,
    onGridResize,
    onSelectionChange: props.onSelectionChange,
    colors: props.colors,
    cursorStyle: props.cursorStyle,
    cursorBlink: props.cursorBlink,
    allowClipboardWrite: props.allowClipboardWrite,
    inverted: bell === 'visual' && inverted,
    focusable: props.focusable ?? true,
    'aria-label': 'Terminal',
    ref: setNode,
    // Wheel has no default-action seam, so it is wired here — the shape
    // `<CodeEditor>` uses for the same gap.
    onWheel: (ev: WheelEvent) => {
      if (nodeRef.current?.handleWheel(ev)) ev.preventDefault();
    },
    // The font goes in through the style, because that is what it is: the
    // element reads `fontFamily`/`fontSize` off the cascade like every other
    // element that draws text, and core throws on either as a flat prop.
    style: fontStyle,
    'data-testname': props['data-testname'],
  });
}

// `<vtterm>` as a typed tag, for an app that would rather drive the element
// itself — the module-augmentation shape react-x11's docs/typescript.md
// prescribes for a third-party element.
declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      vtterm: VtTermProps & {
        focusable?: boolean;
        'aria-label'?: string;
        onWheel?: (ev: WheelEvent) => void;
        'data-testname'?: string;
        ref?: Ref<VtTermNode | null>;
      };
    }
  }
}
