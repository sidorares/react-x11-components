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
import { svgSizeHint } from '../svg.js';
import {
  asciiLower,
  escapeEnd,
  mediaMatches,
  readIdent,
  startsIdent,
} from './parse.js';
import type { Declaration, StyleRule, Stylesheet } from './parse.js';
import {
  applyDeclaration,
  blockify,
  settleOverflow,
  settleClamp,
  copyStyle,
  decorate,
  inherit,
  initialOne,
  initialStyle,
  isInherited,
} from './style.js';
import type { ComputedStyle, RootLook } from './style.js';
import { parseDeclarations } from './parse.js';
import { CounterStyles, counterStyleRule } from './counter-styles.js';
import type { CounterStyleRule } from './counter-styles.js';
import type { UnitContext } from './values.js';
import { customProperties, substituteIn } from './vars.js';
import type { CustomProps } from './vars.js';

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
  /** The rule's cascade layer, null for none (`StyleRule.layer`). */
  layer: readonly number[] | null;
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

  /**
   * Whether a bucket here could hold a rule for `el`, by its tag, id and
   * classes and without matching anything: an index of a rule or two is
   * asked of every element — the user-agent sheet's `q::before` and
   * `q::after` made every element of a document split its `class` twice —
   * and almost none of them has a rule in it.
   */
  reaches(el: Element): boolean {
    if (this.universal.length || this.byTag.has(tagOf(el))) return true;
    if (this.byId.size) {
      const id = attr(el, 'id');
      if (id && this.byId.has(id)) return true;
    }
    if (this.byClass.size) {
      const className = attr(el, 'class');
      if (className) {
        for (const name of className.split(/\s+/)) {
          if (name && this.byClass.has(name)) return true;
        }
      }
    }
    return false;
  }

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

/** The pseudo-elements a rule can style here. */
type PseudoElement =
  'before' | 'after' | 'first-letter' | 'first-line' | 'marker';

/** A selector's trailing `::before`, `::after`, `::first-letter`,
 *  `::first-line` or `::marker`, or CSS 2's single-colon spelling of any of
 *  its four. */
const PSEUDO_ELEMENT = /::?(before|after|first-letter|first-line)$|::marker$/i;

/**
 * A rule for a pseudo-element, as the pseudo-element it styles and a rule
 * for the element it hangs off, which is what gets matched. The specificity
 * is the whole selector's, the pseudo-element counted in. `p::before`
 * matches `p`; `p ::before` and `p > ::before` have nothing left of their
 * last compound and match any child, `p *` and `p > *`.
 */
function splitPseudoElement(
  rule: StyleRule,
): { which: PseudoElement; rule: StyleRule } | null {
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
    which: (m[1] ?? 'marker').toLowerCase() as PseudoElement,
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
    // an escaped character is part of a name, whatever it is — and a hex
    // escape takes the space after it: `.c\6c ass` is the class `class`
    if (c === '\\') i = escapeEnd(selector, i) - 1;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      (c === ' ' ||
        c === '>' ||
        c === '+' ||
        c === '~' ||
        // CSS's other white space: `div\fp` is a descendant too
        c === '\t' ||
        c === '\n' ||
        c === '\r' ||
        c === '\f')
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
    // Names as the matcher reads them, escapes resolved: `.md\:flex` is
    // the class `md:flex`, and filed under its first half it never matched.
    if (c === '#' || c === '.') {
      const name = readIdent(compound, i + 1);
      if (c === '#' && !id) id = name.value;
      if (c === '.' && !cls) cls = name.value;
      i = Math.max(name.end, i + 1);
    } else if (c === '[') {
      i = balancedEnd(compound, i, '[', ']');
    } else if (c === ':') {
      const skip = compound[i + 1] === ':' ? 2 : 1;
      const end = Math.max(readIdent(compound, i + skip).end, i + skip);
      i = compound[end] === '(' ? balancedEnd(compound, end, '(', ')') : end;
    } else if (startsIdent(compound, i)) {
      const name = readIdent(compound, i);
      if (!tag) tag = name.value.toLowerCase();
      i = name.end;
    } else {
      i += 1;
    }
  }
  if (id) return { kind: 'id', name: id };
  if (cls) return { kind: 'class', name: cls };
  if (tag && tag !== '*') return { kind: 'tag', name: tag };
  return { kind: 'any', name: '' };
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

/** What `Cascade.firstLetterRules` found for an element. */
export interface FirstLetterRules {
  readonly el: Element;
  readonly candidates: readonly unknown[];
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
  /** The rules for pseudo-elements, kept apart: they never style the
   *  element itself, and a document with none of them asks nothing. */
  private _pseudo: Record<PseudoElement, RuleIndex> = {
    before: new RuleIndex(),
    after: new RuleIndex(),
    'first-letter': new RuleIndex(),
    'first-line': new RuleIndex(),
    marker: new RuleIndex(),
  };
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
  /** The counter styles the sheets define, over the predefined ones. */
  readonly counterStyles: CounterStyles;

  /** A font's x-height at a size, for `ex`, where the fonts can say. */
  private _xHeightOf: ((family: string, size: number) => number | null) | null;
  private _xHeights = new Map<string, number>();
  /** The advance of a font's "0" at a size, for `ch`, likewise. */
  private _zeroWidthOf:
    ((family: string, size: number) => number | null) | null;
  private _zeroWidths = new Map<string, number>();
  /** A font's own line height at a size, for `lh` where `line-height` is
   *  `normal`, likewise. */
  private _normalLineOf:
    ((family: string, size: number) => number | null) | null;
  private _normalLines = new Map<string, number>();
  /** Whether any declaration sets a custom property or reads one: without
   *  one, no element's style asks about them. */
  private _vars = false;
  /** Whether any declaration has a length in `lh` or `rlh`: only then is
   *  the line height settled ahead of the declarations that read it. */
  private _lh = false;

  constructor(
    sheets: Stylesheet[],
    look: RootLook,
    viewportWidth: number,
    viewportHeight: number,
    scale = 1,
    xHeight: ((family: string, size: number) => number | null) | null = null,
    zeroWidth: ((family: string, size: number) => number | null) | null = null,
    normalLine: ((family: string, size: number) => number | null) | null = null,
  ) {
    this._xHeightOf = xHeight;
    this._zeroWidthOf = zeroWidth;
    this._normalLineOf = normalLine;
    this.look = look;
    this.initial = initialStyle(look, scale);
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.scale = scale;
    const breakpoints = new Set<number>();
    const counterStyles = new Map<string, CounterStyleRule>();
    for (const sheet of sheets) {
      // a counter style's rule whole over any before it of its name
      for (const { prelude, declarations } of sheet.counterStyles ?? []) {
        const style = counterStyleRule(prelude, declarations);
        if (style) counterStyles.set(style.name, style.rule);
      }
      for (const rule of sheet.rules) {
        if (!this._vars && usesVars(rule.declarations)) this._vars = true;
        if (!this._lh && usesLh(rule.declarations)) this._lh = true;
        const pseudo = splitPseudoElement(rule);
        if (pseudo) this._pseudo[pseudo.which].add(pseudo.rule);
        else this._index.add(rule);
      }
      for (const bp of sheet.breakpoints) breakpoints.add(bp);
    }
    this.breakpoints = [...breakpoints].sort((a, b) => a - b);
    this.counterStyles = new CounterStyles(counterStyles);
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
      // a type selector sees `tagOf`'s name — XHTML's `<svg:svg>` is an
      // `svg` — asked only of a name that could be one: this runs for every
      // type selector tried, and the parser has lowercased the rest
      getName: (el: Element) =>
        el.name.endsWith(':svg') ? tagOf(el) : el.name,
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
      this._pseudo.after.hoverSensitive ||
      this._pseudo['first-letter'].hoverSensitive ||
      this._pseudo['first-line'].hoverSensitive ||
      this._pseudo.marker.hoverSensitive
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
  /** Custom property sets by what made them, for one build (`_customFor`). */
  private _customs = new Map<string, CustomProps>();
  private _ids = new WeakMap<object, number>();
  private _nextId = 1;

  /** A box tree is about to be built: the styles shared in the last build
   *  were computed against a pointer and a viewport that may have moved. */
  beginSharing(): void {
    this._shared.clear();
    this._sharedByMatch.clear();
    this._customs.clear();
  }

  /**
   * An element's custom properties: its parent's, or its own over them —
   * shared by every element whose parent has the same ones and whose own
   * come from the same declarations. Tailwind 4 sets thirty-five of them on
   * every element (`*, ::before, ::after { --tw-shadow: 0 0 #0000; … }`),
   * and a set per element was a fifth of building the boxes; it also kept
   * each element's `var()`s from being replaced once for its siblings,
   * which `substituteIn` remembers by the set they were read against.
   */
  private _customFor(
    parentStyle: ComputedStyle,
    candidates: Candidate[],
  ): CustomProps | null {
    let key = '';
    for (const c of candidates) {
      if (!this._hasCustom(c)) continue;
      key += `${this._idOf(c.declarations)}:${c.only},`;
    }
    const parent = parentStyle.custom;
    if (!key) return parent;
    key = `${parent ? this._idOf(parent) : 0}|${key}`;
    const hit = this._customs.get(key);
    if (hit) return hit;
    const own = new Map<string, string>();
    for (const c of candidates) {
      for (const d of pick(c)) if (d.custom) own.set(d.prop, d.value);
    }
    const made = customProperties(own, parent);
    this._customs.set(key, made);
    return made;
  }

  /** Whether a candidate sets a custom property. */
  private _hasCustom(c: Candidate): boolean {
    if (c.only >= 0) return !!c.declarations[c.only].custom;
    let has = CUSTOM_IN.get(c.declarations);
    if (has === undefined) {
      has = c.declarations.some((d) => !!d.custom);
      CUSTOM_IN.set(c.declarations, has);
    }
    return has;
  }

  /** A number for an object, to key a string by. */
  private _idOf(of: object): number {
    let id = this._ids.get(of);
    if (id === undefined) {
      id = this._nextId++;
      this._ids.set(of, id);
    }
    return id;
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
    if (!index.size || !index.reaches(el)) return null;
    const candidates: Candidate[] = [];
    this._matchInto(index, el, candidates);
    if (!candidates.length) return null;
    // One that no rule gives a `content` is none, whatever else reaches it —
    // `content` is not inherited, and its initial `normal` is nothing here.
    // Tailwind's `*, ::before, ::after` reaches both of every element's.
    if (!candidates.some(setsContent)) return null;
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

  /**
   * The rules for an element's `::first-letter`, or null when none reaches
   * it. They are matched against the element here, and its style computed
   * later by `firstLetterStyle`, because the pseudo-element inherits from
   * the box its letter turns out to be in — a `<span>` the block opens with,
   * a `::before` — which the builder has not reached yet.
   */
  firstLetterRules(el: Element): FirstLetterRules | null {
    const index = this._pseudo['first-letter'];
    if (!index.size || !index.reaches(el)) return null;
    const candidates: Candidate[] = [];
    this._matchInto(index, el, candidates);
    if (!candidates.length) return null;
    candidates.sort(byCascade);
    return { el, candidates };
  }

  /** Whether any rule styles a `::first-line`: a document with none asks
   *  nothing more of its blocks. */
  get hasFirstLine(): boolean {
    return this._pseudo['first-line'].size > 0;
  }

  /**
   * A list item's `::marker` style, inheriting from its own, or null when no
   * rule reaches it (CSS Lists 3, 3.1): the colour and the font a bullet or
   * a number is set in, and a `content` it is set as instead.
   */
  markerStyle(el: Element, style: ComputedStyle): ComputedStyle | null {
    const index = this._pseudo.marker;
    if (!index.size || !index.reaches(el)) return null;
    const candidates: Candidate[] = [];
    this._matchInto(index, el, candidates);
    if (!candidates.length) return null;
    candidates.sort(byCascade);
    const out = this._computeStyle(el, style, false, candidates);
    // a marker's direction is its own unless a rule says otherwise (the
    // HTML style sheet's `::marker { unicode-bidi: isolate }`)
    const set = candidates.some((c) =>
      c.declarations.some((d) => d.prop === 'unicode-bidi'),
    );
    if (!set) out.unicodeBidi = 'isolate';
    return out;
  }

  /**
   * An element's `::first-line` style, inheriting from its own, or null
   * when no rule reaches it (CSS 2.1 5.12.1).
   */
  firstLineStyle(el: Element, style: ComputedStyle): ComputedStyle | null {
    const index = this._pseudo['first-line'];
    if (!index.size) return null;
    const candidates: Candidate[] = [];
    this._matchInto(index, el, candidates);
    if (!candidates.length) return null;
    candidates.sort(byCascade);
    return this._computeStyle(el, style, false, candidates);
  }

  /**
   * The style of a `::first-letter` inside a box of `parentStyle`. It is an
   * inline box, or a float where it floats, whatever the rules say of its
   * `display` or its `position` (CSS 2.1 5.12.2).
   */
  firstLetterStyle(
    rules: FirstLetterRules,
    parentStyle: ComputedStyle,
  ): ComputedStyle {
    const style = this._computeStyle(
      rules.el,
      parentStyle,
      false,
      rules.candidates as Candidate[],
    );
    style.display = style.float === 'none' ? 'inline' : 'block';
    style.position = 'static';
    return style;
  }

  /** The x-height of a style's font: the font's own, asked once per face
   *  and size, or half an em. */
  private _exOf(style: ComputedStyle): number {
    const key = `${style.fontFamily}\u0001${style.fontSize}`;
    let ex = this._xHeights.get(key);
    if (ex === undefined) {
      ex = this._xHeightOf?.(style.fontFamily, style.fontSize) ?? NaN;
      if (!(ex > 0)) ex = style.fontSize * 0.5;
      this._xHeights.set(key, ex);
    }
    return ex;
  }

  /** The advance of a style's font's "0": the font's own, asked once per
   *  face and size, or half an em. */
  private _chOf(style: ComputedStyle): number {
    const key = `${style.fontFamily}\u0001${style.fontSize}`;
    let ch = this._zeroWidths.get(key);
    if (ch === undefined) {
      ch = this._zeroWidthOf?.(style.fontFamily, style.fontSize) ?? NaN;
      if (!(ch > 0)) ch = style.fontSize * 0.5;
      this._zeroWidths.set(key, ch);
    }
    return ch;
  }

  /** A style's computed line height as a length, for `lh`: `normal` as
   *  its font's own, asked once per face and size, or 1.2em. */
  private _lineHeightOf(style: ComputedStyle): number {
    const set = style.lineHeight;
    if (set !== 'normal') {
      return style.lineHeightIsLength ? set : set * style.fontSize;
    }
    const key = `${style.fontFamily}\u0001${style.fontSize}`;
    let line = this._normalLines.get(key);
    if (line === undefined) {
      line = this._normalLineOf?.(style.fontFamily, style.fontSize) ?? NaN;
      if (!(line > 0)) line = style.fontSize * 1.2;
      this._normalLines.set(key, line);
    }
    return line;
  }

  /** `styleFor`, from the rules and hints already gathered for `el`. */
  private _computeStyle(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
    candidates: Candidate[],
  ): ComputedStyle {
    const style = inherit(parentStyle, this.initial);
    // custom properties first, in cascade order, so every `var()` in the
    // declarations below finds the one that wins
    if (this._vars) style.custom = this._customFor(parentStyle, candidates);

    // The unit context has to be built twice: once with the parent's font
    // size, so a `font-size: 1.2em` in the cascade resolves against the
    // right em, and again after the font size is settled so every *other*
    // em-relative length in the same rule resolves against this element's.
    const ctxParent: UnitContext = {
      em: parentStyle.fontSize,
      rem: this.initial.fontSize,
      initial: this.initial,
      vw: this.viewportWidth,
      vh: this.viewportHeight,
      scale: this.scale,
      ex: () => this._exOf(parentStyle),
      ch: () => this._chOf(parentStyle),
      lh: () => this._lineHeightOf(parentStyle),
      rlh: () => this._lineHeightOf(this.initial),
    };
    // the family goes with the size, so an `ex` after it is its font's
    let sized = false;
    let keyword = false;
    for (const c of candidates) {
      for (const d of pick(c)) {
        if (d.prop === 'font-family') {
          this._apply(style, parentStyle, d, ctxParent);
        } else if (d.prop === 'font-size' || d.prop === 'font') {
          // NaN until a size is set, so one the declaration did not take
          // leaves the size where it was, and says nothing of it
          const was = style.fontSize;
          style.fontSize = NaN;
          this._apply(style, parentStyle, d, ctxParent);
          if (Number.isNaN(style.fontSize)) {
            style.fontSize = was;
          } else {
            sized = true;
            keyword = !d.vars && sizeKeyword(d.prop, d.value);
          }
        }
      }
    }
    // The generic `monospace` on its own has a smaller size than the rest,
    // 13 pixels to their 16 (the "fixed" font size every browser keeps):
    // an element whose family becomes it, or stops being it, scales the
    // size it inherits by that, and a keyword size is read from the
    // smaller scale — the size it sets itself stays its own. Blink's
    // CheckForGenericFamilyChange, and why a `<pre>` in a browser is 13px.
    const mono = monospaceOnly(style.fontFamily);
    if (
      sized ? keyword && mono : mono !== monospaceOnly(parentStyle.fontFamily)
    ) {
      style.fontSize *= mono ? FIXED_SIZE : 1 / FIXED_SIZE;
    }
    const ctx: UnitContext = {
      ...ctxParent,
      em: style.fontSize,
      ex: () => this._exOf(style),
      ch: () => this._chOf(style),
      lh: () => this._lineHeightOf(style),
    };
    // the line height, which an `lh` in any other declaration reads, ahead
    // of them: set again with the rest, in its place among them
    if (this._lh) {
      for (const c of candidates) {
        for (const d of pick(c)) {
          if (d.prop === 'line-height') this._apply(style, parentStyle, d, ctx);
        }
      }
    }
    const settled = style.fontSize;
    for (const c of candidates) {
      for (const d of pick(c)) {
        if (d.prop === 'font-size' || d.custom) continue;
        this._apply(style, parentStyle, d, ctx);
      }
    }
    // A `font` is applied again, to keep its other longhands in cascade
    // order, and it sets the size it names as well: the size is the first
    // pass's, which the declarations that outrank the `font` had their say
    // in, and the scale after them. `span { font: 15px/1 Ahem }` under
    // `.b > span { font-size: 3.75em }` was 15px, its `em`s 3.75 of its
    // parent's.
    style.fontSize = settled;

    // A table never keeps HTML's alignment, `-webkit-center` and its kin:
    // the `<td align="center">` every mail centres its body table in
    // centres the table, and the text in its cells stays at their start —
    // as Blink resets it ("tables never support the -webkit-* values for
    // text-align"). An author's own `text-align: center` is not HTML's, and
    // is inherited into the table as it always was.
    if (style.alignBlocks !== null && tagOf(el) === 'table') {
      style.textAlign = 'start';
      style.alignBlocks = null;
    }
    settleClamp(style, parentStyle);
    settleOverflow(style);
    blockify(style, inFlexContainer);
    decorate(style);
    return style;
  }

  /** One declaration, its `var()`s replaced first. One that names a
   *  custom property with no value, and has no fallback, is invalid at
   *  computed-value time, and the property is as though `unset`. */
  private _apply(
    style: ComputedStyle,
    parentStyle: ComputedStyle,
    d: Declaration,
    ctx: UnitContext,
  ): void {
    if (!d.vars) {
      applyDeclaration(style, parentStyle, d.prop, d.value, ctx);
      return;
    }
    // unset first: a value that does not parse once it is substituted is
    // invalid at computed-value time, and does not leave the property what
    // an earlier declaration gave it
    if (isInherited(d.prop)) {
      applyDeclaration(style, parentStyle, d.prop, 'inherit', ctx);
    } else {
      initialOne(style, this.initial, d.prop);
    }
    const value = substituteIn(d.value, style.custom);
    if (value !== null)
      applyDeclaration(style, parentStyle, d.prop, value, ctx);
  }

  /**
   * The root's style — nothing above it to inherit from.
   *
   * When the document has no `<body>` of its own, which is every fragment
   * and so the common case for this component, the root box takes the style
   * a `<body>` would have had: the UA sheet's margin and font, and any
   * author `body { … }` rule. Without it a fragment renders hard against the
   * left edge while the same markup inside `<html><body>` does not, which
   * reads as a bug in the renderer rather than as a missing element. With
   * no `<html>` either, the body inherits from an `<html>` that author
   * `html { … }` rules have styled, as the one a browser implies would be.
   *
   * A document with a `<body>` and no `<html>` — the usual shape of a page
   * that starts `<!DOCTYPE html><title>` — has the root box standing in for
   * that implied `<html>` instead, so an `html { font-size }` still reaches
   * the body. Taken as the initial style, the rule matched nothing and the
   * whole page came out at the theme's size.
   */
  rootStyle(hasBody: boolean, hasHtml = true): ComputedStyle {
    const style = copyStyle(this.initial);
    style.display = 'block';
    if (hasBody && hasHtml) return style;
    const synthetic = new DomElement('body', {}, []);
    let parent = style;
    if (!hasHtml) {
      const html = new DomElement('html', {}, hasBody ? [] : [synthetic]);
      synthetic.parent = html;
      parent = this.styleFor(html, style, false);
      if (hasBody) return asRoot(parent);
    }
    // Only the box the body would have drawn is taken, not its layout role:
    // the root is still the initial containing block.
    return asRoot(this.styleFor(synthetic, parent, false));
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
            indexed.match = compile(noEmptyWords(rule.selector), {
              adapter: this._adapter,
              xmlMode: false,
              pseudos: PSEUDOS,
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
        layer: null,
        specificity: 0,
        order: 0,
        declarations: hints,
        only: -1,
      });
    }

    const inline = attr(el, 'style');
    if (inline) {
      const declarations = parseDeclarations(inline);
      if (!this._vars && usesVars(declarations)) this._vars = true;
      if (!this._lh && usesLh(declarations)) this._lh = true;
      const normal = declarations.filter((d) => !d.important);
      const important = declarations.filter((d) => d.important);
      if (normal.length) {
        out.push({
          origin: Origin.Inline,
          layer: null,
          specificity: 0,
          order: 0,
          declarations: normal,
          only: -1,
        });
      }
      if (important.length) {
        out.push({
          origin: Origin.InlineImportant,
          layer: null,
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

/** An implied element's style as the root box's: its look, not its role —
 *  the root is still a block, in flow, and the initial containing block. */
function asRoot(style: ComputedStyle): ComputedStyle {
  style.display = 'block';
  style.position = 'static';
  style.float = 'none';
  return style;
}

/** `:root` is the `<html>` element: the one a browser implies around a
 *  fragment, whose style the root box takes (`rootStyle`), and never a
 *  fragment's top-level elements, which css-select would take for it. */
const PSEUDOS = {
  root: (el: Element) =>
    el.name === 'html' && !(el.parent && isTag(el.parent as Element)),
  // css-select's, but its ranges and tags lower-cased as ASCII has it, and
  // no other script (CSS 2.1 4.1.3): Unicode's took `:lang(\u212Al)`, a
  // Kelvin sign for the K, for `:lang(kl)`
  lang: (el: Element, code: string | null): boolean => {
    const ranges = (code ?? '')
      .split(',')
      .map((range) => range.trim().replace(/^['"]|['"]$/g, ''))
      .filter((range) => range.length > 0)
      .map((range) => asciiLower(range).split('-'));
    let root = el;
    for (let node: Element | null = el; node;) {
      const value = node.attribs['xml:lang'] ?? node.attribs.lang;
      if (value != null) {
        if (!value) return ranges.some((range) => range[0] === '');
        const tag = asciiLower(value).split('-');
        return ranges.some((range) => langRangeMatches(tag, range));
      }
      root = node;
      const parent: Element['parent'] = node.parent;
      node = parent && isTag(parent as Element) ? (parent as Element) : null;
    }
    // with no element saying, the document's, as its `<meta>` sets it —
    // searched from the document, where a fragment's `<meta>` is a
    // sibling of what it covers
    const pragma = pragmaLanguage(root.parent ?? root);
    if (!pragma) return ranges.some((range) => range[0] === '');
    const tag = asciiLower(pragma).split('-');
    return ranges.some((range) => langRangeMatches(tag, range));
  },
};

/**
 * A selector with its `[attr~=""]` made one that matches nothing: an empty
 * string is no word of a list, and such a selector represents nothing
 * (Selectors 3, 6.3.1) — which the matcher's `~=` is not told, taking the
 * empty word for one between two spaces, or at either end of none.
 */
function noEmptyWords(selector: string): string {
  if (!selector.includes('~=')) return selector;
  return selector.replace(
    /\[[^\]"']*~=\s*(?:""|'')\s*(?:[is]\s*)?\]/gi,
    ':not(*)',
  );
}

/**
 * A document's language as a `<meta http-equiv="content-language">` sets
 * it — HTML's pragma-set default language, the last such `<meta>`'s
 * `content` up to its first white space, and none where it lists more
 * than one — by the document's root element, found once.
 */
function pragmaLanguage(root: { children: unknown[] }): string {
  let lang = PRAGMA_LANGUAGE.get(root);
  if (lang !== undefined) return lang;
  lang = '';
  const stack: { children: unknown[] }[] = [root];
  while (stack.length) {
    const node = stack.pop()! as Element;
    if (
      isTag(node) &&
      node.name === 'meta' &&
      node.attribs['http-equiv']?.trim().toLowerCase() === 'content-language'
    ) {
      const content = node.attribs.content;
      if (content !== undefined && !content.includes(',')) {
        const candidate = content.trim().split(/[\t\n\f\r ]/)[0];
        if (candidate) lang = candidate;
      }
    }
    // in document order: the last one pushed is taken first
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (isTag(child as Element)) stack.push(child as Element);
    }
  }
  PRAGMA_LANGUAGE.set(root, lang);
  return lang;
}

const PRAGMA_LANGUAGE = new WeakMap<object, string>();

/** RFC 4647's extended filtering, of a tag's subtags by a range's, as
 *  css-select does it. */
function langRangeMatches(tag: string[], range: string[]): boolean {
  if (range[0] !== '*' && range[0] !== tag[0]) return false;
  let at = 1;
  for (let r = 1; r < range.length; r += 1) {
    if (range[r] === '*') continue;
    while (at < tag.length && tag[at] !== range[r]) {
      if (tag[at++].length <= 1) return false;
    }
    if (at >= tag.length) return false;
    at += 1;
  }
  return true;
}

/** Whether any of these declarations sets a custom property or reads one. */
function usesVars(declarations: readonly Declaration[]): boolean {
  for (const d of declarations) if (d.custom || d.vars) return true;
  return false;
}

/** Whether any of the declarations has a length in `lh` or `rlh`. */
function usesLh(declarations: readonly Declaration[]): boolean {
  for (const d of declarations) if (LH.test(d.value)) return true;
  return false;
}
const LH = /\d\.?r?lh\b/i;

/** Whether a candidate declares `content`. */
function setsContent(c: Candidate): boolean {
  for (const d of pick(c)) if (d.prop === 'content') return true;
  return false;
}

/** Whether a rule's declarations set a custom property, by the array. */
const CUSTOM_IN = new WeakMap<Declaration[], boolean>();

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
      layer: rule.layer,
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
      layer: rule.layer,
      specificity: rule.specificity,
      order: rule.order,
      declarations: rule.declarations,
      only: i,
    });
  }
}

function byCascade(a: Candidate, b: Candidate): number {
  if (a.origin !== b.origin) return a.origin - b.origin;
  if (a.layer !== b.layer) {
    // a later layer wins over an earlier one whatever the specificity, and
    // for `!important` an earlier one does (CSS Cascade 5, 6.4)
    const by = compareLayers(a.layer, b.layer);
    if (by !== 0) return a.origin >= Origin.AuthorImportant ? -by : by;
  }
  if (a.specificity !== b.specificity) return a.specificity - b.specificity;
  return a.order - b.order;
}

/**
 * Which of two layers wins for a normal declaration: a later one over an
 * earlier one, and a rule in no layer over any, as a rule directly in a
 * layer is over the layers inside it.
 */
function compareLayers(
  a: readonly number[] | null,
  b: readonly number[] | null,
): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return b.length - a.length;
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
    const side = v === 'middle' ? 'center' : v;
    if ((tag === 'img' || tag === 'table') && (v === 'left' || v === 'right')) {
      push('float', v);
    } else if (tag === 'img') {
      // an image's other alignments are its line's
      const va = IMAGE_ALIGN[v];
      if (va) push('vertical-align', va);
    } else if (tag === 'hr') {
      // a rule narrower than its line stands where it is aligned
      if (v === 'left') {
        push('margin-left', '0');
        push('margin-right', 'auto');
      } else if (v === 'right') {
        push('margin-left', 'auto');
        push('margin-right', '0');
      }
    } else if (tag === 'table') {
      // a table's `align` places the table and leaves its text alone: set
      // as its text's, `<table align="center">` — the frame of nearly
      // every mail — stood at the left with its cells' text centred
      if (side === 'center') {
        push('margin-left', 'auto');
        push('margin-right', 'auto');
      }
    } else if (
      ALIGNS_BLOCKS.has(tag) &&
      (side === 'center' || side === 'left' || side === 'right')
    ) {
      // these align the blocks in them as well as their text (HTML's
      // rendering, "align descendants"): the table a `<td align="center">`
      // or a `<div align="center">` holds is centred in it
      push('text-align', `-webkit-${side}`);
    } else if (side === 'center') push('text-align', 'center');
    else if (v === 'left' || v === 'right' || v === 'justify')
      push('text-align', v);
  }
  const valign = attr(el, 'valign');
  if (valign) push('vertical-align', valign.toLowerCase());
  // HTML's `dir` is its element's `direction`: `<table dir="rtl">` starts
  // at the right, and a Hebrew or an Arabic message is written this way
  const dir = attr(el, 'dir')?.toLowerCase();
  if (dir === 'rtl' || dir === 'ltr') push('direction', dir);
  // and it isolates the element from the text around it, or with `auto`
  // takes its first strong letter's direction (HTML's UA sheet: `[dir]`,
  // `[dir=auto i]`, `bdo[dir]`)
  if (dir !== undefined) {
    push(
      'unicode-bidi',
      tag === 'bdo'
        ? 'isolate-override'
        : dir === 'auto'
          ? 'plaintext'
          : 'isolate',
    );
  }

  const bgcolor = attr(el, 'bgcolor');
  if (bgcolor) push('background-color', bgcolor);
  if (BACKGROUNDS.has(tag)) {
    const background = attr(el, 'background')?.trim();
    if (background) {
      push('background-image', `url("${background.replace(/["\\\n]/g, '')}")`);
    }
  }
  if (tag === 'body') {
    // the text's colour, and the links'
    const text = attr(el, 'text');
    if (text) push('color', text);
  } else if (tag === 'a' && attr(el, 'href') !== undefined) {
    const body = closestBody(el);
    const link = body ? attr(body, 'link') : undefined;
    if (link) push('color', link);
  }
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
  } else if (tag === 'svg') {
    // an SVG's are CSS lengths of their own, units and all (SVG 2, 5.1.1)
    const width = attr(el, 'width');
    const w = width ? svgSizeHint(width) : null;
    if (w) push('width', w);
    const height = attr(el, 'height');
    const h = height ? svgSizeHint(height) : null;
    if (h) push('height', h);
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
    // the rule's colour and its thickness
    const color = attr(el, 'color');
    if (color) push('border-top-color', color);
    const size = attr(el, 'size');
    if (size && Number(size) > 0) push('border-top-width', `${Number(size)}px`);
  }
  if ((tag === 'td' || tag === 'th') && attr(el, 'nowrap') !== undefined) {
    push('white-space', 'nowrap');
  }
  if (tag === 'br') {
    // below the floats: `<br clear="all">` after a floated image
    const clear = attr(el, 'clear')?.toLowerCase();
    if (clear === 'all' || clear === 'both') push('clear', 'both');
    else if (clear === 'left' || clear === 'right') push('clear', clear);
  }
  if (tag === 'ol') {
    const type = attr(el, 'type');
    const mapped = OL_TYPES[type ?? ''];
    if (mapped) push('list-style-type', mapped);
    // the number a list starts at is its `list-item` counter's, one before
    // it, or counting down one after it (HTML's rendering, "Lists")
    const start = htmlInteger(attr(el, 'start'));
    if (start !== null) {
      push(
        'counter-reset',
        attr(el, 'reversed') !== undefined
          ? `reversed(list-item) ${start + 1}`
          : `list-item ${start - 1}`,
      );
    }
  }
  if (tag === 'ul') {
    const type = attr(el, 'type')?.toLowerCase();
    if (type && BULLETS.has(type)) push('list-style-type', type);
  }
  if (tag === 'li') {
    // an item's `value` is the number it goes on from
    const value = htmlInteger(attr(el, 'value'));
    if (value !== null) push('counter-set', `list-item ${value}`);
    const type = attr(el, 'type');
    const mapped =
      OL_TYPES[type ?? ''] ??
      (type && BULLETS.has(type.toLowerCase()) ? type.toLowerCase() : null);
    if (mapped) push('list-style-type', mapped);
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

/** An image's `align` other than a side, as its `vertical-align`. */
const IMAGE_ALIGN: Record<string, string> = {
  top: 'top',
  texttop: 'text-top',
  middle: 'middle',
  absmiddle: 'middle',
  center: 'middle',
  bottom: 'baseline',
  baseline: 'baseline',
  absbottom: 'bottom',
};

/** The elements whose `align` aligns the blocks in them too. */
const ALIGNS_BLOCKS = new Set([
  'div',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);

/** The elements a `background` attribute gives a background image. */
const BACKGROUNDS = new Set([
  'body',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);

function closestBody(el: Element): Element | null {
  let node = el.parent;
  while (node) {
    if (node.type === 'tag' && (node as Element).name === 'body') {
      return node as Element;
    }
    node = node.parent;
  }
  return null;
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

/** What a `<ul type>` or an `<li type>` names that is not a number. */
const BULLETS = new Set(['disc', 'circle', 'square', 'none']);

/** An attribute read as HTML reads an integer: its leading digits, signed,
 *  whatever follows them; null where it has none. A counter is a 32-bit
 *  integer in a browser, and one past that is kept to it. */
function htmlInteger(value: string | undefined): number | null {
  const match = value === undefined ? null : /^\s*([+-]?\d+)/.exec(value);
  if (!match) return null;
  return Math.max(-2147483648, Math.min(2147483647, Number(match[1])));
}

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

/** The generic fixed-width family's size to everyone else's: 13 to 16. */
const FIXED_SIZE = 13 / 16;

/** Whether a family list is the generic `monospace` and nothing else,
 *  which has the smaller size; a list with a fallback after it does not,
 *  so `monospace, monospace` keeps the size it had. */
function monospaceOnly(family: string): boolean {
  return family.length === 9 && family.toLowerCase() === 'monospace';
}

/** Whether a `font-size`, or the size in a `font`, is an absolute-size
 *  keyword, or `initial`, which is `medium`. */
function sizeKeyword(prop: string, value: string): boolean {
  const words = value.trim().toLowerCase();
  if (prop === 'font-size') return ABSOLUTE_SIZES.has(words);
  for (const word of words.split(/[\s/]+/)) {
    if (ABSOLUTE_SIZES.has(word)) return true;
  }
  return false;
}

const ABSOLUTE_SIZES = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'initial',
]);
