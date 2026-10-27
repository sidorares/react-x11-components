// A page's frames, drawn: the document the page's scripts loaded for each,
// drawn by an `<Html>` of its own over the frame's box (`renderEmbedded`)
// and run in a realm of its own, linked to the page's (`FrameLink`) — its
// `parent` the page's window, its window the page's `contentWindow`, and
// messages both ways. The react-x11 playground is a page and a frame that
// talk this way.
//
// The realm is the frame's and not the view's (`FrameSeat`): a frame the
// page lays out no box for — `display: none`, or set aside — still runs its
// document, in a holder that draws nothing (`FrameHolder`), and a view that
// goes and comes back finds it running, as a browser's frame does. Only a
// document loaded as HTML has a realm (`DomShared.realms`): a frame's first
// `about:blank`, and what a script writes into it, are the page realm's,
// which reaches into them as it makes them, and are drawn and no more.
//
// Part of the engine's chunk (`./runtime.ts`): nothing here is reached
// before a page's scripts run.
import React, { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ScrollableNode } from 'react-x11';

import { Html, useHtmlHandle } from '../index.js';
import type { Document, Element, EmbeddedRect, HtmlProps } from '../index.js';
import { hx } from '../hx.js';
import { useScripts } from './hook.js';
import type { FramePost } from './host.js';
import type { ScriptRunner, ScriptsOptions } from './runner.js';
import { linkTarget, navigableFor } from './target.js';

const h = React.createElement;

/** What a frame takes of the page's `<Html>`: how its documents look and
 *  move, and where their resources come from. */
export type FrameLook = Pick<
  HtmlProps,
  | 'onResource'
  | 'fontSize'
  | 'fontFamily'
  | 'monoFamily'
  | 'defaultColorScheme'
  | 'animate'
  | 'reducedMotion'
  | 'selectionColor'
>;

/** What the page a frame is in gives it. */
export interface FrameContext {
  /** The runner of the document the frame is in. */
  parent: ScriptRunner;
  /** The page's script seams, which a frame's are made from. */
  seams: ScriptsOptions;
  /** The page's look, and its `onResource`, which a frame's document is
   *  drawn with. */
  look: FrameLook;
}

/** What a page mounts over its embedded elements: a frame's document over
 *  an `<iframe>`, where its scripts run; nothing over an `<embed>`, nor
 *  over a `<canvas>`, whose pixels `<Html>` draws in the document
 *  (`canvasImage`). The context is asked as each is mounted, since `<Html>`
 *  asks again as they move, with the props of the page's last render. */
export function embeddedMounts(
  context: () => FrameContext | null,
): (rect: EmbeddedRect) => ReactElement | null {
  return (rect) => {
    const known = rect.kind === 'iframe' ? context() : null;
    if (!known) return null;
    return h(FramePage, { frame: rect.element, context: known });
  };
}

/** The frames the page lays out no box for, each run in a view that draws
 *  nothing, so its scripts run and its `load` comes. */
export function FrameHolder({
  context,
}: {
  context: FrameContext;
}): ReactElement {
  const { parent } = context;
  const undrawn = () =>
    parent.host
      .frames()
      .filter((f) => f.realm && !parent.frameDrawn(f.document));
  const [frames, setFrames] = useState(undrawn);
  useEffect(() => {
    const update = () => setFrames(undrawn());
    update();
    const unFrames = parent.host.onFrames(update);
    const unViews = parent.onFrameViews(update);
    return () => {
      unFrames();
      unViews();
    };
    // the holder is its parent's for its life
  }, [parent]);
  return hx(
    'box',
    {
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      },
    },
    ...frames.map((f) =>
      h(FrameDocument, {
        key: keyOf(f.document),
        frame: f.frame,
        document: f.document,
        url: f.url,
        realm: true,
        context,
        undrawn: true,
      }),
    ),
  );
}

/** The values of an `<iframe>`'s `scrolling` that hide its scroll bars. */
const SCROLLS_NOT = /^(?:off|noscroll|no)$/i;

/** A number for each document, the same while it lives: a frame that goes
 *  on to another document is mounted again. */
const DOCUMENTS = new WeakMap<Document, number>();
let documents = 0;

function keyOf(document: Document): number {
  let key = DOCUMENTS.get(document);
  if (key === undefined) DOCUMENTS.set(document, (key = ++documents));
  return key;
}

/** The frame's document as the page's host has it now, following it as it
 *  goes on to another. */
function FramePage({
  frame,
  context,
}: {
  frame: Element;
  context: FrameContext;
}): ReactElement | null {
  const host = context.parent.host;
  const find = () => host.frames().find((f) => f.frame === frame) ?? null;
  const [shown, setShown] = useState(find);
  useEffect(() => {
    const update = () => setShown(find());
    update();
    return host.onFrames(update);
    // the frame and its host are the view's for its life
  }, [host, frame]);
  if (!shown) return null;
  return h(FrameDocument, {
    key: keyOf(shown.document),
    frame,
    document: shown.document,
    url: shown.url,
    realm: shown.realm,
    context,
  });
}

function FrameDocument({
  frame,
  document,
  url,
  realm,
  context,
  undrawn = false,
}: {
  frame: Element;
  document: Document;
  url: string;
  realm: boolean;
  context: FrameContext;
  undrawn?: boolean;
}): ReactElement {
  const handle = useHtmlHandle();
  const scroller = useRef<ScrollableNode | null>(null);
  const host = context.parent.host;
  const outer = context.seams;
  const seams: ScriptsOptions = {
    ...outer,
    // the frame's own pane: its size and its scroll, in the page's zoom —
    // its offsets device pixels, `dpr` of them a CSS pixel, as the page's
    // are (`viewportOf`)
    viewport: () => {
      const pane = scroller.current;
      const box = pane?.getClientRects()[0];
      const { zoom, dpr } = outer.viewport();
      return {
        width: (box?.width ?? 0) / zoom,
        height: (box?.height ?? 0) / zoom,
        scrollX: (pane?.scrollX ?? 0) / dpr,
        scrollY: (pane?.scrollY ?? 0) / dpr,
        zoom,
        dpr,
        left: box?.x ?? 0,
        top: box?.y ?? 0,
      };
    },
    scrollTo: (x, y) => {
      const { zoom } = outer.viewport();
      scroller.current?.scrollTo({ x: x * zoom, y: y * zoom });
    },
    // a frame's `location` goes on in the frame, and its `open` in a tab
    navigate: (to, how) =>
      how === 'tab'
        ? outer.navigate(to, 'tab')
        : host.navigateFrame(frame, to, null),
    reload: () => host.navigateFrame(frame, url, null),
    // the page's session is the page's: a frame's history is its own
    session: null,
    title: () => {},
    log: (level, text) => outer.log(level, `[frame ${url}] ${text}`),
    drawsFrames: true,
    undrawn,
  };
  const scripts = useScripts(realm, handle, url, seams, {
    parent: context.parent,
    frame,
  });
  // a document of the page realm's is drawn here, and told here of what
  // the page's scripts change in it
  useEffect(() => {
    if (realm) return undefined;
    const { drawn } = host.shared;
    drawn.set(document, handle);
    return () => {
      if (drawn.get(document) === handle) drawn.delete(document);
    };
  }, [realm, host, document, handle]);
  // a frame in this frame is a frame of this frame's realm
  const inner = (): FrameContext | null => {
    const runner = scripts.runner?.();
    return runner ? { ...context, parent: runner, seams } : null;
  };
  const holder = inner();
  // Where a link or a form in the frame sends what it asks for: the frame,
  // a frame its target names in the frame's document, a new tab, or the
  // page — `_top`, and `_parent`, which in a frame in a frame is the frame
  // around it and is taken for the page here.
  const send = (target: string, to: string, post: FramePost | null) => {
    const keyword = target.toLowerCase();
    if (keyword === '_top' || keyword === '_parent') {
      outer.navigate(to, 'here');
      return;
    }
    const where = navigableFor(document, target);
    if (where === 'tab') outer.navigate(to, 'tab');
    else if (where === 'here') host.navigateFrame(frame, to, post);
    else scripts.navigateFrame?.(where, to, post);
  };
  const { look } = context;
  return hx(
    'box',
    {
      ref: scroller,
      style: { flexGrow: 1, overflow: 'scroll' },
      // `scrolling="no"` shows no scroll bars, whatever the document's
      // `overflow` (HTML 15.4.4, the iframe element's rendering)
      ...(SCROLLS_NOT.test(frame.attribs.scrolling ?? '') && {
        scrollbar: false,
      }),
      onScroll: () => scripts.scrolled?.(),
    },
    h(Html, {
      source: '',
      document,
      partial: false,
      baseUrl: url,
      ref: handle.ref,
      ...look,
      onLink: (href, ev) => {
        let link = handle.elementAt(ev.x, ev.y);
        while (link && link.name !== 'a' && link.name !== 'area') {
          link = link.parent?.type === 'tag' ? (link.parent as Element) : null;
        }
        send(linkTarget(link, document), href, null);
      },
      onSubmit: (submission) => {
        const { url: to, method, body, contentType, target } = submission;
        if (!/^(?:https?|file|data):/i.test(to)) return;
        send(
          target,
          to,
          method === 'post'
            ? { body: body ?? '', contentType: contentType ?? '' }
            : null,
        );
      },
      scripting: scripts.scripting,
      onScript: scripts.onScript,
      onParsed: scripts.onParsed,
      onLoaded: scripts.onLoaded,
      onDomEvent: scripts.onDomEvent,
      onDocument: scripts.onDocument,
      onElementScroll: scripts.onElementScroll,
      stylesheet: scripts.stylesheet,
      renderEmbedded: embeddedMounts(inner),
      canvasImage: scripts.canvasImage,
      style: { flexGrow: 1 },
      // the frame's own viewport moved — its box laid out again by the
      // page — which its realm hears as its window's `resize` and its media
      // query lists' `change`; and its own CSS transitions' events, which
      // its realm hears and the page's does not (`InternalHtmlProps`)
      ...({
        _onPaint: scripts.painted,
        _onCssEvents: scripts.cssEvents,
        _onMediaEvent: scripts.mediaEvent,
      } as object),
    }),
    holder ? h(FrameHolder, { context: holder }) : null,
  );
}
