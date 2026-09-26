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

/** A style handed to every element with the same sharing key, and the key
 *  that element's children share under (`Cascade.sharedStyleFor`). */
export interface SharedStyle {
  style: ComputedStyle;
  key: number;
}

/** A compiled matcher, kept beside the rule it came from. */
interface IndexedRule {
  rule: StyleRule;
  match: ((el: Element) => boolean) | null;
  /** Set once compilation has been attempted, so a selector `css-select`
   *  refuses is not recompiled once per element for the rest of the pass. */
  compiled: boolean;
  /** Which rule this is, in a sharing key (`Cascade.sharedStyleFor`). */
  id: number;
}

/**
 * What makes a selector's match depend on more than the element's own tag and
 * attributes and its ancestors' — its siblings, where it sits among them,
 * what it contains, or where the document is scrolled to. Two elements that
 * look alike from the root down can still differ under a rule with one of
 * these, so an element such a rule could reach does not share its style
 * (`Cascade.sharedStyleFor`). css-select spells some of them under other
 * names, and those count too: `:checked` and `:selected` read which option
 * comes first, `:disabled` and `:enabled` which legend does, and `:parent`
 * and `:contains()` the element's contents. Over-broad on purpose: a `+` or
 * `~` inside an attribute value, or the `~=` operator, costs sharing and
 * nothing else.
 */
const UNSHAREABLE =
  /[+~]|:(?:first|last|only)-(?:child|of-type)|:nth-|:empty|:blank|:has\(|:focus-within|:target|:scope|:(?:checked|selected|disabled|enabled|parent)\b|:i?contains\(/;

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
  /** The buckets holding a rule an element cannot share its style under
   *  (`UNSHAREABLE`): the ids, classes and tags whose elements compute
   *  their own, and whether the universal bucket makes every element do so. */
  readonly ownStyleIds = new Set<string>();
  readonly ownStyleClasses = new Set<string>();
  readonly ownStyleTags = new Set<string>();
  ownStyleEverywhere = false;
  /** How many rules are in here, so an empty index costs one comparison. */
  size = 0;
  private _nextId = 0;

  add(rule: StyleRule): void {
    this.size += 1;
    const indexed: IndexedRule = {
      rule,
      match: null,
      compiled: false,
      id: this._nextId++,
    };
    if (rule.selector.includes(':hover') || rule.selector.includes(':active')) {
      this.hoverSensitive = true;
    }
    const key = rightmostKey(rule.selector);
    if (UNSHAREABLE.test(rule.selector)) {
      if (key.kind === 'id') this.ownStyleIds.add(key.name);
      else if (key.kind === 'class') this.ownStyleClasses.add(key.name);
      else if (key.kind === 'tag') this.ownStyleTags.add(key.name);
      else this.ownStyleEverywhere = true;
    }
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

/** A selector's trailing `::before` or `::after`, or CSS 2's single-colon
 *  spelling of either. */
const PSEUDO_ELEMENT = /::?(before|after)$/i;

/**
 * A rule for a `::before` or `::after`, as the pseudo-element it styles and
 * a rule for the element it hangs off, which is what gets matched. The
 * specificity is the whole selector's, the pseudo-element counted in.
 * `p::before` matches `p`; `p ::before` and `p > ::before` have nothing left
 * of their last compound and match any child, `p *` and `p > *`.
 */
function splitPseudoElement(
  rule: StyleRule,
): { which: 'before' | 'after'; rule: StyleRule } | null {
  const m = PSEUDO_ELEMENT.exec(rule.selector);
  if (!m) return null;
  const head = rule.selector.slice(0, m.index);
  const trimmed = head.trimEnd();
  const selector = !trimmed
    ? '*'
    : head !== trimmed || /[>+~]$/.test(trimmed)
      ? `${trimmed} *`
      : trimmed;
  return {
    which: m[1].toLowerCase() as 'before' | 'after',
    rule: { ...rule, selector },
  };
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
  /** The rules for `::before` and `::after`, kept apart: they never style
   *  the element itself, and a document with none of them asks nothing. */
  private _pseudo = { before: new RuleIndex(), after: new RuleIndex() };
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
      for (const rule of sheet.rules) {
        const pseudo = splitPseudoElement(rule);
        if (pseudo) this._pseudo[pseudo.which].add(pseudo.rule);
        else this._index.add(rule);
      }
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
    return (
      this._index.hoverSensitive ||
      this._pseudo.before.hoverSensitive ||
      this._pseudo.after.hoverSensitive
    );
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

  /** Computed styles by sharing key, for one build (`sharedStyleFor`): one
   *  map for the elements shared without matching, one for the elements
   *  shared by what they matched. */
  private _shared = new Map<string, SharedStyle>();
  private _sharedByMatch = new Map<string, SharedStyle>();
  private _nextShareKey = 1;

  /** A box tree is about to be built: the styles shared in the last build
   *  were computed against a pointer and a viewport that may have moved. */
  beginSharing(): void {
    this._shared.clear();
    this._sharedByMatch.clear();
  }

  /**
   * `styleFor`, shared between the elements that must compute the same
   * style, with the key this element's children share under.
   *
   * A style is a function of the parent's style, the rules that match, the
   * presentational attributes, the inline style and whether the parent is a
   * flex container. Outside the rules `UNSHAREABLE` names, what matches
   * depends only on the element's tag and attributes and its ancestors', and
   * the hints read nothing else either. So the key is the parent's key, the
   * flex flag, the tag and every attribute — plus the pointer state where a
   * rule asks for it — and an element whose key has been computed in this
   * build takes that style object, matching nothing. A long document is a
   * few kinds of element many times over: the benchmark's 600 KB report is
   * 9,039 elements and 110 keys, and computing every style again was a third
   * of an edit.
   *
   * An element a rule `UNSHAREABLE` could reach is matched, since where it
   * sits decides what matches — and then shared by what matched: the same
   * parent, attributes and rules make the same style. That is what keeps a
   * striped table from being a style per row, and it keeps the key its
   * children share under, which an element-per-key would have taken from the
   * whole subtree.
   *
   * The style is handed out shared, so nothing may write to it — nothing
   * does after the cascade, and `rootStyle` does not go through here.
   */
  sharedStyleFor(
    el: Element,
    parentStyle: ComputedStyle,
    parentKey: number,
    inFlexContainer: boolean,
  ): SharedStyle {
    let key = `${parentKey}\u0001${inFlexContainer ? 1 : 0}`;
    const tag = tagOf(el);
    key += `\u0001${tag.length}:${tag}`;
    if (this._index.hoverSensitive) {
      if (this._pointer.hovered.has(el)) key += '\u0001:hover';
      if (this._pointer.active.has(el)) key += '\u0001:active';
    }
    const attribs = el.attribs;
    for (const name in attribs) {
      const value = attribs[name];
      key += `\u0001${name.length}:${name}=${value.length}:${value}`;
    }
    if (!this._shareable(el)) {
      const matched: number[] = [];
      const candidates = this._candidates(el, matched);
      key += `\u0001${matched.join(',')}`;
      let shared = this._sharedByMatch.get(key);
      if (shared === undefined) {
        shared = {
          style: this._computeStyle(
            el,
            parentStyle,
            inFlexContainer,
            candidates,
          ),
          key: this._nextShareKey++,
        };
        this._sharedByMatch.set(key, shared);
      }
      return shared;
    }
    let shared = this._shared.get(key);
    if (shared === undefined) {
      shared = {
        style: this.styleFor(el, parentStyle, inFlexContainer),
        key: this._nextShareKey++,
      };
      this._shared.set(key, shared);
    }
    return shared;
  }

  /** Whether no rule `UNSHAREABLE` names could reach this element: the same
   *  buckets `_candidates` looks in. */
  private _shareable(el: Element): boolean {
    const index = this._index;
    if (index.ownStyleEverywhere) return false;
    if (index.ownStyleTags.size && index.ownStyleTags.has(tagOf(el))) {
      return false;
    }
    if (index.ownStyleIds.size) {
      const id = attr(el, 'id');
      if (id && index.ownStyleIds.has(id)) return false;
    }
    if (index.ownStyleClasses.size) {
      const className = attr(el, 'class');
      if (className) {
        for (const name of className.split(/\s+/)) {
          if (name && index.ownStyleClasses.has(name)) return false;
        }
      }
    }
    return true;
  }

  /**
   * The computed style for one element, given its parent's. The box builder
   * asks for every element in document order, through `sharedStyleFor`, so
   * a style is computed only for the elements with none to share.
   */
  styleFor(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
  ): ComputedStyle {
    return this._computeStyle(
      el,
      parentStyle,
      inFlexContainer,
      this._candidates(el),
    );
  }

  /**
   * The style of an element's `::before` or `::after`, or null when it has
   * none: no rule reaches it, or the rules that do leave `content` at
   * `normal` or `none`, which make no box (CSS 2.1 12.2). It inherits from
   * the element's own style, as a pseudo-element does, and a flex
   * container's are flex items. Not shared: few elements have one, and where
   * a rule gives every element one — a clearfix — the style is the cost of
   * the box it makes.
   */
  pseudoStyleFor(
    el: Element,
    which: 'before' | 'after',
    elementStyle: ComputedStyle,
  ): ComputedStyle | null {
    const index = this._pseudo[which];
    if (!index.size) return null;
    const candidates: Candidate[] = [];
    this._matchInto(index, el, candidates);
    if (!candidates.length) return null;
    candidates.sort(byCascade);
    const style = this._computeStyle(
      el,
      elementStyle,
      elementStyle.display === 'flex' || elementStyle.display === 'inline-flex',
      candidates,
    );
    return style.content === 'normal' || style.content === 'none'
      ? null
      : style;
  }

  /** `styleFor`, from the rules and hints already gathered for `el`. */
  private _computeStyle(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
    candidates: Candidate[],
  ): ComputedStyle {
    const style = inherit(parentStyle, this.initial);

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

  /** The rules of `index` that match `el`, pushed onto `out` as candidates,
   *  and their ids onto `matched` in the order they were tried. */
  private _matchInto(
    index: RuleIndex,
    el: Element,
    out: Candidate[],
    matched?: number[],
  ): void {
    // A media query's width is CSS pixels; the viewport is kept in device.
    const width = this.viewportWidth / this.scale;

    const consider = (bucket: IndexedRule[] | undefined): void => {
      if (!bucket) return;
      for (const indexed of bucket) {
        const rule = indexed.rule;
        if (!mediaMatches(rule.media, width, this.look.colorScheme)) continue;
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
        matched?.push(indexed.id);
        const origin = rule.order < 0 ? Origin.UserAgent : Origin.Author;
        pushRule(out, rule, origin);
      }
    };

    const id = attr(el, 'id');
    if (id) consider(index.byId.get(id));
    const className = attr(el, 'class');
    if (className) {
      for (const name of className.split(/\s+/)) {
        if (name) consider(index.byClass.get(name));
      }
    }
    consider(index.byTag.get(tagOf(el)));
    consider(index.universal);
  }

  /** Every rule and hint that applies to `el`, in cascade order — and, into
   *  `matched` when it is passed, the ids of the rules, in the order they
   *  were tried. */
  private _candidates(el: Element, matched?: number[]): Candidate[] {
    const out: Candidate[] = [];
    this._matchInto(this._index, el, out, matched);

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
