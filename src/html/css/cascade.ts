// The cascade: which declarations reach an element, in what order, and what
// they compute to.
//
// Matching is `css-select`'s. That is the one part of a CSS engine where a
// hand-written version is reliably both slower and wronger — `css-select`
// compiles a selector to a closure once and the closure is what runs per
// element, and it has the combinator, `:nth-child(an+b)` and attribute-
// operator cases right — so it is imported, through an adapter that answers
// `:hover` from this renderer's own pointer state.
//
// What is *not* delegated is the choice of which selectors to try. Testing
// every rule against every element is O(rules × elements) and is what makes
// a naive engine quadratic on a real page; rules are indexed here by their
// rightmost simple selector, so an element tries the handful of rules that
// could possibly match it. That is the same index a browser keeps, and it is
// the difference between a 3 ms and a 300 ms first paint on a document with
// a framework stylesheet attached.
import { compile } from 'css-select';
import * as DomUtils from 'domutils';
import { Element as DomElement, isTag } from 'domhandler';
import type { Element } from 'domhandler';

import { attr, tagOf } from '../dom.js';
import { mediaMatches } from './parse.js';
import type { Declaration, StyleRule, Stylesheet } from './parse.js';
import { applyDeclaration, blockify, inherit, initialStyle } from './style.js';
import type { ComputedStyle, RootLook } from './style.js';
import { parseDeclarations } from './parse.js';
import type { UnitContext } from './values.js';

/** Where a declaration came from. Higher wins before specificity is asked. */
const enum Origin {
  UserAgent = 0,
  Presentation = 1,
  Author = 2,
  Inline = 3,
  AuthorImportant = 4,
  InlineImportant = 5,
}

interface Candidate {
  origin: Origin;
  specificity: number;
  order: number;
  declarations: Declaration[];
  /** Only this declaration is taken from `declarations`, for the `!important`
   *  passes where a rule contributes some of its declarations at one level
   *  and the rest at another. `-1` takes them all. */
  only: number;
}

/** What `css-select` is handed. Its `Adapter` is generic over the node type
 *  and this only ever passes domhandler's, so the shape is spelled out
 *  rather than threaded through two type parameters at every call. */
type CssSelectAdapter = typeof DomUtils & {
  isTag: typeof isTag;
  isHovered(el: Element): boolean;
  isActive(el: Element): boolean;
  isVisited(el: Element): boolean;
};

/** A compiled matcher, kept beside the rule it came from. */
interface IndexedRule {
  rule: StyleRule;
  match: ((el: Element) => boolean) | null;
  /** Set once compilation has been attempted, so a selector `css-select`
   *  refuses is not recompiled once per element for the rest of the pass. */
  compiled: boolean;
}

/**
 * Rules bucketed by the key of their rightmost compound selector. An element
 * only ever tries `id`, its classes, its tag and the universal bucket.
 */
class RuleIndex {
  readonly byId = new Map<string, IndexedRule[]>();
  readonly byClass = new Map<string, IndexedRule[]>();
  readonly byTag = new Map<string, IndexedRule[]>();
  readonly universal: IndexedRule[] = [];
  /** Whether any rule in here is pointer-sensitive, so the renderer knows
   *  whether a pointer move can change the cascade at all. */
  hoverSensitive = false;

  add(rule: StyleRule): void {
    const indexed: IndexedRule = { rule, match: null, compiled: false };
    if (rule.selector.includes(':hover') || rule.selector.includes(':active')) {
      this.hoverSensitive = true;
    }
    const key = rightmostKey(rule.selector);
    const bucket =
      key.kind === 'id'
        ? mapBucket(this.byId, key.name)
        : key.kind === 'class'
          ? mapBucket(this.byClass, key.name)
          : key.kind === 'tag'
            ? mapBucket(this.byTag, key.name)
            : this.universal;
    bucket.push(indexed);
  }
}

function mapBucket(
  map: Map<string, IndexedRule[]>,
  key: string,
): IndexedRule[] {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = [];
    map.set(key, bucket);
  }
  return bucket;
}

/**
 * The rightmost compound selector's most selective key. `#id` beats `.class`
 * beats a tag name; a selector ending in `*`, a pseudo-class or an attribute
 * test alone lands in the universal bucket, which is the correct fallback
 * rather than a failure.
 */
function rightmostKey(selector: string): {
  kind: 'id' | 'class' | 'tag' | 'any';
  name: string;
} {
  // Scan to the last top-level combinator; everything after it is the
  // compound this rule finally has to match.
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (quote) {
      if (c === quote && selector[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      (c === ' ' || c === '>' || c === '+' || c === '~')
    ) {
      start = i + 1;
    }
  }
  const compound = selector.slice(start);
  let id: string | null = null;
  let cls: string | null = null;
  let tag: string | null = null;
  let i = 0;
  while (i < compound.length) {
    const c = compound[i];
    if (c === '#') {
      const end = identEnd(compound, i + 1);
      if (!id) id = compound.slice(i + 1, end);
      i = end;
    } else if (c === '.') {
      const end = identEnd(compound, i + 1);
      if (!cls) cls = compound.slice(i + 1, end);
      i = end;
    } else if (c === '[') {
      i = balancedEnd(compound, i, '[', ']');
    } else if (c === ':') {
      const skip = compound[i + 1] === ':' ? 2 : 1;
      const end = identEnd(compound, i + skip);
      i = compound[end] === '(' ? balancedEnd(compound, end, '(', ')') : end;
    } else if (/[a-zA-Z]/.test(c)) {
      const end = identEnd(compound, i);
      if (!tag) tag = compound.slice(i, end).toLowerCase();
      i = end;
    } else {
      i += 1;
    }
  }
  if (id) return { kind: 'id', name: id };
  if (cls) return { kind: 'class', name: cls };
  if (tag && tag !== '*') return { kind: 'tag', name: tag };
  return { kind: 'any', name: '' };
}

function identEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && /[a-zA-Z0-9_\-\\]/.test(text[i])) i += 1;
  return i;
}

function balancedEnd(
  text: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** What the pointer is over, for `:hover`. A chain rather than one element,
 *  because `li:hover a` has to light up while the pointer is on the `li`. */
export interface PointerState {
  hovered: ReadonlySet<Element>;
  active: ReadonlySet<Element>;
}

const NO_POINTER: PointerState = { hovered: new Set(), active: new Set() };

/**
 * A cascade over a fixed set of stylesheets. Rebuilt when the sheets change;
 * re-run when the DOM, the viewport band or the pointer state does.
 */
export class Cascade {
  private _index = new RuleIndex();
  private _adapter: CssSelectAdapter;
  private _pointer: PointerState = NO_POINTER;
  readonly initial: ComputedStyle;
  readonly look: RootLook;
  /** Viewport width the media queries were evaluated at, in device pixels
   *  like every other length here. */
  viewportWidth: number;
  viewportHeight: number;
  /** Device pixels per CSS pixel. Every computed length is device; a
   *  `@media` width is the one CSS-pixel comparison left, and it divides. */
  readonly scale: number;
  /** Every width at which some `@media` rule changes its mind, in CSS
   *  pixels — the unit the author wrote them in. */
  readonly breakpoints: number[];

  constructor(
    sheets: Stylesheet[],
    look: RootLook,
    viewportWidth: number,
    viewportHeight: number,
    scale = 1,
  ) {
    this.look = look;
    this.initial = initialStyle(look);
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.scale = scale;
    const breakpoints = new Set<number>();
    for (const sheet of sheets) {
      for (const rule of sheet.rules) this._index.add(rule);
      for (const bp of sheet.breakpoints) breakpoints.add(bp);
    }
    this.breakpoints = [...breakpoints].sort((a, b) => a - b);
    // css-select's default adapter is domutils; `isHovered` and `isActive`
    // are its documented hooks for exactly this, so `:hover` costs an
    // adapter field rather than a fork of the matcher.
    // `{ ...DomUtils, isTag }` is css-select's own default adapter, spelled
    // out because domutils 4 no longer carries `isTag` — it moved to
    // domhandler — and because the three pointer hooks are the whole reason
    // for building one at all.
    this._adapter = {
      ...DomUtils,
      isTag,
      isHovered: (el: Element) => this._pointer.hovered.has(el),
      isActive: (el: Element) => this._pointer.active.has(el),
      isVisited: () => false,
    };
  }

  /** Whether a pointer move can change what this cascade produces. */
  get hoverSensitive(): boolean {
    return this._index.hoverSensitive;
  }

  setPointer(pointer: PointerState): void {
    this._pointer = pointer;
  }

  /** Which media band a device-pixel width falls in. Two widths in the same
   *  band produce identical styles, which is what lets a resize skip
   *  restyling. */
  mediaBand(width: number): number {
    const cssWidth = width / this.scale;
    let band = 0;
    for (const bp of this.breakpoints) {
      if (cssWidth >= bp) band += 1;
      else break;
    }
    return band;
  }

  /**
   * The computed style for one element, given its parent's. Called once per
   * element per style pass, in document order — the box builder drives it,
   * so there is no second traversal and no map of styles to allocate.
   */
  styleFor(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
  ): ComputedStyle {
    const style = inherit(parentStyle, this.initial);
    const candidates = this._candidates(el);

    // The unit context has to be built twice: once with the parent's font
    // size, so a `font-size: 1.2em` in the cascade resolves against the
    // right em, and again after the font size is settled so every *other*
    // em-relative length in the same rule resolves against this element's.
    const ctxParent: UnitContext = {
      em: parentStyle.fontSize,
      rem: this.initial.fontSize,
      vw: this.viewportWidth,
      vh: this.viewportHeight,
      scale: this.scale,
    };
    for (const c of candidates) {
      for (const d of pick(c)) {
        if (d.prop === 'font-size' || d.prop === 'font') {
          applyDeclaration(style, parentStyle, d.prop, d.value, ctxParent);
        }
      }
    }
    const ctx: UnitContext = { ...ctxParent, em: style.fontSize };
    for (const c of candidates) {
      for (const d of pick(c)) {
        if (d.prop === 'font-size') continue;
        applyDeclaration(style, parentStyle, d.prop, d.value, ctx);
      }
    }

    blockify(style, inFlexContainer);
    return style;
  }

  /**
   * The root's style — nothing above it to inherit from.
   *
   * When the document has no `<body>` of its own, which is every fragment
   * and so the common case for this component, the root box takes the style
   * a `<body>` would have had: the UA sheet's margin and font, and any
   * author `body { … }` rule. Without it a fragment renders hard against the
   * left edge while the same markup inside `<html><body>` does not, which
   * reads as a bug in the renderer rather than as a missing element.
   */
  rootStyle(hasBody: boolean): ComputedStyle {
    const style = { ...this.initial };
    style.display = 'block';
    if (hasBody) return style;
    const synthetic = new DomElement('body', {}, []);
    const bodyStyle = this.styleFor(synthetic, style, false);
    // Only the box the body would have drawn is taken, not its layout role:
    // the root is still the initial containing block.
    bodyStyle.display = 'block';
    bodyStyle.position = 'static';
    bodyStyle.float = 'none';
    return bodyStyle;
  }

  private _candidates(el: Element): Candidate[] {
    const out: Candidate[] = [];
    // A media query's width is CSS pixels; the viewport is kept in device.
    const width = this.viewportWidth / this.scale;

    const consider = (bucket: IndexedRule[] | undefined): void => {
      if (!bucket) return;
      for (const indexed of bucket) {
        const rule = indexed.rule;
        if (!mediaMatches(rule.media, width)) continue;
        if (!indexed.compiled) {
          indexed.compiled = true;
          try {
            indexed.match = compile(rule.selector, {
              adapter: this._adapter,
              xmlMode: false,
            } as unknown as Parameters<typeof compile>[1]) as unknown as (
              node: Element,
            ) => boolean;
          } catch {
            // A selector this matcher does not know (`::-moz-…`, a CSS4 form
            // it has not learnt) drops out of the cascade rather than out of
            // the render.
            indexed.match = null;
          }
        }
        if (!indexed.match || !indexed.match(el)) continue;
        const origin = rule.order < 0 ? Origin.UserAgent : Origin.Author;
        pushRule(out, rule, origin);
      }
    };

    const id = attr(el, 'id');
    if (id) consider(this._index.byId.get(id));
    const className = attr(el, 'class');
    if (className) {
      for (const name of className.split(/\s+/)) {
        if (name) consider(this._index.byClass.get(name));
      }
    }
    consider(this._index.byTag.get(tagOf(el)));
    consider(this._index.universal);

    const hints = presentationHints(el);
    if (hints.length) {
      out.push({
        origin: Origin.Presentation,
        specificity: 0,
        order: 0,
        declarations: hints,
        only: -1,
      });
    }

    const inline = attr(el, 'style');
    if (inline) {
      const declarations = parseDeclarations(inline);
      const normal = declarations.filter((d) => !d.important);
      const important = declarations.filter((d) => d.important);
      if (normal.length) {
        out.push({
          origin: Origin.Inline,
          specificity: 0,
          order: 0,
          declarations: normal,
          only: -1,
        });
      }
      if (important.length) {
        out.push({
          origin: Origin.InlineImportant,
          specificity: 0,
          order: 0,
          declarations: important,
          only: -1,
        });
      }
    }

    out.sort(byCascade);
    return out;
  }
}

function pick(c: Candidate): Declaration[] {
  return c.only < 0 ? c.declarations : [c.declarations[c.only]];
}

function pushRule(out: Candidate[], rule: StyleRule, origin: Origin): void {
  let hasImportant = false;
  for (const d of rule.declarations) {
    if (d.important) {
      hasImportant = true;
      break;
    }
  }
  if (!hasImportant) {
    out.push({
      origin,
      specificity: rule.specificity,
      order: rule.order,
      declarations: rule.declarations,
      only: -1,
    });
    return;
  }
  // A rule with a mix contributes at two levels, so `!important` on one
  // declaration does not drag the rest of the block up with it.
  for (let i = 0; i < rule.declarations.length; i += 1) {
    const d = rule.declarations[i];
    out.push({
      origin: d.important
        ? origin === Origin.UserAgent
          ? Origin.UserAgent
          : Origin.AuthorImportant
        : origin,
      specificity: rule.specificity,
      order: rule.order,
      declarations: rule.declarations,
      only: i,
    });
  }
}

function byCascade(a: Candidate, b: Candidate): number {
  if (a.origin !== b.origin) return a.origin - b.origin;
  if (a.specificity !== b.specificity) return a.specificity - b.specificity;
  return a.order - b.order;
}

/**
 * The presentational attributes, as declarations. They sit above the UA
 * sheet and below every author rule, which is where HTML says they go — and
 * they matter more here than they would in a modern browser, because the
 * documents a desktop application is handed (mail, exported reports,
 * anything generated by a template from 2009) are full of them.
 */
function presentationHints(el: Element): Declaration[] {
  const out: Declaration[] = [];
  const tag = tagOf(el);
  const push = (prop: string, value: string): void => {
    out.push({ prop, value, important: false });
  };

  const align = attr(el, 'align');
  if (align) {
    const v = align.toLowerCase();
    if (tag === 'img' && (v === 'left' || v === 'right')) push('float', v);
    else if (v === 'center' || v === 'middle') push('text-align', 'center');
    else if (v === 'left' || v === 'right' || v === 'justify')
      push('text-align', v);
  }
  const valign = attr(el, 'valign');
  if (valign) push('vertical-align', valign.toLowerCase());

  const bgcolor = attr(el, 'bgcolor');
  if (bgcolor) push('background-color', bgcolor);
  const color = attr(el, 'color');
  if (color && (tag === 'font' || tag === 'basefont')) push('color', color);
  const face = attr(el, 'face');
  if (face && tag === 'font') push('font-family', face);
  const size = attr(el, 'size');
  if (size && tag === 'font') {
    const n = Number(size.replace('+', ''));
    if (Number.isFinite(n))
      push('font-size', `${FONT_SIZE_STEPS[Math.max(1, Math.min(7, n))]}em`);
  }

  // `width`/`height` are lengths on the replaced and table elements and mean
  // nothing anywhere else, which is what stops a `<input width>` from
  // becoming a CSS width the widget then disagrees with.
  if (SIZED.has(tag)) {
    const width = attr(el, 'width');
    if (width) push('width', lengthAttr(width));
    const height = attr(el, 'height');
    if (height) push('height', lengthAttr(height));
  }

  if (tag === 'table') {
    const border = attr(el, 'border');
    if (border && border !== '0')
      push('border', `${Number(border) || 1}px solid currentColor`);
    const spacing = attr(el, 'cellspacing');
    if (spacing) push('border-spacing', lengthAttr(spacing));
  }
  if ((tag === 'td' || tag === 'th') && el.parent) {
    // `cellpadding` lives on the table and applies to its cells, which is the
    // one presentational attribute that is not on the element it styles.
    const table = closestTable(el);
    const padding = table ? attr(table, 'cellpadding') : undefined;
    if (padding) push('padding', lengthAttr(padding));
    const border = table ? attr(table, 'border') : undefined;
    if (border && border !== '0') push('border', '1px solid currentColor');
  }
  if (tag === 'hr') {
    const noshade = attr(el, 'noshade');
    if (noshade !== undefined) push('border-top-width', '2px');
  }
  if (tag === 'ol') {
    const type = attr(el, 'type');
    const mapped = OL_TYPES[type ?? ''];
    if (mapped) push('list-style-type', mapped);
    const start = attr(el, 'start');
    if (start) push('counter-reset', start);
  }
  if (tag === 'img' || tag === 'object') {
    const hspace = attr(el, 'hspace');
    if (hspace) {
      push('margin-left', lengthAttr(hspace));
      push('margin-right', lengthAttr(hspace));
    }
    const vspace = attr(el, 'vspace');
    if (vspace) {
      push('margin-top', lengthAttr(vspace));
      push('margin-bottom', lengthAttr(vspace));
    }
  }
  return out;
}

const SIZED = new Set([
  'img',
  'table',
  'td',
  'th',
  'col',
  'colgroup',
  'iframe',
  'video',
  'canvas',
  'object',
  'embed',
  'hr',
]);

const OL_TYPES: Record<string, string> = {
  '1': 'decimal',
  a: 'lower-alpha',
  A: 'upper-alpha',
  i: 'lower-roman',
  I: 'upper-roman',
};

const FONT_SIZE_STEPS = [1, 0.63, 0.82, 1, 1.13, 1.5, 2, 3];

/** A presentational length: bare numbers are pixels, `50%` stays a percent. */
function lengthAttr(value: string): string {
  const v = value.trim();
  if (v.endsWith('%')) return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? `${n}px` : v;
}

function closestTable(el: Element): Element | null {
  let node = el.parent;
  while (node) {
    if (node.type === 'tag' && (node as Element).name === 'table')
      return node as Element;
    node = node.parent;
  }
  return null;
}
