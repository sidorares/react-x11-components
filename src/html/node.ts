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
import type { Element } from 'domhandler';

import { codePointAtOffset, codeUnitOffsets } from '../internal/text.js';
import { attr, HtmlSource, imageUrlOf, isElement, tagOf } from './dom.js';
import type { Document } from './dom.js';
import { Cascade } from './css/cascade.js';
import { mediaMatches, parseStylesheet } from './css/parse.js';
import type { Stylesheet } from './css/parse.js';
import { uaStylesheet } from './css/ua.js';
import type { ComputedStyle, RootLook } from './css/style.js';
import { buildBoxes, CONTENT_IMAGES } from './layout/boxes.js';
import type {
  Box,
  BoxTree,
  LineText,
  ReplacedKind,
  TextLayoutLike,
} from './layout/boxes.js';
import { layoutDocument } from './layout/block.js';
import { TextLayoutCache } from './layout/cache.js';
import { shapingSafe } from './layout/shaping.js';
import { SurfaceCache } from './surfaces.js';
import { inlineDecoration, runFor } from './layout/inline.js';
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
  containingBlockOf,
  hasRect,
  holds,
  holdsAbsolute,
  paintDocument,
  queryChildIndex,
} from './paint.js';
import type { PaintContext } from './paint.js';
import { controlRectsOf, measureControl } from './controls.js';
import type { BareField, ControlRect } from './controls.js';
import { ResourceStore } from './resources.js';
import type { ResourceRequest, ResourceResult } from './resources.js';
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
  /** The parsed document, once per parse — the DOM handle. */
  onDocument?: (document: Document) => void;
  /** Bumped by the component to force a re-read of a mutated DOM. */
  domRevision?: number;
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
  /** The families the document's `@font-face` rules declare (`fonts.ts`). */
  private _webFonts: WebFonts;
  /** The sheets the last restyle read, and the cascade built from them. */
  private _sheetsRead: SheetsRead | null = null;
  /** Blurred shadows, drawn once each. */
  private _shadowCache: SurfaceCache | null = null;
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
  private _documentHeight = 0;
  private _documentWidth = 0;
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
  private _scriptsSeen = new WeakSet<Element>();
  private _controls: ControlRect[] = [];
  private _reportedDomRevision = -1;

  constructor(props: Record<string, unknown>, app: NtkApp) {
    super(ELEMENT, props, app);
    const ask = (request: ResourceRequest) =>
      this._props().onResource?.(request) ?? null;
    this._resources = new ResourceStore(
      ask,
      (what) => {
        // A late stylesheet is a new cascade: its rules, what it imports,
        // the faces it declares. A late image changes intrinsic sizes, so
        // the box tree is what has to be rebuilt — not merely repainted.
        // Either arriving after first paint is the ordinary case, not an
        // error path: a host on a network answers every request that way.
        this._invalidate(what === 'stylesheet' ? Stale.Style : Stale.Boxes);
      },
      this._urls,
    );
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
          };
    this._deviceLookFor = look;
    this._deviceLookAt = s;
    this._deviceLookValue = scaled;
    return scaled;
  }

  // --- the pipeline ---------------------------------------------------------

  private _invalidate(stale: Stale): void {
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
   * asks once a URL, so a tree built again asks nothing new.
   */
  private _requestBackgrounds(tree: BoxTree): void {
    for (const box of tree.backgrounds) {
      if (!box.el) continue;
      // each layer's, where there is more than one
      for (const url of box.style.backgroundImages ?? [
        box.style.backgroundImage,
      ]) {
        if (typeof url === 'string') {
          this._resources.request({ url, kind: 'image', element: box.el });
        }
      }
      const border = box.style.borderImage.source;
      if (typeof border === 'string') {
        this._resources.request({
          url: border,
          kind: 'image',
          element: box.el,
        });
      }
    }
    // and every image generated content names, which is only known there
    // too
    for (const { url, element } of tree.contentImages) {
      this._resources.request({ url, kind: 'image', element });
    }
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

  /** Rebuild the cascade — the document's sheets plus the host's. */
  private _restyle(width: number): void {
    const props = this._props();
    const look = this._deviceLook();
    const documentBase = this._urls.base;
    // What the sheets are read from, in order: a `<style>`'s text or a
    // fetched `<link>`'s, and after them the host's — each with the URL its
    // own relative URLs resolve against: the document's for a `<style>`,
    // the sheet's own for a `<link>`.
    const read: SheetText[] = [];
    for (const ref of this._source.facts().sheets) {
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
      read.push({ text, encoding, element: ref.element, base });
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
      this._sameSheets(kept, read, extras)
    ) {
      this._cascade = kept.cascade;
      kept.cascade.viewportWidth = width;
      kept.cascade.viewportHeight = this._viewportHeight();
      faces = kept.faces;
    } else {
      const sheets: Stylesheet[] = [uaStylesheet(look)];
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
      for (const { text, encoding, element, base } of read) {
        const sheet = parseStylesheet(text, 0, layers, base);
        const seen: ImportRead[] = [];
        this._placeImports(sheet, encoding, element, layers, seen, place);
        imports.push(seen);
        place(sheet, element);
      }
      for (const text of extras) {
        const sheet = parseStylesheet(text, order, layers);
        order += sheet.rules.length + 1;
        sheets.push(sheet);
      }
      this._cascade = new Cascade(
        sheets,
        look,
        width,
        this._viewportHeight(),
        this._scale,
        fonts ? (family, size) => xHeightOf(fonts, family, size) : null,
        fonts ? (family, size) => zeroWidthOf(fonts, family, size) : null,
        fonts ? (family, size) => normalLineOf(fonts, family, size) : null,
        faces.length ? this._webFonts : null,
      );
      this._sheetsRead = {
        look,
        scale: this._scale,
        fonts,
        texts: read.map((r) => r.text),
        encodings: read.map((r) => r.encoding),
        bases: read.map((r) => r.base),
        imports,
        extras,
        faces,
        cascade: this._cascade,
      };
    }
    // The faces this width and scheme declare: a `@font-face` may sit in a
    // `@media` block like any rule.
    const cssWidth = width / this._scale;
    this._webFonts.setFallback(look.fontFamily);
    this._webFonts.setFaces(
      faces.filter((f) =>
        mediaMatches(f.rule.media, cssWidth, look.colorScheme),
      ),
    );
    this._cascade.setPointer({
      hovered: new Set(this._hovered),
      active: EMPTY_SET,
    });
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
  ): void {
    for (const url of sheet.imports) {
      this._resources.request({ url, kind: 'stylesheet', element });
      const fetched = this._resources.stylesheet(url, [encoding]);
      const base = this._resources.sheetBase(url);
      seen.push({ url, text: fetched?.text ?? null, base });
      const key = base ?? url;
      if (!fetched || depth >= MAX_IMPORT_DEPTH || chain.has(key)) continue;
      const imported = parseStylesheet(fetched.text, 0, layers, base);
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
        r.base !== kept.bases[i]
      ) {
        return false;
      }
      // The encodings an import falls back to are its importer's, which
      // only a parse knows; the text an import decoded to under them is what
      // was kept, and bytes that decode differently now are a new sheet.
      for (const { url, text, base } of kept.imports[i]) {
        this._resources.request({
          url,
          kind: 'stylesheet',
          element: r.element,
        });
        const fetched = this._resources.stylesheet(url, [r.encoding]);
        if ((fetched?.text ?? null) !== text) return false;
        if (this._resources.sheetBase(url) !== base) return false;
      }
    }
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

  private _fonts(): FontsLike | null {
    const fonts = (this.app as { fonts?: FontsLike } | null)?.fonts;
    // a face the engine cannot shape from costs its characters, not the
    // document (`shaping.ts`)
    return fonts ? shapingSafe(fonts) : null;
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

    if (this._stale >= Stale.Style || !this._cascade) {
      this._restyle(target);
      this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
    } else if (this._cascade.mediaBand(target) !== this._mediaBand) {
      // A resize that crossed a `@media` breakpoint is the one resize that
      // does have to restyle. Knowing which resizes those are is why the
      // breakpoints are collected at parse time.
      this._restyle(target);
      this._stale = Math.max(this._stale, Stale.Boxes) as Stale;
    }

    const cascade = this._cascade;
    if (!cascade) return;
    cascade.viewportWidth = target;
    cascade.viewportHeight = viewport;
    // A `vw` or a `vh` is a number by the time a style holds it, so the
    // styles computed for another viewport are wrong for this one: built
    // again, where some style reads the side that moved. A document that
    // reads neither — most — goes on skipping the cascade on a resize.
    if (
      this._stale < Stale.Boxes &&
      ((cascade.readsViewportWidth && this._styledWidth !== target) ||
        (cascade.readsViewportHeight && this._styledHeight !== viewport))
    ) {
      this._stale = Stale.Boxes;
    }

    if (this._stale >= Stale.Boxes || !this._tree) {
      const look = this._deviceLook();
      const build = () =>
        buildBoxes(this._source.document, {
          cascade,
          scale: this._scale,
          imageSize: (el) => this._resources.imageSize(imageUrlOf(el) ?? ''),
          urlSize: (url) => this._resources.imageSize(url),
          controlSize: (el, kind, style) =>
            measureControl(el, kind, style, this._fonts(), look),
        });
      this._tree = build();
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
      this._warmFaces(this._tree);
      this._textPoints = null;
      this._pointsAreUnits = null;
      this._laidOutWidth = -1;
    }

    if (
      this._tree &&
      (this._laidOutWidth !== target ||
        viewportMoved ||
        this._stale >= Stale.Layout)
    ) {
      const result = layoutDocument(
        this._tree,
        this._layoutFonts(),
        target,
        viewport,
      );
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
  }

  /** Whether the document as laid out reads its viewport's height. */
  private _readsViewportHeight(): boolean {
    return (
      this._layoutReadsViewport || this._cascade?.readsViewportHeight === true
    );
  }

  private _reportControls(): void {
    const tree = this._tree;
    const report = this._props().onControls;
    if (!tree || !report) return;
    // The boxes are device pixels; each rect becomes the style of a widget
    // mounted beside this element, and a style is logical.
    const s = this._scale;
    const rects = controlRectsOf(tree).map((r) =>
      s === 1
        ? r
        : {
            ...r,
            x: r.x / s,
            y: r.y / s,
            width: r.width / s,
            height: r.height / s,
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
      next.charset !== prev.charset
    ) {
      this._invalidate(Stale.Style);
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
  }

  override destroySubtree(): void {
    this._resources.destroy();
    this._webFonts.destroy();
    this._source.destroy();
    this._shadowCache?.destroy();
    this._shadowCache = null;
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

  override textContent(): string {
    return this._tree?.text ?? '';
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
    const tree = this._tree;
    if (!tree) return 0;
    // Core's contract: a device-pixel point, the same space the two rect
    // accessors below answer in.
    const local = { x: x - this.abs.x, y: y - this.abs.y };
    const hit = nearestText(tree.root, local.x, local.y);
    if (!hit) return 0;
    return this._toPoints(hit);
  }

  override textCaretRect(index: number): Rect | null {
    const tree = this._tree;
    if (!tree) return null;
    const units = this._toUnits(index);
    const found = caretAt(tree.root, units);
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
    const from = this._toUnits(start);
    const to = this._toUnits(end);
    if (to <= from) return [];
    const out: Rect[] = [];
    collectBands(tree.root, from, to, this.abs.x, this.abs.y, out);
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
    while (node) {
      const href = attr(node, 'href');
      if (href && (tagOf(node) === 'a' || tagOf(node) === 'area')) {
        return this._urls.resolve(href);
      }
      node = isElement(node.parent) ? node.parent : null;
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
    const tree = this._tree;
    if (!tree) return null;
    const box = boxFor(tree.root, element);
    if (!box) return null;
    let rect: Rect | null = null;
    if (box.kind !== 'inline' && box.kind !== 'text') {
      rect = { x: box.x, y: box.y, width: box.width, height: box.height };
    } else {
      const bands: Rect[] = [];
      if (box.subtreeTextEnd > box.subtreeTextStart) {
        collectBands(
          tree.root,
          box.subtreeTextStart,
          box.subtreeTextEnd,
          0,
          0,
          bands,
        );
      }
      if (box.kind === 'inline') fragmentReach(box, bands);
      for (const band of bands) rect = rect ? unionRect(rect, band) : band;
      if (!rect) {
        // an empty subtree's range is `[0, 0)`, wherever it stands: where
        // its text would be is where the text after it starts
        const caret = caretAt(tree.root, textAfter(tree.root, box));
        if (!caret) return null;
        rect = { x: caret.x, y: caret.y, width: 0, height: caret.height };
      }
    }
    const s = this._scale;
    return {
      x: rect.x / s,
      y: rect.y / s,
      width: rect.width / s,
      height: rect.height / s,
    };
  }

  /** The deepest element whose box contains a logical window point. */
  elementAtPoint(x: number, y: number): Element | null {
    const tree = this._tree;
    if (!tree) return null;
    const local = this._toDocument(x, y);
    return deepestAt(tree, local.x, local.y);
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
    const tree = this._tree;
    if (!tree) return null;
    const hit = { text: false };
    const el = deepestAt(tree, x - this.abs.x, y - this.abs.y, hit);
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
    const cascade = this._cascade;
    if (!cascade || !cascade.hoverSensitive) return false;
    const chain: Element[] = [];
    let node = this.elementAtPoint(x, y);
    while (node) {
      chain.push(node);
      node = isElement(node.parent) ? node.parent : null;
    }
    if (sameChain(chain, this._hovered)) return false;
    const was = this._hovered;
    this._hovered = chain;
    cascade.setPointer({ hovered: new Set(chain), active: EMPTY_SET });
    this._restyleHover(was, chain);
    return true;
  }

  clearHover(): boolean {
    if (!this._hovered.length) return false;
    const was = this._hovered;
    this._hovered = [];
    this._cascade?.setPointer({ hovered: new Set(), active: EMPTY_SET });
    this._restyleHover(was, []);
    return true;
  }

  /** The hovered chain moved: restyle where it did, or the document. */
  private _restyleHover(was: readonly Element[], now: readonly Element[]) {
    const done = this._hoverInPlace(was, now);
    if (done === 'painted') this.invalidate(false, this, 'props');
    else if (done === false) this._invalidate(Stale.Boxes);
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
   *  - Only an element whose hover state flipped and that a compound testing
   *    the pointer could match can change (`Cascade.hoverTouches`), with its
   *    subtree, and its later siblings where a sibling combinator follows.
   *    A move between two paragraphs under `a:hover` touches nothing.
   *  - Those are styled again from their parents. Where anything but ink
   *    differs (`PAINT_ONLY`), or a box is not the element's own — an
   *    anonymous or a pseudo-element box, a marker, a control — this is
   *    not the move to take.
   *  - The boxes take their new styles, and each layout of their text is
   *    made again from the runs it was made from (`TextLayoutCache.inputsOf`)
   *    with the new ink (`runFor`), where its geometry comes out the same.
   *
   * Everything is checked before anything is changed. 'none' where nothing
   * could change, 'painted' where it was restyled here, false where the
   * document has to be built again.
   */
  private _hoverInPlace(
    was: readonly Element[],
    now: readonly Element[],
  ): 'none' | 'painted' | false {
    const cascade = this._cascade;
    const tree = this._tree;
    const layouts = this._layouts;
    if (!cascade || !tree || !layouts || !cascade.hoverLocal) return false;
    if (this._stale !== Stale.Nothing || this._laidOutWidth < 0) return false;

    const before = new Set(was);
    const after = new Set(now);
    const roots: Element[] = [];
    for (const el of was) {
      if (!after.has(el) && cascade.hoverTouches(el)) roots.push(el);
    }
    for (const el of now) {
      if (!before.has(el) && cascade.hoverTouches(el)) roots.push(el);
    }
    if (!roots.length) return 'none';

    // what may restyle: the roots' subtrees, which inherit from them and a
    // descendant combinator reaches, and their later siblings' too where a
    // sibling combinator follows a compound that tests the pointer
    const reach = new Set<Element>();
    const collect = (el: Element): boolean => {
      const stack: Element[] = [el];
      while (stack.length) {
        const at = stack.pop()!;
        if (reach.has(at)) continue;
        reach.add(at);
        if (reach.size > HOVER_RESTYLE_LIMIT) return false;
        for (const child of at.children)
          if (isElement(child)) stack.push(child);
      }
      return true;
    };
    for (const root of roots) {
      if (!collect(root)) return false;
      if (!cascade.hoverSiblings) continue;
      for (let s = root.nextSibling; s; s = s.nextSibling) {
        if (isElement(s) && !collect(s)) return false;
      }
    }

    // styled again from their parents, a parent first
    const fresh = new Map<Element, ComputedStyle>();
    const changed = new Map<Element, ComputedStyle>();
    let refused = false;
    const styleOf = (el: Element): ComputedStyle | null => {
      const kept = tree.styles.get(el);
      if (!kept) return null;
      if (!reach.has(el)) return kept.style;
      const done = fresh.get(el);
      if (done) return done;
      const parent = isElement(el.parent) ? el.parent : null;
      const parentStyle = parent ? styleOf(parent) : null;
      if (!parentStyle) {
        refused = true;
        return null;
      }
      const style = cascade.styleFor(el, parentStyle, kept.inFlex);
      fresh.set(el, style);
      const diff = inkOnly(kept.style, style);
      if (diff === false) refused = true;
      else if (diff) changed.set(el, style);
      return style;
    };
    for (const el of reach) {
      styleOf(el);
      if (refused) return false;
    }
    if (!changed.size) return 'none';
    for (const el of changed.keys()) {
      const tag = tagOf(el);
      // their backgrounds are the canvas's
      if (tag === 'html' || tag === 'body') return false;
    }

    // the boxes: each changed element's own, and nothing that takes its
    // style from one without being it
    const fonts = layouts.fonts;
    const restyled: [Box, ComputedStyle][] = [];
    const redecorated: [Box, Box['decoration']][] = [];
    const walk: Box[] = [tree.root];
    while (walk.length) {
      const box = walk.pop()!;
      for (const child of box.children) walk.push(child);
      const owner = box.el ?? nearestElement(box);
      if (!owner) continue;
      const style = changed.get(owner);
      if (!style) continue;
      const kept = tree.styles.get(owner)!;
      // an anonymous box, a pseudo-element, a marker, a control: a style
      // derived from the element's, or drawn from it somewhere else
      if (!box.el || box.style !== kept.style) return false;
      if (box.marker || box.replaced !== 'none') return false;
      restyled.push([box, style]);
      if (box.kind === 'inline') {
        const decoration = inlineDecoration(fonts, box, style);
        if ((decoration === null) !== (box.decoration === null)) {
          // a rounded box with a background is laid out with its edges
          if (style.borderRadius.some((r) => r !== 0)) return false;
        }
        if (decoration !== box.decoration) redecorated.push([box, decoration]);
      }
    }

    // the text: each layout holding a run of a changed element's, made
    // again with its new ink, where it comes out the same shape
    const relaid = new Map<TextLayoutLike, TextLayoutLike | null>();
    const texts: LineText[] = [];
    walk.push(tree.root);
    while (walk.length) {
      const box = walk.pop()!;
      for (const child of box.children) walk.push(child);
      if (!box.lines) continue;
      for (const line of box.lines) {
        for (const text of line.texts) {
          texts.push(text);
          if (relaid.has(text.layout)) continue;
          const next = reinked(text, layouts, changed, tree.styles);
          if (next === false) return false;
          relaid.set(text.layout, next);
        }
      }
    }

    // and only now, all of it
    for (const [box, style] of restyled) box.style = style;
    for (const [box, decoration] of redecorated) box.decoration = decoration;
    for (const text of texts) {
      const next = relaid.get(text.layout);
      if (next) text.layout = next;
    }
    for (const [el, style] of changed) {
      tree.styles.set(el, { style, inFlex: tree.styles.get(el)!.inFlex });
    }
    return 'painted';
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
  // re-styles only when the hovered chain actually changed. The restyle is
  // still document-wide — narrowing it to the affected subtree is the
  // phase-2 item the PRD records.

  override defaultMouseMove(ev: X11MouseEvent): void {
    super.defaultMouseMove?.(ev);
    this.setHover(ev.x, ev.y);
  }

  override defaultMouseLeave(ev: X11MouseEvent): void {
    super.defaultMouseLeave?.(ev);
    this.clearHover();
  }

  // --- paint ----------------------------------------------------------------

  override paint(ctx: Context2D): void {
    super.paint(ctx); // background, border, clip to `abs`
    this._prepare(this.abs.width || 1);
    const tree = this._tree;
    if (!tree) return;
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
    try {
      this._paint(ctx, tree, range, damage);
    } catch (error) {
      this._fail(error, this._laidOutWidth);
    }
  }

  private _paint(
    ctx: Context2D,
    tree: BoxTree,
    range: { start: number; end: number } | null,
    damage: { x: number; y: number; width: number; height: number } | null,
  ): void {
    paintDocument(ctx as PaintContext, tree, {
      originX: this.abs.x,
      originY: this.abs.y,
      // the root's background covers the whole element, not only the
      // document: an element grown past its content is canvas too
      canvas: this.abs,
      scale: this._scale,
      damage,
      selection: range
        ? { start: this._toUnits(range.start), end: this._toUnits(range.end) }
        : null,
      selectionColor: this.selectionColor,
      imageFor: (box) => {
        const url = box.el ? imageUrlOf(box.el) : CONTENT_IMAGES.get(box);
        return url === undefined ? null : this._resources.image(url);
      },
      backgroundImageFor: (url) => {
        const image = this._resources.image(url);
        const size = image ? this._resources.imageSize(url) : null;
        return image && size ? { image, ...size } : null;
      },
      cached: (key, width, height, draw) =>
        (this._shadowCache ??= new SurfaceCache(this.app)).get(
          key,
          width,
          height,
          draw as (ctx: unknown) => void,
        ),
    });
  }
}

const EMPTY_SET: ReadonlySet<Element> = new Set();

/** A sheet as the restyle reads it: its text, the encoding it was decoded
 *  from, the element that brought it, and what its URLs resolve against. */
interface SheetText {
  text: string;
  encoding?: string;
  element: Element;
  base: string | null;
}

/** One `@import` a sheet read, and what it read as. */
interface ImportRead {
  url: string;
  text: string | null;
  base: string | null;
}

/** What a cascade was built from, to tell whether the next would be the
 *  same one: the look, scale and fonts, each sheet's text, encoding and
 *  base, the texts of everything each imports, and the host's own — and
 *  the faces all of them declare. */
interface SheetsRead {
  look: RootLook;
  scale: number;
  fonts: unknown;
  texts: string[];
  encodings: (string | undefined)[];
  bases: (string | null)[];
  imports: ImportRead[][];
  extras: string[];
  faces: DeclaredFace[];
  cascade: Cascade;
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
      !sameBare(p.bare, q.bare)
    ) {
      return false;
    }
  }
  return true;
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
    a.fontSize === b.fontSize
  );
}

// --- walks over the laid-out tree -------------------------------------------

/** Distance from a coordinate to an interval, zero inside it. */
function axisDistance(v: number, lo: number, span: number): number {
  return v < lo ? lo - v : v > lo + span ? v - (lo + span) : 0;
}

/**
 * The code-unit offset nearest a document-space point.
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
function nearestText(box: Box, x: number, y: number): number | null {
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
      bestDistance = distance;
      const local = text.layout.indexAt(x - text.drawX, y - text.drawY);
      const offsets = layoutOffsetsOf(text.layout);
      const units = offsets.length
        ? offsets[Math.max(0, Math.min(local, offsets.length - 1))]
        : local;
      best = Math.max(text.textStart, documentOffsetOf(text, units));
    }
  };

  const visit = (node: Box): void => {
    const boundsDistance =
      axisDistance(y, node.boundsY, node.boundsHeight) * 4 +
      axisDistance(x, node.boundsX, node.boundsWidth);
    if (boundsDistance >= bestDistance) return;

    const lines = node.lines;
    if (lines?.length) {
      // The line nearest in y, by binary search; then outward both ways
      // while vertical distance alone could still beat the best.
      let lo = 0;
      let hi = lines.length;
      while (lo < hi) {
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
        if (axisDistance(y, lines[i].y, lines[i].height) * 4 >= bestDistance)
          break;
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
        for (const child of node.positionedPaint) visit(child);
      }
      return;
    }
    for (const child of node.children) {
      if (child.kind === 'text' || child.kind === 'break') continue;
      visit(child);
    }
  };
  visit(box);
  return best;
}

/** Where a caret at a code-unit offset stands, in document coordinates.
 *  Subtrees whose text range cannot hold the offset are skipped whole, so
 *  the walk is the path to one paragraph, not the document. */
function caretAt(
  box: Box,
  units: number,
): { x: number; y: number; height: number } | null {
  let found: { x: number; y: number; height: number } | null = null;
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
          found = { x: text.drawX + caret.x, y: line.y, height: line.height };
          return;
        }
      }
    }
    for (const child of node.children) {
      if (child.kind === 'text' || child.kind === 'break') continue;
      visit(child);
      if (found) return;
    }
  };
  visit(box);
  return found;
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

function collectBands(
  box: Box,
  from: number,
  to: number,
  dx: number,
  dy: number,
  out: Rect[],
): void {
  if (box.subtreeTextEnd <= box.subtreeTextStart) return;
  if (box.subtreeTextEnd <= from || box.subtreeTextStart >= to) return;
  if (box.lines) {
    const lines = box.lines;
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
          for (const band of bandsFor(
            text.layout,
            natural,
            offsets,
            layoutOffsetOf(text, a),
            layoutOffsetOf(text, b, true),
          )) {
            out.push({
              x: dx + band.x + text.drawX,
              y: dy + line.y,
              width: band.width,
              height: line.height,
            });
          }
        }
      }
    }
  }
  // Atomics are ordinary children, reached below.
  for (const child of box.children) {
    if (child.kind === 'text' || child.kind === 'break') continue;
    collectBands(child, from, to, dx, dy, out);
  }
}

/** The layers of a hit test, in the order CSS paints them within a
 *  context (`deepestAt`). */
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
): Element | null {
  const box = tree.root;
  let found: Element | null = box.el;
  let foundKey: readonly number[] = [];
  let viaText = false;
  // What is under a point is what was painted there last (CSS 2.1 Appendix
  // E): within a context, an in-flow block's own box, then a float over it,
  // then a line's text and atomics, then a positioned box — and a float, an
  // atomic or a positioned box paints its own content whole in its turn,
  // those layers again inside it. So a hit carries the layers down to it,
  // and takes the place of the one before where those come after them, or
  // tie: an infobox floated out of one section hangs over the next, whose
  // own box took every link in it, and a skin that puts the article in a
  // `position: relative` box put all of it in one layer. Positioned boxes
  // are painted in `z-index` order and then the document's (`byZIndex`),
  // the negative ones under the flow: the Zen Garden's `›` has
  // `z-index: 3` over the bar the "View All Designs" link fills after it.
  const take = (el: Element, key: readonly number[], text: boolean) => {
    if (compareKeys(key, foundKey) < 0) return;
    found = el;
    foundKey = key;
    viaText = text;
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
  const enter = (
    child: Box,
    context: readonly number[],
    clipped: readonly Box[],
  ): void => {
    const style = child.style;
    if (
      style.position !== 'static' ||
      (child.parent?.kind === 'flex' && typeof style.zIndex === 'number')
    ) {
      // a flex item with a `z-index` is layered unpositioned (`layered`)
      const z = style.zIndex === 'auto' ? 0 : style.zIndex;
      context = [...context, z < 0 ? HIT_NEGATIVE : HIT_POSITIONED, z];
    } else if (style.float !== 'none') context = [...context, HIT_FLOAT];
    if (clipped.length !== 0 && child.outOfFlow) {
      const containing = containingBlockOf(child);
      clipped = containing
        ? clipped.filter((clip) => holds(clip, containing))
        : [];
    }
    const inside =
      x >= child.x &&
      x < child.x + child.width &&
      y >= child.y &&
      y < child.y + child.height;
    const own = inside && hasRect(child);
    if (!own) {
      const reach = child.boundsY;
      const known =
        Number.isFinite(reach) &&
        (child.boundsWidth > 0 || child.boundsHeight > 0);
      if (!known) {
        if (!inside) return;
      } else if (
        x < child.boundsX ||
        x >= child.boundsX + child.boundsWidth ||
        y < reach ||
        y >= reach + child.boundsHeight
      ) {
        return;
      }
      if (clipsOverflow(child)) {
        if (!holdsAbsolute(child)) return;
        clipped = [...clipped, child];
      }
    }
    if (own && child.el && clipped.length === 0) {
      take(child.el, [...context, HIT_BLOCK], false);
    }
    visit(child, context, clipped);
  };
  const visit = (
    node: Box,
    context: readonly number[],
    clipped: readonly Box[],
  ): void => {
    // The paint index answers a point query too — the wide level of a flat
    // document is the root's child list, and a hit test that walked all of
    // it would run per pointer move once hover is in the picture.
    const candidates = node.paintIndex
      ? queryChildIndex(node.paintIndex, y, y + 1)
      : node.children;
    for (const child of candidates) {
      if (child.kind === 'text' || child.kind === 'break') continue;
      enter(child, context, clipped);
    }
    if (node.paintIndex && node.positionedPaint) {
      for (const child of node.positionedPaint) {
        enter(child, context, clipped);
      }
    }
    if (node.lines) {
      for (const line of node.lines) {
        for (const placed of line.atomics) {
          enter(placed.box, [...context, HIT_INLINE], clipped);
        }
        // An inline box has no box of its own — its extent is the runs on
        // this line — so the element under a point inside a paragraph is
        // found from the run rather than from a rectangle: from where its
        // text sits in the document, whose text boxes know their element.
        // Not from the run itself, whose layout may be one an earlier parse
        // made (`TextLayoutCache`), and which an engine may hand back with
        // nothing on it but its extent.
        if (clipped.length === 0 && y >= line.y && y < line.y + line.height) {
          for (const text of line.texts) {
            const natural = text.layout.lines[text.layoutLine];
            if (!natural) continue;
            for (const run of natural.runs) {
              const left = text.drawX + natural.x + run.x;
              if (x >= left && x < left + run.width) {
                const owner = ownerOf(
                  tree.textBoxes,
                  text.spans.documentAt(run.start),
                );
                if (owner) take(owner, [...context, HIT_INLINE], true);
              }
            }
          }
        }
      }
    }
  };
  visit(box, [], []);
  if (hit) hit.text = viaText;
  return found;
}

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
]);

/** The fields of a run its ink is: what `runFor` takes from `PAINT_ONLY`. */
const INK_FIELDS = [
  'color',
  'underline',
  'underlineStyle',
  'underlineOffset',
  'underlineThickness',
  'strike',
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
function inkOnly(was: ComputedStyle, now: ComputedStyle): boolean | null {
  const a = was as unknown as Record<string, unknown>;
  const b = now as unknown as Record<string, unknown>;
  let ink = false;
  for (const key in b) {
    if (key === 'custom' || sameValue(a[key], b[key])) continue;
    if (!PAINT_ONLY.has(key)) return false;
    ink = true;
  }
  return ink ? true : null;
}

/** Structural equality for a computed value: a number, a string, or the
 *  plain objects and arrays a length or a shadow list is. */
function sameValue(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (typeof x === 'number' && typeof y === 'number') {
    return Number.isNaN(x) && Number.isNaN(y);
  }
  if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  const a = x as Record<string, unknown>;
  const b = y as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (!sameValue(a[key], b[key])) return false;
  return true;
}

/** The element an anonymous box takes its style from: its nearest
 *  ancestor's that has one. */
function nearestElement(box: Box): Element | null {
  for (let at = box.parent; at; at = at.parent) if (at.el) return at.el;
  return null;
}

/**
 * `text`'s layout made again with the ink of the elements a pointer move
 * restyled: from the runs it was made from, each of a changed element's
 * given the ink its new style makes (`runFor`) and nothing else. Null where
 * none of its runs is theirs; false where that cannot be told — a run this
 * cannot place in the document, one some other pass inked (a first line's),
 * or a layout that comes out another shape.
 */
function reinked(
  text: LineText,
  layouts: TextLayoutCache,
  changed: ReadonlyMap<Element, ComputedStyle>,
  styles: BoxTree['styles'],
): TextLayoutLike | null | false {
  const spans = text.spans;
  const ownerAt = (offset: number): Element | null =>
    spans.boxAt ? (spans.boxAt(offset)?.el ?? null) : null;
  const inputs = layouts.inputsOf(text.layout);
  if (!inputs || !spans.boxAt) {
    // not one this could make again: none of its text may be theirs
    for (const line of text.layout.lines) {
      for (const run of line.runs) {
        const owner = spans.boxAt ? ownerAt(run.start) : null;
        if (!spans.boxAt || (owner && changed.has(owner))) return false;
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
    const owner = length ? ownerAt(offset) : null;
    const style = owner ? changed.get(owner) : undefined;
    if (owner && style) {
      if (ownerAt(offset + length - 1) !== owner) return false;
      const was = runFor(run.text, styles.get(owner)!.style);
      const now = runFor(run.text, style);
      for (const f of FACE_FIELDS) if (!sameValue(was[f], now[f])) return false;
      let next: Record<string, unknown> | null = null;
      for (const f of INK_FIELDS) {
        // a run that is not what its style made — a first line's colour
        if (!sameValue(run[f], was[f])) return false;
        if (sameValue(was[f], now[f])) continue;
        next ??= { ...run };
        if (now[f] === undefined) delete next[f];
        else next[f] = now[f];
      }
      if (next) {
        runs ??= content.slice();
        runs[i] = next as unknown as TextRun;
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

/** The element whose text holds a document index: the text box around it,
 *  found by bisecting the boxes in document order. */
function ownerOf(boxes: readonly Box[], index: number): Element | null {
  let lo = 0;
  let hi = boxes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (boxes[mid].textStart <= index) lo = mid;
    else hi = mid - 1;
  }
  const box = boxes[lo];
  return box && index >= box.textStart && index < box.textEnd ? box.el : null;
}

export type { ControlRect, ReplacedKind, ResourceRequest, ResourceResult };

/** The advance of a font's "0" at a size, laid out: null where the engine
 *  cannot lay it out. */
function zeroWidthOf(
  fonts: FontsLike,
  family: string,
  size: number,
): number | null {
  try {
    return fonts.layout([{ text: '0', family, size }], { family, size }, {})
      .width;
  } catch {
    return null;
  }
}

/** A font's own line height at a size, as the engine reports it: null
 *  where it cannot say. */
function normalLineOf(
  fonts: FontsLike,
  family: string,
  size: number,
): number | null {
  try {
    const line = fonts.match(family, { size }).metrics(size).lineHeight;
    return line > 0 ? line : null;
  } catch {
    return null;
  }
}

/** A font's x-height at a size, as the engine reports it: null where the
 *  face states none, or the engine does not say. */
function xHeightOf(
  fonts: FontsLike,
  family: string,
  size: number,
): number | null {
  try {
    const metrics = fonts.match(family, { size }).metrics(size) as {
      xHeight?: number | null;
    };
    const x = metrics.xHeight;
    // NaN where the face states none, which is a number
    return typeof x === 'number' && x > 0 ? x : null;
  } catch {
    return null;
  }
}
