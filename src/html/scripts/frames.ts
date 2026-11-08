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
// document loaded as HTML or XML has a realm (`DomShared.realms`): a frame's
// first `about:blank`, and what a script writes into it, are the page
// realm's, which reaches into them as it makes them, and are drawn and no
// more.
//
// Part of the engine's chunk (`./runtime.ts`): nothing here is reached
// before a page's scripts run.
import { documentReferrerPolicy, linkReferrerPolicy } from '../referrer.js';
import React, { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ScrollableNode } from 'react-x11';

import { Html, useHtmlHandle } from '../index.js';
import type {
  Document,
  Element,
  EmbeddedRect,
  HtmlProps,
  ResourceRequest,
  ResourceResult,
} from '../index.js';
import { hx } from '../hx.js';
import { throughWorker, useScripts } from './hook.js';
import type { FramePost } from './host.js';
import type { ScriptRunner, ScriptsOptions } from './runner.js';
import {
  SB_FORMS,
  SB_POPUPS,
  SB_PROPAGATES,
  SB_TOP_GESTURE,
} from './sandbox.js';
import { HtmlSessionHistory } from './session.js';
import { linkOpener, linkTarget, navigableFor } from './target.js';

const h = React.createElement;

/** Each frame's session history across the documents it shows, kept on
 *  the frame so every view of it — drawn or held — shares one history. */
const FRAME_SESSIONS = new WeakMap<Element, HtmlSessionHistory>();

function sessionOf(frame: Element): HtmlSessionHistory {
  let session = FRAME_SESSIONS.get(frame);
  if (!session) {
    session = new HtmlSessionHistory();
    FRAME_SESSIONS.set(frame, session);
  }
  return session;
}

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
  | 'onPickFiles'
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
 *  an `<iframe>`, an `<object>` or an `<embed>`, where its scripts run;
 *  nothing over a `<canvas>`, whose pixels `<Html>` draws in the document
 *  (`canvasImage`). The context is asked as each is mounted, since `<Html>`
 *  asks again as they move, with the props of the page's last render. */
export function embeddedMounts(
  context: () => FrameContext | null,
): (rect: EmbeddedRect) => ReactElement | null {
  return (rect) => {
    const known = rect.kind === 'canvas' ? null : context();
    if (!known) return null;
    return h(FramePage, {
      frame: rect.element,
      context: known,
      scheme: rect.colorScheme,
    });
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
  scheme,
}: {
  frame: Element;
  context: FrameContext;
  scheme: 'light' | 'dark';
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
  // a document of the page realm's the frame shows has its `load` wait for
  // this view to have all it asked for (`followFrame`)
  useEffect(() => host.followFrame(frame), [host, frame]);
  if (!shown) return null;
  return h(FrameDocument, {
    key: keyOf(shown.document),
    frame,
    document: shown.document,
    url: shown.url,
    realm: shown.realm,
    context,
    scheme,
  });
}

function FrameDocument({
  frame,
  document,
  url,
  realm,
  context,
  scheme,
  undrawn = false,
}: {
  frame: Element;
  document: Document;
  url: string;
  realm: boolean;
  context: FrameContext;
  /** The element's colour scheme, where it is drawn. */
  scheme?: 'light' | 'dark';
  undrawn?: boolean;
}): ReactElement {
  const handle = useHtmlHandle();
  const scroller = useRef<ScrollableNode | null>(null);
  const host = context.parent.host;
  const outer = context.seams;
  // the frame's own history across the documents it shows, shared by every
  // view of this frame (`bindFrame` takes each document as the next of it)
  const session = sessionOf(frame);
  /** What the document's sandbox takes from it, which only the host knows. */
  const sandbox = host.shared.sandboxes.get(document) ?? 0;
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
    navigate: (to, how, post, name, source) => {
      if (how === 'tab') {
        outer.navigate(to, 'tab', post, name, source);
        return;
      }
      // a fragment the document went to in place, which its realm tells as
      // a page's tells its address bar, is at its address already, and loads
      // nothing: sent on, the frame loaded its document again, and a script
      // that set the hash as it loaded did so for good
      if (!post && to.includes('#') && scripts.runner?.()?.host.url === to) {
        return;
      }
      host.navigateFrame(frame, to, post ?? null);
    },
    reload: () => {
      session.reload();
      host.navigateFrame(frame, session.current?.url ?? url, null);
    },
    // a step past this document's own entries loads the entry's document
    // into the frame; one among them the engine traverses itself
    go: (delta) => {
      const to = session.go(delta);
      if (to) host.navigateFrame(frame, to.url, null);
    },
    // nothing of the window it is in is a frame's
    popup: null,
    close: undefined,
    windowName: undefined,
    // what the frame asks for is the frame's, its `Origin` and `Referer`:
    // made as the page's, a CORS answer to the page's origin was held to
    // the frame's, and refused
    fetch: (request, signal) =>
      outer.fetch({ ...request, client: request.client ?? url }, signal),
    session,
    title: () => {},
    log: (level, text) => outer.log(level, `[frame ${url}] ${text}`),
    drawsFrames: true,
    // what this view mounts over its frames is `FramePage`, whatever the
    // page's host mounts over the page's
    framesFollowed: true,
    undrawn,
  };
  // whether the viewport shows scroll bars, as its document's root and the
  // `overflow` that went to the viewport say once it is laid out
  const [bars, setBars] = useState(true);
  const viewportOverflow = (overflow: { x: string; y: string }): void => {
    const root = document.children.find((n): n is Element => n.type === 'tag');
    const width = root && handle.computedStyle(root, null)?.['scrollbar-width'];
    setBars(
      width !== 'none' && !(overflow.x === 'hidden' && overflow.y === 'hidden'),
    );
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
  // a navigated `about:blank` or `srcdoc` has no realm of its own, so
  // nothing calls `arriveAt` for it: the frame's session takes it here.
  // The frame's first `about:blank` is skipped — it is not an entry the
  // Navigation API shows (HTML 7.4.1).
  const shownBare = useRef(false);
  useEffect(() => {
    if (realm || shownBare.current) return;
    if (session.entries.length === 0) return;
    shownBare.current = true;
    // its policy is the page realm's to read, which loaded it
    session.show(url, () => host.referrerPolicyOfDocument(document));
  }, [realm, session, url]);
  // a frame in this frame is a frame of this frame's realm, and in a document
  // with no realm of its own one of the page's, which loads it
  // (`DomHost._holdsFrames`)
  const inner = (): FrameContext | null => {
    const runner = scripts.runner?.();
    if (runner) return { ...context, parent: runner, seams };
    return realm ? null : { ...context, seams };
  };
  const holder = scripts.runner?.() ? inner() : null;
  // Where a link or a form in the frame sends what it asks for: the frame,
  // a frame its target names in the frame's document, a new tab, or the
  // page — `_top`, and `_parent`, which in a frame in a frame is the frame
  // around it and is taken for the page here.
  const send = (
    target: string,
    to: string,
    post: FramePost | null,
    rel: string | undefined,
    /** The link's referrer policy, or its document's. */
    referrerPolicy = '',
  ) => {
    const keyword = target.toLowerCase();
    if (keyword === '_top' || keyword === '_parent') {
      // a link followed is a gesture
      if (!(sandbox & SB_TOP_GESTURE)) outer.navigate(to, 'here');
      return;
    }
    const where = navigableFor(document, target);
    if (where === 'tab') {
      if (sandbox & SB_POPUPS) return;
      const { noopener, noreferrer } = linkOpener(target, rel);
      const runner = scripts.runner?.();
      if (runner?.followTarget(to, target, noopener, noreferrer, post)) return;
      // a tab carries no flags, and a document with none of its own to run
      // has its window opened by the page's runner
      if (sandbox & SB_PROPAGATES) {
        context.parent.openFor(url, sandbox, {
          url: to,
          name: target.toLowerCase() === '_blank' ? '' : target,
          features: { popup: false, noreferrer },
          post,
        });
      } else outer.navigate(to, 'tab');
    } else if (where === 'here') {
      host.navigateFrame(frame, to, post, referrerPolicy);
    } else if (scripts.navigateFrame) {
      scripts.navigateFrame(where, to, post, referrerPolicy);
    } else if (!realm) host.navigateFrameFrom(where, to, post, referrerPolicy);
  };
  const { look } = context;
  return hx(
    'box',
    {
      ref: scroller,
      style: { flexGrow: 1, overflow: 'scroll' },
      // `scrolling="no"` shows no scroll bars, whatever the document's
      // `overflow` (HTML 15.4.4, the iframe element's rendering), and nor
      // does a viewport its root gives `scrollbar-width: none` or that is
      // `hidden` on both axes
      ...((SCROLLS_NOT.test(frame.attribs.scrolling ?? '') || !bars) && {
        scrollbar: false,
      }),
      // a document of the page realm's has its pane's `scroll` told there,
      // among the page's scroll steps' targets
      onScroll: () =>
        realm ? scripts.scrolled?.() : context.parent.frameScrolled(document),
    },
    h(Html, {
      source: '',
      document,
      partial: false,
      baseUrl: url,
      ref: handle.ref,
      ...look,
      // what the frame's document asks for is the frame's: its `Referer`,
      // and for a sandbox no cookie that is the site's alone, where the
      // page's own had the page's
      onResource: (request: ResourceRequest) =>
        throughWorker(
          scripts,
          { ...request, client: url },
          look.onResource,
        ) as Promise<ResourceResult | null>,
      onLink: (href, ev) => {
        let link = handle.elementAt(ev.x, ev.y);
        while (link && link.name !== 'a' && link.name !== 'area') {
          link = link.parent?.type === 'tag' ? (link.parent as Element) : null;
        }
        send(
          linkTarget(link, document),
          href,
          null,
          link?.attribs.rel,
          linkReferrerPolicy(link) || documentReferrerPolicy(document),
        );
      },
      onSubmit: (submission) => {
        const { url: to, method, body, contentType, target } = submission;
        if (sandbox & SB_FORMS) return;
        if (!/^(?:https?|file|data):/i.test(to)) return;
        send(
          target,
          to,
          method === 'post'
            ? { body: body ?? '', contentType: contentType ?? '' }
            : null,
          submission.form.attribs.rel,
        );
      },
      scripting: scripts.scripting,
      onScript: scripts.onScript,
      onParsed: scripts.onParsed,
      // a document of the page realm's has the frame hear `load` once all
      // it asked for is in (`followFrame`)
      onLoaded: realm ? scripts.onLoaded : () => host.frameViewLoaded(document),
      // a document of the page realm's has its events heard there
      onDomEvent: realm
        ? scripts.onDomEvent
        : (event) => (context.parent.dispatch(event) ? undefined : false),
      onDocument: scripts.onDocument,
      // and its scroll containers' `scroll` and `scrollend` there too
      onViewportOverflow: viewportOverflow,
      onElementScroll: realm
        ? scripts.onElementScroll
        : (element) => context.parent.elementScrolled(element),
      stylesheet: scripts.stylesheet,
      renderEmbedded: embeddedMounts(inner),
      canvasImage: scripts.canvasImage,
      ...({ _framed: scripts.framed } as object),
      style: { flexGrow: 1 },
      // the frame's own viewport moved — its box laid out again by the
      // page — which its realm hears as its window's `resize` and its media
      // query lists' `change`; and its own CSS animations' and transitions'
      // events, which its realm hears at its rendering update, the page's
      // where it has none of its own (`InternalHtmlProps`)
      ...({
        _sandbox: sandbox,
        _embedderScheme: scheme,
        _frameElement: frame,
        _onPaint: scripts.painted,
        _onCssEventsOwed: realm
          ? scripts.cssEventsOwed
          : () => context.parent.cssEventsOwed(document),
        _onImage: scripts.imageSettled,
        _onMediaEvent: scripts.mediaEvent,
        ...(context.seams.clipboard && {
          _readClipboard: () => context.seams.clipboard!.read(),
        }),
      } as object),
    }),
    holder ? h(FrameHolder, { context: holder }) : null,
  );
}
