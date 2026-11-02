// `<Pdf>`: a PDF, drawn.
//
// The document is read by PDFium (`pdfium.ts`) on a thread of its own
// (`thread.ts`), and the one element in `node.ts` draws what comes back.
// Nothing goes through `<Html>`, and nothing is fetched: `data` is the
// application's to have read, as `onResource` leaves it for `<Html>`.
import * as React from 'react';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { registerElement, registeredElements } from 'react-x11/host';
import type {} from 'react-x11/jsx-runtime';
import type { Style } from 'react-x11/style';

import { PdfOpenError } from './engine.js';
import type { PdfEngine, PdfInfo, PdfOutlineItem } from './engine.js';
import { ELEMENT, PdfViewNode, SELF_DAMAGED_PROPS } from './node.js';
import type { PdfFit, PdfViewProps } from './node.js';
import { defaultPdfEngine } from './thread.js';

export { ELEMENT as PDF_ELEMENT, PdfViewNode } from './node.js';
export type { PdfFit, PdfViewProps, PdfViewStats } from './node.js';
export { PdfOpenError } from './engine.js';
export type {
  PageLink,
  PageText,
  PdfEngine,
  PdfDocumentId,
  PdfInfo,
  PdfOutlineItem,
  TilePixels,
  TileRequest,
} from './engine.js';
export { PdfiumEngine } from './pdfium.js';
export type { PdfiumModule } from './pdfium.js';
export { defaultPdfEngine } from './thread.js';

if (!registeredElements().includes(ELEMENT)) {
  registerElement(ELEMENT, {
    create: (props, app) => new PdfViewNode(props, app),
    semanticNames: ['document', 'engine', 'ground', 'gap', 'thumb'],
    selfDamagedProps: [...SELF_DAMAGED_PROPS],
    childrenAllowed: false,
  });
}

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      pdfview: PdfViewProps & {
        style?: Style;
        key?: string | number;
        ref?: Ref<unknown>;
      };
    }
  }
}

export type PdfStatus =
  | 'loading'
  | 'ready'
  /** The engine is not installed: an ordinary state of a healthy machine. */
  | 'unavailable'
  | 'password'
  | 'error';

export interface PdfProps {
  /** The file. Nothing here reads one, as nothing here fetches one. */
  data: Uint8Array | null;
  password?: string;
  /** A number, 1 being 96 pixels to the inch, or a fit that follows the pane.
   *  Read when a document opens. Default `'width'`. */
  defaultZoom?: number | PdfFit;
  /** An engine of your own. Default PDFium, on a thread. */
  engine?: PdfEngine;
  /** What shows while there is no document: no engine, or one that failed. */
  fallback?: (state: { status: PdfStatus; error?: Error }) => ReactNode;
  onLoad?: (document: PdfInfo) => void;
  onError?: (error: Error) => void;
  onStatus?: (status: PdfStatus) => void;
  /** The page a reader is on, 0-based. */
  onPageChange?: (page: number) => void;
  onZoomChange?: (zoom: number) => void;
  /** A link was followed. One inside the document has already scrolled;
   *  one outside it goes nowhere unless the application sends it. */
  onLink?: (link: { url?: string; page?: number }) => void;
  /** What shows between and around the pages. */
  ground?: string;
  /** What the scroll thumbs are drawn in. */
  thumb?: string;
  /** Logical pixels between pages. */
  gap?: number;
  /** What the tiles on hand may hold, in bytes. Default 256 MB. */
  cacheBytes?: number;
  style?: Style;
  ref?: Ref<PdfHandle>;
}

/** What a ref to `<Pdf>` holds. */
export interface PdfHandle {
  readonly node: PdfViewNode | null;
  readonly pageCount: number;
  readonly outline: readonly PdfOutlineItem[];
  scrollToPage(page: number): void;
  zoomTo(zoom: number): void;
  fit(fit: PdfFit): void;
  /** The selection as text, however many pages it reaches. */
  selectedText(): Promise<string>;
}

export function Pdf(props: PdfProps): React.ReactElement | null {
  const { data, password, engine: given, fallback, style, ref } = props;
  const [state, setState] = useState<{
    status: PdfStatus;
    document: PdfInfo | null;
    engine: PdfEngine | null;
    error?: Error;
  }>({ status: 'loading', document: null, engine: null });
  const node = useRef<PdfViewNode | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!data) {
      setState({ status: 'loading', document: null, engine: null });
      return;
    }
    let gone = false;
    let opened: { engine: PdfEngine; handle: number } | null = null;
    setState({ status: 'loading', document: null, engine: null });
    const settle = (status: PdfStatus, error?: Error): void => {
      if (gone) return;
      setState({
        status,
        document: null,
        engine: null,
        ...(error ? { error } : {}),
      });
      latest.current.onStatus?.(status);
      if (error) latest.current.onError?.(error);
    };
    void (async () => {
      const engine = given ?? (await defaultPdfEngine());
      if (gone) return;
      if (!engine) {
        settle('unavailable');
        return;
      }
      try {
        const document = await engine.open(
          data,
          password === undefined ? undefined : { password },
        );
        if (gone) {
          engine.close(document.handle);
          return;
        }
        opened = { engine, handle: document.handle };
        setState({ status: 'ready', document, engine });
        latest.current.onStatus?.('ready');
        latest.current.onLoad?.(document);
      } catch (error) {
        const failed = error as Error;
        settle(
          failed instanceof PdfOpenError && failed.code === 'password'
            ? 'password'
            : 'error',
          failed,
        );
      }
    })();
    return () => {
      gone = true;
      if (opened) opened.engine.close(opened.handle);
    };
  }, [data, password, given]);

  useImperativeHandle(
    ref,
    () => ({
      get node() {
        return node.current;
      },
      get pageCount() {
        return state.document?.pages.length ?? 0;
      },
      get outline() {
        return state.document?.outline ?? [];
      },
      scrollToPage: (page) => node.current?.scrollToPage(page),
      zoomTo: (zoom) => node.current?.zoomTo(zoom),
      fit: (fit) => node.current?.fit(fit),
      selectedText: () => node.current?.readSelection() ?? Promise.resolve(''),
    }),
    [state.document],
  );

  if (!state.document) {
    if (state.status === 'loading') return null;
    return (fallback?.({
      status: state.status,
      ...(state.error ? { error: state.error } : {}),
    }) ?? null) as React.ReactElement | null;
  }
  const { defaultZoom, ground, thumb, gap, cacheBytes } = props;
  const { onPageChange, onZoomChange, onLink } = props;
  return React.createElement(ELEMENT, {
    ref: node,
    engine: state.engine,
    document: state.document,
    defaultZoom,
    ground,
    thumb,
    gap,
    cacheBytes,
    onPageChange,
    onZoomChange,
    onLink,
    style: { flexGrow: 1, ...style },
  } as never);
}
