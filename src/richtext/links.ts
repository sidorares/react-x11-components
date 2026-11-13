// Following a link in a document, and what a link of a known kind says
// about the thing it points at.
//
// The only part of the old gesture hook that survived react-x11#291: core
// selects, copies and takes PRIMARY on its own now, but it left hover and
// `cursorAt` out deliberately, so which run is a link and what a click on
// one means are still this package's to answer.
//
// It lived in `../markdown/` until `<TerminalOutput>` needed it for OSC 8
// hyperlinks, and it moved here rather than being copied: there is no
// markdown in it at all. It is about `TextRun.href` and `hrefAtPoint`, both
// of which are this module's — the same "extract when the second consumer
// arrives" move `../codeblock/` was.
//
// The third consumer, `<Html>`, is what made the node test structural: it
// answers `hrefAtPoint` from a document it laid out itself and is not a
// `RichTextNode`. Asking for the method rather than the class is also what
// keeps this module from importing `node.ts`, so a surface that wants link
// clicks and nothing else does not pull the element in behind them.
//
// The whole problem is that a press on a link is also the start of a drag,
// and the two are told apart only at the release: a pointer that has barely
// moved and left nothing selected was a click, and anything else was a
// selection that happened to begin on a link. These handlers never call
// `preventDefault`, so core's own selection still runs after them.
//
// **Link kinds** (`useLinks`) are the second half. A document's link is an
// ordinary link whose href names a thing — a pull request's URL, a
// session's — and an application hands a list of kinds that recognise
// hrefs: what a click on one does, and a card it shows on hover with the
// thing's state now. The state is never in the document. It changes after
// the document was written, so the card is the application's own component,
// reading the application's own stores, and the document holds only which
// thing it means.
import React, { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useTheme } from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent as X11KeyboardEvent,
  MouseEvent as X11MouseEvent,
} from 'react-x11';
import type { Style } from 'react-x11/style';
import { XK_ESCAPE } from 'react-x11/keysyms';

import type { InlineDrawing, LinkAt, TextRun } from './node.js';
import { cancelLater, later } from '../internal/timers.js';
import type { DelayTick } from '../internal/timers.js';

const h = React.createElement;

/** Any node that can name the link under a point — `<richtext>` and
 *  `<htmlview>` both do, and neither has to say so to this module.
 *  `linkAtPoint` is `<richtext>`'s alone, and is what a card needs. */
interface HrefSource {
  hrefAtPoint?(x: number, y: number): string | null;
  linkAtPoint?(x: number, y: number): LinkAt | null;
}

/** How far the pointer may travel and still count as a click, in pixels. */
const CLICK_SLOP = 3;

/** How long the pointer rests on a link before its card opens, in ms. */
export const CARD_OPEN_DELAY = 400;

/** How long a card stays up once the pointer has left the link and the
 *  card — long enough to cross the gap between the two. */
export const CARD_CLOSE_DELAY = 250;

export interface LinkHandlers {
  onMouseDown: (ev: X11MouseEvent<DrawnNode>) => void;
  onMouseUp: (ev: X11MouseEvent<DrawnNode>) => void;
}

/** A link as a kind's callbacks see it. */
export interface LinkInfo {
  href: string;
  /** The link's label as the document draws it. `''` from a surface that
   *  can name the href under a point and nothing more. */
  text: string;
}

/** What a card is handed besides its reference. */
export interface LinkCardContext extends LinkInfo {
  /** Take the card down — after an action in it that leaves it nothing to
   *  say. */
  close(): void;
}

/**
 * A kind of link: which hrefs are one, what a click on one does, and what
 * its hover card shows.
 *
 * ```ts
 * const pullRequest = linkKind({
 *   match: (href) => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(href),
 *   card: (m) => h(PullRequestCard, { repo: m[1], number: Number(m[2]) }),
 * });
 * ```
 *
 * The kinds are tried in order and the first that matches has the link. A
 * kind with no `activate` leaves the click to `onLink`, so a kind can add a
 * card to links the application already follows.
 */
export interface LinkKind<Ref = unknown> {
  /** The reference this kind reads out of an href, or `null`/`undefined`
   *  when the href is not one of its. Called on every hover and click, so
   *  keep it to a pattern match. */
  match(href: string): Ref | null | undefined;
  /** A click on the link. Absent: the click goes to `onLink`. */
  activate?(ref: Ref, link: LinkInfo, ev: X11MouseEvent<DrawnNode>): void;
  /** The card a resting pointer opens. Return the application's own
   *  component: it is mounted for as long as the card is up, and reads the
   *  state of the thing as it is now. Absent: no card. */
  card?(ref: Ref, ctx: LinkCardContext): ReactNode;
  /** How long the pointer rests before the card opens, in ms. Default
   *  `CARD_OPEN_DELAY`. */
  cardDelay?: number;
  /**
   * How the link is drawn: its colour, underline, chip, weight, and an
   * icon before it. Called as the document is drawn, so it may read the
   * thing's state now — and `watch` is how the document hears that the
   * answer changed. Absent: the document's own link look.
   */
  look?(ref: Ref, link: LinkInfo): LinkLook | null | undefined;
  /**
   * The text drawn for the link, in place of the label the document wrote
   * — `owner/repo#12 · Fix the parser` for a bare pull request URL. The
   * document keeps what it wrote: this changes what is drawn, and what a
   * selection of the drawn text copies. Absent, or `undefined`: the
   * document's label.
   */
  label?(ref: Ref, text: string): string | undefined;
  /**
   * Hear when `look` or `label` would answer differently for this
   * reference — the thing's state moved. Call `changed`, and the blocks
   * holding a link to it are drawn again; return what stops listening.
   * Asked once for each reference the document links to, for as long as
   * it does.
   */
  watch?(ref: Ref, changed: () => void): () => void;
}

/** How a link of a kind is drawn, over the document's own link look. */
export interface LinkLook {
  /** The text's colour. */
  color?: string;
  /** The underline's colour, or `false` for none. */
  underline?: string | false;
  underlineStyle?: TextRun['underlineStyle'];
  /** A fill behind the label — a chip. */
  bg?: string;
  bgFill?: TextRun['bgFill'];
  weight?: TextRun['weight'];
  style?: TextRun['style'];
  /** Drawn before the label, in its line — an icon, a status dot. Give the
   *  same object for the same picture: a run's fields are compared by
   *  identity, and a new one lays the paragraph out again. */
  icon?: InlineDrawing;
  /** Room between the icon and the label, in logical pixels. Default 4. */
  iconGap?: number;
}

/** A kind, with its reference type inferred from `match` — so the other
 *  callbacks are checked against it. */
export function linkKind<Ref>(kind: LinkKind<Ref>): LinkKind<Ref> {
  return kind;
}

/** A list of kinds of different references. Each was checked against its
 *  own as it was made with `linkKind`; the list only holds them. */
export type LinkKinds = readonly LinkKind<any>[];

/** The kind that has an href, and the reference it read out of it. */
export function matchLink(
  kinds: LinkKinds | undefined,
  href: string,
): { kind: LinkKind<unknown>; ref: unknown } | null {
  if (!kinds) return null;
  for (const kind of kinds) {
    const ref = kind.match(href);
    if (ref !== null && ref !== undefined) return { kind, ref };
  }
  return null;
}

/**
 * The clock a card opens and closes on: a timer, and nothing else. Exported
 * for the tests, which hold it (`test/held-clock.ts`) — a runner slow
 * enough to spend the open delay inside one `await` finds the card open
 * already, and a test of what comes before it passes either way.
 */
export const cardClock = {
  arm(step: () => void, ms: number): DelayTick {
    return later(step, ms);
  },
  disarm(handle: unknown): void {
    cancelLater(handle as DelayTick);
  },
};

/**
 * Mouse handlers for a document root that follows links. Returns handlers
 * that do nothing when `onLink` is absent — the component never navigates by
 * itself, and a document with no handler simply has inert link text.
 */
export function useLinkClicks(
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void,
): LinkHandlers {
  return useClicks(onLink ? (link, ev) => onLink(link.href, ev) : undefined);
}

/** What a press found, kept for the release that decides whether it was a
 *  click. */
interface Press {
  x: number;
  y: number;
  link: LinkInfo;
}

/** The click half: press, release, and the slop and selection that tell a
 *  click from a drag. `follow` absent, or answering false for an href,
 *  leaves the press alone. */
function useClicks(
  follow: ((link: LinkInfo, ev: X11MouseEvent<DrawnNode>) => void) | undefined,
  takes?: (href: string) => boolean,
): LinkHandlers {
  const press = useRef<Press | null>(null);
  return {
    onMouseDown: (ev) => {
      press.current = null;
      if (!follow || ev.button !== 1) return;
      const link = linkUnder(ev);
      if (link && (!takes || takes(link.href))) {
        press.current = { x: ev.x, y: ev.y, link };
      }
    },
    onMouseUp: (ev) => {
      const start = press.current;
      press.current = null;
      if (!follow || !start || ev.button !== 1) return;
      if (
        Math.abs(ev.x - start.x) > CLICK_SLOP ||
        Math.abs(ev.y - start.y) > CLICK_SLOP
      ) {
        return;
      }
      // a drag that ended where it began still selected something; that was
      // a selection gesture, not a click
      if (!(ev.currentTarget?.textSelection?.isCollapsed ?? true)) return;
      follow(start.link, ev);
    },
  };
}

/** The link under an event's point, from whichever query its target has. */
function linkUnder(ev: X11MouseEvent<DrawnNode>): LinkInfo | null {
  const target = ev.target as HrefSource | null;
  if (typeof target?.linkAtPoint === 'function') {
    const at = target.linkAtPoint(ev.x, ev.y);
    return at ? { href: at.href, text: at.text } : null;
  }
  if (typeof target?.hrefAtPoint === 'function') {
    const href = target.hrefAtPoint(ev.x, ev.y);
    return href != null ? { href, text: '' } : null;
  }
  return null;
}

export interface UseLinksOptions {
  /** A click on a link no kind activates. */
  onLink?: (href: string, ev: X11MouseEvent<DrawnNode>) => void;
  /** The kinds of link this document knows. Give a stable identity. */
  kinds?: LinkKinds;
  /** Over the card's frame: its fill, border, padding, width. */
  cardStyle?: Style;
}

/** Spread onto the document root; `card` goes among its children. */
export interface LinksResult {
  handlers: LinkHandlers & {
    onMouseMove: (ev: X11MouseEvent<DrawnNode>) => void;
    onMouseLeave: (ev: X11MouseEvent<DrawnNode>) => void;
    onKeyDown: (ev: X11KeyboardEvent<DrawnNode>) => void;
  };
  /** The open card, a `<popup>` hung off the link, or null. */
  card: ReactElement | null;
  /** Whether a click on some link does something: what decides the
   *  pointer cursor. */
  follows: boolean;
}

interface OpenCard {
  node: DrawnNode;
  link: LinkAt;
  kind: LinkKind<unknown>;
  ref: unknown;
}

interface Pending {
  node: DrawnNode;
  href: string;
  start: number;
  tick: unknown;
}

/**
 * Clicks and hover cards for a document root, from a list of link kinds.
 *
 * A pointer that rests on a link a kind has a card for opens it after the
 * kind's `cardDelay`, hung below the piece of the link under the pointer.
 * It stays up while the pointer is on the link or on the card, and goes
 * `CARD_CLOSE_DELAY` after it is on neither, at a press anywhere in the
 * document, or at Escape. A press is never a hover: a drag that selects
 * across a link opens nothing.
 */
export function useLinks(options: UseLinksOptions): LinksResult {
  const { onLink, kinds, cardStyle } = options;
  const theme = useTheme() as unknown as Record<string, unknown>;
  const [open, setOpen] = useState<OpenCard | null>(null);
  const openRef = useRef<OpenCard | null>(null);
  openRef.current = open;
  const pending = useRef<Pending | null>(null);
  const closing = useRef<unknown>(null);
  const down = useRef(false);

  const cards = !!kinds?.some((k) => typeof k.card === 'function');
  const activates = !!kinds?.some((k) => typeof k.activate === 'function');

  const cancelPending = (): void => {
    if (pending.current) cardClock.disarm(pending.current.tick);
    pending.current = null;
  };
  const cancelClose = (): void => {
    if (closing.current) cardClock.disarm(closing.current);
    closing.current = null;
  };
  const closeNow = (): void => {
    cancelPending();
    cancelClose();
    if (openRef.current) setOpen(null);
  };
  const closeSoon = (): void => {
    if (closing.current || !openRef.current) return;
    closing.current = cardClock.arm(() => {
      closing.current = null;
      setOpen(null);
    }, CARD_CLOSE_DELAY);
  };

  // the timers go with the document
  useEffect(
    () => () => {
      if (pending.current) cardClock.disarm(pending.current.tick);
      if (closing.current) cardClock.disarm(closing.current);
    },
    [],
  );

  const clicks = useClicks(
    onLink || activates
      ? (link, ev) => {
          const found = matchLink(kinds, link.href);
          if (found?.kind.activate) found.kind.activate(found.ref, link, ev);
          else onLink?.(link.href, ev);
        }
      : undefined,
    onLink ? undefined : (href) => !!matchLink(kinds, href)?.kind.activate,
  );

  const handlers: LinksResult['handlers'] = {
    onMouseDown: (ev) => {
      down.current = true;
      closeNow();
      clicks.onMouseDown(ev);
    },
    onMouseUp: (ev) => {
      down.current = false;
      clicks.onMouseUp(ev);
    },
    onMouseMove: (ev) => {
      if (!cards || down.current) return;
      const target = ev.target as (HrefSource & DrawnNode) | null;
      const link =
        typeof target?.linkAtPoint === 'function'
          ? target.linkAtPoint(ev.x, ev.y)
          : null;
      const found = link ? matchLink(kinds, link.href) : null;
      if (!target || !link || !found?.kind.card) {
        cancelPending();
        closeSoon();
        return;
      }
      const cur = openRef.current;
      if (
        cur &&
        cur.node === target &&
        cur.link.href === link.href &&
        cur.link.start === link.start
      ) {
        cancelPending();
        cancelClose();
        return;
      }
      const p = pending.current;
      if (
        p &&
        p.node === target &&
        p.href === link.href &&
        p.start === link.start
      ) {
        return;
      }
      cancelPending();
      closeSoon();
      const delay = found.kind.cardDelay ?? CARD_OPEN_DELAY;
      pending.current = {
        node: target,
        href: link.href,
        start: link.start,
        tick: cardClock.arm(() => {
          pending.current = null;
          cancelClose();
          setOpen({ node: target, link, kind: found.kind, ref: found.ref });
        }, delay),
      };
    },
    onMouseLeave: () => {
      cancelPending();
      closeSoon();
    },
    onKeyDown: (ev) => {
      if (openRef.current && ev.keysym === XK_ESCAPE) closeNow();
    },
  };

  let card: ReactElement | null = null;
  if (open?.kind.card) {
    const content = open.kind.card(open.ref, {
      href: open.link.href,
      text: open.link.text,
      close: closeNow,
    });
    const frame: Style = {
      flexDirection: 'column',
      padding: 8,
      borderWidth: 1,
      borderColor: String(theme.border ?? '#b2bec3'),
      borderRadius: Number(theme.radius ?? 6),
      backgroundColor: String(theme.surface ?? theme.background ?? 'white'),
    };
    card = h(
      'popup',
      {
        key: 'link-card',
        theme,
        anchor: {
          to: open.node,
          at: open.link.rect,
          placement: 'bottom',
          align: 'start',
          offset: 4,
        },
        maxWidth: 480,
      } as Record<string, unknown>,
      h(
        'box',
        {
          role: 'tooltip',
          onMouseEnter: cancelClose,
          onMouseLeave: closeSoon,
          style: cardStyle ? [frame, cardStyle] : frame,
        } as Record<string, unknown>,
        content,
      ),
    );
  }

  return { handlers, card, follows: !!onLink || activates };
}
