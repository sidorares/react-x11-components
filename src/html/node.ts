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
import {
  registerElement,
  registeredElements,
  registeredPositions,
  registerPosition,
} from 'react-x11/host';
import type { PositionContext } from 'react-x11/host';
import { CARET_BLINK_MS, Node } from 'react-x11/node';
import type {
  Context2D,
  MeasureConstraints,
  MeasuredSize,
} from 'react-x11/node';
import type { DrawnNode, MouseEvent as X11MouseEvent, Rect } from 'react-x11';
import type { Style } from 'react-x11/style';
import type { AnyNode, ChildNode, Element, ParentNode } from 'domhandler';
import { pointOfUnit, unitOfPoint } from './dom-text.js';
import type { HighlightRanges } from './scripts/host.js';
import type { ConsoleProperty, ConsoleResult } from './scripts/scripted.js';
import {
  findTextDirective,
  parseTextDirectives,
  searchTextOf,
  splitFragment,
} from './text-fragments.js';
import type { TextDirective } from './text-fragments.js';
import { compareDocumentPosition } from 'domutils';

import { codePointAtOffset, codeUnitOffsets } from '../internal/text.js';
import {
  attr,
  choosesSource,
  flatChildrenOf,
  flatParentOf,
  HtmlSource,
  imageUrlOf,
  indicatedElement,
  isElement,
  isInputButton,
  isText,
  loadsLazily,
  madeByParser,
  isStylePreload,
  NON_RENDERED,
  ShadowRoot,
  shadowRootOf,
  tagOf,
  treeGeneration,
} from './dom.js';
import type { Document, HtmlChange, SheetRef } from './dom.js';
import { directionHolder } from './direction.js';
import { controlsReached } from './form.js';
import type { FieldSelection } from './form.js';
import {
  alphaOf,
  inkColor,
  isTransparent,
  resolve as resolveLength,
} from './css/values.js';
import type { Len } from './css/values.js';
import { cssomStyle, cssomTransform } from './computed.js';
import type { UsedBox } from './computed.js';
import {
  Cascade,
  CHANGES_BELOW,
  CHANGES_LATER,
  CHANGES_SELF,
  HOVER_EDGE,
  HOVER_FOLLOWED,
  HOVER_PSEUDO_GENERATED,
  HOVER_PSEUDO_NONE,
  HOVER_PSEUDO_OTHER,
  HOVER_SELF,
  HOVER_UNTOUCHED,
  NO_FOCUS,
  TARGET_TEXT,
  VIEWPORT_HEIGHT,
  VIEWPORT_WIDTH,
  readsFace,
  highlightKey,
} from './css/cascade.js';
import type {
  BelowReach,
  ChangeAnchors,
  FocusState,
  HighlightPseudoStyle,
  HoverTouch,
  KeptStyles,
  MatchedRule,
  MetricFace,
  ShadowSheets,
  SiblingPair,
  SiblingReach,
  Tested,
  TransitionPart,
  ViewportOverflow,
} from './css/cascade.js';
import {
  mediaMatches,
  parseDeclarations,
  parseMediaQuery,
  parseStylesheet,
} from './css/parse.js';
import type {
  Declaration,
  KeyframesRule,
  MediaCondition,
  SheetSource,
  StyleRule,
  Stylesheet,
} from './css/parse.js';
import type { ShapeStyles } from './css/shapes.js';
import { uaStylesheet } from './css/ua.js';
import { AnimationTimeline } from './css/timeline.js';
import { NO_ANIMATIONS, easingText, timingAt } from './css/animation.js';
import type { CssEventRecord, ScrollProgress } from './css/timeline.js';
import {
  RANGE_END,
  RANGE_START,
  scrollEdgeAt,
  timelineTriggersOf,
  triggerActive,
  viewEdgeAt,
} from './css/triggers.js';
import type { TimelineTrigger, ViewPlace } from './css/triggers.js';
import { AUTO, resolve as resolveLen } from './css/values.js';
import { ScriptAnimations } from './css/scripted.js';
import type {
  ComputedStyle,
  FontQuery,
  RootLook,
  TimelineRef,
} from './css/style.js';
import {
  INLINE_BEFORE_ABSOLUTE,
  COLOR_SOURCE_FIELDS,
  CONTAIN_INLINE_SIZE,
  NO_SNAP_ALIGN,
  inherit,
  sameValue,
  scrolls,
  urlOf,
  WILL_HOLD_FIXED,
  WILL_HOLD_FIXED_BOX,
  WILL_STACK,
  WILL_STACK_BOX,
} from './css/style.js';
import {
  BOTTOM_EDGE,
  LEFT_EDGE,
  RIGHT_EDGE,
  TOP_EDGE,
} from './css/containers.js';
import type { ContainerSize, ScrollStates } from './css/containers.js';
import {
  BOX_RAISES,
  buildBoxes,
  buildSubtrees,
  canRebuild,
  inLightTree,
  idIndex,
  tailFrom,
  containerBoxes,
  CONTENT_IMAGES,
  CLEARED_FROM,
  COLUMN_LINES,
  COLUMN_PIECES,
  COLUMN_ROWS,
  CUT_BLOCKS,
  GENERATED_FROM,
  GENERATED_ON,
  INLINE_OFFSETS,
  LINE_BOX_RAISES,
  PAINT_ORDER,
  SHAPE_STYLES,
  SHIFTED_LINES,
  TEXT_SHIFTS,
  TRANSITION_IMAGES,
  TRANSITION_KEYS,
  TRANSITION_STYLES,
  anonymousMade,
  awaitedIntrinsics,
  columned,
  intrinsicsOf,
  textFade,
} from './layout/boxes.js';
import type {
  Box,
  BoxTree,
  BuildOptions,
  ForeignObject,
  SubtreeRoots,
  SubtreesBuilt,
  AtomicPlacement,
  LineBox,
  LineText,
  ReplacedKind,
  TextLayoutLike,
  TransitionTree,
} from './layout/boxes.js';
import {
  ANCHOR_FALLBACK,
  anchorAt,
  carryBlockers,
  containmentApplies,
  containsOutOfFlow,
  forgetSizes,
  heldBack,
  heldShift,
  laidWhole,
  layoutAsks,
  layoutDocument,
  noteMoving,
  placedMatrix,
  asideIn,
  putBack,
  setAsideHere,
  setAsideIn,
  asideOf,
  showsUnseen,
  unseenHeld,
  unseenIn,
  commitLastPositions,
  placedStyleOf,
  resolvedInsets,
  restickToViewport,
  restickWithin,
  retranslate,
  translate,
  translationOf,
  VIEWPORT_STICKY,
  forgetSizesIn,
  isInlineLevel,
} from './layout/block.js';
import { frameModeOf, onPage, pageSides } from './layout/writing.js';
import {
  isScroller,
  scrollBarHit,
  scrollBarsOf,
  anchoredAcross,
  anchorScrollsOf,
  followPane,
  positionVisibilityBoxes,
  refitAnchored,
  scrollContent,
  setViewport,
  updatePositionVisibility,
  scrolledBy,
  scrollMoves,
  scrollStateOf,
  setScrollOffsets,
  STUCK,
  wheelScrolls,
} from './layout/scroll.js';
import type {
  ScrollBar,
  ScrollOffset,
  ScrollState,
  Viewport,
} from './layout/scroll.js';
import { lineUp, linesUp, resnap, snapTo } from './layout/snap.js';
import type {
  SnapArea,
  SnapContainer,
  SnapScroll,
  Snapped,
} from './layout/snap.js';

/** Both of a scroll container's bars, hidden by nothing. */
const BARS_SHOWN = { x: false, y: false };
import { layoutShape, shapesEqual } from './layout/shape.js';
import {
  drawnThrough,
  invert,
  mapPoint,
  mapRect,
  multiply,
  outOfPlane,
  transformed,
} from './css/transform.js';
import type { Matrix } from './css/transform.js';
import {
  ViewTransitionRun,
  animationsEnd,
  captureClasses,
  captureName,
  groupTransform,
} from './transition.js';
import type { OldImage, Placement } from './transition.js';
import { TextLayoutCache } from './layout/cache.js';
import { fontAxes } from './layout/axes.js';
import { shapingSafe } from './layout/shaping.js';
import {
  coveredAfter,
  describe,
  describeShadows,
  liftOf,
  overLiftOf,
  partOf,
  shadowLiftOf,
  shadowPartOf,
  shadowsCovered,
  stillLiftOf,
} from './sprites.js';
import type {
  DocumentShadowSprite,
  DocumentSprite,
  Lift,
  Part,
  Pseudo,
  ShadowLift,
  ShadowPart,
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
  lineHeightOf,
  runFor,
} from './layout/inline.js';
import type { FontsLike } from './layout/inline.js';
import type { TextRun } from '../richtext/index.js';
// Through the inline module rather than a second cache: the offsets table for
// a layout is built once, on the first selection that needs it.
import {
  documentOffsetOf,
  emptyBoxPoint,
  emptyLinePoint,
  layoutOffsetOf,
  layoutOffsets as layoutOffsetsOf,
} from './layout/inline.js';
import { lineBands as bandsFor } from '../richtext/runs.js';
import {
  boundsAfterMove,
  inkAfterMove,
  clipFor,
  clipsOverflow,
  computePaintBounds,
  contentClipFor,
  containingBlockOf,
  coverersAfter,
  drawnAtViewport,
  scaleAround,
  drawnInkOf,
  drawsNothing,
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
  intersectionClips,
  apartFromLines,
  apartOf,
  layered,
  layerOf,
  onLine,
  opaqueCanvas,
  opaqueWithin,
  overflowClipRect,
  ownBounds,
  paintCapture,
  paintCover,
  paintDocument,
  paintLiftedBox,
  paintOrderOf,
  pathClips,
  queryChildIndex,
  selectedPieces,
  selectionRows,
  stackLayers,
  stacksLayers,
  topLayerBoxes,
} from './paint.js';
import type {
  MarginLength,
  PaintContext,
  PaintOptions,
  SpriteSource,
  TransitionDraw,
} from './paint.js';
import {
  AT_VIEWPORT,
  HELD_AT_VIEWPORT,
  controlRectsOf,
  heldAtRest,
  measureControl,
  shiftedBack,
  shownBy,
  styledField,
} from './controls.js';
import {
  isEditable,
  isEditingHost,
  isInert,
  isTabbable,
  tabindexStays,
} from './focus.js';
import type { FocusStop } from './focus.js';
import { inReadingOrder } from './reading.js';
import type { BareField, ControlRect, CoverAnswer } from './controls.js';
import { decodesImageType } from './image-types.js';
import { ResourceStore } from './resources.js';
import type { AnimatedImage } from './animated.js';
import type {
  AudioSource,
  PlayerKind,
  ResourceRequest,
  ResourceResult,
  VideoSource,
} from './resources.js';
import { ImageSources } from './srcset.js';
import type { SourceChanges, SourceEnv } from './srcset.js';
import { atDensity } from './svg.js';
import {
  askMedia,
  cutByFixed,
  embeddedRectsOf,
  FIXED_OVER,
  HELD_BY,
  HELD_OVER,
  mediaRectsOf,
  sameSounds,
  videoCandidates,
  videoSignature,
} from './media.js';
import type {
  Cover,
  EmbeddedRect,
  MediaAsked,
  MediaEventHandler,
  MediaEventKind,
  MediaRect,
  MediaState,
  Sound,
  VideoCandidate,
} from './media.js';
import type { IntrinsicSize } from './svg.js';
import { WebFonts } from './fonts.js';
import type { DeclaredFace, DocumentFontFace, FontMatch } from './fonts.js';
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
  /**
   * `src`, for an external script: resolved against the document's base
   * where it has one (`baseUrl`, a `<base href>`), as the URLs `onResource`
   * and `onLink` see are, and as written where it has none. An empty one
   * is handed over empty, since it names no script to fetch — HTML fires
   * the element's `error` for it — and resolved it would be the document.
   */
  src: string | null;
  /** The element's text, for an inline one. Handed over verbatim. */
  text: string;
  element: Element;
}

export interface HtmlViewProps {
  source: string;
  /** A tree to draw in place of parsing `source` (`HtmlSource.adopt`). */
  document?: Document;
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
   * The players with no picture (`Sound`): each `<audio>` a page's script
   * has played and not seen to its end, in the document or out of it, with
   * what it plays and what was asked of it — reported as one is played,
   * asked something, answered for or let go. Absent, no audio source is
   * asked for, and the page plays on unheard.
   */
  onSounds?: (sounds: Sound[]) => void;
  /** What a player with no picture said (`soundEvent`), for the page that
   *  played it. */
  onMediaEvent?: MediaEventHandler;
  /**
   * Where an `<iframe>`, a `<canvas>` or an `<embed>` is, for what a host
   * mounts over it (`renderEmbedded`), in the same space and at the same
   * moments as `onMedia`.
   */
  onEmbedded?: (rects: EmbeddedRect[]) => void;
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
  /** What the document asks of the box that scrolls it
   *  (`BoxTree.viewportOverflow`): reported after the first layout, and
   *  after a build that changed it. */
  onViewportOverflow?: (overflow: ViewportOverflow) => void;
  /** A scroll container in the document scrolled — by the wheel, or by
   *  `scrollElementTo` — told after it is drawn where it went: what a page
   *  hears as the element's `scroll`. */
  onElementScroll?: (element: Element) => void;
  /** The CSS transition events the document's transitions owe since the
   *  last were told, in order (`AnimationTimeline.takeCssEvents`):
   *  what a page hears as `transitionrun` and its kin. */
  onCssEvents?: (events: CssEventInfo[]) => void;
  /** What an `<img>` came to, for the image it asks for now (`askImage`):
   *  what a page hears as the element's `load` or `error`. An image told
   *  of is watched, one in no document with the rest, and a host with no
   *  use for it leaves it out and pays for none of that. */
  onImage?: (element: Element, outcome: 'load' | 'error') => void;
  /** The pane that scrolls the element — the nearest scroll container
   *  around it, the host's — scrolled: noticed as the element paints, which
   *  a scroll that moves the document under the pane's viewport makes it
   *  do. What a page's scripts hear as the window's `scroll`. */
  onViewportScroll?: () => void;
  /** The element painted: what a page's scripts hear the sizes their
   *  windows answer may have moved by — the pane's, which the element is
   *  laid out and painted again for, and an `<iframe>`'s box in it. */
  onPaint?: () => void;
  /** What a `<canvas>` shows: an image `ctx.drawImage` takes — an ntk
   *  `Image` of the canvas's pixels — or null for nothing, drawn in its
   *  content box as an `<img>` is. `canvasChanged` says it changed. */
  canvasImage?: (element: Element) => unknown | null;
  /** The parsed document, once per parse — the DOM handle. */
  onDocument?: (document: Document) => void;
  /** Bumped by the component to force a re-read of a mutated DOM. */
  domRevision?: number;
  /** Whether the document's CSS animations and animated images run.
   *  Default true. */
  animate?: boolean;
  /** Whether the desktop has asked for less motion: what
   *  `prefers-reduced-motion` is answered from. Default false. */
  reducedMotion?: boolean;
  /** Whether an editing host's caret blinks, and how long it stays in each
   *  state: the desktop's (`useDesktopSettings()`), and false — the desktop
   *  asking for a still caret — draws it solid. */
  caretBlink?: boolean;
  caretBlinkMs?: number;
  /** Whether the window has the keyboard (`useWindowState().focused`): a
   *  caret is drawn only where it does, as a browser draws one. Default
   *  true. */
  windowFocused?: boolean;
  /** Whether the host runs the document's scripts: a `<noscript>` is then
   *  drawn as nothing and nothing in it is asked for, and `@media
   *  (scripting: enabled)` holds. This runs none. Default false. */
  scripting?: boolean;
  /** The parse has ended: every element is in the tree, once a document. */
  onParsed?: () => void;
  /**
   * The parse waits at a script that blocks the parser (`blocksParser`),
   * which it has just closed and handed to `onScript`: given, the parse
   * stops after each such script's end tag, with nothing after it in the
   * tree, until the host has run it and says so through the handle's
   * `parserResume` — and what the script's `document.write` writes
   * meanwhile goes in after it, through `parserWrite` (`HtmlSource`).
   * Told a microtask later, once a script, as `onParsed` is told.
   */
  onParserBlocked?: (script: Element) => void;
  /** Everything the document asked for has arrived or failed, counted
   *  from its first complete layout, once a document. */
  onLoaded?: () => void;
  /** A `<link rel=stylesheet>`'s sheet came to something: `load` once a
   *  restyle has applied it and what it imports, `error` where it, or an
   *  import of it, is not to be had (`_tellSheets`) — and a sheet's
   *  `<link rel=preload>`, once the sheet arrived or failed. Once an
   *  `href`. */
  onSheet?: (element: Element, outcome: 'load' | 'error') => void;
  style?: Style | Style[];
}

/** Where an element is as `offsetParent`, `offsetLeft`, `offsetTop`,
 *  `offsetWidth` and `offsetHeight` measure it (`offsetRect`): from its
 *  offset parent's padding edge, in logical pixels, unrounded. */
export interface OffsetRect {
  /** Its `offsetParent`, or null where it has none. */
  parent: Element | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the fragment of the document's URL points (HTML's indicated part,
 * `HtmlViewNode.indicatedPart`): the text its text directives found, or
 * the element it names — where it is, in `elementRect`'s coordinates, and
 * how a viewport is scrolled to show it.
 */
export interface IndicatedPart {
  /** The element the fragment names, its `:target`; null for text. */
  element: Element | null;
  /** The text's rectangle, around all its lines, or the element's. */
  rect: Rect;
  /** Where in the viewport a browser scrolls it to: text to the middle
   *  (`scrollIntoView({ block: 'center' })`), an element to the top. */
  block: 'start' | 'center';
}

/**
 * What an `IntersectionObserver` measures of its targets
 * (`HtmlViewNode.intersectionsOf`), in `elementRect`'s coordinates.
 */
export interface ElementIntersections {
  /** The root's rectangle, before its margin; null for the viewport. */
  root: Rect | null;
  /** Each target's bounding box, and what of that the boxes around it
   *  leave to be seen as far as the root, null for none; null where it
   *  has no box, or is not in the root by containing blocks. */
  targets: ({ rect: Rect; shown: Rect | null } | null)[];
}

/** The text a URL's text directives name, as they were sought
 *  (`HtmlViewNode._seekTargetText`). */
interface TargetText {
  /** The fragment directive, as the URL wrote it. */
  directive: string;
  /** The document it was sought in. */
  document: Document;
  directives: TextDirective[];
  /** What each directive found, a DOM range, or null for nothing yet. */
  ranges: ({ sc: AnyNode; so: number; ec: AnyNode; eo: number } | null)[];
  /** The tree it was last sought in, and that tree's text. */
  sought: BoxTree | null;
  soughtText: string | null;
  /** Whether it is sought no more: every directive found. */
  done: boolean;
}

/**
 * What the component holds that the element does not — the controls'
 * widgets, the focus's boxes — reached through the element, where the
 * handle reaches it (`HtmlHandle`). Set by `<Html>`; null for an element
 * mounted without it.
 */
export interface DocumentInteraction {
  controlValue(el: Element): string | boolean | null;
  setControlValue(el: Element, value: string | boolean): boolean;
  controlSelection(el: Element): FieldSelection | null;
  setControlSelection(el: Element, selection: FieldSelection): boolean;
  showPicker(el: Element): boolean;
  focus(el: Element): boolean;
  /** Tell the document an element has the focus before its widget or its
   *  stop is there to take it — a control just put in, an element a modal
   *  dialog gave back to as it closed — as a script's `focus()` tells it
   *  before it returns (HTML 6.6.3); `focus` gives it core's once it can. */
  told(el: Element): void;
  blur(): void;
  activeElement(): Element | null;
  activate(el: Element): boolean;
  submit(form: Element, submitter: Element | null): void;
  reportValidity(
    form: Element,
    submitter: Element | null,
    attempt?: boolean,
  ): boolean;
  reset(form: Element): void;
}

export function registerHtmlView(): void {
  if (!registeredPositions().includes(AT_VIEWPORT)) {
    registerPosition(AT_VIEWPORT, { place: placeAtViewport });
  }
  if (!registeredPositions().includes(HELD_AT_VIEWPORT)) {
    registerPosition(HELD_AT_VIEWPORT, {
      options: { element: { type: 'any' }, drawn: { type: 'boolean' } },
      place: placeHeld,
    });
  }
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
    selfDamagedProps: [
      'watchStops',
      'onViewportScroll',
      'onPaint',
      'onCssEvents',
      'onImage',
      // what the caret is drawn by, which repaints the caret alone
      'caretBlink',
      'caretBlinkMs',
      'windowFocused',
    ],
    childrenAllowed: false,
  });
}

/**
 * How far to move a box in the `AT_VIEWPORT` position from where layout
 * put it: to where the element it is mounted beside draws its boxes fixed
 * to the viewport from (`viewportOrigin`) — the element in the nearest box
 * around it that holds one. Asked by core after every layout pass, the
 * pass a scroll runs included, so a widget in a fixed header lands with
 * the header in the frame that scrolled.
 */
function placeAtViewport(
  node: Node,
  context: PositionContext,
): { x: number; y: number } | null {
  const origin = viewAround(node)?.viewportOrigin();
  if (!origin) return null;
  return { x: origin.x - context.laidOut.x, y: origin.y - context.laidOut.y };
}

/**
 * How far to move a box in the `HELD_AT_VIEWPORT` position from where
 * layout put it: as far as the sticky boxes the viewport keeps hold the
 * control it is mounted for from where the flow has it. Asked as
 * `placeAtViewport` is, so a widget in a sticky sidebar lands with the
 * sidebar in the frame that scrolled.
 */
function placeHeld(
  node: Node,
  context: PositionContext,
): { x: number; y: number } | null {
  const { element, drawn } = context.options;
  return viewAround(node)?.heldShiftOf(element, node, drawn) ?? null;
}

/** The element a node mounted beside it belongs to: the one in the nearest
 *  box around the node that holds one, found by its kind, not its class,
 *  which a hot reload makes another. */
function viewAround(node: Node): HtmlViewNode | null {
  for (let at = node.parent; at; at = at.parent) {
    const view = at.children.find((child) => child.kind === ELEMENT);
    if (view) return view as HtmlViewNode;
  }
  return null;
}

/** How many times a layout's container sizes may build the boxes again
 *  (`HtmlViewNode._containersMoved`): once for each level of containers
 *  inside containers whose sizes their queries move, which documents do
 *  not nest deep, and never more — an answer that keeps changing its
 *  container's size is a cycle size containment is there to rule out. */
const CONTAINER_PASSES = 4;

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
/** What was at the top of what can be seen before a layout, and where
 *  (`_anchorBefore`): its box in the tree it was in, and its element, to
 *  find it by in a tree built since. */
interface Anchor {
  tree: BoxTree;
  box: Box;
  el: Element | null;
  y: number;
}

interface WarmingFonts {
  prewarm?(family: string, faces?: { weight: number; style: string }[]): void;
}

/** A scroll pane of core's, as `Scrollable` declares one. */
type ScrollPane = Node & {
  isScroller(): boolean;
  /** Its offsets, in device pixels. */
  scrollX: number;
  scrollY: number;
  /** How far what it scrolls reaches, in device pixels. */
  contentWidth: number;
  contentHeight: number;
  /** Scroll it, in logical pixels. */
  scrollTo(to: { x?: number; y?: number }): void;
};

/** The pane's offsets where a pass left them, and `abs` where that pass
 *  put the element (`_notePlaced`). */
interface PlacedAt {
  pane: ScrollPane;
  scrollX: number;
  scrollY: number;
  x: number;
  y: number;
}

/** A size container's content box as a layout left it, in device pixels:
 *  null where it has none, and undefined where the layout set it aside and
 *  its size stands (`Cascade.containersMoved`). */
function containerSizer(
  tree: BoxTree,
  boxes: Map<Element, Box>,
): (el: Element) => ContainerSize | null | undefined {
  return (el) => {
    const box = boxes.get(el);
    if (!box) return null;
    if (heldBack(tree, box)) return undefined;
    if (!containmentApplies(box, CONTAIN_INLINE_SIZE)) return null;
    return { width: box.contentWidth, height: box.contentHeight };
  };
}

/** How long the wheel rests on a snap container before it snaps: past the
 *  gap between one notch and the next of a turn. */
const WHEEL_SNAP_MS = 60;

/** What changed, and therefore how far back up the pipeline to go. */
const enum Stale {
  Nothing = 0,
  Layout = 1,
  Boxes = 2,
  Style = 3,
  Everything = 4,
}

export class HtmlViewNode extends Node {
  /** What `<Html>` holds, for the handle (`DocumentInteraction`). */
  interactive: DocumentInteraction | null = null;
  /** Whether the document may be left, as its scripts answer: the
   *  handle's `beforeUnload`. */
  unloadCheck: (() => boolean) | null = null;
  /** What a console typed, run by the document's scripts: the handle's
   *  `evaluate`. */
  evaluate: ((code: string) => ConsoleResult | null) | null = null;
  /** …a level of a value it kept, and every value let go: the handle's
   *  `inspectValue` and `releaseValues`. */
  inspectValue: ((id: number) => ConsoleProperty[] | null) | null = null;
  releaseValues: (() => void) | null = null;
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
  /** The sheets the cascade in force was made from, parsed, by their text
   *  (`_parseSheet`), and those the one being made takes. */
  private _parsed = new Map<string, ParsedSheet[]>();
  /** Whether the document's sheets may read otherwise than the cascade's
   *  were read, which a build makes the cascade again for before it styles
   *  anything (`_sheetsAdded`): a `<style>` a script put in or wrote to, a
   *  sheet that came. */
  private _sheetsOwed = false;
  /** How each shadow tree's sheets read, as `_restyle` last found them. */
  private _shadowKeys = new Map<ShadowRoot, string>();
  private _parsing: Map<string, ParsedSheet[]> | null = null;
  /** Each `<link>` and `<style>` whose sheet the cascade in force read,
   *  with the `href` a link's was read from and what the sheet imports
   *  (`_noteSheetsInForce`). */
  private _sheetsInForce = new Map<Element, SheetInForce>();
  /** The elements of the sheets the document had when its parse ended:
   *  the parser's, which alone hold a script back (`_blocksScripts`). */
  private _parserSheets: ReadonlySet<Element> = new Set();
  /** The scripts a host waits to run on the sheets before them
   *  (`scriptsUnblocked`). */
  private _scriptWaits: ScriptWait[] = [];
  /** The `href` each `<link>` was last told a `load` or an `error` for
   *  (`_tellSheets`). */
  private _sheetTold = new WeakMap<Element, string>();
  /** The same of a sheet's `<link rel=preload>`, apart: loadCSS makes the
   *  link a sheet's in its `onload`, and the sheet's `load` is told again. */
  private _preloadTold = new WeakMap<Element, string>();
  /** Each sheet text a shadow tree has read as, by a number
   *  (`_sheetsKey`). */
  private _sheetIds = new Map<string, number>();
  /** Blurred shadows, drawn once each. */
  private _shadowCache: SurfaceCache | null = null;
  /**
   * The rasters of the SVG images this has drawn at a size more than once
   * (`drawSvg`), and of the raster images drawn at another size than their
   * own (`drawRaster`), the least recently drawn given up first past the cache's
   * budget: what a single paint draws once is not kept, and a page painted
   * once keeps none. `_drawnOnce` is the keys drawn once. While the width
   * moves, a raster is made only of a key the paint before drew as well
   * (`_drawnLast`, and `_drawnNow` this paint's): each width of a drag is
   * a size of its own for whatever is sized from it, and one drawn again
   * later in the drag — a hand going back over the widths it came
   * through — was made into a raster that nothing copied.
   */
  private _drawings: SurfaceCache | null = null;
  private _drawnOnce = new Set<string>();
  private _drawnLast = new Set<string>();
  private _drawnNow = new Set<string>();
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
    animatesWithin: (box) => this._animatesWithin(box),
    stale: (box) => this._sprites?.takeStale(box) ?? null,
    context: (surface) =>
      this._sprites?.context(surface as SurfaceLike) ?? undefined,
    keep: (box, width, height, key, animated) =>
      (this._sprites ??= new SpriteStore(this.app)).make(
        box,
        width,
        height,
        key,
        animated,
        layoutShape(box),
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
    if (
      pseudo !== 'before' &&
      pseudo !== 'after' &&
      pseudo !== 'details-content'
    ) {
      return null;
    }
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
  /** The boxes whose shadows are offered as parts of their own this frame
   *  (`shadowLiftOf`), and those a presenter has on layers, by sprite key:
   *  each an element whose outer shadows the document leaves out of its
   *  paint and its damage, and whose box it draws as it always did. */
  private _offeredShadows = new Map<string, Element>();
  private _shadowsLifted = new Map<string, Element>();
  /** What each element's shadows were last offered as, and what it was
   *  made from. */
  private _shadowOffers = new WeakMap<
    Element,
    { stamp: string; part: ShadowPart | null }
  >();
  /** The boxes `_shadowsLifted` names in a tree (`_shadowlessBoxes`). */
  private _shadowlessCache: {
    tree: BoxTree;
    lifted: Map<string, Element>;
    boxes: ReadonlySet<Box>;
  } | null = null;
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
  private _mediaBand = '';
  /** The viewport the box tree's styles were computed at, for the ones
   *  that read it (`vw`, `vh`). */
  private _styledWidth = -1;
  private _styledHeight = -1;
  /** The cascade the box tree's styles were computed by. */
  private _styledWith: Cascade | null = null;
  /** A cascade made again for sheets that only added rules, which the
   *  styles the boxes have are kept under, but for what those rules can
   *  style (`_sheetsAdded`). Not the one they were styled with
   *  (`_styledWith`): what a change of sheets makes is no change to
   *  transition through (`_previousStyle`). */
  private _keptFor: Cascade | null = null;
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
  /**
   * A drag the document cannot keep up with is drawn cheaper while it
   * moves (`_behind`): the document's clock makes no frame of its
   * animations, which play on from where their time has got to once it
   * rests, and what is drawn at each frame of it is copied where it can
   * be (`DragPaint`). Whether it is; the element's own work
   * since the last paint, timed on `frameClock` (`_counted`), and whether
   * a timed call is under way; whether a layout at another width came
   * since; of the last frames of the drag drawn as at rest, newest last,
   * whether each ran past `FRAME_BUDGET_MS`; and whether anything was
   * drawn cheaper, for the paint once the drag rests to draw as at rest.
   */
  private _cheap = false;
  private _work = 0;
  private _timing = false;
  private _laidSincePaint = false;
  private _overBudget: boolean[] = [];
  private _drawnCheaper = false;
  /** When the last frame of the drag under way was painted. */
  private _dragFrameAt = -Infinity;
  /** The tile each background layer was drawn at in the drag under way, by
   *  the layer's style, or true for one drawn at two sizes: whose size
   *  moves with the drag, and which a drag drawn cheaper steps
   *  (`DragPaint.moved`). */
  private _tileSizes = new WeakMap<object, [number, number] | true>();
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
  /** The element the fragment of the document's URL names, `:target`
   *  (`_updateBase`). */
  private _target: Element | null = null;
  /** The text the fragment's text directives name, `::target-text`
   *  (`_seekTargetText`); null where it has none. */
  private _targetText: TargetText | null = null;
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
  /** The animations the page's scripts made (`setScriptAnimation`), which
   *  run on the timeline's clock as a CSS animation does. The page's to
   *  make and end, so they outlive a timeline made again. */
  private _scripts = new ScriptAnimations();
  /** The timer for the next frame of an animation, and when it is due. */
  private _frameTimer: unknown = null;
  private _frameAt = Infinity;
  /**
   * The animated images painted since their frame last moved on: the frame
   * each was painted at, the tree it was painted in, and the boxes that drew
   * it — or null, for one drawn outside any box's paint. What `_gifFrame`
   * repaints when the frame moves on, and only that: a box no paint reached
   * since, scrolled out of view or under something opaque, is not asked
   * again until one does.
   */
  private _gifs = new Map<
    AnimatedImage,
    { index: number; tree: BoxTree | null; boxes: Set<Box | null> }
  >();
  /** The timer for the next frame of an animated image, and when it is due. */
  private _gifTimer: unknown = null;
  private _gifAt = Infinity;
  /**
   * The elements the build of the boxes that is due has to style again,
   * where every change asking for it said which (`_invalidate`), and null
   * where any element's style may have changed — a new cascade, a viewport
   * a `vw` reads, a face that arrived.
   */
  private _restyleOnly: Set<Element> | null = null;
  /** The elements whose boxes the build that is due can make otherwise,
   *  where every change it is for said which (`_invalidate`'s `seeds`):
   *  what a build of only their subtrees builds (`_subtreeBuild`). Null
   *  where the whole tree is to be built. */
  private _buildSeeds: Set<Element> | null = null;
  /** Of `_buildSeeds`, those built whatever their styles come to
   *  (`ChangeScope.always`), and which pseudo-elements' rules read what
   *  changed: any other seed is built where its style comes out otherwise
   *  (`_seedsThatMoved`). */
  private _buildAlways: Set<Element> | null = null;
  private _buildPseudo: 0 | 1 | 2 = HOVER_PSEUDO_NONE;
  /** And what holds what a stream's chunks touched, by the first child of
   *  it each touched (`ChangeScope.tails`): the ends of what it holds are
   *  all a build of subtrees builds of it. Null where none is said. */
  private _buildTails: Map<ParentNode, ChildNode | null> | null = null;
  /** Whether every change the build is for was a stream's chunk, which
   *  puts nodes in and moves and takes away none (`SubtreeRoots.
   *  appendOnly`). */
  private _buildParsed = false;
  /** Whether `_restyleOnly` names the elements whose own styles a change
   *  may have changed and not what is under them, which is styled again
   *  where its parent's style came out other than it was (`KeptStyles.
   *  follow`) — what a change to the tree says (`_restyleChanged`). */
  private _restyleFollows = false;
  private _scriptsSeen = new WeakSet<Element>();
  private _controls: ControlRect[] = [];
  /** Where the boxes fixed to the viewport were drawn from where they were
   *  laid out when the controls were last reported: they cut a widget
   *  where they come over it (`controlRectsOf`). */
  private _controlsShift: { x: number; y: number } | null = null;
  /** What was over each control when it was last asked, which a report for
   *  a scroll keeps for the controls outside the viewport. */
  private _covered = new Map<Element, CoverAnswer>();
  /** The players mounted over the document (`media.ts`): where layout put
   *  each, in device pixels, before the boxes fixed to the viewport cut
   *  them; what `onMedia` was last told; and the elements they are over,
   *  for the paint. */
  private _mediaLaid: MediaRect[] = [];
  private _media: MediaRect[] = [];
  /** What the document paints over each player, as the last layout left
   *  it (`coversOf`, `paintCovers`). */
  private _covers = new Map<Element, Cover[]>();
  /** The same of what a host mounts over the embedded elements. */
  private _embeddedLaid: EmbeddedRect[] = [];
  private _embedded: EmbeddedRect[] = [];
  private _mounted: ReadonlySet<Element> = new Set();
  /** Each video's size once its player knows it, in CSS pixels: its
   *  intrinsic size from then on, where its poster's was (HTML 4.8.11.6). */
  private _videoSizes = new WeakMap<Element, IntrinsicSize>();
  /** What was asked of each video's player — by the page's scripts, or by
   *  a press on one with `controls` (`setMediaState`) — laid over what its
   *  markup says as it is reported. By element, so a player mounted again
   *  is told it too. */
  private _mediaAsked = new WeakMap<Element, MediaAsked>();
  /** The `<audio>` elements a page's script has played and that have not
   *  reached their end since (`setMediaState`, `soundEvent`), in the order
   *  each was first played; and what `onSounds` was last told. */
  private _sounding = new Set<Element>();
  private _sounds: Sound[] = [];
  /** The sources each video chose between, and what it chose them from
   *  (`_videoChoice`). */
  private _videoChoices = new WeakMap<
    Element,
    { signature: string; candidates: VideoCandidate[] }
  >();
  /** The focusable areas last reported (`_reportStops`), and where the
   *  watched ones were. */
  private _stops: readonly FocusStop[] = [];
  private _watchedRects = new Map<Element, Rect | null>();
  /** Where each scroll container in the document is scrolled to, by its
   *  element, in CSS pixels (`layout/scroll.ts`): kept across builds and
   *  layouts, each of which moves the boxes it lays out by them again, and
   *  for the document they are elements of. */
  private _scrollOffsets = new Map<Element, ScrollOffset>();
  private _scrollOffsetsOf: Document | null = null;
  /** Where the wheel last turned over the document, in logical window
   *  pixels: what `canScroll` finds a scroll container under. */
  private _wheelAt: { x: number; y: number } | null = null;
  private _widgets: ReadonlySet<Element> = new Set();
  private _widgetsOf: ControlRect[] | null = null;
  private _reportedDomRevision = -1;

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
    const ask = (request: ResourceRequest) =>
      this._props().onResource?.(request) ?? null;
    this._resources = new ResourceStore(
      ask,
      (what, layout, lazily) => {
        // A late stylesheet is a new cascade: its rules, what it imports,
        // the faces it declares. A late image changes intrinsic sizes, so
        // the box tree is what has to be rebuilt — not merely repainted —
        // where anything its size lays out asked for it; one only a
        // background, a border image or a mask paints changes no box, and
        // is painted (`_imagePainted`). An image's size can come before its
        // pixels, read from its header while they decode, and is laid out
        // then with nothing new to paint; a decode that came to another
        // size, or to none, builds the boxes again around kept styles.
        // Either arriving after first paint is the ordinary case, not an
        // error path: a host on a network answers every request that way.
        // A video's source changes no box: a player goes over one. A sheet
        // declined that late changes no style either, but the first
        // rendering may be held for it.
        if (what === 'video') this._reportMedia();
        else if (what === 'audio') this._publishSounds();
        // a sheet only a `<link rel=preload>` asked for: nothing reads it
        // yet, and its `load` is told as the request settles
        else if (what === 'stylesheet' && !layout) return;
        else if (what === 'declined') {
          // nothing to restyle, but a first rendering may have waited on it
          if (!this._tree) this._invalidate(Stale.Style);
        } else if ((what === 'image' || what === 'resized') && !layout) {
          this._imagePainted();
        } else if (what === 'image') this._imageArrived(true, lazily);
        else if (what === 'sized') this._imageArrived(false, lazily);
        else if (what === 'resized') this._invalidate(Stale.Boxes, EMPTY_SET);
        else if (what === 'stylesheet' && this._tree && this._cascade) {
          // a sheet as one more of the document's, whose rules style what
          // they can style (`_sheetsAdded`), and whose boxes are all a build
          // has to make: each sheet GitHub links late built and laid out the
          // whole page for the few dozen elements it styles
          this._sheetsOwed = true;
          this._invalidate(Stale.Boxes, EMPTY_SET, true, EMPTY_SET);
        } else {
          this._invalidate(what === 'stylesheet' ? Stale.Style : Stale.Boxes);
        }
      },
      this._urls,
    );
    // a request that came to nothing changes nothing the layout reads, and
    // still counts to the document's `load`
    this._resources.settled = (key) => {
      this._imageSettled(key);
      this._lifecycle();
    };
    this._images = new ImageSources({
      request: (url, element) => {
        if (this._waitsLazily(element, url)) return;
        this._resources.request(
          { url, kind: 'image', element },
          false,
          this._waited.has(element) && 'lazily',
        );
      },
      state: (url) => this._resources.state(url),
      sized: (url) => this._resources.imageSize(url) !== null,
    });
    this._webFonts = new WebFonts(
      app,
      ask,
      () => {
        // A face arrived, or will not, which has the next one asked for.
        // The frame takes every face that came by then (`_takeFaces`).
        this._facesOwed = true;
        this._invalidate(Stale.Layout);
      },
      'sans-serif',
    );
    // before the first scan: a document that runs scripts asks for nothing
    // in a `<noscript>`, from its first render on
    this._source.setScripting(this._props().scripting ?? false);
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
   *  window resolved to, times every `scale` prop around it. */
  private get _scale(): number {
    return this.scale > 0 ? this.scale : 1;
  }

  /** The scale the document's styles were last computed at: what every
   *  length they hold is device pixels of. */
  private _styledAt = 0;

  /**
   * Style the document again where its scale moved since it was styled: a
   * `scale` prop around the element changed (core's `docs/scale.md`, "A
   * subtree of its own"), as a frame's does when a script sets the zoom of
   * the `<iframe>` it is drawn in. Core lays the element out again, at a
   * width that may be the one it had, so nothing else here would see it: a
   * leaf frame laid out in device pixels at its old scale came out at the
   * CSS size of the box it was drawn in.
   */
  private _followScale(): void {
    if (this._styledAt === 0 || this._styledAt === this._scale) return;
    this._styledAt = this._scale;
    this._restyleOnly = null;
    if (this._stale < Stale.Style) this._stale = Stale.Style;
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
    follow = false,
    /** The elements whose boxes it can make otherwise, where the change
     *  said (`_buildSeeds`): none, for one that did not. */
    seeds: ReadonlySet<Element> | null = null,
    /** And what holds what it touched, from where (`ChangeScope.tails`,
     *  `ChangeScope.ends`). */
    tails: ReadonlyMap<ParentNode, ChildNode | null> | null = null,
    /** Whether all of it is a stream's chunks' (`_buildParsed`). */
    parsed = tails !== null,
    /** Of `seeds`, those built whatever their styles come to, and which
     *  pseudo-elements' rules read what changed (`_buildAlways`). */
    always: ReadonlySet<Element> | null = seeds,
    pseudo: 0 | 1 | 2 = HOVER_PSEUDO_NONE,
  ): void {
    this._geometry += 1;
    if (stale >= Stale.Boxes) {
      const only = stale === Stale.Boxes ? restyle : null;
      const seeded = only !== null && seeds !== null;
      if (this._stale < Stale.Boxes) {
        this._restyleOnly = only ? new Set(only) : null;
        this._restyleFollows = follow;
        this._buildSeeds = seeded ? new Set(seeds) : null;
        this._buildAlways = seeded ? new Set(always) : null;
        this._buildPseudo = pseudo;
        this._buildTails = seeded && tails ? new Map(tails) : null;
        this._buildParsed = seeded && tails !== null && parsed;
      } else if (this._restyleOnly && only) {
        for (const el of only) this._restyleOnly.add(el);
        // styling what follows a change of its parent's style again as
        // well styles more, and never less, than either asked
        if (follow) this._restyleFollows = true;
        if (this._buildSeeds && seeded) {
          this._buildTails = mergeTails(
            this._buildSeeds,
            this._buildTails,
            seeds,
            tails,
          );
          if (!tails || !parsed) this._buildParsed = false;
          for (const el of seeds) this._buildSeeds.add(el);
          for (const el of always ?? seeds) this._buildAlways?.add(el);
          if (pseudo > this._buildPseudo) this._buildPseudo = pseudo;
        } else {
          this._buildSeeds = null;
          this._buildAlways = null;
          this._buildTails = null;
        }
      } else {
        this._restyleOnly = null;
        this._buildSeeds = null;
        this._buildAlways = null;
        this._buildTails = null;
      }
    }
    if (stale > this._stale) this._stale = stale;
    if (stale >= Stale.Layout) this.invalidateMeasure('content');
    this.invalidate(stale >= Stale.Layout, this, 'props');
  }

  // --- what can wait --------------------------------------------------------
  //
  // Nobody sees the want of what is off screen, so a change there waits
  // until it is scrolled near, the thread is idle or a read needs it
  // (`_owe`). The document stays whole while it waits: an owed box is drawn
  // as it was, is hit where it is drawn, and is moved by the layouts around
  // it as any block they keep (`reuseLaid`). Nothing is set aside, so a
  // scroll onto it finds it there. What lets it wait is the layout's: a
  // block its last layout laid out is kept for as long as nothing forgot
  // it, so the work a box owes starts by forgetting it (`forgetSizesIn`).

  /** Whether a face came or failed since the styles took them in. */
  private _facesOwed = false;
  /** What each box is owed, in document order (`_owe`). */
  private _owed = new Map<Box, OwedWork>();
  /** The elements styled again with the boxes they are in: those that read
   *  a face (`_takeFaces`). */
  private _owedStyles = new Map<Box, Element[]>();
  /** The owed boxes drawn where the viewport is, wherever they are laid out:
   *  each is seen, whatever its place in the document. */
  private _owedFixed = new Set<Box>();
  /** Of it, what no scroll need bring in early (`_oweSize`). */
  private _owedSlight = new Set<Box>();
  /** What the next `_update` is to run of it (`OWED_ALL`, or how many). */
  private _owedAsk = 0;
  /** Whether what it ran can be seen, and is to be painted. */
  private _owedShown = false;
  private _owedTimer: unknown = null;
  /** How many boxes a slice takes, found from how long the last took, and
   *  how many slices what is owed has left to it. */
  private _owedChunk = 8;
  private _owedSlices = OWED_SLICES;
  /** When a scroll or a key was last seen. */
  private _inputAt = -Infinity;
  /** Where the top of what can be seen was when what is near it was last
   *  asked after. */
  private _owedTop = 0;
  /** Whether the document came to another size that the pane has not been
   *  told, and when it last was. */
  private _measureOwed = false;
  private _measuredAt = -Infinity;

  /**
   * Put off what a box needs, until it is near what can be seen, the thread
   * is idle, or a read of the page's needs it (`_settle`). `work` is handed
   * the box and the boxes the same run has been up from: it brings the box
   * up to date for the layout that follows, as `forgetSizesIn` forgets what
   * is kept of it. What a document looks like until then has to be what it
   * looked like: anything that joins draws the box as it was, and asks
   * nothing of what the work would change. See "What can wait" in AGENTS.md.
   */
  private _owe(box: Box, work: OwedWork): void {
    const was = this._owed.get(box);
    this._owed.set(
      box,
      was && was !== work
        ? (at, up) => {
            was(at, up);
            work(at, up);
          }
        : work,
    );
    this._armOwed(OWED_REST_MS);
  }

  private _armOwed(ms: number): void {
    if (this._owedTimer !== null) return;
    this._owedTimer = owedClock.arm(() => {
      this._owedTimer = null;
      this._owedSlice();
    }, ms);
  }

  /** Nothing is owed: a build made every box again (`_update`). */
  private _owedDone(): void {
    this._owed.clear();
    this._owedStyles.clear();
    this._owedFixed.clear();
    this._owedSlight.clear();
    this._owedAsk = 0;
    this._webFonts.arrivals();
  }

  /**
   * The faces that came, taken in. What a face changes in a style is its
   * family list, and what it changes in a box is the text set in it: so the
   * lists change where they are, in every style there is, which costs a
   * walk and no cascade, and every box of text set in such a face owes
   * setting again (`_setAgain`). A style is made new only where it read a
   * length from a face (`readsFace`), and that waits with its box. Where
   * nothing can keep a box laid out, or a whole build is coming, the build
   * takes them.
   */
  private _takeFaces(): void {
    this._facesOwed = false;
    const tree = this._tree;
    const cascade = this._cascade;
    const fonts = this._webFonts;
    const layouts = this._layouts;
    this._layouts = null;
    cascade?.facesChanged();
    if (
      !tree ||
      !cascade ||
      !layouts ||
      this._laidOutWidth < 0 ||
      (this._stale >= Stale.Boxes && !this._restyleOnly) ||
      tree.anchors ||
      tree.vertical ||
      tree.firstLine ||
      tree.foreign
    ) {
      this._owedDone();
      // inside `_update`, and the arrival asked for the frame
      this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
      this._restyleOnly = null;
      this._buildSeeds = null;
      this._buildAlways = null;
      this._buildTails = null;
      return;
    }
    // Set in other faces from here on, and what is laid out in the old ones
    // made again from what it was made from (`reinked`)
    this._layouts = new TextLayoutCache(layouts.engine, layouts);
    // a face that failed has the next asked for, and one answered at once
    // is among those taken below
    fonts.request(textOfTree(tree));
    const affects = fonts.arrivals();
    const seen = new Set<ComputedStyle>();
    const take = (style: ComputedStyle): void => {
      if (seen.has(style)) return;
      seen.add(style);
      if (style.familyWritten)
        style.fontFamily = fonts.map(style.familyWritten);
    };
    const readers = new Set<Element>();
    const parents = new Map<Element, ComputedStyle | undefined>();
    for (const [el, { style }] of tree.styles) {
      take(style);
      if (!affects || !readsFace(style)) continue;
      let above = parents.get(el);
      if (!parents.has(el)) {
        const parent = flatParentOf(el);
        above = parent ? tree.styles.get(parent)?.style : undefined;
        parents.set(el, above);
      }
      if (affects(style) || (above && affects(above))) readers.add(el);
    }
    for (const style of anonymousMade(tree.anonymous)) take(style);
    if (tree.impliedHtml) take(tree.impliedHtml);
    take(tree.root.style);
    const owners = new Map<Box, Box>();
    const aside = asideOf(tree);
    const stack: Box[] = [tree.root];
    while (stack.length) {
      const box = stack.pop()!;
      take(box.style);
      const marker = box.marker?.style;
      if (marker) take(marker);
      if (affects) {
        // and the lines a block's own font holds open, whatever is on them
        if (
          (box.kind === 'text' ||
            box.kind === 'inline' ||
            box.lines ||
            box.marker) &&
          (affects(box.style) || (marker && affects(marker)))
        ) {
          this._oweSetting(ownerOf(box, owners), tree);
        }
        // built from the face: a widget's size, a drawing's text
        if (box.el && READS_FACE_AS_BUILT.has(box.replaced)) {
          if (affects(box.style) && setsText(box)) readers.add(box.el);
        }
      }
      const children = aside?.get(box) ?? box.children;
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
    if (readers.size) {
      const first = this._firstBoxesOf(tree);
      for (const el of readers) {
        this._stylesOwed.add(el);
        const box = first.get(el);
        if (!box) continue;
        const owner = ownerOf(box, owners);
        this._oweSetting(owner, tree);
        const held = this._owedStyles.get(owner);
        if (held) held.push(el);
        else this._owedStyles.set(owner, [el]);
      }
    }
    this._warmFaces(tree);
    this._owedTop = this._seenTop();
    this._owedAsk ||= this._owedChunk;
    this._owedSlices = OWED_SLICES;
  }

  /** Owe a box that its text be set again (`_setAgain`). */
  private _oweSetting(box: Box, tree: BoxTree): void {
    if (this._owed.get(box) === this._setAgain) return;
    this._owe(box, this._setAgain);
    if (FIXED_BOXES.has(tree) && drawnAtViewport(box)) this._owedFixed.add(box);
  }

  /** What a box whose text is in a face that came is owed: its layout laid
   *  out again in the style it has, and the surfaces kept of how it looked
   *  drawn again. */
  private readonly _setAgain: OwedWork = (box, up) => {
    forgetSizesIn(box, up);
    this._dropSprites(box, true);
  };

  /**
   * Run what is owed: everything, or what can be seen and as much of the
   * rest as `ask` says, nearest first, below what can be seen before above
   * it, whose height the pane has to follow (`_keepAnchor`). Answers the
   * elements whose styles it owed with them, to be styled and built.
   */
  private _settleOwed(ask: number): Set<Element> {
    const reached = new Set<Element>();
    const owed = this._owed;
    if (!owed.size) return reached;
    const top = this._seenTop();
    const bottom = this._seenBottom();
    const picked: Box[] = [];
    const after: Box[] = [];
    const before: Box[] = [];
    for (const box of owed.keys()) {
      if (ask === OWED_ALL) {
        picked.push(box);
      } else if (
        this._owedFixed.has(box) ||
        (box.y < bottom && box.y + box.height > top)
      ) {
        picked.push(box);
        this._owedShown = true;
      } else if (box.y >= bottom) {
        after.push(box);
      } else before.push(box);
    }
    if (ask !== OWED_ALL) {
      // the nearest either way while they are near, and then what is below
      // before what is above
      const near = this._viewportHeight() * OWED_NEAR;
      let below = 0;
      let above = before.length - 1;
      for (let left = ask; left > 0; left -= 1) {
        const a: Box | undefined = after[below];
        const b: Box | undefined = before[above];
        const to = b ? top - (b.y + b.height) : Infinity;
        const up = to <= near && to < (a ? a.y - bottom : Infinity);
        const box = up || !a ? b : a;
        if (!box) break;
        picked.push(box);
        if (box === a) below += 1;
        else above -= 1;
      }
    }
    const up = new Set<Box>();
    for (const box of picked) {
      owed.get(box)!(box, up);
      owed.delete(box);
      this._owedFixed.delete(box);
      this._owedSlight.delete(box);
      const held = this._owedStyles.get(box);
      if (!held) continue;
      this._owedStyles.delete(box);
      for (const el of held) {
        this._stylesOwed.delete(el);
        reached.add(el);
      }
    }
    return reached;
  }

  /** Everything owed run, for a read of the page's: what it reads is what
   *  a browser would answer, whatever is drawn. */
  private _settle(): void {
    if (this._owed.size || this._facesOwed) {
      this._owedAsk = OWED_ALL;
      this._measureOwed = true;
      if (this._stale < Stale.Layout) this._stale = Stale.Layout;
    }
    this._prepare(this.abs.width || 1);
  }

  /** Everything owed run, for a host's read of what is laid out. */
  settle(): void {
    this._settle();
  }

  /** Whether a box may yet move as what is owed runs. */
  layoutOwed(): boolean {
    return this._owed.size > 0 || this._facesOwed;
  }

  /** Whether anything in a box is owed, or the box is. */
  private _owes(box: Box): boolean {
    for (const owed of this._owed.keys()) {
      for (let at: Box | null = owed; at; at = at.parent) {
        if (at === box) return true;
      }
    }
    return false;
  }

  /** A key was pressed: what is owed waits (`OWED_QUIET_MS`). */
  noteInput(): void {
    this._inputAt = owedClock.now();
  }

  /**
   * What the pane shows moved: what is owed near it is run in a frame, and
   * the rest waits for the scroll to end.
   */
  private _followOwed(): void {
    // asked at the paint's end, where what the frame asked of the pane has
    // landed, and counted twice its shift was a reader's scroll
    this._painting = true;
    try {
      const top = this._seenTop();
      if (top === this._owedTop) return;
      const moved = Math.abs(top - this._owedTop);
      this._inputAt = owedClock.now();
      if (moved * 4 < this._viewportHeight()) return;
      this._owedTop = top;
      this._runNear(this._viewportHeight() * OWED_NEAR);
    } finally {
      this._painting = false;
    }
  }

  /** What is owed within `near` of what can be seen, run in a frame. */
  private _runNear(near: number): void {
    const from = this._seenTop() - near;
    const to = this._seenBottom() + near;
    for (const box of this._owed.keys()) {
      if (this._owedSlight.has(box)) continue;
      if (box.y < to && box.y + box.height > from) {
        this._owedAsk ||= this._owedChunk;
        this._invalidate(Stale.Layout);
        return;
      }
    }
  }

  /**
   * A slice of what is owed, with nothing waiting on the thread: laid out
   * here, between frames, as an owed layout is (`_layoutOwed`), and as much
   * of it as `OWED_SLICE_MS` holds, found from how long the last took. What
   * it moved is off screen, so nothing is painted for it; the pane follows
   * what moved above what it shows (`_keepAnchor`), and is told how tall
   * the document came to be only so often, since that repaints all it
   * shows.
   */
  private _owedSlice(): void {
    if (this.destroyed || !this._owed.size) return;
    const quiet = this._inputAt + OWED_QUIET_MS - owedClock.now();
    if (quiet > 0) {
      this._armOwed(quiet);
      return;
    }
    if (
      this._stale !== Stale.Nothing ||
      this._partial ||
      this._laidOutWidth < 0
    ) {
      this._armOwed(OWED_REST_MS);
      return;
    }
    const from = frameClock.now();
    this._owedAsk = this._owedChunk;
    this._stale = Stale.Layout;
    this._prepare(this.abs.width || 1);
    const took = frameClock.now() - from;
    // A slice costs what it sets and a layout of all that is kept, which a
    // page of boxes no layout keeps pays whatever is in the slice: as many
    // slices as what waits there would be that layout many times over. So
    // they are no more than `OWED_SLICES`, and only a few where even a
    // small one took a long task's time.
    this._owedSlices = Math.max(
      1,
      took >= OWED_LONG_MS
        ? Math.min(OWED_FEW, this._owedSlices - 1)
        : this._owedSlices - 1,
    );
    this._owedChunk = Math.max(
      1,
      Math.min(
        this._owedChunk * 2,
        Math.round((this._owedChunk * OWED_SLICE_MS) / Math.max(took, 1)),
      ),
      Math.ceil(this._owed.size / this._owedSlices),
    );
    // what moved may be in view, where something is centred in what grew,
    // so the slices end in a paint of what the pane shows whatever they did
    this._measureOwed = true;
    if (this._owedShown) {
      this._owedShown = false;
      this.invalidate(true, this, 'props');
    }
    const now = owedClock.now();
    if (
      this._measureOwed &&
      (!this._owed.size || now - this._measuredAt >= OWED_MEASURE_MS)
    ) {
      this._measureOwed = false;
      this._measuredAt = now;
      this.invalidateMeasure('content');
      this.invalidate(true, this, 'props');
    }
    if (this._owed.size) this._armOwed(Math.max(OWED_REST_MS, took));
  }

  /**
   * A layout owed for lengths a restyle took in place (`_resizedInPlace`),
   * laid out at once, as a frame's build is (`_rebuildFrame`), and what it
   * moved and reshaped repainted (`_claimLaidOut`): only the layout says
   * what that is, and core's measure of the element, which would ask for
   * it in the frame, claims all the element shows, before and after. A
   * playground's divider sets its panes' `flex` at every step of a drag,
   * which moves nothing outside the playground, and each step repainted
   * all of joshwcomeau.com's article in view. Where something else is
   * owed already, or the document comes out another size, the element is
   * measured and repainted whole, as before.
   */
  private _layoutOwed(resized: readonly Box[]): void {
    const width = this._laidOutWidth;
    if (this._stale !== Stale.Nothing || !this._tree || width < 0) {
      this._invalidate(Stale.Layout);
      return;
    }
    this._stale = Stale.Layout;
    const shapes = this._laidShapes();
    this._prepare(width);
    if (!this._claimLaidOut(shapes, new Set(resized))) {
      this.invalidateMeasure('content');
      this.invalidate(true, this, 'props');
    }
  }

  /** Each box as the last layout left it, for an owed layout's damage to be
   *  found by (`_claimLaidOut`); null where that layout is not the one
   *  owed — a build is, or a box is set aside. */
  private _laidShapes(): LaidShapes | null {
    const tree = this._tree;
    if (!tree || this._stale !== Stale.Layout || asideIn(tree)) return null;
    const boxes = new Map<Box, LaidShape>();
    const stack: Box[] = [tree.root];
    while (stack.length) {
      const box = stack.pop()!;
      boxes.set(box, {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        lines: box.lines,
        markerX: box.marker?.x ?? NaN,
        markerY: box.marker?.y ?? NaN,
        ink: boundsOf(box),
      });
      for (const child of box.children) stack.push(child);
    }
    return {
      tree,
      width: this._laidOutWidth,
      size: [this._documentWidth, this._documentHeight],
      boxes,
    };
  }

  /**
   * Claim what an owed layout changed (`_layoutOwed`): where and as large
   * as each box was and is — its ink, and so all it holds — for each box
   * it moved, resized or set other lines in, and each of the `resized`,
   * whose own lengths may draw it otherwise where it is — a background
   * from its content box, after a padding — and nothing for the rest.
   * False where that cannot be said, for the whole element to be: another
   * tree, another width or height of the document, a box drawn through a
   * matrix around what changed, which its bounds before do not place, or
   * more changes than a few rects hold.
   */
  private _claimLaidOut(
    shapes: LaidShapes | null,
    resized: ReadonlySet<Box>,
  ): boolean {
    const tree = this._tree;
    if (
      !shapes ||
      !tree ||
      tree !== shapes.tree ||
      this._stale !== Stale.Nothing ||
      this._failedAt !== -1 ||
      this._laidOutWidth !== shapes.width ||
      this._documentWidth !== shapes.size[0] ||
      this._documentHeight !== shapes.size[1] ||
      asideIn(tree)
    ) {
      return false;
    }
    const inks: Rect[] = [];
    const changed: Box[] = [];
    const stack: Box[] = [tree.root];
    while (stack.length) {
      const box = stack.pop()!;
      const was = shapes.boxes.get(box);
      if (!was || changed.length > CLAIMED_SHAPES) return false;
      // what a box reshaped holds is in its ink, before and after
      if (!resized.has(box) && !reshaped(box, was)) {
        for (const child of box.children) stack.push(child);
        continue;
      }
      for (let at: Box | null = box; at; at = at.parent) {
        if (drawnThrough(at.style)) return false;
      }
      changed.push(box);
      const shift = drawnAtViewport(box) ? this._fixedShift() : null;
      for (const ink of [was.ink, boundsOf(box)]) {
        if (!ink) continue;
        inks.push(
          shift ? { ...ink, x: ink.x + shift.x, y: ink.y + shift.y } : ink,
        );
      }
    }
    // a lifted box's pixels are its layer's, painted again in a frame
    if (this._lifted.size && changed.some((box) => this._insideLifted(box))) {
      this.spritesChanged();
    }
    // what the pane shows of each, which is all that is drawn: one far
    // down the document, made one rect with the rest, stretched it down to
    // the viewport's foot. What a scroll brings into view is painted then.
    const shown = this._viewportInDocument();
    const seen: Rect[] = [];
    for (const ink of inks) {
      const part = shown ? rectWithin(ink, shown) : ink;
      if (part) seen.push(part);
    }
    // and the ones that meet as one: a box's ink before and after are
    // most of each other, which core keeps as pieces apart and paints a
    // pass a piece — a pane and its neighbour were six passes a step
    this._repaintInk(mergeMeeting(seen));
    return true;
  }

  /** Take the props' source into the parser. Cheap when nothing changed, and
   *  an append when the new source extends the old — see `HtmlSource`. */
  private _read(): void {
    const props = this._props();
    // a parse that waits for its scripts, where a host runs them: turned
    // off while it waits, it reads on to the end of what it has
    const released = this._source.setYields(!!props.onParserBlocked);
    const changed = props.document
      ? this._source.adopt(props.document)
      : this._source.setSource(props.source ?? '', props.complete !== false);
    if (changed) {
      // A stream's chunk restyles and builds what it reaches, as a change
      // an application tells of does (`touchDocument`): the nodes the
      // parser put in, at the ends of what was open, and the texts it wrote
      // on to (`HtmlSource.takeAppended`). Where that cannot be said, every
      // element is styled again.
      const appended = this._source.takeAppended();
      if (released || !appended || !this._parsedChanges(appended)) {
        this._invalidate(Stale.Style);
      }
      props.onDocument?.(this._source.document);
      this._reportedDomRevision = props.domRevision ?? 0;
    } else if (released) {
      this._invalidate(Stale.Style);
    }
    this._parsedOn();
  }

  /** What the parser read since: the base it may have met, the scripts and
   *  the resources it handed over, where the document has got to, and the
   *  script the parse waits at now. */
  private _parsedOn(): void {
    this._updateBase();
    this._sweep();
    this._lifecycle();
    this._tellBlocked();
  }

  /** The script `onParserBlocked` was last told of. */
  private _blockedTold: Element | null = null;

  /** Tell the host of the script the parse waits at, once a script, a
   *  microtask later: never from inside a commit or a layout, since a host
   *  runs the script from it. */
  private _tellBlocked(): void {
    const held = this._source.held;
    if (!held || held === this._blockedTold) return;
    this._blockedTold = held;
    const doc = this._source.document;
    void Promise.resolve().then(() => {
      if (
        this._source.document === doc &&
        this._source.held === held &&
        !this.destroyed
      ) {
        this._props().onParserBlocked?.(held);
      }
    });
  }

  /**
   * `document.write` from the script the parse waits at (`HtmlSource.write`):
   * the markup parsed into the tree after the script, for the next restyle,
   * and for the scan once the parse goes on, which hands over the scripts
   * and the resources in it. False where the parse does not wait at
   * `script`.
   */
  parserWrite(script: Element, markup: string): boolean {
    if (this.destroyed) return false;
    const before = this._source.revision;
    if (!this._source.write(script, markup)) return false;
    if (this._source.revision !== before) this._parsedOnTo();
    return true;
  }

  /** The script the parse waits at has run: the parse goes on to the next
   *  script it waits at, or to its end (`HtmlSource.resume`). */
  parserResume(script: Element): void {
    if (this.destroyed || this._source.held !== script) return;
    if (this._source.resume(script)) this._parsedOnTo();
    this._parsedOn();
  }

  /** What the parse read on to past a script, or what a script wrote,
   *  restyled and built as a stream's chunk is, where that can be said
   *  (`_parsedChanges`); every element styled again where it cannot. */
  private _parsedOnTo(): void {
    const appended = this._source.takeAppended();
    if (!appended || !this._parsedChanges(appended)) {
      this._invalidate(Stale.Style);
    }
  }

  /** What the parser has put in the tree since this was last asked, from
   *  the first script it waited at on (`HtmlSource.takeMade`). */
  parserMade(): readonly ChildNode[] {
    return this._source.takeMade();
  }

  /**
   * The document's base URL: its first `<base href>`, resolved against the
   * `baseUrl` prop, or the prop — and only an absolute one, since a relative
   * base resolves nothing. Everything resolved against the old one is
   * stale when it moves, the sheets' URLs with it, so the cascade is.
   *
   * And the element the prop's fragment names, which is `:target`: the
   * document's URL is the prop, and a link to `#section` the host follows
   * is the same URL with another fragment — which resolves nothing
   * differently, so it restyles only where a rule tests `:target`. A
   * fragment directive (`#sec:~:text=…`) is no part of what names it, and
   * its text directives are sought in the document (`_seekTargetText`).
   */
  private _updateBase(): void {
    const url = this._props().baseUrl || null;
    const hash = url ? url.indexOf('#') : -1;
    const given = url && hash >= 0 ? url.slice(0, hash) : url;
    const href = this._source.facts().base;
    let base = href ? resolveUrl(href, given) : given;
    if (base && !ABSOLUTE_URL.test(base)) base = null;
    if (base) base = base.split('#')[0];
    if (this._urls.setBase(base)) this._invalidate(Stale.Style);
    const { fragment, directive } = splitFragment(
      url && hash >= 0 ? url.slice(hash + 1) : '',
    );
    const target = indicatedElement(this._source.document, fragment);
    if (target !== this._target) {
      this._target = target;
      const cascade = this._cascade;
      cascade?.setTarget(target);
      if (cascade?.targetSensitive) this._invalidate(Stale.Boxes);
    }
    this._noteTextDirectives(directive);
  }

  /**
   * The fragment directive of the document's URL, as `_updateBase` read it:
   * a new one — or the same over a new document — is sought afresh, and
   * the text the last one lit is lit no more.
   */
  private _noteTextDirectives(directive: string | null): void {
    const doc = this._source.document;
    const had = this._targetText;
    if (had && had.directive === directive && had.document === doc) return;
    const directives = directive ? parseTextDirectives(directive) : [];
    this._targetText = directives.length
      ? {
          directive: directive!,
          document: doc,
          directives,
          ranges: directives.map(() => null),
          sought: null,
          soughtText: null,
          done: false,
        }
      : null;
    if (had?.ranges.some(Boolean)) this.invalidate();
  }

  /**
   * Find the text the fragment's text directives name (WICG Scroll To Text
   * Fragment, "invoke text directives"), in the text the document draws
   * (`text-fragments.ts`), once its parse has ended: each directive until
   * it is found, in each tree built whose text is other than the last one
   * sought in, so text a page's script writes in — which nothing here can
   * wait for, since the element has loaded before the page's scripts run
   * — is found as it arrives, and a build that changes no text, an
   * animation's frame, costs a comparison. What is found is kept as DOM
   * ranges, which outlive the tree, and lit at every paint in
   * `::target-text` (`_litRanges`).
   */
  private _seekTargetText(): void {
    const t = this._targetText;
    const tree = this._tree;
    if (!t || t.done || !tree || tree === t.sought) return;
    if (!this._source.complete || this._stale !== Stale.Nothing) return;
    if (t.document !== this._source.document) return;
    t.sought = tree;
    if (tree.text === t.soughtText) return;
    t.soughtText = tree.text;
    let text: ReturnType<typeof searchTextOf> | null = null;
    let found = false;
    for (let i = 0; i < t.directives.length; i += 1) {
      if (t.ranges[i]) continue;
      text ??= searchTextOf(tree);
      const match = findTextDirective(text, t.directives[i]);
      if (!match) continue;
      const start = pointOfUnit(tree, match[0]);
      const end = pointOfUnit(tree, match[1], true);
      if (!start || !end) continue;
      t.ranges[i] = {
        sc: start.node,
        so: start.offset,
        ec: end.node,
        eo: end.offset,
      };
      found = true;
    }
    if (t.ranges.every(Boolean)) t.done = true;
    if (found) this.invalidate();
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
        const src = attr(el, 'src') ?? null;
        props.onScript({
          type: (attr(el, 'type') ?? 'text/javascript').toLowerCase(),
          src: src ? this._urls.resolve(src) : src,
          text: textOf(el),
          element: el,
        });
      }
    }
    for (const el of facts.resources) {
      const tag = tagOf(el);
      const url = tag === 'link' ? attr(el, 'href') : imageUrlOf(el);
      if (!url) continue;
      // a sheet a `<link rel=preload>` fetches is nobody's yet: its
      // arrival changes nothing, until a sheet's link asks for it too
      if (tag !== 'img' || !this._waitsLazily(el, url)) {
        this._resources.request(
          { url, kind: tag === 'link' ? 'stylesheet' : 'image', element: el },
          isStylePreload(el),
          this._waited.has(el) && 'lazily',
        );
      }
      // the markup's own, the first time it is seen: what a page's script
      // changes after that it says (`askImage`)
      if (tag === 'img' && props.onImage && !this._imageKeys.has(el)) {
        this._watchImage(el);
      }
    }
  }

  // --- what an `<img>` came to --------------------------------------------
  //
  // HTML's "update the image data", as far as a page can see it. Which
  // image an element shows is `_sweep`'s and `_choose`'s; what is watched
  // here is what that image comes to, for the `load` or `error` the page
  // hears at the element and for `complete` and its kin until then. An
  // image in no document is in here as well, where nothing else would ask
  // for it: `new Image()` is how a page preloads and how it tests for a
  // format, and Apple's product pages wait up to five seconds on one.

  /** The elements waiting on an image, by where the store keeps it. */
  private _imagesWaiting = new Map<string, Set<Element>>();
  /** What each `<img>` last asked for, where the store keeps it, whatever
   *  that came to; '' for no image. */
  private _imageKeys = new WeakMap<Element, string>();
  /** What each `<img>` has shown of what it asked for, as `currentSrc`
   *  reads it: nothing while it waits, as Chrome has it, and the image
   *  that came, or the URL that failed to. */
  private _imageShown = new WeakMap<Element, string>();
  /** The document the elements waiting are in. */
  private _imagesOf: Document | null = null;
  /** The images in the document a page's script changed that choose their
   *  source, which the next `_update` chooses for (`_imagesChosen`). */
  private _imagesOwed = new Set<Element>();
  /** What the next microtask tells: one outcome an element, and none for
   *  one that asked for something else since. */
  private _imageTells = new Map<Element, 'load' | 'error'>();
  /** The images a page's script changed, which the end of its task asks
   *  for (`_askDue`). */
  private _imagesDue = new Set<Element>();

  /**
   * A page's script changed what an `<img>` shows, or made one: its image
   * asked for and watched from here on, whether or not it is in the
   * document, and told again though it is the image it had, as setting a
   * `src` to what it was loads it again.
   */
  askImage(el: Element): void {
    if (!this._props().onImage) return;
    const chooses = choosesSource(el);
    if (chooses && inDocument(el, this._source.document)) {
      this._imagesOwed.add(el);
      return;
    }
    // what the store has is there as it is asked for, and no src is no image
    if (!chooses) {
      const url = attr(el, 'src');
      const state = url ? this._resources.state(url) : 'failed';
      if (state === 'ready' || state === 'failed') {
        this._watchImage(el, true);
        return;
      }
    }
    if (!this._imagesDue.size) {
      void Promise.resolve().then(() => this._askDue());
    }
    this._imagesDue.add(el);
  }

  /**
   * Ask for what the images a page's script changed show, at the end of its
   * task: HTML's "await a stable state", which is why a `loading` set after
   * a `src` still counts. React sets an element's attributes in the order
   * they are written, on an element in no document yet.
   */
  private _askDue(): void {
    const due = this._imagesDue;
    this._imagesDue = new Set();
    if (this.destroyed) return;
    for (const el of due) {
      if (choosesSource(el)) {
        this._images.choose(
          [el],
          this._sourceEnv(
            this._laidOutWidth > 0 ? this._laidOutWidth : this.abs.width || 1,
            this._viewportHeight(),
          ),
        );
      } else {
        const url = attr(el, 'src');
        if (url && !this._waitsLazily(el, url)) {
          this._resources.request(
            { url, kind: 'image', element: el },
            false,
            true,
          );
        }
      }
      this._watchImage(el, true);
    }
  }

  // --- what a lazy image waits for ----------------------------------------
  //
  // HTML's lazy loading (2.5.7): an `<img loading="lazy">` in a document
  // whose scripts run is asked for once it comes near the viewport, and
  // holds no `load`. Nothing is kept of which images wait: one waits for as
  // long as what it shows has not been asked for, by it or by anything else
  // (`_waitsLazily`). An element with no box is near nothing, so one under
  // `display: none`, or in no document at all, waits until it has one.

  /** Whether an image may wait in the document as it is: some did the last
   *  time anything asked, so a paint asks again (`_askNear`). */
  private _lazyWaits = false;
  /** The images that have waited, which hold no `load` once they are asked
   *  for, by the viewport or by `loading` set eager: HTML's "delay load
   *  event" is settled before an image waits. */
  private _waited = new WeakSet<Element>();
  /** What can be seen, and the boxes as they were laid out, when a paint
   *  last asked what is near it (`_askNear`). */
  private _lazySeen: { rect: Rect; geometry: number } | null = null;

  /**
   * Whether an `<img>`'s image waits to be near the viewport: HTML's "will
   * lazy load element steps", which are false where scripting is disabled,
   * since a server could read a reader's way down a document from what it
   * was asked for and when. Not where the URL is in the store, as it is in
   * HTML's list of available images, and asked for by another element: it
   * is shown as it arrives.
   */
  private _waitsLazily(el: Element, url: string): boolean {
    if (!(this._props().scripting ?? false) || !loadsLazily(el)) return false;
    if (this._resources.state(url) !== null) return false;
    this._resources.expect(url);
    this._waited.add(el);
    this._lazyWaits = true;
    return true;
  }

  /**
   * Ask for the lazy images a paint finds near what can be seen: HTML's
   * lazy load intersection observer, whose root margin and scroll margin it
   * leaves to the browser. From the boxes as they are laid out, so a paint pays for
   * a walk of what waits and no layout, and no walk at all until the pane
   * has moved `LAZY_STEP_PX` or the boxes have (`_geometry`). The asking is
   * a microtask later: never from inside a paint, since a host answers from
   * it. Not `_owe`'s: what is owed is the document's to bring up to date at
   * a page's read, and a read of a document brings in no image.
   */
  private _askNear(): void {
    const tree = this._tree;
    if (!tree) return;
    // at the paint's end, where what the frame asked of the pane has landed
    this._painting = true;
    const seen = this._seenRect();
    this._painting = false;
    const was = this._lazySeen;
    if (
      was?.geometry === this._geometry &&
      Math.abs(seen.x - was.rect.x) +
        Math.abs(seen.y - was.rect.y) +
        Math.abs(seen.width - was.rect.width) +
        Math.abs(seen.height - was.rect.height) <
        LAZY_STEP_PX
    ) {
      return;
    }
    this._lazySeen = { rect: seen, geometry: this._geometry };
    const boxes = this._imageBoxesOf(tree);
    const facts = this._source.facts();
    const shift = this._fixedShift(this._scrolledOrigin());
    // what a `<foreignObject>` holds is in a tree of its own, laid out
    // against the object, and drawn as the drawing is reached
    const foreign = tree.foreign && foreignImages(tree.foreign);
    const near: { el: Element; url: string; away: number }[] = [];
    let waits = false;
    const ask = (el: Element): void => {
      if (!loadsLazily(el)) return;
      const url = choosesSource(el)
        ? this._images.chosen(el)?.url
        : attr(el, 'src');
      if (!url || this._resources.state(url) !== null) return;
      const box = boxes.get(el);
      const away = box
        ? this._lazyAway(tree, box, seen, shift)
        : foreign?.has(el)
          ? 0
          : null;
      if (away === null) waits = true;
      else near.push({ el, url, away });
    };
    for (const el of facts.resources) ask(el);
    for (const el of facts.pictures) ask(el);
    this._lazyWaits = waits;
    if (!near.length) return;
    // what can be seen first: a host goes through what it is asked in order
    near.sort((a, b) => a.away - b.away);
    const doc = this._source.document;
    void Promise.resolve().then(() => {
      if (this._source.document !== doc || this.destroyed) return;
      for (const { el, url } of near) {
        if (this._props().onImage) this._watchImage(el);
        this._resources.request(
          { url, kind: 'image', element: el },
          false,
          'lazily',
        );
      }
    });
  }

  /**
   * How far a box is from what can be seen, in CSS pixels and 0 where it
   * meets it, where it is near that and the viewport of every box around
   * it that scrolls (`LAZY_NEAR_PX`, `LAZY_LOADING_PX`); null where it is
   * not. What cuts it short is asked only of what the viewport has near: a
   * page of images is a few of those and a walk up the boxes for none of
   * the rest.
   */
  private _lazyAway(
    tree: BoxTree,
    box: Box,
    seen: Rect,
    shift: { x: number; y: number } | null,
  ): number | null {
    const drawn = this._drawnRect(tree, box, false);
    if (!drawn) return null;
    const rect = this._moveToViewport(box, drawn, shift);
    const across = Math.max(
      seen.x - rect.x - rect.width,
      rect.x - seen.x - seen.width,
      0,
    );
    const down = Math.max(
      seen.y - rect.y - rect.height,
      rect.y - seen.y - seen.height,
      0,
    );
    const loaded = this._loadedOf === this._source.document;
    const near = loaded ? LAZY_NEAR_PX : LAZY_LOADING_PX;
    if (across > near || down > near) return null;
    const clips = intersectionClips(
      box,
      null,
      this._scale,
      loaded ? LAZY_MARGINS : LAZY_LOADING_MARGINS,
    );
    return clips && this._cutBy(rect, clips, shift)
      ? Math.max(across, down)
      : null;
  }

  /** What can be seen of the document, in `elementRect`'s coordinates. */
  private _seenRect(): Rect {
    const s = this._scale;
    const top = this._seenTop();
    const viewport = this._viewport();
    const left = viewport ? viewport.x - this.contentBox().x : 0;
    const width = viewport ? viewport.width : (this.root?.abs?.width ?? 0);
    return {
      x: left / s,
      y: top / s,
      width: width / s,
      height: (this._seenBottom() - top) / s,
    };
  }

  /** Watch what an `<img>` shows now, unless that is what it was watched
   *  for: told at once of what is here, or as it settles
   *  (`_imageSettled`). */
  private _watchImage(el: Element, again = false): void {
    const chooses = choosesSource(el);
    const chosen = chooses ? this._images.chosen(el) : null;
    if (chosen === undefined) return;
    const url = chooses ? chosen?.url : attr(el, 'src');
    const key = url ? this._resources.keyOf(url) : '';
    const was = this._imageKeys.get(el);
    if (was === key && !again) return;
    const doc = this._source.document;
    if (this._imagesOf !== doc) {
      this._imagesOf = doc;
      this._imagesWaiting.clear();
    }
    if (was) {
      const waiting = this._imagesWaiting.get(was);
      if (waiting?.delete(el) && !waiting.size) {
        this._imagesWaiting.delete(was);
      }
    }
    this._imageTells.delete(el);
    this._imageKeys.set(el, key);
    this._imageShown.delete(el);
    if (!url) {
      // nothing to show is news only where something was named
      if (chooses || attr(el, 'src') !== undefined) {
        this._tellImage(el, 'error');
      }
      return;
    }
    const state = this._resources.state(url);
    if (state === 'ready' || state === 'failed') {
      this._imageShown.set(el, key);
      this._tellImage(el, this._resources.image(url) ? 'load' : 'error');
      return;
    }
    const waiting = this._imagesWaiting.get(key);
    if (waiting) waiting.add(el);
    else this._imagesWaiting.set(key, new Set([el]));
  }

  /** What the store keeps at `key` came to something. */
  private _imageSettled(key: string): void {
    const waiting = this._imagesWaiting.get(key);
    if (!waiting) return;
    this._imagesWaiting.delete(key);
    if (this._imagesOf !== this._source.document) return;
    const outcome = this._resources.image(key) ? 'load' : 'error';
    for (const el of waiting) {
      this._imageShown.set(el, key);
      this._tellImage(el, outcome);
    }
  }

  /** The images `_choose` chose for: each watched for what it chose, as
   *  `_sweep` watches the rest, and those a page's script changed told
   *  again. */
  private _imagesChosen(): void {
    if (!this._props().onImage) return;
    for (const el of this._source.facts().pictures) this._watchImage(el);
    if (!this._imagesOwed.size) return;
    const owed = this._imagesOwed;
    this._imagesOwed = new Set();
    for (const el of owed) this._watchImage(el, true);
  }

  /** Tell what an image came to, as a task of its own: never inside the
   *  script that asked, and before the document's `load`, which `_lifecycle`
   *  tells a microtask after the one that settled it. */
  private _tellImage(el: Element, outcome: 'load' | 'error'): void {
    const owed = this._imageTells.size > 0;
    this._imageTells.set(el, outcome);
    if (owed) return;
    const doc = this._source.document;
    void Promise.resolve().then(() => {
      const tells = [...this._imageTells];
      this._imageTells.clear();
      if (this._source.document !== doc || this.destroyed) return;
      for (const [element, told] of tells) {
        this._props().onImage?.(element, told);
      }
    });
  }

  /**
   * What a page reads of an `<img>`: whether its image has come to
   * something (`complete`), its size in CSS pixels at the density it was
   * chosen at, 0 until that is known and for one that failed, and the URL
   * it has shown (`_imageShown`). A broken image is complete, and shows
   * nothing (`available`).
   */
  imageState(el: Element): {
    complete: boolean;
    available: boolean;
    width: number;
    height: number;
    src: string;
  } {
    const chooses = choosesSource(el);
    const chosen = chooses ? this._images.chosen(el) : null;
    const url = chooses ? chosen?.url : attr(el, 'src');
    const state = url ? this._resources.state(url) : null;
    const size = this._imageSize(el);
    return {
      complete:
        !this._imagesOwed.has(el) &&
        chosen !== undefined &&
        (!url || state === 'ready' || state === 'failed'),
      available: !!url && state === 'ready' && !!this._resources.image(url),
      width: Math.floor(size?.width ?? 0),
      height: Math.floor(size?.height ?? 0),
      src: this._imageShown.get(el) ?? '',
    };
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

  /**
   * An image arrived that something's size may be laid out from, after the
   * boxes were built. An `<img>` built before its image was in, at the size
   * its attributes said, takes its image's size in place: what a layout
   * reads, and what `object-fit` fits the picture by. Where that moves no
   * box — the same size, or a width and a height of the box's own, which
   * the attributes give it unless a rule says otherwise — it is painted
   * again, as an image a background names is, and laid out again where it
   * can. Only an element whose box is another kind with its image
   * (`awaitingKind`), or a marker or generated content sized by it, is
   * built again, with what it holds (`_arrivedKinds`). Wikipedia says how
   * big each image of an article is, and its article on the X Window System
   * was built and laid out again eleven times as they came in, at some
   * 180 ms a time on a Mac.
   *
   * Nothing here changes what a build already owed is: one of every box
   * reads each size as it makes the box, and one of some subtrees leaves
   * the rest to take theirs here. An image that landed between a page's
   * change and the frame that builds it had made that build the whole
   * document's: most of what the Guardian's and BBC's images cost as they
   * came in, 120 to 420 ms an arrival, with no box of any other kind.
   *
   * `painted` is false where only the size arrived, read from the image's
   * header while its pixels decode: nothing draws it yet, so nothing is
   * painted but what a layout moves. `lazily` is where a lazy image is
   * kept, which only the boxes showing it draw (`_lazyPainted`).
   */
  private _imageArrived(painted = true, lazily?: string): void {
    const tree = this._tree;
    if (!tree || (this._stale >= Stale.Boxes && !this._buildSeeds)) {
      // built again for the boxes an image makes, and no style: an image
      // changes none, and every element was matched again for Wikipedia's
      // interlanguage stars, `list-style-image`s that arrive after the
      // first build, 600 ms of the article on the United States
      this._invalidate(Stale.Boxes, EMPTY_SET);
      return;
    }
    const kinds = this._arrivedKinds(tree);
    if (kinds) this._invalidate(Stale.Boxes, EMPTY_SET, false, kinds);
    let moves = false;
    const s = this._scale;
    // A box takes the size of what its element shows now, unless what it
    // chose is still on its way, which it shows the one before in place of.
    const take = (box: Box): boolean => {
      const el = box.el!;
      const size = this._imageSize(el);
      if (!size || this._sizePending(el)) return false;
      const next = intrinsicsOf(size, s * box.style.effectiveZoom);
      if (!sameIntrinsic(box.intrinsic, next) && !sizedAnyway(box)) {
        const slight = closeIntrinsic(box.intrinsic, next, s);
        if (lazily !== undefined && (slight || !this._inView(tree, box))) {
          this._oweSize(box, next, slight);
          return true;
        }
        moves = true;
        // what the boxes around it measured of it, for their lives, is
        // measured again: a flex item shrunk to an image that had not come
        // was as narrow as none
        forgetSizes(box);
      }
      box.intrinsic = next;
      return true;
    };
    let kept = 0;
    for (const box of tree.awaiting) {
      if (!take(box)) tree.awaiting[kept++] = box;
    }
    tree.awaiting.length = kept;
    // and an image that chose another source since it was built, at a
    // resize or a laid-out `sizes`, and showed the one before until now
    const pictures = this._source.facts().pictures;
    if (pictures.length) {
      // set aside by a layout that stops or not, which lays it out later
      const boxes = this._imageBoxesOf(tree);
      for (const el of pictures) {
        const box = boxes.get(el);
        if (box && !tree.awaiting.includes(box)) take(box);
      }
    }
    if (painted) {
      if (lazily === undefined) this._imagePainted();
      else this._lazyPainted(tree, lazily);
    }
    if (moves) this._invalidate(Stale.Layout);
  }

  /**
   * A lazy image's size, which waits with what else can (`_owe`): it lands
   * ahead of the reader, and a size is news to the layout of all of a long
   * article, in the frames of a scroll. `slight` is a size no reader can
   * tell from the one it has, which does not come in for being near, or in
   * view, and waits for the scroll to end: Wikipedia's images are `height:
   * auto`, half a pixel from their attributes by rounding, and a fling
   * laid the article out for each that landed.
   */
  private _oweSize(
    box: Box,
    next: NonNullable<Box['intrinsic']>,
    slight: boolean,
  ): void {
    if (slight) this._owedSlight.add(box);
    this._owe(box, (_, up) => {
      box.intrinsic = next;
      forgetSizesIn(box, up);
      this._dropSprites(box, true);
    });
  }

  /** Whether a box meets what can be seen. */
  private _inView(tree: BoxTree, box: Box): boolean {
    const drawn = this._drawnRect(tree, box, false);
    if (!drawn) return false;
    const r = this._moveToViewport(box, drawn);
    const seen = this._seenRect();
    return (
      r.x <= seen.x + seen.width &&
      r.x + r.width >= seen.x &&
      r.y <= seen.y + seen.height &&
      r.y + r.height >= seen.y
    );
  }

  /**
   * A lazy image's pixels are in: what shows it is painted again, what holds
   * a drawing of that goes, and nothing else does. Such an image lands
   * ahead of the reader, off screen and in the middle of a scroll, whose
   * frames are blits: painted as any image is, each arrival repainted all
   * the pane shows and every surface kept for a box.
   */
  private _lazyPainted(tree: BoxTree, key: string): void {
    const shown = this._viewportInDocument();
    const inks: Rect[] = [];
    for (const box of tree.images) {
      const url = box.el ? this._imageUrl(box.el) : undefined;
      if (!url || this._resources.keyOf(url) !== key) continue;
      this._dropSprites(box, true);
      if (this._lifted.size && this._insideLifted(box)) {
        this._spriteGen += 1;
        this.spritesChanged();
      }
      const ink = this._inkOf(box);
      const part = ink && shown ? rectWithin(ink, shown) : ink;
      if (part) inks.push(part);
    }
    this._repaintInk(inks);
  }

  /**
   * Whether the size an element's box takes is still to come: its own
   * image's, until its header or its decode has said it, or that of the
   * one it chose, which it shows the one before in place of until the
   * chosen one's pixels are in (`ImageSources.sizePending`). Not whether
   * its pixels are: an image laid out at the size its header said is still
   * drawn only once `ResourceStore.image` has them.
   */
  private _sizePending(el: Element): boolean {
    if (choosesSource(el)) return this._images.sizePending(el);
    const url = imageUrlOf(el) ?? '';
    return (
      this._resources.state(url) === 'pending' &&
      !this._resources.imageSize(url)
    );
  }

  /** The elements whose boxes an image that arrived makes otherwise: what
   *  it was built without, as generated content or a marker, and what comes
   *  out another kind with it. Null where it is none. */
  private _arrivedKinds(tree: BoxTree): Set<Element> | null {
    let kinds: Set<Element> | null = null;
    for (const { url, element, sized } of tree.contentImages) {
      if (!sized && this._resources.imageSize(url)) {
        (kinds ??= new Set()).add(element);
      }
    }
    for (const el of tree.awaitingKind) {
      if (
        this._imageSize(el) ||
        this._resources.holdsDocument(imageUrlOf(el) ?? '')
      ) {
        (kinds ??= new Set()).add(el);
      }
    }
    return kinds;
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
        ...(ref.kind === 'link' && { href: ref.href }),
        ...(ref.constructed && { constructed: true }),
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
    this._sheetsOwed = false;
    this._keptFor = null;
    const props = this._props();
    this._styledAt = this._scale;
    const look = this._deviceLook();
    const facts = this._source.facts();
    // the document's sheets, and after them the host's
    const read = this._readSheets(facts.sheets);
    // Each shadow tree's, which style it alone (CSS Scoping 1, 3.2): the
    // trees whose sheets read alike — a component stamped out on every
    // card of a page — are one set of rules, parsed and indexed once.
    const shadowKeys = new Map<ShadowRoot, string>();
    this._shadowKeys = shadowKeys;
    const shadowRead = new Map<string, SheetText[]>();
    const shadowOwn: [string, SheetText[]][] = [];
    for (const { root, sheets } of facts.shadows) {
      const own = this._readSheets(sheets);
      const key = this._sheetsKey(own);
      shadowKeys.set(root, key);
      if (own.length && !shadowRead.has(key)) shadowRead.set(key, own);
      if (own.length) shadowOwn.push([key, own]);
    }
    const extras = this._extraSheets(props.stylesheet);
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
      // an element put in for one that read the same is the sheet now
      for (let i = 0; i < read.length; i += 1) {
        const source = kept.sheets[i].source;
        if (source) source.element = read[i].element;
      }
      this._cascade.previous = this._previousStyle;
      this._cascade.scripts = this._scripts;
      this._cascade.transitionKeyframes = this._vt?.keyframes ?? null;
      kept.cascade.viewportWidth = width;
      kept.cascade.viewportHeight = this._viewportHeight();
      faces = kept.faces;
    } else {
      // the UA sheet's `px` are CSS pixels, which the cascade scales like an
      // author's, so it is written from the look in CSS pixels: from the
      // device one, a control's size and a button's chrome were doubled at 2x
      const sheets: Stylesheet[] = [uaStylesheet(props.look)];
      this._parsing = new Map();
      const imports: ImportRead[][] = [];
      const parsed: Stylesheet[] = [];
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
      for (const each of read) {
        const { text, encoding, element, base, media } = each;
        // a sheet under its `media` is under it as an imported one is
        // under its import's: each rule, each face and each import in it
        const under = media ? [media] : null;
        const sheet = this._parseSheet(text, layers, base, under);
        sheet.source = sourceOfSheet(each);
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
        parsed.push(sheet);
        place(sheet, element);
      }
      for (const text of extras) {
        const sheet = this._parseSheet(text, layers, null, null);
        for (const rule of sheet.rules) rule.order = order++;
        order += 1;
        if (sheet.rules.length) {
          sheet.source = { url: null, element: null, text };
        }
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
        for (const each of own) {
          const { text, encoding, element, base, media } = each;
          const under = media ? [media] : null;
          const sheet = this._parseSheet(text, treeLayers, base, under);
          sheet.source = sourceOfSheet(each);
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
      this._parsed = this._parsing;
      this._parsing = null;
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
        this._target,
        shadows,
        kept?.cascade ?? null,
      );
      this._cascade.laidOutSize = this._laidOutSize;
      this._cascade.laidOutScroll = this._laidOutScroll;
      this._cascade.previous = this._previousStyle;
      this._cascade.scripts = this._scripts;
      this._cascade.transitionKeyframes = this._vt?.keyframes ?? null;
      this._sheetsRead = {
        look,
        scale: this._scale,
        fonts,
        texts: read.map((r) => r.text),
        encodings: read.map((r) => r.encoding),
        bases: read.map((r) => r.base),
        media: read.map((r) => r.media),
        imports,
        sheets: parsed,
        extras,
        shadows: shadowImports,
        faces,
        cascade: this._cascade,
      };
    }
    this._noteSheetsInForce(read, shadowOwn);
    // the trees as they are now, which a kept cascade was made for others of
    this._cascade.bindShadows(shadowKeys);
    // Set on a kept cascade as on a new one: a change of it is a restyle
    // over the sheets as they were parsed, as a width across a breakpoint is
    const reducedMotion = props.reducedMotion ?? false;
    this._cascade.reducedMotion = reducedMotion;
    const scripting = props.scripting ?? false;
    this._cascade.scripting = scripting;
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
          scripting,
        ),
      ),
    );
    this._cascade.setPointer({
      hovered: new Set(this._hovered),
      active: EMPTY_SET,
    });
    this._cascade.setFocus(this._focus);
    this._cascade.setTarget(this._target);
    this._mediaBand = this._cascade.mediaBand(width, this._viewportHeight());
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
      const imported = this._parseSheet(fetched.text, layers, base, media);
      imported.source = {
        url: base ?? url,
        element: null,
        text: fetched.text,
      };
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

  /**
   * A sheet parsed, or the one the cascade in force was made from where it
   * reads the same: its text, its base and the media it is under — and, for
   * one that names a cascade layer, the layers ranked before it, whose
   * names it ranks after them (`ParsedSheet.layers`). A script that puts a
   * sheet in makes the cascade again, and GitHub's repository page parsed
   * all of its 3.7 MB of CSS again for each of the three its scripts bring.
   * Each is taken once a cascade, since its rules' `order` is their place
   * in it, which `_restyle` sets.
   */
  private _parseSheet(
    text: string,
    layers: Map<string, number>,
    base: string | null,
    under: MediaCondition[][] | null,
  ): Stylesheet {
    const kept = this._parsed.get(text);
    let found: ParsedSheet | null = null;
    if (kept) {
      for (let i = 0; i < kept.length; i += 1) {
        const at = kept[i];
        if (at.base !== base || !sameValue(at.under, under)) continue;
        if (at.layers && !sameNames(at.layers.before, layers)) continue;
        kept.splice(i, 1);
        found = at;
        break;
      }
    }
    if (found?.layers) {
      // the names it ranks, as its parse ranked them
      for (const name of found.layers.added) layers.set(name, layers.size);
    }
    if (!found) {
      const before = [...layers.keys()];
      const sheet = parseStylesheet(text, 0, layers, base, under);
      found = {
        base,
        under,
        sheet,
        layers: sheet.layered
          ? { before, added: [...layers.keys()].slice(before.length) }
          : null,
      };
    }
    if (this._parsing) {
      let taken = this._parsing.get(text);
      if (!taken) this._parsing.set(text, (taken = []));
      taken.push(found);
    }
    return found.sheet;
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
    const box = this._pane()?.contentBox();
    return box && box.width > 0 && box.height > 0 ? box : null;
  }

  /** The pane that scrolls the element: the nearest scroll pane around
   *  it, or null where nothing scrolls it. */
  private _pane(): ScrollPane | null {
    for (let node = this.parent; node; node = node.parent) {
      // `Scrollable`'s, and not every node's: asked the way core asks it
      const pane = node as Partial<ScrollPane>;
      if (pane.isScroller?.()) return node as ScrollPane;
    }
    return null;
  }

  /** The pane's offsets and `abs` as the last pass left them, noted where
   *  core says a pass is over (`_notePlaced`); null before the first. */
  private _placedAt: PlacedAt | null = null;

  /**
   * Note the pane's offsets and where the element is: called where core
   * calls an element only after a layout pass — its paint, and the
   * question a scroll the pane blits asks (`viewportFixedRects`) — so the
   * two are what that pass made of each other (`_scrolledOrigin`).
   */
  private _notePlaced(): void {
    const pane = this._pane();
    if (!pane) {
      this._placedAt = null;
      return;
    }
    const at = (this._placedAt ??= {
      pane,
      scrollX: 0,
      scrollY: 0,
      x: 0,
      y: 0,
    });
    at.pane = pane;
    at.scrollX = pane.scrollX;
    at.scrollY = pane.scrollY;
    at.x = this.abs.x;
    at.y = this.abs.y;
  }

  /**
   * Where the element's corner is for the offsets the pane has now, in
   * window pixels: `abs`, moved by however far the pane has scrolled since
   * the pass that put it there. A pane's `scrollTo` moves its offsets at
   * once and what it holds at the next pass, so measured from `abs` in
   * between, a header fixed at `top: 30px` read -470 to a page's
   * `getBoundingClientRect` straight after its `scrollTo(0, 500)`, where
   * Chrome reads 30, and `elementFromPoint` found what had been under the
   * point before the scroll. A pane's offsets are device pixels, as `abs`
   * is, and a right-to-left pane's offset across moves what it holds the
   * other way (react-x11's `Scrollable`). `abs` as it is where it moved
   * since the note, or the pane is another: a pass that neither painted
   * the element nor blitted the pane placed it, at the offsets there are
   * unless the pane scrolled after it, which nothing here can see.
   */
  private _scrolledOrigin(): { x: number; y: number } {
    const abs = this.abs;
    const at = this._placedAt;
    if (!at || at.x !== abs.x || at.y !== abs.y) return abs;
    const pane = this._pane();
    if (pane !== at.pane) return abs;
    const dx = pane.scrollX - at.scrollX;
    const dy = pane.scrollY - at.scrollY;
    if (dx === 0 && dy === 0) return abs;
    return {
      x: pane.direction === 'rtl' ? abs.x + dx : abs.x - dx,
      y: abs.y - dy,
    };
  }

  /**
   * What the document draws fixed to the viewport of the pane that scrolls
   * it, for that pane's scroll blit to repaint rather than copy with the
   * text (react-x11's `viewportFixedRects`): the whole viewport where a
   * fixed background shows through it, which makes a scroll a repaint, and
   * where each fixed box that draws something is drawn, and each sticky box
   * the viewport holds where it was drawn held and where it is held now.
   * Null for a document with none of them, and where nothing scrolls the
   * element.
   */
  override viewportFixedRects(): Rect[] | null {
    this._notePlaced();
    const tree = this._tree;
    const viewport = tree && this._viewport();
    if (!tree || !viewport) return null;
    if (hasFixedBackground(tree)) return [viewport];
    const out: Rect[] = [];
    // laid out against the viewport at the document's top, and drawn at the
    // viewport (`atViewport`) — but for one that draws nothing, which the
    // copy drags nothing of. A pinned rect costs more than its area: core
    // merges two that meet into the box around both, and past three
    // quarters of the viewport the scroll is a repaint. GitHub keeps its
    // page-load bar fixed across the top of every page at `opacity: 0`, and
    // with a contents list stuck at `top: 0` the two came to the viewport's
    // width and the list's height, and every frame repainted the window.
    // Nor what draws nothing inside one: a menu's backdrop, hidden, over
    // the whole viewport (`drawnInkOf`).
    for (const box of FIXED_BOXES.get(tree) ?? NO_BOXES) {
      if (!(box.boundsWidth > 0 && box.boundsHeight > 0)) continue;
      const ink = drawnInkOf(box);
      if (!ink) continue;
      out.push({
        x: viewport.x + ink.x,
        y: viewport.y + ink.y,
        width: ink.width,
        height: ink.height,
      });
    }
    // A sticky box held to the viewport stays where it is on screen as the
    // pane scrolls, as a fixed one does, until its containing block takes
    // it away, so the copy would drag it with the text. Core repaints each
    // rect here where it is and where the copy put what was there: where a
    // box was drawn held, which takes in where the copy put it, and where
    // the scroll has it now (`_followViewport`), which takes in what the
    // copy put where it lands as it is caught or let go.
    if (VIEWPORT_STICKY.has(tree)) {
      this._followViewport();
      out.push(...this._stuckDrawn);
      for (const rect of this._heldRects(tree)) {
        if (!this._stuckDrawn.some((was) => sameRect(was, rect))) {
          out.push(rect);
        }
      }
    }
    // A box anchored across the pane's scroll moves with its anchor where
    // the copy leaves it, or stays where the copy takes its anchor: where
    // it was drawn, and where it is drawn now.
    if (tree.anchors && anchorScrollsOf(tree.root).size) {
      this._followViewport();
      out.push(...this._anchoredDrawn);
      for (const rect of this._anchoredRects(tree)) {
        if (!this._anchoredDrawn.some((was) => sameRect(was, rect))) {
          out.push(rect);
        }
      }
    }
    return out.length ? out : null;
  }

  /** Where each box anchored across the pane's scroll (`followPane`) is
   *  drawn, in window pixels. */
  private _anchoredRects(tree: BoxTree): Rect[] {
    let out: Rect[] | null = null;
    for (const [box, state] of anchorScrollsOf(tree.root)) {
      if (!state.pane) continue;
      const ink = this._inkOf(box, true);
      if (!ink || !(ink.width > 0 && ink.height > 0)) continue;
      (out ??= []).push({
        x: this.abs.x + ink.x,
        y: this.abs.y + ink.y,
        width: ink.width,
        height: ink.height,
      });
    }
    return out ?? NO_RECTS;
  }

  /**
   * Where each sticky box the viewport keeps (`VIEWPORT_STICKY`) and holds
   * away from where the flow has it is drawn, in window pixels: none of the
   * ones that only scroll with the text, which the copy moves as it should.
   */
  private _heldRects(tree: BoxTree): Rect[] {
    const boxes = VIEWPORT_STICKY.get(tree);
    if (!boxes) return NO_RECTS;
    let out: Rect[] | null = null;
    for (const box of boxes) {
      const stuck = STUCK.get(box);
      if (!stuck || !(stuck[0] || stuck[1])) continue;
      // what of it draws: Docusaurus's navbar, stuck at the top, holds its
      // menu's backdrop, hidden, over the whole viewport
      const ink = this._inkOf(box, true);
      if (!ink || !(ink.width > 0 && ink.height > 0)) continue;
      (out ??= []).push({
        x: this.abs.x + ink.x,
        y: this.abs.y + ink.y,
        width: ink.width,
        height: ink.height,
      });
    }
    return out ?? NO_RECTS;
  }

  /**
   * Place the sticky boxes the viewport keeps again where the pane around
   * the element has scrolled the document to (`restickToViewport`): the
   * layout placed them as though it were at its top, and a scroll of the
   * pane lays nothing out. Their ink is worked out again and the surfaces
   * kept for the boxes around them given up, as a scroll inside the
   * document does (`_scrollBox`). Asked before anything reads where a box
   * is — a paint, a hit test, a scroll blit's question — and a few
   * comparisons where nothing moved; where nothing scrolls the element, they
   * stay where the layout put them.
   *
   * For the offsets the pane has now (`_scrolledOrigin`), whoever asks. A
   * page measures straight after its own `scrollTo`, before the pass that
   * moves `abs`: placed from `abs`, a header held at `top: 0` read -492 on
   * a page scrolled 500px, where Chrome reads 0, and a point at the top of
   * the viewport missed it. They are one placement and not one per asker:
   * placed for the pass to come when a page asks and for the last when
   * core does, a hover between a page's `scrollTo` and its pass would move
   * them back each time, each a walk of the tree's ink and the surfaces
   * around them given up. So a point core asks about in that window — a
   * hover, a press — is read where the last pass drew the flow and the
   * next will draw a held box, for that one frame, and core asks the hover
   * again after it (react-x11#793). The paint and the blit's question note
   * the pass first (`_notePlaced`), so they place them from `abs`, and
   * what they draw and repair is where that pass put it.
   */
  private _followViewport(): void {
    // a pane's scroll, which `scroll-state()` asks the root's and its
    // sticky boxes' of: asked again once what is drawn now is drawn
    if (this._cascade?.readsScrollState && this._noteRootScroll()) {
      void Promise.resolve().then(() => this._askScrollStates());
    }
    // and a trigger whose timeline the pane scrolls
    if (this._timeline.triggered) {
      void Promise.resolve().then(() => this._evaluateTriggers());
    }
    // and an animation that runs on a scroll's timeline, which a layout
    // moves as much as a scroll
    void Promise.resolve().then(() => this._restyleScrolled());
    this._placeAgainstPane();
  }

  /** The boxes `_followViewport` places, without what it tells of the
   *  scroll: all core's pass over what is mounted beside the document needs
   *  (`heldShiftOf`), which asks once a widget. */
  private _placeAgainstPane(): void {
    const tree = this._tree;
    const boxes = tree && VIEWPORT_STICKY.get(tree);
    // and what is anchored across the pane's scroll: fixed to the viewport
    // and anchored in the document, or the other way round
    const anchored = tree?.anchors ? anchorScrollsOf(tree.root) : null;
    if (!tree || (!boxes && !anchored?.size)) return;
    const at = this._viewportAt();
    if (!at) return;
    let moved = boxes ? restickToViewport(boxes, at) : null;
    if (anchored?.size) {
      const followed = followPane(tree.root, at, translate);
      if (followed) moved = moved ? [...moved, ...followed] : followed;
      if (this._refitAnchored(tree, at)) moved ??= [];
    }
    if (!moved) return;
    // what moved, and the boxes around it as far as they have to grow
    // (`boundsAfterMove`); the whole tree where that cannot be said
    if (!moved.every((box) => boundsAfterMove(box, tree.movedInline))) {
      computePaintBounds(tree.root, tree.movedInline);
    }
    for (const box of moved) this._dropSprites(box, false);
    // a layer may now be over a box that moved, or hold one
    if (this._lifted.size) {
      this._spriteGen += 1;
      this.spritesChanged();
    }
    // what is mounted beside the document is told at the paint
    this._stickyMoved = true;
  }

  /**
   * Where the pane around the element has the viewport, in the document's
   * device pixels, for the offsets it has now (`_scrolledOrigin`): how far
   * its scroll moves what is fixed to the viewport from where it was laid
   * out, and the viewport's size. Null where nothing scrolls the element.
   */
  private _viewportAt(): Viewport | null {
    const viewport = this._viewport();
    if (!viewport) return null;
    const origin = this._scrolledOrigin();
    return {
      x: viewport.x - origin.x,
      y: viewport.y - origin.y,
      width: viewport.width,
      height: viewport.height,
    };
  }

  /**
   * What a scroll did to the boxes anchored across it (`refitAnchored`): a
   * box `position-visibility` hides or shows now leaves its stacking
   * context's layers, or joins them, and one that no longer fits where it
   * has position options to try has the document laid out again, which
   * tries them where its anchor is now (CSS Anchor Positioning 1, 6.5).
   * Whether anything is hidden or shown.
   */
  private _refitAnchored(tree: BoxTree, viewport: Viewport | null): boolean {
    const root = tree.root;
    if (refitAnchored(root, viewport)) {
      // asked as a paint reads where the boxes are: the layout is the
      // next frame's
      void Promise.resolve().then(() => this._invalidate(Stale.Layout));
    }
    if (!updatePositionVisibility(root, viewport).length) return false;
    stackLayers(root);
    computePaintBounds(root, tree.movedInline);
    return true;
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
    this._followScale();
    if (this._failedAt === target && this._stale === Stale.Nothing) return;
    try {
      this._counted(() => this._update(target));
      this._failedAt = -1;
    } catch (error) {
      this._fail(error, target);
    }
    this._lifecycle();
    this._seekTargetText();
  }

  /** The document `onParsed` and `onLoaded` were last told of. */
  private _parsedOf: Document | null = null;
  private _loadedOf: Document | null = null;

  /**
   * Tell the host where the document has got to, each once a document:
   * `onParsed` once its parse has ended, and `onLoaded` once, after that,
   * it has been laid out whole and nothing it asked for is on its way — a
   * sheet, an image and its decode, a face, but for a lazy image, which
   * holds no `load` (`ResourceStore.pending`). Counted from a layout because
   * a background, a font and an image's chosen source are asked for only
   * as a layout finds them. Told a microtask later, never from inside a
   * paint or a commit: a host runs a page's scripts from them.
   */
  private _lifecycle(): void {
    if (this.destroyed) return;
    const complete = this._source.complete;
    // a stream's parse, where the parse waits at no script, has nothing to
    // tell yet; one that waits tells its sheets, and lets go the script it
    // waits at once they are in
    if (!complete && !this._source.held) return;
    const doc = this._source.document;
    const props = this._props();
    if (complete && this._parsedOf !== doc) {
      this._parsedOf = doc;
      // what is there now the parser made: a sheet a script puts in from
      // here on holds no script back, and nor does one a script put in
      // while the parse waited for it
      this._parserSheets = new Set(
        this._source
          .facts()
          .sheets.filter((ref) => this._parserMade(ref.element))
          .map((ref) => ref.element),
      );
      if (props.onParsed) {
        void Promise.resolve().then(() => {
          if (this._source.document === doc && !this.destroyed) {
            this._props().onParsed?.();
          }
        });
      }
    }
    this._tellSheets();
    // after: a sheet's `load` is the page's before the script it held runs
    this._wakeScripts();
    if (
      !complete ||
      this._loadedOf === doc ||
      !this._tree ||
      this._stale !== Stale.Nothing ||
      this._partial ||
      this._resources.pending > 0 ||
      this._webFonts.loading
    ) {
      return;
    }
    this._loadedOf = doc;
    if (!props.onLoaded) return;
    void Promise.resolve().then(() => {
      if (this._source.document === doc && !this.destroyed) {
        this._props().onLoaded?.();
      }
    });
  }

  /**
   * Note which `<link>`s and `<style>`s the cascade just made or kept read,
   * each with what its sheet imports, and a link's with the `href` it was
   * read from: what a `load` is told from (`_tellSheets`), and what holds a
   * script back (`_blocksScripts`). Every shadow tree's, not only the one
   * its set of sheets was read for: they read alike and are other
   * elements.
   */
  private _noteSheetsInForce(
    read: readonly SheetText[],
    shadows: readonly [string, SheetText[]][],
  ): void {
    const kept = this._sheetsRead;
    const inForce = new Map<Element, SheetInForce>();
    const note = (
      own: readonly SheetText[],
      imports: readonly ImportRead[][] | undefined,
    ) => {
      for (let i = 0; i < own.length; i += 1) {
        const { element, href } = own[i];
        inForce.set(element, { href, imports: imports?.[i] ?? [] });
      }
    };
    note(read, kept?.imports);
    for (const [key, own] of shadows) note(own, kept?.shadows.get(key));
    this._sheetsInForce = inForce;
  }

  /**
   * Tell the host of each `<link rel=stylesheet>` whose sheet came to
   * something since it was told last (HTML, "fetching and processing a
   * resource from a link element"): a `load` once the cascade in force
   * has read it and nothing it imports is on its way — after the restyle
   * that applied it, so a page that takes an old sheet out on the new
   * one's `load` never shows the document under neither — and an `error`
   * where the host declined it, it failed, or an import of it did. Once an
   * `href`: a link given another is told again. A microtask later, as
   * `onParsed` is: this runs inside a layout. A sheet's preload is told
   * as its sheet settles (`isStylePreload`), which waits for no restyle,
   * since nothing reads it.
   */
  private _tellSheets(): void {
    if (!this._props().onSheet) return;
    const facts = this._source.facts();
    let told: [Element, 'load' | 'error'][] | null = null;
    const ask = (refs: readonly SheetRef[]) => {
      for (const ref of refs) {
        if (ref.kind !== 'link') continue;
        if (this._sheetTold.get(ref.element) === ref.href) continue;
        const outcome = this._sheetOutcome(ref.element, ref.href);
        if (!outcome) continue;
        this._sheetTold.set(ref.element, ref.href);
        (told ??= []).push([ref.element, outcome]);
      }
    };
    ask(facts.sheets);
    for (const { sheets } of facts.shadows) ask(sheets);
    // and a `<link rel=preload>`'s once what it fetches came to something
    // (HTML 4.6.7.12): React commits a `precedence` sheet only once the
    // sheet's preload has told one or the other
    for (const el of facts.resources) {
      if (!isStylePreload(el)) continue;
      const href = attr(el, 'href')!;
      if (this._preloadTold.get(el) === href) continue;
      const state = this._resources.state(href);
      if (state !== 'ready' && state !== 'failed') continue;
      this._preloadTold.set(el, href);
      (told ??= []).push([el, state === 'ready' ? 'load' : 'error']);
    }
    if (!told) return;
    const events: [Element, 'load' | 'error'][] = told;
    const doc = this._source.document;
    void Promise.resolve().then(() => {
      if (this._source.document !== doc || this.destroyed) return;
      for (const [element, outcome] of events) {
        this._props().onSheet?.(element, outcome);
      }
    });
  }

  /** What a `<link>`'s sheet came to: `load`, `error`, or null while it,
   *  or the restyle that reads it, or an import of it is on its way. */
  private _sheetOutcome(
    element: Element,
    href: string,
  ): 'load' | 'error' | null {
    const state = this._resources.state(href);
    if (state === 'failed') return 'error';
    if (state !== 'ready') return null;
    const read = this._sheetsInForce.get(element);
    if (read?.href !== href) {
      // not read yet — but for a sheet that is nothing, which no cascade
      // reads, and which has loaded all there is of it
      return this._resources.stylesheet(href)?.text ? null : 'load';
    }
    return this._importsOutcome(read.imports);
  }

  /** What a sheet's imports came to, as `_sheetOutcome` answers. */
  private _importsOutcome(
    imports: readonly ImportRead[],
  ): 'load' | 'error' | null {
    // an import read as nothing failed, or is on its way, or arrived since
    // and waits for the restyle that reads it
    let failed = false;
    for (const { url, text } of imports) {
      if (text !== null) continue;
      if (this._resources.state(url) !== 'failed') return null;
      failed = true;
    }
    return failed ? 'error' : 'load';
  }

  /**
   * Settled once the document has no style sheet that is blocking scripts
   * (HTML, "has a style sheet that is blocking scripts") — of the ones
   * before `script` in it, or with no `script` all of them. A sheet the
   * parser made holds a script back while its `media` holds and it has
   * not come to anything: a `<link>` until it is told as `load` or
   * `error`, which is after the restyle that applied it and what it
   * imports, and a `<style>` until what it imports has. One a script put
   * in holds nothing. A host runs a script the parser met once this
   * settles, so one after a head's `<link>` reads the document as styled
   * by it, and one before it runs while it is on its way, as a browser
   * runs it on meeting it; a deferred script, a module, waits on them all,
   * as a browser runs it after the parse.
   */
  scriptsUnblocked(script: Element | null = null): Promise<void> {
    if (this.destroyed || !this._blocksScripts(script)) {
      return Promise.resolve();
    }
    const doc = this._source.document;
    return new Promise((resolve) =>
      this._scriptWaits.push({ script, doc, resolve }),
    );
  }

  /** Whether a sheet holds a script back, as `scriptsUnblocked` says. */
  private _blocksScripts(script: Element | null): boolean {
    // until the parse ends every sheet the parser made is the parser's
    const made =
      this._parsedOf === this._source.document ? this._parserSheets : null;
    for (const ref of this._source.facts().sheets) {
      if (made ? !made.has(ref.element) : !this._parserMade(ref.element)) {
        continue;
      }
      // one after the script the parser had not met when it got to it
      if (script && !(compareDocumentPosition(ref.element, script) & BEFORE)) {
        continue;
      }
      if (ref.media && !this._mediaHolds([ref.media])) continue;
      if (ref.kind === 'link') {
        if (!this._sheetOutcome(ref.element, ref.href)) return true;
        continue;
      }
      const read = this._sheetsInForce.get(ref.element);
      // not read yet, by the restyle a change to the tree has coming
      if (!read) {
        if (/@import/i.test(ref.text)) return true;
        continue;
      }
      if (!this._importsOutcome(read.imports)) return true;
    }
    return false;
  }

  /** Whether the document's parser made a sheet's element: every one, in
   *  a document parsed somewhere else and handed over (`adopt`), whose
   *  sheets were all in it before any script ran. */
  private _parserMade(element: Element): boolean {
    return !!this._props().document || madeByParser(element);
  }

  /** Let a host run the scripts the sheets before them no longer hold
   *  back, and those of a document that went. */
  private _wakeScripts(): void {
    if (!this._scriptWaits.length) return;
    const doc = this._source.document;
    const waiting: ScriptWait[] = [];
    for (const wait of this._scriptWaits) {
      if (
        wait.doc === doc &&
        !this.destroyed &&
        this._blocksScripts(wait.script)
      ) {
        waiting.push(wait);
      } else {
        wait.resolve();
      }
    }
    this._scriptWaits = waiting;
  }

  /**
   * `work`, its time added to the element's own since the last paint
   * (`_work`): a layout, a build, a frame of the animations, the sprites
   * offered and the paint, each once where one reaches another.
   */
  private _counted<T>(work: () => T): T {
    if (this._timing) return work();
    this._timing = true;
    const from = frameClock.now();
    try {
      return work();
    } finally {
      this._timing = false;
      this._work += frameClock.now() - from;
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
    if (this._facesOwed) this._takeFaces();
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
    this._geometry += 1;
    // Nothing but the viewport: the size core laid this element out at came
    // from a layout under the old one, and nothing else will tell it so.
    const onlyViewport =
      this._stale === Stale.Nothing && this._laidOutWidth === target;
    const wasWidth = this._documentWidth;
    const wasHeight = this._documentHeight;
    // What is at the top of what can be seen, where a layout at another
    // width, or the one that lays out what a drag kept, is about to move
    // it (`_keepAnchor`): taken before a build, whose boxes have no place
    if (this._laidOutWidth !== target || this._partial || this._owedAsk) {
      this._anchorFrame();
    }

    // the styles a build may keep (`_restyleOnly`), unless something
    // found below changes them all
    let restyleOnly = this._stale === Stale.Boxes ? this._restyleOnly : null;
    this._restyleOnly = null;
    // and the elements whose boxes it can make otherwise, where every change
    // said which — for as long as nothing below asks for more than they
    // did, which gives `restyleOnly` another set (`_subtreeBuild`)
    let seeds = restyleOnly ? this._buildSeeds : null;
    let always = seeds ? this._buildAlways : null;
    const pseudoRules = this._buildPseudo;
    let tails = seeds ? this._buildTails : null;
    let parsed = !!seeds && this._buildParsed;
    this._buildSeeds = null;
    this._buildAlways = null;
    this._buildPseudo = HOVER_PSEUDO_NONE;
    this._buildTails = null;
    this._buildParsed = false;
    let seededWith = restyleOnly;
    // whether `restyleOnly` names only what a crossing or a change to the
    // tree reached, and whether a crossing is what restyles (`_stopAt`)
    let follow = restyleOnly !== null && this._restyleFollows;
    this._restyleFollows = false;
    let crossing = false;
    /** What a crossing, a `vw` or an image's new source restyles, added to
     *  what a change asked for, as `_sheetsAdded` adds what its rules
     *  reach: each its own subtree's to build (`seeds`) where the change
     *  named its own, or all there is to build where none asked. */
    const seedWith = (reached: Set<Element>): void => {
      if (this._stale < Stale.Boxes) {
        this._stale = Stale.Boxes;
        restyleOnly = seededWith = reached;
        seeds = new Set(reached);
        always = seeds;
      } else if (restyleOnly && seeds && restyleOnly === seededWith) {
        for (const el of reached) {
          restyleOnly.add(el);
          seeds.add(el);
          always?.add(el);
        }
      } else if (restyleOnly && reached.size) {
        restyleOnly = new Set([...restyleOnly, ...reached]);
      }
      follow = true;
    };
    // what is owed that this frame or this read asks for (`_settleOwed`)
    if (this._owedAsk) {
      // but none of it under a drag's layout: what a box measures of what
      // it holds is kept for its life, and what it holds is cut short by
      // what is set aside (`setAside`). The drag lays out what can be seen
      // in the faces there are, and what waits runs once it has rested.
      const reached = this._partial
        ? EMPTY_SET
        : this._settleOwed(this._owedAsk);
      this._owedAsk = 0;
      if (reached.size) seedWith(new Set(reached));
    }
    if (this._stale >= Stale.Style || !this._cascade) {
      this._restyle(target);
      this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
      restyleOnly = null;
    } else if (this._sheetsOwed) {
      // Sheets put in, written to or come: the cascade made again, and
      // what the rules it adds can style styled besides what the change
      // reached, every other element keeping its style — where all the
      // sheets did is add rules (`_sheetsAdded`). The Guardian's, BBC's and
      // GitHub's scripts write their components' rules into a `<style>` as
      // each first renders, and each restyled the whole document.
      const reached = this._sheetsAdded(target, viewport);
      if (reached && restyleOnly) {
        for (const el of reached) {
          restyleOnly.add(el);
          seeds?.add(el);
          always?.add(el);
        }
        follow = true;
      } else restyleOnly = null;
    } else if (this._cascade.mediaBand(target, viewport) !== this._mediaBand) {
      // A resize that crossed a `@media` breakpoint is the one resize that
      // does have to restyle. Knowing which resizes those are is why the
      // breakpoints are collected at parse time — and which elements, is
      // the rules it turns on and off: those they match are styled again,
      // and the elements under them where what they are computed from came
      // out other than it was (`Cascade.crossed`, `KeptStyles.follow`),
      // where every element was. A crossing they match nothing of styles
      // nothing.
      const reached = this._crossed(target, viewport);
      crossing = reached !== null;
      if (reached === null) {
        this._restyle(target);
        this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
        restyleOnly = null;
      } else {
        this._mediaBand = this._cascade.mediaBand(target, viewport);
        // and only their boxes built again, as a change's are: what a
        // breakpoint turns on lays out otherwise what it matches, and
        // nothing a build makes of what is around them
        if (reached.size) seedWith(reached);
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
    // candidate, or the same one at another density, is another size: its
    // box takes the size in place and the document is laid out again
    // (`_showInPlace`) — or, where an image's `<source>` sizes it another
    // way now (`dimensionSource`), the boxes are built again, keeping every
    // style but those images', as a `vw` has them built again. Either way
    // the sizes other widths came to stand, since what a width chooses is
    // the same each time it is asked.
    const chose = this._choose(target, viewport);
    if (chose || this._imagesOwed.size) this._imagesChosen();
    let relayout = false;
    if (
      chose &&
      chose.shown.length &&
      !chose.restyle.length &&
      this._tree &&
      this._stale < Stale.Boxes
    ) {
      this._showInPlace(this._tree, chose.shown);
      // laid out again — where the width or the viewport moved, as that
      // layout is anyway, which may stop where what can be seen ends
      // (`_stopAt`): a stale layout is laid out whole
      relayout = this._laidOutWidth === target && !viewportMoved;
    } else if (chose && (chose.shown.length || chose.restyle.length)) {
      // each image's subtree built again, restyled where another
      // `<source>` sizes it — and a set of what to restyle made again only
      // where it adds to it: made again for nothing, a crossing's own
      // subtrees were the whole document's
      seedWith(new Set(chose.restyle));
      if (seeds && restyleOnly === seededWith) {
        for (const el of chose.shown) {
          seeds.add(el);
          always?.add(el);
        }
      }
    }
    // A `vw` or a `vh` is a number by the time a style holds it, so the
    // styles computed for another viewport are wrong for this one: those
    // that hold a length of the side that moved are computed again, and
    // what inherits from them (`Cascade.viewportReaders`), and every style
    // where something else reads it — a query on the viewport's height, a
    // container query's `vw`. A document that reads neither — most — goes
    // on skipping the cascade on a resize.
    const sides =
      (this._styledWidth !== target ? VIEWPORT_WIDTH : 0) |
      (this._styledHeight !== viewport ? VIEWPORT_HEIGHT : 0);
    if (
      (sides & VIEWPORT_WIDTH && cascade.queriesViewportWidth) ||
      (sides & VIEWPORT_HEIGHT && cascade.queriesViewportHeight) ||
      (!this._tree &&
        ((sides & VIEWPORT_WIDTH && cascade.readsViewportWidth) ||
          (sides & VIEWPORT_HEIGHT && cascade.readsViewportHeight)))
    ) {
      if (this._stale < Stale.Boxes) this._stale = Stale.Boxes;
      restyleOnly = null;
    } else if (
      this._tree &&
      this._stale < Stale.Style &&
      ((sides & VIEWPORT_WIDTH && cascade.readsViewportWidth) ||
        (sides & VIEWPORT_HEIGHT && cascade.readsViewportHeight))
    ) {
      const tree = this._tree;
      const readers = cascade.viewportReaders(tree.styles, sides);
      // a root whose font is such a length moves every `rem` and `rlh`
      // with it, wherever they are, under parents whose styles stay
      const rootFont = this._rootFontMoves(tree, readers);
      if (rootFont) {
        for (const el of cascade.rootReaders(tree.styles, rootFont)) {
          readers.add(el);
        }
      }
      // the root box, standing in for a body or an `<html>` the markup does
      // not write, is styled in every build: one that holds such a length
      // is built again with every element's style kept
      const rootReads =
        cascade.holdsViewport(tree.root.style, sides) ||
        (!!tree.impliedHtml && cascade.holdsViewport(tree.impliedHtml, sides));
      // and where what reads it only inks, or is drawn nowhere, it is
      // restyled in place, as a hover is, and the boxes kept
      // — up to an eighth of the document, past which the build of all of
      // it the other way costs less
      const limit = Math.max(HOVER_RESTYLE_LIMIT, tree.styles.size >> 3);
      const inPlace =
        readers.size > 0 &&
        !rootReads &&
        !(rootFont && cascade.pseudoReadsRoot(rootFont));
      // and a `::before` or an `::after` that reads it is made again with
      // its element, which is among the readers (`viewportReaders`): Apple's
      // product pages draw a stripe `width: 100vw` from one, and every step
      // of a drag built all of the page for it
      const pseudo = cascade.pseudoReadsViewport(sides)
        ? HOVER_PSEUDO_GENERATED
        : HOVER_PSEUDO_NONE;
      // What a drag's layout set aside is not styled at each step of it,
      // only what can be seen: no box of it is restyled here, and the
      // styles were most of a step. Apple's page holds 107 such elements,
      // of which a screenful are drawn. They are owed theirs (`_stylesOwed`).
      const held = this._heldBackOf(tree, readers);
      const seen = held
        ? new Set([...readers].filter((el) => !held.has(el)))
        : readers;
      // what holds it and all that holds, or where that is more than a
      // restyle in place takes, followed down from them (`from`)
      const reach = inPlace ? withDescendants(seen, limit) : null;
      if (
        inPlace &&
        this._stale === Stale.Nothing &&
        this._restyleInPlace(
          reach ?? EMPTY_SET,
          (el) => readers.has(el),
          pseudo,
          limit,
          reach ? null : seen,
          BOX_LENGTHS | FONT_LENGTHS,
        )
      ) {
        if (held) {
          for (const el of held) this._stylesOwed.add(el);
          this._asideOwed = true;
        }
        if (this._stylesOwed.size) {
          for (const el of seen) this._stylesOwed.delete(el);
        }
        this._styledWidth = target;
        this._styledHeight = viewport;
      } else if (readers.size || rootReads) {
        // their subtrees built again, where the root box, which no subtree
        // is, holds none: Apple's gallery draws a slide's `::after` in `vw`
        // turned by a `translate` in `vw`, an image `width` in `vw` beside
        // it, and every step of a drag built all of the page for them
        if (!rootReads) seedWith(readers);
        else if (this._stale < Stale.Boxes) {
          this._stale = Stale.Boxes;
          restyleOnly = readers;
          follow = true;
        } else if (restyleOnly) {
          restyleOnly = new Set([...restyleOnly, ...readers]);
          follow = true;
        }
        // and the tree it builds is laid out as a crossing's is while the
        // width moves (`_stopAt`): down to what can be seen, measured from
        // all it holds. Python's sidebar is a quarter of the viewport wide,
        // and every step of a drag built the boxes and laid the whole
        // reference out under them.
        // Not where the tree before set aside what something laid out is
        // placed against: that layout is made again whole, and the
        // Guardian, whose ads are `max-width` in `vw`, paid for two a step.
        if (!laidWhole(tree)) crossing = true;
      }
    }

    if (relayout && this._stale < Stale.Layout) this._stale = Stale.Layout;

    // Built and laid out — and, where an image whose `sizes` is its own
    // laid-out width (`auto`) draws another candidate for the width it was
    // just laid out at, built again, keeping every style, for the size that
    // candidate has, and laid out again. Once: HTML's `contain: size` on
    // such an image (the UA sheet) lays it out the same whichever candidate
    // it holds, so the second layout leaves every width as the first did,
    // and the candidates picked again for them are the same.
    // whether the last layout asked the document's least width, which core's
    // content floors do (`question` below)
    let question = false;
    for (let pass = 0; ; pass += 1) {
      if (this._stale >= Stale.Boxes || !this._tree) {
        const look = this._deviceLook();
        // A build a pointer move asked for styles the elements the move
        // reached, and takes every other element's from the tree it replaces
        // (`Cascade.beginSharing`): the first build only, since a second is
        // one the first found a reason for — a face, an image's size.
        let kept: KeptStyles | null =
          restyleOnly &&
          this._tree &&
          (this._styledWith === cascade || this._keptFor === cascade)
            ? {
                styles: this._tree.styles,
                restyle: this._withAnimated(
                  this._withOwed(restyleOnly),
                  this._tree,
                ),
                follow: follow || this._stylesOwed.size > 0,
                root: this._tree.root.style,
              }
            : null;
        const timeline = this._clockIn(cascade);
        const options = (): BuildOptions => ({
          cascade,
          kept,
          transition: this._vt?.phase === 'live' ? this._transitionTree : null,
          scale: this._scale,
          imageSize: (el) => this._videoSizes.get(el) ?? this._imageSize(el),
          holdsDocument: (el) =>
            this._resources.holdsDocument(imageUrlOf(el) ?? ''),
          sizePending: (el) => this._sizePending(el),
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
        const boxes = () => buildBoxes(this._source.document, options());
        // Where every change the build is for said which elements its boxes
        // can differ in, the tree keeps every box they cannot, and only
        // their subtrees are built (`_subtreeBuild`) — the first build of
        // the pass only, whose `restyleOnly` is still theirs.
        const subtrees =
          kept && seeds && restyleOnly === seededWith
            ? this._seedsThatMoved(
                seeds,
                always,
                tails,
                pseudoRules,
                cascade,
                kept!,
              )
            : null;
        // a build that styles every element ends the animations of the ones
        // it does not reach: under `display: none`, or out of the document
        let apart = false;
        const build = (first = false) => {
          timeline?.beginPass(!kept);
          const built =
            first &&
            subtrees &&
            this._subtreeBuild(subtrees, options(), tails, parsed);
          apart = !!built;
          const tree = built || boxes();
          timeline?.endPass();
          // and one that keeps styles ends the transitions of the elements
          // it left out, taken out of the document
          if (kept) timeline?.endOutside(tree.styles);
          return tree;
        };
        this._tree = build(true);
        // A build of some subtrees during a drag leaves what a restyle in
        // place owed what the drag set aside owed, and its tree stops where
        // a step's would, as a breakpoint's does (`_stopAt`): every write of
        // Apple's resize handlers during a drag built and laid out all of
        // their page.
        if (apart) {
          if (this._partial) crossing = true;
        } else {
          this._asideOwed = false;
          this._stylesOwed.clear();
          this._owedDone();
        }
        kept = null;
        if (this._vt?.phase === 'live') this._armTransitionFrame();
        this._styledWith = cascade;
        this._keptFor = null;
        this._styledWidth = target;
        this._styledHeight = viewport;
        this._requestBackgrounds(this._tree);
        let again = this._contentImagesArrived(this._tree);
        // the faces the styles just asked for, of the families the document
        // loads itself — which, answered at once, change the styles asking
        if (this._webFonts.request(textOfTree(this._tree))) {
          this._layouts = null;
          again = true;
        }
        if (again) {
          this._tree = build();
          this._owedDone();
        }
        // a frame's build keeps them, for `_rebuildFrame` to move to the new
        // boxes or give up (`_carrySprites`)
        if (this._carryingFrom === null) this._sprites?.clear();
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
        // A layout at a fraction of the width the document is drawn at
        // answers a question about its size: core's content floors lay a
        // tree out with little room on offer, to learn what it needs. (With
        // none it lays nothing out, `_sizeAt`.)
        // It lays out whole, and so does the one after it: the places the
        // flow keeps its blocks by (`keepAbove`) are the question's then,
        // and the document is drawn at none of them. It moves nothing on
        // screen (`_keepAnchor`).
        question = target * 2 < this.abs.width;
        const stop =
          question || this._questioned
            ? undefined
            : this._stopAt(target, viewportMoved, crossing);
        // a layout that puts back what a drag set aside, whole, lays it out
        // in the styles its elements have now, which a restyle in place
        // that passed over it left to a build (`_asideOwed`)
        if (!stop && this._asideOwed) {
          this._asideOwed = false;
          this._stale = Stale.Boxes;
          restyleOnly = new Set<Element>();
          follow = false;
          // the build and its layout are this pass's
          pass -= 1;
          continue;
        }
        if (this._scrollOffsetsOf !== this._source.document) {
          this._scrollOffsets.clear();
          this._scrollOffsetsOf = this._source.document;
        }
        setScrollOffsets(this._tree, this._scrollOffsets, this._scale);
        // and where the pane has the viewport, for what is anchored across
        // its scroll, and whether the layout is a question no frame draws
        if (this._tree.anchors) {
          setViewport(this._tree, this._viewportAt());
          layoutAsks(this._tree, question);
        }
        const result = layoutDocument(
          this._tree,
          this._layoutFonts(),
          target,
          viewport,
          this._scale,
          stop?.until,
          stop?.above,
          stop?.reach,
        );
        this._questioned = question;
        this._sizedTree = question ? null : this._tree;
        // the sticky boxes the viewport keeps, where the pane is scrolled to
        this._followViewport();
        this._stickyMoved = false;
        // what was at the top of what can be seen stays there on screen
        if (!question) this._keepAnchor();
        // A tree a crossing built and laid out down to where the layout
        // stops: what it set aside was never laid out, and is no height
        // to guess the document's from, so it is as tall as it was.
        const fresh = result.partial && this._wholeTree !== this._tree;
        if (fresh) result.height = Math.max(result.height, wasHeight);
        this._partial = result.partial;
        // a layout at the width the drag is on waits for the rest the step
        // armed, and arms none: a page writing at every frame would put
        // off the whole layout for good
        if (result.partial && this._widthLaid !== target) this._armSettle();
        else if (!result.partial) this._wholeTree = this._tree;
        // from when the layout is done: one that took long is no rest
        if (this._widthLaid !== -1 && this._widthLaid !== target) {
          this._widthMovedAt = resizeClock.now();
          this._laidSincePaint = true;
          // a drag the frames before fell behind is drawn cheaper from the
          // frame this layout is for
          if (!this._cheap && this._behind()) this._cheapen();
        }
        this._widthLaid = target;
        // The same boxes, somewhere else and another size — but for the
        // layout a restyle in place asks for where what it moved reached the
        // document's end, to learn its height: at the width and under the
        // viewport the boxes were laid out at, with nothing that layout reads
        // changed, they come out where they were, and the surfaces kept for
        // them still hold them. A small document whose card turns at its
        // foot is laid out every frame of the turn.
        // a frame's build lays out a new tree, at the width the one before
        // it was laid out at, where it keeps them
        const from = this._carryingFrom ?? laidOutAt;
        if (target !== from || viewportMoved) {
          // what a box laid out as it was when drawn still draws, wherever
          // the layout moved it; the rest is drawn again (`relaid`)
          this._sprites?.relaid((box, shape) =>
            shapesEqual(shape, layoutShape(box as Box)),
          );
          this._filtered?.staleAll();
        }
        this._documentWidth = result.width;
        this._documentHeight = result.height;
        this._laidOutWidth = target;
        this._laidOutUnder = viewport;
        this._layoutReadsViewport = result.readsViewportHeight;
        // and a snap container at rest where it was snapped to, the
        // viewport as far as the document reaches now
        if (!question && !result.partial) this._resnap();
        this._sizes.delete(target);
        this._sizes.set(target, { width: result.width, height: result.height });
        if (this._sizes.size > SIZES_KEPT) {
          this._sizes.delete(this._sizes.keys().next().value!);
        }
        this._reportControls();
        this._reportMedia();
        this._reportEmbedded();
        this._reportStops();
        this._reportViewport();
      }
      if (!laysOut || !this._tree) break;
      const chose = pass === 0 && this._chooseLaidOut(this._tree);
      if (chose) this._imagesChosen();
      // And where the container queries answer otherwise for the sizes the
      // layout gave their containers, built again restyling the elements
      // they answer for, and laid out again — but for a layout that asked
      // the document's least width, which no answer moves: a container's
      // inline size is its own, whatever is in it, and nothing outside one
      // is under its query.
      const queried =
        pass < CONTAINER_PASSES && !question
          ? this._containersMoved(this._tree)
          : null;
      if (!chose && !queried) break;
      this._stale = Stale.Boxes;
      restyleOnly = seededWith = queried ?? new Set<Element>();
      if (queried) follow = true;
      // and only their subtrees built, where a build of the whole for the
      // two elements a query answers otherwise for followed every layout of
      // GitHub's and Next.js's, a tenth of a second each
      seeds = always = queried && new Set(queried);
      tails = null;
      parsed = false;
    }
    this._stale = Stale.Nothing;
    if (!this._owed.size && this._measureOwed) {
      this._measureOwed = false;
      if (!this._measuring) {
        this.invalidateMeasure('content');
        this.invalidate(true, this, 'props');
      }
    }
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
    // what the triggers say of where the layout put their subjects
    this._evaluateTriggers();
    this._scheduleFrame();
  }

  /**
   * The elements a resize to `target` restyles, having crossed a breakpoint
   * (`Cascade.crossed`), or null where the whole document is: where the
   * boxes were not styled by this cascade at the band it is at, or a face
   * the document loads sits under a media query, which the width chooses as
   * it chooses a rule (`_restyle`).
   */
  private _crossed(target: number, viewport: number): Set<Element> | null {
    const cascade = this._cascade;
    if (!cascade || !this._tree || this._styledWith !== cascade) return null;
    if (
      cascade.mediaBand(cascade.viewportWidth, cascade.viewportHeight) !==
      this._mediaBand
    ) {
      return null;
    }
    if (this._sheetsRead?.faces.some((face) => face.rule.media)) return null;
    return cascade.crossed(
      cascade.viewportWidth,
      target,
      this._source.document,
      cascade.viewportHeight,
      viewport,
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
  ):
    | {
        until: number;
        above: number | undefined;
        reach: { box: Box; below: number } | undefined;
      }
    | undefined {
    const was = this._widthLaid;
    if (was === -1 || viewportMoved || this._lifted.size > 0) return undefined;
    // A layout at the width a drag is on, while the drag holds the rest of
    // the document aside and has not rested (`_partial`, `_armSettle`):
    // what a page's resize handler changed at that step, which stops where
    // the step's layout did. Laid out whole, every write of Apple's handlers
    // laid out all of their page, and built all of it for what the drag's
    // restyles in place owed what was set aside (`_asideOwed`).
    const again =
      was === target &&
      this._partial &&
      this._settleTimer !== null &&
      this._widthMovedAt > -Infinity;
    if (!again) {
      if (was === target) return undefined;
      // a drag's first move is as small as the rest: the edge goes a few
      // pixels an event, and the layout of the whole document it waited
      // for was the drag catching at its start — where a width set once, a
      // window maximized or a sidebar shown, jumps, and is exact at once
      const small = Math.abs(target - was) <= DRAG_STEP_CSS_PX * this._scale;
      if (!small && resizeClock.now() - this._widthMovedAt >= RESIZE_BURST_MS) {
        return undefined;
      }
    }
    // Anything else stale lays out whole, and so does a tree no layout has
    // laid out whole — but for the band a drag crossed, and the tree it
    // built: a layout that stops measures what it sizes from all it holds
    // (`probeWhole`), so it needs none of a whole layout's sizes.
    if (
      !crossing &&
      ((!again && this._stale >= Stale.Layout) ||
        (this._wholeTree !== this._tree && this._crossedTree !== this._tree))
    ) {
      return undefined;
    }
    const until = this._seenBottom() + this._viewportHeight();
    // and from the top of what can be seen, what ends above it kept as it
    // was, where the pane that scrolls the document keeps what is at its
    // top where it is on screen once that is laid out (`_keepAnchor`)
    const above = this._anchors() ? this._seenTop() : undefined;
    // A tree a breakpoint built has no places to keep, and laid out down to
    // where the layout stops, it could set aside what is at the top of what
    // can be seen, where the text above it came to more at the new band:
    // it is laid out down to that, wherever it lands, and as far past it
    // as the layout would have gone (`LayoutContext.reach`)
    let reach: { box: Box; below: number } | undefined;
    const anchor = this._frameAnchor;
    const tree = this._tree;
    if (crossing && anchor && tree && tree !== anchor.tree) {
      const box = anchor.el ? this._firstBoxesOf(tree).get(anchor.el) : null;
      if (!box) return undefined;
      reach = { box, below: until - (anchor.y + anchor.asked) };
    }
    return (until - (above ?? 0)) * 2 < this._documentHeight
      ? { until, above: reach ? undefined : above, reach }
      : undefined;
  }

  /** How far down the document the top of what can be seen is: the top of
   *  the pane that scrolls it, or of the window, less where the document
   *  starts. */
  private _seenTop(): number {
    const viewport = this._viewport();
    const top = (viewport ? viewport.y : 0) - this.contentBox().y;
    // and where the pane will have it once it shifts by what this frame's
    // layouts asked of it (`_keepAnchor`), which the layout pass lands
    return Math.max(0, top + this._pendingShift());
  }

  /** What this frame's layouts asked the pane to shift by that it has not
   *  landed yet: all of it before the pane places its content, in the
   *  layout pass, and none after, in the paint. */
  private _pendingShift(): number {
    return this._painting ? 0 : (this._frameAnchor?.asked ?? 0);
  }

  /**
   * Whether a pane scrolls the document that can keep what is at the top
   * of its viewport where it is on screen while the document moves under
   * it: react-x11's `anchorScrollBy`, which a core before it has not.
   */
  private _anchors(): boolean {
    return (
      typeof (this as { anchorScrollBy?: unknown }).anchorScrollBy ===
        'function' && this._viewport() !== null
    );
  }

  /**
   * What is at the top of what the pane that scrolls the document shows,
   * and where, as the document was last laid out (`anchorAt`): for a
   * layout at another width, which moves it by what the text above it
   * comes to there, to keep it where it is on screen (`_keepAnchor`). Null
   * where nothing above the viewport could move it — the document scrolled
   * to its top — where no pane scrolls the document, and where the pane
   * cannot follow it (`_anchors`).
   */
  private _anchorFrame(): void {
    if (this._frameAnchor) return;
    const shown = this._shown;
    if (!shown || !this._anchors()) return;
    this._frameAnchor = { ...shown, asked: 0 };
    // A frame's layout and paint are one synchronous call, so the frame is
    // over by the first microtask after it, and the pane has landed what
    // it was asked
    const end = () => {
      this._frameAnchor = null;
    };
    if (timers.queueMicrotask) timers.queueMicrotask(end);
    else void Promise.resolve().then(end);
  }

  /** What was at the top of what can be seen when this frame started to
   *  lay out, and how far the pane was asked to move to keep it there
   *  (`_anchorFrame`, `_keepAnchor`). */
  private _frameAnchor: (Anchor & { asked: number }) | null = null;

  /**
   * What was at the top of what can be seen when the document was last
   * drawn, and where (`anchorAt`): what a layout at another width keeps
   * where it is on screen. Taken as it is drawn, where the boxes are what
   * the screen shows — a layout since may have been one to answer a
   * question about the document's size, at a width it is not drawn at, and
   * moved them all (`_keepAnchor`). Null where nothing above the viewport
   * could move it — the document scrolled to its top — and where no pane
   * can follow it (`_anchors`).
   */
  private _shown: Anchor | null = null;

  /** Whether the paint is running, after the pane placed what it holds:
   *  what the frame asked it to shift by has landed (`_pendingShift`). */
  private _painting = false;

  /** Whether the last layout answered a question about the document's
   *  size, at a width it is not drawn at (`_update`): the next lays out
   *  whole. A pane asked for what a document a pixel wide came to clamps
   *  it to its end, and the shift back from there lands at its top. */
  private _questioned = false;

  private _noteShown(tree: BoxTree): void {
    this._painting = true;
    try {
      if (!this._anchors()) {
        this._shown = null;
        return;
      }
      const top = this._seenTop();
      const box = top > 0 ? anchorAt(tree, top) : null;
      this._shown = box ? { tree, box, el: box.el, y: box.y } : null;
    } finally {
      this._painting = false;
    }
  }

  /**
   * Keep what was at the top of what can be seen there on screen, now the
   * document is laid out: the pane that scrolls it moves its offset by as
   * far as the layout moved it, in the pass it was laid out in (react-x11's
   * `anchorScrollBy`, CSS Scroll Anchoring 1). A window dragged narrower
   * breaks the text above into more lines, and the paragraph being read
   * went down the page by as many, a page or two down a long article.
   * Found again by its element where a breakpoint built the boxes again.
   */
  private _keepAnchor(): void {
    const anchor = this._frameAnchor;
    const tree = this._tree;
    if (!anchor || !tree) return;
    const box =
      tree === anchor.tree
        ? anchor.box
        : anchor.el
          ? this._firstBoxesOf(tree).get(anchor.el)
          : undefined;
    if (!box || heldBack(tree, box)) return;
    // A frame may lay the document out more than once — a breakpoint's
    // build and the width a content floor asks about — and each moves the
    // anchor from where the last left it: the pane is asked for what it
    // has not been asked yet
    const moved = box.y - anchor.y;
    const shift = moved - anchor.asked;
    if (shift === 0 || !Number.isFinite(shift)) return;
    anchor.asked = moved;
    // the pane following this is no reader's scroll (`_followOwed`)
    this._owedTop += shift;
    (
      this as unknown as { anchorScrollBy(dx: number, dy: number): boolean }
    ).anchorScrollBy(0, shift);
  }

  /** How far down the document what can be seen of it reaches: the bottom
   *  of the pane that scrolls it, or of the window, less where the
   *  document starts. */
  private _seenBottom(): number {
    const viewport = this._viewport();
    const bottom = viewport
      ? viewport.y + viewport.height
      : (this.root?.abs?.height ?? 0);
    return Math.max(0, bottom - this.contentBox().y + this._pendingShift());
  }

  /**
   * Lay the document out whole once the width has rested — and where the
   * window says a drag of its edge is still under way (`liveResizing`,
   * from AppKit's begin of the drag to its end, which a `<Frame>`'s pane
   * hears from its host), once the drag is over: a hand that pauses a
   * drag is still dragging, and the whole of a long document, laid out at
   * every pause, held the frame that came after it — Wikipedia's longest
   * articles 60 to 100 ms, at every pause of a drag. A window that says
   * nothing of it — X11's, a window not being dragged — rests when its
   * width does.
   */
  private _armSettle(): void {
    if (this._settleTimer !== null) resizeClock.disarm(this._settleTimer);
    this._settleTimer = resizeClock.arm(() => {
      this._settleTimer = null;
      if (this.destroyed) return;
      const live = this._liveResizing();
      // a drag drawn cheaper is drawn as at rest once it is over, and once
      // the hand that drags it holds still (`DRAG_REST_MS`)
      if (
        this._cheap &&
        (!live || resizeClock.now() - this._dragFrameAt >= DRAG_REST_MS)
      ) {
        this._drawAtRest();
      }
      if (live) {
        if (this._partial || this._cheap || this._overBudget.length) {
          this._armSettle();
        }
        return;
      }
      // what the drag's frames cost, and which sizes it moved, are its own
      this._overBudget.length = 0;
      this._tileSizes = new WeakMap();
      if (!this._partial) return;
      this._widthMovedAt = -Infinity;
      this._invalidate(Stale.Layout);
    }, RESIZE_SETTLE_MS);
  }

  /**
   * Whether the drag under way fell behind its edge: two of its last three
   * frames drawn as at rest ran past `FRAME_BUDGET_MS`, and the window
   * says it is being dragged (`liveResizing`). A frame drawn cheaper is
   * none of the three — it is cheap because it is drawn so, and says
   * nothing of what a frame drawn as at rest would cost — so a drag that
   * fell behind is drawn cheaper at every step until it ends, and from the
   * first step after a rest, rather than at rest every other frame. A
   * window that says nothing of a drag — X11's — is drawn as at rest.
   */
  private _behind(): boolean {
    let over = 0;
    for (const was of this._overBudget) if (was) over += 1;
    return over >= 2 && this._liveResizing();
  }

  /** A drag drawn cheaper from now (`_behind`), until it rests. */
  private _cheapen(): void {
    this._cheap = true;
    // the document's clock makes no frame while it is
    this._disarmFrame();
    this._armSettle();
  }

  /**
   * A drag drawn cheaper drawn as at rest: what was drawn cheaper at its
   * frames is drawn again — and so is each surface kept for a box, which a
   * frame may have drawn something cheaper on — and the document's clock
   * makes the frame its animations have got to.
   */
  private _drawAtRest(): void {
    this._cheap = false;
    if (this._drawnCheaper) {
      this._drawnCheaper = false;
      this._sprites?.clear();
      this._filtered?.staleAll();
      this.invalidate(false, this, 'content');
    }
    this._scheduleFrame();
  }

  /** Whether the window this is in is being resized live (`_armSettle`). */
  private _liveResizing(): boolean {
    const root = this.root as { window?: { liveResizing?: unknown } } | null;
    return root?.window?.liveResizing === true;
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
    const scripting = props.scripting ?? false;
    const key = `${target}|${viewport}|${s}|${scheme}|${reducedMotion}|${scripting}|${this._source.revision}`;
    if (key === this._choseIn) return null;
    this._choseIn = key;
    return this._images.choose(
      facts.pictures,
      this._sourceEnv(target, viewport),
    );
  }

  /** What a source is chosen in, at `target` and `viewport`, in device
   *  pixels (`SourceEnv`). */
  private _sourceEnv(target: number, viewport: number): SourceEnv {
    const s = this._scale;
    const props = this._props();
    return {
      width: target / s,
      height: viewport / s,
      scale: s,
      scheme: props.look.colorScheme,
      reducedMotion: props.reducedMotion ?? false,
      scripting: props.scripting ?? false,
      decodes: decodesImageType,
    };
  }

  /**
   * Take what each of `images` shows now into its box, as a build would
   * make it: the size of the source it shows, at the density it was
   * chosen at, or the size its attributes give while nothing it chose has
   * arrived — and what the boxes around it measured of it, for their
   * lives, is forgotten (`forgetSizes`). An image with no box draws
   * nothing. BBC's images are `w` candidates with a `sizes` in `vw`, so at
   * every step of a drag each showed the candidate it showed at another
   * density, and the boxes were built for it.
   */
  private _showInPlace(tree: BoxTree, images: readonly Element[]): void {
    // the tree's image boxes, which a layout that stops does not hide as it
    // hides them from the root
    const boxes = this._imageBoxesOf(tree);
    const taken: Box[] = [];
    for (const el of images) {
      const box = boxes.get(el);
      if (box) taken.push(box);
    }
    const s = this._scale;
    for (const box of taken) {
      const el = box.el!;
      const scale = s * box.style.effectiveZoom;
      const size = this._imageSize(el);
      const next = size
        ? intrinsicsOf(size, scale)
        : awaitedIntrinsics(this._dimensionSource(el), scale);
      // and it waits for what it chose, as a box built now would
      if ((!size || this._sizePending(el)) && !tree.awaiting.includes(box)) {
        tree.awaiting.push(box);
      }
      if (!sameIntrinsic(box.intrinsic, next) && !sizedAnyway(box)) {
        forgetSizes(box);
      }
      box.intrinsic = next;
      this._dropSprites(box, true);
      if (this._lifted.size && this._insideLifted(box)) {
        this._spriteGen += 1;
        this.spritesChanged();
      }
    }
  }

  /** The boxes of a tree's images, by element (`BoxTree.images`). */
  private _imageBoxesOf(tree: BoxTree): Map<Element, Box> {
    let index = this._imageBoxes;
    if (index?.tree !== tree) {
      const of = new Map<Element, Box>();
      for (const box of tree.images) if (!of.has(box.el!)) of.set(box.el!, box);
      index = this._imageBoxes = { tree, of };
    }
    return index.of;
  }

  private _imageBoxes: { tree: BoxTree; of: Map<Element, Box> } | null = null;

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

  /** `near`: only the controls within it are asked what is over them,
   *  for a scroll, which moves boxes over the viewport alone. */
  private _reportControls(near: Rect | null = null): void {
    const tree = this._tree;
    const report = this._props().onControls;
    if (!tree || !report) return;
    this._followHeld();
    // The boxes are device pixels; each rect becomes the style of a widget
    // mounted beside this element, and a style is logical.
    const s = this._scale;
    const cascade = this._cascade;
    const placeholderOf = cascade
      ? (el: Element, style: ComputedStyle) =>
          cascade.placeholderStyle(el, style)
      : undefined;
    const shift = this._fixedShift();
    this._controlsShift = shift;
    // a whole report follows a layout or a restyle, which can change what
    // the fixed boxes fill (`fixedGround`)
    if (!near) {
      FIXED_GROUND.delete(tree);
      this._covered.clear();
    }
    const rects = controlRectsOf(
      tree,
      s,
      placeholderOf,
      shift,
      near,
      this._covered,
      this._fonts(),
    ).map((r) =>
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
    // A field with the focus that a drag set aside keeps its widget where
    // it was: unmounted, the focus would go with it, and the caret
    // (`WidgetBoxes`). Set aside is out of sight, above what can be seen or
    // below it, and so is where the field was a width ago.
    const focus = this._focus.element;
    if (focus && !rects.some((r) => r.element === focus)) {
      const kept = this._controls.find((r) => r.element === focus);
      const box = kept && tree.controls.find((b) => b.el === focus);
      if (box && heldBack(tree, box)) {
        const order = tree.controls.indexOf(box);
        const at = rects.findIndex(
          (r) => tree.controls.findIndex((b) => b.el === r.element) > order,
        );
        rects.splice(at === -1 ? rects.length : at, 0, kept!);
      }
    }
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
    this._covers = new Map();
    this._mediaLaid = tree.media.length
      ? mediaRectsOf(
          tree,
          this._scale,
          (el) => this._sourceOf('video', el),
          this._covers,
        )
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
    const rects = this._mediaLaid.map((laid) => {
      const rect = this._viewportRect(laid, FIXED_OVER.get(laid) ?? fixed);
      const asked = this._mediaAsked.get(rect.element);
      return asked ? { ...rect, ...asked } : rect;
    });
    if (sameMedia(rects, this._media)) return;
    this._media = rects;
    report(rects);
  }

  /** What a host mounts over the embedded elements, to `onEmbedded` where
   *  it changed (`_reportMedia`'s, for an `<iframe>`'s or a `<canvas>`'s
   *  box rather than a video's). */
  private _reportEmbedded(): void {
    const tree = this._tree;
    if (!tree || !this._props().onEmbedded) return;
    this._embeddedLaid = tree.embedded.length
      ? embeddedRectsOf(tree, this._scale)
      : [];
    this._publishEmbedded();
  }

  /** The embedded elements' rects as they are now, cut by the boxes fixed
   *  to the viewport, in logical pixels (`_publishMedia`'s). */
  private _publishEmbedded(): void {
    const tree = this._tree;
    const report = this._props().onEmbedded;
    if (!tree || !report) return;
    const rects = this._embeddedLaid.map((laid) =>
      this._viewportRect(
        laid,
        FIXED_OVER.get(laid) ?? FIXED_BOXES.get(tree),
        HELD_OVER.get(laid),
      ),
    );
    if (sameEmbedded(rects, this._embedded)) return;
    this._embedded = rects;
    report(rects);
  }

  /** A mounted rect as it shows now: cut by the boxes fixed to the
   *  viewport where the scroll has them, and by the sticky boxes it holds
   *  where the scroll has put them (`held`, an embedded element's), and in
   *  logical pixels. */
  private _viewportRect<R extends EmbeddedRect | MediaRect>(
    laid: R,
    fixed: readonly Box[] | undefined,
    held: readonly Box[] = NO_BOXES,
  ): R {
    let r = laid;
    // one in a box fixed to the viewport goes where the viewport is, with
    // the boxes fixed there, which the scroll moves no closer to it
    if (
      (fixed?.length || held.length) &&
      !('atViewport' in laid && laid.atViewport)
    ) {
      const shows = laid.clip ?? laid;
      const cut = cutByFixed(
        shows,
        fixed ?? NO_BOXES,
        this._fixedShift(),
        held,
        this._viewportInDocument(),
      );
      if (cut === 'hidden') r = { ...laid, hidden: true };
      else if (!sameClip(cut, shows)) r = { ...laid, clip: cut };
    }
    // and in a sticky box the viewport keeps, where the flow has it, which
    // core moves it from with the box (`HELD_AT_VIEWPORT`)
    const by = HELD_BY.get(laid);
    if (by) {
      r = heldAtRest(r, by);
      if ('over' in r && r.over) r = { ...r, over: shiftedBack(r.over, by) };
    }
    const s = this._scale;
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
      ...('over' in r &&
        r.over && {
          over: {
            x: r.over.x / s,
            y: r.over.y / s,
            width: r.over.width / s,
            height: r.over.height / s,
          },
        }),
    };
  }

  /**
   * Paint over a video's player what the document paints after the video
   * and reaches it (`coversOf`): each box and all it holds, as the
   * document paints it — through its own matrix, at its own opacity,
   * through its own filter (`paintCover`) — cut to what of the player it
   * reaches. `ctx` is a sibling's mounted after the player, at its origin,
   * which is `at` in the window — `videos.ts`'s `<canvas>`.
   */
  paintCovers(
    element: Element,
    ctx: unknown,
    at: { x: number; y: number },
  ): void {
    const tree = this._tree;
    const covers = this._covers.get(element);
    const c = ctx as PaintContext;
    if (!tree || !covers || !c.save || !c.beginPath || !c.rect || !c.clip) {
      return;
    }
    const options: PaintOptions = {
      ...this._paintOptions(this.selectionRange, null),
      originX: this.abs.x - at.x,
      originY: this.abs.y - at.y,
    };
    for (const { box, rect } of covers) {
      c.save();
      c.beginPath();
      c.rect(
        rect.x + options.originX,
        rect.y + options.originY,
        rect.width,
        rect.height,
      );
      c.clip();
      try {
        paintCover(c, tree, box, options);
      } finally {
        c.restore!();
      }
    }
  }

  /** The source a `<video>` or an `<audio>` plays: the first of its
   *  sources the host answered for that kind of player and no player has
   *  failed on, each asked for in turn. Null while one ahead of it is
   *  still being answered, and where none is left. */
  private _sourceOf<K extends PlayerKind>(
    kind: K,
    el: Element,
  ): {
    source: K extends 'video' ? VideoSource : AudioSource;
    url: string;
  } | null {
    for (const { url, type } of this._videoChoice(el)) {
      if (this._resources.media(kind, url) === undefined) {
        this._resources.requestMedia(kind, url, type, el);
      }
      const answer = this._resources.media(kind, url);
      if (answer === 'pending') return null;
      if (answer === undefined || answer === 'failed') continue;
      return { source: answer, url };
    }
    return null;
  }

  /**
   * The sources a `<video>` chooses between: those whose `media` holds for
   * the document where it is first asked (`_mediaHolds`), and the same
   * ones from then on, as HTML's resource selection algorithm runs once —
   * a window narrowed past a `<source media>` goes on playing what it
   * played, in Chrome as here. Chosen again only where the video's sources
   * change.
   */
  private _videoChoice(el: Element): VideoCandidate[] {
    const signature = videoSignature(el);
    const kept = this._videoChoices.get(el);
    if (kept?.signature === signature) return kept.candidates;
    const candidates = videoCandidates(el, (media) =>
      this._mediaHolds([parseMediaQuery(media)]),
    );
    this._videoChoices.set(el, { signature, candidates });
    return candidates;
  }

  /**
   * What a media element's player is told to do, as a page's script asks
   * it — `play()` and `pause()`, `muted`, `volume`, `playbackRate`, a seek
   * through `currentTime` — kept for the element, and reported with its
   * player at once where it has one, and when it is mounted where not.
   */
  setMediaState(element: Element, state: MediaState): void {
    this._mediaAsked.set(
      element,
      askMedia(this._mediaAsked.get(element), state),
    );
    if (this._mediaLaid.some((r) => r.element === element)) {
      this._publishMedia();
    }
    // an `<audio>` is heard from the first time it is played, and not
    // before: one a page makes for each blip asks for nothing until it
    // sounds
    if (tagOf(element) === 'audio' && this._props().onSounds) {
      if (state.paused === false) this._sounding.add(element);
      if (this._sounding.has(element)) this._publishSounds();
    }
  }

  /**
   * The players with no picture, to `onSounds` where they changed: each
   * `<audio>` played and not ended, whose source the host has answered.
   * One whose answer is on its way is left out until it arrives, and is
   * reported then (`ResourceChange` `'audio'`).
   */
  private _publishSounds(): void {
    const report = this._props().onSounds;
    if (!report) return;
    const sounds: Sound[] = [];
    for (const element of this._sounding) {
      const chosen = this._sourceOf('audio', element);
      if (!chosen) continue;
      const asked = this._mediaAsked.get(element);
      sounds.push({
        ...asked,
        element,
        source: chosen.source,
        url: chosen.url,
        key: this._resources.keyOf(chosen.url),
        loop: attr(element, 'loop') !== undefined,
        // the markup's, until a script says otherwise (`defaultMuted`)
        muted: asked?.muted ?? attr(element, 'muted') !== undefined,
      });
    }
    if (sameSounds(sounds, this._sounds)) return;
    this._sounds = sounds;
    report(sounds);
  }

  /**
   * What the player of a sound said (`sounds.ts`), told to the page
   * (`onMediaEvent`), whose clock follows it. Its end lets the player go:
   * an `<audio>` played again after its end is played from its start, by a
   * new one. A failure is the next source's turn, as a `<video>`'s is.
   */
  soundEvent(
    element: Element,
    url: string,
    kind: MediaEventKind,
    value = '',
  ): void {
    if (kind === 'error') this._resources.failMedia('audio', url);
    if (kind === 'ended') this._sounding.delete(element);
    this._props().onMediaEvent?.(
      element,
      this._resources.keyOf(url),
      kind,
      value,
    );
    if (kind === 'ended' || kind === 'error') this._publishSounds();
  }

  /**
   * What a page's script says of one of its animations (`Element.animate()`,
   * `scripts/dom.ts`): its effect and where its time is, as primitives
   * (`ScriptAnimations.tell`), or, with either null, that the element has it
   * no longer. The element, or its pseudo-element, is restyled at the next
   * frame — in place where that can be, as a CSS animation's frame is — and
   * then at each frame of it that changes what it draws. A document drawn
   * at rest builds it again at once.
   */
  setScriptAnimation(
    element: Element,
    id: number,
    effect: string | null,
    play: string | null,
  ): void {
    const touched = this._scripts.tell(
      element,
      id,
      effect,
      play,
      animationClock.now(),
    );
    if (!touched.length) return;
    // a view transition's pseudo-element is styled as its tree is built,
    // on the transition's timeline
    if (touched.some((pseudo) => pseudo.startsWith('view-transition'))) {
      if (this._vt?.phase === 'live') {
        this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
        this.invalidateMeasure('content');
        this.invalidate(true, this, 'props');
      }
      if (touched.every((pseudo) => pseudo.startsWith('view-transition'))) {
        return;
      }
    }
    if (!this._animating()) {
      this._invalidate(Stale.Boxes, new Set([element]), true);
      return;
    }
    for (const pseudo of touched) {
      if (!pseudo.startsWith('view-transition')) {
        this._timeline.oweScripts(element, pseudo);
      }
    }
    this._scheduleFrame();
  }

  /**
   * What `commitStyles` writes into an element's `style` attribute (Web
   * Animations 1, 6.4): each of `properties`' values as its animations come
   * to now, those made after animation `id` left out, as CSSOM serializes
   * it — `\u0000` between a property and its value, `\u0001` between two.
   * One it has no serialization for is left out. Null where the element is
   * not rendered, which `commitStyles` throws for.
   */
  scriptAnimationValues(
    element: Element,
    id: number,
    properties: readonly string[],
  ): string | null {
    this._prepare(this.abs.width || 1);
    const scripts = this._scripts;
    scripts.until = id;
    let style: ComputedStyle | null;
    try {
      style = this._styledNow(element);
    } finally {
      scripts.until = Infinity;
    }
    if (!style || !this._tree?.styles.has(element)) return null;
    if (style.display === 'none') return null;
    const record = cssomStyle(style, this._scale, null);
    const out: string[] = [];
    for (const prop of properties) {
      const value = prop.startsWith('--')
        ? style.custom?.get(prop)
        : prop === 'transform'
          ? cssomTransform(style.transform, this._scale)
          : record[prop];
      if (value !== undefined) out.push(`${prop}\u0000${value}`);
    }
    return out.join('\u0001');
  }

  /**
   * An element styled at this moment on the timeline, where a script
   * animates it, rather than at the last frame: what `getComputedStyle`
   * reads straight after `animate()`, and `commitStyles` writes. Styled on a
   * fork of the timeline, so the frames it is drawn by are as they were.
   * The element's style in the tree where nothing animates it from a
   * script, and null where it has none.
   */
  private _styledNow(element: Element): ComputedStyle | null {
    const kept = this._styleOf(element);
    const tree = this._tree;
    const cascade = this._cascade;
    if (!kept || !tree || !cascade || !this._timedNow(element)) return kept;
    const parent = flatParentOf(element);
    const parentStyle = parent ? this._styleOf(parent) : tree.root.style;
    if (!parentStyle) return kept;
    return this._atNow(element, () =>
      cascade.styleFor(
        element,
        parentStyle,
        tree.styles.get(element)?.inFlex ?? false,
      ),
    );
  }

  /** Whether what `element` draws now may be other than its last frame's:
   *  a script animates it, or a CSS animation on the clock or a transition
   *  of its own runs, which a page may have sought (`seekAnimation`,
   *  `seekTransition`), or a page did something to one on a scroll's
   *  timeline since (`seekScrolled`). A scroll-driven one is where the last
   *  frame's scroll had it, as a browser's timeline is until the next
   *  frame (`heldProgress`). */
  private _timedNow(element: Element): boolean {
    return (
      this._scripts.has(element) ||
      (this._animating() &&
        (this._timeline.transiting(element) ||
          this._timeline.animatesOnClock(element) ||
          this._timeline.sought(element)))
    );
  }

  /** What `style` works out with the cascade on a fork of the timeline at
   *  this moment, where a script animates `element` or a transition runs
   *  on it: the timeline's clock for the element's frames is left as it
   *  was. */
  private _atNow<T>(element: Element, style: () => T): T {
    const cascade = this._cascade;
    if (!cascade || !this._timedNow(element)) return style();
    const was = cascade.timeline;
    if (this._animating()) {
      const fork = this._timeline.fork(element);
      fork.now = animationClock.now();
      // and the scrolls its scroll-driven animations run on, where the
      // last frame had them
      fork.scrollProgress = this._timeline.heldProgress;
      cascade.timeline = fork;
    } else cascade.timeline = null;
    try {
      return style();
    } finally {
      cascade.timeline = was;
    }
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
    this._resources.failMedia('video', url);
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
  /** What `onViewportOverflow` was last told, or null before the first
   *  layout. */
  private _viewportOverflow: ViewportOverflow | null = null;

  /** What the document asks of the box that scrolls it, to
   *  `onViewportOverflow` where it changed. */
  private _reportViewport(): void {
    const tree = this._tree;
    const report = this._props().onViewportOverflow;
    if (!tree || !report) return;
    const now = tree.viewportOverflow;
    const was = this._viewportOverflow;
    if (was && was.x === now.x && was.y === now.y) return;
    this._viewportOverflow = now;
    report(now);
  }

  private _reportStops(): void {
    const tree = this._tree;
    const report = this._props().onFocusStops;
    if (!tree || !report) return;
    let { stops: all, boxes } = focusCandidates(tree);
    // in the order a container's `reading-flow` reads its items in, where
    // one does, which is layout's to say
    if (tree.readingFlow) ({ stops: all, boxes } = inReadingOrder(all, boxes));
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
      const rect = this._stopRectOf(el);
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
    this._followScale();
    // Core's content floors lay a window out with no room on offer, to learn
    // what the items of a row need. What a document answers is cut to the
    // room it was offered, and what is left of it is a height a pass that
    // measures widths does not read, so a document drawn at a width lays
    // nothing out for it. It was laid out a pixel wide, down across every
    // breakpoint and back: Apple's product page built and laid out all of
    // itself twice for each, some 900 ms, a few times a load. One in a box
    // that really is no wider goes on, since what its scripts are told is
    // told from a layout.
    if (width < 1 && this._tree && this.abs.width >= 1) {
      return { width: 0, height: this._documentHeight };
    }
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
    // what the scan finds — a `<noscript>`'s images and sheets — before the
    // source is read, so a document that runs scripts never asks for them
    const scripted = this._source.setScripting(next.scripting ?? false);
    if (scripted) this._invalidate(Stale.Style);
    if (
      next.look !== prev.look ||
      !sameStylesheets(next.stylesheet, prev.stylesheet) ||
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
    if (
      next.source !== prev.source ||
      next.complete !== prev.complete ||
      !next.onParserBlocked !== !prev.onParserBlocked
    ) {
      this._read();
    } else if (scripted) {
      this._sweep();
    } else if ((next.domRevision ?? 0) !== (prev.domRevision ?? 0)) {
      this._invalidate(Stale.Style);
    } else if ((next.baseUrl ?? null) !== (prev.baseUrl ?? null)) {
      // the same document somewhere else: every URL in it is another one
      this._updateBase();
      this._sweep();
    }
    if (
      next.caretBlink !== prev.caretBlink ||
      next.caretBlinkMs !== prev.caretBlinkMs ||
      (next.windowFocused ?? true) !== (prev.windowFocused ?? true)
    ) {
      this._caretMoved();
    }
    if (next.watchStops !== prev.watchStops) {
      // the rectangles watched from now on are the ones as they stand
      this._watchedRects = new Map(
        (next.watchStops ?? []).map((el) => [
          el,
          this._watchedRects.get(el) ?? this._stopRectOf(el),
        ]),
      );
    }
  }

  override destroySubtree(): void {
    caretClock.disarm(this._caretTimer);
    this._caretTimer = null;
    this._dropHeldHover();
    this._disarmGif();
    this._gifs.clear();
    if (this._settleTimer !== null) resizeClock.disarm(this._settleTimer);
    this._settleTimer = null;
    if (this._owedTimer !== null) owedClock.disarm(this._owedTimer);
    this._owedTimer = null;
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
    this._sprites?.destroy();
    this._sprites = null;
    this._filtered?.clear();
    this._filtered = null;
    this._lifted.clear();
    this._liftedTargets.clear();
    this._offered.clear();
    this._sheetsRead = null;
    this._tree = null;
    this._cascade = null;
    // a host waiting to run a script goes on, to find its document gone
    for (const wait of this._scriptWaits) wait.resolve();
    this._scriptWaits = [];
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
    this._followViewport();
    this._followLifted();
    // Core's contract: a device-pixel point, the same space the two rect
    // accessors below answer in.
    const at = this._unitsAt(x - this.abs.x, y - this.abs.y);
    if (at === null) return 0;
    return this._toPoints(this._selectable(at));
  }

  /** The place in the text, in code units, a point of the document's
   *  device pixels is nearest — `textIndexAt`'s. */
  private _unitsAt(
    x: number,
    y: number,
    origin: { x: number; y: number } = this.abs,
  ): number | null {
    const tree = this._tree;
    if (!tree) return null;
    const local = { x, y };
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
    const shift = this._fixedShift(origin);
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
    return at;
  }

  /**
   * The DOM boundary point nearest a logical window point, in the document
   * as it is now, laid out first as `elementAtPoint` is: a text node and an
   * offset in its data, as `caretPositionFromPoint` answers (CSSOM View 6).
   * Null where the document has no text there to be in.
   */
  textPointAt(x: number, y: number): { node: AnyNode; offset: number } | null {
    this._settle();
    this._followViewport();
    this._followLifted();
    const tree = this._tree;
    const origin = this._scrolledOrigin();
    const local = this._toDocument(x, y, origin);
    const at = tree && this._unitsAt(local.x, local.y, origin);
    return tree && at !== null ? pointOfUnit(tree, at) : null;
  }

  /**
   * Where the text between two DOM boundary points is drawn, in
   * `elementRect`'s coordinates: a rectangle a line, across the letters,
   * as `Range.getClientRects` has the text of a range (CSSOM View 6.2).
   * Where the two are one point, the caret there, of no width. Null where
   * the document has no text there.
   */
  /** The custom highlights a page's `CSS.highlights` holds (CSS
   *  Highlight API 1), as its host last told them. */
  private _highlights: readonly HighlightRanges[] = [];

  /** What a page's `CSS.registerProperty` registered, as the `@property`
   *  rules it amounts to, applied after every other sheet: told at once,
   *  where an adopted sheet waits for a render, since a page reads what it
   *  registered straight after. */
  private _registeredProperties = '';
  setRegisteredProperties(rules: string): void {
    if (rules === this._registeredProperties) return;
    this._registeredProperties = rules;
    this._invalidate(Stale.Style);
  }

  /**
   * The document selection's part in this document as DOM boundary points
   * (Selection API 2): what a page's `getSelection()` answers once the
   * reader selected something. Null where nothing of it is selected.
   */
  selectionPoints(): {
    sc: AnyNode;
    so: number;
    ec: AnyNode;
    eo: number;
    /** Core's range, which says whether it moved where the points, a
     *  tree's nodes, cannot. */
    key: string;
  } | null {
    const range = this.selectionRange;
    const tree = this._tree;
    if (!range || !tree || range.end <= range.start) return null;
    // core's indices are code points of the text a selection can take
    const start = pointOfUnit(
      tree,
      this._inDocument(this._toUnits(range.start), true),
    );
    const end = pointOfUnit(
      tree,
      this._inDocument(this._toUnits(range.end), false),
      true,
    );
    if (!start || !end) return null;
    return {
      sc: start.node,
      so: start.offset,
      ec: end.node,
      eo: end.offset,
      key: `${range.start}:${range.end}`,
    };
  }

  /** Select what a page selected, between two DOM boundary points, as the
   *  reader's selection is drawn and copied; null drops the selection. */
  selectPoints(
    points: { sc: AnyNode; so: number; ec: AnyNode; eo: number } | null,
  ): void {
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    // the selection is the surface's around the document, `<Html>`'s
    // selectable box, which this is a part of
    let surface: DrawnNode | null = this.parent as DrawnNode | null;
    while (surface && surface.textSelection === null) {
      surface = surface.parent as DrawnNode | null;
    }
    if (!surface) return;
    if (!points || !tree) {
      if (this.selectionRange) surface.clearSelection();
      return;
    }
    const index = (node: AnyNode, offset: number): number =>
      this._toPoints(this._selectable(unitOfPoint(tree, node, offset)));
    const self = this as unknown as DrawnNode;
    surface.setSelection(
      { node: self, index: index(points.sc, points.so) },
      { node: self, index: index(points.ec, points.eo) },
    );
  }

  /**
   * Where a DOM boundary point is moved by a character or a word through
   * the text the document draws, forwards or back (Selection API's
   * `modify`): in the drawn text, so it steps over white space the
   * document collapses and on from one text node into the next, wherever
   * the elements around them begin and end. A word forwards ends where the
   * next one does, and backwards starts where the one before does. Null
   * where the document has no text.
   */
  movedPoint(
    node: AnyNode,
    offset: number,
    granularity: 'character' | 'word',
    back: boolean,
  ): { node: AnyNode; offset: number } | null {
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree?.textNodes?.length) return null;
    const text = tree.text;
    let at = unitOfPoint(tree, node, offset);
    const high = (i: number) => /[\uD800-\uDBFF]/.test(text[i] ?? '');
    const low = (i: number) => /[\uDC00-\uDFFF]/.test(text[i] ?? '');
    const step = (): boolean => {
      if (back ? at <= 0 : at >= text.length) return false;
      if (back) at -= low(at - 1) && high(at - 2) ? 2 : 1;
      else at += high(at) && low(at + 1) ? 2 : 1;
      return true;
    };
    if (granularity === 'character') step();
    else {
      const word = (i: number) => /[\p{L}\p{N}_]/u.test(text[i] ?? '');
      const next = () => (back ? at - 1 : at);
      while (!word(next()) && step());
      while (word(next()) && step());
    }
    return pointOfUnit(tree, at, !back);
  }

  // --- the caret ------------------------------------------------------------
  //
  // An editing host's caret: where the page's selection is collapsed — the
  // point the page's realm edits at (`scripts/dom.ts`, `edit`) — drawn while
  // the host it is in has the focus and the window the keyboard, blinking
  // at the desktop's rate, as a browser draws it. It is drawn over all the
  // document paints, after it, and not by the box whose line it is on, so a
  // blink repaints the caret's rectangle and no surface or layer kept for a
  // box holds it.

  /** Where the page's selection is collapsed (`setCaret`). */
  private _caretPoint: { node: AnyNode; offset: number } | null = null;
  /** Whether the blink has the caret drawn. */
  private _caretOn = true;
  private _caretTimer: unknown = null;
  /** Where the caret was drawn, or would have been in the blink's other
   *  half, in window pixels: what its next change repaints. */
  private _caretDrawn: Rect | null = null;

  /** Where the page's selection is collapsed, or null where it is not: a
   *  caret, where an editing host that holds it has the focus. */
  setCaret(point: { node: AnyNode; offset: number } | null): void {
    const was = this._caretPoint;
    if (was?.node === point?.node && was?.offset === point?.offset) return;
    this._caretPoint = point;
    this._caretMoved();
  }

  /** The caret moved, or what shows it changed — the focus, the window's,
   *  the blink's rate: drawn at once, the blink starting again from there,
   *  as a browser's starts again at every key. */
  private _caretMoved(): void {
    this._caretOn = true;
    caretClock.disarm(this._caretTimer);
    this._caretTimer = null;
    const props = this._props();
    if (this._caretShown() && props.caretBlink !== false) {
      const rate = props.caretBlinkMs;
      const ms = typeof rate === 'number' && rate > 0 ? rate : CARET_BLINK_MS;
      const blink = (): void => {
        this._caretTimer = caretClock.arm(blink, ms);
        this._caretOn = !this._caretOn;
        this._repaintCaret();
      };
      this._caretTimer = caretClock.arm(blink, ms);
    }
    this._repaintCaret();
  }

  /**
   * Whether the caret is drawn, blink apart: the window has the keyboard,
   * the focus is on an editing host (HTML 6.8.1), and the selection is
   * collapsed in it, where its content is editable — not in a part of it
   * `contenteditable="false"` takes out.
   */
  private _caretShown(): boolean {
    const point = this._caretPoint;
    const host = this._focus.element;
    if (!point || !host || this._props().windowFocused === false) return false;
    if (!isEditingHost(host)) return false;
    const el = caretElement(point);
    if (!el || !isEditable(el)) return false;
    for (let at: Element | null = el; at;) {
      if (at === host) return true;
      const up: ParentNode | null = at.parent;
      at = isElement(up) ? up : null;
    }
    return false;
  }

  /**
   * Repaint where the caret was drawn and where it is drawn now. Asked
   * between paints — a focus moving, a blink, a page's edit — so it lays
   * nothing out: where the document waits for a build or a layout, the
   * whole element is repainted for it already, and the paint finds the
   * caret then.
   */
  private _repaintCaret(): void {
    const was = this._caretDrawn;
    const now =
      this._caretShown() && this._stale === Stale.Nothing
        ? (this._caretPlace()?.rect ?? null)
        : null;
    this._caretDrawn = now;
    for (const r of was && now && sameRect(was, now) ? [now] : [was, now]) {
      if (!r) continue;
      this.invalidate(
        false,
        {
          x: Math.floor(r.x),
          y: Math.floor(r.y),
          width: Math.ceil(r.width) + 1,
          height: Math.ceil(r.height) + 1,
        },
        'caret',
      );
    }
  }

  /**
   * Where the caret is drawn, in window pixels, and in what colour: the
   * `caret-color` of the element it is in, its text's colour for `auto`.
   * On the line of the block that holds it, as `textCaretRect` finds a
   * caret; at the start of the block's content where it holds no text —
   * an empty editing host, a paragraph emptied — which no line is. Cut
   * where the boxes around it cut what they hold. Null where it is drawn
   * nowhere, or in a colour that shows nothing. Of the document as it was
   * last laid out.
   */
  private _caretPlace(): { rect: Rect; color: string } | null {
    const point = this._caretPoint;
    if (!point) return null;
    const tree = this._tree;
    const el = caretElement(point);
    if (!tree || !el) return null;
    const style = this._styleOf(el);
    if (!style) return null;
    const color = inkColor(style.caretColor ?? 'currentColor', style.color);
    if (isTransparent(color)) return null;
    // the nearest box of the element or of one around it, and the block
    // whose lines hold its text
    let box: Box | null = null;
    for (let at: Element | null = el; at && !box;) {
      box = this._boxOf(tree, at);
      const up: ParentNode | null = at.parent;
      at = isElement(up) ? up : null;
    }
    let block = box;
    while (block && !block.lines && block.parent && block.kind === 'inline') {
      block = block.parent;
    }
    if (!block) return null;
    const shift = this._fixedShift();
    const s = this._scale;
    let found: { x: number; y: number; height: number } | null = null;
    if (block.subtreeTextEnd > block.subtreeTextStart) {
      // before a `<br>`, the caret is on the line the break ends, where
      // the text after the break would put it on the next
      const at = unitOfPoint(tree, point.node, point.offset, (br) => {
        const box = this._boxOf(tree, br);
        return box?.kind === 'break' ? box.textStart : null;
      });
      const units = Math.min(
        Math.max(at, block.subtreeTextStart),
        block.subtreeTextEnd,
      );
      // where the block is in a box fixed to the viewport, the shift its
      // line is drawn at is its own and not a child's
      const fixed = drawnAtViewport(block);
      found = caretAt(block, units, fixed ? null : shift);
      if (found && fixed && shift) {
        found = { ...found, x: found.x + shift.x, y: found.y + shift.y };
      }
    }
    if (!found) {
      const fonts = this._fonts();
      const bs = block.style;
      const height = fonts ? lineHeightOf(fonts, bs) : bs.fontSize * 1.2;
      const left = block.x + block.borderLeft + block.padLeft;
      const right = block.x + block.width - block.borderRight - block.padRight;
      const align = bs.textAlign;
      const rtl = bs.direction === 'rtl';
      const x =
        align === 'center'
          ? (left + right) / 2
          : align === 'right' ||
              (align === 'end' && !rtl) ||
              ((align === 'start' || align === 'justify') && rtl)
            ? right
            : left;
      const at = throughTransforms(
        { x, y: block.y + block.borderTop + block.padTop, width: 0, height },
        block,
      );
      const by = drawnAtViewport(block) ? shift : null;
      found = {
        x: at.x + (by?.x ?? 0),
        y: at.y + (by?.y ?? 0),
        height: at.height,
      };
    }
    let rect: Rect = {
      x: found.x,
      y: found.y,
      width: CARET_WIDTH * s,
      height: found.height,
    };
    // what the boxes around it cut it to, as they cut the line it is on
    const cut = contentClipFor(block, rect, s);
    if (cut) {
      const x = Math.max(rect.x, cut.x);
      const y = Math.max(rect.y, cut.y);
      const right = Math.min(rect.x + rect.width, cut.x + cut.width);
      const bottom = Math.min(rect.y + rect.height, cut.y + cut.height);
      if (right <= x || bottom <= y) return null;
      rect = { x, y, width: right - x, height: bottom - y };
    }
    return {
      rect: {
        x: this.abs.x + rect.x,
        y: this.abs.y + rect.y,
        width: rect.width,
        height: rect.height,
      },
      color,
    };
  }

  /** The caret, over the document as it was painted (`_paintContent`). */
  private _paintCaret(ctx: Context2D): void {
    if (!this._caretShown()) {
      this._caretDrawn = null;
      return;
    }
    const place = this._caretPlace();
    this._caretDrawn = place?.rect ?? null;
    if (!place || !this._caretOn) return;
    ctx.fillStyle = place.color;
    ctx.fillRect(
      place.rect.x,
      place.rect.y,
      place.rect.width,
      place.rect.height,
    );
  }

  /** A page's custom highlights changed: drawn again with the new ones. */
  setHighlights(highlights: readonly HighlightRanges[]): void {
    if (!this._highlights.length && !highlights.length) return;
    const was = this._replacedLit?.lit;
    this._highlights = highlights;
    // a surface kept around a replaced element is of the colours it was lit
    // in (`_dropSprites`)
    const now = this._litReplaced();
    for (const [these, those] of [
      [was, now],
      [now, was],
    ]) {
      for (const [box, colours] of these ?? []) {
        if (those?.get(box)?.join() !== colours.join()) {
          this._dropSprites(box, true);
        }
      }
    }
    this.invalidate();
  }

  /** The custom highlights to paint, the lowest priority first and in the
   *  order registered among equals, each range a document range in code
   *  units with its name's styler, and over them the text the URL's text
   *  directives found, in `::target-text` (CSS Pseudo 4, 3.5); none where
   *  no rule styles any. */
  private _litRanges(): PaintOptions['highlights'] {
    const tree = this._tree;
    const styler = tree?.highlightStyler;
    const targets = this._targetText?.ranges.filter((r) => r !== null);
    if (
      (!this._highlights.length && !targets?.length) ||
      !styler ||
      !tree.textNodes?.length
    ) {
      return undefined;
    }
    // a highlight's style is worked out here, after every layout, and what
    // it keeps of what its `@container` rules and container units read
    // stands until one of those sizes moves
    const boxes = this._containerBoxesOf(tree);
    if (boxes.size) {
      this._cascade?.sizeContainers(boxes.keys(), containerSizer(tree, boxes));
    }
    const out: NonNullable<PaintOptions['highlights']>[number][] = [];
    const ordered = this._highlights
      .map((h, i) => ({ h, i }))
      .sort((a, b) => a.h.priority - b.h.priority || a.i - b.i);
    const all: { name: string; ranges: HighlightRanges['ranges'] }[] =
      ordered.map(({ h }) => h);
    if (targets?.length) all.push({ name: TARGET_TEXT, ranges: targets });
    for (const h of all) {
      const lit = styler(h.name);
      // a highlight's ranges lit as one, so where two of them overlap
      // their text is lit once (CSS Highlight API 1, 4)
      const spans: [number, number][] = [];
      for (const r of h.ranges) {
        const start = unitOfPoint(tree, r.sc, r.so);
        const end = unitOfPoint(tree, r.ec, r.eo);
        if (end > start) spans.push([start, end]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      let last: [number, number] | null = null;
      for (const span of spans) {
        if (last && span[0] <= last[1]) {
          last[1] = Math.max(last[1], span[1]);
          continue;
        }
        if (last)
          out.push({
            selection: { start: last[0], end: last[1] },
            styler: lit,
          });
        last = span;
      }
      if (last)
        out.push({ selection: { start: last[0], end: last[1] }, styler: lit });
    }
    return out.length ? out : undefined;
  }

  /** What `_litReplaced` worked out last, for the highlights and the
   *  tree it was worked out for. */
  private _replacedLit: {
    highlights: readonly HighlightRanges[];
    tree: BoxTree;
    generation: number;
    lit: ReadonlyMap<Box, readonly string[]> | undefined;
  } | null = null;

  /**
   * The colours the custom highlights lay over the replaced elements their
   * ranges hold whole — an image, an `<svg>`, a canvas or a frame — by
   * the element's box, the lowest priority first (CSS Pseudo 4, 3.4: a
   * replaced element's piece of the overlay is the replaced object). Each
   * is the highlight's background, its `currentColor` the colour of the
   * layer under it and then the element's (3.6.3), and as the author
   * wrote it (3.2): an opaque one hides the image. Undefined where none
   * does, which is every document with no highlight or no replaced
   * element, and kept until the highlights or the boxes change.
   */
  private _litReplaced(): ReadonlyMap<Box, readonly string[]> | undefined {
    const tree = this._tree;
    const styler = tree?.highlightStyler;
    if (!this._highlights.length || !tree || !styler || !this._cascade) {
      return undefined;
    }
    const generation = this._cascade.highlightGeneration;
    const kept = this._replacedLit;
    if (
      kept?.tree === tree &&
      kept.highlights === this._highlights &&
      kept.generation === generation
    ) {
      return kept.lit;
    }
    const boxes = replacedBoxesOf(tree);
    let lit: Map<Box, string[]> | undefined;
    const under = new Map<Box, string>();
    if (boxes.length) {
      const ordered = this._highlights
        .map((h, i) => ({ h, i }))
        .sort((a, b) => a.h.priority - b.h.priority || a.i - b.i);
      for (const { h } of ordered) {
        // a range inside one text holds no element: a search's matches
        const spans = h.ranges
          .filter((r) => r.sc !== r.ec || isElement(r.sc))
          .map((r) => spanOf(r));
        if (!spans.length) continue;
        const style = styler(h.name);
        for (const { box, root, before, after } of boxes) {
          if (
            !spans.some(
              (span) =>
                span.root === root &&
                comparePaths(span.start, before) <= 0 &&
                comparePaths(after, span.end) <= 0,
            )
          ) {
            continue;
          }
          const look = style(box);
          if (!look) continue;
          const colour = look.color ?? under.get(box) ?? box.style.color;
          if (look.color) under.set(box, look.color);
          if (!look.background || isTransparent(look.background)) continue;
          lit ??= new Map();
          let list = lit.get(box);
          if (!list) lit.set(box, (list = []));
          list.push(inkColor(look.background, colour));
        }
      }
    }
    this._replacedLit = { highlights: this._highlights, tree, generation, lit };
    return lit;
  }

  textRects(
    start: AnyNode,
    startOffset: number,
    end: AnyNode,
    endOffset: number,
  ): Rect[] | null {
    this._settle();
    this._followViewport();
    const tree = this._tree;
    if (!tree?.textNodes?.length) return null;
    const from = unitOfPoint(tree, start, startOffset);
    const to = unitOfPoint(tree, end, endOffset);
    const shift = this._fixedShift(this._scrolledOrigin());
    const s = this._scale;
    const out: Rect[] = [];
    if (to <= from) {
      const found = caretAt(tree.root, from, shift);
      if (!found) return null;
      out.push({ x: found.x, y: found.y, width: 0, height: found.height });
    } else {
      collectBands(tree.root, from, to, 0, 0, out, true, shift);
    }
    return out.map((r) => ({
      x: r.x / s,
      y: r.y / s,
      width: r.width / s,
      height: r.height / s,
    }));
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
   * as tall as its lines; or of no width, where it stands among what is on
   * its lines when it has none of that, as `<a name>` has none, and as tall
   * as its font. A box fixed to the viewport, and what is in it,
   * where the pane's scroll draws it (`_moveToViewport`). Null for an
   * element with no box — `display: none`, or not in the document.
   */
  elementRect(element: Element): Rect | null {
    this._settle();
    this._followViewport();
    return this._rectOf(element);
  }

  /**
   * What an `IntersectionObserver` measures of its targets against its root
   * (Intersection Observer, 3.2.8), laid out first as `elementRect` is and
   * in its coordinates. The root's rectangle: its padding box where it
   * clips its overflow and its border box where it does not, null where
   * the root is the viewport, which is the caller's. And for each target
   * its bounding box, as `elementRect` has it, and the part of that the
   * boxes around it leave to be seen as far as the root
   * (`intersectionClips`), drawn through the matrices around each — an
   * edge that only meets one kept as a rectangle of no area, or null where
   * they leave none of it; null for a target with no box, or not in `root`
   * by containing blocks. Null where the document or `root` has no box at
   * all. `margin` is the observer's `scrollMargin`, which grows the clip
   * of each box around that scrolls. All of an observer's targets at once,
   * as each frame asks them and again after each paint: laid out and
   * followed once a target, that was most of what measuring one cost.
   */
  intersectionsOf(
    elements: readonly (Element | null)[],
    root: Element | null,
    margin: readonly MarginLength[] | null = null,
  ): ElementIntersections | null {
    this._prepare(this.abs.width || 1);
    this._followViewport();
    const tree = this._tree;
    if (!tree) return null;
    // by the index, not `boxOf`, a walk of the tree a target
    const first = this._firstBoxesOf(tree);
    const rootBox = root ? first.get(root) : null;
    if (rootBox === undefined) return null;
    const shift = this._fixedShift(this._scrolledOrigin());
    let rootRect: Rect | null = null;
    if (rootBox) {
      const edge = overflowClipRect(rootBox, this._scale);
      const r = edge
        ? throughTransforms(edge, rootBox)
        : this._drawnRect(tree, rootBox, false);
      if (!r) return null;
      rootRect = this._moveToViewport(rootBox, r, shift);
    }
    const targets = elements.map((element) => {
      const box =
        element && !this._boxedAsContents(element)
          ? first.get(element)
          : undefined;
      const drawn = box ? this._drawnRect(tree, box, false) : null;
      const clips =
        box && drawn && intersectionClips(box, rootBox, this._scale, margin);
      if (!box || !drawn || !clips) return null;
      const rect = this._moveToViewport(box, drawn, shift);
      return { rect, shown: this._cutBy(rect, clips, shift) };
    });
    return { root: rootRect, targets };
  }

  /** What `clips` leave of a rectangle, each through the matrices around
   *  the box whose coordinates it is in: an edge that only meets one kept
   *  as a rectangle of no area, and null where they leave none of it. */
  private _cutBy(
    rect: Rect,
    clips: readonly { rect: Rect; at: Box }[],
    shift: { x: number; y: number } | null,
  ): Rect | null {
    let x0 = rect.x;
    let y0 = rect.y;
    let x1 = rect.x + rect.width;
    let y1 = rect.y + rect.height;
    for (const clip of clips) {
      const c = this._moveToViewport(
        clip.at,
        throughTransforms(clip.rect, clip.at),
        shift,
      );
      x0 = Math.max(x0, c.x);
      y0 = Math.max(y0, c.y);
      x1 = Math.min(x1, c.x + c.width);
      y1 = Math.min(y1, c.y + c.height);
    }
    return x0 <= x1 && y0 <= y1
      ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      : null;
  }

  /**
   * Where the fragment of the document's URL points, laid out first, for
   * a host to scroll there (HTML's "scroll to the fragment"): the text the
   * first of its text directives that found any names, around all its
   * lines, or else the element the fragment names. Null where it points
   * at neither — no fragment, or one that names nothing here.
   */
  indicatedPart(): IndicatedPart | null {
    this._prepare(this.abs.width || 1);
    const range = this._targetText?.ranges.find((r) => r !== null);
    const rects =
      range && this.textRects(range.sc, range.so, range.ec, range.eo);
    if (rects?.length) {
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const r of rects) {
        left = Math.min(left, r.x);
        top = Math.min(top, r.y);
        right = Math.max(right, r.x + r.width);
        bottom = Math.max(bottom, r.y + r.height);
      }
      const rect = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
      return { element: null, rect, block: 'center' };
    }
    const target = this._target;
    const rect = target && this.elementRect(target);
    return rect ? { element: target, rect, block: 'start' } : null;
  }

  /**
   * Whether an element is drawn where the viewport is — fixed to it, or in
   * a box that is (`drawnAtViewport`) — so that no scroll of the pane
   * around the document moves it, laid out first as `elementRect` is. What
   * a script's `scrollIntoView` asks before it scrolls the viewport for
   * one. False for an element with no box.
   */
  atViewport(element: Element): boolean {
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    const box = tree ? this._boxOf(tree, element) : null;
    return !!box && drawnAtViewport(box);
  }

  /**
   * Whether a media query holds for the document, as `matchMedia` asks:
   * answered from what its own `@media` rules are — its width, the
   * viewport's height, the scale, the palette's colour scheme, the
   * preference for motion and whether it is scripted — so a page's script
   * and its sheets never disagree about which side of a query it is on.
   */
  matchMedia(query: string): boolean {
    return this._mediaHolds([parseMediaQuery(query)]);
  }

  /**
   * The document's `@font-face` faces, as `document.fonts` lists them
   * (`WebFonts.faces`): styled first, as `computedStyle` is, so a sheet a
   * script has just put in has its faces in the set.
   */
  fontFaces(): DocumentFontFace[] {
    this._prepare(this.abs.width || 1);
    return this._webFonts.faces();
  }

  /** The faces a `font` matches, by key, as `document.fonts.load()` and
   *  `check()` find them (`WebFonts.match`), styled first as `fontFaces`
   *  is. */
  matchFonts(query: FontQuery, text: string): FontMatch {
    this._prepare(this.abs.width || 1);
    return this._webFonts.match(
      query.families,
      query.weight,
      query.italic,
      query.stretch,
      text,
    );
  }

  /** Load faces by key, as `FontFace.load()` does (`WebFonts.load`). */
  loadFonts(keys: readonly string[]): Promise<boolean[]> {
    return this._webFonts.load(keys);
  }

  /** Settles once no face of the document's is on its way
   *  (`WebFonts.settled`). */
  fontsSettled(): Promise<void> {
    return this._webFonts.settled();
  }

  /**
   * What `matchMedia` answers from, as a key: the width, the viewport's
   * height, the scale, the colour scheme, the preference for motion and
   * scripting. A page's media query lists are asked again where it moves
   * (HTML's "evaluate media queries and report changes"), and only there.
   */
  mediaEnvironment(): string {
    const props = this._props();
    const width = this.abs.width || this._cascade?.viewportWidth || 1;
    return [
      Math.max(1, Math.floor(width)),
      this._viewportHeight(),
      this._scale,
      props.look.colorScheme,
      props.reducedMotion ?? false,
      props.scripting ?? false,
    ].join(' ');
  }

  /** Whether media conditions hold, as the document's `@media` rules are
   *  matched (`matchMedia`). */
  private _mediaHolds(conditions: MediaCondition[][]): boolean {
    const props = this._props();
    const s = this._scale;
    const width = this.abs.width || this._cascade?.viewportWidth || 1;
    return mediaMatches(
      conditions,
      Math.max(1, Math.floor(width)) / s,
      props.look.colorScheme,
      this._viewportHeight() / s,
      s,
      props.reducedMotion ?? false,
      props.scripting ?? false,
    );
  }

  /**
   * An element's style as `getComputedStyle` reads it (`computed.ts`), by
   * property name, laid out first as `elementRect` is: lengths in CSS
   * pixels, colours as `rgb()`, and the size and the edges of its box the
   * ones its layout came to where it has a box. `pseudo` is a `::before`
   * or an `::after`, null where no rule gives the element one. Null for an
   * element the document has not styled — not in it, or in a
   * `<template>`.
   */
  /** The rules that match `element`, in the order they win
   *  (`Cascade.matchedRules`). */
  matchedRules(element: Element): MatchedRule[] {
    this._prepare(this.abs.width || 1);
    return this._cascade?.matchedRules(element) ?? [];
  }

  /** The sheets the document is styled by (`Cascade.sheetSources`). */
  styleSheets(): SheetSource[] {
    this._prepare(this.abs.width || 1);
    return this._cascade?.sheetSources() ?? [];
  }

  /** The classes or ids some rule of the document's would style `element`
   *  with, were it to carry them (`Cascade.namesThatStyle`). */
  namesThatStyle(element: Element, attribute: 'class' | 'id'): string[] {
    this._prepare(this.abs.width || 1);
    return this._cascade?.namesThatStyle(element, attribute) ?? [];
  }

  /**
   * An element's style as a page reads it. `waits` leaves what is owed
   * waiting, for a script that may read nothing a box decides (`comesFromBox`):
   * a style is right whether its text has been set again or not, since the
   * lists and the lengths read from a face are, and what a box answers is
   * asked for again if it is read (`layoutOwed`).
   */
  computedStyle(
    element: Element,
    pseudo: string | null = null,
    waits = false,
  ): Record<string, string> | null {
    if (waits) this._prepare(this.abs.width || 1);
    else this._settle();
    const tree = this._tree;
    const cascade = this._cascade;
    if (!tree || !cascade) return null;
    const style = this._styledNow(element);
    if (!style) return null;
    if (pseudo?.startsWith('view-transition')) {
      return this._transitionComputed(tree, cascade, element, style, pseudo);
    }
    if (pseudo === 'before' || pseudo === 'after') {
      // one placed by a position option has that option's style, and the
      // insets its layout came to (CSS Anchor Positioning 1, 6.2)
      const generated = this._pseudoBoxOf(tree, element, pseudo);
      const placed = generated && this._placedStyle(generated);
      if (generated && placed) {
        return cssomStyle(
          placed,
          this._scale,
          this._usedBox(generated, placed),
        );
      }
      // one the rules give no `content` is styled by them all the same
      const own = this._atNow(element, () =>
        cascade.pseudoComputedStyle(element, pseudo, style),
      );
      // and one no rule styles has the style it would be made with all
      // the same, its element's inherited, as a browser answers for it
      return cssomStyle(
        own ?? inherit(style, cascade.initial),
        this._scale,
        null,
      );
    }
    const key = pseudo ? highlightKey(pseudo) : null;
    if (key !== null) {
      const own = this._highlightPseudo(element, key);
      return own ? cssomStyle(own, this._scale, null) : null;
    }
    if (pseudo) return null;
    const box = this._ownBoxOf(tree, element);
    if (!box) return cssomStyle(style, this._scale, null);
    const own = this._placedStyle(box) ?? style;
    return cssomStyle(own, this._scale, this._usedBox(box, own));
  }

  /** The style of the position option a box was placed by
   *  (`placedStyleOf`), which is its computed style; null where it was
   *  placed by its own, or is laid out in a vertical flow's frame, whose
   *  styles are turned (`layout/writing.ts`). */
  private _placedStyle(box: Box): ComputedStyle | null {
    const placed = placedStyleOf(box);
    if (!placed) return null;
    return this._tree?.vertical && frameModeOf(box) ? null : placed;
  }

  /** What layout made of a box, as `getComputedStyle` reads it. */
  private _usedBox(box: Box, style: ComputedStyle): UsedBox {
    // margins are no part of a box: worked out again, as layout did, from
    // the width of the block that holds it
    const across = box.parent ? box.parent.contentWidth : this.abs.width;
    const margin = (len: Len) => resolveLength(len, across);
    const used: UsedBox = {
      width: box.width,
      height: box.height,
      margin: [
        margin(style.marginTop),
        margin(style.marginRight),
        margin(style.marginBottom),
        margin(style.marginLeft),
      ],
      border: [
        box.borderTop,
        box.borderRight,
        box.borderBottom,
        box.borderLeft,
      ],
      padding: [box.padTop, box.padRight, box.padBottom, box.padLeft],
      insets: resolvedInsets(box, this._laidOutWidth, this._viewportHeight()),
    };
    // a box laid out in a vertical flow's frame has the frame's sides,
    // which are drawn at the page's others (`layout/writing.ts`)
    const mode = this._tree?.vertical ? frameModeOf(box) : null;
    if (mode) {
      used.width = box.height;
      used.height = box.width;
      used.border = pageSides(used.border, mode);
      used.padding = pageSides(used.padding, mode);
      if (used.insets) {
        used.insets = pageSides(
          used.insets as [
            number | 'auto' | null,
            number | 'auto' | null,
            number | 'auto' | null,
            number | 'auto' | null,
          ],
          mode,
        );
      }
    }
    return used;
  }

  /**
   * A view transition's pseudo-element as `getComputedStyle` reads it (CSS
   * View Transitions 1, 3.2): its box's, where the transition's tree has
   * one — the transition's own styles and animations in it — and otherwise
   * what the rules alone make of it, its parts' chain to the root
   * element's style: the user agent's sheet and the page's rules, as
   * inside an update callback, before the pseudo-elements are styled by
   * the transition. The root element's alone; null for another element's,
   * or one that is none of them.
   */
  private _transitionComputed(
    tree: BoxTree,
    cascade: Cascade,
    element: Element,
    rootStyle: ComputedStyle,
    pseudo: string,
  ): Record<string, string> | null {
    const m =
      /^view-transition(?:-(group|image-pair|old|new)\(\s*([^()\s]+)\s*\)?)?$/.exec(
        pseudo,
      );
    if (!m || !isRootElement(element)) return null;
    const key = m[1] ? `view-transition-${m[1]}(${m[2]})` : 'view-transition';
    if (this._vt?.phase === 'live') {
      for (const top of topLayerBoxes(tree.root)) {
        if (top.pseudo !== 'view-transition') continue;
        const stack = [top];
        while (stack.length) {
          const box = stack.pop()!;
          if (TRANSITION_KEYS.get(box) === key) {
            const style = TRANSITION_STYLES.get(box) ?? box.style;
            return cssomStyle(style, this._scale, this._usedBox(box, style));
          }
          stack.push(...box.children);
        }
      }
    }
    const name = m[2] ?? '';
    const entry = this._vt?.entries.get(name);
    // one that is not there has the style it would be made with, its
    // element's inherited, as Chromium answers: before a transition, after
    // it, and for an image the transition has none of. In an update
    // callback, the old state's parts are there.
    const there =
      this._vt?.phase === 'old' && (!m[1] || (!!entry?.old && m[1] !== 'new'));
    if (!there) {
      return cssomStyle(inherit(rootStyle, cascade.initial), this._scale, null);
    }
    const timeline = new AnimationTimeline();
    timeline.now = animationClock.now();
    const classes = entry?.classes ?? [];
    const at = (
      part: TransitionPart['part'],
      parent: ComputedStyle,
      onlyChild: boolean,
    ) =>
      cascade.transitionStyle(
        element,
        part,
        part === 'view-transition' ? '' : name,
        classes,
        onlyChild,
        parent,
        [],
        timeline,
        part === 'view-transition' ? part : `view-transition-${part}(${name})`,
      );
    let style = at('view-transition', rootStyle, false);
    const part = m[1] as TransitionPart['part'] | undefined;
    if (part) {
      style = at('group', style, (this._vt?.entries.size ?? 1) === 1);
      if (part !== 'group') {
        style = at('image-pair', style, true);
        if (part !== 'image-pair') {
          style = at(part, style, part === 'old' ? !entry?.el : !entry?.old);
        }
      }
    }
    return cssomStyle(style, this._scale, null);
  }

  /**
   * A custom property's computed value, by its name, case and all: every
   * `var()` in it replaced, and the empty string where nothing sets it
   * (`HtmlHandle.customProperty`). Not in `computedStyle`'s record, which
   * would carry every one a theme sets on the root to every element. Null
   * as `computedStyle` is.
   */
  customProperty(
    element: Element,
    name: string,
    pseudo: string | null = null,
  ): string | null {
    this._prepare(this.abs.width || 1);
    const style = this._styleOf(element);
    const key = pseudo ? highlightKey(pseudo) : null;
    // a pseudo-element no rule styles inherits every one of its element's
    const own =
      !style || !pseudo
        ? style
        : key !== null
          ? this._highlightPseudo(element, key)
          : pseudo === 'before' || pseudo === 'after'
            ? (this._cascade?.pseudoComputedStyle(element, pseudo, style) ??
              style)
            : null;
    return own ? (own.custom?.get(name) ?? '') : null;
  }

  /**
   * A highlight pseudo-element's style (`Cascade.highlightPseudoStyle`),
   * worked out down the flat tree from the root, since each element's
   * highlight inherits from its parent's: a shadow tree's top from its
   * host's, and a slotted element's through its slot (CSS Pseudo 4, 3.5).
   * Null for an element the document has not styled.
   */
  private _highlightPseudo(
    element: Element,
    key: string,
  ): ComputedStyle | null {
    const cascade = this._cascade;
    if (!cascade) return null;
    const chain: Element[] = [];
    for (let at: Element | null = element; at; at = flatParentOf(at)) {
      chain.push(at);
    }
    let found: HighlightPseudoStyle | null = null;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const style = this._styledNow(chain[i]);
      if (!style) return null;
      found = cascade.highlightPseudoStyle(chain[i], style, key, found);
    }
    return found?.style ?? null;
  }

  /**
   * What of the root element's font — its size, which a `rem` reads, its
   * line height, an `rlh` — moves where the root is among `readers`, the
   * elements a move of the viewport styles again: its style worked out at
   * the new viewport, as the restyle will, and compared with the tree's,
   * of what the document reads of it (`Cascade.rootMetricsMoved`). Fluid
   * type on the root, `font-size: calc(14px + .5vw)`, sizes every `rem`.
   */
  private _rootFontMoves(tree: BoxTree, readers: ReadonlySet<Element>): number {
    const cascade = this._cascade;
    if (!cascade?.readsRoot) return 0;
    for (const el of readers) {
      if (!isRootElement(el)) continue;
      const kept = tree.styles.get(el);
      if (!kept) return 0;
      const now = cascade.styleFor(el, tree.root.style, kept.inFlex);
      return cascade.rootMetricsMoved(kept.style, now);
    }
    return 0;
  }

  /**
   * An element's computed style: the build's, or where the build gave it
   * none — it is inside an element that is `display: none` — the cascade's
   * for it, from the nearest element around it that has one, as a
   * browser's `getComputedStyle` answers for an element with no box.
   */
  private _styleOf(element: Element): ComputedStyle | null {
    const tree = this._tree;
    const cascade = this._cascade;
    if (!tree || !cascade) return null;
    const known = tree.styles.get(element)?.style;
    if (known) {
      return this._stylesOwed.size
        ? (this._owedStyle(tree, cascade, element) ?? known)
        : known;
    }
    const unboxed = this._unboxedStyles(tree, cascade);
    const kept = unboxed.get(element);
    if (kept) return kept;
    const chain: Element[] = [];
    let style: ComputedStyle | undefined;
    for (let at: Element | null = element; at;) {
      chain.push(at);
      const parent = flatParentOf(at);
      if (!parent) return null;
      style = tree.styles.get(parent)?.style ?? unboxed.get(parent);
      if (style) break;
      at = parent;
    }
    if (!style) return null;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      style = cascade.styleFor(chain[i], style, false);
      unboxed.set(chain[i], style);
    }
    return style;
  }

  /**
   * The style an element has now, where a drag's restyle in place passed
   * over it or an element around it (`_stylesOwed`), or null where none
   * did: worked out for what reads it, a page's `getComputedStyle` in its
   * `resize` handler, and not kept, since the build at rest makes it.
   */
  private _owedStyle(
    tree: BoxTree,
    cascade: Cascade,
    element: Element,
  ): ComputedStyle | null {
    const chain: Element[] = [];
    let owed = 0;
    for (let at: Element | null = element; at; at = flatParentOf(at)) {
      chain.push(at);
      if (this._stylesOwed.has(at)) owed = chain.length;
    }
    if (!owed) return null;
    const above = flatParentOf(chain[owed - 1]);
    let style = above ? tree.styles.get(above)?.style : tree.root.style;
    if (!style) return null;
    for (let i = owed - 1; i >= 0; i -= 1) {
      const inFlex = tree.styles.get(chain[i])?.inFlex ?? false;
      style = cascade.styleFor(chain[i], style, inFlex);
    }
    return style;
  }

  /**
   * The styles `_styleOf` worked out for elements the tree has none for,
   * kept for as long as nothing they are worked out from can have moved:
   * the tree, the cascade, the document's nodes (`treeGeneration`, which a
   * change under `display: none` moves, and restyles nothing) and what the
   * boxes were styled and laid out as (`_geometry`). Apple's product pages
   * read `getComputedStyle` of their closed dialogs' contents a property at
   * a time, and each read styled the chain down from the nearest box
   * again: three and a half seconds of a load.
   */
  private _unboxedStyles(
    tree: BoxTree,
    cascade: Cascade,
  ): Map<Element, ComputedStyle> {
    const at = treeGeneration();
    const kept = this._unboxed;
    if (
      kept?.tree === tree &&
      kept.cascade === cascade &&
      kept.at === at &&
      kept.geometry === this._geometry
    ) {
      return kept.styles;
    }
    const styles = new Map<Element, ComputedStyle>();
    this._unboxed = { tree, cascade, at, geometry: this._geometry, styles };
    return styles;
  }

  private _unboxed: {
    tree: BoxTree;
    cascade: Cascade;
    at: number;
    geometry: number;
    styles: Map<Element, ComputedStyle>;
  } | null = null;

  /**
   * Where a focusable area is as the document was last laid out, as
   * `elementRect` measures it, without laying it out again: what a render
   * reads to place the box that takes the focus for it (`stops.ts`), which
   * `onFocusStops` renders again when the layout moves it.
   */
  stopRect(element: Element): Rect | null {
    return this._stopRectOf(element);
  }

  /** `_rectOf`, cut by the boxes that clip the element and kept inside
   *  them where they show none of it (`shownBy`): a stop is mounted beside
   *  the document, and one at a link a scroll container holds out of sight
   *  would make the box that scrolls the document reach down to it. The
   *  clip is asked in device pixels where the element was laid out, as
   *  `clipFor`'s boxes are, and both are brought back and moved to the
   *  viewport after (`_moveToViewport`): mixed, a stop a clip hid was
   *  placed at twice its distance at 2x, and the Zen Garden's 214 scrolled
   *  sideways into nothing to reach it. */
  private _stopRectOf(element: Element): Rect | null {
    const tree = this._tree;
    const at = tree ? this._boxOf(tree, element) : null;
    const drawn = tree && at ? this._drawnRect(tree, at, false) : null;
    if (!tree || !at || !drawn) return null;
    const rect = this._moveToViewport(at, drawn);
    const box = this._boxOf(tree, element);
    const cut = box && clipFor(box, drawn, this._scale);
    if (!cut) return rect;
    return shownBy(this._moveToViewport(at, cut.rect), rect);
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
    const box = tree ? this._ownBoxOf(tree, element) : null;
    const rect = tree && box ? this._drawnRect(tree, box, first) : null;
    return rect && this._moveToViewport(box!, rect);
  }

  /**
   * Where a box is drawn, in device pixels in the coordinates it was laid
   * out in: the rectangle around its fragments, or its first, turned and
   * scaled as the boxes it is in are, and itself (`getBoundingClientRect`,
   * CSSOM View). Null where it has none (`_fragmentsOf`).
   */
  private _drawnRect(tree: BoxTree, box: Box, first: boolean): Rect | null {
    const fragments = this._fragmentsOf(tree, box);
    if (!fragments) return null;
    return throughTransforms(first ? fragments.first : fragments.all, box);
  }

  /**
   * A rectangle `_drawnRect` measured, in the document's logical pixels as
   * the element is painted now: moved by the scroll of the pane that
   * scrolls the element where the box is fixed to the viewport or in one
   * that is, as paint draws it where the viewport is (`atViewport`) and
   * the hit test finds it there (`_fixedShift`). Measured where it was
   * laid out, a fixed header `top: 30px` on a page scrolled 500px read
   * -470 to a script's `getBoundingClientRect`, where Chrome reads 30. For
   * the offsets the pane has now, the next pass's as well as the last's
   * (`_scrolledOrigin`): a page measures straight after its `scrollTo`.
   */
  private _moveToViewport(
    box: Box,
    rect: Rect,
    shift = this._fixedShift(this._scrolledOrigin()),
  ): Rect {
    const moved = shift && drawnAtViewport(box);
    const s = this._scale;
    return {
      x: (rect.x + (moved ? shift.x : 0)) / s,
      y: (rect.y + (moved ? shift.y : 0)) / s,
      width: rect.width / s,
      height: rect.height / s,
    };
  }

  /**
   * Where a box's fragments are, in device pixels, as layout placed them
   * and before a turn or a scale draws them elsewhere: the first, and the
   * rectangle around all of them — a block's border box, both. Null for a
   * box its block's content does not hold.
   */
  private _fragmentsOf(
    tree: BoxTree,
    box: Box,
  ): { first: Rect; all: Rect } | null {
    if (box.kind !== 'inline' && box.kind !== 'text') {
      const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
      return { first: rect, all: rect };
    }
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
    if (bands.length) {
      let all = bands[0];
      for (let i = 1; i < bands.length; i += 1) {
        all = unionRect(all, bands[i]);
      }
      return { first: bands[0], all };
    }
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
    if (!block) return null;
    let rect: Rect;
    if (!block.lines?.length) {
      const left = block.contentX;
      rect = {
        x: emptyLinePoint(block.style, left, left + block.contentWidth),
        y: block.contentY,
        width: 0,
        height: 0,
      };
    } else {
      // nothing of it takes any room, and it is where the content around
      // it has it on its block's lines, a fragment of no width: an `<a
      // name>`, or a `<span>` a script has not filled yet
      const point = emptyBoxPoint(block, box, fonts);
      if (!point) return null;
      const { x, y, height, onLine } = point;
      const empty = [{ x, y, width: 0, height }];
      if (box.kind === 'inline') {
        fragmentBoxes(box, empty, onLine ? fonts : null);
      }
      rect = empty[0];
    }
    return { first: rect, all: rect };
  }

  /**
   * Where an element is as CSSOM View's offset attributes measure it (7):
   * its `offsetParent`, the first of its fragments' border edge from that
   * one's padding edge, and the size of the rectangle around all of them —
   * as layout put them, before any transform turns, scales or moves them
   * and any scroll moves them, in logical pixels, unrounded. Where Blink
   * parts from the spec's words, as Blink: a `<body>` it is measured from
   * is measured from its border edge where it is positioned and from the
   * root's corner where it is not, and an inline element from its first
   * fragment's border edge; and an offset parent in a shadow tree that is
   * not around the element, open or closed, is passed over, the element
   * measured from it and it from its own (`shadowHidden`). An element no
   * offset parent holds is measured from the document's corner, or a box
   * fixed to the viewport from the viewport's. A `<body>` is at 0, 0, and
   * has none. Null for an element with no box.
   */
  offsetRect(element: Element): OffsetRect | null {
    this._settle();
    this._followViewport();
    const tree = this._tree;
    const box = tree ? this._ownBoxOf(tree, element) : null;
    const own = tree && box ? this._laidOutAt(tree, box) : null;
    if (!tree || !box || !own) return null;
    const s = this._scale;
    const width = own.all.width / s;
    const height = own.all.height / s;
    if (tagOf(element) === 'body') {
      return { parent: null, x: 0, y: 0, width, height };
    }
    let parent = offsetParentOf(box, element);
    const at = this._offsetFrom(tree, parent);
    let x = own.first.x - at.x;
    let y = own.first.y - at.y;
    while (parent?.el && shadowHidden(parent.el, element)) {
      const next = offsetParentOf(parent, parent.el);
      const from = this._laidOutAt(tree, parent);
      const to = this._offsetFrom(tree, next);
      if (from) {
        x += from.first.x - to.x;
        y += from.first.y - to.y;
      }
      parent = next;
    }
    return { parent: parent?.el ?? null, x: x / s, y: y / s, width, height };
  }

  /** The point an offset parent measures the offsets from, in device
   *  pixels as layout put it (`offsetRect`): the document's corner for
   *  none. */
  private _offsetFrom(
    tree: BoxTree,
    parent: Box | null,
  ): { x: number; y: number } {
    const from = parent && this._laidOutAt(tree, parent);
    if (!parent || !from) return { x: 0, y: 0 };
    const { x, y } = from.first;
    if (tagOf(parent.el!) !== 'body') {
      // its padding edge, but an inline box's border edge, as Blink
      // measures from its first line box's corner
      return parent.kind === 'inline'
        ? { x, y }
        : { x: x + parent.borderLeft, y: y + parent.borderTop };
    }
    if (parent.style.position !== 'static') return { x, y };
    // the corner of the box the body is in, as Blink adds the body's place
    // in it
    let root = parent.parent;
    while (root && !root.el) root = root.parent;
    const around = root && this._laidOutAt(tree, root);
    return around ? { x: around.first.x, y: around.first.y } : { x: 0, y: 0 };
  }

  /** `_fragmentsOf`, where layout had them before any transform or any
   *  scroll moved them: what the offset attributes measure. */
  private _laidOutAt(
    tree: BoxTree,
    box: Box,
  ): { first: Rect; all: Rect } | null {
    const fragments = this._fragmentsOf(tree, box);
    if (!fragments) return null;
    let [dx, dy] = scrolledBy(box);
    // what each transform moved it by (`applyRelativeOffsets`), up to a
    // box in the top layer, which none around it moves
    for (let at: Box | null = box; at; at = at.topLayer ? null : at.parent) {
      if (at.kind === 'inline' || !transformed(at.style)) continue;
      const [tx, ty] = translationOf(at);
      dx -= tx;
      dy -= ty;
    }
    // and laid out in the frame of a vertical writing mode, where the turn
    // has it on the page, which is no transform the page wrote
    const turned = tree.vertical;
    if (!dx && !dy && !turned) return fragments;
    const move = (r: Rect): Rect => {
      const at = { ...r, x: r.x + dx, y: r.y + dy };
      return turned ? onPage(box, at) : at;
    };
    return { first: move(fragments.first), all: move(fragments.all) };
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
    this._followViewport();
    this._followLifted();
    const tree = this._tree;
    if (!tree) return true;
    const local = this._toDocument(x, y);
    const hit = selectionHit(local);
    deepestAt(tree, local.x, local.y, undefined, this._fixedShift(), hit);
    if (hit.text) return !withinRuns(tree.unselectable, hit.run);
    return hit.box?.style.userSelect !== 'none';
  }

  /**
   * The deepest element whose box contains a logical window point, in the
   * document as it is now: a layout it owes — after a `refresh()`, a sheet
   * or an image that arrived — is done first, as `elementRect`'s is, so a
   * host that changed the DOM and asks what is under a point before the
   * next paint is answered from the change, as `elementFromPoint` is, and
   * not with an element the change took out. And where the pane's offsets
   * have the document now, as `elementRect` measures it
   * (`_scrolledOrigin`): a page asks what is under a point straight after
   * its `scrollTo`.
   */
  elementAtPoint(x: number, y: number): Element | null {
    this._prepare(this.abs.width || 1);
    return this._drawnAt(x, y, this._scrolledOrigin());
  }

  /**
   * The deepest element under a logical window point as the document was
   * last laid out — what the hover asks (`setHover`). Laid out first, each
   * pointer move between two frames on a page whose hover builds the boxes
   * would build them, where the restyles of all of them are one build at
   * the frame; and core asks the hover again after a frame that laid out
   * (react-x11#793), which brings it up to the tree that frame drew. With
   * the element's corner at `origin` (`_fixedShift`'s).
   */
  private _drawnAt(
    x: number,
    y: number,
    origin: { x: number; y: number } = this.abs,
  ): Element | null {
    this._followViewport();
    const local = this._toDocument(x, y, origin);
    this._followLifted(local);
    const tree = this._tree;
    if (!tree) return null;
    const hit = deepestAt(
      tree,
      local.x,
      local.y,
      undefined,
      this._fixedShift(origin),
    );
    if (hit) return hit;
    // past what the document lays out, but inside the element, the root
    // element's: it paints the canvas, which is all of the viewport
    // (CSSOM View 5, `elementFromPoint`) — a press there is outside every
    // dialog and popover, which a light dismiss asks
    const s = this._scale;
    const inside = (r: Rect | null): boolean =>
      !!r &&
      x * s >= r.x &&
      y * s >= r.y &&
      x * s <= r.x + r.width &&
      y * s <= r.y + r.height;
    if (!inside(this.abs) && !inside(this._viewport())) return null;
    const root = tree.root;
    const html = root.el
      ? root
      : root.children.find((c) => c.el && tagOf(c.el) === 'html');
    return html?.el ?? null;
  }

  /**
   * Where the document draws its boxes fixed to the viewport from, in the
   * window's device pixels: the viewport of the pane that scrolls the
   * element, or the element's own top left where nothing does (`_paint`'s
   * `viewport`, `atViewport`). A box fixed to the viewport is laid out at
   * the document's top and drawn this far from here. What core keeps the
   * widgets of the controls in such a box at (`AT_VIEWPORT`).
   */
  viewportOrigin(): { x: number; y: number } {
    const at = this._viewport() ?? this.abs;
    return { x: at.x, y: at.y };
  }

  /**
   * How far the sticky boxes the viewport keeps hold an element from where
   * the flow has it, with the pane where it is now, in device pixels
   * (`heldShift`). What core moves the box `node`, mounted for a control in
   * one, by (`HELD_AT_VIEWPORT`), in every pass, the pass a scroll runs
   * included: the boxes are placed here rather than at the paint, which
   * comes after the pass has put the widget where the frame shows it.
   */
  heldShiftOf(
    element: Element,
    node: Node,
    drawn: boolean,
  ): { x: number; y: number } | null {
    this._placeAgainstPane();
    const shift = this._heldNow(element, drawn);
    if (shift) this._heldPlaced.set(node, { element, drawn, shift });
    else this._heldPlaced.delete(node);
    return shift;
  }

  /** Where `heldShiftOf` last had core put each box it was asked about. */
  private readonly _heldPlaced = new Map<
    Node,
    { element: Element; drawn: boolean; shift: { x: number; y: number } }
  >();

  private _heldNow(
    element: Element,
    drawn: boolean,
  ): { x: number; y: number } | null {
    const tree = this._tree;
    const box = tree && this._boxOf(tree, element);
    return box ? heldShift(tree, box, drawn ? scaleAround : undefined) : null;
  }

  /**
   * Ask for a pass over the widgets a sticky box moved from since core
   * last placed them: no scroll moved it but a layout of the document's
   * own (`_layoutOwed`), which core runs no pass for, and a report says
   * nothing where the flow has them where it was. A microtask later, as
   * this is asked in a paint as well.
   */
  private _followHeld(): void {
    for (const [node, { element, drawn, shift }] of this._heldPlaced) {
      if (node.destroyed) {
        this._heldPlaced.delete(node);
        continue;
      }
      const now = this._heldNow(element, drawn);
      if (
        !now ||
        (Math.round(now.x) === Math.round(shift.x) &&
          Math.round(now.y) === Math.round(shift.y))
      ) {
        continue;
      }
      void Promise.resolve().then(() =>
        node.invalidate(true, node, 'position'),
      );
    }
  }

  /** What of the document the pane around it shows, in the document's
   *  pixels, or null where nothing scrolls it. */
  private _viewportInDocument(): Rect | null {
    const viewport = this._viewport();
    if (!viewport) return null;
    return {
      x: viewport.x - this.abs.x,
      y: viewport.y - this.abs.y,
      width: viewport.width,
      height: viewport.height,
    };
  }

  /** How far a box fixed to the viewport is drawn from where it was laid
   *  out, in the document's pixels: the scroll of the pane the element is
   *  in (`atViewport`), with the element's corner at `origin` — `abs`,
   *  where the last pass drew it, or the pane's offsets now have it
   *  (`_scrolledOrigin`). Null where nothing scrolls it. */
  private _fixedShift(
    origin: { x: number; y: number } = this.abs,
  ): { x: number; y: number } | null {
    const tree = this._tree;
    const viewport = tree && FIXED_BOXES.has(tree) && this._viewport();
    if (!tree || !viewport) return null;
    return { x: viewport.x - origin.x, y: viewport.y - origin.y };
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
    this._followViewport();
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
    const list = el ? tree.styles.get(el)?.style.cursor : null;
    // the keyword a list of images ends on: none is loaded here, so it
    // falls back as it would on images that failed
    const cursor = list?.slice(list.lastIndexOf(',') + 1).trim();
    if (cursor && cursor !== 'auto') return cursor;
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
    let node = this._drawnAt(x, y);
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
    const found = this._hoverReach(was, now);
    const reach = found?.reach ?? null;
    if (found && cascade && !(found.edge && cascade.pseudoAtEdges)) {
      if (!found.reach.size) return;
      const before = { hovered: new Set(was), active: EMPTY_SET };
      const focus = this._focus;
      // A rule at a shadow tree's edge — `:host(:hover)`, `::slotted()` — is
      // in no index `pointerChanged` asks, so where the move flips a host,
      // an element in a tree or a slotted one, every element it reaches is
      // styled again, as the build would: MDN's custom elements built the
      // boxes at every other move of the pointer. One that styles a
      // pseudo-element of them is a build still.
      const own = found.edge
        ? () => true
        : (el: Element) => cascade.pointerChanged(el, before, focus);
      if (
        this._restyleInPlace(
          found.reach,
          own,
          cascade.hoverPseudo,
          HOVER_RESTYLE_LIMIT,
          found.follows ? found.reach : null,
        )
      ) {
        if (cascade.placeholderFollows('hoverSensitive')) {
          this._reportControls();
        }
        // an animation the move started, or let go of, wants its frames
        this._scheduleFrame();
        return;
      }
    }
    // the reach holds each element whose style can change and all it
    // holds, so only their subtrees are built (`_subtreeBuild`): a
    // playground's divider fades its `::after` in on `:hover`, and the
    // press that sets `pointer-events: none` on the panes, and the release,
    // each built every box of joshwcomeau.com's article
    this._invalidate(Stale.Boxes, reach, found?.follows ?? false, reach);
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
    // an editing host's caret shows while it has the focus
    if (this._caretPoint) this._caretMoved();
    const cascade = this._cascade;
    cascade?.setFocus(now);
    if (!cascade || !cascade.focusSensitive) return false;
    const found = cascade.focusLocal
      ? this._stateReach(
          [...was.within],
          [...now.within],
          // one element, whose ring came or went
          was.element === element ? element : null,
          (el, below) => cascade.focusTouches(el, below),
          (el, into) => cascade.focusAnchors(el, into),
        )
      : null;
    const reach = found?.reach ?? null;
    if (found && !(found.edge && cascade.pseudoAtEdges)) {
      if (!found.reach.size) return true;
      const pointer = { hovered: new Set(this._hovered), active: EMPTY_SET };
      // every element it reaches where it is at a shadow tree's edge, as a
      // move of the pointer there is (`_restyleHover`)
      const own = found.edge
        ? () => true
        : (el: Element) => cascade.pointerChanged(el, pointer, was);
      if (
        this._restyleInPlace(
          found.reach,
          own,
          cascade.focusPseudo,
          HOVER_RESTYLE_LIMIT,
          found.follows ? found.reach : null,
        )
      ) {
        // what a field's placeholder is drawn in is its widget's, which no
        // restyle of a box tells (`Cascade.placeholderFollows`)
        if (cascade.placeholderFollows('focusSensitive')) {
          this._reportControls();
        }
        this._scheduleFrame();
        return true;
      }
    }
    // built where the reach is, as a hover is (`_restyleHover`)
    this._invalidate(Stale.Boxes, reach, found?.follows ?? false, reach);
    return true;
  }

  /**
   * The elements whose styles a move of the hovered chain can change, or
   * null where that cannot be said (`Cascade.hoverLocal`); and whether a
   * rule at a shadow tree's edge can change them, which no index
   * `pointerChanged` asks has (`StateReach`).
   */
  private _hoverReach(
    was: readonly Element[],
    now: readonly Element[],
  ): StateReach | null {
    const cascade = this._cascade;
    if (!cascade || !cascade.hoverLocal) return null;
    return this._stateReach(
      was,
      now,
      null,
      (el, below) => cascade.hoverTouches(el, below),
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
    touches: (el: Element, below: BelowReach[]) => HoverTouch,
    anchors: (el: Element, into: Map<Element, HoverTouch>) => void,
  ): StateReach {
    const before = new Set(was);
    const after = new Set(now);
    const roots = new Map<Element, HoverTouch>();
    /** The elements a compound that leads below matched, and what it
     *  reaches under each (`BelowReach`). */
    const leading = new Map<Element, BelowReach[]>();
    let edge = false;
    const flipped = (el: Element, other: Set<Element> | null): void => {
      if (other?.has(el)) return;
      const below = leading.get(el) ?? [];
      const touch = touches(el, below);
      if (touch === HOVER_EDGE) edge = true;
      if (touch > (roots.get(el) ?? HOVER_UNTOUCHED)) roots.set(el, touch);
      if (below.length) leading.set(el, below);
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
    // combinator follows the compound that tests the pointer. A root only a
    // subject's compound matches is its own alone (`HOVER_SELF`), and the
    // restyle follows what it hands down (`StateReach.follows`): a webmail
    // page's banner, `:hover` a background, holds a hidden strip of ten
    // thousand elements, and each move of the pointer across it built them.
    const reach = new Set<Element>();
    /** The roots in `reach` without what is in them. */
    const alone = new Set<Element>();
    const collect = (el: Element): void => {
      const stack: Element[] = [el];
      while (stack.length) {
        const at = stack.pop()!;
        if (reach.has(at) && !alone.has(at)) continue;
        alone.delete(at);
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
      if (touch === HOVER_SELF) {
        if (!reach.has(root)) {
          reach.add(root);
          alone.add(root);
        }
        continue;
      }
      collect(root);
      if (touch !== HOVER_FOLLOWED && touch !== HOVER_EDGE) continue;
      for (let s = root.nextSibling; s; s = s.nextSibling) {
        if (isElement(s)) collect(s);
      }
    }
    // What a compound that leads below reaches in its element: the
    // subjects among its children or under it, with what is in each. The
    // shallowest first, since every element of the chain can be one — the
    // `*` of `:hover > .anchor-link` — and a walk under an ancestor covers
    // one under an element in it that asks no more of what it finds.
    if (leading.size) {
      const depthOf = (el: Element): number => {
        let depth = 0;
        for (let at = flatParentOf(el); at; at = flatParentOf(at)) depth += 1;
        return depth;
      };
      const whole = (el: Element): boolean => reach.has(el) && !alone.has(el);
      const order = [...leading.keys()]
        .filter((el) => !whole(el))
        .map((el) => [depthOf(el), el] as const)
        .sort((a, b) => a[0] - b[0]);
      const covered = new Set<Element>();
      const stack: Element[] = [];
      // A subject in an inline `<svg>` has no box of its own: the drawing
      // is one, whose shapes are asked for again where it is in the reach
      // (`_restyleInPlace`), and only there.
      const subject = (at: Element): void => {
        collect(at);
        let drawing: Element | null = null;
        for (let up = flatParentOf(at); up; up = flatParentOf(up)) {
          if (tagOf(up) === 'svg') drawing = up;
        }
        if (drawing) reach.add(drawing);
      };
      for (const [, el] of order) {
        if (whole(el) || covered.has(el)) continue;
        const below = leading.get(el)!;
        const deep = below.filter((r) => !r.child).map((r) => r.match);
        for (const r of below) {
          if (!r.child) continue;
          for (const child of flatChildrenOf(el)) {
            if (isElement(child) && r.match(child)) subject(child);
          }
        }
        if (!deep.length) continue;
        stack.push(el);
        while (stack.length) {
          const at = stack.pop()!;
          if (at !== el) {
            if (whole(at)) continue;
            if (deep.some((match) => match(at))) {
              subject(at);
              continue;
            }
            const inner = leading.get(at);
            if (inner?.every((r) => deep.includes(r.match))) covered.add(at);
          }
          for (const child of flatChildrenOf(at))
            if (isElement(child)) stack.push(child);
        }
      }
    }
    return { reach, edge, follows: alone.size > 0 };
  }

  /** The boxes the last restyle in place took a change of lengths for
   *  (`_restyleInPlace`'s `lengths`), which a layout is owed for. */
  private _resizedInPlace: readonly Box[] = [];

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
    given: ReadonlySet<Element>,
    ownChanged: (el: Element) => boolean,
    pseudoRules: 0 | 1 | 2,
    /** The most elements it restyles, past which a build is the cheaper. */
    limit = HOVER_RESTYLE_LIMIT,
    /** The elements a change restyles, followed down from where it is to
     *  each child whose parent's style came out other than it was, in
     *  place of `given`, a reach worked out before: what a change to the
     *  root reaches is everything, and what it changes, mostly nothing. */
    from: ReadonlySet<Element> | null = null,
    /** Which changes of lengths alone a layout follows, as one does at a
     *  new width (`BOX_LENGTHS`, `FONT_LENGTHS`): a block's width, its
     *  margins, its offsets — or its text's size — taken in place, and laid
     *  out again from them, where they build the boxes otherwise. */
    lengths = 0,
  ): boolean {
    this._geometry += 1;
    this._resizedInPlace = [];
    const cascade = this._cascade;
    const tree = this._tree;
    const layouts = this._layouts;
    if (!cascade || !tree || !layouts) return false;
    if (this._stale !== Stale.Nothing || this._laidOutWidth < 0) return false;
    if ((from ?? given).size > limit) return false;
    // what a `<foreignObject>` holds is a tree of its own, which nothing
    // here restyles: a change in it builds the boxes
    if (tree.foreign && inForeignObject(tree.foreign, from ?? given)) {
      return false;
    }
    const grown = from ? new Set<Element>() : null;
    const reach: ReadonlySet<Element> = grown ?? given;
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
    /** The ones whose lengths alone changed, taken in place where a layout
     *  follows (`lengths`), with which lengths (`lengthChange`), and their
     *  boxes. */
    const resized = new Map<Element, number>();
    const resizedBoxes: Box[] = [];
    let refused = false;
    // what changed beyond ink (`hoverChange`): how far some box's ink
    // reaches, the order its layer paints in, where one is
    let reaches = false;
    let reorders = false;
    const moving = new Set<Element>();
    /** The `::before` and `::after` boxes whose translation may have
     *  changed, which have no element of their own to be found by. */
    const movingBoxes = new Set<Box>();
    /** The elements whose opacity changed, which an inline box's cannot
     *  here where blocks broke it: they took it (`FADED_BLOCKS`). */
    const fading = new Set<Element>();
    /** Whether a control's box was restyled: its widget is told. */
    let widgets = false;
    /** Whether a box was shown, hidden, made opaque or not, or moved among
     *  its layers: it may have come over a widget, or gone from over one
     *  (`controlRectsOf`). */
    let covers = false;
    /** Whether `el`, or an element it is in, was `display: none`, and is
     *  with what this restyle made: none of it was drawn, nor is. */
    const unseenBefore = (el: Element): boolean => {
      for (let at: Element | null = el; at; at = flatParentOf(at)) {
        if (tree.styles.get(at)?.style.display === 'none') return true;
      }
      return false;
    };
    const unseenAfter = (el: Element, own: ComputedStyle): boolean => {
      if (own.display === 'none') return true;
      for (let at = flatParentOf(el); at; at = flatParentOf(at)) {
        const style = fresh.get(at) ?? tree.styles.get(at)?.style;
        if (style?.display === 'none') return true;
      }
      return false;
    };
    const styleOf = (el: Element): ComputedStyle | null => {
      const kept = tree.styles.get(el);
      if (!kept) {
        // a `<script>` put in draws nothing and has no style to go by, until
        // a page gives it a `display`
        if (
          reach.has(el) &&
          UNDRAWN_TAGS.has(tagOf(el)) &&
          draws(el, true, tree, cascade)
        ) {
          refused = true;
        }
        return null;
      }
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
        const diff = hoverChange(kept.style, made, lengths);
        // under `display: none` before and after, a change of any kind
        // draws nothing: Node's API pages hold a hidden picker
        // `max-width: 75vw`, and every step of a drag built the boxes
        if (diff === false && unseenBefore(el) && unseenAfter(el, made)) {
          style = made;
          changed.set(el, made);
          quiet.add(el);
        } else if (diff === false) refused = true;
        else if (diff) {
          style = made;
          changed.set(el, made);
          // what is laid out next lays it out at these lengths: where it
          // moves is the layout's to say, and only what else changed is ink
          if (diff.lengths) resized.set(el, diff.lengths);
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
    // a container query finds its container's style as this restyle made
    // it, as a build finds the one it made: a script's change to a
    // container's custom property is what a `style()` query reads of it
    const builtStyles = cascade.stylesOf;
    cascade.stylesOf = (el) => fresh.get(el) ?? tree.styles.get(el)?.style;
    try {
      if (from && grown) {
        // down from the top through what is above the elements changed, a
        // parent before its children, so each is styled from its parent's
        // style as this restyle made it; and on below an element only
        // where its style came out other than it was
        const above = new Set<Element>();
        const tops = new Set<Element>();
        for (const el of from) {
          let top: Element | null = el;
          for (let at = flatParentOf(el); at; at = flatParentOf(at)) {
            // a way up another element of the change took already
            if (above.has(at)) {
              top = null;
              break;
            }
            above.add(at);
            top = at;
          }
          if (top) tops.add(top);
        }
        const visit = (el: Element, parentChanged: boolean): void => {
          if (parentChanged || from.has(el)) {
            grown.add(el);
            if (grown.size > limit) refused = true;
          }
          if (refused) return;
          const style = styleOf(el);
          if (refused) return;
          const moved =
            grown.has(el) &&
            style !== null &&
            style !== tree.styles.get(el)?.style;
          if (!moved && !above.has(el)) return;
          for (const child of flatChildrenOf(el)) {
            if (!isElement(child)) continue;
            if (moved || above.has(child) || from.has(child)) {
              visit(child, moved);
            }
            if (refused) return;
          }
        };
        for (const top of tops) {
          visit(top, false);
          if (refused) return false;
        }
      } else {
        for (const el of reach) {
          styleOf(el);
          if (refused) return false;
        }
      }
    } finally {
      cascade.stylesOf = builtStyles;
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
      // their backgrounds are the canvas's, which lengths do not change:
      // Next.js's `body` is `max-width` in `vw`
      if ((tag === 'html' || tag === 'body') && !resized.has(el)) return false;
    }

    // The boxes, each under its parent: what a box takes depends on what
    // the box it is in took.
    const fonts = layouts.fonts;
    // What a drag's layout set aside is not restyled here: whatever in it
    // the change reached, the boxes are built again with the styles it
    // gives their elements before the layout that puts them back whole
    // (`_asideOwed`). Restyled at every step of the drag, a page in fluid
    // type was its set-aside half each time, and the icons in it sized in
    // `em` built the boxes for it at every step.
    const restyling = (): Iterable<Element> =>
      pseudoRules === HOVER_PSEUDO_NONE ? changed.keys() : reach;
    const passedAside = asideIn(tree) && this._passesAside(tree, restyling());
    // but what was set aside for drawing nothing, which a restyle may show
    const blocks = this._blocksOf(tree, restyling()).filter(
      (block) => !heldBack(tree, block) || unseenHeld(tree, block),
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
      for (const child of unseenIn(tree, box)) walk.push(child);
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
        const diff = hoverChange(box.style, made, lengths);
        if (diff === false) return false;
        if (!diff) continue;
        // the size its element's text came to, which its runs are set at
        // in the layout that follows — or, of a block or a flex box, its
        // lengths, as an element's are taken
        if (diff.lengths) {
          if (
            box.replaced !== 'none' ||
            (diff.lengths & FONT_LENGTHS && tree.firstLine) ||
            (box.kind === 'inline'
              ? diff.lengths !== FONT_LENGTHS
              : box.kind !== 'block' && box.kind !== 'flex')
          ) {
            return false;
          }
          resizedBoxes.push(box);
        }
        if (diff.move && !movable(box, box.style, made)) return false;
        if (diff.fade && brokenAround(box)) return false;
        // how far it reaches, the order its layer paints in and where it
        // is are worked out again as they are for an element's box
        if (diff.reach) reaches = true;
        if (diff.order) reorders = true;
        if (diff.move) movingBoxes.add(box);
        style = made;
        ink = diff.ink;
      } else if (box.pseudo === 'details-content') {
        // a `::details-content`, styled from its element by its own rules
        // as a `::before` is, and as one's restyled: where its element was
        // reached, and its transitions run — an accordion's height
        const from = GENERATED_FROM.get(box);
        if (!from || !reach.has(from)) continue;
        const inherits = fresh.get(from);
        const kept = tree.styles.get(from)?.style;
        if (!inherits || !kept) return false;
        if (!parent || parent.style !== kept) return false;
        const made = cascade.detailsContentStyleFor(from, inherits);
        const diff = hoverChange(box.style, made);
        if (diff === false) return false;
        if (!diff) continue;
        if (diff.move && !movable(box, box.style, made)) return false;
        if (diff.fade && brokenAround(box)) return false;
        if (diff.reach) reaches = true;
        if (diff.order) reorders = true;
        if (diff.move) movingBoxes.add(box);
        style = made;
        ink = diff.ink;
      } else if (box.pseudo === 'backdrop') {
        // a `::backdrop`, which inherits from its element and not from the
        // box around it: built again where its element was restyled
        const from = GENERATED_FROM.get(box);
        if (from && changed.has(from)) return false;
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
        // lengths a block's own flow, a flex box's or a grid's lays it out
        // at; a replaced box's, a table's and an inline box's are read as
        // their boxes are built
        // — and a text's size and its lines' on an inline box too, which
        // the block it is on lays out again with its runs. A `::first-line`
        // is styled from its block as the boxes are built (`FIRST_LINE`).
        const change = resized.get(el);
        if (change) {
          if (box.replaced !== 'none') return false;
          if (
            box.kind === 'inline'
              ? change !== FONT_LENGTHS
              : box.kind !== 'block' && box.kind !== 'flex'
          ) {
            return false;
          }
          if (change & FONT_LENGTHS && tree.firstLine) return false;
          resizedBoxes.push(box);
        }
        // an input button the page took to styling, or stopped, is drawn
        // by the document or mounted as the palette's widget: another box
        if (kept.styledControl !== style.styledControl && isInputButton(el)) {
          return false;
        }
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
        // and the size its parent's text came to, which its own content
        // was measured at: the text of a flex row is in one, a flex item
        // whose max-content sized the line
        if (lengthsThatDiffer(box.style, style) & lengths) {
          if (box.kind !== 'block' && box.kind !== 'flex') return false;
          resizedBoxes.push(box);
        }
      }
      if (!style) continue;
      next.set(box, style);
      restyled.push([box, style]);
      if (!covers && coverChange(box.style, style)) covers = true;
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
        // no walk reached what a drag set aside, so none says what it has:
        // the build it is owed (`passedAside`) makes what it should
        if (passedAside) {
          const box = this._firstBoxesOf(tree).get(el);
          if (box && (heldBack(tree, box) || setAsideIn(tree, box))) continue;
        }
        const has = generated.get(el) ?? 0;
        for (const [which, bit] of GENERATED_BITS) {
          if (has & bit) continue;
          const made = cascade.pseudoStyleFor(el, which, style);
          if (made && made.display !== 'none') return false;
        }
      }
    }
    if (!restyled.length) {
      // An element that draws no box — `display: none`, or one whose box
      // the fix-up dissolved — still has the style a script reads, and the
      // one a later build keeps for it (`KeptStyles`).
      for (const [el, style] of changed) {
        tree.styles.set(el, { style, inFlex: tree.styles.get(el)!.inFlex });
      }
      // and one a drag's layout set aside is owed its build as surely as
      // one beside a box restyled here: a page's handler that changed the
      // lengths of a box below the fold during a drag left it in its old
      // style once the drag rested
      if (passedAside) this._asideOwed = true;
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
          const again = reinked(text, layouts, next, refaded, lengths);
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
    if (passedAside) this._asideOwed = true;
    const moved: [Box, ComputedStyle][] = [];
    const kept = !!this._sprites?.size || !!this._filtered?.size;
    let reoffer = false;
    // a container whose snap type changed, which may have to come to rest
    // at a snap position it was not at (`_resnap`)
    let snapTyped = false;
    // what was kept of the sizes of a box at other lengths, and of every
    // box it is in, which take it in
    for (const box of resizedBoxes) forgetSizes(box);
    this._resizedInPlace = resizedBoxes;
    for (const [box, style] of restyled) {
      const was = box.style;
      box.style = style;
      if (style.scrollSnapType !== was.scrollSnapType) snapTyped = true;
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
      if (
        (box.el && moving.has(box.el) && box.kind !== 'text') ||
        movingBoxes.has(box)
      ) {
        moved.push([box, was]);
      }
    }
    // what a transform or an inset moves after the flow now, which the
    // passes after it walk down to
    noteMoving(
      tree,
      restyled.map(([box]) => box),
    );
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
    // One that draws nothing reaches nowhere: a sparkle scaled to nothing
    // at the start of its animation asked for the whole document's layout
    // at every frame it spent there. Nor does one a box around it clips
    // (`heldByClip`): a mail page's spinner turns at the foot of its
    // message list, a scroller far shorter than the list, and its every
    // frame laid the whole page out again for an end it could not reach.
    let relayout = false;
    for (const [box, was] of moved) {
      const before = heldByClip(box) ? -Infinity : inkBottom(box);
      retranslate(box, was);
      tree.relative = true;
      if (before >= this._documentHeight) relayout = true;
    }
    // how far the boxes' ink reaches, and the order their layers paint in,
    // as layout leaves them (`layoutDocument`) — but where boxes only moved:
    // those and the boxes around them, as far as they have to grow, and no
    // layer changes place. A mail page's spinner turning at the foot of its
    // list walked all 13,000 elements of the page at every frame, and, on
    // its layer, at every turn of the wheel
    if (
      reaches ||
      reorders ||
      moved.length > MOST_MOVED_APART ||
      !moved.every(([box]) => inkAfterMove(box, tree.movedInline))
    ) {
      computePaintBounds(tree.root, tree.movedInline);
      if (tree.negative) hoistNegative(tree.root);
      stackLayers(tree.root);
    }
    for (const [box] of moved) {
      if (heldByClip(box)) continue;
      if (inkBottom(box) >= this._documentHeight) relayout = true;
    }
    // a box a drag's layout left where it was for drawing nothing, shown:
    // set aside, nothing finds it until a layout places it
    if (showsUnseen(tree)) relayout = true;
    if (moved.length || widgets || (covers && tree.controls.length)) {
      this._reportControls();
    }
    // a player over what moved, faded or came over it
    if (tree.media.length) this._reportMedia();
    if (tree.embedded.length) this._reportEmbedded();
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
    // an anchor `visibility` hid or showed hides or shows what
    // `position-visibility` keeps to it (CSS Anchor Positioning 1, 5.4)
    if (tree.anchors) this._revisit(tree, inks);
    this._repaintInk(inks);
    // a snap area's alignment, or its container's type, that changed
    // without a layout: what a container was snapped to may be no snap
    // position now (CSS Scroll Snap 1, 5.4)
    if (cascade.snaps) this._resnap(!snapTyped);
    return true;
  }

  /** What `position-visibility` hides or shows now, where a restyle in
   *  place may have hidden or shown an anchor: drawn again where it was
   *  and where it is, into `inks`. */
  private _revisit(tree: BoxTree, inks: Rect[]): void {
    const root = tree.root;
    const boxes = positionVisibilityBoxes(root);
    if (!boxes.length) return;
    const before = boxes.map((b) => this._inkOf(b));
    if (!updatePositionVisibility(root, this._viewportAt()).length) return;
    stackLayers(root);
    computePaintBounds(root, tree.movedInline);
    for (const ink of before) if (ink) inks.push(ink);
    for (const box of boxes) {
      const ink = this._inkOf(box);
      if (ink) inks.push(ink);
    }
  }

  /** Those of `elements` a drag's layout set aside, or null for none:
   *  those it set aside for drawing nothing are restyled where they are. */
  private _heldBackOf(
    tree: BoxTree,
    elements: ReadonlySet<Element>,
  ): Set<Element> | null {
    if (!asideIn(tree)) return null;
    const first = this._firstBoxesOf(tree);
    let held: Set<Element> | null = null;
    for (const el of elements) {
      const box = first.get(el);
      if (box && heldBack(tree, box) && !unseenHeld(tree, box)) {
        (held ??= new Set()).add(el);
      }
    }
    return held;
  }

  /** What a build restyles, with what is owed a style (`_stylesOwed`). */
  private _withOwed(restyle: ReadonlySet<Element>): ReadonlySet<Element> {
    if (!this._stylesOwed.size) return restyle;
    return new Set([...restyle, ...this._stylesOwed]);
  }

  /** An element's first box in document order, for the tree it was asked
   *  of: made on the first move over a tree, which is one walk of it. */
  private _firstBoxes: { tree: BoxTree; of: Map<Element, Box> } | null = null;

  /** Whether a restyle in place passed over boxes a drag's layout set
   *  aside, which then hold the styles of before: built again, keeping
   *  every element's style, before a layout that lays them out
   *  (`_restyleInPlace`, `_update`). */
  private _asideOwed = false;
  /** The elements a viewport's move left unstyled, for being set aside
   *  (`_heldBackOf`): `tree.styles` holds what they were, a build styles
   *  them again (`_withOwed`), and a read works theirs out (`_owedStyle`). */
  private _stylesOwed = new Set<Element>();

  /**
   * The elements whose container queries answer otherwise for the content
   * boxes the layout just gave their containers (`Cascade.containersMoved`)
   * — in device pixels, as a query's lengths are read — or null for none.
   * A container a partial layout set aside keeps the size it had, and one
   * its box takes no size containment of, a table's, has none.
   */
  private _containersMoved(tree: BoxTree): Set<Element> | null {
    const cascade = this._cascade;
    if (!cascade?.readsContainers) return null;
    const boxes = this._containerBoxesOf(tree);
    return cascade.containersMoved(containerSizer(tree, boxes), (el) =>
      this._scrollStatesOf(boxes.get(el)),
    );
  }

  /** The tree whose boxes hold what the last layout gave them, while the
   *  next is built: none after a layout that asked a question, whose sizes
   *  are no container's. */
  private _sizedTree: BoxTree | null = null;

  /** A size container's content box as the last layout left it, for the
   *  cascade (`Cascade.laidOutSize`): a restyle in place may be the first
   *  thing to read one, or the first since the layout that moved it, and
   *  no layout follows it to say otherwise. */
  private _laidOutSize = (el: Element): ContainerSize | null | undefined => {
    const tree = this._sizedTree;
    if (!tree) return undefined;
    return containerSizer(tree, this._containerBoxesOf(tree))(el);
  };

  /** …and a scroll-state container's scroll states, for the same reason
   *  (`Cascade.laidOutScroll`). */
  private _laidOutScroll = (el: Element): ScrollStates | undefined => {
    const tree = this._sizedTree;
    if (!tree) return undefined;
    return this._scrollStatesOf(this._containerBoxesOf(tree).get(el));
  };

  /** A tree's containers (`BoxTree.containers`): one built before any style
   *  read one has none taken, and takes them as a read first asks. */
  private _containerBoxesOf(tree: BoxTree): Map<Element, Box> {
    return (tree.containers ??= containerBoxes(tree.root, asideOf(tree)));
  }

  /**
   * A scroll-state container's scroll states (CSS Conditional 5, 3.2.6), as
   * the boxes are now: the edge a sticky box is stuck to, by the way its
   * sticky offsets moved it (`STUCK`); the edges a scroll container — or
   * the root, scrolled by the pane the document is in — can scroll on to;
   * and which way it was scrolled last (`_scrolledLast`).
   */
  private _scrollStatesOf(box: Box | undefined): ScrollStates | undefined {
    if (!box?.el) return undefined;
    const style = box.style;
    const el = box.el;
    let stuck = 0;
    const moved = style.position === 'sticky' ? STUCK.get(box) : undefined;
    if (moved) {
      const [dx, dy] = moved;
      if (dy > 0.01) stuck |= TOP_EDGE;
      if (dy < -0.01) stuck |= BOTTOM_EDGE;
      if (dx > 0.01) stuck |= LEFT_EDGE;
      if (dx < -0.01) stuck |= RIGHT_EDGE;
    }
    let scrollable = 0;
    const edges = (
      x: number,
      y: number,
      overX: number,
      overY: number,
    ): number =>
      (y > 0.5 ? TOP_EDGE : 0) |
      (y < overY - 0.5 ? BOTTOM_EDGE : 0) |
      (x > 0.5 ? LEFT_EDGE : 0) |
      (x < overX - 0.5 ? RIGHT_EDGE : 0);
    if (scrolls(style)) {
      const st = scrollStateOf(box);
      scrollable = edges(
        st.x,
        st.y,
        st.width - st.clientWidth,
        st.height - st.clientHeight,
      );
    } else if (box === this._tree?.root || !flatParentOf(el)) {
      // the root, which the pane the document is in scrolls
      const viewport = this._viewportInDocument();
      if (viewport) {
        scrollable = edges(
          viewport.x,
          viewport.y,
          this._documentWidth - viewport.width,
          this._documentHeight - viewport.height,
        );
      }
    }
    return {
      stuck,
      scrollable,
      scrolled: this._scrolledLast.get(el) ?? 0,
      rtl: style.direction === 'rtl',
      // and the position option an anchored container was placed by
      fallback: style.anchoredContainer
        ? (ANCHOR_FALLBACK.get(box) ?? null)
        : null,
    };
  }

  /** Which way each scroll container was scrolled last, as the edges it
   *  was scrolled towards — the root's by the pane the document is in. */
  private _scrolledLast = new Map<Element, number>();
  /** Where the pane had the viewport the last time the root's scroll
   *  states were asked. */
  private _viewportWas: { x: number; y: number } | null = null;

  /** Whether each element's timeline triggers were active when last
   *  asked, by name. */
  private _triggerStates = new WeakMap<Element, Map<string, boolean>>();
  /** The elements that define a timeline trigger, in the document's order,
   *  with their boxes and triggers, for the tree they were found in. */
  private _triggerDefiners: {
    tree: BoxTree;
    of: TriggerDefiner[];
  } | null = null;

  /**
   * What the document's timeline triggers say now (CSS Animation Triggers
   * 1): each trigger an element defines active or not by where its view or
   * scroll timeline is — activated in its activation range, and active
   * until its timeline leaves its active range — and each animation that
   * waits for one told of a change (`AnimationTimeline.applyTriggers`),
   * with a frame asked for it. After each layout and each scroll, an
   * element's or the pane's; nothing where no animation waits for one, or
   * where the document is drawn at rest.
   */
  private _evaluateTriggers(): void {
    const tree = this._tree;
    const timeline = this._timeline;
    if (!tree || !this._animating() || !timeline.triggered) return;
    timeline.now = animationClock.now();
    let definers = this._triggerDefiners;
    if (definers?.tree !== tree) {
      definers = this._triggerDefiners = { tree, of: triggerDefiners(tree) };
    }
    const states = this._triggerStates;
    for (const { el, box, triggers } of definers.of) {
      let of = states.get(el);
      if (!of) states.set(el, (of = new Map()));
      for (const trigger of triggers) {
        of.set(
          trigger.name,
          this._triggerActive(box, trigger, of.get(trigger.name) ?? false),
        );
      }
    }
    const changed = timeline.applyTriggers((el, name) => {
      const definer = triggerFor(tree, definers.of, el as Element, name);
      return definer && (states.get(definer.el)?.get(name) ?? false);
    });
    if (changed.length) this._scheduleFrame();
  }

  /**
   * Whether a trigger an element's `box` defines is active now, from
   * whether it was: where its view timeline has the box in the scrollport
   * it is seen in — the nearest scroll container's, or the pane's for the
   * root — or where its scroll timeline has its scroller scrolled, each
   * along the timeline's axis. A trigger with no timeline this reads never
   * activates.
   */
  private _triggerActive(
    box: Box,
    trigger: TimelineTrigger,
    was: boolean,
  ): boolean {
    const source = trigger.source;
    if (source.kind === 'none') return false;
    // across or down the page; the block and inline axes are those of a
    // horizontal writing mode
    const down = source.axis === 'block' || source.axis === 'y';
    const scroller =
      source.kind === 'scroll' && source.scroller === 'self'
        ? isScroller(box)
          ? box
          : null
        : source.kind === 'scroll' && source.scroller === 'root'
          ? null
          : nearestScroller(box);
    if (source.kind === 'scroll' && source.scroller === 'self' && !scroller) {
      return false;
    }
    // the scrollport, in document coordinates, and how far it is scrolled
    // and can scroll
    let portStart: number;
    let portSize: number;
    let offset: number;
    let max: number;
    if (scroller) {
      const st = scrollStateOf(scroller);
      portStart = down
        ? scroller.y + scroller.borderTop
        : scroller.x + scroller.borderLeft;
      portSize = down ? st.clientHeight : st.clientWidth;
      offset = down ? st.y : st.x;
      max = down ? st.height - st.clientHeight : st.width - st.clientWidth;
    } else {
      const viewport = this._viewport();
      const origin = this._scrolledOrigin();
      const port = viewport
        ? {
            x: viewport.x - origin.x,
            y: viewport.y - origin.y,
            width: viewport.width,
            height: viewport.height,
          }
        : { x: 0, y: 0, width: this.abs.width, height: this.abs.height };
      portStart = down ? port.y : port.x;
      portSize = down ? port.height : port.width;
      offset = portStart;
      max = Math.max(
        0,
        (down ? this._documentHeight : this._documentWidth) - portSize,
      );
    }
    if (source.kind === 'scroll') {
      const edges = (range: TimelineTrigger['activation']) =>
        [scrollEdgeAt(range[0], max), scrollEdgeAt(range[1], max)] as const;
      return triggerActive(
        was,
        offset,
        edges(trigger.activation),
        edges(trigger.active),
      );
    }
    const place = this._viewPlace(
      box,
      scroller,
      down,
      portStart,
      portSize,
      source.inset,
    );
    const edges = (range: TimelineTrigger['activation']) =>
      [viewEdgeAt(range[0], place), viewEdgeAt(range[1], place)] as const;
    return triggerActive(
      was,
      0,
      edges(trigger.activation),
      edges(trigger.active),
    );
  }

  /**
   * After a scroll, which moves no layout: where a container's scroll
   * states answer a query otherwise now — a header stuck, a list scrolled
   * to its end — the elements under it are styled again, as a layout's
   * new sizes style a size container's.
   */
  private _askScrollStates(): void {
    const tree = this._tree;
    const cascade = this._cascade;
    if (!tree || !cascade?.readsScrollState) return;
    const boxes = this._containerBoxesOf(tree);
    const moved = cascade.containersMoved(
      () => undefined,
      (el) => this._scrollStatesOf(boxes.get(el)),
    );
    if (moved) this._invalidate(Stale.Boxes, moved, true);
  }

  /** The way the pane scrolled the root since it was last asked, noted as
   *  the root's last scroll; true where it moved. */
  private _noteRootScroll(): boolean {
    const viewport = this._viewportInDocument();
    // the root element, which the pane scrolls for: a fragment has none
    const root = this._tree
      ? this.document.children.find(
          (c): c is Element => isElement(c) && tagOf(c) === 'html',
        )
      : undefined;
    if (!viewport || !root) return false;
    const was = this._viewportWas;
    this._viewportWas = { x: viewport.x, y: viewport.y };
    if (!was) return false;
    const dx = viewport.x - was.x;
    const dy = viewport.y - was.y;
    if (!dx && !dy) return false;
    this._scrolledLast.set(root, scrolledTowards(dx, dy));
    return true;
  }

  /**
   * An element's first box, as a walk of the tree from its root finds it
   * (`boxFor`), by the tree's index of first boxes (`_firstBoxesOf`): the
   * walk, a read, was a fifth of what `getComputedStyle` and `offsetTop`
   * cost on Apple's product pages, whose scripts read them in a loop. A
   * box a drag's layout set aside is in the index and in no walk
   * (`heldBack`), so one is looked for as before.
   */
  /**
   * The box an element is, where `_boxOf` may find one that is not: the
   * text a `display: contents` element holds is boxed under its name, and
   * its `::before`, but the element is no box (CSS Display 3, 2.5). What
   * measures an element — its rect, its offsets, its client box, its used
   * size, `checkVisibility` — measures nothing of one, as Chrome's does:
   * every rect zero, every check false.
   */
  private _ownBoxOf(tree: BoxTree, element: Element): Box | null {
    return this._boxedAsContents(element) ? null : this._boxOf(tree, element);
  }

  /** Whether an element is `display: contents`, and so no box of its own,
   *  whatever is boxed under its name (`_ownBoxOf`). */
  private _boxedAsContents(element: Element): boolean {
    return this._styleOf(element)?.display === 'contents';
  }

  private _boxOf(tree: BoxTree, element: Element): Box | null {
    const found = CANDIDATES.get(tree)?.byElement.get(element);
    if (found) return found;
    const first = this._firstBoxesOf(tree).get(element);
    if (!first) return null;
    return heldBack(tree, first) ? boxFor(tree.root, element) : first;
  }

  private _firstBoxesOf(tree: BoxTree): Map<Element, Box> {
    let index = this._firstBoxes;
    if (index?.tree !== tree) {
      const of = new Map<Element, Box>();
      // whether or not a drag's layout set some aside: the index is the
      // tree's for as long as it lives
      const aside = asideOf(tree);
      const stack: Box[] = [tree.root];
      while (stack.length) {
        const box = stack.pop()!;
        const el = box.el;
        if (el && of.get(el) === undefined) of.set(el, box);
        const children = (aside && aside.get(box)) || box.children;
        for (let i = children.length - 1; i >= 0; i -= 1) {
          stack.push(children[i]);
        }
      }
      index = this._firstBoxes = { tree, of };
    }
    return index.of;
  }

  /**
   * Whether a restyle of `restyling` reaches a box the tree's last layout
   * set aside, which a walk down the boxes passes (`_asideOwed`): an
   * element's own box set aside, or one some of whose children were — the
   * text, the anonymous boxes and the pseudo-elements that take its style.
   */
  private _passesAside(tree: BoxTree, restyling: Iterable<Element>): boolean {
    const first = this._firstBoxesOf(tree);
    // whether a box is in one set aside, by box: the restyled elements of
    // a long page share their ancestors, which are each asked once
    const held = new Map<Box, boolean>();
    const path: Box[] = [];
    for (const el of restyling) {
      const box = first.get(el);
      if (!box) continue;
      if (setAsideIn(tree, box)) return true;
      let answer = false;
      for (let at: Box | null = box; at; at = at.parent) {
        const known = held.get(at);
        if (known !== undefined) {
          answer = known;
          break;
        }
        // what was set aside for drawing nothing is restyled where it is
        if (setAsideHere(tree, at)) {
          answer = !unseenHeld(tree, at);
          break;
        }
        path.push(at);
      }
      if (answer) return true;
      for (const at of path) held.set(at, false);
      path.length = 0;
    }
    return false;
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
      const broken = box?.kind === 'inline' && box.cut !== 0;
      while (
        box?.parent &&
        (box.kind === 'inline' || box.kind === 'text' || box.kind === 'break')
      ) {
        box = box.parent;
      }
      // the pieces of one broken around a block are its container's, each
      // run of them in an anonymous block of its own: a link around a
      // `<div>` kept its old colour after the block, where a script set it
      if (broken && box?.parent && !box.el && !box.pseudo) box = box.parent;
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
  private _inkOf(box: Box, drawn = false): Rect | null {
    // a box whose shadows are on a layer draws nothing past its border box
    // (`shadowPartOf`), and that is where it is drawn
    const shadowless =
      this._shadowsLifted.size !== 0 &&
      this._tree !== null &&
      this._shadowlessBoxes(this._tree)?.has(box) === true;
    const ink = shadowless
      ? throughTransforms(
          { x: box.x, y: box.y, width: box.width, height: box.height },
          box,
        )
      : drawn
        ? drawnInkOf(box)
        : inkOf(box);
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
    timeline.scrollProgress = this._timelineProgress;
    cascade.timeline = timeline;
    timeline.onCssEvent ??= () => this._oweCssEvents();
    // a new animation starts at the paint that shows it (`paint`), and one
    // that runs out waits at its end for the page to hear of it, where a
    // page hears (`_oweCssEvents`)
    timeline.startsAtPaint = true;
    timeline.holdsEnds = !!this._props().onCssEvents;
    return timeline;
  }

  /** Whether the transition events of a pass are to be told. */
  private _cssEventsOwed = false;
  /** Tell the transition events owed, once the pass that owes them has
   *  run: on a timer of its own, so a page hears them outside the layout
   *  that made them. */
  private _oweCssEvents(): void {
    if (this._cssEventsOwed || !this._props().onCssEvents) {
      return;
    }
    this._cssEventsOwed = true;
    animationClock.arm(() => {
      this._cssEventsOwed = false;
      // the document's, a view transition's tree's, and what one that
      // ended still owed
      const events = [
        ...this._timeline.takeCssEvents(),
        ...(this._vt?.timeline.takeCssEvents() ?? []),
        ...this._cssEventsLeft.splice(0),
      ];
      // the ends held for these are let go as they are told, and the next
      // frame draws each as its animation leaves it — or as the listeners
      // keep it, which they do now, before any paint (`holdsEnds`)
      if (this._timeline.releaseEnds()) this._scheduleFrame();
      const tell = this._props().onCssEvents;
      if (!events.length || !tell) return;
      tell(
        this._cssEventOrder(events).map((e) => ({
          element: e.el as Element,
          pseudo: e.pseudo ? `::${e.pseudo}` : '',
          type: e.type,
          name: e.name,
          elapsedTime: e.elapsed / 1000,
          key: e.key,
        })),
      );
    }, 0);
  }

  /** What a view transition's timeline still owed as the transition
   *  ended (`transitionEnd`). */
  private _cssEventsLeft: CssEventRecord[] = [];

  /**
   * A frame's CSS events in the order a page hears them (Web Animations
   * 1, 4.4.18): by when each was due, and then by the composite order of
   * what owes it — a transition before an animation (CSS Transitions 2,
   * 4.1), its element's tree order, and an element's own before its
   * `::marker`, `::before` and `::after` — and else as they came.
   */
  private _cssEventOrder(events: CssEventRecord[]): CssEventRecord[] {
    const order = new Map<object, number>();
    for (const el of this._tree?.styles.keys() ?? []) order.set(el, order.size);
    const PSEUDO_ORDER = ['', 'marker', 'before', 'after'];
    const pseudoRank = (p: string) => {
      const i = PSEUDO_ORDER.indexOf(p);
      return i < 0 ? PSEUDO_ORDER.length : i;
    };
    return events
      .map((e, i) => ({ e, i }))
      .sort(
        (x, y) =>
          x.e.at - y.e.at ||
          Number(x.e.type.startsWith('animation')) -
            Number(y.e.type.startsWith('animation')) ||
          (order.get(x.e.el) ?? Infinity) - (order.get(y.e.el) ?? Infinity) ||
          pseudoRank(x.e.pseudo) - pseudoRank(y.e.pseudo) ||
          x.i - y.i,
      )
      .map(({ e }) => e);
  }

  /** A page set where a CSS transition's time is (`CSSTransition`'s
   *  `currentTime`, in milliseconds): it runs from there, restyled at the
   *  next frame. */
  seekTransition(key: number, currentTime: number): void {
    if (!this._animating()) return;
    this._timeline.now = animationClock.now();
    if (!this._timeline.seekTransition(key, currentTime)) return;
    this._scheduleFrame();
  }

  /** A page cancelled a CSS animation or a transition: it draws nothing
   *  from the next frame. */
  cancelCss(kind: 'animation' | 'transition', key: number): void {
    if (!this._animating()) return;
    this._timeline.now = animationClock.now();
    const el =
      kind === 'animation'
        ? this._timeline.cancelAnimation(key)
        : this._timeline.cancelTransition(key);
    if (el) this._scheduleFrame();
  }

  /** A page set where a CSS animation's time is, the same way, and held
   *  it there where it paused it. */
  seekAnimation(key: number, currentTime: number, paused: boolean): void {
    if (!this._animating()) return;
    this._timeline.now = animationClock.now();
    if (this._timeline.seekAnimation(key, currentTime, paused)) {
      this._scheduleFrame();
      return;
    }
    // or one of a view transition's pseudo-elements, on its own timeline
    const vt = this._vt;
    if (!vt || vt.phase !== 'live') return;
    vt.timeline.now = animationClock.now();
    if (!vt.timeline.seekAnimation(key, currentTime, paused)) return;
    this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
    this.invalidateMeasure('content');
    this.invalidate(true, this, 'props');
  }

  /** And one on a scroll's timeline, whose time is a percentage of it:
   *  held at `time`, running from the start time `time`, or aligned to its
   *  range again, at `rate` (`AnimationTimeline.seekScrolled`). */
  seekScrolled(
    key: number,
    mode: 'align' | 'start' | 'hold',
    time: number | null,
    rate: number,
  ): void {
    if (!this._animating()) return;
    this._timeline.now = animationClock.now();
    if (this._timeline.seekScrolled(key, mode, time, rate)) {
      this._scheduleFrame();
    }
  }

  /**
   * Where a scroll-driven timeline is for an element (Scroll-driven
   * Animations 1): a `scroll()` timeline how far its scroller — the
   * nearest scroll container around the element, the root's pane, or the
   * element — is scrolled along its axis; a `view()` one how far the
   * element has crossed the scrollport of the nearest one, from `cover
   * 0%` to `cover 100%`, the scrollport less its insets; a named one the
   * nearest ancestor's, or the element's own, of that name. Null where it
   * is inactive: its scroller scrolls nothing that way, or there is no
   * box. Read from the last layout and the scroll now, as the triggers'
   * timelines are (`_triggerActive`).
   */
  private _timelineProgress = (
    el: object,
    _pseudo: string,
    ref: TimelineRef,
  ): ScrollProgress | null => {
    const tree = this._tree;
    if (!tree) return null;
    let subject = el as Element;
    let view: boolean;
    let axis: string;
    let scrollerKind = 'nearest';
    let inset: readonly [Len, Len] = ['auto', 'auto'];
    if (ref.kind === 'scroll') {
      view = false;
      axis = ref.axis;
      scrollerKind = ref.scroller;
    } else if (ref.kind === 'view') {
      view = true;
      axis = ref.axis;
      inset = ref.inset;
    } else if (ref.kind === 'name') {
      const named = namedTimeline(tree, subject, ref.name);
      if (!named) return null;
      subject = named.el;
      view = named.view;
      axis = named.axis;
      inset = named.inset;
      scrollerKind = view ? 'nearest' : 'self';
    } else return null;
    const box = this._firstBoxesOf(tree).get(subject);
    if (!box) return null;
    const down = axis === 'block' || axis === 'y';
    const scroller =
      scrollerKind === 'self'
        ? isScroller(box)
          ? box
          : null
        : scrollerKind === 'root'
          ? null
          : nearestScroller(box);
    if (scrollerKind === 'self' && !scroller) return null;
    const port = this._scrollportOf(scroller, down);
    if (!(port.max > 0)) return null;
    const edge = port.offset <= 0 || port.offset >= port.max - 1e-6;
    if (!view) {
      return {
        at: (port.offset / port.max) * 100,
        edge,
        edgeAt: (e) => (scrollEdgeAt(e, port.max) / port.max) * 100,
      };
    }
    // where the subject is in the scrollport, less its insets; and each
    // edge of a range as how far the scroll is from it (`viewEdgeAt`), on
    // the scale of `cover`
    const place = this._viewPlace(
      box,
      scroller,
      down,
      port.start,
      port.size,
      inset,
    );
    const from = viewEdgeAt({ name: 'cover', offset: 0 }, place);
    const to = viewEdgeAt({ name: 'cover', offset: { pct: 100 } }, place);
    if (!(to - from > 0)) return null;
    return {
      at: (-from / (to - from)) * 100,
      edge,
      edgeAt: (e) => ((viewEdgeAt(e, place) - from) / (to - from)) * 100,
      view: true,
    };
  };

  /**
   * Where a view timeline's subject is in the scrollport it is seen in,
   * along one axis (`ViewPlace`): its border box from the scrollport's
   * start — where it is at rest, for one sticky positioning moves, with
   * how far it can move each way (`stickyReach`) — and the part of the
   * scrollport it is seen through, less the timeline's insets, an `auto`
   * one the scroll container's `scroll-padding` there (Scroll-driven
   * Animations 1, 3.3), the root's for the pane's.
   */
  private _viewPlace(
    box: Box,
    scroller: Box | null,
    down: boolean,
    portStart: number,
    portSize: number,
    inset: readonly [Len, Len],
  ): ViewPlace {
    const sticky = stickyReach(box, scroller, down);
    const start = (down ? box.y : box.x) - sticky.shift - portStart;
    const pad = (i: 0 | 1): number =>
      inset[i] !== AUTO
        ? resolveLen(inset[i], portSize)
        : this._scrollPadding(scroller, down, portSize)[i];
    return {
      start,
      end: start + (down ? box.height : box.width),
      portStart: pad(0),
      portEnd: portSize - pad(1),
      up: sticky.up,
      down: sticky.down,
    };
  }

  /** A scroll container's `scroll-padding` at the start and the end of an
   *  axis, of a scrollport `size` long: the root's for the pane's. */
  private _scrollPadding(
    scroller: Box | null,
    down: boolean,
    size: number,
  ): [number, number] {
    const style = scroller ? scroller.style : this._rootBox()?.style;
    if (!style) return [0, 0];
    return [
      resolveLen(down ? style.scrollPaddingTop : style.scrollPaddingLeft, size),
      resolveLen(
        down ? style.scrollPaddingBottom : style.scrollPaddingRight,
        size,
      ),
    ];
  }

  /** What a view timeline's subject is along an axis, in CSS pixels, for
   *  a page's `ViewTimeline` (`_viewPlace`): the insets an `auto` one
   *  comes to there, the scroll container's `scroll-padding`, and how far
   *  sticky positioning has moved it and can each way. Null where it has
   *  no box. */
  viewAdjustOf(
    element: Element,
    vertical: boolean,
  ): {
    padStart: number;
    padEnd: number;
    shift: number;
    up: number;
    down: number;
  } | null {
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    const box = tree && this._firstBoxesOf(tree).get(element);
    if (!box) return null;
    const scroller = nearestScroller(box);
    const port = this._scrollportOf(scroller, vertical);
    const [padStart, padEnd] = this._scrollPadding(
      scroller,
      vertical,
      port.size,
    );
    const sticky = stickyReach(box, scroller, vertical);
    const s = this._scale;
    return {
      padStart: padStart / s,
      padEnd: padEnd / s,
      shift: sticky.shift / s,
      up: sticky.up / s,
      down: sticky.down / s,
    };
  }

  /** A scrollport, in document coordinates — a scroll container's or,
   *  for null, the pane's — along one axis: where it starts, how long it
   *  is, how far it is scrolled and how far it can be. */
  private _scrollportOf(
    scroller: Box | null,
    down: boolean,
  ): { start: number; size: number; offset: number; max: number } {
    if (scroller) {
      const st = scrollStateOf(scroller);
      const size = down ? st.clientHeight : st.clientWidth;
      return {
        start: down
          ? scroller.y + scroller.borderTop
          : scroller.x + scroller.borderLeft,
        size,
        offset: down ? st.y : st.x,
        max: down ? st.height - st.clientHeight : st.width - st.clientWidth,
      };
    }
    const viewport = this._viewport();
    const origin = this._scrolledOrigin();
    const port = viewport
      ? {
          x: viewport.x - origin.x,
          y: viewport.y - origin.y,
          width: viewport.width,
          height: viewport.height,
        }
      : { x: 0, y: 0, width: this.abs.width, height: this.abs.height };
    const start = down ? port.y : port.x;
    const size = down ? port.height : port.width;
    return {
      start,
      size,
      offset: start,
      max: Math.max(
        0,
        (down ? this._documentHeight : this._documentWidth) - size,
      ),
    };
  }

  /** A scroll or a layout moved: the scroll-driven animations whose
   *  timelines are somewhere else now are styled again at the next frame. */
  private _restyleScrolled(): void {
    if (!this._animating()) return;
    this._timeline.scrollProgress = this._timelineProgress;
    if (this._timeline.restyleScrolled()) this._scheduleFrame();
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
        this._timeline.dropScripts(element);
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
    // what was made since the last paint starts now where nothing waits to
    // be painted: the window shows each as it starts already, and no paint
    // is coming to start it — a transition turned back from where it was
    // drawn, a fade out from what the element looks like
    if (this._claims === this._claimsPainted) {
      this._timeline.startPending(animationClock.now());
    }
    // the surfaces kept for an animation that is over: a box drawn on one
    // keeps one from now on only where it is small enough to keep still
    this._sprites?.sweep((box) => {
      const el = (box as Box).el;
      return (
        !!el && (this._timeline.isLive(el) || this._animatesWithin(box as Box))
      );
    });
    // and none while a drag is drawn cheaper (`_behind`)
    const next =
      this._animating() && !this._cheap
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

  // --- animated images ------------------------------------------------------
  //
  // An animated GIF is an image whose pixels change as time passes, and
  // nothing else: no box is another size or style for it. So a frame of one
  // is a repaint of the boxes that drew it (`_gifFrame`), as a read of a
  // filter's pixels arriving is (`_filterArrived`), and the frame drawn is
  // the one showing at the paint (`_frameOf`). Nothing ticks for an image
  // nothing paints: a frame is asked for only by a paint that drew the one
  // before, so an image scrolled out of view stops until it is drawn again,
  // where it shows the frame it has come to.

  /**
   * The frame of `animation` to draw now, for `box` — and a note that the
   * box drew it, with a timer for when the frame moves on. At rest
   * (`animate={false}`) the first frame, as `animate` holds a CSS
   * animation at its start, and with no note.
   */
  private _frameOf(animation: AnimatedImage, box: Box | null): unknown {
    if (!this._animating()) return animation.image(0);
    const now = animationClock.now();
    const index = animation.indexAt(now);
    const next = animation.nextChange(now);
    if (next !== null) {
      let drawn = this._gifs.get(animation);
      if (!drawn || drawn.index !== index || drawn.tree !== this._tree) {
        drawn = { index, tree: this._tree, boxes: new Set() };
        this._gifs.set(animation, drawn);
      }
      drawn.boxes.add(box);
      this._armGif(next);
    }
    return animation.image(index);
  }

  /** A timer for `at`, where none is due sooner. None while a drag is drawn
   *  cheaper (`_behind`): the paint at rest after it asks again. */
  private _armGif(at: number): void {
    if (this.destroyed || this._cheap) return;
    if (this._gifTimer !== null && this._gifAt <= at) return;
    this._disarmGif();
    this._gifAt = at;
    this._gifTimer = animationClock.arm(
      this._gifFrame,
      Math.max(1, at - animationClock.now()),
    );
  }

  private _disarmGif(): void {
    if (this._gifTimer === null) return;
    animationClock.disarm(this._gifTimer);
    this._gifTimer = null;
    this._gifAt = Infinity;
  }

  /**
   * The frame of some animated image moved on: the boxes that drew the one
   * before are painted again where they are, and what holds a drawing of
   * them goes — the surfaces kept around them, and the layer lifted around
   * one, made again in a frame asked for, since a lifted box's hole claims
   * no damage. A box from a tree since built again is passed over: the
   * build painted everything, and noted what drew the image then.
   */
  private readonly _gifFrame = (): void => {
    this._gifTimer = null;
    this._gifAt = Infinity;
    if (this.destroyed) return;
    const now = animationClock.now();
    const inks: Rect[] = [];
    let whole = false;
    let lifted = false;
    for (const [animation, drawn] of this._gifs) {
      if (animation.indexAt(now) === drawn.index) {
        const next = animation.nextChange(now);
        if (next !== null) this._armGif(next);
        continue;
      }
      this._gifs.delete(animation);
      if (drawn.tree !== this._tree) continue;
      for (const box of drawn.boxes) {
        if (!box) {
          whole = true;
          continue;
        }
        this._dropSprites(box, true);
        if (this._lifted.size && this._insideLifted(box)) lifted = true;
        const ink = this._inkOf(box);
        if (ink) inks.push(ink);
      }
    }
    if (whole) {
      this._imagePainted();
      return;
    }
    if (lifted) {
      this._spriteGen += 1;
      this.spritesChanged();
    }
    this._repaintInk(inks);
  };

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
  override sprites(): (DocumentSprite | DocumentShadowSprite)[] | null {
    return this._counted(() => this._offerSprites());
  }

  private _offerSprites(): (DocumentSprite | DocumentShadowSprite)[] | null {
    this._offered.clear();
    this._offeredShadows.clear();
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
    // and the boxes whose shadows are in transition with what no layer
    // carries, whose shadows alone go on one (`shadowLiftOf`)
    const shadowLifts: ShadowLift[] = [];
    for (const { el, targets } of live) {
      const element = el as Element;
      for (const name of targets) {
        if (name !== '' && name !== 'before' && name !== 'after') continue;
        // an element's and its pseudo-elements' alike: a `::before` is in
        // its element's box, so where both are offered it goes in the
        // element's layer, and its element's raster leaves it out
        const lift = liftOf(host, element, name);
        if (lift) lifts.push(lift);
        else if (name === '') {
          const shadows = shadowLiftOf(host, element);
          if (shadows) shadowLifts.push(shadows);
        }
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
    // and the shadows offered on their own, among them in the same order:
    // where their box is painted, which they are the first of. Their box is
    // the document's, so nothing painted before it may stay on a layer over
    // it, and it is in no part's way above (`above`).
    const tops: Top[] = made
      .filter((entry) => !entry.parent)
      .map((entry) => ({ order: entry.order!, made: entry, shadow: null }));
    for (const lift of shadowLifts) {
      const part = this._shadowPartFor(host, lift, stamp);
      const order = part && paintOrderOf(lift.box);
      if (!part || !order) continue;
      const key = `${this._spriteKeyOf(lift.el, '')}|shadows`;
      tops.push({ order, made: null, shadow: { part, key } });
    }
    tops.sort((a, b) => byPaintOrder(b.order, a.order));
    const above = new Set<Box>();
    const kept: Top[] = [];
    for (const top of tops) {
      if (top.made) {
        if (coveredAfter(tree, top.made.part, above)) continue;
        above.add(top.made.lift.box);
      } else if (shadowsCovered(tree, top.shadow!.part, above)) continue;
      kept.push(top);
    }
    kept.reverse();
    let options: PaintOptions | null = null;
    let out: (DocumentSprite | DocumentShadowSprite)[] | null = null;
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
    for (const top of kept) {
      if (top.made) {
        offer(top.made);
        continue;
      }
      const { part, key } = top.shadow!;
      this._offeredShadows.set(key, part.lift.el);
      (out ??= []).push(
        describeShadows(part, key, this.abs.x, this.abs.y, now),
      );
    }
    return out;
  }

  /** The part `lift`'s shadows are, made again only where what it is made
   *  from changed (`stamp`, and the lift's own id). */
  private _shadowPartFor(
    host: SpriteHost,
    lift: ShadowLift,
    stamp: string,
  ): ShadowPart | null {
    const stamped = `${stamp}|${lift.id}`;
    const was = this._shadowOffers.get(lift.el);
    if (was?.stamp === stamped) return was.part;
    const part = shadowPartOf(host, lift, was?.part ?? null);
    this._shadowOffers.set(lift.el, { stamp: stamped, part });
    return part;
  }

  /** The boxes whose shadows are on layers, in `tree`: their outer shadows
   *  are no ink of the document's (`PaintOptions.shadowless`). */
  private _shadowlessBoxes(tree: BoxTree): ReadonlySet<Box> | null {
    if (!this._shadowsLifted.size) return null;
    const cache = this._shadowlessCache;
    if (cache?.tree === tree && cache.lifted === this._shadowsLifted) {
      return cache.boxes;
    }
    const first = this._firstBoxesOf(tree);
    const boxes = new Set<Box>();
    for (const el of this._shadowsLifted.values()) {
      const box = first.get(el);
      if (box) boxes.add(box);
    }
    this._shadowlessCache = { tree, lifted: this._shadowsLifted, boxes };
    return boxes;
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
    // a box's shadows on a layer: its paint and its damage leave them out,
    // and the presenter claims where they reach as it lifts them and gives
    // them back, which the document repaints
    const shadows = new Map<string, Element>();
    for (const key of keys) {
      const target = this._lifted.get(key) ?? this._offered.get(key);
      if (target) next.set(key, target);
      const el = this._shadowsLifted.get(key) ?? this._offeredShadows.get(key);
      if (el) shadows.set(key, el);
    }
    this._shadowsLifted = shadows;
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
    const el =
      (this._lifted.get(key) ?? this._offered.get(key))?.el ??
      this._shadowsLifted.get(key) ??
      this._offeredShadows.get(key);
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
   * animation moves them — a fade is hit where it is — and that can reach
   * the point at all (`at`, in the document's coordinates): a spinner at the
   * foot of a list is under no wheel turned over the list, and a wheel asks
   * twice a notch. Nothing is repainted or offered again: their pixels are
   * their layers', which already show them there.
   */
  private _followLifted(at?: { x: number; y: number }): void {
    if (!this._lifted.size || this._followingLifted) return;
    let moving: Set<Element> | null = null;
    let generated = false;
    for (const { el, pseudo } of this._lifted.values()) {
      const part = this._spriteOffers.get(el)?.[pseudo]?.part;
      if (!part?.lift.moves) continue;
      // `extent` says where it can be but for one drawn at the viewport,
      // which the pane's scroll places, or in another's layer
      if (
        at &&
        !part.atViewport &&
        !part.nested &&
        !holdsPoint(part.extent, at)
      ) {
        continue;
      }
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
    which: 'before' | 'after' | 'details-content',
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
    if (this.destroyed || !this._animating() || this._cheap) return;
    this._counted(this._makeFrame);
  };

  /** What a frame of the animations does, timed (`_counted`). */
  private readonly _makeFrame = (): void => {
    // an animation no paint has shown for long — nothing draws the
    // document, or not where it is — starts anyway, and runs to its end
    const now = animationClock.now();
    if (now - this._timeline.pendingSince >= PAINT_WAIT_MS) {
      this._timeline.startPending(now);
    }
    const tree = this._tree;
    // a build is coming, and styles every animated element at its time
    if (!this._cascade || !tree || this._stale !== Stale.Nothing) return;
    // A repaint a frame asked for two frames ago is not painted yet: the
    // window is drawing slower than the clock, and a frame made now would
    // be made again before anyone saw it. On a slow server most frames were
    // — the Zen Garden's 219 built its boxes 53 times a second and was
    // shown 9. So it waits for the paint, which asks for the next frame. One
    // frame ahead of the window is no waste, but a pipeline, and a window
    // that keeps up never waits: made only after each paint, 219 ran at 18
    // frames a second on Wayland where it ran at 35. And it waits no longer
    // than `PAINT_WAIT_MS`: a document scrolled out of its pane, or in a
    // window nothing draws, paints nothing, and runs on at that pace.
    const owed = this._owedSince;
    const late = owed >= 0 ? animationClock.now() - owed : 0;
    if (late >= PAINT_LATE_MS && late < PAINT_WAIT_MS) {
      this._waitingForPaint = true;
      this._frameAt = owed + PAINT_WAIT_MS;
      this._frameTimer = animationClock.arm(
        this._frame,
        Math.max(1, this._frameAt - animationClock.now()),
      );
      return;
    }
    // made anyway: what it owes is counted from this frame
    if (late >= PAINT_WAIT_MS) this._owedSince = -1;
    this._waitingForPaint = false;
    const claims = this._claims;
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
    if (this._claims !== claims && this._owedSince < 0) {
      this._owedSince = animationClock.now();
    }
    this._scheduleFrame();
  };

  /** When a frame of the animations first asked for a repaint the window
   *  has not painted since, on the animation clock; -1 where none is owed
   *  (`_frame`). */
  private _owedSince = -1;
  /** Whether a frame is waiting for that paint (`_frame`, `paint`). */
  private _waitingForPaint = false;
  /** Repaints asked for, which a frame compares across its work. */
  private _claims = 0;
  /** How many had been asked for at the last paint, -1 before the first:
   *  where it is all of them, nothing waits to be painted
   *  (`_scheduleFrame`). */
  private _claimsPainted = -1;

  override invalidate(
    layout?: boolean,
    damage?: Node | Rect | null,
    reason?: string,
  ): void {
    this._claims += 1;
    // a change anywhere under a view transition's tree may be drawn in any
    // image of it, wherever its group puts it
    if (this._vt?.phase === 'live' && damage && damage !== this) damage = this;
    super.invalidate(layout, damage, reason);
  }

  /**
   * A frame that changed what layout reads: the subtrees of what it reached
   * built again around every other box, and every other element's kept
   * style (`_subtreeBuild`), and the document laid out, at once.
   * Where each element whose style changed is positioned out of the flow —
   * absolutely or fixed, before and after — or is inside one that is, it
   * is laid out apart from everything around it (CSS 2.1 9.6); and where
   * no other element's box moved and the document is the size it was,
   * what the frame changed is what those boxes drew before and draw now.
   * That is repainted, and anything else repaints the whole element. Zen
   * Garden 219's marquees and panels are all positioned so.
   *
   * The boxes the build keeps are the same boxes after it, which its
   * layout moves where it moves them: so where each was, and what the
   * boxes out of the flow around what the frame reached drew — the roots
   * a change inside them is reported by — are taken before it.
   * joshwcomeau.com's like button sparkles three times a second, and each
   * sparkle's turn that started or ended built and laid out the whole
   * article.
   */
  private _rebuildFrame(reach: ReadonlySet<Element>, follow = false): void {
    this._geometry += 1;
    const before = this._tree!;
    const width = this._laidOutWidth;
    const size = [this._documentWidth, this._documentHeight];
    // the index the build updates for the tree it makes, as it was
    const beforeBoxes = new Map(this._firstBoxesOf(before));
    const placed = new Map<Box, Rect>();
    for (const box of beforeBoxes.values()) {
      placed.set(box, {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
    }
    const drew = new Map<Box, KeptInk>();
    const climbed = new Set<Element>();
    for (const el of reach) {
      for (let at: Element | null = el; at; at = flatParentOf(at)) {
        if (climbed.has(at)) break;
        climbed.add(at);
        const style = before.styles.get(at)?.style;
        const box = beforeBoxes.get(at);
        if (!style || !box || !outOfFlow(style)) continue;
        drew.set(box, {
          ink: this._inkOf(box),
          bounds: {
            x: box.boundsX,
            y: box.boundsY,
            width: box.boundsWidth,
            height: box.boundsHeight,
          },
        });
      }
    }
    this._stale = Stale.Boxes;
    this._restyleOnly = new Set(reach);
    this._restyleFollows = follow;
    this._buildSeeds = new Set(reach);
    this._buildAlways = this._buildSeeds;
    this._buildPseudo = HOVER_PSEUDO_NONE;
    this._buildTails = null;
    this._buildParsed = false;
    this._carryingFrom = width;
    try {
      this._prepare(width);
    } finally {
      this._carryingFrom = null;
    }
    const after = this._tree;
    const changes =
      after &&
      this._laidOutWidth === width &&
      this._documentWidth === size[0] &&
      this._documentHeight === size[1]
        ? this._changedOutOfFlow(before, beforeBoxes, placed, after, reach)
        : null;
    if (changes) {
      for (const change of changes) {
        if (change.was) change.drew = drew.get(change.was);
      }
      this._carrySprites(after!, changes);
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
      for (const { was, now, drew: kept } of shown) {
        const old = kept ? kept.ink : was && this._inkOf(was);
        if (old) inks.push(old);
        const ink = now && this._inkOf(now);
        if (ink) inks.push(ink);
      }
      this._repaintInk(inks);
      return;
    }
    this._sprites?.clear();
    this.invalidateMeasure('content');
    this.invalidate(true, this, 'props');
  }

  /** Where `_prepare` builds for a frame, the width the tree before it was
   *  laid out at: the build and its layout keep the surfaces kept for
   *  boxes, for `_carrySprites` to move or give up, rather than forgetting
   *  them. Null otherwise. */
  private _carryingFrom: number | null = null;

  /**
   * After a frame's build that changed only what `changes` names, out of the
   * flow: each kept surface moves to the box that draws its element now,
   * where that box is where the old one was and styled as it was, with the
   * ink of what changed inside it, before and after, to be painted again on
   * it (`repaintStale`); and the rest are given up, as a build gives up all
   * of them. A change of the element itself gives its surface up.
   */
  private _carrySprites(after: BoxTree, changes: OutOfFlowChange[]): void {
    const sprites = this._sprites;
    if (!sprites?.size) return;
    const afterBoxes = this._firstBoxesOf(after);
    const inkOfBox = (b: Box): Rect => ({
      x: b.boundsX,
      y: b.boundsY,
      width: b.boundsWidth,
      height: b.boundsHeight,
    });
    sprites.carry((key) => {
      const was = key as Box;
      const el = was.el;
      const which = was.pseudo;
      if (!el || (which && which !== 'before' && which !== 'after'))
        return null;
      const now = which
        ? this._pseudoBoxOf(after, el, which)
        : afterBoxes.get(el);
      if (
        !now ||
        now.style !== was.style ||
        now.x !== was.x ||
        now.y !== was.y ||
        now.width !== was.width ||
        now.height !== was.height
      ) {
        return null;
      }
      const stale: Rect[] = [];
      for (const change of changes) {
        const pseudo = change.now?.pseudo || change.was?.pseudo || '';
        if (change.el === el) {
          // the element itself, or the pseudo-element the surface is of
          if (!pseudo || pseudo === was.pseudo) return null;
          // a `::before` or an `::after` inside its element's box
          if (was.pseudo) continue;
        } else {
          if (was.pseudo) continue;
          let inside = false;
          for (let at = flatParentOf(change.el); at; at = flatParentOf(at)) {
            if (at === el) {
              inside = true;
              break;
            }
          }
          if (!inside) continue;
        }
        const drew =
          change.drew?.bounds ?? (change.was && inkOfBox(change.was));
        if (drew) stale.push(drew);
        if (change.now) stale.push(inkOfBox(change.now));
      }
      return { box: now, stale };
    });
  }

  /** Whether an animation is under way on an element inside `box`'s own,
   *  which paints it again at each frame (`SpriteSource.animatesWithin`). */
  private _animatesWithin(box: Box): boolean {
    const el = box.el;
    if (!el || box.pseudo || !this._animating()) return false;
    for (const { el: at } of this._timeline.live(this._skipLifted)) {
      for (let p = flatParentOf(at as Element); p; p = flatParentOf(p)) {
        if (p === el) return true;
      }
    }
    return false;
  }

  /**
   * What a tree built again changed, where all it changed is positioned out
   * of the flow or inside what is: for each element whose style changed,
   * the nearest out of the flow before and after, itself or around it, and
   * each `::before` or `::after` of the elements the frame restyled
   * (`reach`) out of the flow, with the boxes it was drawn in and is. Null
   * where an element or a pseudo-element in the flow changed, or a box of
   * one that did not moved. A sparkle's drawing that ends its turn in a
   * span placed absolutely changes nothing outside the span, and built
   * and laid out the whole document and repainted all of it.
   */
  private _changedOutOfFlow(
    before: BoxTree,
    beforeBoxes: ReadonlyMap<Element, Box>,
    /** Where each of those was laid out, which a box the build kept is
     *  not now where the layout moved it. */
    placed: ReadonlyMap<Box, Rect>,
    after: BoxTree,
    reach: ReadonlySet<Element>,
  ): OutOfFlowChange[] | null {
    if (before.styles.size !== after.styles.size) return null;
    const changed: Element[] = [];
    const found = new Set<Element>();
    // the nearest element out of the flow in both trees, at or around one
    // that changed: a box laid out apart from everything around it, with
    // all it holds (CSS 2.1 9.6)
    const rootOf = (el: Element): Element | null => {
      for (let at: Element | null = el; at; at = flatParentOf(at)) {
        const was = before.styles.get(at)?.style;
        const now = after.styles.get(at)?.style;
        if (!was || !now) return null;
        if (outOfFlow(was) && outOfFlow(now)) return at;
      }
      return null;
    };
    for (const [el, now] of after.styles) {
      const was = before.styles.get(el);
      if (!was) return null;
      if (was.style === now.style || sameValue(was.style, now.style)) continue;
      changed.push(el);
      const root = rootOf(el);
      if (!root) return null;
      found.add(root);
    }
    // of those, the outermost: what is in one moves with it
    const roots: Element[] = [];
    for (const root of found) {
      let inside = false;
      for (let at = flatParentOf(root); at && !inside; at = flatParentOf(at)) {
        inside = found.has(at);
      }
      if (!inside) roots.push(root);
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
      if (!was || !sameGeometry(was, box, placed.get(was))) return null;
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
    // seen until a scroll repainted it. An element styled again because
    // its parent's style changed (`KeptStyles.follow`) is in `changed`
    // where its own did, and its pseudo-elements, styled over it, can
    // have changed only then.
    for (const el of changed.length ? new Set([...reach, ...changed]) : reach) {
      // inside a root, whose own change takes in what it holds
      if (apart.has(el)) continue;
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
   * Told what changed (`changes`), it restyles what the change can reach
   * and no more (`_changeScope`): the elements a selector that tests what
   * changed can match, where every element was styled again. Where all
   * that changed is ink, in place, as a hover is (`_restyleInPlace`);
   * where it is positioned out of the flow, built again and repainted
   * where it was and is, as an animation's frame is (`_rebuildFrame`);
   * and otherwise built again keeping every other element's style.
   *
   * Explicit rather than observed: see `HtmlHandle.refresh`.
   */
  touchDocument(changes: readonly HtmlChange[] | null = null): void {
    this._source.touch();
    this._updateBase();
    this._sweep();
    // a preload of what is here already settles as it is asked for, which
    // no layout need follow
    this._tellSheets();
    this._highlightsChanged();
    const scope = changes ? this._changeScope(changes) : null;
    if (!scope) {
      this._invalidate(Stale.Style);
      return;
    }
    this._restyleChanged(scope);
  }

  /** Whether a rule reads a control's state (`useForms`): one that none
   *  does has nothing to tell a keystroke to. */
  get readsControls(): boolean {
    return this._cascade?.readsControls ?? false;
  }

  /** A rule a change turns on or off for a custom highlight restyles no
   *  element of its own, and its text is painted again in the new look. */
  private _highlightsChanged(): void {
    if (
      (this._highlights.length || this._targetText?.ranges.some(Boolean)) &&
      this._cascade?.hasHighlights
    ) {
      this._cascade.highlightGeneration += 1;
      this.invalidate();
    }
  }

  /**
   * What a stream's chunk did to the tree (`HtmlSource.takeAppended`),
   * restyled and built as a change an application tells of is
   * (`touchDocument`) — with what the parser does known besides: it puts
   * nodes in at the end of what holds them and writes on to the text that
   * ends one, so no node before them sits elsewhere, and the boxes a build
   * can keep are those of everything before the first thing it touched in
   * each (`ChangeScope.tails`). False where it cannot be said, and every
   * element is to be styled again.
   */
  private _parsedChanges(changes: readonly HtmlChange[]): boolean {
    if (!changes.length) return true;
    this._highlightsChanged();
    const scope = this._changeScope(changes, true);
    if (!scope) return false;
    // What a drawing names by an id — a sprite's symbol, a gradient, a clip
    // — may be what came, or grow, and a drawing kept from before draws it
    // as it has it now, matched by the rules again (`SHAPE_STYLES`): where
    // a chunk brings an id, or writes into a drawing, every drawing is
    // drawn again. A build of the whole made every drawing anew.
    if (namesAnew(changes)) {
      this._tree?.shapeCopies?.forget(
        idIndex(this._source.document as unknown as Element),
      );
      for (const el of this._source.facts().drawings) scope.drawings.add(el);
    }
    this._restyleChanged(scope);
    return true;
  }

  /**
   * What a list of changes to the tree can restyle: the elements whose own
   * styles may have changed (`own`), whether the boxes have to be built
   * again (`boxes`), the inline drawings to draw again, and which
   * pseudo-elements' rules read what changed. Null where that cannot be
   * said, and where the change is one to the cascade itself — a sheet
   * coming, going or changing, a `<meta>` or a `<base>` — so every
   * element is styled again.
   */
  private _changeScope(
    changes: readonly HtmlChange[],
    /** Whether they are what a stream's chunk did (`_parsedChanges`). */
    parsed = false,
  ): ChangeScope | null {
    const cascade = this._cascade;
    const tree = this._tree;
    if (!cascade || !tree || this._stale >= Stale.Style) return null;
    const scope: ChangeScope = {
      own: new Set(),
      targets: new Set(),
      always: new Set(),
      treePseudo: HOVER_PSEUDO_NONE,
      boxes: false,
      drawings: new Set(),
      pseudo: HOVER_PSEUDO_NONE,
      anchored: new Map(),
      altered: new Set(),
      ...(parsed && { tails: new Map() }),
    };
    const unchanged = unchangedAttributes(changes);
    for (const change of changes) {
      if (change.type !== 'childList' || change.nextSibling === undefined) {
        continue;
      }
      for (const node of change.removedNodes) {
        (scope.gone ??= new Map()).set(node, change.nextSibling);
      }
    }
    for (const change of changes) {
      if (unchanged?.has(change)) continue;
      if (!this._scopeOf(change, cascade, tree, scope)) return null;
    }
    for (const change of derivedChanges(changes, unchanged, cascade)) {
      if (!this._scopeOf(change, cascade, tree, scope)) return null;
    }
    // what holds an element whose own boxes can differ is no tail's
    if (scope.altered) {
      for (const el of scope.altered) {
        scope.tails?.delete(el);
        scope.ends?.set(el, false);
      }
    }
    return scope;
  }

  /** One change into `scope` (`_changeScope`); false where it cannot be
   *  said what the change reaches. */
  private _scopeOf(
    change: HtmlChange,
    cascade: Cascade,
    tree: BoxTree,
    scope: ChangeScope,
  ): boolean {
    // What is not in the document draws nothing, and no selector reads it:
    // a fragment a script builds before it puts it in, an element it took
    // out. Its coming in is a change to the document, and says so.
    if (!inDocument(change.target, this._source.document)) return true;
    // What is inside a drawing has no box and no style of its own: the
    // drawing is drawn again. A `:has()` around it may ask it something,
    // and what that restyles is found as for a change anywhere — the
    // anchors the change reaches, from the drawing up: what is inside it is
    // drawn again with it. joshwcomeau.com animates an inline drawing a
    // path at a time, and with one `:has()` anywhere in its sheets each
    // frame restyled all 6,000 elements of the page, which held its frames'
    // downloads back seconds.
    const drawing = drawingAround(change.target);
    // A host that took a shadow tree draws what the tree holds, and what no
    // slot takes of its own is drawn no longer. No selector outside the host
    // can tell, so that is its reach: every element it holds, however
    // deep, built with it. Its rules are bound to the tree as the sheets
    // are read (`_sheetsAdded`), where one that brings rules of its own
    // makes the cascade again. Every custom element with a shadow tree
    // restyled and built the whole document: MDN's and GitHub's each spent
    // more than a second of a load on it. A tree that adopted other sheets
    // reaches what one put on the host does.
    if (change.type === 'shadowRoot') {
      if (drawing) return false;
      const host = change.target;
      scope.boxes = true;
      scope.sheets = true;
      scope.targets.add(host);
      scope.always.add(host);
      addFlatSubtree(host, scope.own);
      addFlatSubtree(host, scope.always);
      return true;
    }
    if (drawing) {
      if (cascade.asksWhatElementsHold) {
        const reach =
          change.type === 'attributes'
            ? cascade.attributeChange(
                change.attributeName.toLowerCase(),
                change.oldValue,
                attr(change.target, change.attributeName.toLowerCase()) ?? null,
              )
            : cascade.treeChange(
                change.type === 'characterData',
                changedNodes(change),
              );
        if (!reach) return false;
        if (
          reach.anchors &&
          !spreadAnchors(
            drawing,
            false,
            reach.anchors,
            scope,
            cascade.changesCrossTrees,
          )
        ) {
          return false;
        }
      }
      // but what its `<foreignObject>`s hold is styled from its elements
      // down, and laid out at each object's size: a change in a drawing
      // with any builds the boxes
      if (tree.foreign && drawsForeign(tree.foreign, drawing)) {
        scope.boxes = true;
        return true;
      }
      scope.drawings.add(drawing);
      return true;
    }
    // where the boxes can differ: the element an attribute changed of, or
    // what holds what came, went or changed (`_subtreeRoots`)
    const changed =
      change.type === 'characterData' ? change.target.parent : change.target;
    const target = changed instanceof ShadowRoot ? changed.host : changed;
    if (target && isElement(target) && change.type !== 'childList') {
      scope.targets.add(target as Element);
      if (change.type !== 'attributes') scope.always.add(target as Element);
    }
    if (change.type === 'attributes') {
      const el = change.target;
      const name = change.attributeName.toLowerCase();
      // an attribute nothing has is no box's
      if (!name.startsWith('-rx-')) scope.altered?.add(el);
      if (
        changesCascade(el, name, change.oldValue ?? null) &&
        !(SHEET_TAGS.has(tagOf(el)) && this._sheetsKept(el, scope))
      ) {
        // a sheet's element: the cascade is made again before the build,
        // which styles what the rules it adds can style besides what the
        // change reaches (`_sheetsAdded`)
        if (!SHEET_TAGS.has(tagOf(el))) return false;
        scope.sheets = true;
      }
      const reach = cascade.attributeChange(
        name,
        change.oldValue,
        attr(el, name) ?? null,
      );
      if (!reach) return false;
      let bits = reach.bits;
      // an `attr()` in its own `style` reads any of its attributes, which
      // no rule says (`MutationRules` notes a rule's)
      if (name !== 'style' && attr(el, 'style')?.includes('attr(')) {
        bits |= CHANGES_SELF;
      }
      const anchors = reach.anchors;
      // Something the boxes read of the element besides its style — a
      // source, a value, a span, a label — or a hint its style takes, or
      // what is in it takes: a table's `cellpadding` is its cells'.
      // A `tabindex` that stays a number says only whether Tab reaches the
      // element (`isTabbable`), which is asked of a tree's focusable areas
      // once a tree: Apple's galleries move theirs from card to card
      const stops = name === 'tabindex' && tabindexStays(el, change.oldValue);
      if (stops) scope.stops = true;
      const quiet = stops || STYLE_ONLY_ATTRIBUTE.test(name);
      if (!quiet) scope.always.add(el);
      if (!quiet) bits |= CHANGES_SELF | CHANGES_BELOW;
      else if (name === 'style') bits |= CHANGES_SELF;
      if (!bits && !anchors) return true;
      // under an element nothing draws, nothing it reaches is drawn — but
      // a `:has()` it changes the answer to is around it
      if (!anchors && el.parent && isElement(el.parent)) {
        if (undrawn(el.parent, tree)) return true;
      }
      if (!quiet) scope.boxes = true;
      if (reach.pseudo > scope.pseudo) scope.pseudo = reach.pseudo;
      const crossing = cascade.changesCrossTrees;
      // below the element, what the rules testing the change can style
      // (`AttributeReach.below`): what reads the attribute besides the
      // cascade reads it of everything in the element
      spreadChange(
        el,
        bits,
        false,
        scope.own,
        crossing,
        undefined,
        quiet ? reach.below : null,
        reach.later,
      );
      return !anchors || spreadAnchors(el, false, anchors, scope, crossing);
    }
    // What an element holds: its children, or a text's data. A comment is
    // nothing a selector counts — not an element, and no text — and draws
    // nothing; a script draws nothing either, but is an element, which a
    // `:first-child` or a sibling combinator counts.
    const parent =
      change.type === 'childList' ? change.target : change.target.parent;
    // the top of a shadow tree holds what is in it as an element does,
    // with nothing above it in its tree for a selector to read
    const root = parent instanceof ShadowRoot ? parent : null;
    // and a stream's fragment is what the document holds, at its top
    const atTop = !!scope.tails && parent === this._source.document;
    if (!parent || (!root && !atTop && !isElement(parent))) return false;
    if (scope.tails && root) return false;
    if (
      !root &&
      !atTop &&
      CASCADE_TAGS.has(tagOf(parent as Element)) &&
      !(tagOf(parent as Element) === 'style' && this._sheetsKept(parent, scope))
    ) {
      // what a `<style>` holds is its sheet: a CSS-in-JS library writes its
      // rules into one as their components first render
      if (tagOf(parent as Element) !== 'style') return false;
      scope.sheets = true;
    }
    let drawn = false;
    if (change.type === 'childList') {
      let counted = false;
      for (const nodes of [change.addedNodes, change.removedNodes]) {
        for (const node of nodes) {
          const held = cascadeHeld(node);
          if (held & HELD_PRAGMA) return false;
          if (held & HELD_SHEET && !this._sheetsKept(parent, scope)) {
            scope.sheets = true;
          }
          // a shadow tree that came with it is bound as the sheets are read
          if (held & HELD_TREE && nodes === change.addedNodes) {
            scope.sheets = true;
          }
          if (node.type !== 'comment') counted = true;
          if (
            !drawn &&
            draws(node, nodes === change.addedNodes, tree, cascade)
          ) {
            drawn = true;
          }
        }
      }
      if (!counted) return true;
    } else if (change.target.type === 'comment') {
      return true;
    } else drawn = true;
    if (scope.tails)
      return this._appendedScope(change, parent, drawn, tree, scope);
    const reach = cascade.treeChange(
      change.type === 'characterData',
      changedNodes(change),
    );
    if (!reach) return false;
    const { kidsLater, followers, siblings, below, self, later, anchors } =
      reach;
    if (reach.pseudo > scope.treePseudo) scope.treePseudo = reach.pseudo;
    let bits = reach.bits;
    if (!drawn && !bits && !kidsLater && !followers && !anchors) return true;
    const holder = root ? root.host : (parent as Element);
    // under a holder nothing draws nothing it reaches is drawn — but its
    // own later siblings, which a test of what it holds before a sibling
    // combinator reaches, are not under it: `.panel:empty ~ .hint` with the
    // panel hidden kept its hint as the panel was
    if (!anchors && !(bits & CHANGES_LATER) && undrawn(holder, tree)) {
      return true;
    }
    if (drawn) scope.boxes = true;
    if (change.type === 'childList') {
      // what holds what came or went — but where none of it is ever drawn,
      // a script or a style a page puts in or takes out, no box of the
      // holder's can differ: what came is styled where it is, and what went
      // is a seed of its own, whose style goes (`_subtreeRoots`)
      if (drawn) {
        scope.targets.add(holder);
        scope.always.add(holder);
        // and where among them, so that a build keeps the boxes before it
        // and builds the end of what the holder holds (`_subtreeRoots`):
        // a webmail page puts its popups at the end of its `<body>`, and
        // each built the whole document again
        if (!root) {
          const from = changedFrom(change, parent, scope.gone);
          const ends = (scope.ends ??= new Map());
          const had = ends.get(parent);
          if (had === false) {
            // a record that does not say where: none
          } else if (from === undefined) ends.set(parent, false);
          else if (
            had === undefined ||
            tailAt(parent, from) < tailAt(parent, had)
          ) {
            ends.set(parent, from);
          }
        }
      } else {
        for (const node of change.removedNodes) {
          if (isElement(node)) {
            scope.targets.add(node);
            scope.always.add(node);
          }
        }
      }
    }
    const crossing = cascade.changesCrossTrees;
    if (change.type === 'childList') {
      // what came in is styled whole, and so is what moved here from
      // elsewhere, under parents it was not styled under, and its boxes are
      // built whatever its style comes to: a rule of a pseudo-element's may
      // reach it where it is now
      for (const node of change.addedNodes) {
        if (isElement(node)) {
          addSubtree(node, scope.own, crossing);
          addSubtree(node, scope.always, crossing);
        }
      }
    }
    if (root) {
      spreadRootChange(root, bits, scope.own, crossing, kidsLater || followers);
    } else {
      // What a test of what the holder holds, or of where one of its
      // children sits, reaches: those of them its compound names
      // (`TreeReach.self`), and below the one it is of, from those, what
      // its rule's subject names (`TreeReach.below`)
      if (bits & CHANGES_SELF && self) {
        bits &= ~CHANGES_SELF;
        if (testedOf(self.holder, holder)) scope.own.add(holder);
        for (const child of holder.children) {
          if (isElement(child) && testedOf(self.kids, child)) {
            scope.own.add(child);
          }
        }
      }
      if (bits & CHANGES_BELOW && below) {
        bits &= ~CHANGES_BELOW;
        const reachFrom = (el: Element): void => {
          if (below.subjects) addSubjects(el, scope.own, below.subjects);
          else addSubtree(el, scope.own, crossing);
        };
        if (testedOf(below.holder, holder)) reachFrom(holder);
        else {
          for (const child of holder.children) {
            if (isElement(child) && testedOf(below.kids, child)) {
              reachFrom(child);
            }
          }
        }
      }
      // A sibling combinator reads an element's earlier siblings, so what
      // came or went reaches the children after where it did and what is
      // in them (`followersOf`) — those its sibling combinators lead to
      // (`siblingsReached`) — or all of them where the change does not say
      // where. A test of where a child sits before one reaches the
      // children after each child it is of, from the first its compound
      // names (`TreeReach.later`): Apple's pages count their cards,
      // `.card:first-child:nth-last-child(2) ~ .card`, and every dialog
      // their script put in the `<body>` restyled all of it.
      const from = followers ? followersOf(change, parent, scope.gone) : null;
      spreadChange(
        parent as Element,
        bits,
        true,
        scope.own,
        crossing,
        from === undefined,
      );
      if (from !== undefined && !(bits & CHANGES_BELOW)) {
        const reached: Element[] = [];
        siblingsReached(
          change,
          parent,
          from,
          siblings,
          kidsLater ? later : false,
          reached,
        );
        for (const el of reached) addSubtree(el, scope.own, crossing);
      }
    }
    return (
      !anchors ||
      spreadAnchors(root ?? (parent as Element), true, anchors, scope, crossing)
    );
  }

  /**
   * `_scopeOf` for what a stream's chunk did to what an element holds, or
   * the document (`_parsedChanges`): nodes put in at its end, or text
   * written on to the one that ends it. So what can be restyled is less
   * than for a change anywhere in what it holds: the new nodes and what is
   * in them; the holder, where what tests whether it holds anything or its
   * text can answer otherwise — `:empty` only where it held nothing; the
   * children that were last, or last of their type, and every child where
   * a rule counts from the end (`Cascade.appendChange`). A sibling
   * combinator reaches what is after the child it follows, which is new.
   * Its boxes can differ from the first child it touched on (`tails`).
   */
  private _appendedScope(
    change: HtmlChange,
    parent: ParentNode,
    drawn: boolean,
    tree: BoxTree,
    scope: ChangeScope,
  ): boolean {
    const cascade = this._cascade!;
    const reach = cascade.appendChange();
    if (!reach) return false;
    if (reach.pseudo > scope.treePseudo) scope.treePseudo = reach.pseudo;
    const text = change.type === 'characterData';
    const added = change.type === 'childList' ? change.addedNodes : [];
    const kids = parent.children;
    const touched = (text ? change.target : added[0]) as ChildNode;
    const at = kids.lastIndexOf(touched);
    if (at < 0) return false;
    const holder = isElement(parent) ? parent : null;
    // the holder's own: whether it holds anything — where nothing before
    // what came is more than a comment or white space — or text, and its
    // text
    let own = 0;
    if (text) own = reach.text | reach.blank;
    else {
      let held = false;
      for (let i = 0; i < at && !held; i += 1) {
        const kid = kids[i];
        held = isElement(kid) || (isText(kid) && NOT_BLANK.test(kid.data));
      }
      if (!held) own |= reach.empty;
      if (added.some((node) => isText(node))) own |= reach.text;
    }
    // the children before what came that were last, and last of a type
    // that came, or every one of them where a rule counts from the end
    const elements = added.filter(isElement) as Element[];
    const before: Element[] = [];
    if (elements.length && (reach.last || reach.every)) {
      const types = new Set(elements.map((el) => tagOf(el)));
      let first = true;
      for (let i = at - 1; i >= 0; i -= 1) {
        const kid = kids[i];
        if (!isElement(kid)) continue;
        if (reach.every || first || types.has(tagOf(kid))) before.push(kid);
        first = false;
        types.delete(tagOf(kid));
        if (!reach.every && !types.size) break;
      }
    }
    const anchors = reach.anchors;
    if (!drawn && !own && !before.length && !anchors) return true;
    // under a holder nothing draws nothing it reaches is drawn — but its
    // own later siblings, which are not under it, and itself where what
    // tests what it holds is what it reaches: an `:empty` one hid
    const under = own ? holder?.parent : holder;
    if (
      under &&
      isElement(under) &&
      !anchors &&
      !(own & CHANGES_LATER) &&
      undrawn(under, tree)
    ) {
      return true;
    }
    if (drawn) {
      scope.boxes = true;
      if (holder) {
        scope.targets.add(holder);
        scope.always.add(holder);
      }
      const tails = scope.tails!;
      const had = tails.get(parent);
      if (!had || kids.lastIndexOf(had) > at) tails.set(parent, touched);
    }
    const crossing = cascade.changesCrossTrees;
    for (const node of added) {
      if (isElement(node)) {
        addSubtree(node, scope.own, crossing);
        addSubtree(node, scope.always, crossing);
      }
    }
    if (holder && own) spreadChange(holder, own, false, scope.own, crossing);
    const kin = reach.last | reach.every;
    for (const el of before) spreadChange(el, kin, false, scope.own, crossing);
    return (
      !anchors ||
      spreadAnchors(
        parent as Element | ShadowRoot,
        true,
        anchors,
        scope,
        crossing,
      )
    );
  }

  /**
   * The tree a build of only the subtrees `seeds` can change makes
   * (`buildSubtrees`), with every other box the tree's own, kept with what
   * its layouts learnt — or null where it cannot be told, and the whole
   * document is built. A root whose element came out as no block in the
   * flow is built from the root around it, a few times over (`wider`). A
   * root in a shadow tree, or one holding one, is no root (`inLightTree`,
   * `holdsShadow`): a flat tree's order is not the document's there.
   */
  private _subtreeBuild(
    seeds: ReadonlySet<Element>,
    options: BuildOptions,
    tails: ReadonlyMap<ParentNode, ChildNode | null> | null = null,
    /** Whether all of it is a stream's chunks' (`_buildParsed`). */
    parsed = false,
  ): BoxTree | null {
    const tree = this._tree;
    if (!tree) return null;
    // most of the document is the whole of it, built with no splice after
    if (seeds.size > tree.styles.size * SUBTREE_MOST) return null;
    // what a drag's layout set aside is put back, as it was, for the
    // build to splice the subtrees into the whole lists: what a restyle in
    // place owed it stays owed (`_asideOwed`), and the next layout sets it
    // aside again where it stops
    if (asideIn(tree)) putBack(tree);
    const first = this._firstBoxesOf(tree);
    let built: SubtreesBuilt | null = null;
    let ends = tails;
    for (let tries = 0; !built; tries += 1) {
      const found = this._subtreeRoots(
        tree,
        seeds,
        options.kept?.restyle,
        ends,
        parsed,
      );
      if (!found) return null;
      found.appendOnly = parsed;
      built = buildSubtrees(tree, this._source.document, found, options, first);
      // A root that came out as no block in the flow of its own — Apple's
      // gallery caption, made absolute by a class its script sets at every
      // step of a drag — is what its parent's flow places otherwise, and
      // is built with the root around it, which the build gives up at
      // without a change to the tree: it had built the whole document.
      if (!built) {
        if (!found.wider || tries >= SUBTREE_WIDENINGS) return null;
        seeds = new Set([...seeds, ...found.wider]);
        // the end of what holds it, from there: a dialog at the top of a
        // `<body>`, shown or hidden, is no root, and built the whole document
        if (found.widerEnds) {
          const wider = new Map(ends);
          for (const [parent, kid] of found.widerEnds) {
            const had = wider.get(parent);
            if (
              had === undefined ||
              tailAt(parent, kid) < tailAt(parent, had)
            ) {
              wider.set(parent, kid);
            }
          }
          ends = wider;
        }
      }
    }
    // what the boxes around each new one measured of the old, for their
    // lives, is measured again
    for (const box of built.made) forgetSizes(box);
    // and each element's first box is the new tree's: its old where it was
    // kept, its new where it was built (`_firstBoxesOf`) — the index the
    // build was found with, which belongs to the tree it replaces
    for (const boxes of built.replaced) {
      for (const box of boxes) {
        if (box.el && first.get(box.el) === box) first.delete(box.el);
      }
    }
    const stack = built.added.slice().reverse();
    while (stack.length) {
      const box = stack.pop()!;
      if (box.el && !first.has(box.el)) first.set(box.el, box);
      for (let i = box.children.length - 1; i >= 0; i -= 1) {
        stack.push(box.children[i]);
      }
    }
    this._firstBoxes = { tree: built.tree, of: first };
    carryBlockers(tree, built.tree, built.replaced, built.added);
    return built.tree;
  }

  /**
   * The seeds of a build of subtrees (`_subtreeBuild`) it has to build:
   * those a change can make otherwise whatever their styles come to
   * (`always`), those whose styles come out other than they are, and any
   * that has a `::before` or an `::after`, or comes to, where a rule of
   * theirs read what changed. What a selector can reach is more than it changes: Apple's script
   * sets a class on each section as it scrolls in, and each of the dozens
   * of elements a rule of that class can style was built again, styled as
   * it was. Asked from the top down, each of its parent's style as it
   * stands, since what is in an element that moved is built with it.
   */
  private _seedsThatMoved(
    seeds: Set<Element>,
    always: ReadonlySet<Element> | null,
    tails: ReadonlyMap<ParentNode, ChildNode | null> | null,
    pseudoRules: 0 | 1 | 2,
    cascade: Cascade,
    kept: KeptStyles,
  ): Set<Element> {
    const tree = this._tree;
    if (
      !tree ||
      !always ||
      (always.size >= seeds.size && !tails?.size) ||
      pseudoRules === HOVER_PSEUDO_OTHER
    ) {
      return seeds;
    }
    const document = this._source.document;
    const generates = (el: Element, style: ComputedStyle): boolean => {
      if (GENERATED_ON.has(el)) return true;
      for (const [which] of GENERATED_BITS) {
        const made = cascade.pseudoStyleFor(el, which, style);
        if (made && made.display !== 'none') return true;
      }
      return false;
    };
    /** The seeds asked about whose styles are as they were: kept, in what
     *  is built around them too. */
    const same = new Set<Element>();
    const moved = (el: Element): boolean => {
      const had = tree.styles.get(el);
      // what holds what came or went is built from there on, where its own
      // style stands (`_subtreeRoots`): the end of a `<body>` a `:has()` is
      // anchored at was all of the `<body>`, and the whole document
      if (
        (always.has(el) && !tails?.has(el)) ||
        !had ||
        !inDocument(el, document)
      ) {
        return true;
      }
      const parent = flatParentOf(el);
      const parentStyle = parent
        ? tree.styles.get(parent)?.style
        : tree.root.style;
      if (!parentStyle) return true;
      const made = cascade.styleFor(el, parentStyle, had.inFlex);
      if (hoverChange(had.style, made) !== null) return true;
      if (pseudoRules !== HOVER_PSEUDO_NONE && generates(el, made)) return true;
      same.add(el);
      return false;
    };
    /** Whether an element is built, or is in what is. */
    const built = new Map<Element, boolean>();
    const left = new Set<Element>();
    const path: Element[] = [];
    const outer = cascade.stylesOf;
    cascade.stylesOf = (el) => tree.styles.get(el)?.style;
    try {
      for (const seed of seeds) {
        let inBuilt = false;
        for (let at: Element | null = seed; at; at = flatParentOf(at)) {
          const known = built.get(at);
          if (known !== undefined) {
            inBuilt = known;
            break;
          }
          path.push(at);
        }
        while (path.length) {
          const el = path.pop()!;
          inBuilt ||= seeds.has(el) && moved(el);
          built.set(el, inBuilt);
        }
        if (inBuilt || always.has(seed)) left.add(seed);
      }
    } finally {
      cascade.stylesOf = outer;
    }
    if (same.size) {
      const restyle = new Set(kept.restyle);
      for (const el of same) restyle.delete(el);
      kept.restyle = restyle;
    }
    return left;
  }

  /**
   * The elements whose subtrees a build of only what `seeds` can change
   * builds (`buildSubtrees`): for each seed still in the document, the
   * nearest element at or around it whose box can be built apart from its
   * siblings (`canRebuild`), and of those the outermost. A seed under an
   * element the last build left `display: none` draws nothing before or
   * after, where that element's style is none a change can reach
   * (`restyled`): the `<style>` a CSS-in-JS library writes to, in the
   * `<head>`. Null where a seed's nearest such element is the document's
   * top.
   */
  private _subtreeRoots(
    tree: BoxTree,
    seeds: ReadonlySet<Element>,
    restyled: ReadonlySet<Element> | undefined,
    tails: ReadonlyMap<ParentNode, ChildNode | null> | null = null,
    /** Whether all of it is a stream's chunks' (`_buildParsed`). */
    parsed = false,
  ): SubtreeRoots | null {
    const first = this._firstBoxesOf(tree);
    const document = this._source.document;
    const roots = new Set<Element>();
    const hidden = new Set<Element>();
    const gone: Element[] = [];
    // The ends of what holds what a stream's chunk touched: from the child
    // after the last block-level box of its own before the first thing the
    // chunk touched, which stays (`tailFrom`). What is in one is its, and so
    // is the change to what holds it. One that cannot be is a seed of a
    // change to what it holds, as any other — but for the document's, whose
    // children no seed says.
    const atTails = new Map<ParentNode, number>();
    const tailed = new Set<ChildNode>();
    const addTail = (node: ParentNode, from: number): void => {
      const had = atTails.get(node);
      if (had !== undefined && had <= from) return;
      atTails.set(node, from);
      const kids = node.children;
      for (let i = from; i < (had ?? kids.length); i += 1) tailed.add(kids[i]);
    };
    for (const [node, touched] of tails ?? []) {
      // past the last child, from a script's change at the end: the last
      // child built with it, since a tail holds one
      const kid = touched ?? node.children[node.children.length - 1];
      const from =
        !kid ||
        (isElement(node) &&
          (restyled?.has(node) || !inLightTree(node as Element)))
          ? -1
          : tailFrom(node, kid, first, tree);
      if (from < 0) {
        if (!isElement(node)) return null;
        continue;
      }
      addTail(node, from);
    }
    const holders = new Set(atTails.keys());
    const inTail = (node: ChildNode): boolean => {
      for (let at: AnyNode | null = node; at; at = at.parent) {
        if (tailed.has(at as ChildNode)) return true;
      }
      return false;
    };
    // and for a seed of a chunk's that no element around it can be built
    // apart for — text a stream writes into an inline box at the top of
    // its document — the end of what holds the child it is in, or of what
    // holds that, from a block of its own before it, which stays
    const tailAround = (seed: Element): boolean => {
      let child: ChildNode = seed;
      for (let node = seed.parent; node;) {
        if (node instanceof ShadowRoot) return false;
        const el = isElement(node) ? (node as Element) : null;
        if (
          !el ||
          ((!seeds.has(el) || holders.has(el)) && !restyled?.has(el))
        ) {
          const from = tailFrom(node, child, first, tree);
          if (from >= 0) {
            addTail(node, from);
            return true;
          }
        }
        if (!el) return false;
        child = el;
        node = el.parent;
      }
      return false;
    };
    // a subtree in a shadow tree or a slot is no run of the document's order:
    // it is built with the host it is in (`inLightTree`)
    const rootAround = (el: Element): Element | null => {
      let at: Element | null = el;
      while (at && !(canRebuild(at, first) && inLightTree(at))) {
        at = flatParentOf(at);
      }
      return at;
    };
    for (const seed of seeds) {
      if (!inDocument(seed, document)) {
        gone.push(seed);
        continue;
      }
      if (holders.has(seed) || (tailed.size && inTail(seed))) continue;
      let hiding: Element | null = null;
      let above: Element | null = null;
      let top = seed;
      let inert = false;
      for (let at: Element | null = seed; at; at = flatParentOf(at)) {
        top = at;
        // no build styles what a `<template>` holds
        if (at !== seed && NON_RENDERED.has(tagOf(at))) {
          inert = true;
          break;
        }
        if (tree.styles.get(at)?.style.display === 'none') {
          hiding ??= at;
          if (at !== seed) above ??= at;
        }
      }
      if (inert) {
        if (tree.styles.has(seed)) gone.push(seed);
        continue;
      }
      // in a host's light tree and in no slot: drawn no longer, and what it
      // drew goes with what the host builds
      if (!hiding && top.parent && isElement(top.parent)) {
        gone.push(seed);
        if (!first.has(top)) continue;
        const around = rootAround(top.parent as Element);
        if (!around) return null;
        roots.add(around);
        continue;
      }
      if (!first.has(seed)) {
        // no build styles what is under an element of `display: none`
        if (above && !restyled?.has(above)) {
          if (tree.styles.has(seed)) gone.push(seed);
          continue;
        }
        if (hiding && !restyled?.has(hiding)) continue;
        // no box, before or after, where it was `display: none` or is new
        // and of a kind the UA never draws: styled where it is, and the
        // whole document built if it comes out drawn (`buildSubtrees`)
        const boxless =
          hiding ??
          (!tree.styles.has(seed) && UNDRAWN_TAGS.has(tagOf(seed))
            ? seed
            : null);
        if (boxless) {
          hidden.add(boxless);
          continue;
        }
      }
      const at = rootAround(seed);
      if (at) roots.add(at);
      else if (!tails || !parsed || !tailAround(seed)) return null;
    }
    const outermost = (set: ReadonlySet<Element>, also = set): Element[] => {
      const out: Element[] = [];
      for (const el of set) {
        let inner = false;
        for (let at = flatParentOf(el); at && !inner; at = flatParentOf(at)) {
          if (roots.has(at) || also.has(at)) inner = true;
        }
        // and none in a tail, which builds it
        if (!inner && !(tailed.size && inTail(el))) out.push(el);
      }
      return out;
    };
    // and a tail in a root's subtree is the root's, and one in another
    // tail's that tail's
    const keptTails: { node: ParentNode; from: number }[] = [];
    for (const [node, from] of atTails) {
      if (isElement(node)) {
        if (inTail(node as Element)) continue;
        let inRoot = false;
        for (
          let at: Element | null = node as Element;
          at && !inRoot;
          at = flatParentOf(at)
        ) {
          if (roots.has(at)) inRoot = true;
        }
        if (inRoot) continue;
      }
      keptTails.push({ node, from });
    }
    return {
      roots: outermost(roots),
      tails: keptTails,
      hidden: outermost(hidden),
      gone,
    };
  }

  /**
   * The cascade made again for sheets that may read otherwise
   * (`_sheetsOwed`), and the elements the rules they add can style
   * (`Cascade.addedReach`): where every sheet the cascade was made from is
   * still there, in its order, as it read or with rules after its last, and
   * nothing else changed that every style reads (`addedRules`) — every other
   * element is styled by the rules it was. Null where that cannot be said,
   * and every element is styled again; an empty set where the sheets read
   * as they did.
   */
  private _sheetsAdded(target: number, viewport: number): Set<Element> | null {
    const was = this._sheetsRead;
    const cascade = this._cascade;
    const tree = this._tree;
    const treesWere = this._shadowKeys;
    // a width that crossed a breakpoint as well, which the styles kept were
    // not computed at
    const band =
      !!cascade && cascade.mediaBand(target, viewport) === this._mediaBand;
    this._restyle(target);
    const now = this._sheetsRead;
    // A shadow tree bound to other rules than it was: all they style is in
    // its host. GitHub's `<tool-tip>` puts a `<style>` in its tree as it
    // connects, and the first of them styled the whole document.
    const rebound = new Set<Element>();
    for (const [root, key] of this._shadowKeys) {
      if ((treesWere.get(root) ?? '') !== key) {
        addFlatSubtree(root.host, rebound);
      }
    }
    if (this._cascade === cascade) return rebound;
    if (!was || !now || !tree || !band || this._styledWith !== cascade) {
      return null;
    }
    const added = addedRules(was, now);
    if (!added) return null;
    // the boxes it looks in for who runs a name
    if (added.keyframes.size && asideIn(tree)) return null;
    const reached = this._cascade!.addedReach(
      added.rules,
      this._source.document,
      !!tree.impliedHtml,
    );
    if (reached) {
      this._keptFor = this._cascade;
      if (added.keyframes.size) runningAny(tree, added.keyframes, reached);
      for (const el of rebound) reached.add(el);
    }
    return reached;
  }

  /**
   * Whether a change to a sheet's element — a `<style>`, a `<link>` — at
   * `at`, or one put in or taken away there, leaves the cascade as it is:
   * where it is in the document's tree and its sheets read as the
   * cascade's were read (`_sameSheets`, which
   * `_restyle` asks to keep the cascade). A `<link>` a script puts in for
   * a sheet that is not in yet is no change until the sheet comes, which
   * is one then (`ResourceStore._changed`): GitHub's chunks bring their CSS
   * modules so, five at a time. A shadow tree's sheets are bound to it by
   * how they read, and a `<meta>` or a `<base>` is no sheet: both are a
   * change to the cascade whatever they read.
   */
  private _sheetsKept(at: AnyNode, scope: ChangeScope): boolean {
    if (inShadowTree(at)) return false;
    scope.sheetsAsRead ??= this._sheetsAsRead();
    return scope.sheetsAsRead;
  }

  /** The sheets applied after the document's: the host's, and what the
   *  page registered (`setRegisteredProperties`). */
  private _extraSheets(extra: string | string[] | undefined): string[] {
    const extras = Array.isArray(extra) ? extra : extra ? [extra] : [];
    return this._registeredProperties
      ? [...extras, this._registeredProperties]
      : extras;
  }

  /** Whether the document's sheets read as the cascade's were read
   *  (`_sheetsKept`). */
  private _sheetsAsRead(): boolean {
    const kept = this._sheetsRead;
    if (!kept || kept.cascade !== this._cascade) return false;
    const extras = this._extraSheets(this._props().stylesheet);
    return this._sameSheets(
      kept,
      this._readSheets(this._source.facts().sheets),
      extras,
    );
  }

  /**
   * The changes `_changeScope` found restyled: in place where all that
   * changed is ink, in a frame's build where it is out of the flow, and in
   * a build keeping every other element's style otherwise.
   */
  private _restyleChanged(scope: ChangeScope): void {
    if (scope.drawings.size) this._drawAgain(scope.drawings);
    if (scope.stops && this._tree) {
      CANDIDATES.delete(this._tree);
      this._reportStops();
    }
    if (scope.sheets) {
      // what the new rules style is known once they are read, before the
      // build (`_sheetsAdded`)
      this._sheetsOwed = true;
      this._invalidate(
        Stale.Boxes,
        scope.own,
        true,
        seedsOf(scope),
        scope.tails ?? endsOf(scope),
        !!scope.tails,
        scope.always,
        Math.max(scope.pseudo, scope.treePseudo) as 0 | 1 | 2,
      );
      return;
    }
    if (!scope.boxes && scope.targets.size && this._tree) {
      // what went and drew nothing — a script, a hidden panel — takes its
      // style with it, as a build would, and so does what moved under an
      // element nothing draws, which a build styles no further into
      const tree = this._tree;
      const document = this._source.document;
      for (const el of scope.targets) {
        const parent = el.parent;
        if (
          !inDocument(el, document) ||
          (parent && isElement(parent) && undrawn(parent, tree))
        ) {
          forgetStyles(el, tree.styles);
        }
      }
    }
    if (!scope.own.size && !scope.boxes) return;
    if (!scope.boxes) {
      // the change's elements and all they hold, or where that is more than
      // a restyle in place takes, followed down from them: a `:has()` that
      // anchors at the root puts the root among them for a change to a
      // `<script>` in the head (`_restyleInPlace`'s `from`)
      const reach = withDescendants(scope.own, HOVER_RESTYLE_LIMIT);
      // what is laid out apart from all around it is built again and
      // repainted where it was and is (`_rebuildFrame`), where it cannot
      // be restyled here
      const apart =
        this._stale === Stale.Nothing &&
        !!this._tree &&
        this._laidOutWidth >= 0 &&
        laidOutApart(scope.own, this._tree);
      if (
        this._restyleInPlace(
          reach ?? EMPTY_SET,
          (el) => scope.own.has(el),
          scope.pseudo,
          HOVER_RESTYLE_LIMIT,
          reach ? null : scope.own,
          // a box's lengths, and not a text's size: a root's is every
          // `rem`'s, which a build follows (`_rootMoved`)
          BOX_LENGTHS,
        )
      ) {
        // a change of lengths alone keeps the boxes, and is laid out again
        if (this._resizedInPlace.length) this._layoutOwed(this._resizedInPlace);
        // a transition the change started wants its frames
        this._scheduleFrame();
        return;
      }
      if (apart) {
        this._rebuildFrame(scope.own, true);
        return;
      }
    }
    this._invalidate(
      Stale.Boxes,
      scope.own,
      true,
      seedsOf(scope),
      scope.tails ?? endsOf(scope),
      !!scope.tails,
      scope.always,
      Math.max(scope.pseudo, scope.treePseudo) as 0 | 1 | 2,
    );
  }

  /**
   * Inline drawings whose insides changed: what the rules give their
   * shapes is asked again at their next paint, the surfaces kept around
   * them are let go, and where nothing else is due to repaint the whole
   * element, what they draw is repainted.
   */
  private _drawAgain(drawings: ReadonlySet<Element>): void {
    const tree = this._tree;
    if (!tree) return;
    const boxes = this._firstBoxesOf(tree);
    const inks: Rect[] = [];
    for (const el of drawings) {
      const box = boxes.get(el);
      if (!box) continue;
      SHAPE_STYLES.delete(box);
      this._dropSprites(box, true);
      // a lifted box's pixels are its layer's, painted again in a frame
      if (this._lifted.size && this._insideLifted(box)) {
        this.spritesChanged();
        continue;
      }
      const ink = this._inkOf(box);
      if (ink) inks.push(ink);
    }
    if (this._stale === Stale.Nothing) this._repaintInk(inks);
  }

  /** The document's `<title>`, when it had one. */
  get title(): string | null {
    return this._source.facts().title;
  }

  /** A logical window point in document (device) coordinates, with the
   *  element's corner at `origin` (`_fixedShift`'s). */
  private _toDocument(
    x: number,
    y: number,
    origin: { x: number; y: number } = this.abs,
  ): { x: number; y: number } {
    const s = this._scale;
    return { x: x * s - origin.x, y: y * s - origin.y };
  }

  // --- scroll containers ---------------------------------------------------
  //
  // A box that clips what overflows it with an `overflow` that scrolls is
  // scrolled by moving what it holds (`layout/scroll.ts`), so everything
  // that reads a box finds it where it is drawn. A scroll here moves the
  // boxes by the difference, works out the ink again, repaints the
  // scrollport and tells what is mounted beside the document where its
  // element went; a layout moves the boxes it lays out by the offsets kept
  // here.

  /**
   * Where a scroll container is scrolled to, how far it can be and its
   * scrollport — `scrollTop`, `scrollHeight`, `clientHeight` and their
   * kin, in CSS pixels — laid out first; null for an element that is no
   * scroll container, or has no box.
   */
  /** The pipeline brought up to date at the width the document is drawn
   *  at, for a reader of where the viewport is scrolled
   *  (`HandleInternals.layoutNow`). */
  layoutNow(): void {
    this._prepare(this.abs.width || 1);
  }

  /**
   * A page's script was stopped by its engine's watchdog inside something
   * it asked of the document (`HandleInternals.interrupted`): a style, a
   * layout, cut half way through, every `finally` under it skipped. So
   * nothing is gone on from that it may have left half made — the flags a
   * `finally` puts back, the cascade, whose `timeline` and `stylesOf` a cut
   * leaves a fork's, and the boxes laid out from them — and the next layout
   * styles, builds and lays the document out from nothing, as the first
   * did. Rare: the engine begins no op so near its ceiling that one as long
   * as a page's time is cut (`ScriptEngine._bridge`).
   */
  interrupted(): void {
    this._timing = false;
    this._measuring = false;
    this._painting = false;
    this._followingLifted = false;
    this._carryingFrom = null;
    this._scripts.until = Infinity;
    // a cascade made again, which a sheet that reads as it did keeps
    this._sheetsRead = null;
    this._invalidate(Stale.Style);
  }

  /**
   * What the boxes were laid out and scrolled as, as a key: one that moves
   * with every invalidation, layout, restyle in place, frame and scroll of
   * a box in the document, and with the pane's scroll and the element's
   * size — and a new one at each ask while a change waits to be laid out.
   * A look of a page's observers that finds it as it was finds what the
   * last one found (`geometry`): a `ResizeObserver` measured every target
   * ten times a second for as long as it was open, most of what a webmail
   * page at rest cost.
   */
  geometryKey(): string {
    if (this._stale !== Stale.Nothing) return `owed ${++this._geometry}`;
    const at = this._scrolledOrigin();
    return `${this._geometry} ${at.x},${at.y} ${this.abs.width}x${this.abs.height} ${this._viewportHeight()}`;
  }

  /** Moved by everything `geometryKey` follows. */
  private _geometry = 0;

  scrollStateOf(element: Element): ScrollState | null {
    this._prepare(this.abs.width || 1);
    let box = this._scrollerOf(element);
    if (!box) return null;
    // how far what it holds reaches, where what it holds waits: a handler
    // that reads `scrollTop` of what holds none of it settles nothing
    if (this._owes(box)) {
      this._settle();
      box = this._scrollerOf(element);
      if (!box) return null;
    }
    const state = scrollStateOf(box);
    const s = this._scale;
    return {
      x: state.x / s,
      y: state.y / s,
      width: state.width / s,
      height: state.height / s,
      clientWidth: state.clientWidth / s,
      clientHeight: state.clientHeight / s,
      clientTop: state.clientTop / s,
      clientLeft: state.clientLeft / s,
    };
  }

  /**
   * An element's padding box, as `clientWidth`, `clientHeight`,
   * `clientTop` and `clientLeft` read it where it is no scroll container
   * (CSSOM View 6): its size, and its border's widths at the top and the
   * left, in CSS pixels, laid out first. Null for an element with no box,
   * and for one whose box is inline, which has no client box.
   */
  clientBoxOf(
    element: Element,
  ): { width: number; height: number; top: number; left: number } | null {
    this._settle();
    const tree = this._tree;
    const box = tree ? this._ownBoxOf(tree, element) : null;
    if (!box || box.kind === 'inline') return null;
    const s = this._scale;
    return {
      width: Math.max(0, box.width - box.borderLeft - box.borderRight) / s,
      height:
        Math.max(
          0,
          box.height -
            box.captionTop -
            box.captionBottom -
            box.borderTop -
            box.borderBottom,
        ) / s,
      top: box.borderTop / s,
      left: box.borderLeft / s,
    };
  }

  /**
   * Whether an element is drawn, as a script's `checkVisibility` asks
   * (CSSOM View 6.1), laid out first: it has a box — which nothing under
   * `display: none` has, nor a `display: contents` element, nor what a
   * `content-visibility: hidden` box holds — and where `asks.opacity`,
   * neither it nor an element around it in the flat tree is at an opacity
   * of 0, and where `asks.visibility`, it is visible. Its style is the one
   * it has at this moment, where an animation runs on it. Nothing here
   * skips what `content-visibility: auto` holds, so an option to ask that
   * finds nothing to refuse.
   */
  checkVisibility(
    element: Element,
    asks: { opacity: boolean; visibility: boolean },
  ): boolean {
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    const style = this._styledNow(element);
    if (!tree || !style || !this._ownBoxOf(tree, element)) return false;
    if (asks.visibility && style.visibility !== 'visible') return false;
    if (asks.opacity) {
      for (let at: Element | null = element; at; at = flatParentOf(at)) {
        if (this._styledNow(at)?.opacity === 0) return false;
      }
    }
    return true;
  }

  /**
   * Whether a scroll container's scroll moves an element: its box is in
   * the container's and positioned against nothing outside it
   * (`scrollMoves`), laid out first as `scrollStateOf` is. What a
   * script's `scrollIntoView` asks of each scroll container around an
   * element before it scrolls it. False for an element with no box, and
   * for one that is no scroll container.
   */
  scrollMoves(scroller: Element, element: Element): boolean {
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    const port = this._scrollerOf(scroller);
    const box = tree ? this._boxOf(tree, element) : null;
    return !!port && !!box && scrollMoves(port, box);
  }

  /**
   * Scroll a scroll container to an offset, in CSS pixels, kept within how
   * far it can be — as `scrollTop` is set, or `scrollTo` called — laid out
   * first. Answers where it came to, or null for an element that is no
   * scroll container.
   */
  scrollElementTo(
    element: Element,
    to: { x?: number; y?: number },
    /** A relative scroll — `scrollBy()` — which snaps in the direction it
     *  moved (`snapTo`'s `from`). */
    relative = false,
    /** The element a scroll brings into view — `scrollIntoView()`'s, a
     *  fragment's, the focus's — which a snap container lines up as its
     *  `scroll-snap-align` says where it is one of its areas, and a
     *  container that does not snap too (`lineUp`). */
    target: Element | null = null,
  ): ScrollOffset | null {
    this._settle();
    const box = this._scrollerOf(element);
    if (!box) return null;
    const state = scrollStateOf(box);
    const s = this._scale;
    const at = this._snapScroll(
      box,
      (to.x ?? state.x / s) * s,
      (to.y ?? state.y / s) * s,
      relative ? { from: { x: state.x, y: state.y } } : {},
      target,
    );
    // a scroll into view of what the container shows as it is moves
    // nothing, and costs nothing
    if (Math.abs(at.x - state.x) < 0.5 && Math.abs(at.y - state.y) < 0.5) {
      return { x: state.x / s, y: state.y / s };
    }
    return this._scrollBox(box, at.x / s, at.y / s);
  }

  /**
   * Where a scroll of a scroll container to `x`, `y`, in device pixels,
   * comes to rest: where `snapTo` says in a snap container, which notes
   * what it lined up, or with `target` lined up (`lineUp`); and where it
   * was asked to be in one that does not snap, but where it brings an area
   * into view, which it lines up.
   */
  private _snapScroll(
    box: Box,
    x: number,
    y: number,
    scroll: SnapScroll,
    target: Element | null = null,
  ): { x: number; y: number } {
    const aim = this._targetBox(target);
    const snap = box.style.scrollSnapType && this._snapContainerOf(box);
    if (snap && box.el) {
      const at = aim ? lineUp(snap, aim, x, y) : snapTo(snap, x, y, scroll);
      this._snapped.set(box.el, {
        x: snapKey(at.targetX),
        y: snapKey(at.targetY),
      });
      return at;
    }
    const lone = aim && this._snapContainerOf(box, aim);
    return lone ? lineUp(lone, aim, x, y) : { x, y };
  }

  /** The first box of the element a scroll brings into view, which is the
   *  snap area it lines up where it is one. */
  private _targetBox(target: Element | null): Box | null {
    const tree = this._tree;
    return target && tree
      ? (this._firstBoxesOf(tree).get(target) ?? null)
      : null;
  }

  // --- scroll snapping (CSS Scroll Snap 1, `layout/snap.ts`) ---------------
  //
  // A script's scroll of a snap container — a scroll container in the
  // document, or the viewport — comes to rest where `snapTo` says, and the
  // area it lines up on each axis is noted by its element, so that a layout
  // that moves it scrolls the container to it again (`_resnap`). A scroll
  // key snaps as it scrolls, by a page within a snapport where it can, and
  // the wheel once it has rested on a container — or on the viewport, which
  // takes the wheel itself where the root snaps (`canScroll`) — for
  // `WHEEL_SNAP_MS`, each in the direction it went from where it started
  // (`_snapUserScroll`). A scroll that brings an area into view lines it up
  // (`lineUp`), in a container that snaps or not.

  /** The area each snap container was last snapped to on each axis, by
   *  the container's element, and the viewport's by the document. */
  private _snapped = new Map<
    Element | Document,
    { x: SnapKey | null; y: SnapKey | null }
  >();

  /** A scroll container's snap container: its snap areas, where each is
   *  at no scroll from its scrollport's corner, and its scrollport. With
   *  `only`, a container of that box's area alone, whether or not it
   *  snaps — what lines a scroll's target up where it does not — or null
   *  where the box is no area of the container's. */
  private _snapContainerOf(box: Box, only?: Box): SnapContainer | null {
    if (!only && !box.style.scrollSnapType) return null;
    const state = scrollStateOf(box);
    const left = box.x + box.borderLeft;
    const top = box.y + box.borderTop;
    const at = (child: Box) =>
      scrollMoves(box, child)
        ? { x: child.x - left + state.x, y: child.y - top + state.y }
        : null;
    const areas = only ? areaIn(box, only, at) : snapAreasIn(box, at);
    if (!areas) return null;
    return {
      style: box.style,
      areas,
      width: state.clientWidth,
      height: state.clientHeight,
      maxX: state.width - state.clientWidth,
      maxY: state.height - state.clientHeight,
      focused: this._snapFocused,
      targeted: this._snapTargeted,
    };
  }

  /** Whether a snap area is the focused element or holds it: the first a
   *  snap prefers where several line up (CSS Scroll Snap 1, "selecting
   *  between multiple aligned snap areas"), and what a re-snap keeps. */
  private _snapFocused = (box: Box): boolean =>
    !!box.el && this._focus.within.has(box.el);

  /** The same of the URL's target, which comes after the focus. */
  private _snapTargeted = (box: Box): boolean => {
    const el = box.el;
    if (!el) return false;
    for (let at = this._target; at; at = flatParentOf(at)) {
      if (at === el) return true;
    }
    return false;
  };

  /** The root element's box, under the tree's anonymous root, where the
   *  root's style is the viewport's `scroll-snap-type` and
   *  `scroll-padding`. */
  private _rootBox(): Box | null {
    const root = this._tree?.root;
    return (
      (root?.el
        ? root
        : root?.children.find((c) => c.el && tagOf(c.el) === 'html')) ?? null
    );
  }

  /** The viewport's snap container: the root's `scroll-snap-type`, and the
   *  areas no scroll container in the document holds, at their places in
   *  the document; null where the root's snaps on no axis or nothing
   *  scrolls the document. With `only`, that box's area alone, as
   *  `_snapContainerOf` makes it. */
  private _viewportSnap(only?: Box): SnapContainer | null {
    const tree = this._tree;
    const root = tree?.root;
    const style = this._rootBox()?.style;
    const port = this._viewport();
    if (!tree || !root || !style || !port) return null;
    if (!only && !style.scrollSnapType) return null;
    const at = (child: Box) =>
      fixedToViewport(child) ? null : { x: child.x, y: child.y };
    const areas = only ? areaIn(root, only, at) : snapAreasIn(root, at);
    if (!areas) return null;
    return {
      style,
      areas,
      width: port.width,
      height: port.height,
      maxX: Math.max(0, this._documentWidth - port.width),
      maxY: Math.max(0, this._documentHeight - port.height),
      focused: this._snapFocused,
      targeted: this._snapTargeted,
    };
  }

  /**
   * The CSS animations under way on an element, or on what it holds as
   * well — or every one in the document for null — as a page's
   * `getAnimations()` lists them (CSS Animations 2, 4): each its element and
   * pseudo-element, its name and place in its `animation-name` list, its
   * timing and play state, its timeline — the clock's, a scroll's, a
   * subject's view, or none — and range, and where its time is on the
   * clock's. Keyed by its run, which a page's `CSSAnimation` is kept by.
   */
  /**
   * A CSS animation's keyframes as `getKeyframes()` lists them (CSS
   * Animations 2, 4.3): its `@keyframes`' frames in order of offset, each
   * with its easing — `ease` where it gives none — and its properties'
   * values as written, frames at one offset and of one easing merged, the
   * later's values over the earlier's; and where the rule has no frame at
   * 0 or at 1, one made of the values the element has there, which the
   * animation runs from or to (`composite: 'replace'`). Of the element's
   * own animation, its `::before`'s or `::after`'s, or a view transition's
   * pseudo-element's (`pseudo`, '' for its own); null where there is none.
   */
  cssKeyframesOf(
    element: Element,
    pseudo: string,
    name: string,
  ):
    | {
        offset: number;
        easing: string;
        composite: 'auto' | 'replace';
        values: Record<string, string>;
      }[]
    | null {
    this._prepare(this.abs.width || 1);
    const cascade = this._cascade;
    const rule = cascade?.keyframes(name) ?? null;
    if (!rule) return null;
    const frames: {
      offset: number;
      easing: string;
      composite: 'auto' | 'replace';
      values: Record<string, string>;
    }[] = [];
    const animated = new Set<string>();
    for (const frame of rule.frames) {
      const easing = frame.easing ?? 'ease';
      for (const offset of frame.offsets) {
        let into = frames.find(
          (f) => f.offset === offset && f.easing === easing,
        );
        if (!into) {
          into = { offset, easing, composite: 'auto', values: {} };
          frames.push(into);
        }
        for (const d of frame.declarations) {
          into.values[d.prop] = d.value;
          animated.add(d.prop);
        }
      }
    }
    frames.sort((a, b) => a.offset - b.offset);
    // the values it runs from and to where the rule has no frame there:
    // the style under its animations
    const record = this._underlyingRecord(element, pseudo) ?? {};
    const underlying = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const prop of animated) {
        if (record[prop] !== undefined) out[prop] = record[prop];
      }
      return out;
    };
    if (!frames.some((f) => f.offset === 0)) {
      frames.unshift({
        offset: 0,
        easing: 'ease',
        composite: 'replace',
        values: underlying(),
      });
    }
    if (!frames.some((f) => f.offset === 1)) {
      frames.push({
        offset: 1,
        easing: 'ease',
        composite: 'replace',
        values: underlying(),
      });
    }
    return frames;
  }

  /** An element's style under its animations, or a view transition's
   *  pseudo-element's, as `getComputedStyle` writes it: its `::before`'s
   *  and `::after`'s as they are drawn. Null where it has none. */
  private _underlyingRecord(
    element: Element,
    pseudo: string,
  ): Record<string, string> | null {
    const tree = this._tree;
    const cascade = this._cascade;
    if (!tree || !cascade) return null;
    if (pseudo.startsWith('view-transition')) {
      const how = this._vt?.styled.get(pseudo);
      if (!how) return this.computedStyle(element, pseudo);
      const style = cascade.transitionStyle(
        element,
        how.part,
        how.name,
        how.classes,
        how.onlyChild,
        how.parent,
        how.dynamic,
        this._vt!.timeline,
        pseudo,
        true,
      );
      return cssomStyle(style, this._scale, null);
    }
    if (pseudo) return this.computedStyle(element, pseudo);
    const parent = flatParentOf(element);
    const parentStyle =
      (parent && isElement(parent) ? tree.styles.get(parent)?.style : null) ??
      tree.root.style;
    const style = cascade.underlyingStyleFor(
      element,
      parentStyle,
      parentStyle.display === 'flex' || parentStyle.display === 'inline-flex',
    );
    return cssomStyle(style, this._scale, null);
  }

  cssAnimationsOf(
    element: Element | null,
    subtree: boolean,
  ): CssAnimationInfo[] {
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree || !this._animating()) return [];
    const s = this._scale;
    const within = (el: Element): boolean => {
      if (!element || el === element) return true;
      if (!subtree) return false;
      for (let at: Element | null = el; at;) {
        if (at === element) return true;
        const parent = flatParentOf(at);
        at = parent && isElement(parent) ? parent : null;
      }
      return false;
    };
    const lenText = (len: Len): string => {
      if (typeof len === 'number') return `${len / s}px`;
      if (!len || typeof len !== 'object' || !('pct' in len)) return '0%';
      const { pct, px } = len as { pct: number; px?: number };
      if (!px) return `${pct}%`;
      return `calc(${pct}% ${px < 0 ? '-' : '+'} ${Math.abs(px) / s}px)`;
    };
    const edgeText = (
      edge: { name: string | null; offset: Len } | undefined,
      end: boolean,
    ): string => {
      if (!edge || edge === (end ? RANGE_END : RANGE_START)) return 'normal';
      const offset = lenText(edge.offset);
      if (edge.name === null) {
        return offset === (end ? '100%' : '0%') ? 'normal' : offset;
      }
      return `${edge.name} ${offset}`;
    };
    const out: CssAnimationInfo[] = [];
    const boxes = this._firstBoxesOf(tree);
    // in their composite order: their elements' tree order, an element
    // before its `::marker`, `::before` and `::after`, and then their
    // place in `animation-name` (CSS Animations 2, 4.1)
    const order = new Map<object, number>();
    for (const el of tree.styles.keys()) order.set(el, order.size);
    const PSEUDO_ORDER = ['', 'marker', 'before', 'after'];
    const listed = this._timeline
      .cssAnimations()
      .sort(
        (x, y) =>
          (order.get(x.el) ?? 0) - (order.get(y.el) ?? 0) ||
          PSEUDO_ORDER.indexOf(x.pseudo) - PSEUDO_ORDER.indexOf(y.pseudo) ||
          x.index - y.index,
      )
      .map((a) => ({ ...a, timeline: this._timeline }));
    // and a view transition's tree's, on its own timeline, in the order
    // its boxes are (CSS View Transitions 1, 3.4), by their keys
    const transitionBoxes = new Map<string, Box>();
    const vt = this._vt;
    if (vt?.phase === 'live') {
      for (const top of topLayerBoxes(tree.root)) {
        if (top.pseudo !== 'view-transition') continue;
        const stack = [top];
        while (stack.length) {
          const box = stack.pop()!;
          const key = TRANSITION_KEYS.get(box);
          if (key) transitionBoxes.set(key, box);
          for (let i = box.children.length - 1; i >= 0; i -= 1) {
            stack.push(box.children[i]);
          }
        }
      }
      const keys = [...transitionBoxes.keys()];
      listed.push(
        ...vt.timeline
          .cssAnimations()
          .filter((a) => transitionBoxes.has(a.pseudo))
          .sort(
            (x, y) =>
              keys.indexOf(x.pseudo) - keys.indexOf(y.pseudo) ||
              x.index - y.index,
          )
          .map((a) => ({ ...a, timeline: vt.timeline })),
      );
    }
    for (const a of listed) {
      const el = a.el as Element;
      if (!within(el)) continue;
      // the style the animation is of: the element's, its `::before`'s or
      // `::after`'s, or a box of a view transition's tree
      const style =
        a.pseudo === ''
          ? tree.styles.get(el)?.style
          : a.pseudo === 'before' || a.pseudo === 'after'
            ? this._pseudoBoxOf(tree, el, a.pseudo)?.style
            : transitionBoxes.get(a.pseudo)?.style;
      if (!style) continue;
      const lists = style.animations;
      const i = a.index;
      const at = <T>(list: readonly T[]): T => list[i % list.length];
      const timing = timingAt(lists, i);
      const ref = style.animationTimeline.length
        ? at(style.animationTimeline)
        : ({ kind: 'auto' } as TimelineRef);
      let timeline: CssAnimationInfo['timeline'] = { kind: 'document' };
      if (ref.kind === 'none') timeline = { kind: 'none' };
      else if (ref.kind === 'scroll') {
        const box = boxes.get(el);
        const scroller =
          ref.scroller === 'self'
            ? el
            : ref.scroller === 'root' || !box
              ? null
              : (nearestScroller(box)?.el ?? null);
        timeline = { kind: 'scroll', source: scroller, axis: ref.axis };
      } else if (ref.kind === 'view') {
        timeline = {
          kind: 'view',
          subject: el,
          axis: ref.axis,
          inset: ref.inset.map((v) => (v === 'auto' ? 'auto' : lenText(v))),
        };
      } else if (ref.kind === 'name') {
        const named = namedTimeline(tree, el, ref.name);
        timeline = !named
          ? { kind: 'none' }
          : named.view
            ? {
                kind: 'view',
                subject: named.el,
                axis: named.axis,
                inset: named.inset.map((v) =>
                  v === 'auto' ? 'auto' : lenText(v),
                ),
              }
            : { kind: 'scroll', source: named.el, axis: named.axis };
      }
      const now = a.timeline.now;
      out.push({
        key: a.key,
        element: el,
        pseudo: a.pseudo ? `::${a.pseudo}` : '',
        name: a.name,
        index: i,
        duration: timing.auto ? 'auto' : timing.duration,
        delay: timing.delay,
        iterations: timing.iterations,
        direction: timing.direction,
        fill: timing.fill,
        easing: easingText(at(lists.easings)),
        paused: at(lists.playStates) === 'paused' || !!a.run.pagePaused,
        ...(a.run.pageCancelled ? { cancelled: true } : null),
        currentTime: a.run.hold ?? now - a.run.start,
        // on a scroll's, where the scroll has it
        ...(timeline.kind === 'scroll' || timeline.kind === 'view'
          ? {
              scroll: {
                at: a.run.scroll?.at ?? null,
                start: a.run.scroll?.start ?? null,
                rate: a.run.scroll?.rate ?? 1,
              },
            }
          : null),
        timeline,
        rangeStart: edgeText(
          style.animationRangeStart[i % style.animationRangeStart.length],
          false,
        ),
        rangeEnd: edgeText(
          style.animationRangeEnd[i % style.animationRangeEnd.length],
          true,
        ),
      });
    }
    return out;
  }

  /** The CSS transitions under way on an element, or on what it holds as
   *  well, or in the whole document for null, in their composite order:
   *  their elements' tree order, an element before its pseudo-elements,
   *  the order they were made in and then their properties' names (CSS
   *  Transitions 2, 4.1). */
  cssTransitionsOf(
    element: Element | null,
    subtree: boolean,
  ): CssTransitionInfo[] {
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree) return [];
    const order = new Map<object, number>();
    for (const el of tree.styles.keys()) order.set(el, order.size);
    const PSEUDO_ORDER = ['', 'marker', 'before', 'after'];
    const within = (el: Element): boolean => {
      if (!element || el === element) return true;
      if (!subtree) return false;
      for (let at: Element | null = el; at;) {
        if (at === element) return true;
        const parent = flatParentOf(at);
        at = parent && isElement(parent) ? parent : null;
      }
      return false;
    };
    const now = this._timeline.now;
    return this._timeline
      .cssTransitions()
      .filter(
        (t) =>
          order.has(t.el) &&
          PSEUDO_ORDER.includes(t.pseudo) &&
          within(t.el as Element),
      )
      .sort(
        (x, y) =>
          order.get(x.el)! - order.get(y.el)! ||
          PSEUDO_ORDER.indexOf(x.pseudo) - PSEUDO_ORDER.indexOf(y.pseudo) ||
          x.run.serial - y.run.serial ||
          (x.run.property < y.run.property ? -1 : 1),
      )
      .map(({ el, pseudo, run, key }) => ({
        key,
        element: el as Element,
        pseudo: pseudo ? `::${pseudo}` : '',
        property: run.property,
        duration: run.duration,
        delay: run.start - run.created,
        easing: easingText(run.easing),
        // waiting for the paint that first shows it, it has not begun
        currentTime: run.pending ? 0 : now - run.created,
      }));
  }

  /**
   * Where a script's scroll of the viewport to `x`, `y`, in CSS pixels,
   * comes to rest where the root makes it a snap container — noted as the
   * viewport's snap — and where it was asked to be where not; with
   * `target`, the element it brings into view, lined up where it is an
   * area of the viewport's (`lineUp`), whether or not the root snaps.
   */
  snapViewport(
    x: number,
    y: number,
    target: Element | null = null,
    /** A relative scroll — `scrollBy()` — which snaps the way it went
     *  from where the pane is. */
    relative = false,
  ): { x: number; y: number } {
    this._prepare(this.abs.width || 1);
    const s = this._scale;
    const pane = relative ? this._pane() : null;
    const at = this._snapViewportAt(
      x * s,
      y * s,
      pane ? { from: { x: pane.scrollX, y: pane.scrollY } } : {},
      target,
    );
    return { x: at.x / s, y: at.y / s };
  }

  /** `snapViewport` in device pixels, for a scroll of any kind. */
  private _snapViewportAt(
    x: number,
    y: number,
    scroll: SnapScroll,
    target: Element | null = null,
  ): { x: number; y: number } {
    const aim = this._targetBox(target);
    const snap = this._viewportSnap();
    if (snap) {
      const at = aim ? lineUp(snap, aim, x, y) : snapTo(snap, x, y, scroll);
      this._noteViewportSnap(at);
      return at;
    }
    const lone = aim && this._viewportSnap(aim);
    return lone ? lineUp(lone, aim, x, y) : { x, y };
  }

  /** What the viewport was snapped to, as `_snapped` keeps it. */
  private _noteViewportSnap(at: Snapped): void {
    this._snapped.set(this._source.document, {
      x: snapKey(at.targetX),
      y: snapKey(at.targetY),
    });
  }

  /** After a layout: each snap container snapped to an area lined up with
   *  it again where the layout moved it, and a `mandatory` one no script
   *  has scrolled snapped where it is. */
  private _resnap(lostOnly = false): void {
    const tree = this._tree;
    if (!tree || !this._cascade?.snaps) return;
    const s = this._scale;
    // after a restyle that laid nothing out, only a container whose area
    // is no snap position now moves
    const lost = (
      snap: SnapContainer,
      keys: { x: SnapKey | null; y: SnapKey | null },
      x: number,
      y: number,
    ): boolean =>
      (['x', 'y'] as const).some((axis) => {
        const key = keys[axis];
        if (!key) return false;
        const box = snapBox(snap, key);
        return !box || !linesUp(snap, box, axis, axis === 'x' ? y : x);
      });
    for (const [el, keys] of this._snapped) {
      if (el === this._source.document) {
        const snap = this._viewportSnap();
        const pane = this._pane();
        if (!snap || !pane) continue;
        if (lostOnly && !lost(snap, keys, pane.scrollX, pane.scrollY)) {
          continue;
        }
        // the pane's offsets are device pixels, as the boxes are
        const at = resnap(snap, pane.scrollX, pane.scrollY, {
          x: snapBox(snap, keys.x),
          y: snapBox(snap, keys.y),
        });
        this._noteViewportSnap(at);
        this._scrollPaneTo(pane, at.x, at.y);
        continue;
      }
      const box = this._scrollerOf(el as Element);
      const snap = box && this._snapContainerOf(box);
      if (!box || !snap) continue;
      const state = scrollStateOf(box);
      if (lostOnly && !lost(snap, keys, state.x, state.y)) continue;
      const at = resnap(snap, state.x, state.y, {
        x: snapBox(snap, keys.x),
        y: snapBox(snap, keys.y),
      });
      this._snapped.set(el, { x: snapKey(at.targetX), y: snapKey(at.targetY) });
      if (Math.abs(at.x - state.x) >= 0.5 || Math.abs(at.y - state.y) >= 0.5) {
        this._scrollBox(box, at.x / s, at.y / s);
      }
    }
    // a mandatory container must be at rest at a snap position, whether or
    // not a script scrolled it — the viewport too, where the root is one
    if (lostOnly) return;
    const doc = this._source.document;
    const viewport = this._snapped.has(doc) ? null : this._viewportSnap();
    const pane = viewport?.style.scrollSnapType?.mandatory && this._pane();
    if (viewport && pane) {
      const at = snapTo(viewport, pane.scrollX, pane.scrollY);
      this._noteViewportSnap(at);
      this._scrollPaneTo(pane, at.x, at.y);
    }
    for (const box of snapContainersIn(tree.root)) {
      const el = box.el!;
      if (this._snapped.has(el) || !box.style.scrollSnapType!.mandatory) {
        continue;
      }
      const snap = this._snapContainerOf(box);
      if (!snap) continue;
      const state = scrollStateOf(box);
      const at = snapTo(snap, state.x, state.y);
      this._snapped.set(el, { x: snapKey(at.targetX), y: snapKey(at.targetY) });
      if (Math.abs(at.x - state.x) >= 0.5 || Math.abs(at.y - state.y) >= 0.5) {
        this._scrollBox(box, at.x / s, at.y / s);
      }
    }
  }

  /**
   * Scroll the pane to where the viewport snapped, in device pixels. A
   * layout that moved an area down the document grew it too, and the pane
   * learns how far it reaches only in the pass the layout is in, so where
   * it cannot reach the place yet it is asked again once the frame is
   * over, as `_anchorFrame` ends a frame.
   */
  private _scrollPaneTo(pane: ScrollPane, x: number, y: number): void {
    if (Math.abs(x - pane.scrollX) < 0.5 && Math.abs(y - pane.scrollY) < 0.5) {
      return;
    }
    const s = this._scale;
    pane.scrollTo({ x: x / s, y: y / s });
    if (Math.abs(x - pane.scrollX) < 0.5 && Math.abs(y - pane.scrollY) < 0.5) {
      return;
    }
    const again = () => {
      if (this._pane() === pane) pane.scrollTo({ x: x / s, y: y / s });
    };
    if (timers.queueMicrotask) timers.queueMicrotask(again);
    else void Promise.resolve().then(again);
  }

  /** The wheel turned at a logical window point: what `canScroll` finds a
   *  scroll container under (`<Html>`'s `onWheelCapture`). */
  wheelAt(point: { x: number; y: number } | null): void {
    this._wheelAt = point;
  }

  /**
   * Core's wheel asks each node out from the one under the pointer whether
   * it has room to move on the axis a delta names, and scrolls the first
   * that does: this element does where a scroll container under the
   * pointer can move that way, the innermost first, and the box around the
   * document has its turn where none can — a list scrolled to its end
   * hands the wheel on to the page, as a browser's does. Where the root
   * makes the viewport a snap container, the element scrolls the pane
   * itself, so that it snaps once the wheel rests (`_viewportWheel`).
   */
  canScroll(dx: number, dy: number): boolean {
    return this._wheelScroller(dx, dy) !== null || this._viewportWheel(dx, dy);
  }

  /** Scroll the scroll container `canScroll` found, by logical pixels. */
  scrollBy(by: { x?: number; y?: number }): void {
    const box = this._wheelScroller(by.x ?? 0, by.y ?? 0);
    if (!box) {
      this._wheelViewport(by);
      return;
    }
    const state = scrollStateOf(box);
    const s = this._scale;
    // a snap container snaps once the wheel has rested on it, in the
    // direction it went from where it was when the wheel began
    if (box.style.scrollSnapType && box.el) {
      this._armWheelSnap(box, state.x, state.y);
    }
    this._scrollBox(
      box,
      state.x / s + (wheelScrolls(box, 'x') ? (by.x ?? 0) : 0),
      state.y / s + (wheelScrolls(box, 'y') ? (by.y ?? 0) : 0),
    );
  }

  /** The wheel turned on a snap container — null for the viewport — that
   *  was at `x`, `y`: it snaps once the wheel has rested on it for
   *  `WHEEL_SNAP_MS`, from where it was when the wheel began. */
  private _armWheelSnap(box: Box | null, x: number, y: number): void {
    const gesture = this._wheelGesture;
    if (gesture && gesture.box === box) {
      snapClock.disarm(gesture.timer);
      gesture.timer = snapClock.arm(
        () => this._snapUserScroll(),
        WHEEL_SNAP_MS,
      );
      return;
    }
    if (gesture) snapClock.disarm(gesture.timer);
    this._wheelGesture = {
      box,
      from: { x, y },
      timer: snapClock.arm(() => this._snapUserScroll(), WHEEL_SNAP_MS),
    };
  }

  /**
   * Whether the wheel scrolls the viewport here: where the root makes it a
   * snap container and the pane around the document can move the way a
   * delta goes — and the root lets it be scrolled on the axis. A document
   * whose root does not snap leaves the pane its own wheel.
   */
  private _viewportWheel(dx: number, dy: number): boolean {
    if (!this._rootBox()?.style.scrollSnapType) return false;
    const pane = this._pane();
    if (!pane) return false;
    const overflow = this._tree?.viewportOverflow;
    const box = pane.contentBox();
    const room = (at: number, content: number, client: number, d: number) =>
      d > 0 ? at < content - client - 0.5 : d < 0 ? at > 0.5 : false;
    return (
      (overflow?.x !== 'hidden' &&
        room(pane.scrollX, pane.contentWidth, box.width, dx)) ||
      (overflow?.y !== 'hidden' &&
        room(pane.scrollY, pane.contentHeight, box.height, dy))
    );
  }

  /** The wheel's scroll of the viewport `_viewportWheel` let it have, by
   *  logical pixels: the pane moved, to snap once the wheel rests. */
  private _wheelViewport(by: { x?: number; y?: number }): void {
    const pane = this._pane();
    if (!pane || !this._viewportWheel(by.x ?? 0, by.y ?? 0)) return;
    const s = this._scale;
    const overflow = this._tree?.viewportOverflow;
    this._armWheelSnap(null, pane.scrollX, pane.scrollY);
    pane.scrollTo({
      x: pane.scrollX / s + (overflow?.x !== 'hidden' ? (by.x ?? 0) : 0),
      y: pane.scrollY / s + (overflow?.y !== 'hidden' ? (by.y ?? 0) : 0),
    });
  }

  /** The wheel's scroll of a snap container, until it rests: where the
   *  container was when it began, and which — null for the viewport. */
  private _wheelGesture: {
    box: Box | null;
    from: { x: number; y: number };
    timer: unknown;
  } | null = null;

  /** The wheel rested on a snap container: it comes to rest where the
   *  snap points ahead of where the gesture began say. */
  private _snapUserScroll(): void {
    const gesture = this._wheelGesture;
    this._wheelGesture = null;
    if (!gesture || !this._tree) return;
    const s = this._scale;
    const from = { from: gesture.from };
    if (!gesture.box) {
      const pane = this._pane();
      if (!pane) return;
      const at = this._snapViewportAt(pane.scrollX, pane.scrollY, from);
      pane.scrollTo({ x: at.x / s, y: at.y / s });
      return;
    }
    const el = gesture.box.el;
    if (!el || this._scrollerOf(el) !== gesture.box) return;
    const state = scrollStateOf(gesture.box);
    const at = this._snapScroll(gesture.box, state.x, state.y, from);
    this._scrollBox(gesture.box, at.x / s, at.y / s);
  }

  /** A press at a logical window point: where the scroll keys start from
   *  until the focus is somewhere of the document's (`scrollForKey`). */
  pressedAt(x: number, y: number): void {
    this._pressed = this._drawnAt(x, y);
  }
  private _pressed: Element | null = null;

  /**
   * A scroll key, pressed with the focus on the document or on one of its
   * links: scroll the innermost container around `from` — the element the
   * focus is on, or else the one last pressed — that the user may scroll
   * on the axis and that can move that way, and on out to the pane around
   * the document, as a browser chains the keys. A line is 40 CSS pixels
   * and a page seven eighths of the scrollport, as Chrome has them, and
   * `end` goes to the end. Answers whether anything scrolled. The pane is
   * left alone where the document's root gave the viewport `overflow:
   * hidden` on the axis.
   *
   * A snap container — the viewport too, where the root snaps — comes to
   * rest at a snap position the key's way (`snapTo`): a line or a page is
   * a relative scroll, from where it was, and a page takes a place within
   * a snapport before any farther, so that it skips no area; `end` is an
   * absolute one, to the place nearest the end.
   */
  scrollForKey(
    axis: 'x' | 'y',
    how: 'line' | 'page' | 'end',
    sign: 1 | -1,
    from: Element | null,
  ): boolean {
    this._prepare(this.abs.width || 1);
    const s = this._scale;
    const step = (at: number, max: number, client: number): number => {
      const by =
        how === 'line' ? 40 : how === 'page' ? client * 0.875 : Infinity;
      return Math.min(max, Math.max(0, at + sign * by));
    };
    // how a key's scroll snaps, from where it was, in device pixels
    const scroll = (x: number, y: number): SnapScroll =>
      how === 'end' ? {} : { from: { x, y }, page: how === 'page' };
    for (let el = from ?? this._pressed; el; el = flatParentOf(el)) {
      const box = this._scrollerOf(el);
      if (!box || !wheelScrolls(box, axis)) continue;
      const state = scrollStateOf(box);
      const x = state.x / s;
      const y = state.y / s;
      const at = axis === 'x' ? x : y;
      const max =
        (axis === 'x'
          ? state.width - state.clientWidth
          : state.height - state.clientHeight) / s;
      const client =
        (axis === 'x' ? state.clientWidth : state.clientHeight) / s;
      const to = step(at, max, client);
      if (Math.abs(to - at) < 0.5) continue;
      // a snap container rests at the next snap point the key's way
      if (box.style.scrollSnapType && box.el) {
        const snapped = this._snapScroll(
          box,
          (axis === 'x' ? to : x) * s,
          (axis === 'y' ? to : y) * s,
          scroll(state.x, state.y),
        );
        this._scrollBox(box, snapped.x / s, snapped.y / s);
        return true;
      }
      this._scrollBox(box, axis === 'x' ? to : x, axis === 'y' ? to : y);
      return true;
    }
    // the pane around the document, where the document lets it scroll
    const overflow = this._tree?.viewportOverflow;
    if ((axis === 'x' ? overflow?.x : overflow?.y) === 'hidden') return false;
    for (let node = this.parent; node; node = node.parent) {
      const pane = node as unknown as {
        isScroller?: () => boolean;
        scrollX: number;
        scrollY: number;
        scale: number;
        contentWidth: number;
        contentHeight: number;
        scrollTo(to: { x?: number; y?: number }): void;
      };
      if (!pane.isScroller?.()) continue;
      const ps = pane.scale || 1;
      const box = node.contentBox();
      const at = (axis === 'x' ? pane.scrollX : pane.scrollY) / ps;
      const client = (axis === 'x' ? box.width : box.height) / ps;
      const max = Math.max(
        0,
        (axis === 'x' ? pane.contentWidth : pane.contentHeight) / ps - client,
      );
      const to = step(at, max, client);
      if (Math.abs(to - at) < 0.5) return false;
      // the viewport, where the root snaps, as a snap container does
      if (this._rootBox()?.style.scrollSnapType) {
        const x = axis === 'x' ? to : pane.scrollX / ps;
        const y = axis === 'y' ? to : pane.scrollY / ps;
        const snapped = this._snapViewportAt(
          x * ps,
          y * ps,
          scroll(pane.scrollX, pane.scrollY),
        );
        pane.scrollTo({ x: snapped.x / ps, y: snapped.y / ps });
        return true;
      }
      pane.scrollTo(axis === 'x' ? { x: to } : { y: to });
      return true;
    }
    return false;
  }

  /** The innermost scroll container under where the wheel turned that the
   *  wheel scrolls and that has room to move the way a delta goes. */
  private _wheelScroller(dx: number, dy: number): Box | null {
    const at = this._wheelAt;
    const tree = this._tree;
    if (!at || !tree || (!dx && !dy)) return null;
    const local = this._toDocument(at.x, at.y);
    for (let el = this._drawnAt(at.x, at.y); el; el = flatParentOf(el)) {
      const box = this._scrollerOf(el);
      if (!box) continue;
      // the point inside its scrollport: an element positioned out of a
      // scroll container is no part of what it scrolls
      const left = box.x + box.borderLeft;
      const top = box.y + box.borderTop;
      const state = scrollStateOf(box);
      if (
        local.x < left ||
        local.y < top ||
        local.x >= left + state.clientWidth ||
        local.y >= top + state.clientHeight
      ) {
        continue;
      }
      const room = (v: number, max: number, d: number) =>
        d > 0 ? v < max - 0.5 : d < 0 ? v > 0.5 : false;
      if (
        (wheelScrolls(box, 'x') &&
          room(state.x, state.width - state.clientWidth, dx)) ||
        (wheelScrolls(box, 'y') &&
          room(state.y, state.height - state.clientHeight, dy))
      ) {
        return box;
      }
    }
    return null;
  }

  /** An element's box, where it is a scroll container. */
  private _scrollerOf(element: Element): Box | null {
    const tree = this._tree;
    if (!tree) return null;
    const box = this._firstBoxesOf(tree).get(element) ?? null;
    return box && isScroller(box) ? box : null;
  }

  /**
   * Scroll a scroll container's content to an offset in CSS pixels: the
   * boxes moved by the difference, the ink worked out again, the
   * scrollport repainted, and what is mounted beside the document told
   * where its element went. Answers where it came to.
   */
  private _scrollBox(box: Box, x: number, y: number): ScrollOffset {
    this._geometry += 1;
    const s = this._scale;
    const was = scrollStateOf(box);
    // what is anchored to something it scrolls moves with it, and may be
    // hidden or shown by `position-visibility`: drawn again where it was
    let root = box;
    while (root.parent) root = root.parent;
    const anchored = [
      ...anchoredAcross(box).map((a) => a.box),
      ...positionVisibilityBoxes(root),
    ];
    const before = anchored.map((b) => this._inkOf(b));
    const to = scrollContent(box, x * s, y * s, translate);
    // a box `position-visibility` hides or shows now leaves its
    // stacking context's layers, or joins them, with what it holds — and
    // one anchored across the scroll that no longer fits tries its
    // position options again (`_refitAnchored`)
    const anchors = !!this._tree?.anchors;
    const viewport = anchors ? this._viewportAt() : null;
    if (anchors && refitAnchored(root, viewport)) {
      this._invalidate(Stale.Layout);
    }
    if (updatePositionVisibility(root, viewport).length) stackLayers(root);
    // its sticky boxes where it is scrolled to now
    if (to.x !== was.x || to.y !== was.y) restickWithin(box);
    const offset = { x: to.x / s, y: to.y / s };
    const el = box.el!;
    if (offset.x || offset.y) this._scrollOffsets.set(el, offset);
    else this._scrollOffsets.delete(el);
    if (to.x === was.x && to.y === was.y) return offset;
    // what a layout that stopped set aside in a scroll container may be
    // what it is scrolled to now: the document is laid out whole
    if (this._partial) this._invalidate(Stale.Layout);
    // and what waits may be what it shows now, or wait the longer for it
    if (this._owed.size) {
      this._inputAt = owedClock.now();
      this._runNear(0);
    }
    this._scrolledLast.set(el, scrolledTowards(to.x - was.x, to.y - was.y));
    const tree = this._tree!;
    computePaintBounds(tree.root, tree.movedInline);
    // what a read of the pixels or a layer holds of what moved
    this._filtered?.staleAll();
    this._spriteGen += 1;
    this.spritesChanged();
    const after = anchored.map((b) => this._inkOf(b));
    this._repaintInk([
      {
        x: box.x + box.borderLeft,
        y: box.y + box.borderTop,
        width: was.clientWidth,
        height: was.clientHeight,
      },
      ...[...before, ...after].filter((r): r is Rect => r !== null),
    ]);
    this._reportControls();
    this._reportMedia();
    this._reportEmbedded();
    this._reportStops();
    // what a `scroll-state()` query answers for it, or for a sticky box
    // in it
    this._askScrollStates();
    // and what a trigger whose timeline it scrolls says now
    this._evaluateTriggers();
    // and where an animation that runs on its scroll is
    this._restyleScrolled();
    this._props().onElementScroll?.(el);
    return offset;
  }

  /**
   * A `<canvas>`'s picture changed (`canvasImage`): its box repainted where
   * it is, and the surfaces kept for the boxes around it, which hold it as
   * it was, given up.
   */
  canvasChanged(element: Element): void {
    const tree = this._tree;
    if (!tree) return;
    const box = this._firstBoxesOf(tree).get(element);
    if (!box || box.replaced !== 'frame') return;
    this._dropSprites(box, true);
    const ink = this._inkOf(box);
    if (ink) this._repaintInk([ink]);
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

  /** The thumb a press took, and how far along it: dragged until the
   *  release (`defaultMouseDrag`). */
  private _barDrag: { box: Box; axis: 'x' | 'y'; grab: number } | null = null;

  /** Whether a logical window point is on a bar of a scroll container in
   *  the document: a press there is the bar's, and no link's, no
   *  selection's and not the page's (`<Html>`'s `onMouseDownCapture`). */
  scrollBarAt(x: number, y: number): boolean {
    return this._barAt(x, y) !== null;
  }

  /** Whether a bar's thumb is being dragged: the release that ends it is
   *  the bar's too. */
  get draggingScrollBar(): boolean {
    return this._barDrag !== null;
  }

  /** The bar under a logical window point, of the innermost scroll
   *  container there, and the part of it: what a press on it does. */
  private _barAt(
    x: number,
    y: number,
  ): { box: Box; bar: ScrollBar; part: 'thumb' | 'track' } | null {
    if (!this._tree) return null;
    const local = this._toDocument(x, y);
    for (let el = this._drawnAt(x, y); el; el = flatParentOf(el)) {
      const box = this._scrollerOf(el);
      if (!box) continue;
      for (const bar of this._barsOf(box)) {
        const part = scrollBarHit(bar, local.x, local.y, this._scale);
        if (part) return { box, bar, part };
      }
    }
    return null;
  }

  private _barsOf(box: Box): ScrollBar[] {
    const hidden =
      box.el && this._cascade
        ? this._cascade.scrollbarHidden(box.el, box.style)
        : BARS_SHOWN;
    return scrollBarsOf(box, this._scale, hidden);
  }

  /** A press on a bar: its thumb taken to drag, as core's pane takes its
   *  own, or its track paging toward the press; anywhere else, the
   *  selection's. */
  override defaultMouseDown(ev: X11MouseEvent): void {
    const hit = ev.button === 1 ? this._barAt(ev.x, ev.y) : null;
    if (!hit) {
      super.defaultMouseDown?.(ev);
      return;
    }
    const local = this._toDocument(ev.x, ev.y);
    const along = hit.bar.axis === 'x' ? local.x : local.y;
    if (hit.part === 'thumb') {
      this._barDrag = {
        box: hit.box,
        axis: hit.bar.axis,
        grab: along - hit.bar.thumbStart,
      };
      ev.capturePointer();
      return;
    }
    const s = this._scale;
    const state = scrollStateOf(hit.box);
    const page =
      (hit.bar.axis === 'x' ? state.clientWidth : state.clientHeight) / s;
    const by = along < hit.bar.thumbStart ? -page : page;
    this._scrollBox(
      hit.box,
      state.x / s + (hit.bar.axis === 'x' ? by : 0),
      state.y / s + (hit.bar.axis === 'y' ? by : 0),
    );
  }

  override defaultMouseDrag(ev: X11MouseEvent): void {
    const drag = this._barDrag;
    if (!drag) {
      super.defaultMouseDrag?.(ev);
      return;
    }
    const bar = this._barsOf(drag.box).find((b) => b.axis === drag.axis);
    if (!bar || bar.travel <= 0) return;
    const local = this._toDocument(ev.x, ev.y);
    const at =
      (drag.axis === 'x' ? local.x : local.y) - drag.grab - bar.trackStart;
    const s = this._scale;
    // whole device pixels, as core's thumb moves a pane
    const to =
      Math.round(
        (Math.min(bar.travel, Math.max(0, at)) / bar.travel) * bar.range,
      ) / s;
    const state = scrollStateOf(drag.box);
    this._scrollBox(
      drag.box,
      drag.axis === 'x' ? to : state.x / s,
      drag.axis === 'y' ? to : state.y / s,
    );
  }

  override defaultMouseUp(ev: X11MouseEvent): void {
    if (this._barDrag) {
      this._barDrag = null;
      return;
    }
    super.defaultMouseUp?.(ev);
  }

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
    this._notePlaced();
    super.paint(ctx); // background, border, clip to `abs`
    this._counted(() => this._paintContent(ctx));
    // the animations this paint is the first to show start now, and run
    // from here (`AnimationTimeline.startsAtPaint`)
    this._claimsPainted = this._claims;
    if (this._timeline.startPending(animationClock.now())) {
      this._scheduleFrame();
    }
    // what the layouts since the last rendering placed anchored boxes by
    // is their last successful position option now
    commitLastPositions();
    this._noteFrame();
    this._notePaneScroll();
    if (this._owed.size) this._followOwed();
    if (this._lazyWaits) this._askNear();
    this._props().onPaint?.();
  }

  /** Where the pane around the element was scrolled to at the last paint
   *  (`onViewportScroll`), or null before the first. */
  private _paneScroll: string | null = null;
  /** Where the sticky boxes the viewport held were drawn at the last paint,
   *  in window pixels (`_heldRects`): what a scroll blit of the pane drags
   *  with the text, for it to repair (`viewportFixedRects`). */
  private _stuckDrawn: Rect[] = NO_RECTS;
  /** Where the boxes anchored across the pane's scroll were drawn at the
   *  last paint (`_anchoredRects`), for its blit to repair. */
  private _anchoredDrawn: Rect[] = NO_RECTS;
  /** Whether `_followViewport` moved a box since what is mounted beside the
   *  document was last told where its element is. */
  private _stickyMoved = false;

  /** Tell `onViewportScroll` the pane moved since the last paint. */
  private _notePaneScroll(): void {
    const tell = this._props().onViewportScroll;
    if (!tell) return;
    for (let node = this.parent; node; node = node.parent) {
      const pane = node as unknown as {
        isScroller?: () => boolean;
        scrollX: number;
        scrollY: number;
      };
      if (!pane.isScroller?.()) continue;
      const at = `${pane.scrollX},${pane.scrollY}`;
      const was = this._paneScroll;
      this._paneScroll = at;
      if (was !== null && was !== at) tell();
      return;
    }
  }

  /** The document, over what core painted for the element (`paint`). */
  private _paintContent(ctx: Context2D): void {
    // what a frame of the animations asked for is being painted: the next
    // is made as soon as the clock has one (`_frame`)
    this._owedSince = -1;
    if (this._waitingForPaint) {
      this._waitingForPaint = false;
      this._scheduleFrame();
    }
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree) return;
    // the sticky boxes the viewport keeps, where the pane has scrolled the
    // document to, and the widgets and players in them with them
    this._followViewport();
    if (this._stickyMoved) {
      this._stickyMoved = false;
      this._reportControls(this._viewportInDocument());
      this._reportMedia();
      this._reportEmbedded();
      this._reportStops();
    }
    this._stuckDrawn = this._heldRects(tree);
    this._anchoredDrawn = tree.anchors ? this._anchoredRects(tree) : NO_RECTS;
    // what is at the top of the viewport as it is drawn, for a layout at
    // another width to keep it there (`_anchorFrame`)
    this._noteShown(tree);
    // a scroll moves the boxes fixed to the viewport over the players and
    // lays nothing out, and the sticky ones it holds over the frames: where
    // they are, and what of each the pane shows, is asked as it is painted
    const fixed = FIXED_BOXES.has(tree);
    if (this._mediaLaid.length && fixed) this._publishMedia();
    if (this._embeddedLaid.length && (fixed || VIEWPORT_STICKY.has(tree))) {
      this._publishEmbedded();
    }
    // and over the controls, whose widgets they cut where they come over
    // them (`controlRectsOf`) — where one fills anything with an opaque
    // ground, which a header does and a page's transparent wrappers and
    // hidden overlays do not
    if (tree.controls.length && fixedGround(tree)) {
      const shift = this._fixedShift();
      const was = this._controlsShift;
      if (shift?.x !== was?.x || shift?.y !== was?.y) {
        this._reportControls(this._viewportInDocument());
      }
    }
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
      this._paintCaret(ctx);
    } catch (error) {
      this._fail(error, this._laidOutWidth);
      // nothing under the element was filled: what it promised is the
      // window's ground, where it leaves the document blank
      if (promised) {
        ctx.fillStyle = this._props().look.background;
        ctx.fillRect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
      }
    }
    // the surfaces given up since the last paint that this one did not
    // draw on again
    this._sprites?.trim();
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

  /** The raster kept of an image at a size (`_drawings`), made on its
   *  second drawing there; null on its first, and where none can be. */
  private _drawingKept(
    key: string,
    width: number,
    height: number,
    draw: (ctx: unknown) => void,
  ): SurfaceLike | null {
    const cache = (this._drawings ??= new SurfaceCache(this.app));
    if (!cache.has(key)) {
      if (
        this._liveResizing() ||
        resizeClock.now() - this._widthMovedAt < RESIZE_BURST_MS
      ) {
        this._drawnNow.add(key);
        if (!this._drawnLast.has(key)) return null;
      } else if (!this._drawnOnce.has(key)) {
        // keys drawn once are cheap, and a long life of them is forgotten
        // wholesale
        if (this._drawnOnce.size >= 4096) this._drawnOnce.clear();
        this._drawnOnce.add(key);
        return null;
      } else {
        this._drawnOnce.delete(key);
      }
    }
    return cache.get(key, width, height, draw);
  }

  // --- view transitions -----------------------------------------------------
  //
  // A view transition (CSS View Transitions 1) is the page's realm's to run,
  // step by step (`scripts/dom.ts`); what it asks of the element is to
  // capture the old state, to capture the new and to end. In between, the
  // tree of its pseudo-elements is built as boxes in the top layer
  // (`_transitionTree`), each element it captured is a hole where it is
  // laid out (`PaintOptions.captured`), and each image in the tree draws
  // its element (`_transitionImage`): the old one as it was captured, and
  // the new one as it is, at every paint.

  /** A view transition under way, from the capture of its old state. */
  private _vt: ViewTransitionRun | null = null;
  /** The timer for its tree's next frame. */
  private _vtTimer: unknown = null;

  /**
   * Capture a view transition's old state (7.4): each element a name
   * captures — the root's, by the user agent's — where it is and a picture
   * of it and all it holds, but the elements in it captured on their own.
   * The name two elements share, which skips the transition, or ''.
   */
  transitionCaptureOld(): string {
    this.transitionEnd();
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree) return '';
    const named = this._namedElements(tree);
    if (typeof named === 'string') return named;
    const run = new ViewTransitionRun();
    const boxes = new Set(named.map((n) => n.box));
    for (const { name, el, box, classes } of named) {
      const others = new Set(boxes);
      others.delete(box);
      const root = isRootElement(el);
      const placement = root
        ? this._viewportPlacement(box)
        : this._placementOf(box);
      const shot = this._captureSurface(tree, root ? null : box, others);
      const old: OldImage = {
        ...placement,
        surface: shot?.surface ?? null,
        inkX: shot?.inkX ?? 0,
        inkY: shot?.inkY ?? 0,
        inkWidth: shot?.inkWidth ?? 0,
        inkHeight: shot?.inkHeight ?? 0,
      };
      run.entries.set(name, {
        name,
        classes,
        old,
        el: null,
        now: null,
        anim: null,
      });
    }
    this._vt = run;
    run.timeline.onCssEvent = () => this._oweCssEvents();
    return '';
  }

  /**
   * Capture a view transition's new state (7.4) and draw its tree: each
   * element a name captures now, added to the names the old state had, and
   * for each name both have, the `@keyframes` its group runs from where the
   * old element was. The name two elements share, which ends the
   * transition, or ''.
   */
  transitionCaptureNew(): string {
    const run = this._vt;
    if (!run || run.phase !== 'old') return '';
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree) return '';
    const named = this._namedElements(tree);
    if (typeof named === 'string') {
      this.transitionEnd();
      return named;
    }
    for (const { name, el, box, classes } of named) {
      let entry = run.entries.get(name);
      if (!entry) {
        entry = { name, classes, old: null, el: null, now: null, anim: null };
        run.entries.set(name, entry);
      }
      entry.el = el;
      entry.classes = classes;
      entry.now = isRootElement(el)
        ? this._viewportPlacement(box)
        : this._placementOf(box);
    }
    const s = this._scale;
    let index = 0;
    for (const entry of run.entries.values()) {
      index += 1;
      const old = entry.old;
      if (!old || !entry.el) continue;
      // named after the name where that is a name as written, and by its
      // place where it would have to be escaped, which `animation-name`
      // does not read back
      const name = /^[-\w\u0080-\uffff]+$/.test(entry.name)
        ? `-ua-view-transition-group-anim-${entry.name}`
        : `-ua-view-transition-group-anim-${index}`;
      const from =
        `width: ${cssPx(old.width, s)}; height: ${cssPx(old.height, s)}; ` +
        `transform: ${groupTransform(old.matrix, old.width, old.height, s)}`;
      const rule = parseStylesheet(`@keyframes ${name} { from { ${from} } }`)
        .keyframes?.[0];
      if (rule) {
        // by the name it reads back as, and written as it is read
        run.keyframes.set(rule.name, rule);
        entry.anim = name;
      }
    }
    run.phase = 'live';
    run.started = animationClock.now();
    if (this._cascade) this._cascade.transitionKeyframes = run.keyframes;
    this._sprites?.clear();
    this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
    this.invalidateMeasure('content');
    this.invalidate(true, this, 'props');
    return '';
  }

  /** End a view transition (7.9 and 7.6): its tree goes, and its elements
   *  are drawn where they are laid out again. */
  transitionEnd(): void {
    const run = this._vt;
    if (!run) return;
    this._vt = null;
    this._cssEventsLeft.push(...run.timeline.takeCssEvents());
    if (this._vtTimer !== null) {
      animationClock.disarm(this._vtTimer);
      this._vtTimer = null;
    }
    run.dispose();
    if (this._cascade) this._cascade.transitionKeyframes = null;
    if (run.phase === 'live') {
      this._sprites?.clear();
      this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
      this.invalidateMeasure('content');
      this.invalidate(true, this, 'props');
    }
  }

  /** How long until a view transition's animations are all over, in
   *  milliseconds: `Infinity` while one is paused or never ends, and 0
   *  once they are, or where none is under way. Null where it cannot go
   *  on (7.8): an element its new state captured is no longer rendered, or
   *  is broken across columns. */
  transitionRemaining(): number | null {
    const run = this._vt;
    if (!run || run.phase !== 'live') return 0;
    // its tree as it is styled now: a page may have changed its rules
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (tree) {
      const boxes = this._firstBoxesOf(tree);
      for (const entry of run.entries.values()) {
        if (!entry.el) continue;
        const box = boxes.get(entry.el);
        if (!box || COLUMN_PIECES.has(box)) return null;
      }
    }
    return Math.max(0, run.endsAt - animationClock.now());
  }

  /** A timer for the next frame a view transition's tree changes at. */
  private _armTransitionFrame(): void {
    if (this._vtTimer !== null) {
      animationClock.disarm(this._vtTimer);
      this._vtTimer = null;
    }
    const run = this._vt;
    if (!run || run.phase !== 'live' || this.destroyed) return;
    const next = run.timeline.nextFrame();
    if (next === null) return;
    this._vtTimer = animationClock.arm(
      () => {
        this._vtTimer = null;
        if (this._vt !== run || this.destroyed) return;
        this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
        this.invalidateMeasure('content');
        this.invalidate(true, this, 'props');
      },
      Math.max(1, next - animationClock.now()),
    );
  }

  /**
   * The elements a state of a view transition captures, by name, in tree
   * order — the order the user agent's walk of the paint finds them in,
   * near enough — each with its principal box and its classes; or the name
   * two of them share (7.4). One with no box is not rendered, and captured
   * by nothing.
   */
  private _namedElements(
    tree: BoxTree,
  ): { name: string; el: Element; box: Box; classes: string[] }[] | string {
    const boxes = this._firstBoxesOf(tree);
    const out: { name: string; el: Element; box: Box; classes: string[] }[] =
      [];
    const seen = new Set<string>();
    for (const [el, { style }] of tree.styles) {
      const name = captureName(el, style);
      if (name === null) continue;
      const box = boxes.get(el);
      // one broken across columns is not captured (7.4)
      if (!box || COLUMN_PIECES.has(box)) continue;
      if (seen.has(name)) return name;
      seen.add(name);
      out.push({ name, el, box, classes: captureClasses(style) });
    }
    return out;
  }

  /** The boxes of the elements a view transition draws in its tree now. */
  private _capturedBoxes(tree: BoxTree): Set<Box> {
    const out = new Set<Box>();
    const run = this._vt;
    if (!run) return out;
    const boxes = this._firstBoxesOf(tree);
    for (const entry of run.entries.values()) {
      const box = entry.el && boxes.get(entry.el);
      if (box) out.add(box);
    }
    return out;
  }

  /** Whether a view transition captured the root element, which its tree
   *  draws the canvas in. */
  private _rootCaptured(run: ViewTransitionRun): boolean {
    for (const entry of run.entries.values()) {
      if (entry.el && isRootElement(entry.el)) return true;
    }
    return false;
  }

  /** The viewport, as the root's capture is placed (7.4): its size, at
   *  its own corner. */
  private _viewportPlacement(box: Box): Placement {
    const viewport = this._viewport() ?? this.abs;
    return {
      width: viewport.width,
      height: viewport.height,
      matrix: [1, 0, 0, 1, 0, 0],
      direction: box.style.direction,
      mixBlendMode: box.style.mixBlendMode,
    };
  }

  /**
   * Where a box's border box is from the viewport's corner, as the matrix
   * from its own corner, in device pixels (7.4): the place layout gave it,
   * its transform and those of the boxes around it, and the scroll that
   * moves it — none for one fixed to the viewport.
   */
  private _placementOf(box: Box): Placement {
    let m: Matrix = [1, 0, 0, 1, box.x, box.y];
    for (let at: Box | null = box; at; at = at.topLayer ? null : at.parent) {
      const placed = placedMatrix(at);
      if (placed && placed.length === 6) m = multiply(placed as Matrix, m);
    }
    if (!drawnAtViewport(box)) {
      const viewport = this._viewport() ?? this.abs;
      m = multiply(
        [1, 0, 0, 1, this.abs.x - viewport.x, this.abs.y - viewport.y],
        m,
      );
    }
    return {
      width: box.width,
      height: box.height,
      matrix: m,
      direction: box.style.direction,
      mixBlendMode: box.style.mixBlendMode,
    };
  }

  /**
   * A picture of a box and all it holds, as laid out, but for `others` —
   * the elements in it captured on their own — on a surface the size of
   * what it draws, cut to the viewport and as far again on each side; or,
   * for null, of the document in the viewport, the root's. Where the
   * surface's corner is from the box's border box, and its size. Null where
   * no surface can be had.
   */
  private _captureSurface(
    tree: BoxTree,
    box: Box | null,
    others: ReadonlySet<Box>,
  ): {
    surface: SurfaceLike;
    inkX: number;
    inkY: number;
    inkWidth: number;
    inkHeight: number;
  } | null {
    const base = this._paintOptions(null, null);
    const viewport = this._viewport() ?? this.abs;
    if (!box) {
      const w = Math.ceil(viewport.width);
      const h = Math.ceil(viewport.height);
      if (!(w > 0 && h > 0)) return null;
      const surface = this._surface(w, h);
      if (!surface) return null;
      paintDocument(surface.getContext('2d') as PaintContext, tree, {
        ...base,
        originX: this.abs.x - viewport.x,
        originY: this.abs.y - viewport.y,
        canvas: base.canvas && {
          ...base.canvas,
          x: base.canvas.x - viewport.x,
          y: base.canvas.y - viewport.y,
        },
        viewport: {
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height,
        },
        damage: { x: 0, y: 0, width: w, height: h },
        selection: null,
        captured: others,
        groundCanvas: true,
      });
      return { surface, inkX: 0, inkY: 0, inkWidth: w, inkHeight: h };
    }
    // what it draws, in the document, cut to as far round the viewport
    // again as the viewport is: where a box fixed to the viewport is laid
    // out at the document's top, and any other one where it scrolls
    const fixed = drawnAtViewport(box);
    const vx = fixed ? 0 : viewport.x - this.abs.x;
    const vy = fixed ? 0 : viewport.y - this.abs.y;
    const x0 = Math.floor(
      Math.max(Math.min(box.boundsX, box.x), vx - viewport.width),
    );
    const y0 = Math.floor(
      Math.max(Math.min(box.boundsY, box.y), vy - viewport.height),
    );
    const x1 = Math.ceil(
      Math.min(
        Math.max(box.boundsX + box.boundsWidth, box.x + box.width),
        vx + 2 * viewport.width,
      ),
    );
    const y1 = Math.ceil(
      Math.min(
        Math.max(box.boundsY + box.boundsHeight, box.y + box.height),
        vy + 2 * viewport.height,
      ),
    );
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 0 && h > 0) || w * h > CAPTURE_LIMIT) return null;
    const surface = this._surface(w, h);
    if (!surface) return null;
    paintCapture(surface.getContext('2d') as PaintContext, tree, box, {
      ...base,
      originX: -x0,
      originY: -y0,
      canvas: undefined,
      viewport: {
        x: -x0,
        y: -y0,
        width: viewport.width,
        height: viewport.height,
      },
      damage: { x: 0, y: 0, width: w, height: h },
      selection: null,
      captured: others,
    });
    return {
      surface,
      inkX: x0 - box.x,
      inkY: y0 - box.y,
      inkWidth: w,
      inkHeight: h,
    };
  }

  /**
   * A view transition's tree, as the builder makes it (`TransitionTree`):
   * `::view-transition` over the root element, and for each name its group
   * — the size of its element and where it is, from where it was where it
   * has both — its image pair, isolated where it has both, and its old and
   * new images, faded out and in; each styled by the user agent's sheet and
   * the page's rules over what the transition gives it (7.8), at the time
   * its timeline has come to. Notes when its animations are over.
   */
  private readonly _transitionTree = (
    root: Element,
    rootStyle: ComputedStyle,
  ): TransitionTree | null => {
    const run = this._vt;
    const cascade = this._cascade;
    if (!run || run.phase !== 'live' || !cascade) return null;
    const s = this._scale;
    const timeline = run.timeline;
    timeline.now = animationClock.now();
    const declarations = (text: string) =>
      text ? parseDeclarations(text) : [];
    // each part styled, and how, for its style under its animations
    run.styled.clear();
    const styled = (
      part: TransitionPart['part'],
      name: string,
      classes: readonly string[],
      onlyChild: boolean,
      parent: ComputedStyle,
      dynamic: readonly Declaration[],
    ): ComputedStyle => {
      const key =
        part === 'view-transition' ? part : `view-transition-${part}(${name})`;
      run.styled.set(key, { part, name, classes, onlyChild, parent, dynamic });
      return cascade.transitionStyle(
        root,
        part,
        name,
        classes,
        onlyChild,
        parent,
        dynamic,
        timeline,
        key,
      );
    };
    const style = styled('view-transition', '', [], false, rootStyle, []);
    let end = animationsEnd(style);
    const groups: TransitionTree['groups'] = [];
    const count = run.entries.size;
    for (const entry of run.entries.values()) {
      const at = entry.now ?? entry.old;
      if (!at) continue;
      const both = !!entry.old && !!entry.el;
      const { name, classes } = entry;
      const group = styled(
        'group',
        name,
        classes,
        count === 1,
        style,
        declarations(
          `width: ${cssPx(at.width, s)}; height: ${cssPx(at.height, s)}; ` +
            `transform: ${groupTransform(at.matrix, at.width, at.height, s)}; ` +
            `direction: ${at.direction}; mix-blend-mode: ${at.mixBlendMode}` +
            (both && entry.anim ? `; animation-name: ${entry.anim}` : ''),
        ),
      );
      const pair = styled(
        'image-pair',
        name,
        classes,
        true,
        group,
        declarations(both ? 'isolation: isolate' : ''),
      );
      const fade = (out: boolean) =>
        declarations(
          both
            ? `animation-name: -ua-view-transition-fade-${out ? 'out' : 'in'}, ` +
                '-ua-mix-blend-mode-plus-lighter'
            : '',
        );
      const old = entry.old
        ? styled('old', name, classes, !entry.el, pair, fade(true))
        : null;
      const now =
        entry.el && entry.now
          ? styled('new', name, classes, !entry.old, pair, fade(false))
          : null;
      end = Math.max(
        end,
        animationsEnd(group),
        animationsEnd(pair),
        old ? animationsEnd(old) : 0,
        now ? animationsEnd(now) : 0,
      );
      groups.push({
        name,
        group,
        pair,
        old:
          old && entry.old
            ? { style: old, width: entry.old.width, height: entry.old.height }
            : null,
        new:
          now && entry.now
            ? { style: now, width: entry.now.width, height: entry.now.height }
            : null,
      });
    }
    run.endsAt = run.started + end;
    return { style, groups };
  };

  /**
   * What a view transition's image draws (`PaintOptions.transitionImage`):
   * the old one, its element as it was captured; the new one, its element
   * as it is, painted now — the root's, the document in the viewport —
   * each with its border box stretched over the image's box, and what it
   * draws past it with it.
   */
  private readonly _transitionImage = (box: Box): TransitionDraw | null => {
    const run = this._vt;
    const tree = this._tree;
    const info = TRANSITION_IMAGES.get(box);
    if (!run || !tree || !info) return null;
    const entry = run.entries.get(info.name);
    if (!entry) return null;
    if (info.which === 'old') {
      const old = entry.old;
      if (!old?.surface) return null;
      return (ctx, x, y, w, h) =>
        drawCaptured(ctx, old.surface!, old, x, y, w, h);
    }
    const el = entry.el;
    if (!el) return null;
    return (ctx, x, y, w, h, damage) => {
      const root = isRootElement(el);
      const own = this._firstBoxesOf(tree).get(el) ?? null;
      if (!own) return;
      const others = this._capturedBoxes(tree);
      others.delete(own);
      // the root's leaves the transition's own tree out
      if (root) {
        for (const top of topLayerBoxes(tree.root)) {
          if (top.pseudo === 'view-transition') others.add(top);
        }
      }
      const size = root ? this._viewportPlacement(own) : own;
      // drawn at its size, as it is: straight onto the context, as the
      // document would draw it there
      if (Math.abs(w - size.width) < 1e-6 && Math.abs(h - size.height) < 1e-6) {
        this._paintLive(ctx, tree, root ? null : own, x, y, damage, others);
        return;
      }
      const shot = this._captureSurface(tree, root ? null : own, others);
      if (!shot) return;
      try {
        drawCaptured(
          ctx,
          shot.surface,
          { ...shot, width: size.width, height: size.height },
          x,
          y,
          w,
          h,
        );
      } finally {
        shot.surface.destroy?.();
      }
    };
  };

  /** An element a view transition draws in its new image, at its size with
   *  its border box's corner at (`x`, `y`) — or, for null, the document in
   *  the viewport, its corner there — but for `others`. */
  private _paintLive(
    ctx: PaintContext,
    tree: BoxTree,
    box: Box | null,
    x: number,
    y: number,
    damage: Rect | null,
    others: ReadonlySet<Box>,
  ): void {
    const base = this._paintOptions(null, damage);
    const viewport = this._viewport() ?? this.abs;
    if (!box) {
      const dx = x - viewport.x;
      const dy = y - viewport.y;
      paintDocument(ctx, tree, {
        ...base,
        originX: this.abs.x + dx,
        originY: this.abs.y + dy,
        canvas: base.canvas && {
          ...base.canvas,
          x: base.canvas.x + dx,
          y: base.canvas.y + dy,
        },
        viewport: { ...viewport, x, y },
        selection: null,
        captured: others,
        groundCanvas: true,
      });
      return;
    }
    const originX = x - box.x;
    const originY = y - box.y;
    paintCapture(ctx, tree, box, {
      ...base,
      originX,
      originY,
      canvas: undefined,
      viewport: {
        x: originX,
        y: originY,
        width: viewport.width,
        height: viewport.height,
      },
      selection: null,
      captured: others,
    });
  }

  private _paint(
    ctx: Context2D,
    tree: BoxTree,
    range: { start: number; end: number } | null,
    damage: { x: number; y: number; width: number; height: number } | null,
  ): void {
    // the keys this paint draws, against the ones the paint before drew
    const last = this._drawnLast;
    last.clear();
    this._drawnLast = this._drawnNow;
    this._drawnNow = last;
    const vt = this._vt?.phase === 'live' ? this._vt : null;
    const captured = vt ? this._capturedBoxes(tree) : null;
    paintDocument(ctx as PaintContext, tree, {
      ...this._paintOptions(range, damage),
      captured,
      noCanvas: !!vt && this._rootCaptured(vt),
      transitionImage: vt ? this._transitionImage : undefined,
      lifted: this._liftedBoxes(tree),
      shadowless: this._shadowlessBoxes(tree),
      drag: this._liveResizing()
        ? {
            cheap: this._cheap,
            moved: this._tileMoved,
            paused: this._paused,
            drawn: this._noteCheaper,
          }
        : null,
    });
  }

  /** `DragPaint.moved`: a background layer's tile size, the first it was
   *  drawn at in the drag under way, or true once it was drawn at another
   *  (`_tileSizes`). */
  private readonly _tileMoved = (
    layer: object,
    width: number,
    height: number,
  ): boolean => {
    const was = this._tileSizes.get(layer);
    if (was === true) return true;
    if (!was) {
      this._tileSizes.set(layer, [width, height]);
      return false;
    }
    if (was[0] === width && was[1] === height) return false;
    this._tileSizes.set(layer, true);
    return true;
  };

  /** `DragPaint.paused`: an animation of the box's own, an element's or a
   *  pseudo-element's, under way on the clock a drag drawn cheaper pauses. */
  private readonly _paused = (box: Box): boolean => {
    const el = box.el ?? GENERATED_FROM.get(box);
    return !!el && this._timeline.isLive(el, box.el ? '' : (box.pseudo ?? ''));
  };

  private readonly _noteCheaper = (): void => {
    this._drawnCheaper = true;
  };

  /**
   * After a paint: what the element's own work came to since the paint
   * before, where the window says a drag of its edge is under way
   * (`liveResizing`) and a layout at another width came in that time — a
   * frame of the drag, which a drag drawn as at rest notes for `_behind`.
   * Zen Garden 214's photographs, sized to cover their boxes, were each
   * drawn again at every width of a drag, under an animation the
   * document's clock made a frame of forty times a second, and a frame of
   * the drag cost the document 18 to 30 ms.
   */
  private _noteFrame(): void {
    const work = this._work;
    this._work = 0;
    const laid = this._laidSincePaint;
    this._laidSincePaint = false;
    if (!laid || !this._liveResizing()) return;
    // a rest of the drag is the settle's to find, from the end of its last
    // frame, and its end
    this._dragFrameAt = resizeClock.now();
    this._armSettle();
    if (this._cheap) return;
    const over = this._overBudget;
    over.push(work > FRAME_BUDGET_MS);
    if (over.length > 3) over.shift();
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
      highlights: this._litRanges(),
      litReplaced: this._litReplaced(),
      scrollbarHidden: (box) =>
        box.el && this._cascade
          ? this._cascade.scrollbarHidden(box.el, box.style)
          : BARS_SHOWN,
      imageFor: (box) => {
        if (box.replaced === 'frame') {
          return box.el && tagOf(box.el) === 'canvas'
            ? (this._props().canvasImage?.(box.el) ?? null)
            : null;
        }
        const url = box.el ? this._imageUrl(box.el) : CONTENT_IMAGES.get(box);
        if (url === undefined) return null;
        const animation = this._resources.animation(url);
        return animation
          ? this._frameOf(animation, box)
          : this._resources.image(url);
      },
      mounted: this._mounted,
      backgroundImageFor: (url, box) => {
        const animation = this._resources.animation(url);
        const image = animation
          ? this._frameOf(animation, box)
          : this._resources.image(url);
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

/** A tree's text, and the text of the HTML in its `<foreignObject>`s,
 *  which is no part of it (`ForeignObject`): what a document's faces are
 *  loaded for the characters of. */
function textOfTree(tree: BoxTree): string {
  if (!tree.foreign) return tree.text;
  let text = tree.text;
  for (const object of tree.foreign.values()) {
    text += `\n${textOfTree(object.tree)}`;
  }
  return text;
}

/** Whether a drawing has a `<foreignObject>` with HTML built for it. */
function drawsForeign(
  objects: ReadonlyMap<Element, ForeignObject>,
  drawing: Element,
): boolean {
  for (const object of objects.values()) {
    if (object.svg.el === drawing) return true;
  }
  return false;
}

/** Whether any of `els` is a `<foreignObject>` with HTML built for it, or
 *  in one: what an element of a drawing is under, in the document's tree. */
function inForeignObject(
  objects: ReadonlyMap<Element, ForeignObject>,
  els: ReadonlySet<Element>,
): boolean {
  for (const el of els) {
    for (let at: Element | null = el; at; at = elementParent(at)) {
      if (objects.has(at)) return true;
    }
  }
  return false;
}

/** An element's parent, where that is an element. */
function elementParent(el: Element): Element | null {
  const parent = el.parent;
  return parent && parent.type === 'tag' ? (parent as Element) : null;
}

/** Whether an element is its document's root: its parent the document. */
function isRootElement(el: Element): boolean {
  return !!el.parent && !el.parent.parent && !(el.parent instanceof ShadowRoot);
}

/** Device pixels as a CSS length, for a style the transition writes. */
function cssPx(device: number, scale: number): string {
  return `${Math.round((device / scale) * 1e4) / 1e4}px`;
}

/** The most pixels a view transition's capture of one element takes: a
 *  large window's worth twice over. */
const CAPTURE_LIMIT = 16 * 1024 * 1024;

/**
 * A captured element drawn with its border box over `w` by `h` at (`x`,
 * `y`): the surface, which reaches past the border box by `inkX`… of the
 * element's pixels, stretched as the border box is, on whole pixels where
 * it is drawn at its size.
 */
function drawCaptured(
  ctx: PaintContext,
  surface: SurfaceLike,
  image: {
    width: number;
    height: number;
    inkX: number;
    inkY: number;
    inkWidth: number;
    inkHeight: number;
  },
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (!ctx.drawImage || !(image.width > 0 && image.height > 0)) return;
  const sx = w / image.width;
  const sy = h / image.height;
  const dx = x + image.inkX * sx;
  const dy = y + image.inkY * sy;
  if (Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6) {
    ctx.drawImage(surface, Math.round(dx), Math.round(dy));
    return;
  }
  ctx.drawImage(surface, dx, dy, image.inkWidth * sx, image.inkHeight * sy);
}

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
  /** A `<link>`'s `href` as it was read, which its `load` is told for. */
  href?: string;
  base: string | null;
  /** What its `media` attribute puts it under (`SheetRef.media`). */
  media: MediaCondition[] | null;
  /** A sheet its tree adopted (`SheetRef.constructed`). */
  constructed?: boolean;
}

/** Where a sheet read from the document came from. */
function sourceOfSheet(read: SheetText): SheetSource {
  return {
    url: read.href === undefined ? null : (read.base ?? read.href),
    element: read.constructed ? null : read.element,
    text: read.text,
  };
}

/** One `@import` a sheet read, and what it read as. */
interface ImportRead {
  url: string;
  text: string | null;
  base: string | null;
}

/** A `<link>`'s or a `<style>`'s sheet as the cascade in force read it:
 *  a link's from its `href`. */
interface SheetInForce {
  href: string | undefined;
  imports: readonly ImportRead[];
}

/** A script a host waits to run (`scriptsUnblocked`). */
interface ScriptWait {
  script: Element | null;
  doc: Document;
  resolve: () => void;
}

/** `compareDocumentPosition`'s answer where the first comes before the
 *  second: domutils' `DocumentPosition` is a `const enum`, which an
 *  isolated module cannot read. */
const BEFORE = 2;

/** A sheet as `_parseSheet` keeps it: what it was parsed under. */
interface ParsedSheet {
  base: string | null;
  under: MediaCondition[][] | null;
  sheet: Stylesheet;
  /** For a sheet that names a cascade layer, the layers ranked before its
   *  parse, in their order, and the names it ranked after them: a layer's
   *  rank is the document's, the order its sheets first name them in. */
  layers: { before: string[]; added: string[] } | null;
}

/**
 * The rules the sheets `now` reads add to the ones `was` read, where that
 * is all they do (`_sheetsAdded`): every sheet of `was` is in `now`, in its
 * order, under the same base and media and importing the same, reading as
 * it did or with style rules after its last — a CSS-in-JS library's
 * `<style>` written to — and every other sheet is new; a shadow tree's
 * sheets import what they did, and one that reads otherwise is bound to
 * other rules, which styles what its host holds (`_sheetsAdded`); and the
 * host's sheets are as they were. And nothing added
 * reaches past what its selectors name: no `@import`, `@font-face`,
 * `@property`, `@function`, `@position-try`, `@counter-style` or cascade
 * layer, no `@scope`, `@starting-style` or `@namespace`, and no selector at
 * a shadow tree's edge or for a highlight or a view transition. A
 * `@keyframes` reaches what runs its name, which is said beside the rules
 * (`runningAny`). Null otherwise.
 */
function addedRules(
  was: SheetsRead,
  now: SheetsRead,
): { rules: StyleRule[]; keyframes: Set<string> } | null {
  if (
    now.look !== was.look ||
    now.scale !== was.scale ||
    now.fonts !== was.fonts ||
    now.extras.length !== was.extras.length ||
    now.extras.some((text, i) => text !== was.extras[i]) ||
    [...was.shadows].some(([key, imports]) =>
      now.shadows
        .get(key)
        ?.some((list, i) => !sameImportsRead(list, imports[i])),
    )
  ) {
    return null;
  }
  const added: StyleRule[] = [];
  const keyframes = new Set<string>();
  let j = 0;
  for (let i = 0; i < now.texts.length; i += 1) {
    const sheet = now.sheets[i];
    const text = now.texts[i];
    if (
      j < was.texts.length &&
      now.encodings[i] === was.encodings[j] &&
      now.bases[i] === was.bases[j] &&
      sameValue(now.media[i], was.media[j]) &&
      sameImportsRead(now.imports[i], was.imports[j])
    ) {
      if (text === was.texts[j]) {
        j += 1;
        continue;
      }
      // one that names layers as the last of the document's, after which
      // no sheet can name one first
      const tail =
        !sheet.layered || (i === now.texts.length - 1 && !now.extras.length)
          ? rulesAfter(was.sheets[j], sheet)
          : null;
      const frames = tail && keyframesAfter(was.sheets[j], sheet);
      if (tail && frames && !ADDS_REACH.test(text)) {
        added.push(...tail);
        for (const rule of frames) keyframes.add(rule.name);
        j += 1;
        continue;
      }
    }
    // a sheet after every one of the cascade's may name layers: a layer
    // ranks where the document first names it, so ones it names first rank
    // after all the others, and a rule of its in one already named is one
    // more rule there, as any added rule is (React Aria's `@layer { … }`)
    const last = j === was.texts.length && !now.extras.length;
    if (
      now.imports[i].length ||
      !onlyRules(sheet, last) ||
      ADDS_REACH.test(text)
    ) {
      return null;
    }
    added.push(...sheet.rules);
    for (const rule of sheet.keyframes ?? []) keyframes.add(rule.name);
  }
  if (j !== was.texts.length) return null;
  for (const rule of added)
    if (EDGE_OR_HIGHLIGHT.test(rule.selector)) return null;
  return { rules: added, keyframes };
}

/** The `@keyframes` `now` has after those `was` has, as `rulesAfter` has
 *  its rules: a CSS-in-JS library writes one as a component first renders.
 *  Null where it does not hold `was`'s as they were. */
function keyframesAfter(
  was: Stylesheet,
  now: Stylesheet,
): readonly KeyframesRule[] | null {
  const had = was.keyframes ?? [];
  const has = now.keyframes ?? [];
  if (has.length < had.length) return null;
  for (let i = 0; i < had.length; i += 1) {
    if (!sameValue(had[i], has[i])) return null;
  }
  return has.slice(had.length);
}

/**
 * The elements that run an animation of one of `names`, or whose `::before`
 * or `::after` does, into `into`: a `@keyframes` that comes reaches those
 * and no others (CSS Animations 1, 3). Wikipedia's chunks of CSS each bring
 * one, and each styled all 18,000 elements of an article again.
 */
function runningAny(
  tree: BoxTree,
  names: ReadonlySet<string>,
  into: Set<Element>,
): void {
  const runs = (style: ComputedStyle): boolean =>
    style.animations !== NO_ANIMATIONS &&
    style.animations.names.some((name) => name !== null && names.has(name));
  for (const [el, { style }] of tree.styles) if (runs(style)) into.add(el);
  const stack: Box[] = [tree.root];
  while (stack.length) {
    const box = stack.pop()!;
    if (box.pseudo && runs(box.style)) {
      const from = GENERATED_FROM.get(box);
      if (from) into.add(from);
    }
    for (const child of box.children) stack.push(child);
  }
}

/** The at-rules whose reach no selector says. */
const ADDS_REACH =
  /@(?:scope|starting-style|namespace|view-transition)(?![\w-])/i;

/** What a selector of an added rule may not be: at a shadow tree's edge,
 *  or for a highlight or a view transition, which no element's index holds
 *  (`Cascade.addedReach`). */
const EDGE_OR_HIGHLIGHT =
  /:host|::?(?:part|slotted|highlight)\(|::(?:selection|target-text|spelling-error|grammar-error|view-transition)/i;

/** Whether a sheet holds style rules and nothing a selector does not
 *  reach (`addedRules`) — layers too, where `layers`. */
function onlyRules(sheet: Stylesheet, layers = false): boolean {
  return (
    !sheet.imports.length &&
    (layers || !sheet.layered) &&
    !sheet.fontFaces.length &&
    !sheet.properties?.length &&
    !sheet.functions?.length &&
    !sheet.positionTries?.length &&
    !sheet.counterStyles?.length
  );
}

/**
 * The style rules `now` has that `was` has not, where it holds every rule
 * of `was` as it was, in its order, and nothing else `was` has not: a
 * sheet written to — at its end, as emotion writes, or between its rules,
 * as styled-components writes each component's group (BBC's). Each
 * element no new rule matches is styled by the rules it was, in their
 * order. Null otherwise.
 */
function rulesAfter(was: Stylesheet, now: Stylesheet): StyleRule[] | null {
  if (now.rules.length < was.rules.length) return null;
  // its at-rules as they were — not only as many: a page's CSSOM sets a
  // `@position-try`'s descriptors in place
  if (
    now.layered !== was.layered ||
    !sameValue(now.imports, was.imports) ||
    !sameValue(now.importConditions, was.importConditions) ||
    !sameValue(now.fontFaces, was.fontFaces) ||
    !sameValue(now.properties ?? null, was.properties ?? null) ||
    !sameValue(now.functions ?? null, was.functions ?? null) ||
    !sameValue(now.positionTries ?? null, was.positionTries ?? null) ||
    !sameValue(now.counterStyles ?? null, was.counterStyles ?? null)
  ) {
    return null;
  }
  // the old rules matched in order: a rule a new one stands in for, read
  // alike, is as good as it, since the two style alike
  const added: StyleRule[] = [];
  let j = 0;
  for (const rule of now.rules) {
    if (j < was.rules.length && sameRule(was.rules[j], rule)) j += 1;
    else added.push(rule);
    // more new rules than there are rules left to hold the old ones
    if (now.rules.length - added.length < j) return null;
  }
  return j === was.rules.length ? added : null;
}

/** Whether two style rules read alike, wherever their sheets put them. */
function sameRule(a: StyleRule, b: StyleRule): boolean {
  return (
    a.selector === b.selector &&
    a.specificity === b.specificity &&
    sameValue(a.declarations, b.declarations) &&
    sameValue(a.media, b.media) &&
    sameValue(a.layer, b.layer) &&
    sameValue(a.containers ?? null, b.containers ?? null)
  );
}

/** Whether two sheets imported the same, as they read. */
function sameImportsRead(
  a: readonly ImportRead[],
  b: readonly ImportRead[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].url !== b[i].url || a[i].text !== b[i].text) return false;
    if (a[i].base !== b[i].base) return false;
  }
  return true;
}

/** Whether `layers` ranks the names of `before`, in that order, and no
 *  others. */
function sameNames(
  before: readonly string[],
  layers: ReadonlyMap<string, number>,
): boolean {
  if (before.length !== layers.size) return false;
  let i = 0;
  for (const name of layers.keys()) if (name !== before[i++]) return false;
  return true;
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
  /** Each sheet as it was parsed, by `texts`: what a cascade made again
   *  where sheets were only added holds besides (`addedRules`). */
  sheets: Stylesheet[];
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

/** The first box an element made: a focusable area's without a walk of
 *  the tree. */
/**
 * An element's `offsetParent` (CSSOM View 7), by its first box: up the
 * boxes around it, as Blink walks its layout objects, so a box with no
 * element of its own is passed over, and so is an element with no box —
 * `display: contents`. The first that is the containing block of a fixed
 * box, for a fixed one; for any other, the first that is one of an
 * absolute box, or the `<body>`, or a `<td>`, a `<th>` or a `<table>` where
 * the element is not positioned. Whichever tree that one is in: a shadow
 * tree's is the caller's to pass over (`shadowHidden`). Null for the root,
 * the `<body>`, a box fixed to the viewport, a box in the top layer —
 * whose layout object Blink hangs off the view, which is no element — and
 * an element nothing around holds.
 */
function offsetParentOf(box: Box, element: Element): Box | null {
  // the root element
  // the root, and the body
  const above = element.parent;
  if (
    !box.parent ||
    !above ||
    (above.type === 'root' && !(above instanceof ShadowRoot)) ||
    tagOf(element) === 'body' ||
    box.topLayer
  ) {
    return null;
  }
  const position = box.style.position;
  const fixed = position === 'fixed';
  if (fixed && !containingBlockOf(box)) return null;
  for (let at: Box | null = box.parent; at; at = at.parent) {
    const el = at.el;
    if (!el) continue;
    if (containsOutOfFlow(at, fixed)) return at;
    if (fixed) continue;
    const tag = tagOf(el);
    if (tag === 'body') return at;
    if (
      position === 'static' &&
      (tag === 'td' || tag === 'th' || tag === 'table')
    ) {
      return at;
    }
  }
  return null;
}

/**
 * Whether a node is in a shadow tree that is not around another, open or
 * closed: one DOM's retargeting would hand the other its host for (DOM
 * 4.8). What `offsetParent` passes over, as Blink does — the spec's words
 * pass over a closed one alone (CSSOM View 7).
 */
function shadowHidden(node: AnyNode, from: AnyNode): boolean {
  let root = node;
  while (root.parent) root = root.parent;
  if (!(root instanceof ShadowRoot)) return false;
  for (let at: AnyNode | null = from; at;) {
    if (at === root) return false;
    at = at.parent ?? (at instanceof ShadowRoot ? at.host : null);
  }
  return true;
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
    fragmentBoxes(box, bands, fonts);
  }
  out.push(...bands);
}

/** An inline box's bands on its lines made its fragments' border boxes:
 *  as tall as they are, and moved where it was. */
function fragmentBoxes(box: Box, bands: Rect[], fonts: FontsLike | null): void {
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

/** Rects that overlap or touch made one, until none of those left do. */
function mergeMeeting(rects: Rect[]): Rect[] {
  const out = rects.slice();
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) {
      const a = out[i];
      const b = out[j];
      if (
        a.x <= b.x + b.width &&
        b.x <= a.x + a.width &&
        a.y <= b.y + b.height &&
        b.y <= a.y + a.height
      ) {
        out[i] = unionRect(a, b);
        out.splice(j, 1);
        // what the grown rect meets may be one it passed
        j = i;
      }
    }
  }
  return out;
}

/** What of `a` is inside `b`, or null for none. */
function rectWithin(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (!(right > x && bottom > y)) return null;
  return { x, y, width: right - x, height: bottom - y };
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

/** The edges a scroll by `dx` and `dy` went towards: a scroll down is
 *  towards the bottom (`scrolled: bottom`). */
function scrolledTowards(dx: number, dy: number): number {
  return (
    (dy < 0 ? TOP_EDGE : 0) |
    (dy > 0 ? BOTTOM_EDGE : 0) |
    (dx < 0 ? LEFT_EDGE : 0) |
    (dx > 0 ? RIGHT_EDGE : 0)
  );
}

/** An element that defines timeline triggers: its first box, and each
 *  trigger it defines. */
interface TriggerDefiner {
  el: Element;
  box: Box;
  triggers: TimelineTrigger[];
}

/** The elements of a tree that define timeline triggers, in the
 *  document's order. */
function triggerDefiners(tree: BoxTree): TriggerDefiner[] {
  const out: TriggerDefiner[] = [];
  const seen = new Set<Element>();
  const stack: Box[] = [tree.root];
  while (stack.length) {
    const box = stack.pop()!;
    const el = box.el;
    if (el && !box.pseudo && !seen.has(el)) {
      seen.add(el);
      if (box.style.timelineTriggers.names.length) {
        out.push({
          el,
          box,
          triggers: timelineTriggersOf(box.style.timelineTriggers),
        });
      }
    }
    for (let i = box.children.length - 1; i >= 0; i -= 1) {
      stack.push(box.children[i]);
    }
  }
  return out;
}

/**
 * The element whose trigger of `name` an animation of `el`'s hears: the
 * last in the document's order to define one that `el` can see — every
 * one, but one defined inside an element whose `trigger-scope` names it
 * (or is `all`), which only what that element holds sees (CSS Animation
 * Triggers 1). Undefined for none.
 */
function triggerFor(
  tree: BoxTree,
  definers: readonly TriggerDefiner[],
  el: Element,
  name: string,
): TriggerDefiner | undefined {
  const scopes = (at: Element): boolean => {
    const scope = tree.styles.get(at)?.style.triggerScope;
    return scope === 'all' || (Array.isArray(scope) && scope.includes(name));
  };
  let found: TriggerDefiner | undefined;
  for (const definer of definers) {
    if (!definer.triggers.some((t) => t.name === name)) continue;
    let scope: Element | null = null;
    for (let at: Element | null = definer.el; at; at = flatParentOf(at)) {
      if (scopes(at)) {
        scope = at;
        break;
      }
    }
    if (scope) {
      let inside = false;
      for (let at: Element | null = el; at; at = flatParentOf(at)) {
        if (at === scope) {
          inside = true;
          break;
        }
      }
      if (!inside) continue;
    }
    found = definer;
  }
  return found;
}

/** A CSS animation as a page's `getAnimations()` is told of it
 *  (`HtmlViewNode.cssAnimationsOf`). */
export interface CssAnimationInfo {
  key: number;
  element: Element;
  pseudo: string;
  name: string;
  index: number;
  duration: number | 'auto';
  delay: number;
  iterations: number;
  direction: string;
  fill: string;
  easing: string;
  paused: boolean;
  /** Whether the page cancelled it (`CSSAnimation.cancel()`), which
   *  `getAnimations()` lists no longer. */
  cancelled?: boolean;
  currentTime: number;
  /** On a scroll's timeline, where its time is, in percentages of the
   *  timeline: its time as last sampled, null where its timeline was
   *  inactive; the start time a page set, null while it is aligned to its
   *  range; and its playback rate (`ScrollRun`). */
  scroll?: { at: number | null; start: number | null; rate: number };
  timeline:
    | { kind: 'document' | 'none' }
    | { kind: 'scroll'; source: Element | null; axis: string }
    | { kind: 'view'; subject: Element; axis: string; inset: string[] };
  rangeStart: string;
  rangeEnd: string;
}

/** A CSS transition event a page hears (CSS Transitions 2, 6.1): its
 *  target and pseudo-element, its type, the longhand and the elapsed time
 *  in seconds (`onCssEvents`). */
export interface CssEventInfo {
  element: Element;
  pseudo: string;
  type: string;
  /** The longhand a transition is of, or an animation's name. */
  name: string;
  elapsedTime: number;
  /** Its run's key (`CssAnimationInfo`, `CssTransitionInfo`). */
  key: number;
}

/** A CSS transition as a page's `getAnimations()` lists it
 *  (`HtmlViewNode.cssTransitionsOf`): its run's key, its owning element
 *  and pseudo-element, its longhand, its effect's timing in milliseconds
 *  and where its time is, from when it was made. */
export interface CssTransitionInfo {
  key: number;
  element: Element;
  pseudo: string;
  property: string;
  duration: number;
  delay: number;
  easing: string;
  currentTime: number;
}

/** The timeline an element's `animation-timeline` names (Scroll-driven
 *  Animations 1, 4.2): `scroll-timeline-name` or `view-timeline-name` on
 *  the element or the nearest ancestor that declares it, its axis and
 *  inset the ones at the name's place in their lists — or, where an
 *  ancestor's `timeline-scope` takes the name first, the last element in
 *  its subtree that declares it outside a scope of its own, and none where
 *  no element does (4.3). Where neither is found, the document is the
 *  scope, as though its root took every name (csswg-drafts#7759). */
function namedTimeline(
  tree: BoxTree,
  el: Element,
  name: string,
): NamedTimeline | null {
  for (let at: Element | null = el; at;) {
    const style = tree.styles.get(at)?.style;
    if (style) {
      const own = declaredTimeline(at, style, name);
      if (own) return own;
      if (scopes(style, name)) return scopedTimeline(tree, at, name);
    }
    const parent = flatParentOf(at);
    at = parent && isElement(parent) ? parent : null;
  }
  return scopedTimeline(tree, null, name);
}

interface NamedTimeline {
  el: Element;
  view: boolean;
  axis: string;
  inset: readonly [Len, Len];
}

/** Whether a style's `timeline-scope` takes a name. */
function scopes(style: ComputedStyle, name: string): boolean {
  const scope = style.timelineScope;
  return (
    scope === 'all' || (scope !== 'none' && scope.split(', ').includes(name))
  );
}

/** The timeline an element declares by a name, a scroll's before a view's
 *  and a later place in a list before an earlier (4.3). */
function declaredTimeline(
  at: Element,
  style: ComputedStyle,
  name: string,
): NamedTimeline | null {
  const scroll = style.scrollTimelineName.split(', ').lastIndexOf(name);
  if (scroll >= 0) {
    const axes = style.scrollTimelineAxis.split(', ');
    return {
      el: at,
      view: false,
      axis: axes[scroll % axes.length],
      inset: ['auto', 'auto'],
    };
  }
  const view = style.viewTimelineName.split(', ').lastIndexOf(name);
  if (view >= 0) {
    const axes = style.viewTimelineAxis.split(', ');
    const insets = style.viewTimelineInset;
    return {
      el: at,
      view: true,
      axis: axes[view % axes.length],
      inset: insets[view % insets.length],
    };
  }
  return null;
}

/** The timeline a `timeline-scope` on `scope` — or the document, for
 *  null — makes of a name: the last element under it in tree order that
 *  declares the name, where neither it nor an element between them has a
 *  scope of the name of its own, which keeps it from outside. */
function scopedTimeline(
  tree: BoxTree,
  scope: Element | null,
  name: string,
): NamedTimeline | null {
  let found: NamedTimeline | null = null;
  for (const [el, entry] of tree.styles) {
    if (el === scope) continue;
    const style = entry.style;
    // most elements declare no timeline, and are passed over cheaply
    if (
      style.scrollTimelineName === 'none' &&
      style.viewTimelineName === 'none'
    ) {
      continue;
    }
    const timeline = declaredTimeline(el, style, name);
    if (!timeline) continue;
    let under = scope === null;
    for (
      let at: AnyNode | null = el;
      at && isElement(at);
      at = flatParentOf(at)
    ) {
      if (at === scope) {
        under = true;
        break;
      }
      const style = tree.styles.get(at)?.style;
      if (style && scopes(style, name)) {
        under = false;
        break;
      }
    }
    if (under) found = timeline;
  }
  return found;
}

/**
 * How sticky positioning moves a view timeline's subject along an axis
 * (Scroll-driven Animations 1, 3.2): how far the sticky boxes from it up to
 * its scroller have moved it now (`shift`), and how far each can move it
 * at most toward the scrollport's start (`up`) — one with an end inset, as
 * far as its containing block lets its margin box go back — and toward its
 * end (`down`), one with a start inset, as far on. A subject held at the
 * top of a section is seen from where it would enter held at the
 * section's top to where it would leave carried to its foot, as Blink and
 * WebKit have it.
 */
function stickyReach(
  box: Box,
  scroller: Box | null,
  down: boolean,
): { shift: number; up: number; down: number } {
  let shift = 0;
  let up = 0;
  let on = 0;
  for (let at: Box | null = box; at && at !== scroller; at = at.parent) {
    if (at.style.position !== 'sticky' || at.kind === 'inline') continue;
    const stuck = STUCK.get(at);
    const moved = stuck ? (down ? stuck[1] : stuck[0]) : 0;
    shift += moved;
    let cb = at.parent;
    while (cb && cb.kind === 'inline') cb = cb.parent;
    if (!cb) continue;
    const st = at.style;
    const rest = (down ? at.y : at.x) - moved;
    const size = down ? at.height : at.width;
    const cbAt = down ? cb.contentY : cb.contentX;
    const cbEnd = cbAt + (down ? cb.contentHeight : cb.contentWidth);
    if ((down ? st.bottom : st.right) !== AUTO) {
      up += Math.max(0, rest - (down ? at.marginTop : at.marginLeft) - cbAt);
    }
    if ((down ? st.top : st.left) !== AUTO) {
      on += Math.max(
        0,
        cbEnd - (rest + size + (down ? at.marginBottom : at.marginRight)),
      );
    }
  }
  return { shift, up, down: on };
}

/** The scroll container a box is scrolled by: the nearest one around it,
 *  or null for the pane the document is in. */
function nearestScroller(box: Box): Box | null {
  for (let at = box.parent; at; at = at.parent) {
    if (isScroller(at)) return at;
  }
  return null;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

/** Whether two intrinsic sizes are one. */
function sameIntrinsic(a: Box['intrinsic'], b: Box['intrinsic']): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.width === b.width &&
      a.height === b.height &&
      a.missing === b.missing &&
      a.ratio === b.ratio)
  );
}

/** Whether two sizes of an image are within a CSS pixel of each other, each
 *  way: `s` device pixels. */
function closeIntrinsic(
  a: Box['intrinsic'],
  b: NonNullable<Box['intrinsic']>,
  s: number,
): boolean {
  return (
    !!a &&
    Math.abs(a.width - b.width) <= s &&
    Math.abs(a.height - b.height) <= s
  );
}

/**
 * Whether a replaced box is the size its style names whatever its image's
 * is: a width and a height that are lengths, as an `<img>`'s attributes
 * make them, where nothing takes either as a share or a suggestion. A
 * percentage is a share of something a shrink-to-fit width is measured
 * from the image to find, and a flex or grid item's automatic minimum is
 * its content's size (CSS Flexbox 1, 4.5).
 */
function sizedAnyway(box: Box): boolean {
  const { width, height } = box.style;
  if (typeof width !== 'number' || typeof height !== 'number') return false;
  const parent = box.parent;
  return !parent || (parent.kind !== 'flex' && !parent.style.grid);
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
      p.colorScheme !== q.colorScheme ||
      p.opacity !== q.opacity ||
      p.placeholderColor !== q.placeholderColor ||
      p.atViewport !== q.atViewport ||
      p.held !== q.held ||
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
      p.held !== q.held ||
      p.autoPlay !== q.autoPlay ||
      p.loop !== q.loop ||
      p.muted !== q.muted ||
      p.controls !== q.controls ||
      p.label !== q.label ||
      p.paused !== q.paused ||
      p.volume !== q.volume ||
      p.playbackRate !== q.playbackRate ||
      p.seek?.count !== q.seek?.count ||
      !sameClip(p.clip, q.clip) ||
      !sameClip(p.over, q.over)
    ) {
      return false;
    }
  }
  return true;
}

function sameEmbedded(a: EmbeddedRect[], b: EmbeddedRect[]): boolean {
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
      p.radius !== q.radius ||
      p.clipRadius !== q.clipRadius ||
      p.opacity !== q.opacity ||
      p.hidden !== q.hidden ||
      p.zoom !== q.zoom ||
      p.atViewport !== q.atViewport ||
      p.held !== q.held ||
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

/** The element a caret at a DOM boundary point is in: a text node's
 *  parent, or the element the point is between the children of. */
function caretElement(point: {
  node: AnyNode;
  offset: number;
}): Element | null {
  if (isElement(point.node)) return point.node;
  const parent = point.node.parent;
  return isElement(parent) ? parent : null;
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
  // up to a box in the top layer, which nothing around it moves
  for (let at = from; at; at = at.topLayer ? null : at.parent) {
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
    // on its own baseline, which `vertical-align` may raise off the line's:
    // a line says so of the text on it, and a band of no width is a box
    // with nothing on the line to say it of
    const raised = !band.width || SHIFTED_LINES.has(line);
    const baseline = line.y + line.baseline - (raised ? raiseOn(line, box) : 0);
    const top = baseline - face.ascent - box.padTop - box.borderTop;
    const bottom = baseline + face.descent + box.padBottom + box.borderBottom;
    bands[i] = { x: band.x, y: top, width: band.width, height: bottom - top };
  }
}

/** How far `vertical-align` raises an inline box's baseline off its line's:
 *  by what was noted of it, or of the nearest box around it, for one with
 *  no text for anything to be noted of. Nothing is noted of a box lowered
 *  back to the line's baseline, which goes for what is in it too. */
function raiseOn(line: LineBox, box: Box): number {
  for (let at: Box | null = box; at?.kind === 'inline'; at = at.parent) {
    const raise = LINE_BOX_RAISES.get(line)?.get(at) ?? BOX_RAISES.get(at);
    if (raise !== undefined) return raise;
    if (at.style.verticalAlign !== 'baseline') return 0;
  }
  return 0;
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
/** And the top layer's boxes over all of those, in its order. */
const HIT_TOP_LAYER = 4;

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
      // and one in the top layer over everything, after the walk
      if (child.topLayer) continue;
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
        if (!child.topLayer) enter(child, context, stack, clipped);
      }
    }
    // what is on a block's lines but for what the inline boxes that are
    // layers have of them, which is in each's layers rather than the
    // block's (`paintsApart`)
    if (node.lines) {
      walkLines(
        node.lines,
        apartFromLines(node.lines),
        context,
        stack,
        clipped,
      );
    } else if (node.kind === 'inline') {
      const own = apartOf(node);
      if (own) walkLines(own.lines, own.skip, context, stack, clipped);
    }
  };
  const walkLines = (
    lines: Iterable<LineBox>,
    skip: ReadonlySet<LineText | AtomicPlacement> | undefined,
    context: readonly number[],
    stack: readonly number[],
    clipped: readonly Box[],
  ): void => {
    for (const line of lines) {
      // its texts and atomics in the document's order, which paint
      // paints them in (`placesOn`): a word an inline-block is under is
      // what the pointer is over
      const shifted = tree.movedInline && SHIFTED_LINES.has(line);
      const texts =
        clipped.length === 0 &&
        (shifted || (y >= line.y && y < line.y + line.height))
          ? line.texts
          : NO_TEXTS;
      let i = 0;
      for (const placed of line.atomics) {
        for (; i < placed.before && i < texts.length; i += 1) {
          if (!skip?.has(texts[i])) textAt(texts[i], line, shifted, context);
        }
        const atomic = placed.box;
        if (skip?.has(placed)) continue;
        if (atomic.parent && layered(atomic.parent, atomic)) continue;
        enter(atomic, [...context, HIT_INLINE, (order += 1)], stack, clipped);
      }
      for (; i < texts.length; i += 1) {
        if (!skip?.has(texts[i])) textAt(texts[i], line, shifted, context);
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
  // `visible`, are what each shows. A text a relative or a sticky inline box
  // moved is on its line's row moved with it, where it is drawn: on the row
  // it left, a span held at the top of the viewport was no target.
  const textAt = (
    text: LineText,
    line: LineBox,
    shifted: boolean,
    context: readonly number[],
  ): void => {
    const natural = text.layout.lines[text.layoutLine];
    if (!natural) return;
    const at = (order += 1);
    if (shifted) {
      const top = line.y + (TEXT_SHIFTS.get(text)?.y ?? 0);
      if (y < top || y >= top + line.height) return;
    }
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
  // The top layer over all of it, in its order (`topLayerBoxes`), each box
  // under none of the document's clips: a `::backdrop` is its dialog's to
  // the pointer, so a press anywhere around a modal dialog is the dialog's,
  // as it is in a browser, and nothing of the page under it is hovered.
  const top = topLayerBoxes(box);
  for (let k = 0; k < top.length; k += 1) {
    const key = [HIT_TOP_LAYER, k];
    enter(top[k], key, key, []);
  }
  if (hit) hit.text = viaText;
  return found;
}

const NO_TEXTS: LineText[] = [];
const NO_BOXES: readonly Box[] = [];
const NO_RECTS: Rect[] = [];

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

/** What a change of the pointer or the focus can restyle
 *  (`_stateReach`): the elements, and whether a rule at a shadow tree's
 *  edge tests the change, which the boxes are built again for. */
interface StateReach {
  reach: Set<Element>;
  edge: boolean;
  /** Whether a root is in `reach` without what is in it (`HOVER_SELF`):
   *  the restyle follows down from each element whose style came out other
   *  than it was, to what inherits from it. */
  follows: boolean;
}

/** How many elements a pointer move restyles in place before the document
 *  is built again instead: a link's subtree is a handful, and a compound
 *  that matches a container reaches everything in it. */
const HOVER_RESTYLE_LIMIT = 300;

/** How many times a build of subtrees starts again from the root around
 *  one that came out as no block in the flow (`_subtreeBuild`), before the
 *  whole document is built: each is a build of what the last one was. */
const SUBTREE_WIDENINGS = 3;
/** The share of the document's elements past which a change's seeds are
 *  built as a whole document (`_subtreeBuild`): GitHub's `<body>` holds a
 *  `:has()` that reaches all of it, and each of four widenings built nearly
 *  all of it before the whole build it came to. */
const SUBTREE_MOST = 0.7;

/**
 * Whether two `stylesheet` props hold the same sheets in the same order. An
 * array made again at each render is no change of them: `<Html scripts>`
 * merges the sheets a page adopted into the application's at every render,
 * and github.com, which adopts some, was styled whole at each of the forty
 * renders of its load, inside its scripts' tasks at their next layout read.
 */
function sameStylesheets(
  a: string | string[] | undefined,
  b: string | string[] | undefined,
): boolean {
  if (a === b) return true;
  const x = Array.isArray(a) ? a : a ? [a] : [];
  const y = Array.isArray(b) ? b : b ? [b] : [];
  return x.length === y.length && x.every((sheet, i) => sheet === y[i]);
}

/** Text that is more than white space: what `:blank` and `:empty` have
 *  held nothing but before a child came (`_appendedScope`). */
const NOT_BLANK = /[^ \t\n\f\r]/;

/** What a list of changes to the tree can restyle (`_changeScope`). */
interface ChangeScope {
  own: Set<Element>;
  boxes: boolean;
  drawings: Set<Element>;
  pseudo: 0 | 1 | 2;
  /** The elements each set of anchors has been asked about, which one
   *  answers alike for every change of a list (`spreadAnchors`), each by
   *  the fewest levels above what changed it was asked at. */
  anchored: Map<
    ChangeAnchors,
    { around: Map<Element, number>; beside: Map<Element, number> }
  >;
  /** Whether the document's sheets read as the cascade's were, asked once
   *  a list where a change is a sheet's element's (`_sheetsAsRead`). */
  sheetsAsRead?: boolean;
  /** Whether they read otherwise, and the cascade is to be made again
   *  before the build, which styles what the rules it adds can style
   *  besides `own` (`_sheetsAdded`). */
  sheets?: boolean;
  /** The elements whose boxes a change can make otherwise beside `own`:
   *  the one whose attribute changed, and what holds what came, went or
   *  changed (`_subtreeRoots`). */
  targets: Set<Element>;
  /** Of `targets`, those whose boxes can differ whatever their styles come
   *  to: what holds what came, went or changed, and the element of an
   *  attribute the boxes read (`_seedsThatMoved`). */
  always: Set<Element>;
  /** Whether a `tabindex` moved that leaves its element a focusable area,
   *  so that only which of them Tab reaches can differ. */
  stops?: boolean;
  /** Which pseudo-elements' rules a change to the tree can change the
   *  answer to, for `_seedsThatMoved`, as `pseudo` is an attribute's. */
  treePseudo: 0 | 1 | 2;
  /** For a stream's chunk (`_parsedChanges`): what holds what the parser
   *  put in or wrote on to — an element, or the document — by the first of
   *  its children it touched, from where on its boxes can differ and none
   *  before (`_subtreeRoots`). */
  tails?: Map<ParentNode, ChildNode>;
  /** The elements of a chunk an attribute of changed — a second `<body>`'s
   *  on the first — whose own boxes can differ: no tail of theirs. */
  altered?: Set<Element>;
  /** What a record of the list says was after each node it took out
   *  (`HtmlChange`'s `nextSibling`), for one taken out before it whose
   *  record names it there (`followersOf`). */
  gone?: Map<AnyNode, AnyNode | null>;
  /** For a change a script told of: what holds what came or went, by the
   *  first of its children from which on its boxes can differ — null for
   *  past the last, false where a record does not say — whose boxes before
   *  that are kept, as a stream's chunk's are (`tails`, `changedFrom`). */
  ends?: Map<ParentNode, ChildNode | null | false>;
}

/** The elements whose changes are changes to the cascade: a sheet's, what
 *  the root's colour scheme and the document's language are read from,
 *  and what every URL resolves against. */
const CASCADE_TAGS = new Set(['style', 'link', 'meta', 'base']);

/**
 * Whether a change of an attribute of one of `CASCADE_TAGS` is one to the
 * cascade: one of those its sheets, its pragmas and its base are read from
 * (`DocumentSource.facts`, `metaColorScheme`, `pragmaLanguage`) — a
 * `<style>`'s `media`, a sheet's `<link>`'s `href` and `media` and any
 * `<link>`'s `rel`, a pragma `<meta>`'s, before or after (`pragmaMeta`), a
 * `<base>`'s `href`. Any other is an attribute as any element's is: a
 * bundler marks the `<link>` it is loading (rspack's
 * `data-rspack-loading`), and GitHub sets its icon's `href` at every
 * change of scheme. Anything new read of these elements joins this, or a
 * change of it leaves the document as it was.
 */
function changesCascade(
  el: Element,
  name: string,
  oldValue: string | null,
): boolean {
  switch (tagOf(el)) {
    case 'style':
      return name === 'media';
    case 'link':
      return (
        name === 'rel' ||
        ((name === 'href' || name === 'media') && isSheetLink(el))
      );
    case 'meta':
      if (name === 'content') return pragmaMeta(el);
      if (name !== 'name' && name !== 'http-equiv') return false;
      return (
        pragmaMeta(el) ||
        pragmaMeta(el, name, (oldValue ?? '').trim().toLowerCase())
      );
    case 'base':
      return name === 'href';
    default:
      return false;
  }
}

/** Whether a `<link>` is a sheet's, as `DocumentSource.facts` reads it. */
function isSheetLink(el: Element): boolean {
  return (attr(el, 'rel') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .includes('stylesheet');
}

/** The attributes nothing reads but the cascade, where a selector tests
 *  them, and an inline style: a change of one builds no box where it
 *  changes no style. Everything else may be read by the boxes, a widget, a
 *  focus stop or a presentational hint. `role` and `aria-*` are written for
 *  assistive technology, and but for `aria-label`, which names a stop and a
 *  player, a selector is all that reads them here: a widget takes
 *  `aria-hidden` as it renders. `hidden` is the UA sheet's. `-rx-defined` is
 *  no attribute: it is a custom element's upgrade, which only `:defined`
 *  reads; nor is `-rx-modal`, a dialog going into the top layer or out,
 *  which only `:modal` reads — and the style it gives, which the boxes
 *  follow — nor `-rx-picker-open`, a `<select>`'s menu dropping or going,
 *  which only `:open` and `:closed` read; nor what a player tells of itself
 *  (`mediaSync`), nor a control's state, a custom element's or a direction
 *  a text turned (`controlsReached`). */
const STYLE_ONLY_ATTRIBUTE =
  /^(?:class|id|style|role|hidden|aria-(?!label$)[^]*|data-[^]*|on[a-z]+|-rx-(?:defined|modal|picker-open|paused|muted|seeking|buffering|stalled|form|state|dir))$/;

/** The node a change to an element's text starts from, for what its text
 *  decides: where a text was written or what holds what came or went, and
 *  around an element that took a `dir`, which a walk of its text passes
 *  over. */
function textChangedAt(change: HtmlChange): AnyNode | null {
  if (change.type === 'characterData') return change.target.parent;
  if (change.type === 'childList') return change.target;
  if (change.type === 'attributes' && change.attributeName === 'dir') {
    return change.target.parent;
  }
  return null;
}

/**
 * What a list of changes changed that no record says, as records of the
 * attributes nothing has that `:valid` and its kin and `:dir()` read: an
 * answer read from other elements than the one a change was made to
 * (`controlsReached`, `directionHolder`). None where no rule reads either,
 * so that a document with none pays nothing for it.
 */
function derivedChanges(
  changes: readonly HtmlChange[],
  unchanged: ReadonlySet<HtmlChange> | null,
  cascade: Cascade,
): HtmlChange[] {
  const controls = cascade.readsControls;
  const direction = cascade.readsDirection;
  if (!controls && !direction) return [];
  const reached = new Set<Element>();
  const turned = new Set<Element>();
  for (const change of changes) {
    if (unchanged?.has(change)) continue;
    if (controls) controlsReached(change, reached);
    if (direction) {
      const holder = textChangedAt(change);
      const around = holder && directionHolder(holder);
      if (around) turned.add(around);
    }
  }
  const told = (target: Element, attributeName: string): HtmlChange => ({
    type: 'attributes',
    target,
    attributeName,
  });
  return [
    ...[...reached].map((el) => told(el, '-rx-form')),
    ...[...turned].map((el) => told(el, '-rx-dir')),
  ];
}

/**
 * The attribute changes in a list that changed nothing: an attribute set to
 * what it was, or set and set back, as the first change to it says it was.
 * DOM makes a record for each — a `classList.remove` of a class the element
 * does not have, a `style.setProperty` of the value it holds — and a page
 * that writes them at every frame restyles nothing in a browser, which
 * compares. Null where none did.
 */
function unchangedAttributes(
  changes: readonly HtmlChange[],
): Set<HtmlChange> | null {
  let before: Map<Element, Map<string, string | null | undefined>> | null =
    null;
  for (const change of changes) {
    if (change.type !== 'attributes') continue;
    before ??= new Map();
    let names = before.get(change.target);
    if (!names) before.set(change.target, (names = new Map()));
    const name = change.attributeName.toLowerCase();
    if (!names.has(name)) names.set(name, change.oldValue);
  }
  if (!before) return null;
  let out: Set<HtmlChange> | null = null;
  for (const change of changes) {
    if (change.type !== 'attributes') continue;
    const name = change.attributeName.toLowerCase();
    const was = before.get(change.target)!.get(name);
    if (was === undefined || was !== (attr(change.target, name) ?? null)) {
      continue;
    }
    (out ??= new Set()).add(change);
  }
  return out;
}

/** Whether a node is in `document`, or in a shadow tree of an element that
 *  is. */
function inDocument(node: AnyNode, document: Document): boolean {
  let at: AnyNode | null = node;
  while (at) {
    if (at === document) return true;
    at = at instanceof ShadowRoot ? at.host : at.parent;
  }
  return false;
}

/** The outermost inline `<svg>` a node is inside, or null — not the root
 *  itself, whose own attributes size its box. */
function drawingAround(node: AnyNode): Element | null {
  let found: Element | null = null;
  for (let at = node.parent; at && isElement(at); at = at.parent) {
    if (tagOf(at) === 'svg') found = at;
  }
  return found;
}

/** The elements whose boxes a change scope can make otherwise: what it
 *  restyles, and what the changes were to (`_subtreeRoots`). */
/** Whether a stream's chunk puts in an element with an id, or anything in
 *  a drawing, which a drawing elsewhere may name (`_parsedChanges`). */
function namesAnew(changes: readonly HtmlChange[]): boolean {
  for (const change of changes) {
    if (change.type === 'attributes') {
      if (change.attributeName === 'id') return true;
      continue;
    }
    if (drawingAround(change.target) || tagOfNode(change.target) === 'svg') {
      return true;
    }
    if (change.type !== 'childList') continue;
    for (const node of change.addedNodes) {
      if (!isElement(node)) continue;
      const stack: Element[] = [node];
      while (stack.length) {
        const el = stack.pop()!;
        if (el.attribs.id !== undefined || tagOf(el) === 'svg') return true;
        for (const child of el.children)
          if (isElement(child)) stack.push(child);
      }
    }
  }
  return false;
}

/** An element's tag, or '' for any other node. */
function tagOfNode(node: AnyNode): string {
  return isElement(node) ? tagOf(node) : '';
}

/**
 * Two changes' tails as one (`_invalidate`): what holds what each touched,
 * from the first child either did — but for what one of them seeds as a
 * change of any kind to what it holds, which is no tail. The document's
 * own is never a seed, so it is never dropped: what it holds is told by
 * its tail alone.
 */
function mergeTails(
  seeds: ReadonlySet<Element>,
  tails: ReadonlyMap<ParentNode, ChildNode | null> | null,
  more: ReadonlySet<Element>,
  moreTails: ReadonlyMap<ParentNode, ChildNode | null> | null,
): Map<ParentNode, ChildNode | null> | null {
  if (!tails && !moreTails) return null;
  const out = new Map<ParentNode, ChildNode | null>();
  for (const [node, from] of tails ?? []) {
    if (more.has(node as Element) && !moreTails?.has(node)) continue;
    out.set(node, from);
  }
  for (const [node, from] of moreTails ?? []) {
    if (seeds.has(node as Element) && !tails?.has(node)) {
      out.delete(node);
      continue;
    }
    const had = out.get(node);
    if (had === undefined || tailAt(node, from) < tailAt(node, had)) {
      out.set(node, from);
    }
  }
  return out;
}

/** Where among what `node` holds a tail from `from` starts: past the last
 *  child for null, the end (`ChangeScope.ends`). */
function tailAt(node: ParentNode, from: ChildNode | null): number {
  return from === null ? node.children.length : node.children.lastIndexOf(from);
}

/** The tails a script's changes said (`ChangeScope.ends`), or null for
 *  none. */
function endsOf(scope: ChangeScope): Map<ParentNode, ChildNode | null> | null {
  if (!scope.ends) return null;
  const out = new Map<ParentNode, ChildNode | null>();
  for (const [node, from] of scope.ends)
    if (from !== false) out.set(node, from);
  return out.size ? out : null;
}

function seedsOf(scope: ChangeScope): Set<Element> {
  const seeds = new Set(scope.own);
  for (const el of scope.targets) seeds.add(el);
  return seeds;
}

/** Whether a node is in a shadow tree, whose sheets are bound to it by
 *  how they read: a change to one is a refresh of everything. */
function inShadowTree(node: AnyNode): boolean {
  for (let up: AnyNode | null = node; up; up = up.parent) {
    if (up instanceof ShadowRoot) return true;
  }
  return false;
}

/**
 * Whether a `<meta>` is one the cascade reads (`metaColorScheme`,
 * `pragmaLanguage`): a `name="color-scheme"` or an `http-equiv=
 * "content-language"` — as it is, or with `name` read as `value`, as it
 * was before a change of that attribute. Any other is an element like any:
 * the Guardian's scripts, Next.js's and npm's put in the `<meta>`s of a
 * page's social cards and referrer policy, and each restyled the whole
 * document.
 */
function pragmaMeta(el: Element, name?: string, value?: string): boolean {
  const read = (attribute: string): string =>
    attribute === name
      ? value!
      : (attr(el, attribute) ?? '').trim().toLowerCase();
  return (
    read('name') === 'color-scheme' || read('http-equiv') === 'content-language'
  );
}

/** What a node is, or holds, that the cascade reads, as bits: a sheet's
 *  element (`HELD_SHEET`) — a `<style>`, a sheet's `<link>`, and not the
 *  `<link rel="preload">` a page's scripts put in for every chunk they load
 *  — a pragma `<meta>` (`pragmaMeta`) or a `<base>` (`HELD_PRAGMA`), which
 *  ends the walk, and a shadow tree's host (`HELD_TREE`). */
function cascadeHeld(node: AnyNode): number {
  if (!isElement(node)) return HELD_NOTHING;
  let held = HELD_NOTHING;
  const stack: Element[] = [node];
  while (stack.length) {
    const el = stack.pop()!;
    const tag = tagOf(el);
    if (tag === 'base' || (tag === 'meta' && pragmaMeta(el))) {
      return HELD_PRAGMA;
    }
    if (tag === 'style' || (tag === 'link' && isSheetLink(el))) {
      held |= HELD_SHEET;
    }
    if (shadowRootOf(el)) held |= HELD_TREE;
    for (const child of el.children) if (isElement(child)) stack.push(child);
  }
  return held;
}

const HELD_NOTHING = 0;
const HELD_SHEET = 1;
const HELD_PRAGMA = 2;
const HELD_TREE = 4;

/** The elements of `CASCADE_TAGS` a sheet is read from. */
const SHEET_TAGS = new Set(['style', 'link']);

/** Whether a node coming or going changes what is drawn: anything but a
 *  comment, or an element nothing draws whatever the sheets say. A text
 *  of white space alone may be nothing too, but where it is, only layout
 *  knows. */
/** The elements the UA's sheet never draws, `display: none`, which a
 *  page's scripts put in and take out as they load: a seed of a subtree
 *  build of its own, styled where it is (`_subtreeRoots`). */
const UNDRAWN_TAGS = new Set([
  'script',
  'style',
  'link',
  'meta',
  'title',
  'base',
  'template',
]);

/**
 * Whether a node a change put in (`added`) or took out draws something: a
 * text does, and an element did where the last build styled it drawn — one
 * it did not style was under an element nothing draws, or never built. One
 * put in draws but where it is of a kind the UA's sheet never draws, and no
 * rule of the page draws it: a `<title>` a page set `display: inline`
 * draws its text.
 */
function draws(
  node: AnyNode,
  added: boolean,
  tree: BoxTree,
  cascade: Cascade,
): boolean {
  if (node.type === 'comment') return false;
  if (!isElement(node)) return true;
  if (!added) {
    const kept = tree.styles.get(node);
    return kept !== undefined && kept.style.display !== 'none';
  }
  if (!UNDRAWN_TAGS.has(tagOf(node))) return true;
  const parent = flatParentOf(node);
  const parentStyle = parent && tree.styles.get(parent)?.style;
  if (!parentStyle) return false;
  const inFlex =
    parentStyle.display === 'flex' || parentStyle.display === 'inline-flex';
  return cascade.styleFor(node, parentStyle, inFlex).display !== 'none';
}

/** Whether `el`, or the nearest element around it the last build styled,
 *  is `display: none` — or none is, outside the document. */
function undrawn(el: Element, tree: BoxTree): boolean {
  for (let at: AnyNode | null = el; at && isElement(at); at = at.parent) {
    const kept = tree.styles.get(at);
    if (kept) return kept.style.display === 'none';
  }
  return true;
}

/** An element's style and those of everything in it, out of `styles`. */
function forgetStyles(el: Element, styles: Map<Element, unknown>): void {
  if (!styles.delete(el)) return;
  for (const child of el.children) {
    if (isElement(child)) forgetStyles(child, styles);
  }
}

/** What is in `el` that `subjects` matches, into `into`: the elements in
 *  its tree, since no rule but one at a tree's edge, which reaches all
 *  that is in the element (`MutationRules.below`), styles across one. */
function addSubjects(
  el: Element,
  into: Set<Element>,
  subjects: (el: Element) => boolean,
): void {
  const stack: Element[] = [];
  for (const child of el.children) if (isElement(child)) stack.push(child);
  while (stack.length) {
    const at = stack.pop()!;
    if (subjects(at)) into.add(at);
    for (const child of at.children) if (isElement(child)) stack.push(child);
  }
}

/** An element and everything in it into `into`. */
function addSubtree(el: Element, into: Set<Element>, crossing = false): void {
  if (crossing) {
    addFlatSubtree(el, into);
    return;
  }
  const stack: Element[] = [el];
  while (stack.length) {
    const at = stack.pop()!;
    into.add(at);
    for (const child of at.children) if (isElement(child)) stack.push(child);
  }
}

/** `addSubtree` across shadow trees' edges, where a rule reaches across
 *  one (`Cascade.changesCrossTrees`): what is in an element in its tree,
 *  in the shadow tree it hosts, and, for a slot, what is assigned to it,
 *  which a `::slotted()` past the slot's own compound tests. */
function addFlatSubtree(el: Element, into: Set<Element>): void {
  const seen = new Set<Element>();
  const stack: Element[] = [el];
  while (stack.length) {
    const at = stack.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    into.add(at);
    for (const child of at.children) if (isElement(child)) stack.push(child);
    const root = shadowRootOf(at);
    if (root) {
      for (const child of root.children) {
        if (isElement(child)) stack.push(child);
      }
    }
    if (tagOf(at) === 'slot') {
      for (const child of flatChildrenOf(at)) {
        if (isElement(child)) stack.push(child);
      }
    }
  }
}

/** The elements and everything in them, or null past `limit` of them:
 *  what is in them in the tree and in the flat tree both, since what
 *  inherits from a host is its shadow tree, and from a slot what is
 *  assigned to it. */
function withDescendants(
  els: ReadonlySet<Element>,
  limit: number,
): Set<Element> | null {
  const out = new Set<Element>();
  const stack: Element[] = [...els];
  while (stack.length) {
    const at = stack.pop()!;
    if (out.has(at)) continue;
    out.add(at);
    if (out.size > limit) return null;
    for (const child of at.children) if (isElement(child)) stack.push(child);
    const flat = flatChildrenOf(at);
    if (flat !== at.children) {
      for (const child of flat) if (isElement(child)) stack.push(child);
    }
  }
  return out;
}

/**
 * The elements a change can restyle, by where a selector tests what
 * changed (`CHANGES_*`), into `own`: from `el`, whose attribute changed, or
 * whose children or text did where `holder` — for which a selector's
 * subject is `el` itself (`:empty`) or each of its children
 * (`:first-child`).
 */
function spreadChange(
  el: Element,
  bits: number,
  holder: boolean,
  own: Set<Element>,
  crossing = false,
  /** For a holder, whether its children and what is in them are reached
   *  as later siblings of what came or went (`TreeReach.kidsLater`), apart
   *  from its own later siblings (`CHANGES_LATER`). */
  kidsLater = holder && (bits & CHANGES_LATER) !== 0,
  /** What of what is in `el` a change reaches there can restyle
   *  (`AttributeReach.below`); null for all of it. */
  below: ((el: Element) => boolean) | null = null,
  /** And of its later siblings and what they hold
   *  (`AttributeReach.later`). */
  later: ((el: Element) => boolean) | null = null,
): void {
  if (bits & CHANGES_SELF) {
    own.add(el);
    if (holder) {
      for (const child of el.children) if (isElement(child)) own.add(child);
    }
  }
  if (bits & CHANGES_BELOW) {
    if (below) addSubjects(el, own, below);
    else addSubtree(el, own, crossing);
  }
  if (holder && kidsLater && !(bits & CHANGES_BELOW)) {
    for (const child of el.children) {
      if (isElement(child)) addSubtree(child, own, crossing);
    }
  }
  if (bits & CHANGES_LATER) {
    for (let s = el.next; s; s = s.next) {
      if (!isElement(s)) continue;
      if (!later) {
        addSubtree(s, own, crossing);
        continue;
      }
      if (later(s)) own.add(s);
      addSubjects(s, own, later);
    }
  }
}

/** `spreadChange` for what the top of a shadow tree holds changing: each
 *  thing in it is a selector's subject as a holder's children are. */
function spreadRootChange(
  root: ShadowRoot,
  bits: number,
  own: Set<Element>,
  crossing = false,
  kidsLater = (bits & CHANGES_LATER) !== 0,
): void {
  for (const child of root.children) {
    if (!isElement(child)) continue;
    if (bits & (CHANGES_BELOW | CHANGES_LATER) || kidsLater) {
      addSubtree(child, own, crossing);
    } else if (bits & CHANGES_SELF) own.add(child);
  }
}

/**
 * What a change reaches through the `:has()`s whose answer it can change
 * (`anchors`), into `scope.own`: from each element that may be one's, and
 * matches the compound the `:has()` is in, as that compound's place in its
 * selector says (`spreadChange`). Those are the elements around `el` —
 * itself and its ancestors, which a `:has()` looks down from; the earlier
 * siblings of each, where an argument starts at a sibling; and what a
 * holder holds, which were the earlier siblings of what came or went.
 * Where what changed is read inside the element too, as `:lang()` and
 * `:disabled` read theirs, one inside it may be one's as well, which a
 * change of such an attribute restyles with everything else in it — none
 * is style-only. False where a compound cannot be asked.
 *
 * A `:has()` asks what is in its element's tree, so the walk up stops at
 * the top of one — and one that asks only a few levels down
 * (`HasAnchor.levels`) is asked only of the elements that far above what
 * changed: the holder is one above what came or went, an element none
 * above its own attribute, and a drawing at least none above what changed
 * inside it. Each element is asked once a list of changes for each set of
 * anchors (`scope.anchored`), which answers it alike every time it is
 * asked from as far or further.
 */
function spreadAnchors(
  el: Element | ShadowRoot,
  holder: boolean,
  anchors: ChangeAnchors,
  scope: ChangeScope,
  crossing: boolean,
): boolean {
  let asked = scope.anchored.get(anchors);
  if (!asked) {
    asked = { around: new Map(), beside: new Map() };
    scope.anchored.set(anchors, asked);
  }
  const { around, beside } = asked;
  const from = (at: Element, distance: number, aside = false): boolean => {
    // what is asked of what is around a change holds for what is beside
    // it, and not the other way round
    const was = around.get(at);
    if (was !== undefined && was <= distance) return true;
    if (aside) {
      const had = beside.get(at);
      if (had !== undefined && had <= distance) return true;
      beside.set(at, distance);
    } else around.set(at, distance);
    const subjects = new Set<(el: Element) => boolean>();
    const bits = anchors.at(at, distance, aside, subjects);
    if (bits === null) return false;
    if (bits) spreadChange(at, bits, false, scope.own, crossing);
    if (subjects.size && !(bits & CHANGES_BELOW)) {
      const named = [...subjects];
      addSubjects(at, scope.own, (el) => named.some((one) => one(el)));
    }
    return true;
  };
  const top = el instanceof ShadowRoot ? null : el;
  let distance = holder ? 1 : 0;
  for (
    let at: AnyNode | null = top;
    at && isElement(at) && distance <= anchors.levels;
    at = at.parent, distance += 1
  ) {
    if (!from(at, distance)) return false;
    if (!anchors.siblings) continue;
    for (let s = at.prev; s; s = s.prev) {
      if (isElement(s) && !from(s, distance, true)) return false;
    }
  }
  if (holder && anchors.siblings) {
    for (const child of el.children) {
      if (isElement(child) && !from(child, 0, true)) return false;
    }
  }
  return true;
}

/** How long the content under a still pointer has to have stopped moving
 *  before the hover is asked for again (`HtmlViewNode._holdHover`): a
 *  tenth of a second, which is what WebKit waits after a scroll before it
 *  sends the mouse move that updates its own. */
const HOVER_REST_MS = 100;

/** How late the paint a frame of the animations asked for may be before
 *  the next waits for it — two frames: one ahead of the window is a
 *  pipeline (`_frame`). */
const PAINT_LATE_MS = 32;

/** How long a frame of the animations waits for an owed paint before it is
 *  made anyway (`_frame`). */
const PAINT_WAIT_MS = 250;

const timers = globalThis as {
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
  queueMicrotask?(fn: () => void): void;
  performance?: { now?(): number };
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

/** How many page tasks are running, nested, and the clock they replaced
 *  (`holdAnimationClock`). */
let clockHolds = 0;
let clockBeforeHold: (() => number) | null = null;

/**
 * A page's task begins: the animations' clock stands still until it ends
 * (`releaseAnimationClock`), as a browser's document timeline does for a
 * task (Web Animations 1, 4.1.1). A page that sets an animation's time and
 * reads a style straight after reads the style at that time.
 */
export function holdAnimationClock(): void {
  if (clockHolds++ > 0) return;
  const held = animationClock.now();
  clockBeforeHold = animationClock.now;
  animationClock.now = () => held;
}

/** The page's task is over: the clock runs again. */
export function releaseAnimationClock(): void {
  if (clockHolds === 0 || --clockHolds > 0) return;
  if (clockBeforeHold) animationClock.now = clockBeforeHold;
  clockBeforeHold = null;
}

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

/**
 * The clock what is owed runs on (`_owe`), as `hoverClock` is a held
 * hover's: through `globalThis`, unref'd, and exported for a test to hold.
 */
export const owedClock = {
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

/** What a box is owed (`HtmlViewNode._owe`): `up` is the boxes the same run
 *  has gone up from, for `forgetSizesIn`. */
type OwedWork = (box: Box, up: Set<Box>) => void;

/** An ask of everything owed (`_settleOwed`). */
const OWED_ALL = -1;

/** The boxes made from a face as they are built, and not as they are laid
 *  out, which a face that came builds again: a widget's size, a drawing's
 *  text. */
const READS_FACE_AS_BUILT: ReadonlySet<string> = new Set([
  'input',
  'textarea',
  'select',
  'button',
  'svg',
]);

/** Whether a box made from a face as it is built has anything set in one:
 *  a widget, or a drawing with text in it, of the icons a page is full of. */
function setsText(box: Box): boolean {
  if (box.replaced !== 'svg') return true;
  const stack: AnyNode[] = [...(box.el?.children ?? [])];
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    if (tagOf(node) === 'text') return true;
    for (const child of node.children) stack.push(child);
  }
  return false;
}

/**
 * The box whose layout sets what `box` holds, for a run of text or a marker:
 * the block its lines are in, or the table or the multicol container around
 * that, which are laid out as one.
 */
function ownerOf(box: Box, known: Map<Box, Box>): Box {
  let block = box;
  while (
    block.parent &&
    (block.kind === 'text' ||
      block.kind === 'break' ||
      block.kind === 'inline' ||
      isInlineLevel(block))
  ) {
    block = block.parent;
  }
  const kept = known.get(block);
  if (kept) return kept;
  let owner = block;
  for (let at: Box | null = block; at; at = at.parent) {
    if (at.kind === 'table' || at.style.columns) owner = at;
  }
  known.set(block, owner);
  return owner;
}

/** How long after a scroll or a key what is owed waits to run. */
const OWED_QUIET_MS = 150;
/** How long a slice of what is owed is to take, and the least rest after
 *  it: past a frame at 60Hz neither a scroll nor a key waits on one. */
const OWED_SLICE_MS = 10;
const OWED_REST_MS = 16;
/** The most slices what is owed is cut into from any one, and how few
 *  where a slice took `OWED_LONG_MS`. */
const OWED_SLICES = 12;
const OWED_LONG_MS = 40;
const OWED_FEW = 3;
/** How often the pane is told how tall a document that is being set again
 *  has come to be: each telling repaints all of what it shows. */
const OWED_MEASURE_MS = 250;
/** How many viewports either side of what can be seen count as near. */
const OWED_NEAR = 1;

/**
 * How near what can be seen, in CSS pixels, a lazy image has to be to be
 * asked for, across and down, and from the viewport of each box around it
 * that scrolls. HTML leaves it to the browser: this is Chrome's on a fast
 * connection, Firefox's is 600 down alone and WebKit's the viewport. It
 * buys the time an image takes to arrive: at 1,250 a fling of 3,000 pixels
 * a second finds it there if it took 400 ms.
 */
const LAZY_NEAR_PX = 1250;

/**
 * The same until the document's `load`, whose boxes are a guess. Its first
 * layout comes before its head's scripts, and Wikipedia's menus, open until
 * one of them runs, stood 3,500 pixels of them above the first image of an
 * article, so nothing the reader was about to see was near for a second.
 * At `LAZY_NEAR_PX` what a viewport shows was done a fifth to a third later
 * than with every image asked for at once, on Wikipedia, BBC and the
 * Guardian, and at this no later.
 */
const LAZY_LOADING_PX = 4000;

/** How far the pane moves between walks of what waits (`_askNear`): a
 *  quarter of how near an image has to be, which is too little to come. */
const LAZY_STEP_PX = 300;

/** A distance as an observer's `scrollMargin`. */
const marginsOf = (value: number): readonly MarginLength[] =>
  new Array<MarginLength>(4).fill({ value, percent: false });
const LAZY_MARGINS = marginsOf(LAZY_NEAR_PX);
const LAZY_LOADING_MARGINS = marginsOf(LAZY_LOADING_PX);

/** The `<img>`s of the documents `<foreignObject>`s hold. */
function foreignImages(foreign: ReadonlyMap<Element, ForeignObject>) {
  const images = new Set<Element>();
  for (const { tree } of foreign.values()) {
    for (const box of tree.images) if (box.el) images.add(box.el);
  }
  return images;
}

/**
 * The clock an editing host's caret blinks on (`_caretMoved`), as
 * `hoverClock` is a held hover's: through `globalThis`, unref'd, and
 * exported for a test to hold — on the real clock, a runner slow enough to
 * spend a blink between two reads of the screen finds the caret turned.
 */
export const caretClock = {
  arm(step: () => void, ms: number): unknown {
    const handle = timers.setTimeout?.(step, ms) ?? null;
    (handle as { unref?(): void } | null)?.unref?.();
    return handle;
  },
  disarm(handle: unknown): void {
    timers.clearTimeout?.(handle);
  },
};

/** How wide a caret is, in logical pixels: what core's `<textinput>`
 *  draws its at, so the two agree on one screen. */
const CARET_WIDTH = 1.5;

/**
 * The clock the wheel rests on before a snap container snaps
 * (`_snapUserScroll`), as `hoverClock` is a held hover's: through
 * `globalThis`, unref'd, and exported for a test to hold.
 */
export const snapClock = {
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
 * The clock the element's own work is timed on, for a drag it cannot keep
 * up with (`_noteFrame`): through `globalThis`, and exported for a test to
 * make a frame cost what it says.
 */
export const frameClock = {
  now(): number {
    return timers.performance?.now?.() ?? Date.now();
  },
};

/** What the element's own work in a frame of a drag may come to before the
 *  drag is drawn cheaper (`_noteFrame`): most of a frame at 60Hz, where
 *  core's layout and the window's own paint and present take the rest. */
const FRAME_BUDGET_MS = 12;

/** How long the hand that drags a window's edge holds still before a drag
 *  drawn cheaper is drawn as at rest (`_behind`): longer than the gaps a
 *  slow drag's steps come at, so that it is not drawn one way and the
 *  other at each of them. */
const DRAG_REST_MS = 300;

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
  // drawn only where an editing host's caret is (`_paintCaret`)
  'caretColor',
  // what `getComputedStyle` reads a colour field in, which draws nothing
  ...COLOR_SOURCE_FIELDS,
  // and the images and families as written, whose drawing is the fields
  // beside them
  'backgroundImageText',
  'fontFamilyText',
  // the shape a corner's radii are drawn in, inside the border box
  'cornerShape',
  // and the rules in a container's gaps, drawn under what it holds
  'columnRule',
  'rowRule',
  'ruleOverlap',
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
  /** Which lengths changed besides, of those it was told to take
   *  (`BOX_LENGTHS`, `FONT_LENGTHS`), which the layout that follows lays
   *  out. */
  lengths: number;
}

/** A `HoverChange` of nothing yet, which `hoverChange` copies and fills. */
const NO_HOVER_CHANGE: HoverChange = {
  ink: false,
  reach: false,
  order: false,
  move: false,
  fade: false,
  lengths: 0,
};

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

/** The most boxes a restyle in place works the ink of out one at a time
 *  (`inkAfterMove`), each going up through what is around it: past this, one
 *  walk of the tree is the cheaper. */
const MOST_MOVED_APART = 32;

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
  ...COLOR_SOURCE_FIELDS,
  'backgroundImageText',
  'fontFamilyText',
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

/** Whether a box fixed to the viewport fills anything with an opaque
 *  ground (`opaqueWithin`), and so may come over a widget as the page
 *  scrolls: once a tree. */
const FIXED_GROUND = new WeakMap<BoxTree, boolean>();

function fixedGround(tree: BoxTree): boolean {
  let known = FIXED_GROUND.get(tree);
  if (known === undefined) {
    known = false;
    for (const box of FIXED_BOXES.get(tree) ?? NO_BOXES) {
      const all = {
        x: box.boundsX,
        y: box.boundsY,
        width: box.boundsWidth,
        height: box.boundsHeight,
      };
      if (opaqueWithin(box, all).length) {
        known = true;
        break;
      }
    }
    FIXED_GROUND.set(tree, known);
  }
  return known;
}

/**
 * Whether a restyle in place may have put a box over a control's widget,
 * or taken one from over it, which only a box that fills it with an opaque
 * background does (`controlRectsOf`): shown or hidden, faded or brought to
 * full opacity, given an opaque background or a translucent one, or moved
 * among its layers. A fade between two opacities below 1 is none of them,
 * so an animation's frames ask nothing.
 */
function coverChange(was: ComputedStyle, now: ComputedStyle): boolean {
  if (was === now) return false;
  return (
    was.visibility !== now.visibility ||
    was.opacity >= 1 !== now.opacity >= 1 ||
    was.zIndex !== now.zIndex ||
    (was.backgroundColor !== now.backgroundColor &&
      opaqueGround(was) !== opaqueGround(now))
  );
}

function opaqueGround(style: ComputedStyle): boolean {
  const bg = style.backgroundColor;
  return !!bg && !isTransparent(bg) && alphaOf(inkColor(bg, style.color)) === 1;
}

/**
 * The lengths of a box's style its layout reads as it lays the box out
 * (`layoutBox`, `resolveEdges`), and the factors a flex item grows and
 * shrinks by, which nothing builds a box from: a change of them alone is
 * laid out again in place where a layout follows (`_restyleInPlace`'s
 * `lengths`). A splitter sets its panes' `flex` at every step of a drag —
 * joshwcomeau.com's playgrounds do — and each built the panes' boxes. Not a
 * font's size or a line's height, which a block's runs are made of, and
 * not a sizing keyword, which says how the box is measured.
 */
const LENGTH_FIELDS: ReadonlySet<string> = new Set([
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'top',
  'right',
  'bottom',
  'left',
  'rowGap',
  'columnGap',
  'flexBasis',
  'flexGrow',
  'flexShrink',
]);

/**
 * The lengths a block's runs and lines are made of — its text's size, its
 * lines' height, the first line's indent — which `collect` reads off each
 * box's style as it lays a paragraph out, so that a box laid out again
 * after taking them sets its text at them (`_restyleInPlace`'s `lengths`).
 * Fluid type is one in `vw`: Bootstrap's headings are
 * `calc(1.3rem + .6vw)`, and every step of a drag built the boxes.
 */
const FONT_FIELDS: ReadonlySet<string> = new Set([
  'fontSize',
  'lineHeight',
  'textIndent',
]);

/** A difference in `LENGTH_FIELDS` (`lengthKind`). */
const BOX_LENGTHS = 1;
/** A difference in `FONT_FIELDS`. */
const FONT_LENGTHS = 2;

/** Which lengths a field of a style is: `BOX_LENGTHS`, `FONT_LENGTHS`, or 0
 *  for none. */
function lengthKind(key: string): number {
  if (LENGTH_FIELDS.has(key)) return BOX_LENGTHS;
  return FONT_FIELDS.has(key) ? FONT_LENGTHS : 0;
}

/** Which lengths two styles of one element differ in, whatever else they
 *  differ in. */
function lengthsThatDiffer(was: ComputedStyle, now: ComputedStyle): number {
  const a = was as unknown as Record<string, unknown>;
  const b = now as unknown as Record<string, unknown>;
  let change = 0;
  for (const key in b) {
    if (!sameValue(a[key], b[key])) change |= lengthKind(key);
  }
  return change;
}

/**
 * How two styles of one element differ, for a restyle in place: null where
 * they do not, a `HoverChange` where every difference is ink, how far ink
 * reaches, a `z-index` that stays a stacking context's, an opacity or a
 * visibility, or a transform — none of which moves anything but the box
 * and what it holds (CSS Transforms 1: a transform does not affect layout)
 * — and false where anything else differs. Where a layout follows, the
 * kinds of length in `lengths` (`BOX_LENGTHS`, `FONT_LENGTHS`) are taken as
 * well, beside any of that, and said in `HoverChange.lengths`: Apple's
 * gallery draws a slide's `::after` `width` in `vw`, turned by a `translate`
 * in `vw`, and each step of a drag built the boxes for the two together.
 */
function hoverChange(
  was: ComputedStyle,
  now: ComputedStyle,
  lengths = 0,
): HoverChange | null | false {
  const a = was as unknown as Record<string, unknown>;
  const b = now as unknown as Record<string, unknown>;
  // an absolute box's static position, which what its `display` was before
  // it was made a block says, and which is in no field of a style
  if (INLINE_BEFORE_ABSOLUTE.has(was) !== INLINE_BEFORE_ABSOLUTE.has(now)) {
    return false;
  }
  let change: HoverChange | null = null;
  for (const key in b) {
    // the sets are shared by what made them (`Cascade._customFor`), and
    // within a build they are one object where they are the same; a
    // restyle makes the root's again, and Next.js's, the same set, sent
    // every restyle in place that reached it down through all of the page
    if (key === 'custom') {
      if (!sameValue(a[key], b[key])) {
        change ??= { ...NO_HOVER_CHANGE };
      }
      continue;
    }
    // what an element's animations and transitions leave is in its other
    // fields already (`Cascade._computeStyle`); the lists themselves draw
    // nothing
    if (key === 'animations' || key === 'transitions') {
      if (!sameValue(a[key], b[key])) {
        change ??= { ...NO_HOVER_CHANGE };
      }
      continue;
    }
    if (sameValue(a[key], b[key])) continue;
    change ??= { ...NO_HOVER_CHANGE };
    const kind = lengths && lengthKind(key);
    if (kind & lengths) {
      change.lengths |= kind;
      continue;
    }
    change.ink = true;
    if (PAINT_ONLY.has(key)) continue;
    if (key === 'opacity') {
      // a group to fade before and after, or none either time: the order
      // its layers paint in is the same (`stacksLayers`) — as it is where
      // the opacity is named in `will-change` both times, which one in
      // transition or animated is, a layer of its context at 1 as well.
      // Otherwise the box became a stacking context or stopped being one,
      // which moves no box and contains nothing out of the flow: the order
      // is worked out again from the styles, as a `z-index`'s is
      // (`stackLayers`). BBC's and Bootstrap's `a:hover{opacity:.8}` built
      // the page again a move.
      if (
        (a[key] as number) < 1 !== (b[key] as number) < 1 &&
        !(was.willChange & now.willChange & WILL_STACK)
      ) {
        change.order = true;
      }
      change.fade = true;
      continue;
    }
    if (key === 'filter' || key === 'backdropFilter') {
      // a stacking context and the containing block of what is out of the
      // flow in it before and after, or neither — or a filter named in
      // `will-change` both times, which one in transition or animated is:
      // only how the group's pixels, or what is behind it, are drawn changes
      // (`paintFiltered`, `paintBackdrop`). Apple's cards fade a frosted
      // panel in as they scroll, and every step built them
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

/** Whether a rectangle has a point in it or on its edge. */
function holdsPoint(rect: Rect, at: { x: number; y: number }): boolean {
  return (
    at.x >= rect.x &&
    at.y >= rect.y &&
    at.x <= rect.x + rect.width &&
    at.y <= rect.y + rect.height
  );
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

/** A part offered above the document, in the order it is painted: one
 *  `Made` of an element, or the shadows of a box (`shadowPartOf`). */
interface Top {
  order: readonly number[];
  made: Made | null;
  shadow: { part: ShadowPart; key: string } | null;
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
  /** Where the build kept `was`, which is `now` then: what it drew before
   *  the layout (`_rebuildFrame`). */
  drew?: KeptInk;
}

/** What a box drew before a layout that may move it: its ink as a repaint
 *  takes it (`_inkOf`), and its bounds. */
interface KeptInk {
  ink: Rect | null;
  bounds: Rect;
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
    if (drawsNothing(box)) continue;
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

/** What a change of children put in and took out: none, for any other. */
/**
 * The first of a holder's children from which a change of what it holds
 * can make its boxes otherwise, as the record says: what came, and what
 * was after what went (`followersOf`'s `nextSibling`, followed through
 * `gone`) — null for past the last child, and undefined where the record
 * does not say, or the tree since moved what it names out of the holder.
 */
function changedFrom(
  change: HtmlChange,
  parent: ParentNode,
  gone?: ReadonlyMap<AnyNode, AnyNode | null>,
): ChildNode | null | undefined {
  if (change.type !== 'childList') return undefined;
  const kids = parent.children;
  let at = kids.length;
  for (const node of change.addedNodes) {
    if (node.parent !== parent) continue;
    const index = kids.indexOf(node as ChildNode);
    if (index < at) at = index;
  }
  if (change.removedNodes.length) {
    let next = change.nextSibling;
    if (next === undefined) return undefined;
    const seen = new Set<AnyNode>();
    while (next && next.parent !== parent && gone?.has(next)) {
      if (seen.has(next)) return undefined;
      seen.add(next);
      next = gone.get(next)!;
    }
    if (next) {
      if (next.parent !== parent) return undefined;
      const index = kids.indexOf(next as ChildNode);
      if (index < at) at = index;
    }
  }
  return at < kids.length ? kids[at] : null;
}

/** Whether a test of what an element holds or where it sits reaches `el`
 *  (`TreeTested`). */
function testedOf(tested: Tested, el: Element): boolean {
  return tested === true || (tested !== false && tested(el));
}

/**
 * The children a change of what `parent` holds reaches through the sibling
 * combinators (`TreeReach.siblings`), into `out`, walking them in order
 * from where it was, `from` (`followersOf`) — or from the first, where
 * where a child sits is read before one (`kidsLater`). A child whose
 * answer changed is a source: what came, what went, one whose place a
 * compound in `later` tests, and one reached. A `~` reaches each child
 * after a source it follows that it leads to from that; a `+`, the child
 * just after one, where it leads to that — and the child after where the
 * change was, where it follows the one before it, whose next that one
 * was. So `A + B ~ C` is followed through the `B` it reaches. Every child
 * after `from` where the rules say nothing.
 */
function siblingsReached(
  change: HtmlChange,
  parent: ParentNode,
  from: AnyNode | null,
  siblings: SiblingReach | null,
  later: Tested,
  out: Element[],
): void {
  if (!siblings) {
    for (let s = from; s; s = s.next) if (isElement(s)) out.push(s);
    return;
  }
  const trailsOf = (
    pairs: readonly SiblingPair[],
    el: Element,
    into: Set<Tested>,
  ): Set<Tested> => {
    for (const { lead, trail } of pairs) {
      if (testedOf(lead, el)) into.add(trail);
    }
    return into;
  };
  const ledTo = (trails: ReadonlySet<Tested>, el: Element): boolean => {
    for (const trail of trails) if (testedOf(trail, el)) return true;
    return false;
  };
  const added = new Set<AnyNode>(
    change.type === 'childList' ? change.addedNodes : [],
  );
  // what went, at `from`, and the child before where it was, whose next
  // it was
  const tildeFrom = new Set<Tested>();
  const plusFrom = new Set<Tested>();
  if (change.type === 'childList') {
    for (const node of change.removedNodes) {
      if (!isElement(node)) continue;
      trailsOf(siblings.tilde, node, tildeFrom);
      trailsOf(siblings.plus, node, plusFrom);
    }
  }
  if (from) {
    let before: AnyNode | null = from.prev;
    while (before && (added.has(before) || !isElement(before))) {
      before = before.prev;
    }
    if (before) trailsOf(siblings.plus, before as Element, plusFrom);
  }
  const tilde = new Set<Tested>();
  let plus = new Set<Tested>();
  let edge: Set<Tested> | null = null;
  for (
    let s: AnyNode | null = later === false ? from : parent.children[0];
    s;
    s = s.next
  ) {
    if (s === from) {
      for (const trail of tildeFrom) tilde.add(trail);
      edge = plusFrom;
    }
    if (!isElement(s)) continue;
    if (added.has(s)) {
      trailsOf(siblings.tilde, s, tilde);
      plus = trailsOf(siblings.plus, s, new Set());
      continue;
    }
    const reached: boolean =
      ledTo(tilde, s) || ledTo(plus, s) || (!!edge && ledTo(edge, s));
    edge = null;
    if (reached) out.push(s);
    const source: boolean = reached || (later !== false && testedOf(later, s));
    if (source) trailsOf(siblings.tilde, s, tilde);
    plus = source ? trailsOf(siblings.plus, s, new Set()) : new Set();
  }
}

/**
 * The first of a holder's children after where a change of what it holds
 * came or went, as the record says (`HtmlChange`'s `nextSibling`), and
 * before it, what came: null for none, where it was at the end, and
 * undefined where the record does not say, or the tree since moved what it
 * names out of the holder. What it names that the list took out since is
 * followed to what that one's record says was after it (`gone`): a page
 * that takes out its popups one after another names each the next.
 */
function followersOf(
  change: HtmlChange,
  parent: ParentNode,
  gone?: ReadonlyMap<AnyNode, AnyNode | null>,
): AnyNode | null | undefined {
  if (change.type !== 'childList') return undefined;
  let first: AnyNode | null = null;
  let at = Infinity;
  const consider = (node: AnyNode): boolean => {
    if (node.parent !== parent) return false;
    const index = parent.children.indexOf(node as ChildNode);
    if (index < at) {
      at = index;
      first = node;
    }
    return true;
  };
  for (const node of change.addedNodes) consider(node);
  if (change.removedNodes.length) {
    let next = change.nextSibling;
    if (next === undefined) return undefined;
    // each at most once, which a list that put one back between ends
    const seen = new Set<AnyNode>();
    while (next && next.parent !== parent && gone?.has(next)) {
      if (seen.has(next)) return undefined;
      seen.add(next);
      next = gone.get(next)!;
    }
    if (next !== null && !consider(next)) return undefined;
  }
  return first;
}

function changedNodes(change: HtmlChange): readonly AnyNode[] {
  if (change.type !== 'childList') return [];
  if (!change.removedNodes.length) return change.addedNodes;
  if (!change.addedNodes.length) return change.removedNodes;
  return [...change.addedNodes, ...change.removedNodes];
}

/** How far down a box's ink reaches (`computePaintBounds`): none, for one
 *  that draws nothing, whose bounds are at infinity. */
function inkBottom(box: Box): number {
  return box.boundsY === Infinity ? -Infinity : box.boundsY + box.boundsHeight;
}

/** A box as a layout left it, for an owed layout to be compared with
 *  (`HtmlViewNode._laidShapes`): where it is and how large, the lines it
 *  holds — the same array where nothing set them again — where its marker
 *  is, and its ink. */
interface LaidShape {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: LineBox[] | null;
  markerX: number;
  markerY: number;
  ink: Rect | null;
}

/** Every box of a tree as a layout left it, with the width it was laid out
 *  at and the size it came to. */
interface LaidShapes {
  tree: BoxTree;
  width: number;
  size: [number, number];
  boxes: Map<Box, LaidShape>;
}

/** How many boxes an owed layout may have reshaped before the whole
 *  element is claimed: their inks are one rect round them all by then
 *  (`_repaintInk`). */
const CLAIMED_SHAPES = 64;

/** A box's ink bounds, in the coordinates of the box it is in: null where
 *  it draws nothing. */
function boundsOf(box: Box): Rect | null {
  if (box.boundsY === Infinity) return null;
  if (!(box.boundsWidth > 0 && box.boundsHeight > 0)) return null;
  return {
    x: box.boundsX,
    y: box.boundsY,
    width: box.boundsWidth,
    height: box.boundsHeight,
  };
}

/**
 * Whether a layout moved, resized or set other lines in a box than `was`
 * says: its rect, where it has one laid out — a text's, a break's and an
 * inline box's are their block's lines — its lines where they are other
 * arrays and otherwise set, and its marker. A box laid out again where it
 * was, and as it was, is none: an aside a sticky box keeps from being kept
 * comes out the same at every layout.
 */
function reshaped(box: Box, was: LaidShape): boolean {
  if (
    box.kind !== 'text' &&
    box.kind !== 'break' &&
    hasRect(box) &&
    (box.x !== was.x ||
      box.y !== was.y ||
      box.width !== was.width ||
      box.height !== was.height)
  ) {
    return true;
  }
  if (box.lines !== was.lines && !sameLines(box.lines, was.lines)) return true;
  const marker = box.marker;
  return marker
    ? marker.x !== was.markerX || marker.y !== was.markerY
    : !Number.isNaN(was.markerX);
}

/** Whether two sets of lines are set alike: each line where it was, as
 *  large, over the same text, its fragments drawn from the same layouts at
 *  the same places, and what sits on it where it sat. */
function sameLines(a: LineBox[] | null, b: LineBox[] | null): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i];
    const q = b[i];
    if (
      p.x !== q.x ||
      p.y !== q.y ||
      p.width !== q.width ||
      p.height !== q.height ||
      p.baseline !== q.baseline ||
      p.textStart !== q.textStart ||
      p.textEnd !== q.textEnd ||
      p.texts.length !== q.texts.length ||
      p.atomics.length !== q.atomics.length ||
      (p.edges?.length ?? 0) !== (q.edges?.length ?? 0)
    ) {
      return false;
    }
    for (let j = 0; j < p.texts.length; j += 1) {
      const s = p.texts[j];
      const t = q.texts[j];
      if (
        s.layout !== t.layout ||
        s.layoutLine !== t.layoutLine ||
        s.drawX !== t.drawX ||
        s.drawY !== t.drawY ||
        s.textStart !== t.textStart ||
        s.textEnd !== t.textEnd
      ) {
        return false;
      }
    }
    for (let j = 0; j < p.atomics.length; j += 1) {
      if (p.atomics[j].x !== q.atomics[j].x) return false;
      if (p.atomics[j].y !== q.atomics[j].y) return false;
    }
    for (let j = 0; j < (p.edges?.length ?? 0); j += 1) {
      if (p.edges![j].x !== q.edges![j].x) return false;
      if (p.edges![j].width !== q.edges![j].width) return false;
    }
  }
  return true;
}

/**
 * Whether a box around `box` clips what it holds, with nothing out of the
 * flow between them: the document is then as tall as that box reaches and
 * no taller, wherever `box` moves inside it (`computePaintBounds`). Out of
 * the flow, what a box reaches is counted by the containing blocks it is
 * placed in (`layoutDocument`), so the answer there is no.
 */
function heldByClip(box: Box): boolean {
  if (box.outOfFlow) return false;
  for (let at = box.parent; at?.parent; at = at.parent) {
    if (hasRect(at) && clipsOverflow(at)) return true;
    if (at.outOfFlow) return false;
  }
  return false;
}

/**
 * Whether every element a change restyles is positioned out of the flow,
 * or inside one that is, as the tree has them: the only change a frame's
 * build repaints apart (`_changedOutOfFlow`). Anything else it builds and
 * lays out whole and repaints whole, where a build of what the change
 * reached keeps every other box and what its layouts learnt
 * (`_subtreeBuild`). Wikipedia's contents mark the section in view as the
 * article scrolls, and each mark was the whole article built and laid out
 * again: 45 ms, several times a second.
 */
function laidOutApart(own: ReadonlySet<Element>, tree: BoxTree): boolean {
  outer: for (const el of own) {
    for (let at: AnyNode | null = el; at && isElement(at); at = at.parent) {
      const style = tree.styles.get(at)?.style;
      if (!style) return false;
      if (outOfFlow(style)) continue outer;
    }
    return false;
  }
  return true;
}

/** Whether a box is laid out where it was and as large: one that has a
 *  rect of its own — an inline box's text is its block's. How far it
 *  draws is no part of it, since that takes in what it holds, and a box
 *  out of the flow it holds moved. */
function sameGeometry(a: Box, b: Box, at: Rect = a): boolean {
  if (!hasRect(a) || !hasRect(b)) return hasRect(a) === hasRect(b);
  return (
    at.x === b.x &&
    at.y === b.y &&
    at.width === b.width &&
    at.height === b.height
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
  which: 'before' | 'after' | 'details-content',
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
  /** The lengths a layout that follows lays out (`hoverChange`): where it
   *  sets text at a new size, it is set then, whatever else changed. */
  lengths: number,
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
      for (const f of FACE_FIELDS) {
        if (sameValue(was[f], now[f])) continue;
        return lengths & FONT_LENGTHS ? null : false;
      }
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

/** A snap target by what it is of: its element, and which pseudo-element
 *  of it where it is a generated box — a box is made again by a build,
 *  and the element it is of is not. */
interface SnapKey {
  el: Element;
  pseudo: Box['pseudo'];
}

function snapKey(box: Box | null): SnapKey | null {
  if (!box) return null;
  const el = box.el ?? GENERATED_FROM.get(box);
  return el ? { el, pseudo: box.pseudo } : null;
}

/** The area of a container a key names, or null where it is none now. */
function snapBox(c: SnapContainer, key: SnapKey | null): Box | null {
  if (!key) return null;
  for (const area of c.areas) {
    const b = area.box;
    if (b.pseudo === key.pseudo && (b.el ?? GENERATED_FROM.get(b)) === key.el) {
      return b;
    }
  }
  return null;
}

/** The snap areas under a box whose nearest scroll container it is, in
 *  tree order, each placed by `at` — null for one that is not the
 *  container's to scroll. An inline box's rect is never laid out, and is
 *  no area here. */
function snapAreasIn(
  container: Box,
  at: (box: Box) => { x: number; y: number } | null,
): SnapArea[] {
  const out: SnapArea[] = [];
  const walk = (b: Box): void => {
    for (const child of b.children) {
      if (canBeArea(child) && holdsArea(container, child)) {
        const area = areaAt(child, at);
        if (area) out.push(area);
      }
      walk(child);
    }
  };
  walk(container);
  return out;
}

/** The one snap area a box is under a container, as `snapAreasIn` would
 *  find it, or null where it is none of the container's. */
function areaIn(
  container: Box,
  box: Box,
  at: (box: Box) => { x: number; y: number } | null,
): SnapArea[] | null {
  if (!canBeArea(box)) return null;
  let a = box.parent;
  while (a && a !== container) a = a.parent;
  if (!a || !holdsArea(container, box)) return null;
  const area = areaAt(box, at);
  return area ? [area] : null;
}

/** Whether a box can be a snap area: an element's or a pseudo-element's,
 *  and not the text, nor an anonymous box, which takes its parent's
 *  `scroll-snap-align` with the rest of its style and is no area of its
 *  own. */
function canBeArea(box: Box): boolean {
  return (
    box.style.scrollSnapAlign !== NO_SNAP_ALIGN &&
    box.kind !== 'text' &&
    (box.el !== null || box.pseudo !== null) &&
    hasRect(box)
  );
}

/** Whether a container is a box's nearest scroll container on its
 *  containing blocks: one positioned past a scroll container inside it is
 *  its own. */
function holdsArea(container: Box, box: Box): boolean {
  for (let a = box.parent; a && a !== container; a = a.parent) {
    if (isScroller(a) && scrollMoves(a, box)) return false;
  }
  return true;
}

function areaAt(
  box: Box,
  at: (box: Box) => { x: number; y: number } | null,
): SnapArea | null {
  const place = at(box);
  return place
    ? { box, x: place.x, y: place.y, width: box.width, height: box.height }
    : null;
}

/** The scroll containers in a tree that snap on an axis. */
function snapContainersIn(root: Box): Box[] {
  const out: Box[] = [];
  const walk = (b: Box): void => {
    for (const child of b.children) {
      if (child.style.scrollSnapType && isScroller(child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** The replaced kinds a highlight lays its colour over: what draws a
 *  picture, and not a form control, which is a widget. */
const LIT_REPLACED = new Set(['image', 'svg', 'frame']);

/** A replaced box a highlight may cover, with where its element's edges
 *  are in its tree (`pointPath`): a range holds it whole where it starts
 *  at or before the first and ends at or after the second (DOM 5.5,
 *  "contained"). */
interface ReplacedBox {
  box: Box;
  root: AnyNode;
  before: number[];
  after: number[];
}

/** The boxes of a tree's replaced elements a highlight may cover, in the
 *  order the tree has them: found once a tree, and none in most. */
const REPLACED_BOXES = new WeakMap<BoxTree, ReplacedBox[]>();
function replacedBoxesOf(tree: BoxTree): ReplacedBox[] {
  let found = REPLACED_BOXES.get(tree);
  if (found) return found;
  found = [];
  const stack: Box[] = [tree.root];
  while (stack.length) {
    const box = stack.pop()!;
    const el = box.el;
    if (el?.parent && LIT_REPLACED.has(box.replaced)) {
      const before = pointPath(el.parent, el.parent.children.indexOf(el));
      const after = before.slice();
      after[after.length - 1] += 1;
      found.push({ box, root: rootOf(el), before, after });
    }
    for (let i = box.children.length - 1; i >= 0; i -= 1) {
      stack.push(box.children[i]);
    }
  }
  REPLACED_BOXES.set(tree, found);
  return found;
}

/** A range's boundary points as paths (`pointPath`), and its root. */
function spanOf(r: { sc: AnyNode; so: number; ec: AnyNode; eo: number }): {
  root: AnyNode;
  start: number[];
  end: number[];
} {
  return {
    root: rootOf(r.sc) === rootOf(r.ec) ? rootOf(r.sc) : r.sc,
    start: pointPath(r.sc, r.so),
    end: pointPath(r.ec, r.eo),
  };
}

/** Where a DOM boundary point is, as the child indices down to it from its
 *  root and its offset last: two points of a tree compare as their paths
 *  do, a path that is a prefix of another's before it (DOM 5.2). */
function pointPath(node: AnyNode, offset: number): number[] {
  const path = [offset];
  for (let at: AnyNode = node; at.parent; at = at.parent) {
    path.push(at.parent.children.indexOf(at as ChildNode));
  }
  return path.reverse();
}
function comparePaths(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function rootOf(node: AnyNode): AnyNode {
  let at = node;
  while (at.parent) at = at.parent;
  return at;
}
