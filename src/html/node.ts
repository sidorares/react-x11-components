// `<htmlview>` — the retained element behind `<Html>`.
//
// It owns the whole pipeline and, more importantly, owns **when each stage
// runs**. That is the component's reason to exist, so it is worth stating in
// one place:
//
//   source changed      → parse (incrementally), style, box, lay out, paint
//   stylesheet arrived  → style, box, lay out, paint
//   DOM mutated         → box, lay out, paint
//   width changed       → lay out, paint          (no parse, no cascade)
//   media band crossed  → style, box, lay out, paint
//   scrolled / exposed  → paint, culled to the damage rect
//
// Each row is strictly cheaper than the one above it, and the two the
// component is measured on — first content painted, and what an expose or a
// resize costs — are the two cheapest. Nothing in a computed style depends on
// the width (see css/values.ts) and nothing in a box tree depends on the
// scroll, which is what makes the table true rather than aspirational.
//
// **Why one element rather than a tree of `<box>`es and `<richtext>`s**, the
// way `<Markdown>` is built. Two reasons, and the second is the load-bearing
// one:
//
//  1. A document of any size is thousands of elements. Reconciling them
//     through React and laying them out through yoga, per keystroke of a
//     streaming document, is the cost this is trying not to pay.
//  2. **CSS layout is not the host's layout.** react-x11 lays out with yoga,
//     which is flexbox; block flow with margin collapsing, floats, an inline
//     formatting context and table column sizing are not expressible in it.
//     Composing would mean approximating the layout model, which is what
//     ntk's `HtmlView` did and what makes it hard to trust. So the element
//     draws — the same call `<Flow>` makes for a different reason — and the
//     things that must be real widgets (form controls) are mounted beside it
//     rather than inside it.
//
// What is reused from `<richtext>` is everything that was not about the
// element: the `TextRun` vocabulary, the per-run decoration painter, and the
// bidi-correct selection bands. See `src/richtext/runs.ts`.
import { registerElement, registeredElements } from 'react-x11/host';
import { Node } from 'react-x11/node';
import type {
  Context2D,
  MeasureConstraints,
  MeasuredSize,
} from 'react-x11/node';
import type { MouseEvent as X11MouseEvent, Rect } from 'react-x11';
import type { Style } from 'react-x11/style';
import type { ChildNode, Element } from 'domhandler';

import { codePointAtOffset, codeUnitOffsets } from '../internal/text.js';
import {
  attr,
  choosesSource,
  flatChildrenOf,
  flatParentOf,
  HtmlSource,
  imageUrlOf,
  isElement,
  isText,
  tagOf,
} from './dom.js';
import type { Document, ShadowRoot, SheetRef } from './dom.js';
import {
  Cascade,
  HOVER_FOLLOWED,
  HOVER_PSEUDO_GENERATED,
  HOVER_PSEUDO_NONE,
  HOVER_PSEUDO_OTHER,
  HOVER_UNTOUCHED,
  NO_FOCUS,
} from './css/cascade.js';
import type {
  FocusState,
  HoverTouch,
  KeptStyles,
  MetricFace,
  ShadowSheets,
} from './css/cascade.js';
import { mediaMatches, parseStylesheet } from './css/parse.js';
import type { MediaCondition, Stylesheet } from './css/parse.js';
import type { ShapeStyles } from './css/shapes.js';
import { uaStylesheet } from './css/ua.js';
import { AnimationTimeline } from './css/timeline.js';
import type { ComputedStyle, RootLook } from './css/style.js';
import {
  sameValue,
  urlOf,
  WILL_HOLD_FIXED,
  WILL_HOLD_FIXED_BOX,
  WILL_STACK,
  WILL_STACK_BOX,
} from './css/style.js';
import {
  BOX_RAISES,
  buildBoxes,
  CONTENT_IMAGES,
  CLEARED_FROM,
  COLUMN_LINES,
  COLUMN_PIECES,
  COLUMN_ROWS,
  CUT_BLOCKS,
  GENERATED_FROM,
  INLINE_OFFSETS,
  LINE_BOX_RAISES,
  PAINT_ORDER,
  SHAPE_STYLES,
  SHIFTED_LINES,
  TEXT_SHIFTS,
  columned,
  textFade,
} from './layout/boxes.js';
import type {
  Box,
  BoxTree,
  LineBox,
  LineText,
  ReplacedKind,
  TextLayoutLike,
} from './layout/boxes.js';
import { layoutDocument, placedMatrix, retranslate } from './layout/block.js';
import {
  invert,
  mapPoint,
  mapRect,
  outOfPlane,
  transformed,
} from './css/transform.js';
import { TextLayoutCache } from './layout/cache.js';
import { fontAxes } from './layout/axes.js';
import { shapingSafe } from './layout/shaping.js';
import {
  coveredAfter,
  describe,
  liftOf,
  overLiftOf,
  partOf,
  stillLiftOf,
} from './sprites.js';
import type {
  DocumentSprite,
  Lift,
  Part,
  Pseudo,
  SpriteHost,
} from './sprites.js';
import { SpriteStore, SurfaceCache, newSurface } from './surfaces.js';
import { FilterStore } from './filters.js';
import type { SurfaceLike } from './surfaces.js';
import {
  faceExtentOf,
  faceLineHeight,
  fadeRun,
  inlineDecoration,
  runFor,
} from './layout/inline.js';
import type { FontsLike } from './layout/inline.js';
import type { TextRun } from '../richtext/index.js';
// Through the inline module rather than a second cache: the offsets table for
// a layout is built once, on the first selection that needs it.
import {
  documentOffsetOf,
  layoutOffsetOf,
  layoutOffsets as layoutOffsetsOf,
} from './layout/inline.js';
import { lineBands as bandsFor } from '../richtext/runs.js';
import {
  clipsOverflow,
  computePaintBounds,
  containingBlockOf,
  coverersAfter,
  drawnAtViewport,
  FIXED_BOXES,
  fixedToViewport,
  forgetCasts,
  forgetDecoratedAncestors,
  hasRect,
  hoistNegative,
  holds,
  holdsAbsolute,
  inClip,
  inClipPath,
  layered,
  layerOf,
  onLine,
  opaqueCanvas,
  ownBounds,
  paintDocument,
  paintLiftedBox,
  paintOrderOf,
  pathClips,
  queryChildIndex,
  selectedPieces,
  selectionRows,
  stackLayers,
  stacksLayers,
} from './paint.js';
import type { PaintContext, PaintOptions, SpriteSource } from './paint.js';
import { controlRectsOf, measureControl, styledField } from './controls.js';
import { isInert, isTabbable } from './focus.js';
import type { FocusStop } from './focus.js';
import type { BareField, ControlRect } from './controls.js';
import { decodesImageType } from './image-types.js';
import { ResourceStore } from './resources.js';
import type {
  ResourceRequest,
  ResourceResult,
  VideoSource,
} from './resources.js';
import { ImageSources } from './srcset.js';
import type { SourceChanges } from './srcset.js';
import { atDensity } from './svg.js';
import { cutByFixed, mediaRectsOf, videoCandidates } from './media.js';
import type { MediaRect } from './media.js';
import type { IntrinsicSize } from './svg.js';
import { WebFonts } from './fonts.js';
import type { DeclaredFace } from './fonts.js';
import { resolveUrl, UrlResolver } from './url.js';

/** The element name — registration key, `node.kind` and JSX tag alike. */
export const ELEMENT = 'htmlview';

/** The ntk connection a node is built against, derived from `Node`'s own
 *  constructor rather than named, so it cannot drift from core's. */
export type NtkApp = ConstructorParameters<typeof Node>[2];

/** What a `<script>` hands the host. Never parsed and never evaluated —
 *  the seam exists so an application can decide, not so this can pretend. */
export interface ScriptRequest {
  /** The `type` attribute, lowercased; `'text/javascript'` when absent. */
  type: string;
  /** `src`, for an external script. */
  src: string | null;
  /** The element's text, for an inline one. Handed over verbatim. */
  text: string;
  element: Element;
}

export interface HtmlViewProps {
  source: string;
  /** False while more source may still arrive. */
  complete?: boolean;
  /** Author stylesheets applied after the document's own. */
  stylesheet?: string | string[];
  /** The encoding the host decoded `source` from: what a stylesheet handed
   *  over as bytes falls back to. */
  charset?: string;
  /** The URL the document came from, which its relative URLs resolve
   *  against — see `url.ts`. */
  baseUrl?: string | null;
  look: RootLook;
  selectionColor?: string;
  onResource?: (
    request: ResourceRequest,
  ) => Promise<ResourceResult | null> | ResourceResult | null;
  onScript?: (script: ScriptRequest) => void;
  /** Where the real widgets go, in the element's own coordinates and in
   *  logical pixels — the unit the style that mounts each one is in. */
  onControls?: (rects: ControlRect[]) => void;
  /**
   * Where a `<video>`'s player goes and what it plays (`media.ts`), in the
   * same space as `onControls`: reported after a layout that moved one, a
   * source the host answered or the player failed on, and a scroll that
   * brought a box fixed to the viewport over one. Absent, no video source
   * is asked for, and every video is its poster.
   */
  onMedia?: (rects: MediaRect[]) => void;
  /**
   * The document's focusable areas, in the order Tab reaches them
   * (`focus.ts`): reported after a layout or a restyle that changed which
   * they are, or moved one `watchStops` names — a new array each time, so
   * a component holding it as state renders again and reads where the
   * watched ones are now (`stopRect`).
   */
  onFocusStops?: (stops: readonly FocusStop[]) => void;
  /** The stops whose rectangles `onFocusStops` keeps watch on: the few a
   *  component mounts a box over (`stops.ts`). */
  watchStops?: readonly Element[];
  /** The parsed document, once per parse — the DOM handle. */
  onDocument?: (document: Document) => void;
  /** Bumped by the component to force a re-read of a mutated DOM. */
  domRevision?: number;
  /** Whether the document's CSS animations run. Default true. */
  animate?: boolean;
  /** Whether the desktop has asked for less motion: what
   *  `prefers-reduced-motion` is answered from. Default false. */
  reducedMotion?: boolean;
  style?: Style | Style[];
}

export function registerHtmlView(): void {
  if (registeredElements().includes(ELEMENT)) return;
  registerElement(ELEMENT, {
    create: (props, app) => new HtmlViewNode(props, app),
    // `source` and `look` are this element's own vocabulary and neither is a
    // style name today; declaring them keeps the DEV flat-style-prop
    // assertion honest if core's vocabulary grows underneath us.
    semanticNames: [
      'source',
      'look',
      'stylesheet',
      'charset',
      'complete',
      'baseUrl',
    ],
    // what the component watches is no part of the picture: a new window of
    // stops after each Tab is no repaint of the document
    selfDamagedProps: ['watchStops'],
    childrenAllowed: false,
  });
}

/** How many widths' sizes a document keeps (`HtmlViewNode._sizeAt`): the
 *  two a frame of a resize asks, and a little slack for a drag that turns
 *  back. */
const SIZES_KEPT = 4;

/**
 * A size in the whole pixels core lays out in, rounded up — less the float
 * noise a sum of Yoga's single-precision positions carries: a page exactly
 * `100vh` tall came to 737.0000076 under a 737-pixel viewport, and a
 * rounding that took it for 738 scrolled it by a pixel under a scrollbar.
 */
function wholePixels(n: number): number {
  return Math.max(0, Math.ceil(n - 1 / 64));
}

/** How deep `@import`s are followed: an import in an import in an import is
 *  a stylesheet; sixteen of them is a loop that changes its URL each time. */
const MAX_IMPORT_DEPTH = 16;

/** A scheme at the start: an absolute URL, a base that means something. */
const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** What warming a document's faces needs of the fonts: ntk's
 *  `FontManager#prewarm`, which names faces from the release that added
 *  them (8.14) and warms the family's four before it. An engine without it
 *  has nothing to look up. */
interface WarmingFonts {
  prewarm?(family: string, faces?: { weight: number; style: string }[]): void;
}

/** What changed, and therefore how far back up the pipeline to go. */
const enum Stale {
  Nothing = 0,
  Layout = 1,
  Boxes = 2,
  Style = 3,
  Everything = 4,
}

export class HtmlViewNode extends Node {
  private _source = new HtmlSource();
  /** Where the document's relative URLs resolve: its `<base href>` against
   *  the `baseUrl` prop, or the prop, or nowhere (`url.ts`). */
  private _urls = new UrlResolver();
  private _resources: ResourceStore;
  /** The sources the `<img srcset>`s and `<picture>`s have chosen, and what
   *  each shows while its choice is on its way (`srcset.ts`). */
  private _images: ImageSources;
  /** The viewport, scale, scheme and preference for motion they were last
   *  chosen in, and the document's revision then: `_choose` asks nothing
   *  again until one of them moves. */
  private _choseIn = '';
  /** The families the document's `@font-face` rules declare (`fonts.ts`). */
  private _webFonts: WebFonts;
  /** The sheets the last restyle read, and the cascade built from them. */
  private _sheetsRead: SheetsRead | null = null;
  /** Each sheet text a shadow tree has read as, by a number
   *  (`_sheetsKey`). */
  private _sheetIds = new Map<string, number>();
  /** Blurred shadows, drawn once each. */
  private _shadowCache: SurfaceCache | null = null;
  /**
   * The rasters of the SVG images this has drawn at a size more than once
   * (`drawSvg`), the least recently drawn given up first past the cache's
   * budget: what a single paint draws once is not kept, and a page painted
   * once keeps none. `_drawnOnce` is the keys drawn once.
   */
  private _drawings: SurfaceCache | null = null;
  private _drawnOnce = new Set<string>();
  /** Blocks of the tiles of small repeating backgrounds (`tileBlock`). */
  private _tileBlocks: SurfaceCache | null = null;
  /** Whether the backend was found to have no offscreen surface. */
  private _noSurface = false;
  /** The surfaces kept for the boxes whose transform is animating, drawn
   *  once and composited each frame (`paintSprite`). They hold the boxes as
   *  they were laid out and styled, so a build or a layout forgets them
   *  all, and a restyle in place the ones it reaches (`_restyledSprites`). */
  private _sprites: SpriteStore | null = null;
  /** The pixels of the boxes a filter's colour functions are run over, read
   *  back from the group each painted and kept (`paintFiltered`). What a
   *  build, a layout or a restyle forgets of the surfaces kept for boxes it
   *  forgets of these, keeping what each element drew last until a read
   *  under its new boxes arrives. */
  private _filtered: FilterStore | null = null;
  /** What the painter asks for a box's kept surface. A box whose element an
   *  animation is under way on keeps one however large it is, until the
   *  animation is over; a pseudo-element's box is one only the painter's
   *  size limit lets keep one. */
  private readonly _spriteSource: SpriteSource = {
    kept: (box, width, height, key) =>
      this._sprites?.get(box, width, height, key) ?? null,
    animates: (box) => !!box.el && !box.pseudo && this._timeline.isLive(box.el),
    keep: (box, width, height, key, animated) =>
      (this._sprites ??= new SpriteStore(this.app)).make(
        box,
        width,
        height,
        key,
        animated,
      ),
  };
  // --- sprites (`sprites()`, src/html/sprites.ts) ---
  /**
   * The style an element has in the tree the document draws, or a
   * pseudo-element's: what a transition starts from (`Cascade.previous`).
   * None where the tree was styled by other sheets: a stylesheet arriving
   * is no change to transition through, as a browser that waits for it to
   * draw shows none.
   */
  private readonly _previousStyle = (
    el: Element,
    pseudo: string,
  ): ComputedStyle | null => {
    const tree = this._tree;
    if (!tree || this._styledWith !== this._cascade) return null;
    if (pseudo === '') return tree.styles.get(el)?.style ?? null;
    if (pseudo !== 'before' && pseudo !== 'after') return null;
    return this._pseudoBoxOf(tree, el, pseudo)?.style ?? null;
  };
  /** What a presenter has on layers of their own, by sprite key, as it
   *  said last (`spritesLifted`): an element or a pseudo-element of one
   *  each, a hole in the document, and an animation the document's clock
   *  leaves alone. */
  private _lifted = new Map<string, SpriteTarget>();
  /** The same by element: which of its own ('') and its pseudo-elements'
   *  are lifted. */
  private _liftedTargets = new Map<Element, Set<Pseudo>>();
  /** This frame's offers, by key: what a key the presenter names is. */
  private _offered = new Map<string, SpriteTarget>();
  /** Each sprite's key, the same for as long as its element lives. */
  private _spriteKeys = new WeakMap<Element, Partial<Record<Pseudo, string>>>();
  private _spriteSeq = 0;
  /** What each was last offered as, and what that was made from: making
   *  one samples its frames, and a frame asks every time. */
  private _spriteOffers = new WeakMap<
    Element,
    Partial<Record<Pseudo, SpriteOffer>>
  >();
  /** The build a frame of the document's animations made last where all
   *  it changed was laid out apart, out of the flow (`_rebuildFrame`): the
   *  trees before and after it, by their serials, and the elements whose
   *  change it laid out apart. A part that holds none of them and is
   *  inside none paints what it painted before (`sprites`). */
  private _quietBuild: {
    before: number;
    after: number;
    roots: readonly Element[];
  } | null = null;
  /** Moves whenever what a lifted box draws may have changed without a
   *  build — a restyle of it, or of a box in it. */
  private _spriteGen = 0;
  /** The animations the render server ran to their end, by element. */
  private _endedSprites = new WeakMap<Element, Set<string>>();
  /** Whether a restyle in place is only bringing lifted elements up to
   *  where their animations have them (`_followLifted`): what they draw is
   *  what it was, and their layers already show them there. */
  private _followingLifted = false;
  /** The boxes a tree turns out of the plane (`_tiltedBoxes`), as of
   *  that tree: dropped by a restyle in place that turns one into or out
   *  of it. */
  private _tiltedKept: { tree: BoxTree; boxes: readonly Box[] } | null = null;
  /** The lifted boxes, for the paint, as of a tree and a set. */
  private _liftedBoxCache: {
    tree: BoxTree;
    lifted: ReadonlyMap<string, SpriteTarget>;
    boxes: ReadonlySet<Box>;
  } | null = null;
  /** The animations that are not the document's clock's to run: an
   *  element's own, or a pseudo-element's, on a layer of its own. */
  private readonly _skipLifted = (el: object, pseudo: string): boolean =>
    this._liftedTargets.get(el as Element)?.has(pseudo as Pseudo) ?? false;
  private _cascade: Cascade | null = null;
  private _tree: BoxTree | null = null;
  /** The faces `_warmFaces` has asked the font matcher for, and of which
   *  fonts. */
  private _warmedFaces = new Set<string>();
  private _warmedFor: unknown = null;
  private _stale: Stale = Stale.Everything;
  /** The width the document was last laid out at. Not `_laidOutAt`: core's
   *  `Node` has a method of that name, which a field would hide. */
  private _laidOutWidth = -1;
  private _mediaBand = -1;
  /** The viewport the box tree's styles were computed at, for the ones
   *  that read it (`vw`, `vh`). */
  private _styledWidth = -1;
  private _styledHeight = -1;
  /** The cascade the box tree's styles were computed by. */
  private _styledWith: Cascade | null = null;
  private _documentHeight = 0;
  private _documentWidth = 0;
  /**
   * While the width keeps moving — a window edge dragged — the document is
   * laid out down to a viewport past what can be seen and no further, and
   * whole once the width rests (`_stopAt`). Whether the layout it has is
   * one that stopped; the box tree last laid out whole, which a layout
   * that stops takes the size of what it sets aside from; when the width
   * last moved; and the wait for it to rest.
   */
  private _partial = false;
  private _wholeTree: BoxTree | null = null;
  /** The tree a band a drag crossed built, which a layout may stop in as
   *  it may in one laid out whole (`_stopAt`). */
  private _crossedTree: BoxTree | null = null;
  private _widthMovedAt = -Infinity;
  /** The width of the last layout, whatever was built since: a band a
   *  drag crosses builds the boxes again, and the width still moved. */
  private _widthLaid = -1;
  private _settleTimer: unknown = null;
  /** The viewport height the document was last laid out under, and whether
   *  that layout read it (`LayoutResult.readsViewportHeight`). */
  private _laidOutUnder = -1;
  private _layoutReadsViewport = false;
  /** Whether core is asking for this element's size right now — inside
   *  its layout pass, where a node must not ask to be measured again. */
  private _measuring = false;
  /** What the document came to at the widths it was last laid out at, while
   *  nothing a layout reads has changed (`_sizeAt`). */
  private _sizes = new Map<number, { width: number; height: number }>();
  private _textPoints: number[] | null = null;
  /** Whether code points and code units are the same index — true unless
   *  the text carries surrogate pairs. null until checked. */
  private _pointsAreUnits: boolean | null = null;
  private _hovered: Element[] = [];
  /** Which element's widget holds the focus (`setFocus`). */
  private _focus: FocusState = NO_FOCUS;
  /** Where the pointer last moved to, in logical window pixels, while it
   *  is over the element (`defaultMouseMove`). */
  private _pointerAt: { x: number; y: number } | null = null;
  /** A hover held until the content under a still pointer stops moving:
   *  the timer, and when the content last moved (`_holdHover`). */
  private _heldHover: unknown = null;
  private _heldSince = 0;
  /** The document's timeline: when each element's animations started
   *  (`css/timeline.ts`). It outlives the cascades and the box trees. */
  private _timeline = new AnimationTimeline();
  /** The timer for the next frame of an animation, and when it is due. */
  private _frameTimer: unknown = null;
  private _frameAt = Infinity;
  /**
   * The elements the build of the boxes that is due has to style again,
   * where every change asking for it said which (`_invalidate`), and null
   * where any element's style may have changed — a new cascade, a viewport
   * a `vw` reads, a face that arrived.
   */
  private _restyleOnly: Set<Element> | null = null;
  private _scriptsSeen = new WeakSet<Element>();
  private _controls: ControlRect[] = [];
  /** The players mounted over the document (`media.ts`): where layout put
   *  each, in device pixels, before the boxes fixed to the viewport cut
   *  them; what `onMedia` was last told; and the elements they are over,
   *  for the paint. */
  private _mediaLaid: MediaRect[] = [];
  private _media: MediaRect[] = [];
  private _mounted: ReadonlySet<Element> = new Set();
  /** Each video's size once its player knows it, in CSS pixels: its
   *  intrinsic size from then on, where its poster's was (HTML 4.8.11.6). */
  private _videoSizes = new WeakMap<Element, IntrinsicSize>();
  /** The focusable areas last reported (`_reportStops`), and where the
   *  watched ones were. */
  private _stops: readonly FocusStop[] = [];
  private _watchedRects = new Map<Element, Rect | null>();
  private _widgets: ReadonlySet<Element> = new Set();
  private _widgetsOf: ControlRect[] | null = null;
  private _reportedDomRevision = -1;

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
    const ask = (request: ResourceRequest) =>
      this._props().onResource?.(request) ?? null;
    this._resources = new ResourceStore(
      ask,
      (what, layout) => {
        // A late stylesheet is a new cascade: its rules, what it imports,
        // the faces it declares. A late image changes intrinsic sizes, so
        // the box tree is what has to be rebuilt — not merely repainted —
        // where anything its size lays out asked for it; one only a
        // background, a border image or a mask paints changes no box, and
        // is painted (`_imagePainted`). Either arriving after first paint
        // is the ordinary case, not an error path: a host on a network
        // answers every request that way. A video's source changes no box:
        // a player goes over one. A sheet declined that late changes no
        // style either, but the first rendering may be held for it.
        if (what === 'video') this._reportMedia();
        else if (what === 'declined') {
          // nothing to restyle, but a first rendering may have waited on it
          if (!this._tree) this._invalidate(Stale.Style);
        } else if (what === 'image' && !layout) this._imagePainted();
        else
          this._invalidate(what === 'stylesheet' ? Stale.Style : Stale.Boxes);
      },
      this._urls,
    );
    this._images = new ImageSources({
      request: (url, element) =>
        this._resources.request({ url, kind: 'image', element }),
      state: (url) => this._resources.state(url),
    });
    this._webFonts = new WebFonts(
      app,
      ask,
      () => {
        // A face arrived: the family lists change, so the styles do, and
        // every text layout kept from before was set in the face it
        // replaces — under the same list, where a family of the document's
        // had loaded one weight and now has another.
        this._layouts = null;
        this._invalidate(Stale.Boxes);
      },
      'sans-serif',
    );
    this._read();
  }

  private _props(): HtmlViewProps {
    return this.props as unknown as HtmlViewProps;
  }

  // --- units ----------------------------------------------------------------
  //
  // The whole pipeline — the cascade's lengths, the box tree, the paint, the
  // walks the accessors run — works in **device pixels**, the unit `abs`,
  // `contentBox()`, the paint context and `paintDamage()` arrive in (core's
  // `docs/scale.md`). Three things cross into that unit and each converts
  // once, here:
  //
  //  - a CSS pixel: every `px` the author wrote, the UA sheet's, an image's
  //    own pixels, a `width="600"` attribute, the theme's font size and
  //    control chrome in `look`. `UnitContext.scale` and `_deviceLook()`
  //    multiply them on the way in;
  //  - a synthetic event's `x`/`y`, and so the public point queries
  //    (`elementAtPoint`, `hrefAtPoint`, `setHover`): logical, multiplied in
  //    `_toDocument`. The selection seam (`textIndexAt` and the two rect
  //    accessors) is core's device-pixel contract and stays device;
  //  - a control rect on its way out to `onControls`: divided, because it
  //    becomes a style.
  //
  // At 1x every conversion is the identity, which is how a view that
  // compared `ev.x` with `abs` and laid `16px` out as sixteen device pixels
  // passed every test and then hovered the wrong element and drew the
  // document at half size on a retina panel.

  /** Device pixels per logical pixel — the display scale this element's
   *  window resolved to, constant for the node's life. */
  private get _scale(): number {
    return this.scale > 0 ? this.scale : 1;
  }

  private _deviceLookFor: RootLook | null = null;
  private _deviceLookAt = 0;
  private _deviceLookValue: RootLook | null = null;

  /** The look with its lengths on the device grid: the theme's font size and
   *  the control chrome are logical pixels, and the cascade's initial style
   *  and `measureControl` want device ones. Memoized on the look's identity
   *  so the cascade and the control measurer see one object. */
  private _deviceLook(): RootLook {
    const look = this._props().look;
    const s = this._scale;
    if (
      this._deviceLookValue &&
      this._deviceLookFor === look &&
      this._deviceLookAt === s
    ) {
      return this._deviceLookValue;
    }
    const scaled =
      s === 1
        ? look
        : {
            ...look,
            fontSize: look.fontSize * s,
            controlPadY: look.controlPadY * s,
            controlBorder: look.controlBorder * s,
            controlRadius: look.controlRadius * s,
            controlFontSize: (look.controlFontSize ?? look.fontSize) * s,
            ...(look.focusRingWidth !== undefined && {
              focusRingWidth: look.focusRingWidth * s,
            }),
            ...(look.focusRingOffset !== undefined && {
              focusRingOffset: look.focusRingOffset * s,
            }),
          };
    this._deviceLookFor = look;
    this._deviceLookAt = s;
    this._deviceLookValue = scaled;
    return scaled;
  }

  // --- the pipeline ---------------------------------------------------------

  /**
   * `restyle` with `Stale.Boxes`: the elements whose styles the change
   * could have touched, where that is all of it — a pointer move's reach
   * (`_hoverReach`). The build it asks for keeps every other element's
   * (`_restyleOnly`).
   */
  private _invalidate(
    stale: Stale,
    restyle: ReadonlySet<Element> | null = null,
  ): void {
    if (stale >= Stale.Boxes) {
      const only = stale === Stale.Boxes ? restyle : null;
      if (this._stale < Stale.Boxes) {
        this._restyleOnly = only ? new Set(only) : null;
      } else if (this._restyleOnly && only) {
        for (const el of only) this._restyleOnly.add(el);
      } else {
        this._restyleOnly = null;
      }
    }
    if (stale > this._stale) this._stale = stale;
    if (stale >= Stale.Layout) this.invalidateMeasure('content');
    this.invalidate(stale >= Stale.Layout, this, 'props');
  }

  /** Take the props' source into the parser. Cheap when nothing changed, and
   *  an append when the new source extends the old — see `HtmlSource`. */
  private _read(): void {
    const props = this._props();
    const changed = this._source.setSource(
      props.source ?? '',
      props.complete !== false,
    );
    if (changed) {
      this._invalidate(Stale.Style);
      props.onDocument?.(this._source.document);
      this._reportedDomRevision = props.domRevision ?? 0;
    }
    this._updateBase();
    this._sweep();
  }

  /**
   * The document's base URL: its first `<base href>`, resolved against the
   * `baseUrl` prop, or the prop — and only an absolute one, since a relative
   * base resolves nothing. Everything resolved against the old one is
   * stale when it moves, the sheets' URLs with it, so the cascade is.
   */
  private _updateBase(): void {
    const given = this._props().baseUrl || null;
    const href = this._source.facts().base;
    let base = href ? resolveUrl(href, given) : given;
    if (base && !ABSOLUTE_URL.test(base)) base = null;
    if (this._urls.setBase(base)) this._invalidate(Stale.Style);
  }

  /**
   * Hand the document's own declarations to the host: every `<script>` once,
   * and every resource that has not been asked for.
   *
   * Scripts are **never parsed and never run**. The seam is the whole of the
   * feature: an application that wants scripting brings its own engine and
   * its own policy, and one that does not gets a document that cannot
   * surprise it. There is no configuration in between, because a renderer
   * that half-runs a script is a renderer nobody can reason about.
   */
  private _sweep(): void {
    const props = this._props();
    const facts = this._source.facts();
    if (props.onScript) {
      for (const el of facts.scripts) {
        if (this._scriptsSeen.has(el)) continue;
        // a chunk of a stream that ended inside it left it holding part of
        // its text: it is handed over once, whole, after its end tag
        if (this._source.isOpen(el)) continue;
        this._scriptsSeen.add(el);
        props.onScript({
          type: (attr(el, 'type') ?? 'text/javascript').toLowerCase(),
          src: attr(el, 'src') ?? null,
          text: textOf(el),
          element: el,
        });
      }
    }
    for (const el of facts.resources) {
      const tag = tagOf(el);
      const url = tag === 'link' ? attr(el, 'href') : imageUrlOf(el);
      if (!url) continue;
      this._resources.request({
        url,
        kind: tag === 'link' ? 'stylesheet' : 'image',
        element: el,
      });
    }
  }

  /**
   * Ask for every `background-image` the styles name. Known only once the
   * cascade has run, where an `<img>` is known from the markup; the store
   * asks once a URL, so a tree built again asks nothing new. An
   * `image-set()` is the option it chose for this element's scale, which
   * the cascade chose with the rest of the style (`imageSetOf`), and only
   * that one is asked for.
   */
  private _requestBackgrounds(tree: BoxTree): void {
    for (const box of tree.backgrounds) {
      // a pseudo-element's are its element's
      const element = box.el ?? GENERATED_FROM.get(box);
      if (!element) continue;
      // each layer's, where there is more than one
      // only painted, each of them: no box's size waits on one
      for (const image of box.style.backgroundImages ?? [
        box.style.backgroundImage,
      ]) {
        const url = urlOf(image);
        if (url !== null) {
          this._resources.request({ url, kind: 'image', element }, true);
        }
      }
      const border = urlOf(box.style.borderImage.source);
      if (border !== null) {
        this._resources.request(
          {
            url: border,
            kind: 'image',
            element,
          },
          true,
        );
      }
      // and each mask layer's, which is an image as a background's is
      for (const image of box.style.mask.images) {
        const url = urlOf(image);
        if (url !== null) {
          this._resources.request({ url, kind: 'image', element }, true);
        }
      }
    }
    // and every image generated content names, which is only known there
    // too
    for (const { url, element } of tree.contentImages) {
      this._resources.request({ url, kind: 'image', element });
    }
  }

  /**
   * An image arrived that only paints — a background, a border image, a
   * mask: no box is any other size for it, so the element is painted again
   * rather than built and laid out again, which each image a page decorates
   * its boxes with cost it, an arrival at a time over a network. What holds
   * a drawing made without it goes: the surfaces kept for boxes, and the
   * layers lifted from them, made again in a frame asked for, since a
   * lifted box's hole claims no damage.
   */
  private _imagePainted(): void {
    this._sprites?.clear();
    this._filtered?.staleAll();
    if (this._lifted.size) {
      this._spriteGen += 1;
      this.spritesChanged();
    }
    this.invalidate(false, this, 'content');
  }

  /** Whether an image generated content names arrived as it was asked for,
   *  the tree built without its size: a host that answers at once is told
   *  nothing later, where an `<img>` is asked for before the build. */
  private _contentImagesArrived(tree: BoxTree): boolean {
    for (const { url, sized } of tree.contentImages) {
      if (!sized && this._resources.imageSize(url)) return true;
    }
    return false;
  }

  /**
   * Ask the font matcher for the faces the document's text is set in, as
   * soon as its boxes say which and while its layout is still ahead. A face
   * nothing had warmed was a synchronous fc-match inside that layout: the
   * benchmark report's `th`, at 600, waited 38 ms before its first paint.
   * One child answers every face a call names, off the event loop (ntk's
   * `FontManager#prewarm`), and a layout reaching a face still on its way
   * takes the answer rather than asking again. Each face is asked once, by
   * the family, weight and style the layout hands the engine.
   */
  private _warmFaces(tree: BoxTree): void {
    const fonts = this._fonts() as WarmingFonts | null;
    if (typeof fonts?.prewarm !== 'function') return;
    if (this._warmedFor !== fonts) {
      this._warmedFor = fonts;
      this._warmedFaces.clear();
    }
    let faces: Map<string, { weight: number; style: string }[]> | null = null;
    for (const style of tree.textStyles) {
      const key = `${style.fontFamily}|${style.fontWeight}|${style.fontStyle}`;
      if (this._warmedFaces.has(key)) continue;
      this._warmedFaces.add(key);
      faces ??= new Map();
      let named = faces.get(style.fontFamily);
      if (!named) faces.set(style.fontFamily, (named = []));
      named.push({ weight: style.fontWeight, style: style.fontStyle });
    }
    if (faces)
      for (const [family, named] of faces) fonts.prewarm(family, named);
  }

  /**
   * What a tree's sheets are read from, in order: a `<style>`'s text or a
   * fetched `<link>`'s — each with the URL its own relative URLs resolve
   * against: the document's for a `<style>`, the sheet's own for a
   * `<link>`.
   */
  private _readSheets(refs: readonly SheetRef[]): SheetText[] {
    const props = this._props();
    const documentBase = this._urls.base;
    const read: SheetText[] = [];
    for (const ref of refs) {
      // A sheet handed over as bytes that names no encoding of its own is in
      // its referrer's: a `<link charset>`, then the document's (CSS 2.1
      // 4.4), and an import is in the encoding of the sheet importing it.
      const linked =
        ref.kind === 'inline'
          ? null
          : this._resources.stylesheet(ref.href, [
              attr(ref.element, 'charset') || undefined,
              props.charset,
            ]);
      const text = ref.kind === 'inline' ? ref.text : linked?.text;
      if (!text) continue;
      const encoding = linked ? linked.encoding : props.charset;
      const base =
        ref.kind === 'inline'
          ? documentBase
          : this._resources.sheetBase(ref.href);
      read.push({
        text,
        encoding,
        element: ref.element,
        base,
        media: ref.media,
      });
    }
    return read;
  }

  /**
   * How a tree's sheets read, as a key: the trees whose sheets read alike
   * share their rules (`Cascade.bindShadows`), and '' is none. Each text is
   * a number, the first time it is read and after: a page of a component's
   * cards has its sheet once a card, and the text is the same string each
   * scan, whose hash is kept, where a key of the texts themselves was a
   * string of all of them to hash again on every restyle.
   */
  private _sheetsKey(read: readonly SheetText[]): string {
    let key = '';
    for (const { text, encoding, base, media } of read) {
      let id = this._sheetIds.get(text);
      if (id === undefined) {
        id = this._sheetIds.size;
        this._sheetIds.set(text, id);
      }
      key += `${id}\u0001${encoding ?? ''}\u0001${base ?? ''}`;
      // what its `media` puts it under, by value, as `_sameSheets` asks
      if (media) key += `\u0001${JSON.stringify(media)}`;
      key += '\u0002';
    }
    return key;
  }

  /** Rebuild the cascade — the document's sheets plus the host's. */
  private _restyle(width: number): void {
    const props = this._props();
    const look = this._deviceLook();
    const facts = this._source.facts();
    // the document's sheets, and after them the host's
    const read = this._readSheets(facts.sheets);
    // Each shadow tree's, which style it alone (CSS Scoping 1, 3.2): the
    // trees whose sheets read alike — a component stamped out on every
    // card of a page — are one set of rules, parsed and indexed once.
    const shadowKeys = new Map<ShadowRoot, string>();
    const shadowRead = new Map<string, SheetText[]>();
    for (const { root, sheets } of facts.shadows) {
      const own = this._readSheets(sheets);
      const key = this._sheetsKey(own);
      shadowKeys.set(root, key);
      if (own.length && !shadowRead.has(key)) shadowRead.set(key, own);
    }
    const extra = props.stylesheet;
    const extras = Array.isArray(extra) ? extra : extra ? [extra] : [];
    const fonts = this._fonts();
    // Sheets that read as they did last time are the same rules: an append
    // to a streamed document, or a width across a `@media` breakpoint,
    // restyles the elements without parsing a framework's stylesheet again
    // or indexing its thousand rules again.
    const kept = this._sheetsRead;
    let faces: DeclaredFace[];
    if (
      kept &&
      kept.look === look &&
      kept.scale === this._scale &&
      kept.fonts === fonts &&
      this._sameSheets(kept, read, extras) &&
      this._sameShadows(kept, shadowRead)
    ) {
      this._cascade = kept.cascade;
      this._cascade.previous = this._previousStyle;
      kept.cascade.viewportWidth = width;
      kept.cascade.viewportHeight = this._viewportHeight();
      faces = kept.faces;
    } else {
      // the UA sheet's `px` are CSS pixels, which the cascade scales like an
      // author's, so it is written from the look in CSS pixels: from the
      // device one, a control's size and a button's chrome were doubled at 2x
      const sheets: Stylesheet[] = [uaStylesheet(props.look)];
      const imports: ImportRead[][] = [];
      faces = [];
      let order = 0;
      const layers = new Map<string, number>();
      // A sheet takes its place in the cascade's order once everything it
      // imports has taken theirs: `@import` is a resource like any other,
      // and an imported sheet's rules sit *before* the importing sheet's
      // (CSS 2.1 6.4.1), or an imported rule would win a tie against the
      // sheet importing it.
      const place = (sheet: Stylesheet, element: Element): void => {
        for (const rule of sheet.rules) rule.order = order++;
        order += 1;
        sheets.push(sheet);
        for (const rule of sheet.fontFaces) faces.push({ rule, element });
      };
      for (const { text, encoding, element, base, media } of read) {
        // a sheet under its `media` is under it as an imported one is
        // under its import's: each rule, each face and each import in it
        const under = media ? [media] : null;
        const sheet = parseStylesheet(text, 0, layers, base, under);
        const seen: ImportRead[] = [];
        this._placeImports(
          sheet,
          encoding,
          element,
          layers,
          seen,
          place,
          0,
          new Set(),
          under,
        );
        imports.push(seen);
        place(sheet, element);
      }
      for (const text of extras) {
        const sheet = parseStylesheet(text, order, layers);
        order += sheet.rules.length + 1;
        sheets.push(sheet);
      }
      // a shadow tree's in an order and layers of their own, read as the
      // document's are, imports and all; its `@font-face` rules are not
      // the document's fonts
      const shadows: ShadowSheets[] = [];
      const shadowImports = new Map<string, ImportRead[][]>();
      for (const [key, own] of shadowRead) {
        const tree: Stylesheet[] = [];
        const treeImports: ImportRead[][] = [];
        const treeLayers = new Map<string, number>();
        let treeOrder = 0;
        const placeInTree = (sheet: Stylesheet): void => {
          for (const rule of sheet.rules) rule.order = treeOrder++;
          treeOrder += 1;
          tree.push(sheet);
        };
        for (const { text, encoding, element, base, media } of own) {
          const under = media ? [media] : null;
          const sheet = parseStylesheet(text, 0, treeLayers, base, under);
          const seen: ImportRead[] = [];
          this._placeImports(
            sheet,
            encoding,
            element,
            treeLayers,
            seen,
            placeInTree,
            0,
            new Set(),
            under,
          );
          treeImports.push(seen);
          placeInTree(sheet);
        }
        shadows.push({ key, sheets: tree });
        shadowImports.set(key, treeImports);
      }
      this._cascade = new Cascade(
        sheets,
        look,
        width,
        this._viewportHeight(),
        this._scale,
        fonts ? (face) => xHeightOf(fonts, face) : null,
        fonts ? (face) => zeroWidthOf(fonts, face) : null,
        fonts ? (face) => normalLineOf(fonts, face) : null,
        faces.length ? this._webFonts : null,
        null,
        null,
        shadows,
      );
      this._cascade.previous = this._previousStyle;
      this._sheetsRead = {
        look,
        scale: this._scale,
        fonts,
        texts: read.map((r) => r.text),
        encodings: read.map((r) => r.encoding),
        bases: read.map((r) => r.base),
        media: read.map((r) => r.media),
        imports,
        extras,
        shadows: shadowImports,
        faces,
        cascade: this._cascade,
      };
    }
    // the trees as they are now, which a kept cascade was made for others of
    this._cascade.bindShadows(shadowKeys);
    // Set on a kept cascade as on a new one: a change of it is a restyle
    // over the sheets as they were parsed, as a width across a breakpoint is
    const reducedMotion = props.reducedMotion ?? false;
    this._cascade.reducedMotion = reducedMotion;
    // The faces this width and scheme declare: a `@font-face` may sit in a
    // `@media` block like any rule.
    const cssWidth = width / this._scale;
    const cssHeight = this._viewportHeight() / this._scale;
    this._webFonts.setFallback(look.fontFamily);
    this._webFonts.setFaces(
      faces.filter((f) =>
        mediaMatches(
          f.rule.media,
          cssWidth,
          look.colorScheme,
          cssHeight,
          this._scale,
          reducedMotion,
        ),
      ),
    );
    this._cascade.setPointer({
      hovered: new Set(this._hovered),
      active: EMPTY_SET,
    });
    this._cascade.setFocus(this._focus);
    this._mediaBand = this._cascade.mediaBand(width);
  }

  /**
   * Place what a sheet imports, and what each of those imports, depth
   * first — asking for each through the seam, as a parse of the sheet has
   * to. `seen` records every import read, in order, which is what tells the
   * next restyle whether the sheets read the same (`_sameSheets`). A sheet
   * that imports itself, or one of the sheets importing it, is read once.
   */
  private _placeImports(
    sheet: Stylesheet,
    encoding: string | undefined,
    element: Element,
    layers: Map<string, number>,
    seen: ImportRead[],
    place: (sheet: Stylesheet, element: Element) => void,
    depth = 0,
    chain: Set<string> = new Set(),
    /** The media queries `sheet` is itself under, where it was imported
     *  under some. */
    under: MediaCondition[][] | null = null,
  ): void {
    for (let i = 0; i < sheet.imports.length; i += 1) {
      const url = sheet.imports[i];
      // what it imports is under its import's media queries, and under
      // the ones the sheet importing it is under
      const conditions = sheet.importConditions[i];
      const media = conditions ? [...(under ?? []), conditions] : under;
      this._resources.request({ url, kind: 'stylesheet', element });
      const fetched = this._resources.stylesheet(url, [encoding]);
      const base = this._resources.sheetBase(url);
      seen.push({ url, text: fetched?.text ?? null, base });
      const key = base ?? url;
      if (!fetched || depth >= MAX_IMPORT_DEPTH || chain.has(key)) continue;
      const imported = parseStylesheet(fetched.text, 0, layers, base, media);
      chain.add(key);
      this._placeImports(
        imported,
        fetched.encoding,
        element,
        layers,
        seen,
        place,
        depth + 1,
        chain,
        media,
      );
      chain.delete(key);
      place(imported, element);
    }
  }

  /** Whether the sheets read the same as the ones `kept` was built from,
   *  down to what each imports — asking for the imports again, as a parse
   *  of the sheet would have. */
  private _sameSheets(
    kept: SheetsRead,
    read: SheetText[],
    extras: string[],
  ): boolean {
    if (read.length !== kept.texts.length) return false;
    if (extras.length !== kept.extras.length) return false;
    for (let i = 0; i < extras.length; i += 1) {
      if (extras[i] !== kept.extras[i]) return false;
    }
    for (let i = 0; i < read.length; i += 1) {
      const r = read[i];
      if (
        r.text !== kept.texts[i] ||
        r.encoding !== kept.encodings[i] ||
        r.base !== kept.bases[i] ||
        !sameValue(r.media, kept.media[i])
      ) {
        return false;
      }
      if (!this._sameImports(kept.imports[i], r)) return false;
    }
    return true;
  }

  /** Whether the shadow trees' sheets read as they did: the same sets,
   *  each importing the same. */
  private _sameShadows(
    kept: SheetsRead,
    shadows: ReadonlyMap<string, SheetText[]>,
  ): boolean {
    if (kept.shadows.size !== shadows.size) return false;
    for (const [key, own] of shadows) {
      const imports = kept.shadows.get(key);
      if (!imports) return false;
      for (let i = 0; i < own.length; i += 1) {
        if (!this._sameImports(imports[i], own[i])) return false;
      }
    }
    return true;
  }

  /**
   * Whether what a sheet imports reads as it did. The encodings an import
   * falls back to are its importer's, which only a parse knows; the text an
   * import decoded to under them is what was kept, and bytes that decode
   * differently now are a new sheet.
   */
  private _sameImports(imports: readonly ImportRead[], r: SheetText): boolean {
    for (const { url, text, base } of imports) {
      this._resources.request({
        url,
        kind: 'stylesheet',
        element: r.element,
      });
      const fetched = this._resources.stylesheet(url, [r.encoding]);
      if ((fetched?.text ?? null) !== text) return false;
      if (this._resources.sheetBase(url) !== base) return false;
    }
    return true;
  }

  /**
   * The viewport the document is seen through, in window coordinates: the
   * content box of the pane that scrolls the element, where one does —
   * what `position: fixed` and a fixed background are placed against, as
   * a browser places them against its page area. Null where nothing
   * scrolls it, and the element is its own.
   */
  private _viewport(): Rect | null {
    for (let node = this.parent; node; node = node.parent) {
      // `Scrollable`'s, and not every node's: asked the way core asks it
      const scroller = node as { isScroller?: () => boolean };
      if (!scroller.isScroller?.()) continue;
      const box = node.contentBox();
      return box.width > 0 && box.height > 0 ? box : null;
    }
    return null;
  }

  /**
   * What the document draws fixed to the viewport of the pane that scrolls
   * it, for that pane's scroll blit to repaint rather than copy with the
   * text (react-x11's `viewportFixedRects`): the whole viewport where a
   * fixed background shows through it, which makes a scroll a repaint, and
   * where each fixed box is drawn. Null for a document with neither, and
   * where nothing scrolls the element.
   */
  override viewportFixedRects(): Rect[] | null {
    const tree = this._tree;
    const viewport = tree && this._viewport();
    if (!tree || !viewport) return null;
    if (hasFixedBackground(tree)) return [viewport];
    const boxes = FIXED_BOXES.get(tree);
    if (!boxes) return null;
    // laid out against the viewport at the document's top, and drawn at the
    // viewport (`atViewport`)
    const out: Rect[] = [];
    for (const box of boxes) {
      if (!(box.boundsWidth > 0 && box.boundsHeight > 0)) continue;
      out.push({
        x: viewport.x + box.boundsX,
        y: viewport.y + box.boundsY,
        width: box.boundsWidth,
        height: box.boundsHeight,
      });
    }
    return out.length ? out : null;
  }

  private _viewportHeight(): number {
    // The viewport a `vh` resolves against is the one the document is seen
    // through, not the document — a document taller than it does not make
    // `100vh` taller with it. That is the box that scrolls the element,
    // where one does: a browser's page area, below its tab strip and its
    // toolbar, where `100vh` measured by the window put a page's footer the
    // toolbar's height below the fold. The window, where nothing scrolls it.
    for (let node = this.parent; node; node = node.parent) {
      // `Scrollable`'s, and not every node's: asked the way core asks it
      const scroller = node as { isScroller?: () => boolean };
      if (!scroller.isScroller?.()) continue;
      const height = node.contentBox().height;
      if (height > 0) return height;
      break;
    }
    const root = this.root;
    const height = root?.abs?.height;
    return height && height > 0 ? height : 600;
  }

  /** The engine this document lays text out with, and the one it is over:
   *  one object while the engine is, since caches are kept by it. */
  private _engine: { over: FontsLike; fonts: FontsLike } | null = null;

  private _fonts(): FontsLike | null {
    const fonts = (this.app as { fonts?: FontsLike } | null)?.fonts;
    if (!fonts) return null;
    // a face the engine cannot shape from costs its characters, not the
    // document (`shaping.ts`)
    const safe = shapingSafe(fonts);
    if (this._engine?.over !== safe) {
      // and a face of the document's is set at the weight and the width
      // its rule has for a style's (`axes.ts`)
      this._engine = { over: safe, fonts: fontAxes(safe, this._webFonts) };
    }
    return this._engine.fonts;
  }

  /** The text layouts the last pass made, for this one to reuse. */
  private _layouts: TextLayoutCache | null = null;

  /** The fonts a layout pass lays text out with: the engine's, through the
   *  layouts the pass before made (`TextLayoutCache`). */
  private _layoutFonts(): FontsLike | null {
    const fonts = this._fonts();
    if (!fonts) return null;
    if (this._layouts?.engine !== fonts)
      this._layouts = new TextLayoutCache(fonts);
    this._layouts.begin();
    return this._layouts.fonts;
  }

  /**
   * Bring the pipeline up to date for a width — or, where that throws, leave
   * the document blank. From a paint a throw is the application's end, for
   * a document it did not write: a stack a thousand nested elements run
   * down, or a limit of the text engine's or the server's that one more
   * document finds. Reported once for each thing that went wrong, and tried
   * again only when something changes, or the width does.
   */
  private _prepare(width: number): void {
    const target = Math.max(1, Math.floor(width));
    if (this._failedAt === target && this._stale === Stale.Nothing) return;
    try {
      this._update(target);
      this._failedAt = -1;
    } catch (error) {
      this._fail(error, target);
    }
  }

  /** The width the pipeline threw at, until something changes (`_prepare`). */
  private _failedAt = -1;
  private _failures: Set<string> | null = null;

  private _fail(error: unknown, width: number): void {
    this._tree = null;
    this._sprites?.clear();
    this._filtered?.staleAll();
    this._stale = Stale.Nothing;
    this._failedAt = width;
    this._laidOutWidth = -1;
    this._documentWidth = 0;
    this._documentHeight = 0;
    const message = String((error as { stack?: unknown })?.stack ?? error);
    this._failures ??= new Set();
    if (this._failures.has(message)) return;
    this._failures.add(message);
    const g = globalThis as {
      process?: { env?: Record<string, string | undefined> };
      console?: { error(message: string): void };
    };
    if (g.process?.env?.NODE_ENV === 'production') return;
    g.console?.error(
      '@react-x11/components: <Html> could not lay out or paint its ' +
        `document, and leaves it blank.\n${message}`,
    );
  }

  private _update(target: number): void {
    const props = this._props();
    if ((props.domRevision ?? 0) !== this._reportedDomRevision) {
      this._reportedDomRevision = props.domRevision ?? 0;
      this._source.touch();
      this._updateBase();
      this._sweep();
      if (this._stale < Stale.Style) this._stale = Stale.Style;
    }
    // A document that reads its viewport's height — a `vh`, a percentage
    // height on the root, a box placed against the initial containing block
    // — is laid out again when that height moves. One that reads none, which
    // is most, goes on skipping layout when the window only grew taller.
    const viewport = this._viewportHeight();
    const viewportMoved =
      viewport !== this._laidOutUnder && this._readsViewportHeight();
    // the sizes other widths came to were read from what just changed
    if (this._stale !== Stale.Nothing || viewportMoved) this._sizes.clear();
    if (
      this._stale === Stale.Nothing &&
      this._laidOutWidth === target &&
      !viewportMoved
    ) {
      return;
    }
    // Nothing but the viewport: the size core laid this element out at came
    // from a layout under the old one, and nothing else will tell it so.
    const onlyViewport =
      this._stale === Stale.Nothing && this._laidOutWidth === target;
    const wasWidth = this._documentWidth;
    const wasHeight = this._documentHeight;

    // the styles a build may keep (`_restyleOnly`), unless something
    // found below changes them all
    let restyleOnly = this._stale === Stale.Boxes ? this._restyleOnly : null;
    this._restyleOnly = null;
    // whether `restyleOnly` names only what a crossing reached, and
    // whether a crossing is what restyles (`_stopAt`)
    let follow = false;
    let crossing = false;
    if (this._stale >= Stale.Style || !this._cascade) {
      this._restyle(target);
      this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
      restyleOnly = null;
    } else if (this._cascade.mediaBand(target) !== this._mediaBand) {
      // A resize that crossed a `@media` breakpoint is the one resize that
      // does have to restyle. Knowing which resizes those are is why the
      // breakpoints are collected at parse time — and which elements, is
      // the rules it turns on and off: those they match are styled again,
      // and the elements under them where what they are computed from came
      // out other than it was (`Cascade.crossed`, `KeptStyles.follow`),
      // where every element was. A crossing they match nothing of styles
      // nothing.
      const reached = this._crossed(target);
      crossing = reached !== null;
      if (reached === null) {
        this._restyle(target);
        this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
        restyleOnly = null;
      } else {
        this._mediaBand = this._cascade.mediaBand(target);
        if (reached.size && this._stale < Stale.Boxes) {
          this._stale = Stale.Boxes;
          restyleOnly = reached;
          follow = true;
        } else if (reached.size && restyleOnly) {
          restyleOnly = new Set([...restyleOnly, ...reached]);
          follow = true;
        }
      }
    }

    // a first rendering waits for the stylesheets the head links to
    if (!this._tree && this._renderBlocked()) return;

    const cascade = this._cascade;
    if (!cascade) return;
    cascade.viewportWidth = target;
    cascade.viewportHeight = viewport;
    cascade.dimensionSource = this._dimensionSource;
    // An image chosen for this viewport (`_choose`) that shows another
    // candidate, or the same one at another density, is another size: the
    // boxes are built again, keeping every style but those of the images
    // whose `<source>` sizes them another way now (`dimensionSource`), as a
    // `vw` has them built again — and as for a `vw`, the sizes other widths
    // came to stand, since what a width chooses is the same each time it
    // is asked.
    const chose = this._choose(target, viewport);
    if (chose && (chose.shown || chose.restyle.length)) {
      if (this._stale < Stale.Boxes) {
        this._stale = Stale.Boxes;
        restyleOnly = new Set(chose.restyle);
      } else if (restyleOnly) {
        restyleOnly = new Set([...restyleOnly, ...chose.restyle]);
      }
    }
    // A `vw` or a `vh` is a number by the time a style holds it, so the
    // styles computed for another viewport are wrong for this one: built
    // again, where some style reads the side that moved. A document that
    // reads neither — most — goes on skipping the cascade on a resize.
    if (
      (cascade.readsViewportWidth && this._styledWidth !== target) ||
      (cascade.readsViewportHeight && this._styledHeight !== viewport)
    ) {
      if (this._stale < Stale.Boxes) this._stale = Stale.Boxes;
      restyleOnly = null;
    }

    // Built and laid out — and, where an image whose `sizes` is its own
    // laid-out width (`auto`) draws another candidate for the width it was
    // just laid out at, built again, keeping every style, for the size that
    // candidate has, and laid out again. Once: HTML's `contain: size` on
    // such an image (the UA sheet) lays it out the same whichever candidate
    // it holds, so the second layout leaves every width as the first did,
    // and the candidates picked again for them are the same.
    for (let pass = 0; ; pass += 1) {
      if (this._stale >= Stale.Boxes || !this._tree) {
        const look = this._deviceLook();
        // A build a pointer move asked for styles the elements the move
        // reached, and takes every other element's from the tree it replaces
        // (`Cascade.beginSharing`): the first build only, since a second is
        // one the first found a reason for — a face, an image's size.
        let kept: KeptStyles | null =
          restyleOnly && this._tree && this._styledWith === cascade
            ? {
                styles: this._tree.styles,
                restyle: this._withAnimated(restyleOnly, this._tree),
                follow,
                root: this._tree.root.style,
              }
            : null;
        const timeline = this._clockIn(cascade);
        const boxes = () =>
          buildBoxes(this._source.document, {
            cascade,
            kept,
            scale: this._scale,
            imageSize: (el) => this._videoSizes.get(el) ?? this._imageSize(el),
            urlSize: (url) => this._resources.imageSize(url),
            faceAscent: (style) => {
              const fonts = this._fonts();
              return fonts ? faceExtentOf(fonts, style).ascent : undefined;
            },
            faceExtent: (style) => {
              const fonts = this._fonts();
              return fonts ? faceExtentOf(fonts, style) : undefined;
            },
            controlSize: (el, kind, style) =>
              measureControl(el, kind, style, this._fonts(), look),
          });
        // a build that styles every element ends the animations of the ones
        // it does not reach: under `display: none`, or out of the document
        const build = () => {
          timeline?.beginPass(!kept);
          const tree = boxes();
          timeline?.endPass();
          return tree;
        };
        this._tree = build();
        kept = null;
        this._styledWith = cascade;
        this._styledWidth = target;
        this._styledHeight = viewport;
        this._requestBackgrounds(this._tree);
        let again = this._contentImagesArrived(this._tree);
        // the faces the styles just asked for, of the families the document
        // loads itself — which, answered at once, change the styles asking
        if (this._webFonts.request(this._tree.text)) {
          this._layouts = null;
          again = true;
        }
        if (again) this._tree = build();
        this._sprites?.clear();
        this._filtered?.staleAll();
        this._warmFaces(this._tree);
        this._textPoints = null;
        this._pointsAreUnits = null;
        this._laidOutWidth = -1;
      }

      const laysOut =
        !!this._tree &&
        (this._laidOutWidth !== target ||
          viewportMoved ||
          this._stale >= Stale.Layout);
      if (this._tree && laysOut) {
        const laidOutAt = this._laidOutWidth;
        if (crossing) this._crossedTree = this._tree;
        const result = layoutDocument(
          this._tree,
          this._layoutFonts(),
          target,
          viewport,
          this._scale,
          this._stopAt(target, viewportMoved, crossing),
        );
        // A tree a crossing built and laid out down to where the layout
        // stops: what it set aside was never laid out, and is no height
        // to guess the document's from, so it is as tall as it was.
        const fresh = result.partial && this._wholeTree !== this._tree;
        if (fresh) result.height = Math.max(result.height, wasHeight);
        this._partial = result.partial;
        if (result.partial) this._armSettle();
        else this._wholeTree = this._tree;
        // from when the layout is done: one that took long is no rest
        if (this._widthLaid !== -1 && this._widthLaid !== target) {
          this._widthMovedAt = resizeClock.now();
        }
        this._widthLaid = target;
        // The same boxes, somewhere else and another size — but for the
        // layout a restyle in place asks for where what it moved reached the
        // document's end, to learn its height: at the width and under the
        // viewport the boxes were laid out at, with nothing that layout reads
        // changed, they come out where they were, and the surfaces kept for
        // them still hold them. A small document whose card turns at its
        // foot is laid out every frame of the turn.
        if (target !== laidOutAt || viewportMoved) {
          this._sprites?.clear();
          this._filtered?.staleAll();
        }
        this._documentWidth = result.width;
        this._documentHeight = result.height;
        this._laidOutWidth = target;
        this._laidOutUnder = viewport;
        this._layoutReadsViewport = result.readsViewportHeight;
        this._sizes.delete(target);
        this._sizes.set(target, { width: result.width, height: result.height });
        if (this._sizes.size > SIZES_KEPT) {
          this._sizes.delete(this._sizes.keys().next().value!);
        }
        this._reportControls();
        this._reportMedia();
        this._reportStops();
      }
      if (
        pass > 0 ||
        !laysOut ||
        !this._tree ||
        !this._chooseLaidOut(this._tree)
      ) {
        break;
      }
      this._stale = Stale.Boxes;
      restyleOnly = new Set<Element>();
    }
    this._stale = Stale.Nothing;
    // Read after core's layout pass — the viewport is the box around this
    // one, whose new height only that pass decides — so it is a paint that
    // finds it moved, and the next frame that measures this element again.
    // Inside a measure the answer already is the new size.
    if (
      onlyViewport &&
      !this._measuring &&
      (this._documentWidth !== wasWidth || this._documentHeight !== wasHeight)
    ) {
      this.invalidateMeasure('content');
    }
    this._scheduleFrame();
  }

  /**
   * The elements a resize to `target` restyles, having crossed a breakpoint
   * (`Cascade.crossed`), or null where the whole document is: where the
   * boxes were not styled by this cascade at the band it is at, or a face
   * the document loads sits under a media query, which the width chooses as
   * it chooses a rule (`_restyle`).
   */
  private _crossed(target: number): Set<Element> | null {
    const cascade = this._cascade;
    if (!cascade || !this._tree || this._styledWith !== cascade) return null;
    if (cascade.mediaBand(cascade.viewportWidth) !== this._mediaBand) {
      return null;
    }
    if (this._sheetsRead?.faces.some((face) => face.rule.media)) return null;
    return cascade.crossed(
      cascade.viewportWidth,
      target,
      this._source.document,
    );
  }

  /**
   * Where a layout at `target` stops, in document coordinates, or nothing
   * for a layout of the whole document. A width that moves again within
   * `RESIZE_BURST_MS` of the last layout at another width is a window edge
   * being dragged, and each frame of the drag lays the document out only
   * down to a viewport past the one the pane shows: the rest keeps its
   * boxes as they were and its height (`setAside`), and is laid out at the
   * width the drag rests at, `RESIZE_SETTLE_MS` later (`_armSettle`). What
   * can be seen is laid out at every step, and Wikipedia's longest articles
   * reflow at the rate of their first screen. A width that jumps further
   * than a drag's step lays out the whole, so a width set once is exact at
   * once; so does anything else that lays out, a tree no layout has laid
   * out whole, a document of layers the presenter runs, and a document less
   * than two of those stops tall.
   */
  private _stopAt(
    target: number,
    viewportMoved: boolean,
    crossing: boolean,
  ): number | undefined {
    const was = this._widthLaid;
    if (was === -1 || was === target) return undefined;
    // a drag's first move is as small as the rest: the edge goes a few
    // pixels an event, and the layout of the whole document it waited for
    // was the drag catching at its start — where a width set once, a
    // window maximized or a sidebar shown, jumps, and is exact at once
    const small = Math.abs(target - was) <= DRAG_STEP_CSS_PX * this._scale;
    if (
      (!small && resizeClock.now() - this._widthMovedAt >= RESIZE_BURST_MS) ||
      viewportMoved ||
      this._lifted.size > 0
    ) {
      return undefined;
    }
    // Anything else stale lays out whole, and so does a tree no layout has
    // laid out whole — but for the band a drag crossed, and the tree it
    // built: a layout that stops measures what it sizes from all it holds
    // (`probeWhole`), so it needs none of a whole layout's sizes.
    if (
      !crossing &&
      (this._stale >= Stale.Layout ||
        (this._wholeTree !== this._tree && this._crossedTree !== this._tree))
    ) {
      return undefined;
    }
    const until = this._seenBottom() + this._viewportHeight();
    return until * 2 < this._documentHeight ? until : undefined;
  }

  /** How far down the document what can be seen of it reaches: the bottom
   *  of the pane that scrolls it, or of the window, less where the
   *  document starts. */
  private _seenBottom(): number {
    const viewport = this._viewport();
    const bottom = viewport
      ? viewport.y + viewport.height
      : (this.root?.abs?.height ?? 0);
    return Math.max(0, bottom - this.contentBox().y);
  }

  /** Lay the document out whole once the width has rested. */
  private _armSettle(): void {
    if (this._settleTimer !== null) resizeClock.disarm(this._settleTimer);
    this._settleTimer = resizeClock.arm(() => {
      this._settleTimer = null;
      if (this.destroyed || !this._partial) return;
      this._widthMovedAt = -Infinity;
      this._invalidate(Stale.Layout);
    }, RESIZE_SETTLE_MS);
  }

  /**
   * Whether the document's first rendering waits on a stylesheet: one its
   * head links to, under no media query that could leave it out, or one a
   * sheet imports, still on its way. A browser holds a page's first paint
   * until they are in (HTML, "render-blocking"). Built before then, the
   * document was built, laid out and painted in the user agent's styles —
   * its text set in fonts it never asked for — and built again as each one
   * arrived: the flash of unstyled content, and the first frame's work
   * twice. A sheet the host declined, or failed to fetch, holds nothing,
   * and once something is drawn a sheet arriving restyles it as before.
   */
  private _renderBlocked(): boolean {
    for (const ref of this._source.facts().sheets) {
      if (ref.kind !== 'link' || ref.media !== null) continue;
      if (inBody(ref.element)) continue;
      if (this._resources.state(ref.href) === 'pending') return true;
    }
    for (const imports of this._sheetsRead?.imports ?? []) {
      for (const read of imports) {
        if (read.text !== null) continue;
        if (this._resources.state(read.url) === 'pending') return true;
      }
    }
    return false;
  }

  /** Whether the document as laid out reads its viewport's height. */
  private _readsViewportHeight(): boolean {
    return (
      this._layoutReadsViewport ||
      this._cascade?.readsViewportHeight === true ||
      this._images.readsHeight
    );
  }

  /**
   * Choose a source for each `<img srcset>` and each `<img>` in a
   * `<picture>`, for the viewport the document is laid out in — `target`
   * and `viewport`, in device pixels — and this element's scale, which is
   * the density a candidate is chosen for (`srcset.ts`). Each is asked for
   * as it is chosen. Whether what any of them shows changed.
   *
   * The viewport is the document's, as a `@media` query's is: this
   * element's width. Core asks a document its height at widths it is
   * never drawn at — the old width in a resize, as well as the new — and
   * a choice is made at each, which is a request at most for an image that
   * is never shown, and only where that width chose another. What changed,
   * or null where nothing was chosen again.
   */
  private _choose(target: number, viewport: number): SourceChanges | null {
    const facts = this._source.facts();
    if (!facts.pictures.length) return null;
    const s = this._scale;
    const props = this._props();
    const scheme = props.look.colorScheme;
    const reducedMotion = props.reducedMotion ?? false;
    const key = `${target}|${viewport}|${s}|${scheme}|${reducedMotion}|${this._source.revision}`;
    if (key === this._choseIn) return null;
    this._choseIn = key;
    return this._images.choose(facts.pictures, {
      width: target / s,
      height: viewport / s,
      scale: s,
      scheme,
      reducedMotion,
      decodes: decodesImageType,
    });
  }

  /**
   * Pick the candidates of the images whose `sizes` is their laid-out
   * width (`auto`), for the content widths `tree` was just laid out at.
   * Whether what any of them draws changed.
   */
  private _chooseLaidOut(tree: BoxTree): boolean {
    const facts = this._source.facts();
    if (!facts.pictures.length) return false;
    const s = this._scale;
    return this._images.chooseLaidOut(facts.pictures, (el) => {
      const box = this._firstBoxesOf(tree).get(el);
      return box?.kind === 'replaced' ? box.contentWidth / s : null;
    });
  }

  /** The element whose `width` and `height` size an `<img>`, for the
   *  cascade (`Cascade.dimensionSource`). */
  private _dimensionSource = (img: Element): Element =>
    this._images.dimensionSource(img);

  /** Where an image element's image is: what an `<img>` that chooses its
   *  source shows of it (`_choose`), or what the element names. */
  private _imageUrl(el: Element): string | undefined {
    return choosesSource(el) ? this._images.shown(el)?.url : imageUrlOf(el);
  }

  /**
   * An image element's intrinsic size, in CSS pixels: its image's, over
   * the density it was chosen at — a `2x` candidate is half its pixels
   * across, and a `w` one as wide as its `sizes` — or null where it has
   * not arrived. An infinitely dense one, chosen for a `sizes` of 0, is no
   * size at all, as in a browser.
   */
  private _imageSize(el: Element): IntrinsicSize | null {
    if (!choosesSource(el)) {
      return this._resources.imageSize(imageUrlOf(el) ?? '');
    }
    const shown = this._images.shown(el);
    const size = shown && this._resources.imageSize(shown.url);
    return shown && size ? atDensity(size, shown.density) : null;
  }

  private _reportControls(): void {
    const tree = this._tree;
    const report = this._props().onControls;
    if (!tree || !report) return;
    // The boxes are device pixels; each rect becomes the style of a widget
    // mounted beside this element, and a style is logical.
    const s = this._scale;
    const rects = controlRectsOf(tree, s).map((r) =>
      s === 1
        ? r
        : {
            ...r,
            x: r.x / s,
            y: r.y / s,
            width: r.width / s,
            height: r.height / s,
            fontSize: r.fontSize / s,
            ...(r.clip && {
              clip: {
                x: r.clip.x / s,
                y: r.clip.y / s,
                width: r.clip.width / s,
                height: r.clip.height / s,
              },
            }),
            ...(r.bare && {
              bare: {
                ...r.bare,
                x: r.bare.x / s,
                y: r.bare.y / s,
                width: r.bare.width / s,
                height: r.bare.height / s,
                fontSize: r.bare.fontSize / s,
              },
            }),
          },
    );
    if (sameRects(rects, this._controls)) return;
    this._controls = rects;
    report(rects);
  }

  /**
   * The players a laid-out document mounts, to `onMedia` where they changed:
   * each `<video>` a sibling over the document can show, with the source
   * the host answered for it (`media.ts`).
   */
  private _reportMedia(): void {
    const tree = this._tree;
    if (!tree || !this._props().onMedia) return;
    this._mediaLaid = tree.media.length
      ? mediaRectsOf(tree, this._scale, (el) => this._videoOf(el))
      : [];
    const mounted = new Set(this._mediaLaid.map((r) => r.element));
    if (!sameElements(mounted, this._mounted)) {
      // the frame a video with no poster is drawn in goes, or comes back
      this._mounted = mounted;
      this.invalidate(false, this, 'content');
    }
    this._publishMedia();
  }

  /**
   * The players as they are now, to `onMedia` where they changed: cut by
   * the boxes fixed to the viewport where the scroll has them, and in
   * logical pixels. Asked again at each paint of a document that has both,
   * since a scroll moves one over the other and lays nothing out.
   */
  private _publishMedia(): void {
    const tree = this._tree;
    const report = this._props().onMedia;
    if (!tree || !report) return;
    const fixed = FIXED_BOXES.get(tree);
    const shift = fixed ? this._fixedShift() : null;
    const s = this._scale;
    const rects = this._mediaLaid.map((laid) => {
      let r = laid;
      if (fixed) {
        const shows = laid.clip ?? laid;
        const cut = cutByFixed(shows, fixed, shift);
        if (cut === 'hidden') r = { ...laid, hidden: true };
        else if (!sameClip(cut, shows)) r = { ...laid, clip: cut };
      }
      if (s === 1) return r;
      return {
        ...r,
        x: r.x / s,
        y: r.y / s,
        width: r.width / s,
        height: r.height / s,
        ...(r.radius !== undefined && { radius: r.radius / s }),
        ...(r.clipRadius !== undefined && { clipRadius: r.clipRadius / s }),
        ...(r.clip && {
          clip: {
            x: r.clip.x / s,
            y: r.clip.y / s,
            width: r.clip.width / s,
            height: r.clip.height / s,
          },
        }),
      };
    });
    if (sameMedia(rects, this._media)) return;
    this._media = rects;
    report(rects);
  }

  /** The source a `<video>` plays: the first of its sources the host
   *  answered and no player has failed on, each asked for in turn. Null
   *  while one ahead of it is still being answered, and where none is
   *  left. */
  private _videoOf(el: Element): { source: VideoSource; url: string } | null {
    for (const { url, type } of videoCandidates(el)) {
      if (this._resources.video(url) === undefined) {
        this._resources.requestVideo(url, type, el);
      }
      const answer = this._resources.video(url);
      if (answer === 'pending') return null;
      if (answer === undefined || answer === 'failed') continue;
      return { source: answer, url };
    }
    return null;
  }

  /**
   * A player knows the size of what it plays (`onLoadedMetadata`), in CSS
   * pixels: the video's intrinsic size from now on, as HTML has it, so a
   * box that sets neither side takes the video's and one that sets a side
   * takes its ratio.
   */
  mediaLoaded(element: Element, width: number, height: number): void {
    if (!(width > 0 && height > 0)) return;
    const was = this._videoSizes.get(element);
    if (was?.width === width && was.height === height) return;
    this._videoSizes.set(element, { width, height, ratio: width / height });
    this._invalidate(Stale.Boxes, EMPTY_SET);
  }

  /** A player could not play the source it was handed — a format it has no
   *  decoder for, a URL that did not answer, a display with no player: the
   *  next source's turn, and the poster where there is none. */
  mediaFailed(element: Element, url: string): void {
    this._resources.failVideo(url);
    if (this._videoSizes.delete(element))
      this._invalidate(Stale.Boxes, EMPTY_SET);
    else this._reportMedia();
  }

  /**
   * The focusable areas, and where the watched ones are, to `onFocusStops`
   * where either changed: an element with a box that is visible, not
   * `inert`, and — for a control — with a widget mounted for it, since the
   * widget is what takes the focus.
   */
  private _reportStops(): void {
    const tree = this._tree;
    const report = this._props().onFocusStops;
    if (!tree || !report) return;
    const { stops: all, boxes } = focusCandidates(tree);
    const widgets = this._widgetElements();
    // Asked after every restyle in place, a pointer's included, and the
    // answer is nearly always the last: compared as it is found, and a new
    // list made only where it is not.
    const was = this._stops;
    let stops: FocusStop[] | null = null;
    let n = 0;
    for (let i = 0; i < all.length; i += 1) {
      const stop = all[i];
      // a hidden element is no focusable area, as it takes no press
      if (boxes[i].style.visibility !== 'visible') continue;
      // a control whose widget is not mounted — no room, scaled to nothing
      // — has nothing to take the focus
      if (stop.widget && !widgets.has(stop.element)) continue;
      if (!stops) {
        const same = was[n];
        if (
          same?.element === stop.element &&
          same.tabbable === stop.tabbable &&
          same.widget === stop.widget
        ) {
          n += 1;
          continue;
        }
        stops = was.slice(0, n);
      }
      stops.push(stop);
      n += 1;
    }
    let changed = false;
    if (stops || n !== was.length) {
      this._stops = stops ?? was.slice(0, n);
      changed = true;
    }
    for (const el of this._props().watchStops ?? []) {
      const rect = this._rectOf(el);
      if (!sameRect(rect, this._watchedRects.get(el) ?? null)) changed = true;
      this._watchedRects.set(el, rect);
    }
    if (changed) report([...this._stops]);
  }

  /** The elements whose widgets are mounted, as last reported. */
  private _widgetElements(): ReadonlySet<Element> {
    const controls = this._controls;
    if (this._widgetsOf !== controls) {
      this._widgetsOf = controls;
      this._widgets = new Set(controls.map((rect) => rect.element));
    }
    return this._widgets;
  }

  // --- core's questions -----------------------------------------------------

  /**
   * The size the document comes to at the offered width.
   *
   * The element sizes to its content and the application scrolls it — a
   * `<box overflow="scroll">` around it, the same shape `<Markdown>` uses.
   * That keeps the form controls mounted beside it scrolling with it for
   * free, and core's scroller already blits. Virtualizing a document taller
   * than X11's 16-bit coordinate space is the phase-2 work; see the PRD.
   */
  override measureContent({ width }: MeasureConstraints): MeasuredSize {
    const offered = Number.isFinite(width) ? width : 800;
    this._measuring = true;
    let size: { width: number; height: number };
    try {
      size = this._sizeAt(offered);
    } finally {
      this._measuring = false;
    }
    // core takes finite numbers only, and throws on any other from the
    // layout — a document of lengths no clamp foresaw is none too tall
    const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
    return {
      width: wholePixels(Math.min(finite(size.width), offered)),
      height: wholePixels(finite(size.height)),
    };
  }

  /**
   * The size the document comes to at `width`.
   *
   * Core asks a leaf for its height at the width it was measured at as well
   * as at the one it has now (`probeHeightFloors`), to learn whether a
   * relayout changed what the leaf needs — so every frame of a resize asks
   * two widths, and the boxes hold one. Laying the document out at the old
   * width to answer, and then at the new one again for the pass after, was
   * three whole passes a frame. The size a width came to is kept instead,
   * and answers until anything a layout reads changes: the source, the
   * styles, a resource, the viewport height. Nothing but a size comes from
   * it — paint and the text accessors read the boxes, which are only ever
   * laid out for real (`_prepare`).
   */
  private _sizeAt(width: number): { width: number; height: number } {
    const target = Math.max(1, Math.floor(width));
    if (
      target !== this._laidOutWidth &&
      this._stale === Stale.Nothing &&
      (this._props().domRevision ?? 0) === this._reportedDomRevision &&
      (!this._readsViewportHeight() ||
        this._viewportHeight() === this._laidOutUnder)
    ) {
      const known = this._sizes.get(target);
      if (known) return known;
    }
    this._prepare(width);
    return { width: this._documentWidth, height: this._documentHeight };
  }

  override applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void {
    super.applyProps(nextProps, prevProps);
    const next = nextProps as unknown as HtmlViewProps;
    const prev = prevProps as unknown as HtmlViewProps;
    if (
      next.look !== prev.look ||
      next.stylesheet !== prev.stylesheet ||
      next.charset !== prev.charset ||
      // a page's `prefers-reduced-motion` rules hold or fail now, as its
      // `prefers-color-scheme` rules do when the palette changes
      (next.reducedMotion ?? false) !== (prev.reducedMotion ?? false)
    ) {
      this._invalidate(Stale.Style);
    } else if ((next.animate ?? true) !== (prev.animate ?? true)) {
      // animations let run again start again
      this._timeline = new AnimationTimeline();
      this._invalidate(Stale.Boxes);
    }
    if (next.source !== prev.source || next.complete !== prev.complete) {
      this._read();
    } else if ((next.domRevision ?? 0) !== (prev.domRevision ?? 0)) {
      this._invalidate(Stale.Style);
    } else if ((next.baseUrl ?? null) !== (prev.baseUrl ?? null)) {
      // the same document somewhere else: every URL in it is another one
      this._updateBase();
      this._sweep();
    }
    if (next.watchStops !== prev.watchStops) {
      // the rectangles watched from now on are the ones as they stand
      this._watchedRects = new Map(
        (next.watchStops ?? []).map((el) => [
          el,
          this._watchedRects.get(el) ?? this._rectOf(el),
        ]),
      );
    }
  }

  override destroySubtree(): void {
    this._dropHeldHover();
    if (this._settleTimer !== null) resizeClock.disarm(this._settleTimer);
    this._settleTimer = null;
    this._disarmFrame();
    this._resources.destroy();
    this._webFonts.destroy();
    this._source.destroy();
    this._shadowCache?.destroy();
    this._shadowCache = null;
    this._drawings?.destroy();
    this._drawings = null;
    this._drawnOnce.clear();
    this._tileBlocks?.destroy();
    this._tileBlocks = null;
    this._sprites?.clear();
    this._sprites = null;
    this._filtered?.clear();
    this._filtered = null;
    this._lifted.clear();
    this._liftedTargets.clear();
    this._offered.clear();
    this._sheetsRead = null;
    this._tree = null;
    this._cascade = null;
    super.destroySubtree();
  }

  // --- answering for our own text -------------------------------------------
  //
  // The four accessors from react-x11#291, over the whole document at once.
  // A single element answering for every paragraph is what makes a drag from
  // the first heading to the last table cell one contiguous selection with no
  // per-block plumbing — and it is only possible because the box tree already
  // gave every piece of text its slice of one index.
  //
  // Core counts in **code points**; the boxes count in code units, because
  // that is what ntk's run geometry speaks. The conversion is here, once.
  //
  // And core counts only the text a selection can take. The runs
  // `user-select: none` keeps out — generated content's, unless a rule
  // says otherwise (CSS UI 4, 6.1) — are not in what it is told the
  // document holds, so a copy, which is core's slice of that, leaves them
  // out as a browser's does, and a drag across one has nothing in it to
  // take (`_selectable`, `_inDocument`).

  override textContent(): string {
    const tree = this._tree;
    if (!tree) return '';
    return tree.unselectable.length ? selectableOf(tree).text : tree.text;
  }

  /** A document offset, in code units, as one of the text a selection can
   *  take: one inside a run it cannot take is where that run stands. */
  private _selectable(units: number): number {
    const tree = this._tree;
    if (!tree?.unselectable.length) return units;
    const gaps = tree.unselectable;
    const { before } = selectableOf(tree);
    // the last run that starts before the offset
    let lo = 0;
    let hi = before.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gaps[mid * 2] < units) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return units;
    const i = lo - 1;
    return units - before[i] - (Math.min(units, gaps[i * 2 + 1]) - gaps[i * 2]);
  }

  /** An offset of the text a selection can take, in code units, as the
   *  document's: past the runs it cannot take that stand there where
   *  `past`, as a range's start and a caret are, and before them where
   *  not, as a range's end is. */
  private _inDocument(units: number, past: boolean): number {
    const tree = this._tree;
    if (!tree?.unselectable.length) return units;
    const gaps = tree.unselectable;
    const { before } = selectableOf(tree);
    // the last run whose place in the selectable text is before the
    // offset, or at it where `past`
    let lo = 0;
    let hi = before.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const at = gaps[mid * 2] - before[mid];
      if (at < units || (past && at === units)) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return units;
    const i = lo - 1;
    return units + before[i] + gaps[i * 2 + 1] - gaps[i * 2];
  }

  /**
   * Whether the document's code-point and code-unit indices coincide.
   *
   * They differ only where the text carries surrogate pairs (code points
   * past U+FFFF — emoji, mostly), and the offsets table that converts
   * between them costs O(text): tens of milliseconds and a table entry per
   * character on a megabyte-scale document, rebuilt on every DOM change.
   * A regex scan answers "are there any" in a fraction of that, with no
   * allocation, so the common all-BMP document never builds the table.
   */
  private _identityIndex(): boolean {
    if (this._pointsAreUnits === null) {
      this._pointsAreUnits = !/[\uD800-\uDFFF]/.test(this.textContent());
    }
    return this._pointsAreUnits;
  }

  private _points(): number[] {
    if (!this._textPoints)
      this._textPoints = codeUnitOffsets(this.textContent());
    return this._textPoints;
  }

  private _toUnits(codePoint: number): number {
    if (this._identityIndex()) {
      return Math.max(0, Math.min(codePoint, this.textContent().length));
    }
    const offsets = this._points();
    const at = Math.max(0, Math.min(codePoint, offsets.length - 1));
    return offsets[at];
  }

  private _toPoints(codeUnit: number): number {
    if (this._identityIndex()) {
      return Math.max(0, Math.min(codeUnit, this.textContent().length));
    }
    return codePointAtOffset(this._points(), codeUnit);
  }

  override textIndexAt(x: number, y: number): number {
    this._followLifted();
    const tree = this._tree;
    if (!tree) return 0;
    // Core's contract: a device-pixel point, the same space the two rect
    // accessors below answer in.
    const local = { x: x - this.abs.x, y: y - this.abs.y };
    // What a press starts a selection in is what the pointer is over —
    // what was painted there last (`deepestAt`), the target of the press
    // (Pointer Events' topmost event target) — as every engine has it,
    // with no spec to say so: on text, the letter under the point; on a
    // box, the text in its flow nearest the point, or any text it holds,
    // or where it stands in the document where it holds none (Blink's
    // `HitTestResult::GetPosition`, Gecko's `GetContentOffsetsFromPoint`).
    // Nearest across the whole document, a paragraph a page drew over a
    // large faint word gave its press and its drag to the word: Zen Garden
    // 220's "Est. 2003", a fixed `::before`, stands behind its preamble.
    const shift = this._fixedShift();
    const hit = selectionHit(local);
    deepestAt(tree, local.x, local.y, undefined, shift, hit);
    let at: number | null;
    if (hit.text) {
      at = textOffsetAt(hit.text, hit.x, hit.y);
    } else {
      const box = hit.box ?? tree.root;
      const frame = { box, x: hit.x, y: hit.y, atViewport: hit.atViewport };
      const boxes = tree.textBoxes;
      at =
        nearestText(frame, shift, boxes, true) ??
        nearestText(frame, shift, boxes);
      if (at === null && box !== tree.root) at = textBefore(box);
    }
    if (at === null) return 0;
    return this._toPoints(this._selectable(at));
  }

  override textCaretRect(index: number): Rect | null {
    const tree = this._tree;
    if (!tree) return null;
    const units = this._inDocument(this._toUnits(index), true);
    const found = caretAt(tree.root, units, this._fixedShift());
    if (!found) return null;
    return {
      x: this.abs.x + found.x,
      y: this.abs.y + found.y,
      width: 0,
      height: found.height,
    };
  }

  override textRangeRects(start: number, end: number): Rect[] {
    const tree = this._tree;
    if (!tree) return [];
    const from = this._inDocument(this._toUnits(start), true);
    const to = this._inDocument(this._toUnits(end), false);
    if (to <= from) return [];
    const out: Rect[] = [];
    // the rows the highlight paints, over glyphs taller than their line,
    // and none over the text it leaves out
    const shift = this._fixedShift();
    for (const [a, b] of selectedPieces(from, to, tree.unselectable)) {
      collectBands(tree.root, a, b, this.abs.x, this.abs.y, out, true, shift);
    }
    return out;
  }

  // --- pointer --------------------------------------------------------------
  //
  // The three point queries take **logical** window pixels — what a synthetic
  // event's `x`/`y` carry and what `useLinkClicks` and an application's
  // handler hand over — and are the one place the two units meet on the way
  // in. `_toDocument` multiplies.

  /** The link under a logical window point, if any — resolved against the
   *  document's base where it has one. Not part of the selection seam: core
   *  deliberately left hover and `cursorAt` out of #291, so following a
   *  link stays this package's. */
  hrefAtPoint(x: number, y: number): string | null {
    const el = this.elementAtPoint(x, y);
    let node: Element | null = el;
    // up the flat tree: a link in a shadow tree around a slot is the link
    // of what is assigned to the slot
    while (node) {
      const href = this.hrefOf(node);
      if (href !== null) return href;
      node = flatParentOf(node);
    }
    return null;
  }

  /** The URL the document's relative URLs resolve against, or null where
   *  it has none (`_updateBase`). */
  get documentBase(): string | null {
    return this._urls.base;
  }

  /**
   * Where an element is, in document coordinates: logical pixels from this
   * element's top left, the space the scroll offset of a box around it is
   * in — so scrolling to a fragment is `scrollTo({ y: rect.y })`. A block's
   * border box. An inline element's fragments, from its first line to its
   * last, each across its text, the inline-blocks and inline boxes' edges
   * it holds, and its own padding and border where it starts or ends — its
   * border box across, as `getBoundingClientRect` is (CSSOM View 6.1) — and
   * as tall as its lines; or where its text would start when it has none,
   * as `<a name>` has none. Null for an element with no box — `display:
   * none`, or not in the document.
   */
  elementRect(element: Element): Rect | null {
    this._prepare(this.abs.width || 1);
    return this._rectOf(element);
  }

  /**
   * Where a focusable area is as the document was last laid out, as
   * `elementRect` measures it, without laying it out again: what a render
   * reads to place the box that takes the focus for it (`stops.ts`), which
   * `onFocusStops` renders again when the layout moves it.
   */
  stopRect(element: Element): Rect | null {
    return this._rectOf(element);
  }

  /** The link an element is — its `href`, resolved as a click on it is
   *  (`hrefAtPoint`) — or null where it is no link. */
  hrefOf(element: Element): string | null {
    const href = attr(element, 'href');
    const tag = tagOf(element);
    return href && (tag === 'a' || tag === 'area')
      ? this._urls.resolve(href)
      : null;
  }

  /**
   * A point on an element, in `elementRect`'s coordinates: the middle of
   * its first fragment — of the first line an inline element is on, where
   * the middle of its rectangle can be on no line of it — or of its box.
   * Where a click on it lands when the keyboard activates it (`stops.ts`),
   * so that a handler asking what is under the click finds it.
   */
  focusPoint(element: Element): { x: number; y: number } | null {
    const rect = this._rectOf(element, true);
    return rect
      ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      : null;
  }

  /** `elementRect`, in the layout there is — or its first fragment's. */
  private _rectOf(element: Element, first = false): Rect | null {
    const tree = this._tree;
    if (!tree) return null;
    // a focusable area's without a walk of the tree
    const box =
      CANDIDATES.get(tree)?.byElement.get(element) ??
      boxFor(tree.root, element);
    if (!box) return null;
    let rect: Rect | null = null;
    if (box.kind !== 'inline' && box.kind !== 'text') {
      rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    } else {
      const bands: Rect[] = [];
      const fonts = this._layouts?.fonts ?? null;
      // an inline box broken around the blocks in it is its pieces, a box
      // of the element's each (CSS 2.1 9.2.1.1), and its fragments are
      // theirs; and on the lines between them it has a fragment around each
      // block, across the box the block is in and as tall as its border
      // box, as a browser's has — Blink's block-in-inline, Gecko's split
      // inline's anonymous block. A list item made inline around a block
      // link measured as the empty edge after it
      for (const piece of piecesOf(tree.root, box)) {
        inlineBands(tree.root, piece, fonts, bands);
      }
      for (const block of (box.cut ? CUT_BLOCKS.get(box) : null) ?? []) {
        const around = block.parent;
        if (!around) continue;
        // from where clearance moved it down from, as Blink's line around
        // a block in an inline box starts there: the Zen Garden's 214
        // makes its content an inline box of floats and a footer that
        // clears them, and Chrome measures it from the floats' top
        const top = Math.min(block.y, CLEARED_FROM.get(block) ?? block.y);
        bands.push({
          x: around.contentX,
          y: top,
          width: around.contentWidth,
          height: block.y + block.height - top,
        });
      }
      if (first && bands.length) rect = bands[0];
      else for (const band of bands) rect = rect ? unionRect(rect, band) : band;
      if (!rect) {
        // on no line, where its block has none: text set at no size takes
        // no room and gets no box, and CSS puts it on lines of no height
        // at the block's top (9.4.2), as a browser measures it — nothing,
        // where the block's content starts. Where the text after it
        // starts was the next text that took room, elsewhere in the
        // document: the Zen Garden's 170 hides a heading at `font-size:
        // 0`, and an `<abbr>` in it measured as the end of the paragraph
        // above it
        let block = box.parent;
        while (block && block.kind === 'inline') block = block.parent;
        if (block && !block.lines?.length) {
          const rtl = block.style.direction === 'rtl';
          rect = {
            x: rtl ? block.contentX + block.contentWidth : block.contentX,
            y: block.contentY,
            width: 0,
            height: 0,
          };
        }
      }
      if (!rect) {
        // an empty subtree's range is `[0, 0)`, wherever it stands: where
        // its text would be is where the text after it starts
        const caret = caretAt(tree.root, textAfter(tree.root, box));
        if (!caret) return null;
        rect = { x: caret.x, y: caret.y, width: 0, height: caret.height };
      }
    }
    // where it is drawn: the rectangle around it, turned and scaled as the
    // boxes it is in are, and itself (`getBoundingClientRect`, CSSOM View)
    rect = throughTransforms(rect, box);
    const s = this._scale;
    return {
      x: rect.x / s,
      y: rect.y / s,
      width: rect.width / s,
      height: rect.height / s,
    };
  }

  /**
   * Whether a press at a logical window point may start a selection: not
   * on text or a box `user-select: none` keeps out of one, which a
   * `::before` and an `::after` are unless a rule says otherwise (CSS UI 4,
   * 6.1). The root turns such a press down, and the selection there was
   * stays, as Blink keeps it (`CanStartSelection`): a toolbar's button
   * pressed with a paragraph selected does not take the selection away.
   */
  startsSelectionAt(x: number, y: number): boolean {
    this._followLifted();
    const tree = this._tree;
    if (!tree) return true;
    const local = this._toDocument(x, y);
    const hit = selectionHit(local);
    deepestAt(tree, local.x, local.y, undefined, this._fixedShift(), hit);
    if (hit.text) return !withinRuns(tree.unselectable, hit.run);
    return hit.box?.style.userSelect !== 'none';
  }

  /** The deepest element whose box contains a logical window point. */
  elementAtPoint(x: number, y: number): Element | null {
    this._followLifted();
    const tree = this._tree;
    if (!tree) return null;
    const local = this._toDocument(x, y);
    return deepestAt(tree, local.x, local.y, undefined, this._fixedShift());
  }

  /** How far a box fixed to the viewport is drawn from where it was laid
   *  out, in the document's pixels: the scroll of the pane the element is
   *  in (`atViewport`). Null where nothing scrolls it. */
  private _fixedShift(): { x: number; y: number } | null {
    const tree = this._tree;
    const viewport = tree && FIXED_BOXES.has(tree) && this._viewport();
    if (!tree || !viewport) return null;
    return { x: viewport.x - this.abs.x, y: viewport.y - this.abs.y };
  }

  /**
   * The cursor for a point of this element's, in device pixels: what core
   * asks a drawn element as the pointer moves over it (`cursorAt`,
   * react-x11#757). The `cursor` the document's styles give what is under
   * it — a link's `pointer`, the user-agent sheet's — and where they say
   * nothing, text's I-beam over text and the arrow elsewhere, as a browser
   * shows them. The arrow is named rather than left to null: null lets
   * core fall through to the element's `defaultCursor`, which is the
   * I-beam on a selectable surface, and every `<Html>` is one.
   */
  override cursorAt(x: number, y: number): string | null {
    this._followLifted();
    const tree = this._tree;
    if (!tree) return null;
    const hit = { text: false };
    const el = deepestAt(
      tree,
      x - this.abs.x,
      y - this.abs.y,
      hit,
      this._fixedShift(),
    );
    const cursor = el ? tree.styles.get(el)?.style.cursor : null;
    // a keyword; a `url()` this cannot load falls back, as its list would
    if (cursor && cursor !== 'auto' && /^[a-z-]+$/.test(cursor)) return cursor;
    return hit.text ? 'text' : 'default';
  }

  /**
   * The pointer moved, to a logical window point. Returns true when the
   * cascade's answer could have changed, so the caller knows whether to
   * invalidate — which it only ever does for a document that actually
   * contains a `:hover` rule.
   */
  setHover(x: number, y: number): boolean {
    this._dropHeldHover();
    const cascade = this._cascade;
    if (!cascade || !cascade.hoverSensitive) return false;
    // the element under the pointer and every element around it in the
    // flat tree (Selectors 4, 9.2): a host and a slot are hovered over
    // what is drawn in them
    const chain: Element[] = [];
    let node = this.elementAtPoint(x, y);
    while (node) {
      chain.push(node);
      node = flatParentOf(node);
    }
    if (sameChain(chain, this._hovered)) return false;
    const was = this._hovered;
    this._hovered = chain;
    cascade.setPointer({ hovered: new Set(chain), active: EMPTY_SET });
    this._restyleHover(was, chain);
    return true;
  }

  clearHover(): boolean {
    this._dropHeldHover();
    if (!this._hovered.length) return false;
    const was = this._hovered;
    this._hovered = [];
    this._cascade?.setPointer({ hovered: new Set(), active: EMPTY_SET });
    this._restyleHover(was, []);
    return true;
  }

  /**
   * The hovered chain moved: nothing, where no rule that tests the pointer
   * names an element it moved over; a restyle where they are, where all it
   * changed is ink (`_hoverInPlace`); and otherwise the boxes built again,
   * with the styles of every element the move did not reach kept.
   */
  private _restyleHover(was: readonly Element[], now: readonly Element[]) {
    const cascade = this._cascade;
    const reach = this._hoverReach(was, now);
    if (reach !== null && cascade) {
      if (!reach.size) return;
      const before = { hovered: new Set(was), active: EMPTY_SET };
      const focus = this._focus;
      if (
        this._restyleInPlace(
          reach,
          (el) => cascade.pointerChanged(el, before, focus),
          cascade.hoverPseudo,
        )
      ) {
        // an animation the move started, or let go of, wants its frames
        this._scheduleFrame();
        return;
      }
    }
    this._invalidate(Stale.Boxes, reach);
  }

  /** The element whose widget holds the focus, or null (`setFocus`). */
  get focusedElement(): Element | null {
    return this._focus.element;
  }

  /**
   * The focus moved: `element`'s widget took it, or, given null, no widget
   * of this document holds it now — it went to something else in the
   * window, or nowhere. `visible` is whether it shows, `:focus-visible`,
   * which it always does in a text field. Restyles what `:focus` and its
   * kin reach as a hover does (`_restyleHover`), and returns whether the
   * cascade's answer could have changed.
   *
   * No element of a document takes the focus: a control's widget, mounted
   * beside it, does, and says so here. Only a text field's does, so far —
   * the widgets core draws as components keep their own focus to
   * themselves.
   */
  setFocus(element: Element | null, visible = true): boolean {
    const was = this._focus;
    if (was.element === element && (!element || was.visible === visible)) {
      return false;
    }
    // and every element around it in the flat tree (Selectors 4, 9.5)
    const within = new Set<Element>();
    for (let at: Element | null = element; at; at = flatParentOf(at)) {
      within.add(at);
    }
    const now: FocusState = element ? { element, visible, within } : NO_FOCUS;
    this._focus = now;
    const cascade = this._cascade;
    cascade?.setFocus(now);
    if (!cascade || !cascade.focusSensitive) return false;
    const reach = cascade.focusLocal
      ? this._stateReach(
          [...was.within],
          [...now.within],
          // one element, whose ring came or went
          was.element === element ? element : null,
          (el) => cascade.focusTouches(el),
          (el, into) => cascade.focusAnchors(el, into),
        )
      : null;
    if (reach !== null) {
      if (!reach.size) return true;
      const pointer = { hovered: new Set(this._hovered), active: EMPTY_SET };
      if (
        this._restyleInPlace(
          reach,
          (el) => cascade.pointerChanged(el, pointer, was),
          cascade.focusPseudo,
        )
      ) {
        this._scheduleFrame();
        return true;
      }
    }
    this._invalidate(Stale.Boxes, reach);
    return true;
  }

  /**
   * The elements whose styles a move of the hovered chain can change, or
   * null where that cannot be said (`Cascade.hoverLocal`).
   */
  private _hoverReach(
    was: readonly Element[],
    now: readonly Element[],
  ): Set<Element> | null {
    const cascade = this._cascade;
    if (!cascade || !cascade.hoverLocal) return null;
    return this._stateReach(
      was,
      now,
      null,
      (el) => cascade.hoverTouches(el),
      (el, into) => cascade.hoverAnchors(el, into),
    );
  }

  /**
   * The elements whose styles a move of the hovered chain can change, or
   * of the focus's chain.
   *
   * Only an element whose hover state flipped and that a compound testing
   * the pointer could match can change (`Cascade.hoverTouches`), with its
   * subtree, and its later siblings' where a sibling combinator is in play;
   * and the elements a `:has()` testing the pointer may flip, which are
   * around the ones that changed. A move between two paragraphs under
   * `a:hover` reaches nothing. The focus's the same way, its chain the
   * focused element and every element around it, and `also` one whose
   * state flipped though it is in both — the ring coming or going.
   */
  private _stateReach(
    was: readonly Element[],
    now: readonly Element[],
    also: Element | null,
    touches: (el: Element) => HoverTouch,
    anchors: (el: Element, into: Map<Element, HoverTouch>) => void,
  ): Set<Element> {
    const before = new Set(was);
    const after = new Set(now);
    const roots = new Map<Element, HoverTouch>();
    const flipped = (el: Element, other: Set<Element> | null): void => {
      if (other?.has(el)) return;
      const touch = touches(el);
      if (touch > (roots.get(el) ?? HOVER_UNTOUCHED)) roots.set(el, touch);
    };
    for (const el of was) flipped(el, after);
    for (const el of now) flipped(el, before);
    // the chains are ancestor chains, so the deepest that changed on each
    // side is where a `:has()` is looked for from
    const deepest = (chain: readonly Element[], other: Set<Element>) => {
      const el = chain[0];
      if (el && !other.has(el)) anchors(el, roots);
    };
    deepest(was, after);
    deepest(now, before);
    if (also) {
      flipped(also, null);
      anchors(also, roots);
    }

    // the roots' subtrees, which a descendant combinator reaches, and
    // what inherits from them, through a host's shadow tree and a slot's
    // assigned children; and their later siblings' too where a sibling
    // combinator follows the compound that tests the pointer
    const reach = new Set<Element>();
    const collect = (el: Element): void => {
      const stack: Element[] = [el];
      while (stack.length) {
        const at = stack.pop()!;
        if (reach.has(at)) continue;
        reach.add(at);
        for (const child of at.children)
          if (isElement(child)) stack.push(child);
        const flat = flatChildrenOf(at);
        if (flat !== at.children) {
          for (const child of flat) if (isElement(child)) stack.push(child);
        }
      }
    };
    for (const [root, touch] of roots) {
      collect(root);
      if (touch !== HOVER_FOLLOWED) continue;
      for (let s = root.nextSibling; s; s = s.nextSibling) {
        if (isElement(s)) collect(s);
      }
    }
    return reach;
  }

  /**
   * A pointer move restyled where it happened, when all it changed is ink.
   *
   * A move to another element is a change to the cascade, and the pipeline
   * answers one by building every box again and laying the document out:
   * 270 ms on X11 and twice that on Cocoa for a Wikipedia article, on every
   * link the pointer crossed. But the rules a page writes for `:hover`
   * nearly all change a colour, an underline, a background or a border's
   * colour — 77 of that article's 79 — and those move nothing. So:
   *
   *  - The elements the move reached (`_hoverReach`) are styled again from
   *    their parents — the ones a rule testing the pointer answers
   *    differently for, or whose parent's style changed; the rest, most of
   *    a hovered card or table row, have the styles they had
   *    (`Cascade.pointerChanged`). Where anything but ink differs
   *    (`PAINT_ONLY`), this is not the move to take.
   *  - The boxes take their new styles: an element's own, the text in it,
   *    the anonymous boxes the fix-up made around what is in it, and its
   *    `::before` and `::after`, styled again by their own rules. A box
   *    whose style is derived some other way — a marker, a first letter —
   *    is not one to restyle here. A control's is, and its widget is told
   *    (`_reportControls`), unless the page took to drawing the field or
   *    stopped.
   *  - Each layout of their text is made again from the runs it was made
   *    from (`TextLayoutCache.inputsOf`) with the new ink (`runFor`), where
   *    its geometry comes out the same.
   *
   * Everything is checked before anything is changed, and nothing is looked
   * at but the blocks the restyled elements are in (`_blocksOf`): a move
   * costs what it changed, in a document of any length. True where it was
   * restyled here, or had nothing to restyle; false where the boxes have to
   * be built again.
   *
   * A focus change is answered the same way (`setFocus`), and so is a
   * frame of an animation (`_frame`). `ownChanged` says of an element in
   * `reach` whether its own style may have: whether the rules that test
   * the pointer or the focus answer differently for it than they did, or
   * whether its animations run. `pseudoRules` is which pseudo-elements'
   * rules test the state that changed.
   */
  private _restyleInPlace(
    reach: ReadonlySet<Element>,
    ownChanged: (el: Element) => boolean,
    pseudoRules: 0 | 1 | 2,
  ): boolean {
    const cascade = this._cascade;
    const tree = this._tree;
    const layouts = this._layouts;
    if (!cascade || !tree || !layouts) return false;
    if (this._stale !== Stale.Nothing || this._laidOutWidth < 0) return false;
    if (reach.size > HOVER_RESTYLE_LIMIT) return false;
    // a first line's, a first letter's and a marker's styles are layout's
    if (pseudoRules === HOVER_PSEUDO_OTHER) return false;
    // what an animation restyled comes to at this moment's time
    this._clockIn(cascade);

    const flips = new Map<Element, boolean>();
    const flipped = (el: Element): boolean => {
      let flip = flips.get(el);
      if (flip === undefined) {
        flip = ownChanged(el);
        flips.set(el, flip);
      }
      return flip;
    };

    // styled again from their parents, a parent first
    const fresh = new Map<Element, ComputedStyle>();
    const changed = new Map<Element, ComputedStyle>();
    // the ones whose ink is what it was: only their custom properties
    // changed, which the elements under them read
    const quiet = new Set<Element>();
    let refused = false;
    // what changed beyond ink (`hoverChange`): how far some box's ink
    // reaches, the order its layer paints in, where one is
    let reaches = false;
    let reorders = false;
    const moving = new Set<Element>();
    /** The elements whose opacity changed, which an inline box's cannot
     *  here where blocks broke it: they took it (`FADED_BLOCKS`). */
    const fading = new Set<Element>();
    /** Whether a control's box was restyled: its widget is told. */
    let widgets = false;
    const styleOf = (el: Element): ComputedStyle | null => {
      const kept = tree.styles.get(el);
      if (!kept) return null;
      if (!reach.has(el)) return kept.style;
      const done = fresh.get(el);
      if (done) return done;
      // an element at the top of the document is styled from the box above
      // it all, as the builder styled it (`BoxBuilder.run`), and every
      // other from its parent in the flat tree, as the builder walks it
      const parent = flatParentOf(el);
      const parentStyle = parent ? styleOf(parent) : tree.root.style;
      if (!parentStyle) {
        refused = true;
        return null;
      }
      const parentWas = parent ? tree.styles.get(parent)!.style : parentStyle;
      let style = kept.style;
      if (parentStyle !== parentWas || flipped(el)) {
        const made = cascade.styleFor(el, parentStyle, kept.inFlex);
        const diff = hoverChange(kept.style, made);
        if (diff === false) refused = true;
        else if (diff) {
          style = made;
          changed.set(el, made);
          if (!diff.ink) quiet.add(el);
          if (diff.reach) reaches = true;
          if (diff.order) reorders = true;
          if (diff.move) moving.add(el);
          if (diff.fade) fading.add(el);
        }
      }
      fresh.set(el, style);
      return style;
    };
    for (const el of reach) {
      styleOf(el);
      if (refused) return false;
    }
    // The drawings the move reached. What the rules give the shapes in one
    // is no box's style (`BoxTree.shapeStyler`), so it is asked for again:
    // of a drawing whose own style changed — its colour, a custom property
    // — and of each where a rule that reaches into a drawing tests the
    // pointer, `a:hover svg path`. One with another answer is painted
    // again; one never painted has none yet, and asks when it is.
    const redrawn: [Box, ShapeStyles | null][] = [];
    if (tree.shapeStyler) {
      for (const el of reach) {
        if (tagOf(el) !== 'svg') continue;
        const style = fresh.get(el);
        if (!style) continue;
        if (!changed.has(el) && !cascade.shapesFollowPointer) continue;
        const box = this._firstBoxesOf(tree).get(el);
        const was = box && SHAPE_STYLES.get(box);
        if (!box || was === undefined) continue;
        const shapes = cascade.shapeStyles(el, style, tree.shapeCopies);
        if (shapes?.key !== was?.key) redrawn.push([box, shapes]);
      }
    }
    const redraw = (): Rect[] => {
      const inks: Rect[] = [];
      for (const [box, shapes] of redrawn) {
        SHAPE_STYLES.set(box, shapes);
        this._dropSprites(box, true);
        const ink = this._inkOf(box);
        if (ink) inks.push(ink);
      }
      return inks;
    };
    if (!changed.size && pseudoRules === HOVER_PSEUDO_NONE) {
      this._repaintInk(redraw());
      return true;
    }
    for (const el of changed.keys()) {
      const tag = tagOf(el);
      // their backgrounds are the canvas's
      if (tag === 'html' || tag === 'body') return false;
    }

    // The boxes, each under its parent: what a box takes depends on what
    // the box it is in took.
    const fonts = layouts.fonts;
    const blocks = this._blocksOf(
      tree,
      pseudoRules === HOVER_PSEUDO_NONE ? changed.keys() : reach,
    );
    const restyled: [Box, ComputedStyle][] = [];
    const next = new Map<Box, ComputedStyle>();
    /** The restyled boxes whose ink changed, to repaint. */
    const inked = new Set<Box>();
    /** Whether an inline box's opacity changed, which fades the text in it
     *  whoever's that text is (`textFade`). */
    let refaded = false;
    /** The `::before` and `::after` boxes found, by element: 1 and 2. */
    const generated = new Map<Element, number>();
    const redecorated: [Box, Box['decoration']][] = [];
    const walk: Box[] = blocks.slice();
    while (walk.length) {
      const box = walk.pop()!;
      for (const child of box.children) walk.push(child);
      const parent = box.parent;
      const above = parent ? next.get(parent) : undefined;
      let style: ComputedStyle | undefined;
      let ink = !!parent && inked.has(parent);
      if (box.kind === 'text' || box.kind === 'break') {
        // Text is set in the style of the box it is in — an element's, a
        // pseudo-element's — or of its element, where the fix-up put an
        // anonymous box around it.
        const el = box.el;
        if (parent && box.style === parent.style) style = above;
        else if (el && box.style === tree.styles.get(el)?.style) {
          style = changed.get(el);
          ink = !quiet.has(el);
        } else if (above || (el && changed.has(el))) return false;
      } else if (box.pseudo === 'before' || box.pseudo === 'after') {
        const from = GENERATED_FROM.get(box);
        if (!from) {
          // an inside marker, made of its item's style and its own rules
          if (above) return false;
          continue;
        }
        if (!reach.has(from)) continue;
        generated.set(
          from,
          (generated.get(from) ?? 0) | (box.pseudo === 'before' ? 1 : 2),
        );
        const inherits = fresh.get(from);
        const kept = tree.styles.get(from)?.style;
        if (!inherits || !kept) return false;
        if (inherits === kept && !flipped(from)) continue;
        // styled by its own rules over its element's style, as the builder
        // styled it, in its element's box
        if (!parent || parent.style !== kept || box.marker) return false;
        const made = cascade.pseudoStyleFor(from, box.pseudo, inherits);
        if (!made || made.display === 'none') return false;
        const diff = hoverChange(box.style, made);
        if (diff === false) return false;
        if (!diff) continue;
        if (diff.reach || diff.order || diff.move) return false;
        if (diff.fade && brokenAround(box)) return false;
        style = made;
        ink = diff.ink;
      } else if (box.pseudo) {
        // a first letter, styled from the box its letter is in
        if (above) return false;
      } else if (box.el) {
        const el = box.el;
        style = changed.get(el);
        if (!style) continue;
        const kept = tree.styles.get(el)!.style;
        // a style derived from the element's, or drawn from it somewhere
        // else. A widget mounted beside the document takes its look from
        // it, and is told again once it is restyled — unless the page took
        // to drawing the field, or stopped, which is another size of box.
        // An image, a drawing or a rule is drawn here, from its box, like
        // any.
        if (box.style !== kept) return false;
        if (box.marker) return false;
        if (WIDGETS.has(box.replaced)) {
          const kind = box.replaced!;
          if (styledField(kind, kept) !== styledField(kind, style)) {
            return false;
          }
          widgets = true;
        }
        if (moving.has(el) && !movable(box, kept, style)) return false;
        if (fading.has(el) && brokenAround(box)) return false;
        ink = !quiet.has(el);
      } else if (above) {
        // An anonymous box takes what its parent's style passes on
        // (`anonymousStyles`), so it takes that of the new one: the text of
        // a link made a flex row is in one, and takes the link's colour.
        if (GENERATED_FROM.has(box)) return false;
        const display = box.style.display;
        if (tree.anonymous(parent!.style, display) !== box.style) return false;
        style = tree.anonymous(above, display);
      }
      if (!style) continue;
      next.set(box, style);
      restyled.push([box, style]);
      // a lifted box's pixels are its layer's: its hole needs no repaint
      if (ink && !(this._lifted.size && this._insideLifted(box))) {
        inked.add(box);
      }
      if (box.kind === 'inline') {
        if (style.opacity !== box.style.opacity) refaded = true;
        const decoration = inlineDecoration(fonts, box, style);
        if ((decoration === null) !== (box.decoration === null)) {
          // a rounded box with a background is laid out with its edges
          if (style.borderRadius.some((r) => r !== 0)) return false;
        }
        if (decoration !== box.decoration) redecorated.push([box, decoration]);
      }
    }
    // a `::before` or an `::after` a rule that tests the pointer now gives
    // an element is a box to build
    if (pseudoRules !== HOVER_PSEUDO_NONE) {
      for (const el of reach) {
        if (!flipped(el)) continue;
        const style = fresh.get(el);
        if (!style) continue;
        const has = generated.get(el) ?? 0;
        for (const [which, bit] of GENERATED_BITS) {
          if (has & bit) continue;
          const made = cascade.pseudoStyleFor(el, which, style);
          if (made && made.display !== 'none') return false;
        }
      }
    }
    if (!restyled.length) {
      this._repaintInk(redraw());
      return true;
    }

    // the text: each layout holding a run of a restyled box's, made again
    // with its new ink, where it comes out the same shape
    const relaid = new Map<TextLayoutLike, TextLayoutLike | null>();
    const texts: LineText[] = [];
    if (inked.size) for (const block of blocks) walk.push(block);
    while (walk.length) {
      const box = walk.pop()!;
      for (const child of box.children) walk.push(child);
      if (!box.lines) continue;
      for (const line of box.lines) {
        for (const text of line.texts) {
          texts.push(text);
          if (relaid.has(text.layout)) continue;
          const again = reinked(text, layouts, next, refaded);
          if (again === false) return false;
          relaid.set(text.layout, again);
        }
      }
    }

    // what each box drew before, to be repainted with what it draws after
    const inks: Rect[] = [];
    for (const box of inked) {
      const ink = this._inkOf(box);
      if (ink) inks.push(ink);
    }

    // and only now, all of it
    const moved: [Box, ComputedStyle][] = [];
    const kept = !!this._sprites?.size || !!this._filtered?.size;
    let reoffer = false;
    for (const [box, style] of restyled) {
      const was = box.style;
      box.style = style;
      if (kept) this._restyledSprites(box, was, style);
      // a box turned into the plane or out of it is a still part to offer
      // or one no longer (`_tiltedBoxes`)
      if (outOfPlane(style) !== outOfPlane(was)) {
        tree.tilted ||= outOfPlane(style);
        this._tiltedKept = null;
      }
      // what a lifted box shows is its layer's to know: offered again, and
      // painted there, in a frame asked for since its hole claims none
      if (
        !this._followingLifted &&
        this._lifted.size &&
        this._insideLifted(box)
      ) {
        this._spriteGen += 1;
        reoffer = true;
      }
      if (box.el && moving.has(box.el) && box.kind !== 'text') {
        moved.push([box, was]);
      }
    }
    for (const [box, decoration] of redecorated) {
      // what is inside it keeps which boxes around it paint, and this is
      // one more or one fewer of them
      if ((decoration === null) !== (box.decoration === null)) {
        forgetDecoratedAncestors(box);
      }
      box.decoration = decoration;
    }
    for (const text of texts) {
      const again = relaid.get(text.layout);
      if (again) text.layout = again;
      // its runs' boxes may cast other shadows now, in another colour or
      // faded otherwise
      forgetCasts(text.spans);
    }
    for (const [el, style] of changed) {
      tree.styles.set(el, { style, inFlex: tree.styles.get(el)!.inFlex });
    }
    for (const ink of redraw()) inks.push(ink);
    // A box that moved moves what is in it, as layout moved it the first
    // time (`applyRelativeOffsets`), and a later layout moves it the same
    // way; where it reached the document's end, before or after, the
    // document's height may have changed with it, which only a layout says.
    let relayout = false;
    for (const [box, was] of moved) {
      const before = box.boundsY + box.boundsHeight;
      retranslate(box, was);
      tree.relative = true;
      if (before >= this._documentHeight) relayout = true;
    }
    // how far the boxes' ink reaches, and the order their layers paint in,
    // as layout leaves them (`layoutDocument`)
    if (reaches || reorders || moved.length) {
      computePaintBounds(tree.root, tree.movedInline);
      if (tree.negative) hoistNegative(tree.root);
      stackLayers(tree.root);
    }
    for (const [box] of moved) {
      if (box.boundsY + box.boundsHeight >= this._documentHeight) {
        relayout = true;
      }
    }
    if (moved.length || widgets) this._reportControls();
    // a player over what moved, faded or came over it
    if (tree.media.length) this._reportMedia();
    // which areas are visible, and where the watched ones are
    this._reportStops();
    if (reoffer) this.spritesChanged();
    // A lifted element only followed to where its layer has it changes no
    // height a reader sees: its own restyle, when it is given back, does.
    if (relayout && !this._followingLifted) {
      this._invalidate(Stale.Layout);
      return true;
    }
    for (const box of inked) {
      const ink = this._inkOf(box);
      if (ink) inks.push(ink);
    }
    this._repaintInk(inks);
    return true;
  }

  /** An element's first box in document order, for the tree it was asked
   *  of: made on the first move over a tree, which is one walk of it. */
  private _firstBoxes: { tree: BoxTree; of: Map<Element, Box> } | null = null;

  private _firstBoxesOf(tree: BoxTree): Map<Element, Box> {
    let index = this._firstBoxes;
    if (index?.tree !== tree) {
      const of = new Map<Element, Box>();
      const stack: Box[] = [tree.root];
      while (stack.length) {
        const box = stack.pop()!;
        if (box.el && !of.has(box.el)) of.set(box.el, box);
        for (let i = box.children.length - 1; i >= 0; i -= 1) {
          stack.push(box.children[i]);
        }
      }
      index = this._firstBoxes = { tree, of };
    }
    return index.of;
  }

  /**
   * The blocks a restyle of `changed` has to look in: for each element, the
   * box its text is set in the lines of — the nearest box around its first
   * that is not an inline one — which holds every box that takes its style
   * from it, the pieces a block in it broke it into among them
   * (`breakAround`). One that is inside another is left to it.
   */
  private _blocksOf(tree: BoxTree, changed: Iterable<Element>): Box[] {
    const first = this._firstBoxesOf(tree);
    const blocks = new Set<Box>();
    for (const el of changed) {
      let box: Box | null = first.get(el) ?? null;
      while (
        box?.parent &&
        (box.kind === 'inline' || box.kind === 'text' || box.kind === 'break')
      ) {
        box = box.parent;
      }
      if (box) blocks.add(box);
    }
    const out: Box[] = [];
    for (const block of blocks) {
      let inside = false;
      for (let at = block.parent; at && !inside; at = at.parent) {
        inside = blocks.has(at);
      }
      if (!inside) out.push(block);
    }
    return out;
  }

  /**
   * Where a box draws, in the document's coordinates as the element is
   * painted now: its ink (`inkOf`), moved by the scroll of the pane that
   * scrolls the element where the box is fixed to the viewport or in one
   * that is, since paint draws it where the viewport is (`atViewport`).
   * Where it was laid out is where a fixed box is drawn only at the
   * document's top: the frames of Zen Garden 215's turning starburst,
   * `position: fixed`, repainted where it had been laid out, and showed
   * only as a scroll repainted the viewport's fixed boxes.
   */
  private _inkOf(box: Box): Rect | null {
    const ink = inkOf(box);
    const shift = ink && this._fixedShift();
    if (!ink || !shift || !drawnAtViewport(box)) return ink;
    return { ...ink, x: ink.x + shift.x, y: ink.y + shift.y };
  }

  /**
   * Repaint the document where `inks` are, in its own coordinates: the ink
   * of the boxes a hover restyled, before and after. Past a handful of rects
   * the damage is one around them all, which is what core would make of
   * them anyway.
   */
  private _repaintInk(inks: Rect[]): void {
    if (!inks.length) return;
    const x = this.abs.x;
    const y = this.abs.y;
    const place = (r: Rect): Rect => ({
      x: Math.floor(x + r.x),
      y: Math.floor(y + r.y),
      width: Math.ceil(r.width) + 1,
      height: Math.ceil(r.height) + 1,
    });
    if (inks.length > 6) {
      let all = inks[0];
      for (const r of inks) all = unionRect(all, r);
      this.invalidate(false, place(all), 'props');
      return;
    }
    for (const r of inks) this.invalidate(false, place(r), 'props');
  }

  /**
   * Forget the surfaces kept for the boxes around `box`, and for `box`
   * itself where `self` (`paintSprite`): what it draws is not what they
   * hold.
   */
  private _dropSprites(box: Box, self: boolean): void {
    const sprites = this._sprites?.size ? this._sprites : null;
    const filtered = this._filtered?.size ? this._filtered : null;
    if (!sprites && !filtered) return;
    for (let at = self ? box : box.parent; at; at = at.parent) {
      sprites?.drop(at);
      filtered?.stale(at.el ?? at, at.pseudo ?? '');
    }
  }

  /**
   * A read of a filtered box's pixels arrived (`FilterStore`): the box is
   * painted again, from them, and what holds a drawing made without them
   * goes — the surfaces kept around it, the reads of a filter around it,
   * and the layer lifted around it, made again in a frame asked for, since
   * a lifted box's hole claims no damage.
   */
  private readonly _filterArrived = (of: object): void => {
    if (this.destroyed) return;
    const box = of as Box;
    this._dropSprites(box, false);
    if (this._lifted.size && this._insideLifted(box)) {
      this._spriteGen += 1;
      this.spritesChanged();
    }
    const ink = this._inkOf(box);
    if (ink) this._repaintInk([ink]);
  };

  /**
   * What a restyle of `box` from `was` to `now` leaves of the surfaces kept
   * for it and around it. A box that draws something else now leaves none
   * of them; one only turned, moved, faded or put in another place among
   * its layers leaves its own, which holds it unturned and unfaded, and
   * none around it. Text takes the style of the box it is set in, and
   * neither turns nor fades on its own: what that box's transform did is
   * the box's.
   */
  private _restyledSprites(
    box: Box,
    was: ComputedStyle,
    now: ComputedStyle,
  ): void {
    const sprites = this._sprites;
    const filtered = this._filtered;
    let kept = false;
    for (let at: Box | null = box; at && !kept; at = at.parent) {
      kept =
        !!sprites?.has(at) || !!filtered?.has(at.el ?? at, at.pseudo ?? '');
    }
    if (!kept) return;
    const change = spriteChange(was, now);
    if (change === SpriteChange.Drawn) this._dropSprites(box, true);
    else if (
      change === SpriteChange.Placed &&
      box.kind !== 'text' &&
      box.kind !== 'break'
    ) {
      this._dropSprites(box, false);
    }
  }

  // --- animations ----------------------------------------------------------
  //
  // An animation is a style that changes as time passes, so a frame of one
  // is a restyle of the elements it runs on, at the timeline's time — in
  // place where all it changed is what a hover may change there, which an
  // opacity, a colour, a visibility and a transform are (`hoverChange`), and
  // otherwise with the boxes built again around the other elements' kept
  // styles. Nothing ticks while nothing changes: the timeline says when the
  // next frame is due (`nextFrame`) — a frame away while one is under way,
  // the end of a delay before one starts, and never once each is over or
  // paused — and a timer waits for it.

  /** Whether the document's animations run (`animate`). */
  private _animating(): boolean {
    return this._props().animate !== false;
  }

  /** The cascade's styles computed at this moment on the timeline, or at
   *  rest where no animation runs; the timeline where one does. */
  private _clockIn(cascade: Cascade): AnimationTimeline | null {
    if (!this._animating()) {
      cascade.timeline = null;
      return null;
    }
    const timeline = this._timeline;
    timeline.now = animationClock.now();
    cascade.timeline = timeline;
    return timeline;
  }

  /**
   * The elements a frame of the document's animations restyles: each with
   * one under way, and what it holds where a property it animates is
   * inherited; and whether one is a `::before`'s or an `::after`'s, whose
   * box is restyled with its element's though the element's own style is
   * what it was. One whose style the tree does not hold — it is under
   * `display: none` now — has no animation.
   */
  private _animationReach(tree: BoxTree): {
    reach: Set<Element>;
    generated: boolean;
  } {
    const reach = new Set<Element>();
    let generated = false;
    if (!this._animating()) return { reach, generated };
    for (const { el, inherits, generated: pseudo } of this._timeline.live(
      this._skipLifted,
    )) {
      const element = el as Element;
      if (!tree.styles.has(element)) {
        this._timeline.drop(element, '');
        this._timeline.drop(element, 'before');
        this._timeline.drop(element, 'after');
        continue;
      }
      generated ||= pseudo;
      const stack: Element[] = [element];
      while (stack.length) {
        const at = stack.pop()!;
        if (reach.has(at)) continue;
        reach.add(at);
        if (!inherits) continue;
        for (const child of at.children)
          if (isElement(child)) stack.push(child);
      }
    }
    return { reach, generated };
  }

  /** The elements a build that keeps styles styles again, and every one an
   *  animation is under way on: a kept style is one at a time gone by. */
  private _withAnimated(
    restyle: ReadonlySet<Element>,
    tree: BoxTree,
  ): ReadonlySet<Element> {
    const animated = this._animationReach(tree).reach;
    if (!animated.size) return restyle;
    for (const el of restyle) animated.add(el);
    return animated;
  }

  /** A timer for the next frame an animation wants, where one does and no
   *  timer already waits for it. */
  private _scheduleFrame(): void {
    if (this.destroyed) return;
    // the surfaces kept for an animation that is over: a box drawn on one
    // keeps one from now on only where it is small enough to keep still
    this._sprites?.sweep((box) => {
      const el = (box as Box).el;
      return !!el && this._timeline.isLive(el);
    });
    const next = this._animating()
      ? this._timeline.nextFrame(this._skipLifted)
      : null;
    if (next === null) {
      this._disarmFrame();
      return;
    }
    if (this._frameTimer !== null && this._frameAt <= next) return;
    this._disarmFrame();
    this._frameAt = next;
    this._frameTimer = animationClock.arm(
      this._frame,
      Math.max(1, next - animationClock.now()),
    );
  }

  private _disarmFrame(): void {
    if (this._frameTimer === null) return;
    animationClock.disarm(this._frameTimer);
    this._frameTimer = null;
    this._frameAt = Infinity;
  }

  // --- sprites --------------------------------------------------------------
  //
  // react-x11's surface presenter on macOS runs an animation in the render
  // server where what it moves is on a layer of its own
  // (sidorares/react-x11#819), and a document hands it the elements whose
  // animation it can run (`src/html/sprites.ts` says which). The presenter
  // decides every frame which go on layers, and says so (`spritesLifted`):
  // each is a hole in the document from then on, and its animation is not
  // the document's clock's, so a frame of it costs nothing here. One given
  // back is restyled at once to where its animation has got to, and runs on
  // the clock again. Nothing else asks — X11, Wayland, a scene the presenter
  // refuses — and every animation there runs here, as it always has.

  /**
   * The elements whose CSS animation a presenter may run on a layer of its
   * own, and the `::before`s and `::after`s, as react-x11's
   * `Node.sprites()` takes them. Asked every frame,
   * after layout, by the presenter that lifts them. A part's frames are
   * sampled once and kept for as long as the document draws and lays it
   * out as it did; what is made each frame is where it is and the delay
   * from now.
   */
  override sprites(): DocumentSprite[] | null {
    this._offered.clear();
    if (this.destroyed) return null;
    const animating = this._animating();
    // no animation, and no box turned out of the plane in the tree this
    // frame paints, or one a build it owes may make
    if (!animating && this._stale === Stale.Nothing && !this._tree?.tilted) {
      return null;
    }
    // this frame paints after the presenter: a build it owes is built now,
    // so that the boxes offered are the ones it paints
    if (this._stale !== Stale.Nothing) this._prepare(this.abs.width || 1);
    const tree = this._tree;
    const cascade = this._cascade;
    if (!tree || !cascade) return null;
    const live = animating ? this._timeline.live() : [];
    const tilted = this._tiltedBoxes(tree);
    if (!live.length && !tilted.length) return null;
    const now = animationClock.now();
    // the pane that scrolls the element, whose viewport a box fixed to it
    // is drawn at
    const viewport = this._viewport();
    const host: SpriteHost = {
      tree,
      cascade,
      timeline: this._timeline,
      now,
      scale: this.scale,
      scrolls: viewport !== null,
      boxes: this._firstBoxesOf(tree),
      pseudoBox: (el, which) => this._pseudoBoxOf(tree, el, which),
      ended: (el, id) => this._endedSprites.get(el)?.has(id) ?? false,
    };
    const range = this.selectionRange;
    // what a part is painted from, but for the tree and its own animation
    // (`Lift.id`)
    const held = [
      this._spriteGen,
      this._laidOutWidth,
      range ? `${range.start}-${range.end}` : '',
      viewport ? 'scrolled' : '',
    ].join(':');
    // and what it is made from
    const stamp = `${serialOf(tree)}:${held}`;
    // The build since the frame before, where all it changed was laid out
    // apart (`_quietBuild`): a part that holds none of what changed, and is
    // inside none of it, paints what it painted, though every box is new —
    // Zen Garden 219's marquees build the document at every frame, beside
    // the panels on layers.
    const quiet =
      this._quietBuild?.after === serialOf(tree) ? this._quietBuild : null;
    // the lifts, an ancestor's ahead of its descendants': a part inside
    // another's box goes in that part's layer, and the presenter takes a
    // parent before the parts in it
    const lifts: Lift[] = [];
    for (const { el, targets } of live) {
      const element = el as Element;
      for (const name of targets) {
        if (name !== '' && name !== 'before' && name !== 'after') continue;
        // an element's and its pseudo-elements' alike: a `::before` is in
        // its element's box, so where both are offered it goes in the
        // element's layer, and its element's raster leaves it out
        const lift = liftOf(host, element, name);
        if (lift) lifts.push(lift);
      }
    }
    // and each box turned out of the plane and seen in a perspective that
    // no animation of its own is moving: still, and drawn by the render
    // server through its whole matrix (`stillLiftOf`)
    for (const box of tilted) {
      const lift = stillLiftOf(host, box);
      if (lift) lifts.push(lift);
    }
    if (lifts.length > 1) {
      const depths = new Map<Box, number>();
      for (const { box } of lifts) {
        let depth = 0;
        for (let at = box.parent; at; at = at.parent) depth += 1;
        depths.set(box, depth);
      }
      lifts.sort((a, b) => depths.get(a.box)! - depths.get(b.box)!);
    }
    // the parts made so far, by their boxes
    const madeBoxes = new Map<Box, Made>();
    const made: Made[] = [];
    let shift: { x: number; y: number } | null | undefined;
    const make = (lift: Lift): Made | null => {
      const { el: element, pseudo } = lift;
      // the nearest box around it that is a part's: its layer goes in that
      // one's, and the boxes between are all it is asked about
      let parent: Made | null = null;
      for (let at = lift.box.parent; at && !parent; at = at.parent) {
        parent = madeBoxes.get(at) ?? null;
      }
      const own = `${lift.id}` + (parent ? `|${parent.key}` : '');
      const stamped =
        `${stamp}|${own}` + (parent ? `:${serialOf(parent.part)}` : '');
      let offers = this._spriteOffers.get(element);
      if (!offers) this._spriteOffers.set(element, (offers = {}));
      let offer = offers[pseudo];
      if (offer?.stamp !== stamped) {
        const was = offer;
        const part = partOf(host, lift, was?.part, parent?.part ?? null);
        // the raster painted again, but where all that changed is the tree,
        // built again around it by a frame that changed nothing it holds
        const same =
          was?.part &&
          part &&
          was.held === `${held}|${own}` &&
          quiet !== null &&
          was.tree === quiet.before &&
          !repaints(quiet.roots, element);
        offer = {
          stamp: stamped,
          part,
          held: `${held}|${own}`,
          tree: serialOf(tree),
          version: same ? was.version : `${serialOf(lift.box)}:${stamped}`,
        };
        offers[pseudo] = offer;
      }
      if (!offer.part) return null;
      // a box fixed to the viewport the scroll has brought within its
      // reach: the document draws it this frame, under that box or over
      // it, as their order has it. One at the viewport keeps its place
      // against them, and is asked about them with the rest
      // (`coveredAfter`), and one inside another part goes where that part
      // does.
      if (offer.part.fixed.length && !offer.part.atViewport) {
        if (shift === undefined) shift = this._fixedShift();
        if (fixedWithin(offer.part, shift)) return null;
      }
      const entry: Made = {
        lift,
        key: this._spriteKeyOf(element, pseudo),
        part: offer.part,
        version: offer.version,
        parent,
        order: parent ? null : paintOrderOf(lift.box),
        kids: [],
      };
      if (!parent && !entry.order) return null; // nowhere in the paint order
      parent?.kids.push(entry);
      madeBoxes.set(lift.box, entry);
      made.push(entry);
      return entry;
    };
    for (const lift of lifts) make(lift);
    // What the document paints over a part turned out of the plane, made a
    // part of its own where it can be one, so that its layer stands over
    // the other's as it is painted over it (`overLiftOf`) — or the other
    // could go on no layer at all, and be drawn a tile at a time at every
    // paint: Zen Garden 219's preamble hangs over a corner of the tilted
    // sidebar. A browser gives a box a layer for the same reason. Only what
    // is over such a part, all of it or none, and no more than a few in
    // all: a layer is a raster to keep. A part in the plane the document
    // draws as cheaply as anything over it, and is left to it.
    let room = MAX_OVER_PARTS;
    for (const entry of made.slice()) {
      if (entry.parent || room === 0) continue;
      if (entry.part.transform.length !== 16) continue;
      const over = coverersAfter(
        entry.lift.box,
        entry.part.over,
        entry.part.fixedOver,
      );
      if (!over?.length) continue;
      const covers: Lift[] = [];
      // no layer of a raster larger than what shows the document
      const shown = viewport ?? this.abs;
      const most = shown.width * shown.height;
      for (const box of over) {
        if (madeBoxes.has(box)) continue;
        // one that holds a part already made is that part's to answer for
        const lift =
          box.boundsWidth * box.boundsHeight > most ||
          made.some((other) => holds(box, other.lift.box))
            ? null
            : overLiftOf(host, box);
        if (!lift) {
          covers.length = 0;
          break;
        }
        covers.push(lift);
      }
      if (!covers.length || covers.length > room) continue;
      for (const lift of covers) {
        if (!make(lift)) break;
        room -= 1;
      }
    }
    // What the document paints after a part, asked from the last painted
    // to the first: those it keeps are layers over the ones before them,
    // and the presenter takes the earlier ones off their layers in the
    // frame it turns a later one down (react-x11's `Node.sprites()`). One
    // inside another is asked with the parts outside it the same way, and
    // goes where its parent does.
    const tops = made
      .filter((entry) => !entry.parent)
      .sort((a, b) => byPaintOrder(b.order!, a.order!));
    const above = new Set<Box>();
    const kept: Made[] = [];
    for (const entry of tops) {
      if (coveredAfter(tree, entry.part, above)) continue;
      above.add(entry.lift.box);
      kept.push(entry);
    }
    kept.reverse();
    let options: PaintOptions | null = null;
    let out: DocumentSprite[] | null = null;
    // each top part in the order it is painted, and the parts inside it
    // after it — a parent ahead of what is in its layer
    const offer = (entry: Made): void => {
      const { lift, key, part, parent } = entry;
      if (parent && coveredAfter(tree, part, above)) return;
      this._offered.set(key, { el: lift.el, pseudo: lift.pseudo });
      const painted = (options ??= this._paintOptions(range, null));
      // from the viewport's corner, for one the document draws there
      const origin = part.atViewport && viewport ? viewport : this.abs;
      (out ??= []).push(
        describe(
          part,
          key,
          entry.version,
          origin.x,
          origin.y,
          now,
          (ctx, box, children) =>
            paintLiftedBox(
              ctx as PaintContext,
              tree,
              box,
              painted,
              this._holesOf(tree, children),
            ),
          parent?.key ?? null,
        ),
      );
      for (const kid of entry.kids) offer(kid);
    };
    for (const entry of kept) offer(entry);
    return out;
  }

  /**
   * Which of the offered elements are on layers now (react-x11's
   * `Node.spritesLifted`), before the frame paints: those are holes in the
   * document from here (`PaintOptions.lifted`), and their animations are
   * not the clock's. One given back is restyled where its animation has got
   * to, and back on the clock, in this frame.
   */
  override spritesLifted(keys: ReadonlySet<string>): void {
    const next = new Map<string, SpriteTarget>();
    for (const key of keys) {
      const target = this._lifted.get(key) ?? this._offered.get(key);
      if (target) next.set(key, target);
    }
    let dropped = false;
    for (const key of this._lifted.keys()) {
      if (!next.has(key)) dropped = true;
    }
    this._lifted = next;
    this._liftedTargets = new Map();
    for (const { el, pseudo } of next.values()) {
      let lifted = this._liftedTargets.get(el);
      if (!lifted) this._liftedTargets.set(el, (lifted = new Set()));
      lifted.add(pseudo);
    }
    this._liftedBoxCache = null;
    if (dropped) {
      this._disarmFrame();
      this._frame();
    } else {
      this._scheduleFrame();
    }
  }

  /**
   * The render server is done with an animation it ran for a sprite
   * (react-x11's `Node.spriteAnimationEnded`). One that ran out is over for
   * the document too: no longer offered, and the frame that asks hands the
   * element back to be drawn as the animation left it. One cut short — its
   * layer went — is the document's clock's again, which `spritesLifted`
   * sees to.
   */
  override spriteAnimationEnded(
    key: string,
    id: string,
    finished: boolean,
  ): void {
    if (!finished) return;
    const el = (this._lifted.get(key) ?? this._offered.get(key))?.el;
    if (!el) return;
    // `<the animation's id>|<property>`: the first is what `liftOf` asks
    const cut = id.lastIndexOf('|');
    const own = cut < 0 ? id : id.slice(0, cut);
    let ended = this._endedSprites.get(el);
    if (!ended) this._endedSprites.set(el, (ended = new Set()));
    ended.add(own);
    // asked only until the document's clock passes the same end, so the
    // oldest can go: a button hovered all day ends a transition each time
    if (ended.size > MAX_ENDED) ended.delete(ended.values().next().value!);
    // the frame that asks again
    this.spritesChanged();
  }

  /**
   * The lifted elements a point is about to be hit against, restyled to
   * where their animations have them now: their layers moved them, and the
   * document's own style of them stopped at the lift. Only those whose
   * animation moves them — a fade is hit where it is — and nothing is
   * repainted or offered again: their pixels are their layers', which
   * already show them there.
   */
  private _followLifted(): void {
    if (!this._lifted.size || this._followingLifted) return;
    let moving: Set<Element> | null = null;
    let generated = false;
    for (const { el, pseudo } of this._lifted.values()) {
      if (!this._spriteOffers.get(el)?.[pseudo]?.part?.lift.moves) continue;
      (moving ??= new Set()).add(el);
      generated ||= pseudo !== '';
    }
    if (!moving) return;
    this._followingLifted = true;
    try {
      // a pseudo-element's box is restyled with its element's
      this._restyleInPlace(
        moving,
        () => true,
        generated ? HOVER_PSEUDO_GENERATED : HOVER_PSEUDO_NONE,
      );
    } finally {
      this._followingLifted = false;
    }
  }

  /** The boxes `tree` turns out of the plane, an element's or a
   *  pseudo-element's: found by a walk, once a tree, and none where the
   *  build turned none (`BoxTree.tilted`). */
  private _tiltedBoxes(tree: BoxTree): readonly Box[] {
    if (!tree.tilted) return NO_BOXES;
    const kept = this._tiltedKept;
    if (kept?.tree === tree) return kept.boxes;
    const boxes: Box[] = [];
    const stack: Box[] = [tree.root];
    while (stack.length) {
      const at = stack.pop()!;
      for (const child of at.children) stack.push(child);
      if (outOfPlane(at.style)) boxes.push(at);
    }
    this._tiltedKept = { tree, boxes };
    return boxes;
  }

  private _spriteKeyOf(el: Element, pseudo: Pseudo): string {
    let keys = this._spriteKeys.get(el);
    if (!keys) this._spriteKeys.set(el, (keys = {}));
    return (keys[pseudo] ??= `html:${++this._spriteSeq}`);
  }

  /** An element's `::before` or `::after` box: a child of the element's
   *  first box, or of an anonymous box the fix-up made in it. */
  private _pseudoBoxOf(
    tree: BoxTree,
    el: Element,
    which: 'before' | 'after',
  ): Box | null {
    return generatedIn(this._firstBoxesOf(tree).get(el), el, which);
  }

  /** Whether a box is a lifted one, or inside one. */
  private _insideLifted(box: Box): boolean {
    const tree = this._tree;
    const lifted = tree && this._liftedBoxes(tree);
    if (!lifted) return false;
    for (let at: Box | null = box; at; at = at.parent) {
      if (lifted.has(at)) return true;
    }
    return false;
  }

  /** The boxes of the parts whose keys a presenter hands a part's paint,
   *  lifted inside it: holes in its raster. */
  private _holesOf(
    tree: BoxTree,
    keys: ReadonlySet<string> | undefined,
  ): ReadonlySet<Box> | null {
    if (!keys?.size) return null;
    const holes = new Set<Box>();
    const first = this._firstBoxesOf(tree);
    for (const key of keys) {
      const target = this._offered.get(key) ?? this._lifted.get(key);
      if (!target) continue;
      const box = target.pseudo
        ? this._pseudoBoxOf(tree, target.el, target.pseudo)
        : first.get(target.el);
      if (box) holes.add(box);
    }
    return holes;
  }

  /** The lifted boxes in `tree`, for the paint to leave out: each lifted
   *  element's, and each lifted pseudo-element's. */
  private _liftedBoxes(tree: BoxTree): ReadonlySet<Box> | null {
    if (!this._lifted.size) return null;
    const cache = this._liftedBoxCache;
    if (cache?.tree === tree && cache.lifted === this._lifted) {
      return cache.boxes;
    }
    const first = this._firstBoxesOf(tree);
    const boxes = new Set<Box>();
    for (const { el, pseudo } of this._lifted.values()) {
      const box = pseudo ? this._pseudoBoxOf(tree, el, pseudo) : first.get(el);
      if (box) boxes.add(box);
    }
    this._liftedBoxCache = { tree, lifted: this._lifted, boxes };
    return boxes;
  }

  /** A frame of the document's animations. */
  private readonly _frame = (): void => {
    this._frameTimer = null;
    this._frameAt = Infinity;
    if (this.destroyed || !this._animating()) return;
    const tree = this._tree;
    // a build is coming, and styles every animated element at its time
    if (!this._cascade || !tree || this._stale !== Stale.Nothing) return;
    const { reach, generated } = this._animationReach(tree);
    if (
      reach.size &&
      !this._restyleInPlace(
        reach,
        (el) => this._timeline.isLive(el),
        generated ? HOVER_PSEUDO_GENERATED : HOVER_PSEUDO_NONE,
      )
    ) {
      this._rebuildFrame(reach);
    }
    this._scheduleFrame();
  };

  /**
   * A frame that changed what layout reads: the boxes built again around
   * every other element's kept style and the document laid out, at once.
   * Where each element whose style changed is positioned out of the flow —
   * absolutely or fixed, before and after — or is inside one that is, it
   * is laid out apart from everything around it (CSS 2.1 9.6); and where
   * no other element's box moved and the document is the size it was,
   * what the frame changed is what those boxes drew before and draw now.
   * That is repainted, and anything else repaints the whole element. Zen
   * Garden 219's marquees and panels are all positioned so.
   */
  private _rebuildFrame(reach: ReadonlySet<Element>): void {
    const before = this._tree!;
    const width = this._laidOutWidth;
    const size = [this._documentWidth, this._documentHeight];
    const beforeBoxes = this._firstBoxesOf(before);
    this._stale = Stale.Boxes;
    this._restyleOnly = new Set(reach);
    this._prepare(width);
    const after = this._tree;
    const changes =
      after &&
      this._laidOutWidth === width &&
      this._documentWidth === size[0] &&
      this._documentHeight === size[1]
        ? this._changedOutOfFlow(before, beforeBoxes, after, reach)
        : null;
    if (changes) {
      this._quietBuild = {
        before: serialOf(before),
        after: serialOf(after!),
        roots: changes.map((change) => change.el),
      };
      // what a change on a layer, or in one, drew and draws is its layer's:
      // its hole needs no repaint, and the layer is moved or painted again
      // in a frame asked for
      let shown = changes;
      if (this._lifted.size) {
        shown = changes.filter(({ now }) => !now || !this._insideLifted(now));
        if (shown.length < changes.length) this.spritesChanged();
      }
      const inks: Rect[] = [];
      for (const { was, now } of shown) {
        for (const box of [was, now]) {
          const ink = box && this._inkOf(box);
          if (ink) inks.push(ink);
        }
      }
      this._repaintInk(inks);
      return;
    }
    this.invalidateMeasure('content');
    this.invalidate(true, this, 'props');
  }

  /**
   * What a tree built again changed, where all it changed is positioned out
   * of the flow: each element out of the flow whose style changed, and each
   * `::before` or `::after` of the elements the frame restyled (`reach`),
   * with the boxes it was drawn in and is. Null where an element or a
   * pseudo-element in the flow changed, or a box of one that did not moved.
   */
  private _changedOutOfFlow(
    before: BoxTree,
    beforeBoxes: ReadonlyMap<Element, Box>,
    after: BoxTree,
    reach: ReadonlySet<Element>,
  ): OutOfFlowChange[] | null {
    if (before.styles.size !== after.styles.size) return null;
    const changed: Element[] = [];
    const roots: Element[] = [];
    for (const [el, now] of after.styles) {
      const was = before.styles.get(el);
      if (!was) return null;
      if (was.style === now.style || sameValue(was.style, now.style)) continue;
      changed.push(el);
      if (outOfFlow(was.style) && outOfFlow(now.style)) roots.push(el);
    }
    // what is laid out with the roots, and moves with them
    const apart = new Set<Element>();
    for (const root of roots) {
      const stack: Element[] = [root];
      while (stack.length) {
        const at = stack.pop()!;
        if (apart.has(at)) continue;
        apart.add(at);
        for (const child of at.children) {
          if (isElement(child)) stack.push(child);
        }
      }
    }
    for (const el of changed) if (!apart.has(el)) return null;
    const afterBoxes = this._firstBoxesOf(after);
    for (const [el, box] of afterBoxes) {
      if (apart.has(el)) continue;
      const was = beforeBoxes.get(el);
      if (!was || !sameGeometry(was, box)) return null;
    }
    const changes: OutOfFlowChange[] = roots.map((el) => ({
      el,
      was: beforeBoxes.get(el) ?? null,
      now: afterBoxes.get(el) ?? null,
    }));
    // A pseudo-element has no element, so no style in `styles` to compare,
    // and its box is no element's: the rest found nothing of it, and a frame
    // that moved one alone repainted nothing. Zen Garden 215's robot rises
    // into the page as an `aside::after` fixed to the viewport, and was not
    // seen until a scroll repainted it.
    for (const el of reach) {
      for (const [which] of GENERATED_BITS) {
        const was = generatedIn(beforeBoxes.get(el), el, which);
        const now = generatedIn(afterBoxes.get(el), el, which);
        if (!was && !now) continue;
        if (!was || !now) return null;
        if (was.style === now.style || sameValue(was.style, now.style)) {
          continue;
        }
        if (!outOfFlow(was.style) || !outOfFlow(now.style)) return null;
        changes.push({ el, was, now });
      }
    }
    return changes;
  }

  /** The document, for an application that wants to read or change it. */
  get document(): Document {
    return this._source.document;
  }

  /**
   * An application changed the DOM under us. Restyles, re-lays-out and
   * repaints — everything but the parse, which nothing that happened to the
   * tree can invalidate.
   *
   * Explicit rather than observed: see `HtmlHandle.refresh`.
   */
  touchDocument(): void {
    this._source.touch();
    this._updateBase();
    this._sweep();
    this._invalidate(Stale.Style);
  }

  /** The document's `<title>`, when it had one. */
  get title(): string | null {
    return this._source.facts().title;
  }

  /** A logical window point in document (device) coordinates. */
  private _toDocument(x: number, y: number): { x: number; y: number } {
    const s = this._scale;
    return { x: x * s - this.abs.x, y: y * s - this.abs.y };
  }

  // --- pointer defaults -----------------------------------------------------
  //
  // `:hover` is wired at the element rather than through React: the cascade
  // already knows whether any rule in the document tests it, `setHover`
  // returns without work when none does, and a document that does use it
  // re-styles only when the hovered chain actually changed, and then only
  // the elements the change reached (`_restyleHover`).
  //
  // **A hover waits for a scroll to stop.** Core asks again what is under a
  // pointer that stayed where it was after every frame that laid out —
  // hover follows content, react-x11#793 — and says so with a move to the
  // point the pointer is already at. While a document scrolls that is every
  // frame, each with something else under the pointer: a restyle a frame
  // at best, and where a hover moves something, the boxes built again a
  // frame, which took a page scrolled under a parked pointer from 52 frames
  // a second to 4. A browser holds its hover until the scroll is over, for
  // the same reason; so does this, for `HOVER_REST_MS` after the content
  // last moved. What was hovered stays hovered as it scrolls away, as it
  // does there. A move of the pointer itself is answered at once.

  override defaultMouseMove(ev: X11MouseEvent): void {
    super.defaultMouseMove?.(ev);
    const at = this._pointerAt;
    if (at !== null && at.x === ev.x && at.y === ev.y) {
      this._holdHover();
      return;
    }
    this._pointerAt = { x: ev.x, y: ev.y };
    this.setHover(ev.x, ev.y);
  }

  override defaultMouseLeave(ev: X11MouseEvent): void {
    super.defaultMouseLeave?.(ev);
    this._pointerAt = null;
    this.clearHover();
  }

  /** The content moved under the pointer: the hover is asked for once it
   *  has been still for `HOVER_REST_MS`. One timer a wait, put off by
   *  being armed again when it finds the content moved since. */
  private _holdHover(): void {
    if (!this._cascade?.hoverSensitive) return;
    this._heldSince = hoverClock.now();
    if (this._heldHover !== null) return;
    const rest = (): void => {
      this._heldHover = null;
      const at = this._pointerAt;
      if (!at || this.destroyed) return;
      const left = this._heldSince + HOVER_REST_MS - hoverClock.now();
      if (left > 0) {
        this._heldHover = hoverClock.arm(rest, left);
        return;
      }
      this.setHover(at.x, at.y);
    };
    this._heldHover = hoverClock.arm(rest, HOVER_REST_MS);
  }

  private _dropHeldHover(): void {
    if (this._heldHover === null) return;
    hoverClock.disarm(this._heldHover);
    this._heldHover = null;
  }

  // --- paint ----------------------------------------------------------------

  override paint(ctx: Context2D): void {
    super.paint(ctx); // background, border, clip to `abs`
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree) return;
    // a scroll moves the boxes fixed to the viewport over the players and
    // lays nothing out: where they are is asked as it is painted
    if (this._mediaLaid.length && FIXED_BOXES.has(tree)) this._publishMedia();
    const range = this.selectionRange;
    // Culling against the damage is what makes an expose of a strip cost the
    // strip rather than the document. `paintDamage()` is null when the whole
    // window is being repainted — but "the whole window" still bounds the
    // paint, and the bound is load-bearing rather than an optimization: X
    // carries glyph positions as Int16, so a document taller than ±32767
    // *thrown to the server unculled* dies in the protocol encoder, not on
    // the screen. The window node's rect is the tightest thing always known.
    let damage = this.paintDamage();
    if (!damage) {
      const window = this.root?.abs;
      if (window && window.height > 0) {
        damage = { x: 0, y: 0, width: window.width, height: window.height };
      }
    }
    const promised = this._promisedOpaque;
    this._promisedOpaque = false;
    try {
      this._paint(ctx, tree, range, damage);
    } catch (error) {
      this._fail(error, this._laidOutWidth);
      // nothing under the element was filled: what it promised is the
      // window's ground, where it leaves the document blank
      if (promised) {
        ctx.fillStyle = this._props().look.background;
        ctx.fillRect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
      }
    }
  }

  /**
   * What the document covers with opaque pixels, for core to fill nothing
   * under it (`Node.opaqueRect`): the whole element, where its canvas is
   * opaque — painted first, over all of it (`opaqueCanvas`). A page with a
   * background of its own was drawn over the window's ground and the
   * background of every box around the element, each filled whole at
   * every repaint of the window: three fills of three or four megapixels
   * at each frame of a resize at 2x, the size of the page's own paint.
   * Asked before the paint, so the document is brought up to date first,
   * as the paint would, and a paint that throws fills what it promised
   * (`paint`).
   */
  override opaqueRect(): Rect | null {
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree || !opaqueCanvas(tree)) return null;
    this._promisedOpaque = true;
    return this.abs;
  }

  /** Whether the pass being painted was promised opaque (`opaqueRect`). */
  private _promisedOpaque = false;

  /** A surface for the painter to draw a masked element on, asked of the
   *  backend until it is found to have none. */
  private _surface(width: number, height: number): SurfaceLike | null {
    if (this._noSurface) return null;
    const surface = newSurface(this.app, width, height);
    if (!surface) this._noSurface = true;
    return surface;
  }

  /** The raster kept of an SVG image at a size (`_drawings`), made on its
   *  second drawing there; null on its first, and where none can be. */
  private _drawingKept(
    key: string,
    width: number,
    height: number,
    draw: (ctx: unknown) => void,
  ): SurfaceLike | null {
    const cache = (this._drawings ??= new SurfaceCache(this.app));
    if (!cache.has(key)) {
      if (!this._drawnOnce.has(key)) {
        // keys drawn once are cheap, and a long life of them is forgotten
        // wholesale
        if (this._drawnOnce.size >= 4096) this._drawnOnce.clear();
        this._drawnOnce.add(key);
        return null;
      }
      this._drawnOnce.delete(key);
    }
    return cache.get(key, width, height, draw);
  }

  private _paint(
    ctx: Context2D,
    tree: BoxTree,
    range: { start: number; end: number } | null,
    damage: { x: number; y: number; width: number; height: number } | null,
  ): void {
    paintDocument(ctx as PaintContext, tree, {
      ...this._paintOptions(range, damage),
      lifted: this._liftedBoxes(tree),
    });
  }

  /** What the document is painted with, but for the boxes a presenter has
   *  lifted: the same for the document and for a part on a layer of its
   *  own, which is painted where the document would paint it. */
  private _paintOptions(
    range: { start: number; end: number } | null,
    damage: { x: number; y: number; width: number; height: number } | null,
  ): PaintOptions {
    return {
      originX: this.abs.x,
      originY: this.abs.y,
      // the root's background covers the whole element, not only the
      // document: an element grown past its content is canvas too
      canvas: this.abs,
      viewport: this._viewport() ?? undefined,
      scale: this._scale,
      damage,
      selection: range
        ? {
            start: this._inDocument(this._toUnits(range.start), true),
            end: this._inDocument(this._toUnits(range.end), false),
            skip: this._tree?.unselectable,
          }
        : null,
      selectionColor: this.selectionColor,
      imageFor: (box) => {
        const url = box.el ? this._imageUrl(box.el) : CONTENT_IMAGES.get(box);
        return url === undefined ? null : this._resources.image(url);
      },
      mounted: this._mounted,
      backgroundImageFor: (url) => {
        const image = this._resources.image(url);
        const size = image ? this._resources.imageSize(url) : null;
        return image && size ? { image, ...size } : null;
      },
      surface: (width, height) => this._surface(width, height),
      tilesKept: (key, width, height, draw) =>
        (this._tileBlocks ??= new SurfaceCache(this.app)).get(
          key,
          width,
          height,
          draw as (ctx: unknown) => void,
        ),
      cached: (key, width, height, draw) =>
        (this._shadowCache ??= new SurfaceCache(this.app)).get(
          key,
          width,
          height,
          draw as (ctx: unknown) => void,
        ),
      drawingKept: (key, width, height, draw) =>
        this._drawingKept(key, width, height, draw as (ctx: unknown) => void),
      sprites: this._spriteSource,
      filters: (this._filtered ??= new FilterStore(
        this.app,
        this._filterArrived,
        undefined,
        undefined,
        animationClock,
      )),
    };
  }
}

const EMPTY_SET: ReadonlySet<Element> = new Set();

/** A number for an object, the same for as long as it lives: what a tree
 *  or a box is in a sprite's stamp and version. */
const SERIALS = new WeakMap<object, number>();
let serials = 0;
function serialOf(of: object): number {
  let n = SERIALS.get(of);
  if (n === undefined) SERIALS.set(of, (n = ++serials));
  return n;
}

/** Whether a tree has a background fixed to the viewport: an image a box
 *  names (`tree.backgrounds`), or the canvas's image or gradient — the
 *  root's, or the body's it paints, which the root box stands in for where
 *  the markup has neither element. */
function hasFixedBackground(tree: BoxTree): boolean {
  for (const box of tree.backgrounds) {
    if (box.style.backgroundAttachment === 'fixed') return true;
  }
  const root = tree.root;
  const body = root.children.find((child) => child.el?.name === 'body');
  for (const box of body ? [root, body] : [root]) {
    const style = box.style;
    if (
      style.backgroundAttachment === 'fixed' &&
      (style.backgroundImage ||
        style.backgroundImages ||
        style.backgroundGradient)
    ) {
      return true;
    }
  }
  return false;
}

/** A sheet as the restyle reads it: its text, the encoding it was decoded
 *  from, the element that brought it, and what its URLs resolve against. */
interface SheetText {
  text: string;
  encoding?: string;
  element: Element;
  base: string | null;
  /** What its `media` attribute puts it under (`SheetRef.media`). */
  media: MediaCondition[] | null;
}

/** One `@import` a sheet read, and what it read as. */
interface ImportRead {
  url: string;
  text: string | null;
  base: string | null;
}

/** What a cascade was built from, to tell whether the next would be the
 *  same one: the look, scale and fonts, each sheet's text, encoding, base
 *  and media, the texts of everything each imports, and the host's own —
 *  and the faces all of them declare. */
interface SheetsRead {
  look: RootLook;
  scale: number;
  fonts: unknown;
  texts: string[];
  encodings: (string | undefined)[];
  bases: (string | null)[];
  /** Compared by value: the document's facts, and so each list, are made
   *  again at every revision, a streamed append's too. */
  media: (MediaCondition[] | null)[];
  imports: ImportRead[][];
  extras: string[];
  /** Each set of shadow trees' sheets, by how they read (`_sheetsKey`), and
   *  what each of its sheets imports. */
  shadows: ReadonlyMap<string, ImportRead[][]>;
  faces: DeclaredFace[];
  cascade: Cascade;
}

/** What the parser keeps in a head: anything else, or text, starts the
 *  body (HTML, "in head" insertion mode). */
const HEAD_CONTENT = new Set([
  'html',
  'head',
  'title',
  'meta',
  'link',
  'style',
  'script',
  'base',
  'noscript',
  'template',
]);

/**
 * Whether an element is in the document's `<body>`, where a stylesheet
 * linked to holds no rendering (`_renderBlocked`): inside one written, or,
 * where none is, after the first thing no head holds, where the parser
 * starts one — a fragment's `<link>` after its first paragraph.
 */
function inBody(element: Element): boolean {
  for (let at = element.parent; at; at = at.parent) {
    if (isElement(at) && tagOf(at) === 'body') return true;
  }
  for (let at: ChildNode | null = element; at; at = at.parent as ChildNode) {
    for (let prev = at.prev; prev; prev = prev.prev) {
      if (
        isElement(prev)
          ? !HEAD_CONTENT.has(tagOf(prev))
          : isText(prev) && /\S/.test(prev.data)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** The first box an element made, depth first. */
function boxFor(root: Box, element: Element): Box | null {
  const stack: Box[] = [root];
  while (stack.length) {
    const box = stack.pop()!;
    if (box.el === element) return box;
    for (let i = box.children.length - 1; i >= 0; i -= 1) {
      stack.push(box.children[i]);
    }
  }
  return null;
}

/**
 * An inline element's boxes: the one it has, or where a block in it broke
 * it (`breakAround`), each piece, in document order.
 */
function piecesOf(root: Box, first: Box): Box[] {
  // the first piece is cut at its end where there are more
  if (first.kind !== 'inline' || !(first.cut & 2)) return [first];
  const pieces: Box[] = [];
  const stack: Box[] = [root];
  while (stack.length) {
    const box = stack.pop()!;
    if (box.el === first.el && box.kind === 'inline') pieces.push(box);
    for (let i = box.children.length - 1; i >= 0; i -= 1) {
      stack.push(box.children[i]);
    }
  }
  return pieces;
}

/**
 * The bands of one inline box's fragments, or a text's: on the lines of
 * the block it is laid out in, and no text of a float or a positioned box
 * inside it — on lines of their own — is one of them (CSSOM View 6.1): a
 * list item made inline around an absolute link measured as the link.
 * Each across its text, the inline-blocks and inline boxes' edges it holds
 * and its own padding and border where it starts or ends there, and as
 * tall as its border box.
 */
function inlineBands(
  root: Box,
  box: Box,
  fonts: FontsLike | null,
  out: Rect[],
): void {
  // its own, apart from any other piece's: `fragmentHeights` makes each of
  // the bands it is handed as tall as this box on that band's line
  const bands: Rect[] = [];
  let block: Box | null = box.parent;
  while (block && !block.lines) block = block.parent;
  if (box.subtreeTextEnd > box.subtreeTextStart) {
    if (box.kind === 'inline' && block?.lines) {
      lineBands(
        block.lines,
        box.subtreeTextStart,
        box.subtreeTextEnd,
        0,
        0,
        bands,
        true,
      );
    } else {
      collectBands(root, box.subtreeTextStart, box.subtreeTextEnd, 0, 0, bands);
    }
  }
  if (box.kind === 'inline') {
    fragmentReach(box, bands);
    if (fonts) fragmentHeights(box, bands, fonts);
    // where `position: relative` on it or an inline box around it moved
    // it, all of it (CSS 2.1 9.4.3), as `getBoundingClientRect` has it
    // (CSSOM View 6.1): the bands are where the lines put it, and a link
    // moved 120px down measured on its line, as wide as from where it was
    // laid out to where it was drawn
    const { x, y } = relativeOffsetOf(box);
    if (x || y) {
      for (const band of bands) {
        band.x += x;
        band.y += y;
      }
    }
  }
  out.push(...bands);
}

/** How far an inline box and the inline boxes around it moved it by their
 *  relative offsets (`INLINE_OFFSETS`). */
function relativeOffsetOf(box: Box): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let at: Box | null = box; at?.kind === 'inline'; at = at.parent) {
    const offset = INLINE_OFFSETS.get(at);
    if (offset) {
      x += offset.x;
      y += offset.y;
    }
  }
  return { x, y };
}

/** Whether a document offset is inside one of a list of runs: sorted,
 *  disjoint `[start, end)` pairs, flat (`BoxTree.unselectable`). */
function withinRuns(runs: readonly number[], at: number): boolean {
  let lo = 0;
  let hi = runs.length >> 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid * 2 + 1] <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo < runs.length >> 1 && runs[lo * 2] <= at;
}

/** The text a selection can take, and how many code units of the text it
 *  cannot take stand before each run of that (`BoxTree.unselectable`). */
function selectableOf(tree: BoxTree): { text: string; before: number[] } {
  let found = SELECTABLE.get(tree);
  if (!found) {
    const gaps = tree.unselectable;
    const before: number[] = [];
    let text = '';
    let at = 0;
    let removed = 0;
    for (let i = 0; i < gaps.length; i += 2) {
      before.push(removed);
      text += tree.text.slice(at, gaps[i]);
      at = gaps[i + 1];
      removed += gaps[i + 1] - gaps[i];
    }
    found = { text: text + tree.text.slice(at), before };
    SELECTABLE.set(tree, found);
  }
  return found;
}

const SELECTABLE = new WeakMap<BoxTree, { text: string; before: number[] }>();

/** Where a box that holds no text stands in the document's text: at the
 *  end of the text before it, found up the boxes before it and around it,
 *  as each knows the range its subtree holds. */
function textBefore(box: Box): number {
  for (let node = box; node.parent; node = node.parent) {
    const siblings = node.parent.children;
    for (let i = siblings.indexOf(node) - 1; i >= 0; i -= 1) {
      const sibling = siblings[i];
      if (sibling.subtreeTextEnd > sibling.subtreeTextStart) {
        return sibling.subtreeTextEnd;
      }
    }
  }
  return 0;
}

/** Where the document's text goes on after a box with none: the start of
 *  the next text in document order, or the end of the last before it. */
function textAfter(root: Box, target: Box): number {
  const stack: Box[] = [root];
  let passed = false;
  let before = 0;
  while (stack.length) {
    const box = stack.pop()!;
    if (box === target) {
      passed = true;
      continue;
    }
    if (box.kind === 'text' && box.textEnd > box.textStart) {
      if (passed) return box.textStart;
      before = box.textEnd;
    }
    for (let i = box.children.length - 1; i >= 0; i -= 1) {
      stack.push(box.children[i]);
    }
  }
  return before;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function textOf(el: Element): string {
  let out = '';
  for (const child of el.children) {
    if (child.type === 'text') out += child.data;
  }
  return out;
}

function sameChain(a: Element[], b: Element[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Each tree's focusable areas that can be stops at all — an element's first
 * box, of one that is not `inert` — each as the stop it is where it is
 * shown, with its box, and the box by element (`_reportStops`). What a
 * restyle in place can change — visibility, a widget's room — is asked of
 * these each time; what only a build can, here, once a tree.
 */
interface Candidates {
  stops: FocusStop[];
  boxes: Box[];
  byElement: Map<Element, Box>;
}

const CANDIDATES = new WeakMap<BoxTree, Candidates>();

function focusCandidates(tree: BoxTree): Candidates {
  let found = CANDIDATES.get(tree);
  if (found) return found;
  found = { stops: [], boxes: [], byElement: new Map() };
  for (const box of tree.focusables) {
    const el = box.el;
    if (!el || found.byElement.has(el) || isInert(el)) continue;
    found.byElement.set(el, box);
    found.boxes.push(box);
    found.stops.push({
      element: el,
      tabbable: isTabbable(el),
      widget: box.kind === 'replaced' && WIDGETS.has(box.replaced),
    });
  }
  CANDIDATES.set(tree, found);
  return found;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function sameRects(a: ControlRect[], b: ControlRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i];
    const q = b[i];
    if (
      p.element !== q.element ||
      p.x !== q.x ||
      p.y !== q.y ||
      p.width !== q.width ||
      p.height !== q.height ||
      p.fontFamily !== q.fontFamily ||
      p.fontSize !== q.fontSize ||
      p.opacity !== q.opacity ||
      !sameClip(p.clip, q.clip) ||
      !sameBare(p.bare, q.bare)
    ) {
      return false;
    }
  }
  return true;
}

function sameMedia(a: MediaRect[], b: MediaRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i];
    const q = b[i];
    if (
      p.element !== q.element ||
      p.source !== q.source ||
      p.url !== q.url ||
      p.x !== q.x ||
      p.y !== q.y ||
      p.width !== q.width ||
      p.height !== q.height ||
      p.fit !== q.fit ||
      p.radius !== q.radius ||
      p.clipRadius !== q.clipRadius ||
      p.opacity !== q.opacity ||
      p.hidden !== q.hidden ||
      p.autoPlay !== q.autoPlay ||
      p.loop !== q.loop ||
      p.muted !== q.muted ||
      p.controls !== q.controls ||
      p.label !== q.label ||
      !sameClip(p.clip, q.clip)
    ) {
      return false;
    }
  }
  return true;
}

function sameElements(
  a: ReadonlySet<Element>,
  b: ReadonlySet<Element>,
): boolean {
  if (a.size !== b.size) return false;
  for (const el of a) if (!b.has(el)) return false;
  return true;
}

function sameClip(a?: ControlRect['clip'], b?: ControlRect['clip']): boolean {
  if (!a || !b) return a === b;
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function sameBare(a?: BareField, b?: BareField): boolean {
  if (!a || !b) return a === b;
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.color === b.color &&
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.chevron === b.chevron
  );
}

// --- walks over the laid-out tree -------------------------------------------

/** Distance from a coordinate to an interval, zero inside it. */
function axisDistance(v: number, lo: number, span: number): number {
  return v < lo ? lo - v : v > lo + span ? v - (lo + span) : 0;
}

/** The code-unit offset in the document of the place in a text's line
 *  nearest a point in the coordinates the text was laid out in. */
function textOffsetAt(text: LineText, x: number, y: number): number {
  // in the row that is this line's, where the layout's other lines are
  // in another column and a point past this one is not over them
  let row = y - text.drawY;
  const natural = text.layout.lines[text.layoutLine];
  if (natural && columned.any && COLUMN_ROWS.has(text)) {
    row = Math.max(natural.y, Math.min(row, natural.y + natural.height - 0.01));
  }
  const local = text.layout.indexAt(x - text.drawX, row);
  const offsets = layoutOffsetsOf(text.layout);
  const units = offsets.length
    ? offsets[Math.max(0, Math.min(local, offsets.length - 1))]
    : local;
  return Math.max(text.textStart, documentOffsetOf(text, units));
}

/** A box, and a point in the coordinates what it holds was laid out in:
 *  inside its own matrix, and taken back by the viewport's scroll where it
 *  is fixed to it, as the hit test that reached it took it (`deepestAt`). */
interface TextFrame {
  box: Box;
  x: number;
  y: number;
  /** Whether the box is fixed to the viewport, or in one that is. */
  atViewport: boolean;
}

/** What the selection asks of the hit test (`deepestAt`): the text on top
 *  under the point, or else the box on top, and the point in the frame of
 *  the box the one or the other was laid out in. */
interface SelectionHit {
  text: LineText | null;
  /** Where the run under the point starts in the document's text, in code
   *  units: a run's text is all of one box. */
  run: number;
  box: Box | null;
  x: number;
  y: number;
  atViewport: boolean;
}

/** A hit for the selection to be told of, at a document point. */
function selectionHit(at: { x: number; y: number }): SelectionHit {
  return { text: null, run: -1, box: null, ...at, atViewport: false };
}

/** Whether any of a line text's runs is seen: a run's text is all of one
 *  text box, whose style says so. Text a page hid is no place for a press
 *  to land nearest, as Blink passes over a box that is not visible
 *  (`IsHitTestCandidate`). */
function seenText(text: LineText, boxes: readonly Box[]): boolean {
  const runs = text.layout.lines[text.layoutLine]?.runs;
  if (!runs?.length) return true;
  for (const run of runs) {
    const box = textBoxAt(boxes, text.spans.documentAt(run.start));
    if (!box || box.style.visibility === 'visible') return true;
  }
  return false;
}

/**
 * The code-unit offset nearest a point, among the text a box holds: the
 * box and the point in its frame (`TextFrame`), passing over text no one
 * can see.
 *
 * Two prunes keep this the viewport's cost rather than the document's — it
 * runs per pointer event during a selection drag, where an unpruned walk of
 * a big document measured in the tens of milliseconds *per move*:
 *
 *  - a subtree whose ink bounds cannot beat the best distance found so far
 *    is skipped whole (the metric `dy·4 + dx` is monotone in both axis
 *    distances, so the bounds give an exact lower bound);
 *  - within a box, lines are y-sorted, so the candidates are found by
 *    binary search and the scan stops the moment vertical distance alone
 *    rules a line out.
 */
function nearestText(
  from: TextFrame,
  /** How far a box fixed to the viewport is drawn from where it was laid
   *  out (`HtmlViewNode._fixedShift`). */
  fixedShift: { x: number; y: number } | null,
  /** The document's text boxes, which say whether a text is seen. */
  boxes: readonly Box[],
  /** Only the text in the box's flow: not what its absolute and fixed
   *  boxes hold, however deep (`HtmlViewNode.textIndexAt`). */
  inFlow = false,
): number | null {
  let { x, y, atViewport } = from;
  let best: number | null = null;
  let bestDistance = Infinity;

  const tryLine = (line: NonNullable<Box['lines']>[number]): void => {
    const dy = axisDistance(y, line.y, line.height);
    for (const text of line.texts) {
      const natural = text.layout.lines[text.layoutLine];
      if (!natural) continue;
      const left = text.drawX + natural.x;
      const dx = axisDistance(x, left, natural.width);
      const distance = dy * 4 + dx;
      if (distance >= bestDistance) continue;
      if (!seenText(text, boxes)) continue;
      bestDistance = distance;
      best = textOffsetAt(text, x, y);
    }
  };

  // a box fixed to the viewport is where the pane's scroll draws it
  const visit = (node: Box): void => {
    if (!fixedShift || atViewport || !fixedToViewport(node)) {
      visitAt(node);
      return;
    }
    x -= fixedShift.x;
    y -= fixedShift.y;
    atViewport = true;
    try {
      visitAt(node);
    } finally {
      x += fixedShift.x;
      y += fixedShift.y;
      atViewport = false;
    }
  };

  const visitAt = (node: Box): void => {
    const boundsDistance =
      axisDistance(y, node.boundsY, node.boundsHeight) * 4 +
      axisDistance(x, node.boundsX, node.boundsWidth);
    if (boundsDistance >= bestDistance) return;
    // in a box painted through a matrix, the point taken back through it
    // (`deepestAt`): the text is where it was laid out
    const matrix = placedMatrix(node);
    if (!matrix) {
      visitIn(node);
      return;
    }
    const back = invert(matrix);
    if (!back) return;
    const px = x;
    const py = y;
    [x, y] = mapPoint(back, px, py);
    try {
      visitIn(node);
    } finally {
      x = px;
      y = py;
    }
  };

  const visitIn = (node: Box): void => {
    const lines = node.lines;
    if (lines?.length) {
      // The line nearest in y, by binary search; then outward both ways
      // while vertical distance alone could still beat the best.
      let lo = 0;
      let hi = lines.length;
      // the lines columns took apart are in no order down the page: each
      // is tried
      const apart = columned.any && COLUMN_LINES.has(lines);
      while (!apart && lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].y > y) hi = mid;
        else lo = mid + 1;
      }
      for (let i = lo - 1; i >= 0; i -= 1) {
        if (axisDistance(y, lines[i].y, lines[i].height) * 4 >= bestDistance)
          break;
        tryLine(lines[i]);
      }
      for (let i = lo; i < lines.length; i += 1) {
        if (axisDistance(y, lines[i].y, lines[i].height) * 4 >= bestDistance) {
          if (apart) continue;
          break;
        }
        tryLine(lines[i]);
      }
    }
    // Atomics are ordinary children of the box, so the child walk below
    // reaches them; a per-line atomics pass would visit each twice.
    //
    // A wide child list goes through the sorted index, outward from the
    // pointer's y — the bounds prune alone still *visits* every child to
    // reject it, and twenty thousand rejections per pointer move is the
    // cost being avoided. The expansion stops the moment vertical distance
    // alone cannot beat the best hit.
    const index = node.paintIndex;
    if (index) {
      const sorted = index.boxes;
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].boundsY > y) hi = mid;
        else lo = mid + 1;
      }
      for (let i = lo - 1; i >= 0; i -= 1) {
        const child = sorted[i];
        if (
          axisDistance(y, child.boundsY, child.boundsHeight) * 4 >=
          bestDistance
        )
          break;
        visit(child);
      }
      for (let i = lo; i < sorted.length; i += 1) {
        const child = sorted[i];
        if (
          axisDistance(y, child.boundsY, child.boundsHeight) * 4 >=
          bestDistance
        )
          break;
        visit(child);
      }
      if (node.positionedPaint) {
        for (const child of node.positionedPaint) {
          if (!inFlow || !child.outOfFlow) visit(child);
        }
      }
      return;
    }
    for (const child of node.children) {
      if (child.kind === 'text' || child.kind === 'break') continue;
      if (!inFlow || !child.outOfFlow) visit(child);
    }
  };
  // the frame's own box is entered already: the point is in its frame
  visitIn(from.box);
  return best;
}

/** Where a caret at a code-unit offset stands, in document coordinates.
 *  Subtrees whose text range cannot hold the offset are skipped whole, so
 *  the walk is the path to one paragraph, not the document. */
function caretAt(
  box: Box,
  units: number,
  /** How far a box fixed to the viewport is drawn from where it was laid
   *  out (`HtmlViewNode._fixedShift`): a caret in one is where it is
   *  drawn. */
  fixedShift: { x: number; y: number } | null = null,
): { x: number; y: number; height: number } | null {
  let found: { x: number; y: number; height: number } | null = null;
  let shift: { x: number; y: number } | null = null;
  const visit = (node: Box): void => {
    if (found) return;
    if (node.subtreeTextEnd <= node.subtreeTextStart) return;
    if (units < node.subtreeTextStart || units > node.subtreeTextEnd) return;
    const lines = node.lines;
    if (lines?.length) {
      // Lines are in document order, so their text starts are sorted:
      // binary search the last line starting at or before the offset.
      let lo = 0;
      let hi = lines.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].textStart > units) hi = mid;
        else lo = mid + 1;
      }
      for (let i = Math.max(0, lo - 1); i < lines.length; i += 1) {
        const line = lines[i];
        if (line.textStart > units) break;
        for (const text of line.texts) {
          if (units < text.textStart || units > text.textEnd) continue;
          const offsets = layoutOffsetsOf(text.layout);
          const layoutUnits = layoutOffsetOf(text, units);
          const caret = text.layout.caretPosition(
            codePointAtOffset(offsets, layoutUnits),
          );
          const at = throughTransforms(
            {
              x: text.drawX + caret.x,
              y: line.y,
              width: 0,
              height: line.height,
            },
            node,
          );
          found = {
            x: at.x + (shift?.x ?? 0),
            y: at.y + (shift?.y ?? 0),
            height: at.height,
          };
          return;
        }
      }
    }
    for (const child of node.children) {
      if (child.kind === 'text' || child.kind === 'break') continue;
      if (fixedShift && !shift && fixedToViewport(child)) {
        shift = fixedShift;
        visit(child);
        if (!found) shift = null;
      } else visit(child);
      if (found) return;
    }
  };
  visit(box);
  return found;
}

/**
 * A rectangle in a box's own coordinates — the ones it and what it holds
 * were laid out in — as the rectangle around where it is drawn: through
 * the matrix of each box from `from` up that is painted through one
 * (`placedMatrix`). The rectangle itself, in a document that transforms
 * nothing but by moving it.
 */
function throughTransforms(rect: Rect, from: Box | null): Rect {
  for (let at = from; at; at = at.parent) {
    const matrix = placedMatrix(at);
    if (matrix) rect = mapRect(matrix, rect.x, rect.y, rect.width, rect.height);
  }
  return rect;
}

/** Every band a document range covers, in window coordinates. The subtree
 *  text ranges prune the walk to the boxes the range actually crosses, so a
 *  drag's small range costs its own paragraphs; only Ctrl+A pays for all. */
/**
 * What an inline box reaches on each line besides its text, as `out`
 * rectangles as tall as the line: its own padding and border where it
 * starts or ends there — its edge less its margin, which is outside it —
 * and the inline-blocks and inline boxes' edges inside it, whole. The rest
 * of its border box across, which its text alone missed: a padded link was
 * as wide as its words (`elementRect`).
 */
function fragmentReach(box: Box, out: Rect[]): void {
  let block = box.parent;
  while (block && !block.lines) block = block.parent;
  if (!block?.lines) return;
  const inside = (b: Box | null): boolean => {
    for (let at = b; at && at !== block; at = at.parent) {
      if (at === box) return true;
    }
    return false;
  };
  const rtl = box.style.direction === 'rtl';
  for (const line of block.lines) {
    let left = Infinity;
    let right = -Infinity;
    for (const edge of line.edges ?? []) {
      if (edge.box === box) {
        // the element's `direction` says which side its start is on, as
        // paint reads it (`paintInlineBoxes`)
        const onLeft = (edge.side === 'start') !== rtl;
        left = Math.min(left, onLeft ? edge.x + box.marginLeft : edge.x);
        right = Math.max(
          right,
          onLeft ? edge.x + edge.width : edge.x + edge.width - box.marginRight,
        );
      } else if (inside(edge.box)) {
        left = Math.min(left, edge.x);
        right = Math.max(right, edge.x + edge.width);
      }
    }
    for (const placed of line.atomics) {
      if (!inside(placed.box)) continue;
      left = Math.min(left, placed.x - placed.box.marginLeft);
      right = Math.max(
        right,
        placed.x + placed.box.width + placed.box.marginRight,
      );
    }
    if (right > left) {
      out.push({
        x: left,
        y: line.y,
        width: right - left,
        height: line.height,
      });
    }
  }
}

/**
 * An inline element's bands made as tall as its fragments' border boxes,
 * as CSSOM View takes an inline box's client rects (6.1): its font's
 * content area about its own baseline, with the padding and the border
 * above and below it, which take no room on the line (CSS 2.1 10.6.1) and
 * which paint draws the background over (`paintInlineBoxes`). A band is a
 * line's height across until then: a link padded 10px below measured as
 * tall as its line and no taller.
 */
function fragmentHeights(box: Box, bands: Rect[], fonts: FontsLike): void {
  let block = box.parent;
  while (block && !block.lines) block = block.parent;
  if (!block?.lines?.length) return;
  const face = faceExtentOf(fonts, box.style);
  const byTop = new Map<number, LineBox>();
  for (const line of block.lines) byTop.set(line.y, line);
  for (let i = 0; i < bands.length; i += 1) {
    const band = bands[i];
    const line = byTop.get(band.y);
    if (!line) continue;
    // on its own baseline, which `vertical-align` may raise off the line's
    const raise = SHIFTED_LINES.has(line)
      ? (LINE_BOX_RAISES.get(line)?.get(box) ?? BOX_RAISES.get(box) ?? 0)
      : 0;
    const baseline = line.y + line.baseline - raise;
    const top = baseline - face.ascent - box.padTop - box.borderTop;
    const bottom = baseline + face.descent + box.padBottom + box.borderBottom;
    bands[i] = { x: band.x, y: top, width: band.width, height: bottom - top };
  }
}

/** The bands of a text range on one block's own lines. */
function lineBands(
  lines: readonly LineBox[],
  from: number,
  to: number,
  dx: number,
  dy: number,
  out: Rect[],
  /** Where the lines put the text, not where a relative offset moved it
   *  (`TEXT_SHIFTS`): what an inline box's own offset is added to. */
  laidOut = false,
  /** The rows a highlight covers (`selectionRows`) rather than the line's:
   *  past it where the glyphs are taller than the line. */
  ink = false,
): void {
  // First line whose text can reach `from`, by binary search over the
  // sorted text starts; stop at the first line past `to`.
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].textEnd > from) hi = mid;
    else lo = mid + 1;
  }
  for (let i = lo; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.textStart >= to) break;
    if (line.textEnd > from && line.textStart < to) {
      for (const text of line.texts) {
        const natural = text.layout.lines[text.layoutLine];
        if (!natural) continue;
        const a = Math.max(from, text.textStart);
        const b = Math.min(to, text.textEnd);
        if (b <= a) continue;
        const offsets = layoutOffsetsOf(text.layout);
        const moved = laidOut ? (TEXT_SHIFTS.get(text)?.x ?? 0) : 0;
        // The spaces a line ends on are removed (CSS Text 3, 4.1.2), and
        // take no room on it: the engine sets them past its line's content,
        // where a caret after them goes, and a band that took them in made
        // a link that ends a line a space wider than Chrome's. So the text
        // a line ends with is measured no further than its content.
        const ends = endsLine(line, text, natural);
        const rows = ink
          ? selectionRows(line, text, natural)
          : { y: line.y, height: line.height };
        for (const band of bandsFor(
          text.layout,
          natural,
          offsets,
          layoutOffsetOf(text, a),
          layoutOffsetOf(text, b, true),
        )) {
          let left = band.x;
          let right = band.x + band.width;
          if (ends) {
            left = Math.max(left, natural.x);
            right = Math.max(left, Math.min(right, natural.x + natural.width));
          }
          out.push({
            x: dx + left + text.drawX - moved,
            y: dy + rows.y,
            width: right - left,
            height: rows.height,
          });
        }
        // The spaces a piece of a line ends on, where the line goes on
        // after them: the engine stripped them from the piece it laid out
        // as a line, and they are the text's all the same, in the elements
        // that hold its end — a link whose text ends in a space, before
        // the next link, is that space wider than its letters
        if (text.trail && b >= text.textEnd && !rtlLine(natural)) {
          out.push({
            x: dx + natural.x + natural.width + text.drawX - moved,
            y: dy + rows.y,
            width: text.trail,
            height: rows.height,
          });
        }
        // the spaces `pre-wrap` keeps that the line ends on, which have no
        // run: the engine hung them past the line (`LineText.hung`)
        for (const space of text.hung ?? []) {
          const at = documentOffsetOf(text, space.at);
          if (at < a || at >= b) continue;
          out.push({
            x: dx + space.x + text.drawX - moved,
            y: dy + rows.y,
            width: space.width,
            height: rows.height,
          });
        }
      }
    }
  }
}

/** Whether a laid-out line's last run reads right to left, its end at its
 *  left. */
function rtlLine(natural: {
  runs: { run?: { direction?: string } }[];
}): boolean {
  return natural.runs[natural.runs.length - 1]?.run?.direction === 'rtl';
}

/** Whether a line's text is where the line ends: its last, with nothing
 *  placed after it — an inline-block or an image past its content. */
function endsLine(
  line: LineBox,
  text: LineText,
  natural: { x: number; width: number },
): boolean {
  if (line.texts[line.texts.length - 1] !== text) return false;
  const right = text.drawX + natural.x + natural.width;
  for (const placed of line.atomics) {
    if (placed.x >= right - 0.01) return false;
  }
  return true;
}

function collectBands(
  box: Box,
  from: number,
  to: number,
  dx: number,
  dy: number,
  out: Rect[],
  ink = false,
  /** How far a box fixed to the viewport is drawn from where it was laid
   *  out (`HtmlViewNode._fixedShift`), for the bands in one: null inside
   *  one already. */
  fixedShift: { x: number; y: number } | null = null,
): void {
  if (box.subtreeTextEnd <= box.subtreeTextStart) return;
  if (box.subtreeTextEnd <= from || box.subtreeTextStart >= to) return;
  const first = out.length;
  if (box.lines) lineBands(box.lines, from, to, dx, dy, out, false, ink);
  // Atomics are ordinary children, reached below.
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    if (fixedShift && fixedToViewport(child)) {
      const x = dx + fixedShift.x;
      const y = dy + fixedShift.y;
      collectBands(child, from, to, x, y, out, ink);
    } else collectBands(child, from, to, dx, dy, out, ink, fixedShift);
  }
  // where a box painted through a matrix draws them
  const matrix = out.length > first ? placedMatrix(box) : null;
  if (!matrix) return;
  for (let i = first; i < out.length; i += 1) {
    const band = out[i];
    const to = mapRect(
      matrix,
      band.x - dx,
      band.y - dy,
      band.width,
      band.height,
    );
    out[i] = { ...band, ...to, x: to.x + dx, y: to.y + dy };
  }
}

/** The layers of a hit test, in the order CSS paints them within a
 *  context (`deepestAt`): a stacking context's own box under the boxes it
 *  paints below its flow, which are over its background (CSS 2.1 Appendix
 *  E, steps 1 to 3). What is painted with the lines — their text, their
 *  atomics, a flex item — is ordered in theirs by the document. */
const HIT_CONTEXT = -2;
const HIT_NEGATIVE = -1;
const HIT_BLOCK = 0;
const HIT_FLOAT = 1;
const HIT_INLINE = 2;
const HIT_POSITIONED = 3;

/** The deepest element box containing a document-space point. */
function deepestAt(
  tree: BoxTree,
  x: number,
  y: number,
  /** Told whether what was found was found under text: a run's, rather
   *  than a box's. */
  hit?: { text: boolean },
  /** How far a box fixed to the viewport is drawn from where it was laid
   *  out (`HtmlViewNode._fixedShift`): the point is taken back by it in
   *  there, as paint moved the box by it (`atViewport`). */
  fixedShift: { x: number; y: number } | null = null,
  /** Told, for the selection, the text or the box what was found was
   *  found in, and the point in its frame (`SelectionHit`). */
  select?: SelectionHit,
): Element | null {
  const box = tree.root;
  let found: Element | null = box.el;
  let foundKey: readonly number[] = [];
  let viaText = false;
  // What is under a point is what was painted there last (CSS 2.1 Appendix
  // E): within a context, an in-flow block's own box, then a float over it,
  // then the lines' text and atomics and the flex items, in the document's
  // order, then a positioned box — and a float, an atomic, a flex item or a
  // positioned box paints its own content whole in its turn, those layers
  // again inside it. So a hit carries the layers down to it, and takes the
  // place of the one before where those come after them, or tie: an
  // infobox floated out of one section hangs over the next, whose
  // own box took every link in it, and a skin that puts the article in a
  // `position: relative` box put all of it in one layer. Positioned boxes
  // are painted in `z-index` order and then the document's (`byZIndex`),
  // the negative ones under the flow: the Zen Garden's `›` has
  // `z-index: 3` over the bar the "View All Designs" link fills after it.
  // Nor is a box the pointer passes through under it: one that is not
  // visible, which is no target for the pointer in any browser (CSS 2.1
  // 11.2 has it invisible, and a hit test finds what is seen), or one with
  // `pointer-events: none` (CSS UI 4, 5.2). Both are inherited, and what is
  // in such a box may say otherwise, so the walk goes on through it. A
  // site's closed menu is laid out over its page, hidden: GitHub's covered
  // its repository's tabs, and the pointer over a tab was over the menu.
  const take = (
    el: Element,
    style: ComputedStyle,
    key: readonly number[],
    text: boolean,
    /** The text or the box it was found in, for the selection, and the
     *  run's place in the document's text. */
    line: LineText | null,
    hitBox: Box | null,
    run = -1,
  ) => {
    if (style.visibility !== 'visible' || style.pointerEvents === 'none') {
      return;
    }
    if (compareKeys(key, foundKey) < 0) return;
    found = el;
    foundKey = key;
    viaText = text;
    if (select) {
      select.text = line;
      select.run = run;
      select.box = hitBox;
      select.x = x;
      select.y = y;
      select.atViewport = atViewport;
    }
  };
  // A box is walked into wherever it draws — its reach, overflow and all
  // (`computePaintBounds`) — and named only where its own rectangle is. A
  // page's `html, body { height: 100% }` is one viewport tall and its
  // article overflows it, and a walk that went no further than a box's own
  // rectangle found nothing below the first screen: once Wikipedia was
  // scrolled, no link lit up. One whose reach is not known yet — before its
  // first paint — is walked into at its rectangle, as before.
  //
  // A box that clips what overflows it hides what it holds past its edge —
  // but not the positioned boxes whose containing block is outside it (CSS
  // 2.1 11.1.1), which paint puts off until its clip ends
  // (`paintPositioned`). So past the edge the walk goes on only into a box
  // that holds positioned ones, carrying the clips the point is outside
  // of, and names nothing until a positioned box escapes them all: the
  // Zen Garden's archive links are absolute `<li>`s in an `overflow:
  // hidden` list with no height of its own, and not one of them could be
  // hovered or pressed.
  let atViewport = false;
  const aroundFixed = fixedShift ? boxesAroundFixed(tree) : null;
  // how many boxes painted whole in their turn the walk has entered —
  // floats, the ones painted with the positioned boxes, and an atomic or a
  // flex item among the lines — and texts it has asked, which is their
  // order in the document (`gatherLayers`, `placesOn`)
  let order = 0;
  const enter = (
    child: Box,
    context: readonly number[],
    stack: readonly number[],
    clipped: readonly Box[],
  ): void => {
    if (!fixedShift || atViewport || !fixedToViewport(child)) {
      enterAt(child, context, stack, clipped);
      return;
    }
    x -= fixedShift.x;
    y -= fixedShift.y;
    atViewport = true;
    try {
      enterAt(child, context, stack, clipped);
    } finally {
      x += fixedShift.x;
      y += fixedShift.y;
      atViewport = false;
    }
  };
  // A box painted through a matrix (`placedMatrix`) is under the point
  // where the matrix puts it: inside the rectangle around what it draws
  // there, the point is taken back through the matrix, into the
  // coordinates the box and all it holds were laid out in, and the walk
  // goes on with that. An icon turned a quarter is pressed where it is
  // drawn; a box flattened to nothing is nowhere.
  const enterAt = (
    child: Box,
    context: readonly number[],
    stack: readonly number[],
    clipped: readonly Box[],
  ): void => {
    const matrix = placedMatrix(child);
    if (!matrix) {
      enterIn(child, context, stack, clipped, null);
      return;
    }
    if (
      x < child.boundsX ||
      x >= child.boundsX + child.boundsWidth ||
      y < child.boundsY ||
      y >= child.boundsY + child.boundsHeight
    ) {
      return;
    }
    const back = invert(matrix);
    if (!back) return;
    const px = x;
    const py = y;
    [x, y] = mapPoint(back, px, py);
    try {
      enterIn(child, context, stack, clipped, ownBounds(child));
    } finally {
      x = px;
      y = py;
    }
  };
  const enterIn = (
    child: Box,
    context: readonly number[],
    /** The layers of the stacking context the box is in, which orders
     *  the positioned boxes in it however deep (`stackLayers`). */
    stack: readonly number[],
    clipped: readonly Box[],
    /** What the box draws in its own coordinates, where those are not the
     *  ones its bounds are in: a box painted through a matrix. */
    bounds: Rect | null,
  ): void => {
    const style = child.style;
    // What a `clip-path` cuts away of a box it cuts away of all the box
    // holds, whatever that is positioned from (CSS Masking 1, 5.1), and
    // nothing not drawn is under a pointer: a label a page hides for a
    // screen reader alone under `clip-path: inset(50%)` took the hover and
    // the press of what was drawn where it lay.
    if (pathClips(child) && !inClipPath(child, x, y)) return;
    // `clip` is not that rule as paint has it. It shows the part of an
    // absolute box it names (CSS 2.1 11.1.2), and past that part nothing is
    // drawn of the box, nor of what is painted with it. A stacking context
    // paints all it holds, inside its clip. A box that is none leaves its
    // positioned boxes to the context around it, which cuts each to the
    // clips its containing block is under (`clipsFor`): this one for all
    // but a fixed box, which is under none and is drawn past it. So past
    // its clip the first is left, and the second is walked as a box that
    // clips its overflow is past its edge — whether or not the point is in
    // its own rectangle, which a clip may show only a part of. Both were
    // walked as if they showed whole: a label hidden for a screen reader
    // alone under `clip: rect(0, 0, 0, 0)` took the hover and the press of
    // the link drawn where it lay.
    let cut = !inClip(child, x, y);
    const stacks = stacksLayers(child);
    if (cut && stacks) return;
    // A box painted with the positioned ones (`layered`) — positioned, a
    // flex item with a `z-index`, or a stacking context unpositioned:
    // transformed, translucent, contained, isolated, a float or a flex item
    // too — is
    // among the ones its stacking context paints, ordered by `z-index` and
    // then by the document (`gatherLayers`). Keyed in the layers of the box
    // around it instead, a box after one a negative margin drew up under
    // it took the pointer where the first was drawn over it, as did a
    // positioned box in one that is no stacking context over a positioned
    // box after it. One on a line, which its line paints, is in the line's.
    const lifted = child.parent !== null && layered(child.parent, child);
    if (lifted || style.position !== 'static') {
      const z = layerOf(child);
      context = [
        ...(lifted ? stack : context),
        z < 0 ? HIT_NEGATIVE : HIT_POSITIONED,
        z,
        (order += 1),
      ];
    } else if (child.parent?.kind === 'flex') {
      // A flex item is painted whole among the lines, in its turn (CSS
      // Flexbox 5.4), as an inline-block is. Keyed with the blocks, it was
      // under the background of a block after it that a negative margin
      // drew up under it, and over the text of one before it.
      context = [...context, HIT_INLINE, (order += 1)];
    } else if (style.float !== 'none') {
      // and a float after another over all of the first, its text too
      context = [...context, HIT_FLOAT, (order += 1)];
    }
    // what is in a stacking context is ordered in its layers, the root
    // element's too (`hoistNegative`), over its own box
    const ground =
      stacks || (child.parent === tree.root && child.el?.name === 'html');
    if (ground) stack = context;
    if (clipped.length !== 0 && child.outOfFlow) {
      const containing = containingBlockOf(child);
      clipped = containing
        ? clipped.filter((clip) => holds(clip, containing))
        : [];
    }
    // in one of its pieces, where columns broke it: its rect takes in the
    // columns between them, which are other boxes'
    const pieces = columned.any ? COLUMN_PIECES.get(child) : undefined;
    const inside = pieces
      ? pieces.some(
          (piece) =>
            x >= piece.x &&
            x < piece.x + piece.width &&
            y >= piece.y &&
            y < piece.y + piece.height,
        )
      : x >= child.x &&
        x < child.x + child.width &&
        y >= child.y &&
        y < child.y + child.height;
    const own = inside && hasRect(child);
    if (!own) {
      const left = bounds ? bounds.x : child.boundsX;
      const reach = bounds ? bounds.y : child.boundsY;
      const across = bounds ? bounds.width : child.boundsWidth;
      const down = bounds ? bounds.height : child.boundsHeight;
      const known = Number.isFinite(reach) && (across > 0 || down > 0);
      const away = known
        ? x < left || x >= left + across || y < reach || y >= reach + down
        : !inside;
      if (away) {
        // A box fixed to the viewport in it is drawn where the scroll has
        // the viewport, which no reach laid out at the document's top
        // says: the walk goes on to it, naming nothing on the way, as past
        // a clip. Zen Garden 220's "Est. 2003" is in its banner, and was
        // under the pointer only where the page had not scrolled.
        if (!fixedShift || atViewport || !aroundFixed?.has(child)) return;
        cut = true;
      } else if (clipsOverflow(child)) cut = true;
    }
    if (cut) {
      if (!holdsAbsolute(child)) return;
      clipped = [...clipped, child];
    }
    // A pseudo-element's box is its element's to the pointer (CSSOM View
    // 5, `elementFromPoint`; Selectors 4, 11.2): a `::before` hung above
    // its box — the Zen Garden's cables that panels hang from — hovers the
    // panel, as it does in a browser. Named by nothing, it kept nothing
    // under the pointer, and a panel that slid down its cable on `:hover`
    // lost the hover in the frame it left the pointer and slid back.
    const named = child.el ?? GENERATED_FROM.get(child) ?? null;
    if (own && named && clipped.length === 0) {
      const key = [...context, ground ? HIT_CONTEXT : HIT_BLOCK];
      take(named, style, key, false, null, child);
    }
    visit(child, context, stack, clipped);
  };
  const visit = (
    node: Box,
    context: readonly number[],
    stack: readonly number[],
    clipped: readonly Box[],
  ): void => {
    // The paint index answers a point query too — the wide level of a flat
    // document is the root's child list, and a hit test that walked all of
    // it would run per pointer move once hover is in the picture. A flex
    // box's are in the order paint has them, its `order`.
    const ordered = node.kind === 'flex' ? PAINT_ORDER.get(node) : undefined;
    const candidates =
      ordered ??
      (node.paintIndex
        ? queryChildIndex(node.paintIndex, y, y + 1)
        : node.children);
    for (const child of candidates) {
      if (child.kind === 'text' || child.kind === 'break') continue;
      // one on a line is entered there, in its turn among the line's text,
      // unless it is painted with the positioned boxes
      if (onLine(node, child) && !layered(node, child)) continue;
      enter(child, context, stack, clipped);
    }
    // and the ones the query passed over that hold a box fixed to the
    // viewport, which is not where they were laid out
    if (!ordered && node.paintIndex && fixedShift && !atViewport) {
      if (aroundFixed?.has(node)) {
        for (const child of node.paintIndex.boxes) {
          if (aroundFixed.has(child) && !candidates.includes(child)) {
            enter(child, context, stack, clipped);
          }
        }
      }
    }
    if (!ordered && node.paintIndex && node.positionedPaint) {
      for (const child of node.positionedPaint) {
        enter(child, context, stack, clipped);
      }
    }
    if (node.lines) {
      for (const line of node.lines) {
        // its texts and atomics in the document's order, which paint
        // paints them in (`placesOn`): a word an inline-block is under is
        // what the pointer is over
        const texts =
          clipped.length === 0 && y >= line.y && y < line.y + line.height
            ? line.texts
            : NO_TEXTS;
        let i = 0;
        for (const placed of line.atomics) {
          for (; i < placed.before && i < texts.length; i += 1) {
            textAt(texts[i], context);
          }
          const atomic = placed.box;
          if (atomic.parent && layered(atomic.parent, atomic)) continue;
          enter(atomic, [...context, HIT_INLINE, (order += 1)], stack, clipped);
        }
        for (; i < texts.length; i += 1) textAt(texts[i], context);
      }
    }
  };
  // An inline box has no box of its own — its extent is the runs on its
  // line — so the element under a point inside a paragraph is found from
  // the run rather than from a rectangle: from where its text sits in the
  // document, whose text boxes know their element. Not from the run
  // itself, whose layout may be one an earlier parse made
  // (`TextLayoutCache`), and which an engine may hand back with nothing on
  // it but its extent. Whether it is seen and pointed at is its text box's
  // to say, whose style is the pseudo-element's in generated content: Zen
  // Garden 220's headings are hidden, and their `::after`s, which say
  // `visible`, are what each shows.
  const textAt = (text: LineText, context: readonly number[]): void => {
    const natural = text.layout.lines[text.layoutLine];
    if (!natural) return;
    const at = (order += 1);
    for (const run of natural.runs) {
      const left = text.drawX + natural.x + run.x;
      if (x >= left && x < left + run.width) {
        const offset = text.spans.documentAt(run.start);
        const box = textBoxAt(tree.textBoxes, offset);
        const owner = box?.el;
        if (owner && tree.styles.has(owner)) {
          const key = [...context, HIT_INLINE, at];
          take(owner, box.style, key, true, text, null, offset);
        }
      }
    }
  };
  visit(box, [], [], []);
  if (hit) hit.text = viaText;
  return found;
}

const NO_TEXTS: LineText[] = [];
const NO_BOXES: readonly Box[] = [];

/** The boxes a tree's boxes fixed to the viewport are in, from their
 *  parents up: what a hit test walks into past their reach once the
 *  viewport has scrolled (`deepestAt`). Kept by the list, which a layout
 *  makes again. */
function boxesAroundFixed(tree: BoxTree): Set<Box> | null {
  const fixed = FIXED_BOXES.get(tree);
  if (!fixed) return null;
  let around = AROUND_FIXED.get(fixed);
  if (!around) {
    around = new Set();
    for (const box of fixed) {
      for (let at = box.parent; at && !around.has(at); at = at.parent) {
        around.add(at);
      }
    }
    AROUND_FIXED.set(fixed, around);
  }
  return around;
}

const AROUND_FIXED = new WeakMap<readonly Box[], Set<Box>>();

/** Paint order between two hits' layers, outermost first: negative where
 *  `a` was painted under `b`. */
function compareKeys(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// --- a pointer move restyled where it happened (`_hoverInPlace`) -----------

/** How many elements a pointer move restyles in place before the document
 *  is built again instead: a link's subtree is a handful, and a compound
 *  that matches a container reaches everything in it. */
const HOVER_RESTYLE_LIMIT = 300;

/** How long the content under a still pointer has to have stopped moving
 *  before the hover is asked for again (`HtmlViewNode._holdHover`): a
 *  tenth of a second, which is what WebKit waits after a scroll before it
 *  sends the mouse move that updates its own. */
const HOVER_REST_MS = 100;

const timers = globalThis as {
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
};

/**
 * The clock a held hover waits on. Through `globalThis` because `src/`
 * compiles with `types: []`, and unref'd where the runtime allows it: a
 * timer of a document's must not keep a process alive that is otherwise
 * done. One object, exported from this module though not from the package,
 * so a test can hold it and say when the rest is over (`test/held-clock.ts`).
 */
export const hoverClock = {
  now(): number {
    return Date.now();
  },
  arm(step: () => void, ms: number): unknown {
    const handle = timers.setTimeout?.(step, ms) ?? null;
    (handle as { unref?(): void } | null)?.unref?.();
    return handle;
  },
  disarm(handle: unknown): void {
    timers.clearTimeout?.(handle);
  },
};

/**
 * The clock the document's animations run on, as `hoverClock` is a held
 * hover's: through `globalThis`, unref'd, and exported for a test to hold.
 */
export const animationClock = {
  now(): number {
    return Date.now();
  },
  arm(step: () => void, ms: number): unknown {
    const handle = timers.setTimeout?.(step, ms) ?? null;
    (handle as { unref?(): void } | null)?.unref?.();
    return handle;
  },
  disarm(handle: unknown): void {
    timers.clearTimeout?.(handle);
  },
};

/**
 * The clock a resize rests on (`_stopAt`), as `hoverClock` is a held
 * hover's: through `globalThis`, unref'd, and exported for a test to hold.
 */
export const resizeClock = {
  now(): number {
    return Date.now();
  },
  arm(step: () => void, ms: number): unknown {
    const handle = timers.setTimeout?.(step, ms) ?? null;
    (handle as { unref?(): void } | null)?.unref?.();
    return handle;
  },
  disarm(handle: unknown): void {
    timers.clearTimeout?.(handle);
  },
};

/** How soon after the last a width that moves again is a drag's: a window
 *  edge dragged moves it a frame at a time. */
const RESIZE_BURST_MS = 200;

/** How long a dragged width rests before the document is laid out whole. */
const RESIZE_SETTLE_MS = 150;

/** The most a width moves, in CSS pixels, that is taken for a step of a
 *  drag on its own, before the next one says so (`_stopAt`). */
const DRAG_STEP_CSS_PX = 48;

/**
 * The computed properties a pointer move may change in place: ink, which
 * moves nothing. A background colour is drawn inside the box it colours
 * and a border's colour on the border it has; `box-shadow`, `text-shadow`
 * and an outline's width reach past it, where the paint index has already
 * looked, and a background image has to be fetched.
 */
const PAINT_ONLY = new Set([
  'color',
  'textFillColor',
  'cursor',
  'pointerEvents',
  'fill',
  'stroke',
  'backgroundColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'outlineColor',
  'textDecorationLine',
  'textDecorationColor',
  'textDecorationStyle',
  'textDecorationThickness',
  'textUnderlineOffset',
  'underline',
  'underlineStyle',
  'underlineThickness',
  'underlineOffset',
  'lineThrough',
  'lineThroughStyle',
  'lineThroughThickness',
]);

/** The fields of a run its ink is: what `runFor` takes from `PAINT_ONLY`. */
const INK_FIELDS = [
  'color',
  'underline',
  'underlineStyle',
  'underlineOffset',
  'underlineThickness',
  'strike',
  'strikeStyle',
  'strikeThickness',
] as const;

/** The fields of a run its shape is, which ink never changes. */
const FACE_FIELDS = [
  'family',
  'size',
  'weight',
  'style',
  'letterSpacing',
  'features',
] as const;

/** Whether two styles differ in ink alone: true where they do, null where
 *  they do not differ, false where something else does. Custom properties
 *  are read through the properties that use them. */
/** What a restyle in place changed beyond ink: how far a box's ink
 *  reaches, the order its layer paints in, or where it is. */
interface HoverChange {
  /** Whether anything that is drawn changed: false where only the custom
   *  properties did, which the elements under this one read. */
  ink: boolean;
  reach: boolean;
  order: boolean;
  move: boolean;
  /** Whether the opacity changed, and the box stays a group to fade or
   *  stays none (`stacksLayers`). */
  fade: boolean;
}

/** An element's `::before` and `::after`, each with its bit in the set
 *  of the ones a restyle found boxes of (`_hoverInPlace`). */
const GENERATED_BITS = [
  ['before', 1],
  ['after', 2],
] as const;

/** The replaced boxes that are controls (`BoxTree.controls`, `controls.ts`):
 *  a widget mounted beside the document, or a button whose press it reports. */
const WIDGETS = new Set<ReplacedKind>([
  'input',
  'textarea',
  'select',
  'button',
  'checkbox',
  'radio',
]);

/** What only moves how far a box's ink reaches: a shadow, and an outline's
 *  size, which take no room (CSS Backgrounds 3, 7.1; CSS UI 4, 3). */
const INK_REACH = new Set([
  'boxShadow',
  'outlineStyle',
  'outlineWidth',
  'outlineOffset',
]);

/** What transforms a box: it moves, turns or scales where it is, and
 *  nothing around it does (CSS Transforms 1, 3). */
const TRANSFORM_FIELDS = new Set([
  'translate',
  'rotate',
  'scale',
  'transform',
  'transformOrigin',
]);

/** How a restyle changed what a box draws, for the surface kept for it and
 *  the ones around it (`_restyledSprites`). */
const enum SpriteChange {
  /** It draws what it did, where it did. */
  None = 0,
  /** It draws what it did, turned, moved, faded or in another place among
   *  its layers. */
  Placed = 1,
  /** It draws something else. */
  Drawn = 2,
}

/** What places a box's drawing without changing it: where its surface is
 *  drawn through, how faded or filtered, and among which layers. */
const PLACING_FIELDS = new Set([
  ...TRANSFORM_FIELDS,
  'opacity',
  'filter',
  'zIndex',
]);

/** What draws nothing: the custom properties and the animation lists, which
 *  are in the other fields already, and what the pointer does over it. */
const UNDRAWN_FIELDS = new Set([
  'custom',
  'animations',
  'transitions',
  'cursor',
  'pointerEvents',
]);

/** The last answer for each new style, which the text set in a box shares
 *  with it. */
const SPRITE_CHANGES = new WeakMap<
  ComputedStyle,
  { was: ComputedStyle; change: SpriteChange }
>();

function spriteChange(was: ComputedStyle, now: ComputedStyle): SpriteChange {
  if (was === now) return SpriteChange.None;
  const known = SPRITE_CHANGES.get(now);
  if (known?.was === was) return known.change;
  const a = was as unknown as Record<string, unknown>;
  const b = now as unknown as Record<string, unknown>;
  let change = SpriteChange.None;
  for (const key in b) {
    if (UNDRAWN_FIELDS.has(key) || sameValue(a[key], b[key])) continue;
    if (!PLACING_FIELDS.has(key)) {
      change = SpriteChange.Drawn;
      break;
    }
    change = SpriteChange.Placed;
  }
  SPRITE_CHANGES.set(now, { was, change });
  return change;
}

/**
 * How two styles of one element differ, for a restyle in place: null where
 * they do not, a `HoverChange` where every difference is ink, how far ink
 * reaches, a `z-index` that stays a stacking context's, an opacity or a
 * visibility, or a transform — none of which moves anything but the box
 * and what it holds (CSS Transforms 1: a transform does not affect layout)
 * — and false where anything else differs.
 */
function hoverChange(
  was: ComputedStyle,
  now: ComputedStyle,
): HoverChange | null | false {
  const a = was as unknown as Record<string, unknown>;
  const b = now as unknown as Record<string, unknown>;
  let change: HoverChange | null = null;
  for (const key in b) {
    // the sets are shared by what made them (`Cascade._customFor`): one
    // object where they are the same
    if (key === 'custom') {
      if (a[key] !== b[key]) {
        change ??= {
          ink: false,
          reach: false,
          order: false,
          move: false,
          fade: false,
        };
      }
      continue;
    }
    // what an element's animations and transitions leave is in its other
    // fields already (`Cascade._computeStyle`); the lists themselves draw
    // nothing
    if (key === 'animations' || key === 'transitions') {
      if (!sameValue(a[key], b[key])) {
        change ??= {
          ink: false,
          reach: false,
          order: false,
          move: false,
          fade: false,
        };
      }
      continue;
    }
    if (sameValue(a[key], b[key])) continue;
    change ??= {
      ink: true,
      reach: false,
      order: false,
      move: false,
      fade: false,
    };
    change.ink = true;
    if (PAINT_ONLY.has(key)) continue;
    if (key === 'opacity') {
      // a group to fade before and after, or none either time: the order
      // its layers paint in is the same (`stacksLayers`) — as it is where
      // the opacity is named in `will-change` both times, which one in
      // transition or animated is, a layer of its context at 1 as well
      if (
        (a[key] as number) < 1 !== (b[key] as number) < 1 &&
        !(was.willChange & now.willChange & WILL_STACK)
      ) {
        return false;
      }
      change.fade = true;
      continue;
    }
    if (key === 'filter') {
      // a stacking context and the containing block of what is out of the
      // flow in it before and after, or neither — or a filter named in
      // `will-change` both times, which one in transition or animated is:
      // only how the group's pixels are drawn changes (`paintFiltered`)
      if (
        (a[key] === null) !== (b[key] === null) &&
        (was.willChange & now.willChange & FILTER_WILL) !== FILTER_WILL
      ) {
        return false;
      }
      continue;
    }
    // drawn or not, and under the pointer or not, where it was laid out —
    // but for a row or a column of a table, which `collapse` takes out
    if (key === 'visibility') {
      if (a[key] === 'collapse' || b[key] === 'collapse') return false;
      continue;
    }
    if (INK_REACH.has(key)) {
      change.reach = true;
      continue;
    }
    if (key === 'zIndex') {
      // one stacking context either way, with nothing hoisted below the
      // flow (`hoistNegative`): only its place among its layers changes
      const z0 = a[key];
      const z1 = b[key];
      if (typeof z0 !== 'number' || typeof z1 !== 'number') return false;
      if (z0 < 0 || z1 < 0) return false;
      change.order = true;
      continue;
    }
    if (TRANSFORM_FIELDS.has(key)) {
      change.move = true;
      continue;
    }
    return false;
  }
  return change;
}

/**
 * Whether a box can take a new translation where it is: a box of its own
 * rather than an inline one, whose text is what moves; and the same
 * containing block and stacking context for what is in it, which a
 * transform makes a box (CSS Transforms 1, 2) — so either transformed
 * before and after, or naming a transform in `will-change` before and
 * after, which a running animation of one does (Web Animations 1, 5.6), or
 * already positioned with a `z-index`, and holding nothing fixed, which
 * only a transform takes in.
 */
function movable(box: Box, was: ComputedStyle, now: ComputedStyle): boolean {
  if (box.kind === 'inline') return false;
  if (transformed(was) === transformed(now)) return true;
  if (
    (was.willChange & TRANSFORM_WILL) === TRANSFORM_WILL &&
    (now.willChange & TRANSFORM_WILL) === TRANSFORM_WILL
  ) {
    return true;
  }
  if (was.position === 'static') return false;
  if (typeof was.zIndex !== 'number' || typeof now.zIndex !== 'number') {
    return false;
  }
  const stack: Box[] = [...box.children];
  while (stack.length) {
    const at = stack.pop()!;
    if (at.style.position === 'fixed') return false;
    for (const child of at.children) stack.push(child);
  }
  return true;
}

/** What a sprite is of: an element, or a pseudo-element of one. */
interface SpriteTarget {
  el: Element;
  pseudo: Pseudo;
}

/** How many of an element's animations the render server ran to their end
 *  are remembered (`spriteAnimationEnded`). */
const MAX_ENDED = 32;

/** A part the document made this frame, before it is asked what is
 *  painted after it (`HtmlViewNode.sprites`). */
interface Made {
  lift: Lift;
  key: string;
  part: Part;
  /** What its raster is painted at (`SpriteOffer.version`). */
  version: string;
  /** The part whose layer it goes in, or null for one above the
   *  document. */
  parent: Made | null;
  /** Where it is painted (`paintOrderOf`), for one above the document. */
  order: number[] | null;
  /** The parts that go in its layer. */
  kids: Made[];
}

/** An element out of the flow whose style a build changed, or one of its
 *  pseudo-elements, and the boxes it was drawn in before the build and is
 *  after it (`_changedOutOfFlow`). */
interface OutOfFlowChange {
  el: Element;
  was: Box | null;
  now: Box | null;
}

/** What an element, or a pseudo-element of one, was last offered as, and
 *  what that was made from (`HtmlViewNode.sprites`). */
interface SpriteOffer {
  /** Everything it was made from: a new one makes the part again. */
  stamp: string;
  part: Part | null;
  /** What it was painted from, but for the tree: the same, and the tree
   *  built again by a frame that changed nothing it holds, it paints what
   *  it painted (`_quietBuild`). */
  held: string;
  /** The tree it was made from, by its serial. */
  tree: number;
  /** What its raster is painted at, which a presenter paints again when it
   *  changes. */
  version: string;
}

/** No more parts than this are made of what the document paints over a
 *  part (`HtmlViewNode.sprites`). */
const MAX_OVER_PARTS = 4;

/**
 * Whether a build that changed `roots`, each laid out apart from the rest
 * (`_quietBuild`), changed what a part of `el`'s paints: one of them is
 * `el`, is inside it, or holds it.
 */
function repaints(roots: Iterable<Element>, el: Element): boolean {
  for (const root of roots) {
    for (let at: Element | null = root; at; at = flatParentOf(at)) {
      if (at === el) return true;
    }
    for (let at = flatParentOf(el); at; at = flatParentOf(at)) {
      if (at === root) return true;
    }
  }
  return false;
}

/** Paint order, as `paintOrderOf` keys it: negative where `a` is painted
 *  first. */
function byPaintOrder(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Whether one of the boxes fixed to the viewport is within a part's reach
 *  where it is drawn now, `shift` from where it was laid out
 *  (`_fixedShift`), or where it was laid out where nothing scrolls the
 *  element. */
function fixedWithin(
  part: Part,
  shift: { x: number; y: number } | null,
): boolean {
  const e = part.extent;
  const dx = shift?.x ?? 0;
  const dy = shift?.y ?? 0;
  for (const box of part.fixed) {
    if (!(box.boundsWidth > 0 && box.boundsHeight > 0)) continue;
    const x = box.boundsX + dx;
    const y = box.boundsY + dy;
    if (
      x < e.x + e.width &&
      e.x < x + box.boundsWidth &&
      y < e.y + e.height &&
      e.y < y + box.boundsHeight
    ) {
      return true;
    }
  }
  return false;
}

/** What naming a transform in `will-change` makes of a box that is not
 *  inline: what a transform does, but for moving it. */
const TRANSFORM_WILL = WILL_STACK_BOX | WILL_HOLD_FIXED_BOX;

/** What naming a filter in `will-change` makes of any box: a stacking
 *  context, and the containing block of what is out of the flow in it. */
const FILTER_WILL = WILL_STACK | WILL_HOLD_FIXED;

/** Whether a style takes its box out of the flow, to be laid out apart
 *  from everything around it. */
function outOfFlow(style: ComputedStyle): boolean {
  return style.position === 'absolute' || style.position === 'fixed';
}

/** Whether a box is laid out where it was and as large: one that has a
 *  rect of its own — an inline box's text is its block's. How far it
 *  draws is no part of it, since that takes in what it holds, and a box
 *  out of the flow it holds moved. */
function sameGeometry(a: Box, b: Box): boolean {
  if (!hasRect(a) || !hasRect(b)) return hasRect(a) === hasRect(b);
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/**
 * Whether an inline box is a piece of one the blocks in it broke apart,
 * which took its opacity when the boxes were built (`FADED_BLOCKS`). They
 * are its parent's children now and none of its own, which is why it is
 * asked by its `cut`. Everything else in an inline box is faded by what
 * its style says when it is painted: its text and what is on its lines
 * by the inline boxes around them (`inlineFade`, `reinked`), its floats
 * and its positioned boxes in its own paint.
 */
function brokenAround(box: Box): boolean {
  return box.kind === 'inline' && box.cut !== 0;
}

/** An element's `::before` or `::after` box, in its first box or the
 *  anonymous boxes in it. */
function generatedIn(
  box: Box | undefined,
  el: Element,
  which: 'before' | 'after',
): Box | null {
  if (!box || box.el !== el) return null;
  const stack = [...box.children];
  while (stack.length) {
    const at = stack.pop()!;
    if (at.pseudo === which && GENERATED_FROM.get(at) === el) return at;
    if (!at.el && !at.pseudo) stack.push(...at.children);
  }
  return null;
}

/** Where a box draws, in document coordinates: its ink bounds, or for an
 *  inline box or a run of text, which are drawn on their block's lines and
 *  have none of their own, the block's. */
function inkOf(box: Box): Rect | null {
  let at: Box | null = box;
  while (at && (at.kind === 'text' || at.kind === 'break' || !hasRect(at))) {
    at = at.parent;
  }
  if (!at || at.boundsY === Infinity) return null;
  if (!(at.boundsWidth > 0 && at.boundsHeight > 0)) return null;
  // its bounds are in the coordinates of the box it is in, which a box
  // around it painted through a matrix draws somewhere else
  return throughTransforms(
    {
      x: at.boundsX,
      y: at.boundsY,
      width: at.boundsWidth,
      height: at.boundsHeight,
    },
    at.parent,
  );
}

/**
 * `text`'s layout made again with the ink of the boxes a pointer move
 * restyled: from the runs it was made from, each of a restyled text box's
 * given the ink its new style makes (`runFor`) and nothing else — faded,
 * as the layout fades it, by the inline boxes around it (`fadeRun`), which
 * fade a run whose own box is not restyled where `refaded` says an inline
 * box's opacity changed. Null where none of its runs is theirs; false
 * where that cannot be told — a run this cannot place in the document, one
 * some other pass inked (a first line's), or a layout that comes out
 * another shape.
 */
function reinked(
  text: LineText,
  layouts: TextLayoutCache,
  next: ReadonlyMap<Box, ComputedStyle>,
  refaded: boolean,
): TextLayoutLike | null | false {
  const spans = text.spans;
  const inputs = layouts.inputsOf(text.layout);
  if (!inputs || !spans.boxAt) {
    // not one this could make again: none of its text may be theirs
    for (const line of text.layout.lines) {
      for (const run of line.runs) {
        const box = spans.boxAt?.(run.start);
        if (!spans.boxAt) return false;
        if (box && next.has(box)) return false;
        if (box && refaded && textFade(box) !== textFade(box, next)) {
          return false;
        }
      }
    }
    return null;
  }
  let runs: TextRun[] | null = null;
  let offset = 0;
  const content = inputs.content;
  for (let i = 0; i < content.length; i += 1) {
    const run = content[i];
    const length = run.text.length;
    const box = length ? spans.boxAt(offset) : null;
    const style = box ? next.get(box) : undefined;
    // the fade it was set at, and the one it is set at now
    const faded = box && (style || refaded) ? textFade(box) : 1;
    const fades = box && refaded ? textFade(box, next) : faded;
    if (box && (style || fades !== faded)) {
      if (spans.boxAt(offset + length - 1) !== box) return false;
      const was = fadeRun(runFor(run.text, box.style), faded);
      const now = fadeRun(runFor(run.text, style ?? box.style), fades);
      for (const f of FACE_FIELDS) if (!sameValue(was[f], now[f])) return false;
      let inked: Record<string, unknown> | null = null;
      for (const f of INK_FIELDS) {
        // a run that is not what its style made — a first line's colour
        if (!sameValue(run[f], was[f])) return false;
        if (sameValue(was[f], now[f])) continue;
        inked ??= { ...run };
        if (now[f] === undefined) delete inked[f];
        else inked[f] = now[f];
      }
      if (inked) {
        runs ??= content.slice();
        runs[i] = inked as unknown as TextRun;
      }
    }
    offset += length;
  }
  if (!runs) return null;
  const layout = layouts.fonts.layout(runs, inputs.style, inputs.options);
  return sameShape(text.layout, layout) ? layout : false;
}

/** Whether two layouts put the same text in the same places: ink aside,
 *  the same layout. */
function sameShape(a: TextLayoutLike, b: TextLayoutLike): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.lines.length !== b.lines.length) return false;
  for (let i = 0; i < a.lines.length; i += 1) {
    const x = a.lines[i];
    const y = b.lines[i];
    if (
      x.x !== y.x ||
      x.y !== y.y ||
      x.width !== y.width ||
      x.height !== y.height ||
      x.baseline !== y.baseline ||
      x.ascent !== y.ascent ||
      x.descent !== y.descent ||
      x.start !== y.start ||
      x.end !== y.end ||
      x.runs.length !== y.runs.length
    ) {
      return false;
    }
    for (let j = 0; j < x.runs.length; j += 1) {
      const r = x.runs[j];
      const t = y.runs[j];
      if (
        r.x !== t.x ||
        r.width !== t.width ||
        r.start !== t.start ||
        r.end !== t.end
      ) {
        return false;
      }
    }
  }
  return true;
}

/** The text box that holds a document index, found by bisecting the boxes
 *  in document order: its element, and the style its text is set in. */
function textBoxAt(boxes: readonly Box[], index: number): Box | null {
  let lo = 0;
  let hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (boxes[mid].textStart <= index) lo = mid;
    else hi = mid - 1;
  }
  const box = boxes[lo];
  return box && index >= box.textStart && index < box.textEnd ? box : null;
}

export type {
  ControlRect,
  FocusStop,
  ReplacedKind,
  ResourceRequest,
  ResourceResult,
};

/** The advance of a face's "0", laid out: null where the engine cannot
 *  lay it out. */
function zeroWidthOf(fonts: FontsLike, face: MetricFace): number | null {
  const { family, size, weight, stretch } = face;
  // a run is upright or slanted, as `inline.ts` sets one
  const style = face.style === 'normal' ? 'normal' : 'italic';
  try {
    const run = { family, size, weight, style, stretch } as const;
    return fonts.layout([{ text: '0', ...run }], run, {}).width;
  } catch {
    return null;
  }
}

/** A face's own line height, as the engine reports it: null where it
 *  cannot say. */
function normalLineOf(fonts: FontsLike, face: MetricFace): number | null {
  const { family, size, weight, style } = face;
  try {
    const line = faceLineHeight(
      fonts.match(family, { size, weight, style }).metrics(size),
    );
    return line > 0 ? line : null;
  } catch {
    return null;
  }
}

/** A face's x-height, as the engine reports it: null where the face
 *  states none, or the engine does not say. */
function xHeightOf(fonts: FontsLike, face: MetricFace): number | null {
  const { family, size, weight, style } = face;
  try {
    const metrics = fonts
      .match(family, { size, weight, style })
      .metrics(size) as {
      xHeight?: number | null;
    };
    const x = metrics.xHeight;
    // NaN where the face states none, which is a number
    return typeof x === 'number' && x > 0 ? x : null;
  } catch {
    return null;
  }
}
