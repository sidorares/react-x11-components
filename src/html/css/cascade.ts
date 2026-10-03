// The cascade: which declarations reach an element, in what order, and what
// they compute to.
//
// Matching is `css-select`'s. That is the one part of a CSS engine where a
// hand-written version is reliably both slower and wronger — `css-select`
// compiles a selector to a closure once and the closure is what runs per
// element, and it has the combinator, `:nth-child(an+b)` and attribute-
// operator cases right — so it is imported, through an adapter that answers
// `:hover` from this renderer's own pointer state, and pseudo-classes that
// answer `:focus` and its kin from which element's widget holds the focus.
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

import {
  NON_RENDERED,
  ShadowRoot,
  assignedSlot,
  attr,
  isElement,
  shadowRootAround,
  shadowRootOf,
  tagOf,
} from '../dom.js';
import { systemColorTable, usedColorScheme } from './color.js';
import {
  asciiLower,
  escapeEnd,
  mediaMatches,
  readIdent,
  startsIdent,
} from './parse.js';
import type {
  Declaration,
  KeyframesRule,
  StyleRule,
  Stylesheet,
} from './parse.js';
import { NO_ANIMATIONS, restingFrames, spanAt, tracksOf } from './animation.js';
import type { Animations } from './animation.js';
import type { Keyframe } from './parse.js';
import { discrete, interpolateField } from './interpolate.js';
import type { AnimationTimeline, Sample } from './timeline.js';
import {
  animatedWillChange,
  fieldsAnimatedBy,
  noteAnimated,
} from './timeline.js';
import {
  animatedFields,
  applyDeclaration,
  blockify,
  settleAlign,
  settleButton,
  settleContentVisibility,
  settleOverflow,
  settleOutline,
  settleClamp,
  copyStyle,
  decorate,
  familyList,
  inherit,
  initialOne,
  initialStyle,
  isInherited,
} from './style.js';
import type { ComputedStyle, RootLook } from './style.js';
import type { FontFamilies } from '../fonts.js';
import { parseDeclarations } from './parse.js';
import { CounterStyles, counterStyleRule } from './counter-styles.js';
import type { CounterStyleRule } from './counter-styles.js';
import { PALETTE_CHROME } from './ua.js';
import type { UnitContext } from './values.js';
import { FIXED_SIZE, keywordFontSize, viewportUnit } from './values.js';
import { customProperties, hasVar, substituteIn, validVars } from './vars.js';
import type { CustomProps } from './vars.js';
import {
  ROOT_BOX_PROPS,
  SHAPE_TAGS,
  isShapeProp,
  isUse,
  shapeValue,
  useHref,
} from './shapes.js';
import type { ShapeContext, ShapeStyle, ShapeStyles } from './shapes.js';

/** Where a declaration came from. Higher wins before specificity is asked. */
const enum Origin {
  UserAgent = 0,
  Presentation = 1,
  Author = 2,
  Inline = 3,
  /** What an animation leaves (`restingFrames`): over every declaration
   *  but an `!important` one (CSS Cascade 5, 6.1). */
  Animation = 4,
  AuthorImportant = 5,
  InlineImportant = 6,
  /** The UA sheet's `!important`, over every author's (CSS Cascade 4,
   *  6.1): HTML's `contain: size` on an image whose `sizes` is `auto`. */
  UserAgentImportant = 7,
}

/** Whether a candidate is the UA sheet's, normal or `!important`. */
function fromUserAgent(origin: Origin): boolean {
  return origin === Origin.UserAgent || origin === Origin.UserAgentImportant;
}

interface Candidate {
  origin: Origin;
  /** How many shadow trees deep the tree the declarations were written for
   *  is (`TreeInfo.depth`), the document's 0: of two from different trees,
   *  the outer one's normal declarations win and the inner one's
   *  `!important` ones (CSS Cascade 5, 6.1, "context"). */
  context: number;
  /** That tree's shadow root, null for the document's: where an
   *  `animation-name` in its declarations finds its `@keyframes` first
   *  (CSS Scoping 1, 3.5). */
  tree: ShadowRoot | null;
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

/**
 * The styles of the build before, for a build that only some elements'
 * styles can differ in (`Cascade.beginSharing`): what each element's came
 * to, and the elements to style again — `restyle`, each with everything in
 * it, since a style is its parent's and the rules', and a rule reads an
 * element's ancestors.
 */
export interface KeptStyles {
  styles: ReadonlyMap<Element, { style: ComputedStyle; inFlex: boolean }>;
  restyle: ReadonlySet<Element>;
}

/** A shadow tree's sheets, as the cascade is handed them: every tree whose
 *  sheets read the same — `key` — shares their rules (`Cascade.bindShadows`),
 *  which a component stamped out on every card of a page has parsed and
 *  indexed once. */
export interface ShadowSheets {
  key: string;
  sheets: Stylesheet[];
}

/**
 * The rules written for one tree (CSS Scoping 1, 3.2): the document's, or a
 * set of shadow trees'. Its ordinary rules are in the cascade's indexes,
 * filed under `id` (`IndexedRule.scope`); what is here is what is asked of
 * the elements at its edges — its host, from inside (`:host`), the light
 * children assigned to its slots (`::slotted()`), and the parts of the
 * shadow trees of the hosts in it (`::part()`) — and its `@keyframes`.
 */
interface TreeRules {
  id: number;
  host: HostRule[];
  slotted: SlottedRule[];
  parts: PartRule[];
  keyframes: Map<string, KeyframesRule[]>;
}

function newTreeRules(id: number): TreeRules {
  return { id, host: [], slotted: [], parts: [], keyframes: new Map() };
}

/** The tree an element is in: its shadow root, null for the document's,
 *  how many shadow trees deep it is — the document's 0 — and its rules. */
interface TreeInfo {
  root: ShadowRoot | null;
  depth: number;
  rules: TreeRules;
}

/** What a rule is for of an element — itself, or a pseudo-element of it. */
type PseudoTarget = '' | PseudoElement;

/** A rule whose subject is its tree's host, seen from inside: `:host`,
 *  `:host()` or `:host-context()` alone, or before a pseudo-element. */
interface HostRule {
  rule: StyleRule;
  /** Its id in a sharing key, below every index's (`_scopedId`). */
  id: number;
  pseudo: PseudoTarget;
  host: (host: Element) => boolean;
}

/** `::slotted()`: what the slot has to be, in its tree, and what the light
 *  child assigned to it has to be. */
interface SlottedRule {
  rule: StyleRule;
  id: number;
  pseudo: PseudoTarget;
  slot: (slot: Element) => boolean;
  el: (el: Element) => boolean;
}

/** `::part()`: what the host has to be, in the rule's tree, the part names
 *  the element has to have, and the pseudo-classes after it. `inner` for
 *  one that hangs off `:host`, which is the tree's own host's parts, seen
 *  from inside: the elements of the tree, and of the trees inside it that
 *  export theirs to it (CSS Shadow Parts 1, 4.1). */
interface PartRule {
  rule: StyleRule;
  id: number;
  pseudo: PseudoTarget;
  host: (host: Element) => boolean;
  names: readonly string[];
  el: ((el: Element) => boolean) | null;
  inner: boolean;
}

/** The user agent's rules' tree (`IndexedRule.scope`): every one. */
const UA_SCOPE = -1;

/** A selector that says something of the edge of a shadow tree. */
const SCOPING = /:host|::?(?:slotted|part)\(/i;

/** What the pointer entering or leaving an element can change
 *  (`Cascade.hoverTouches`): nothing, the element and what is in it, or
 *  those and the siblings after it. */
export type HoverTouch = 0 | 1 | 2;
export const HOVER_UNTOUCHED = 0;
export const HOVER_TOUCHED = 1;
export const HOVER_FOLLOWED = 2;

/** Which pseudo-elements' rules test the pointer (`Cascade.hoverPseudo`). */
export const HOVER_PSEUDO_NONE = 0;
export const HOVER_PSEUDO_GENERATED = 1;
export const HOVER_PSEUDO_OTHER = 2;

/** The pseudo-elements a pointer move can restyle: `::selection`'s style
 *  is worked out as a selection is painted. */
const POINTER_PSEUDO_ELEMENTS = [
  'before',
  'after',
  'first-letter',
  'first-line',
  'marker',
] as const;

/** A compiled matcher, kept beside the rule it came from. */
interface IndexedRule {
  rule: StyleRule;
  match: ((el: Element) => boolean) | null;
  /** Set once compilation has been attempted, so a selector `css-select`
   *  refuses is not recompiled once per element for the rest of the pass. */
  compiled: boolean;
  /** Which rule this is, in a sharing key (`Cascade.sharedStyleFor`). */
  id: number;
  /** The ids and classes the rule asks of its subject's ancestors
   *  (`ancestorKeys`): an element with no ancestor of one of them is not
   *  the rule's, which is known without matching it. Null until first
   *  asked, and set by `Cascade._needsOf` alone, which notes the names. */
  needs: readonly string[] | null;
  /** Whether the selector is the class or the id the rule is filed under,
   *  and nothing else (`keyOnly`): an element its bucket is asked for is
   *  the rule's, with no matcher to run. */
  keyOnly: boolean;
  /** For a rule kept for drawings: whether it declares something a
   *  drawing's root does not have from its box's style. Null until asked. */
  root: boolean | null;
  /** The selector as it is matched in the tree a `<use>`'s copy is in
   *  (`Cascade.shapeStyles`), compiled once one is first asked. */
  inCopy: ((el: Element) => boolean) | null;
  inCopyCompiled: boolean;
  /** The tree the rule is for (`TreeRules.id`): the document's 0, a set
   *  of shadow trees' their own, and the user agent's every tree's
   *  (`UA_SCOPE`). */
  scope: number;
  /** For a rule written from inside a shadow tree past its top, `:host(…)
   *  .x`: what the tree's host has to be, asked once the rest of the
   *  selector has matched (`readHost`). Null in every other rule. */
  host: ((host: Element) => boolean) | null;
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
 * and `:contains()` the element's contents; and `:has-slotted` reads what
 * the host it is in has. Over-broad on purpose: a `+` or `~` inside an
 * attribute value, or the `~=` operator, costs sharing and nothing else.
 */
const UNSHAREABLE =
  /[+~]|:(?:first|last|only)-(?:child|of-type)|:nth-|:empty|:blank|:has\(|:has-slotted|:focus-within|:target|:scope|:(?:checked|selected|disabled|enabled|parent)\b|:i?contains\(/;

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
  /** …and focus-sensitive, for a widget taking the focus or giving it up. */
  focusSensitive = false;
  /** The rules that test `:hover` or the focus, in buckets of their own:
   *  the ones whose answers a pointer move or a focus change can change,
   *  which is all that is asked to know whether an element's did
   *  (`Cascade.pointerChanged`). Null until there is one. */
  pointer: RuleIndex | null = null;
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
    return this.names(el);
  }

  /** Whether a bucket here is for `el`'s id, or for a class of its. */
  names(el: Element): boolean {
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

  add(
    rule: StyleRule,
    key = rightmostKey(rule.selector),
    scope = 0,
    host: ((host: Element) => boolean) | null = null,
  ): void {
    this.size += 1;
    const indexed: IndexedRule = {
      rule,
      match: null,
      compiled: false,
      id: this._nextId++,
      needs: null,
      keyOnly: keyOnly(rule.selector, key),
      root: null,
      inCopy: null,
      inCopyCompiled: false,
      scope,
      host,
    };
    if (rule.selector.includes(':hover') || rule.selector.includes(':active')) {
      this.hoverSensitive = true;
    }
    const focus = FOCUS.test(rule.selector);
    if (focus) this.focusSensitive = true;
    if (UNSHAREABLE.test(rule.selector)) {
      if (key.kind === 'id') this.ownStyleIds.add(key.name);
      else if (key.kind === 'class') this.ownStyleClasses.add(key.name);
      else if (key.kind === 'tag') this.ownStyleTags.add(key.name);
      else this.ownStyleEverywhere = true;
    }
    this._bucket(key).push(indexed);
    if (focus || HOVER.test(rule.selector)) {
      this.pointer ??= new RuleIndex();
      this.pointer.size += 1;
      this.pointer._bucket(key).push(indexed);
    }
  }

  private _bucket(key: ReturnType<typeof rightmostKey>): IndexedRule[] {
    return key.kind === 'id'
      ? mapBucket(this.byId, key.name)
      : key.kind === 'class'
        ? mapBucket(this.byClass, key.name)
        : key.kind === 'tag'
          ? mapBucket(this.byTag, key.name)
          : this.universal;
  }
}

/** The pseudo-elements a rule can style here. */
type PseudoElement =
  'before' | 'after' | 'first-letter' | 'first-line' | 'marker' | 'selection';

/** A selector's trailing `::before`, `::after`, `::first-letter`,
 *  `::first-line`, `::marker` or `::selection`, or CSS 2's single-colon
 *  spelling of any of its four. */
const PSEUDO_ELEMENT =
  /::?(before|after|first-letter|first-line)$|::(marker|selection)$/i;

/**
 * What a `::selection` makes of the text it covers (CSS Pseudo 4, 3.2): the
 * colour the text is drawn in, null for its own, and the band under it,
 * null for none.
 */
export interface SelectionStyle {
  color: string | null;
  background: string | null;
}

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
    which: (m[1] ?? m[2]).toLowerCase() as PseudoElement,
    rule: { ...rule, selector },
  };
}

/**
 * The compounds of a selector that test `:hover`, each without it (and
 * without an `:active` beside it), and whether one is followed by a sibling
 * combinator, which reaches the element's later siblings.
 *
 * A `:hover` inside `:is()`, `:where()` or `:not()` is found where it is:
 * each takes a selector list and matches the element it is written on, so
 * a list entry of one compound tests that element — `a:not(:hover)` is a
 * compound of `a`'s that tests the pointer — and an entry with combinators
 * in it names an ancestor or an earlier sibling, as it would outside.
 * Tailwind 4 writes every `group-hover:` that way, `:is(:where(.group):hover
 * *)`, and a page of them built its document again on every move. Whatever
 * the nesting, the element whose hover changed is one a compound found here
 * matches, and what changes with it is itself, what is in it, and what
 * follows it where a sibling combinator is in play: a selector reads an
 * element, its ancestors and the siblings before each of them, and nothing
 * else. `nested` is left for a function this cannot read a selector list
 * in — `:nth-child(… of :hover)`, `:host()` — which reaches elements no
 * compound names.
 *
 * A `:hover` in a compound's `:has()` is the other way about, since what
 * it tests is below: the compound, without its `:has()`, is an ancestor of
 * the element the pointer is over — or an earlier sibling of it or of an
 * ancestor, where the argument starts at a sibling (Selectors 4, 4.5). So
 * it is given as an anchor (`has`).
 *
 * `:active` is not the pointer's here: nothing sets it (`setPointer` is
 * handed none), so a selector that tests only it never changes as the
 * pointer moves — Wikipedia's buttons' `:focus:not(:active)` among them.
 * A press that sets it would have to be counted here too.
 *
 * The focus is the other state a change of reaches only some elements, and
 * `kind` says which is asked for: `FOCUS_STATE` finds the compounds that
 * test `:focus`, `:focus-visible` or `:focus-within` the same way. Either
 * kind leaves the other's pseudo-classes out of a compound as well as its
 * own, so what is left matches wherever the compound could, in any state —
 * `a:focus:hover` is a compound of `a`'s, for both.
 */
export function pointerCompounds(
  selector: string,
  kind: StateKind = HOVER_STATE,
): PointerCompounds {
  const out: PointerCompounds = {
    compounds: [],
    siblings: false,
    nested: false,
    has: [],
    followed: [],
  };
  scanComplex(selector, out, kind);
  return out;
}

/** A state a change of reaches only the elements some compound names: which
 *  selectors mention it at all, which tests it anywhere, and which of the
 *  pseudo-classes `STATE_PSEUDO_AT` takes out of a compound are its own. */
export interface StateKind {
  mentions: RegExp;
  any: RegExp;
  own: RegExp;
}

/** The pointer's: `:hover`, and `:active`, which nothing sets. */
export const HOVER_STATE: StateKind = {
  mentions: /:(?:hover|active)/i,
  any: /:hover(?![\w-])/i,
  own: /^:hover$/i,
};

/** The focus's: `:focus`, `:focus-visible` and `:focus-within`. */
export const FOCUS_STATE: StateKind = {
  mentions: /:focus/i,
  any: /:focus(?:-visible|-within)?(?![\w-])/i,
  own: /^:focus/i,
};

export interface PointerCompounds {
  compounds: string[];
  siblings: boolean;
  nested: boolean;
  has: { anchor: string; siblings: boolean }[];
  /** The compounds and anchors a sibling combinator follows: the ones
   *  whose elements' later siblings change with them. */
  followed: string[];
}

/** The functions that take a selector list and match the element they are
 *  written on (Selectors 4, 4.2 to 4.4), under the names css-select and
 *  older sheets know them by. */
const MATCHES_ANY = /^(?:is|where|not|matches|any|-webkit-any|-moz-any)$/i;

/** The compounds of a complex selector, each with the combinator after it. */
function compoundsOf(selector: string): { text: string; next: string }[] {
  const parts: { text: string; next: string }[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  const split = (end: number, next: string): void => {
    const text = selector.slice(start, end).trim();
    if (text) parts.push({ text, next });
    else if (parts.length && next !== ' ') parts[parts.length - 1].next = next;
  };
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (quote) {
      if (c === quote && selector[i - 1] !== '\\') quote = '';
      continue;
    }
    if (c === '\\') i = escapeEnd(selector, i) - 1;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[\s>+~]/.test(c)) {
      split(i, c === '+' || c === '~' || c === '>' ? c : ' ');
      start = i + 1;
    }
  }
  split(selector.length, '');
  return parts;
}

/** A selector list's entries: split at its top-level commas. */
function selectorsOf(list: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (quote) {
      if (c === quote && list[i - 1] !== '\\') quote = '';
    } else if (c === '\\') i = escapeEnd(list, i) - 1;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      entries.push(list.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(list.slice(start));
  return entries;
}

/** Where the parenthesis opened at `open` closes, or the text's end. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
    } else if (c === '\\') i = escapeEnd(text, i) - 1;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** `:host`, `:host()` or `:host-context()` as a compound reads: the
 *  function's argument, null for `:host`, and whether the host's
 *  ancestors are asked too. */
interface HostCompound {
  arg: string | null;
  context: boolean;
}

/** `:host` or `:host-context` at the start of a string, and no longer
 *  name. */
const HOST_AT = /^:host(-context)?(?![\w-])/i;

/**
 * What a compound says of its tree's host (CSS Scoping 1, 3.2.1): undefined
 * where it names no `:host` outside its functions, null where it names one
 * it can match nothing as, and else the compound, which is `:host`,
 * `:host(<compound>)` or `:host-context(<compound>)` and nothing more. The
 * host is featureless in its own tree, so nothing else in a compound
 * matches it there: `:host.dark` and `div:host` match nothing.
 */
function hostCompound(text: string): HostCompound | null | undefined {
  let depth = 0;
  let quote = '';
  let at = -1;
  for (let i = 0; i < text.length && at < 0; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
    } else if (c === '\\') i = escapeEnd(text, i) - 1;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0 && HOST_AT.test(text.slice(i))) at = i;
  }
  if (at < 0) return undefined;
  if (at > 0) return null;
  const m = HOST_AT.exec(text)!;
  let i = m[0].length;
  let arg: string | null = null;
  if (text[i] === '(') {
    const close = closeOf(text, i);
    if (close >= text.length) return null;
    arg = text.slice(i + 1, close).trim();
    i = close + 1;
    if (!arg || compoundsOf(arg).length !== 1) return null;
  }
  const context = m[1] !== undefined;
  if (i !== text.length || (context && arg === null)) return null;
  return { arg, context };
}

/** A selector written in a shadow tree, as it reads of the host
 *  (`readHost`). */
type HostReading =
  | { kind: 'none' }
  | { kind: 'never' }
  | { kind: 'subject'; host: HostCompound }
  | { kind: 'anchored'; host: HostCompound; rest: string };

/**
 * A selector written in a shadow tree, read for its host (CSS Scoping 1,
 * 3.1.1). In its own tree the host stands where the shadow root does, above
 * the tree's top, so a `:host` compound is the selector's subject — a rule
 * for the host, from inside — or its first compound, before a descendant
 * or a child combinator; then the rest is matched inside the tree, with the
 * child at its top (`:-rx-top`). Anywhere else it matches nothing: the host
 * has no ancestor and no sibling in its tree.
 */
function readHost(selector: string): HostReading {
  const compounds = compoundsOf(selector);
  let host: HostCompound | undefined;
  for (let i = 0; i < compounds.length; i += 1) {
    const found = hostCompound(compounds[i].text);
    if (found === undefined) continue;
    if (found === null || i > 0) return { kind: 'never' };
    host = found;
  }
  if (!host) return { kind: 'none' };
  if (compounds.length === 1) return { kind: 'subject', host };
  const next = compounds[0].next;
  if (next !== ' ' && next !== '>') return { kind: 'never' };
  let rest = '';
  for (let i = 1; i < compounds.length; i += 1) {
    const { text, next: after } = compounds[i];
    rest += i === 1 && next === '>' ? `${text}:-rx-top` : text;
    if (after) rest += after === ' ' ? ' ' : ` ${after} `;
  }
  return { kind: 'anchored', host, rest };
}

/** Where `::name(` opens outside every function, bracket and string in a
 *  selector, and where its argument closes; null where it does not. */
function pseudoFunction(
  selector: string,
  name: RegExp,
): { at: number; close: number } | null {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (quote) {
      if (c === quote && selector[i - 1] !== '\\') quote = '';
    } else if (c === '\\') i = escapeEnd(selector, i) - 1;
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0) {
      const m = name.exec(selector.slice(i));
      if (m) return { at: i, close: closeOf(selector, i + m[0].length - 1) };
    }
  }
  return null;
}

/** The compound a pseudo-element hangs off, from what is written before
 *  it: `*` where nothing is, or where a combinator ends it. */
function originOf(head: string): string {
  const trimmed = head.trimEnd();
  return !trimmed
    ? '*'
    : head !== trimmed || /[>+~]$/.test(trimmed)
      ? `${trimmed} *`
      : trimmed;
}

/**
 * `::slotted(<compound>)` (CSS Scoping 1, 3.2.2): the slot it hangs off,
 * as a selector, and what the assigned element has to be. Undefined where
 * the selector has none; null where it is not one that can match.
 */
function readSlotted(
  selector: string,
): { slot: string; arg: string } | null | undefined {
  const found = pseudoFunction(selector, SLOTTED_AT);
  if (!found) return undefined;
  if (found.close !== selector.length - 1) return null;
  const arg = selector
    .slice(found.at + '::slotted('.length, found.close)
    .trim();
  if (!arg || compoundsOf(arg).length !== 1) return null;
  return { slot: originOf(selector.slice(0, found.at)), arg };
}
const SLOTTED_AT = /^::slotted\(/i;

/**
 * `::part(<ident>+)` (CSS Shadow Parts 1, 4.1): the host it hangs off, as
 * a selector, the names, and the pseudo-classes after it, of the part's
 * state — `:hover`, `:checked`. Undefined where the selector has none;
 * null where it is not one that can match.
 */
function readPart(
  selector: string,
): { host: string; names: string[]; after: string | null } | null | undefined {
  const found = pseudoFunction(selector, PART_AT);
  if (!found) return undefined;
  const names = selector
    .slice(found.at + '::part('.length, found.close)
    .trim()
    .split(/\s+/);
  if (!names[0] || names.some((n) => !PART_NAME.test(n))) return null;
  const after = selector.slice(found.close + 1);
  if (after && (after[0] !== ':' || after.includes('::'))) return null;
  if (after && compoundsOf(after).length !== 1) return null;
  return {
    host: originOf(selector.slice(0, found.at)),
    names,
    after: after || null,
  };
}
const PART_AT = /^::part\(/i;
const PART_NAME = /^-?[_a-zA-Z\u0080-\uffff][-\w\u0080-\uffff]*$/;

/** Whether a slot of a shadow tree has anything assigned to it, after
 *  flattening: a slot assigned to it counts by what it has, assigned or
 *  its fallback (DOM 4.2.2.3, "find flattened slottables"). */
function hasSlotted(slot: Element, nested = false): boolean {
  const root = shadowRootAround(slot);
  // a `<slot>` outside a shadow tree is no slot, and assigned as it is
  if (!root) return nested;
  const assigned = root.assignedTo(slot);
  const nodes = assigned.length || !nested ? assigned : slot.children;
  for (const node of nodes) {
    if (!isElement(node) || node.name !== 'slot') {
      if (isElement(node) || node.type === 'text') return true;
    } else if (hasSlotted(node, true)) return true;
  }
  return false;
}

/** The parent of an element in the shadow-including tree: the host for the
 *  top of a shadow tree. */
function shadowIncludingParent(el: Element): Element | null {
  const parent = el.parent;
  if (parent instanceof ShadowRoot) return parent.host;
  return isElement(parent) ? parent : null;
}

/** A space-separated list's tokens: a `part` attribute's names. */
function tokensOf(value: string): string[] {
  return value.split(/[ \t\n\f\r]+/).filter((name) => name.length > 0);
}

/**
 * The names `names`, parts of the tree a host hosts, go by in the tree the
 * host is in, through its `exportparts` (CSS Shadow Parts 1, 3.2): each
 * entry an `inner` it exports as it is, or an `inner: outer` it exports
 * as `outer`. A name no entry names is not seen there.
 */
function exportedNames(
  names: readonly string[],
  exportparts: string,
): string[] {
  const out: string[] = [];
  for (const entry of exportparts.split(',')) {
    const [inner, outer, extra] = entry.split(':').map((part) => part.trim());
    if (!inner || extra !== undefined) continue;
    if (outer !== undefined && !outer) continue;
    if (names.includes(inner)) out.push(outer ?? inner);
  }
  return out;
}

/** `pointerCompounds` for one complex selector, into `out`. */
function scanComplex(
  selector: string,
  out: PointerCompounds,
  kind: StateKind,
): void {
  for (const { text, next } of compoundsOf(selector)) {
    const compoundsFrom = out.compounds.length;
    const hasFrom = out.has.length;
    const found = scanCompound(text, out, kind);
    const sibling = next === '+' || next === '~';
    if (found.args.length) {
      out.has.push({
        anchor: found.bare.trim() || '*',
        siblings: found.args.some((arg) =>
          selectorsOf(arg).some((one) => /^\s*[+~]/.test(one)),
        ),
      });
    }
    if (found.pointer) out.compounds.push(found.bare.trim() || '*');
    // what follows the element this compound matches follows one whose
    // hover, or whose answer to a `:has()`, changed
    // — the one this compound matches, or one a selector nested in it
    // named, which is more than it reaches and never less
    if (sibling && (found.pointer || found.below || found.args.length)) {
      out.siblings = true;
      for (let i = compoundsFrom; i < out.compounds.length; i += 1) {
        out.followed.push(out.compounds[i]);
      }
      for (let i = hasFrom; i < out.has.length; i += 1) {
        out.followed.push(out.has[i].anchor);
      }
    }
  }
}

/**
 * What one compound says of the pointer: the compound without what tests
 * it (`bare`), whether it tests the element's own hover (`pointer`), the
 * arguments of each `:has()` of the element's that tests it below (`args`),
 * and whether a selector nested in it named another element's (`below`),
 * whose compounds went into `out`. Of the focus, likewise, for
 * `FOCUS_STATE`.
 */
function scanCompound(
  text: string,
  out: PointerCompounds,
  kind: StateKind,
): { bare: string; pointer: boolean; below: boolean; args: string[] } {
  let bare = '';
  let pointer = false;
  let below = false;
  const args: string[] = [];
  let bracket = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
      bare += c;
      continue;
    }
    if (c === '\\') {
      const end = escapeEnd(text, i);
      bare += text.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === ':' && bracket === 0 && text[i + 1] !== ':') {
      const m = STATE_PSEUDO_AT.exec(text.slice(i));
      if (m) {
        if (kind.own.test(m[0])) pointer = true;
        i += m[0].length - 1;
        continue;
      }
      const fn = FUNCTION_AT.exec(text.slice(i));
      if (fn) {
        const open = i + fn[0].length - 1;
        const close = closeOf(text, open);
        const arg = text.slice(open + 1, close);
        const whole = text.slice(i, close + 1);
        i = close;
        if (!kind.any.test(arg)) {
          bare += whole;
          continue;
        }
        const name = fn[1].toLowerCase();
        if (name === 'has') {
          // the compound is kept without it: its argument is what the
          // pointer changes, and whatever holds the `:hover` in there, the
          // element it tests is in the anchor's subtree or a later
          // sibling's
          args.push(arg);
        } else if (MATCHES_ANY.test(name)) {
          // Kept as what the entries that test this element's hover ask
          // of it besides — `:where(a:hover)` is a compound of `a`'s, and
          // so is `:not(a:hover)`, which only an `a` can change its answer
          // to. Tailwind's typography writes its links `.prose
          // :where(a:hover):not(:where(.not-prose, .not-prose *))`, and
          // without the `a` that was a compound every element matched.
          const own: string[] = [];
          let any = false;
          for (const entry of selectorsOf(arg)) {
            if (!kind.any.test(entry)) continue;
            const parts = compoundsOf(entry);
            if (parts.length !== 1) {
              scanComplex(entry, out, kind);
              below = true;
              continue;
            }
            // of this element itself
            const one = scanCompound(parts[0].text, out, kind);
            if (one.below) below = true;
            if (!one.pointer && !one.args.length) continue;
            if (one.pointer) pointer = true;
            args.push(...one.args);
            const rest = one.bare.trim();
            if (rest && rest !== '*') own.push(rest);
            else any = true;
          }
          if (own.length && !any) bare += `:is(${own.join(',')})`;
        } else {
          out.nested = true;
          bare += whole;
        }
        continue;
      }
    }
    bare += c;
  }
  return { bare, pointer, below, args };
}

/** A functional pseudo-class's name and its opening parenthesis, at the
 *  start of a string. */
const FUNCTION_AT = /^:([\w-]+)\(/;

/** `:hover` anywhere in a selector. */
const HOVER = HOVER_STATE.any;

/** `:focus`, `:focus-visible` or `:focus-within` anywhere in a selector. */
const FOCUS = FOCUS_STATE.any;

/** A pseudo-class of a state this renderer keeps — `:hover`, `:active`,
 *  `:focus` and its two kin — at the start of a string, and nothing
 *  longer. */
const STATE_PSEUDO_AT =
  /^:(?:hover|active|focus(?:-visible|-within)?)(?![\w-])/i;

/** Any of them anywhere in a selector. */
const STATE_PSEUDO = /:(?:hover|active|focus(?:-visible|-within)?)(?![\w-])/i;

/**
 * A selector compiled to a matcher over this adapter. css-select keeps the
 * answers of a `:has()` above the subject, or of the ancestors a
 * descendant combinator tried under one, for as long as the matcher lives
 * (`cacheResults`) — which is the cascade's life, and a pointer move is no
 * new cascade. So a selector that tests the pointer or the focus keeps
 * none: with them, `#box:has(a:hover) .m` answered what it did before the
 * first move, for good.
 */
function compileSelector(
  selector: string,
  adapter: CssSelectAdapter,
  pseudos: typeof PSEUDOS = PSEUDOS,
  /** Whether what it answers may be kept: not where the adapter's tree
   *  moves under it, as a `<use>`'s copy's does (`Cascade.shapeStyles`). */
  cache = true,
): (el: Element) => boolean {
  return compile(noEmptyWords(selector), {
    adapter,
    xmlMode: false,
    pseudos,
    cacheResults: cache && !STATE_PSEUDO.test(selector),
  } as unknown as Parameters<typeof compile>[1]) as unknown as (
    node: Element,
  ) => boolean;
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
  return compoundKey(selector.slice(start));
}

/**
 * Whether a selector is nothing but the class or the id it is filed under
 * (`rightmostKey`): `.p-4`, `#nav`, as a utility framework writes all its
 * rules. An element its bucket is asked for has that class or that id,
 * which is all such a rule asks. A type is left to the matcher, which
 * reads an element's name its own way (`getName`).
 */
function keyOnly(
  selector: string,
  key: { kind: 'id' | 'class' | 'tag' | 'any'; name: string },
): boolean {
  if (key.kind !== 'class' && key.kind !== 'id') return false;
  const text = selector.trim();
  if (text[0] !== (key.kind === 'class' ? '.' : '#')) return false;
  const name = readIdent(text, 1);
  return name.end === text.length && name.value === key.name;
}

/** A compound selector's most selective key (`rightmostKey`). */
function compoundKey(compound: string): {
  kind: 'id' | 'class' | 'tag' | 'any';
  name: string;
} {
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

/**
 * The ids and classes a selector asks of its subject's ancestors: for each
 * compound a descendant or a child combinator follows, its id, or else its
 * first class, as `#name` or `.name`. Such a compound is an ancestor of
 * the subject — one a sibling combinator follows is a sibling of one — so
 * an element with no ancestor of some such name is not the rule's, which
 * is known without matching it. A compound with neither asks nothing.
 */
function ancestorKeys(selector: string): string[] {
  const keys: string[] = [];
  const compounds = compoundsOf(selector);
  for (let i = 0; i < compounds.length - 1; i += 1) {
    const { text, next } = compounds[i];
    if (next !== ' ' && next !== '>') continue;
    const key = compoundKey(text);
    if (key.kind === 'id') keys.push(`#${key.name}`);
    else if (key.kind === 'class') keys.push(`.${key.name}`);
  }
  return keys;
}

/** No names: what is above the root. */
const NO_NAMES: ReadonlySet<string> = new Set();

/** The element a selector's ancestor is matched against: the parent, where
 *  that is an element — not the document, nor a shadow tree's root, as the
 *  matcher's own climb stops there. */
function elementParent(el: Element): Element | null {
  const parent = el.parent;
  return parent && isTag(parent as Element) ? (parent as Element) : null;
}

/** A drawing none of whose own elements a rule reaches. */
const NO_SHAPES: ReadonlyMap<Element, ShapeStyle> = new Map();

/** What the rules matched in the copy a `<use>` makes of an element: each
 *  element they reach, with its place in the copy and its rules in cascade
 *  order; how many elements the copy has; and the `<use>`s in it. */
interface CopyMatch {
  rules: { el: Element; at: number; candidates: Candidate[] }[];
  size: number;
  uses: Element[];
}

/**
 * What `Cascade.shapeStyles` keeps for the drawings of one build of the
 * boxes (`BoxTree.shapeCopies`): the document's elements by their ids, and
 * what the rules matched in the copy of each element a `<use>` names —
 * the same whichever `<use>` makes it, so a page of hundreds of icons from
 * one sprite matches each symbol once — and what that comes to for a
 * drawing of each style. A build is made again whenever the document, its
 * style sheets or a viewport a value reads change, and a pointer move
 * changes nothing a copy is matched by: nothing in one is under the
 * pointer, and a drawing whose style it changes has another style.
 */
export class ShapeCopies {
  /** @internal */
  readonly matched = new Map<Element, CopyMatch>();
  /** @internal What each copy comes to for a drawing of a style, and the
   *  key that names it. */
  readonly resolved = new WeakMap<
    ComputedStyle,
    Map<Element, { into: Map<Element, ShapeStyle> | null; key: string }>
  >();
  constructor(readonly byId: (id: string) => Element | null) {}
}

/** What the rules asked of every element of a drawing, or of every one of
 *  a type, ask of its ancestors (`Cascade.shapeStyles`). */
interface ShapeNeeds {
  /** The classes and the ids some such rule names in an ancestor. */
  classes: Set<string>;
  ids: Set<string>;
  /** Whether a rule asked of every element asks nothing of its ancestors,
   *  and the types with such a rule. */
  universal: boolean;
  tags: Set<string>;
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

/** Where the focus is, for `:focus` and its kin: the element whose widget
 *  holds it, whether that shows (`:focus-visible`), and the element with
 *  every element around it (`:focus-within`). No element of a document
 *  takes the focus itself; a control's widget, mounted beside it, does. */
export interface FocusState {
  element: Element | null;
  visible: boolean;
  within: ReadonlySet<Element>;
}

export const NO_FOCUS: FocusState = {
  element: null,
  visible: false,
  within: new Set(),
};

/**
 * What the selectors that test one state — the pointer, or the focus — say
 * of the elements a change of it can restyle: the compounds that test it,
 * each without it and with whether a sibling combinator follows it, and
 * the anchors of the `:has()`s that test it (`pointerCompounds`).
 */
class StateRules {
  /** The compounds, each without the state, and their matchers, compiled
   *  when a change first asks (`touches`). */
  private _compounds = new Map<string, boolean>();
  private _matchers:
    { match: (el: Element) => boolean; followed: boolean }[] | null = null;
  /** Whether a change can be restyled where it happened
   *  (`HtmlViewNode._hoverInPlace`): false where a selector tests the
   *  state inside a functional pseudo-class, which reaches elements no
   *  compound names. */
  local = true;
  /** The compounds whose `:has()` tests the state, each without it,
   *  whether its argument starts at a sibling, and whether a sibling
   *  combinator follows it (`anchors`). */
  private _anchors = new Map<
    string,
    { siblings: boolean; followed: boolean }
  >();
  private _anchorMatchers:
    | {
        match: (el: Element) => boolean;
        siblings: boolean;
        followed: boolean;
      }[]
    | null = null;

  constructor(private readonly _kind: StateKind) {}

  note(selector: string): void {
    if (!this._kind.mentions.test(selector)) return;
    const found = pointerCompounds(selector, this._kind);
    if (found.nested) this.local = false;
    const followed = new Set(found.followed);
    for (const c of found.compounds) {
      this._compounds.set(
        c,
        followed.has(c) || (this._compounds.get(c) ?? false),
      );
    }
    for (const { anchor, siblings } of found.has) {
      const was = this._anchors.get(anchor);
      this._anchors.set(anchor, {
        siblings: siblings || (was?.siblings ?? false),
        followed: followed.has(anchor) || (was?.followed ?? false),
      });
    }
  }

  /** `Cascade.hoverTouches`, for this state. */
  touches(
    el: Element,
    compile: (selector: string) => ((el: Element) => boolean) | null,
  ): HoverTouch {
    // the followed ones first, so the first that matches is the answer
    this._matchers ??= [...this._compounds]
      .sort(([, a], [, b]) => Number(b) - Number(a))
      .flatMap(([compound, followed]) => {
        const match = compile(compound);
        return match ? [{ match, followed }] : [];
      });
    for (const { match, followed } of this._matchers) {
      if (match(el)) return followed ? HOVER_FOLLOWED : HOVER_TOUCHED;
    }
    return HOVER_UNTOUCHED;
  }

  /** `Cascade.hoverAnchors`, for this state. */
  anchors(
    el: Element,
    into: Map<Element, HoverTouch>,
    compile: (selector: string) => ((el: Element) => boolean) | null,
  ): void {
    if (!this._anchors.size) return;
    this._anchorMatchers ??= [...this._anchors]
      .sort(([, a], [, b]) => Number(b.followed) - Number(a.followed))
      .flatMap(([anchor, { siblings, followed }]) => {
        const match = compile(anchor);
        return match ? [{ match, siblings, followed }] : [];
      });
    const note = (at: Element, followed: boolean): void => {
      if (followed) into.set(at, HOVER_FOLLOWED);
      else if (!into.has(at)) into.set(at, HOVER_TOUCHED);
    };
    const siblings = this._anchorMatchers.some((m) => m.siblings);
    for (let at: Element | null = el; at;) {
      if (at !== el) {
        for (const { match, followed } of this._anchorMatchers) {
          if (match(at)) {
            note(at, followed);
            break;
          }
        }
      }
      if (siblings) {
        for (let s = at.prev; s; s = s.prev) {
          if (!isTag(s as Element)) continue;
          for (const m of this._anchorMatchers) {
            if (m.siblings && m.match(s as Element)) {
              note(s as Element, m.followed);
              break;
            }
          }
        }
      }
      const parent: Element['parent'] = at.parent;
      at = parent && isTag(parent as Element) ? (parent as Element) : null;
    }
  }
}

/**
 * The face a style's font-relative units are measured in: its family list,
 * size, weight, slant and width, the five that pick one. A family's faces
 * can be different fonts altogether — a page's `@font-face` rules may set
 * its bold in another file — so an `ex` in bold text is the bold face's,
 * and a `ch` in condensed text is the condensed face's "0".
 */
export interface MetricFace {
  family: string;
  size: number;
  weight: number;
  style: ComputedStyle['fontStyle'];
  stretch: number;
}

/** What a face measures, where the fonts can say. */
export type FaceMetric = (face: MetricFace) => number | null;

/** What a style's face is read from: a computed style, or the part of one
 *  a declaration's font-relative units are measured against. */
type FaceSource = Pick<
  ComputedStyle,
  'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle' | 'fontStretch'
>;

/** …and its line height, for `lh`. */
type LineSource = FaceSource &
  Pick<ComputedStyle, 'lineHeight' | 'lineHeightIsLength'>;

function faceOf(style: FaceSource): MetricFace {
  return {
    family: style.fontFamily,
    size: style.fontSize,
    weight: style.fontWeight,
    style: style.fontStyle,
    stretch: style.fontStretch,
  };
}

function faceKey(style: FaceSource): string {
  return `${style.fontFamily}\u0001${style.fontSize}\u0001${style.fontWeight}\u0001${style.fontStyle}\u0001${style.fontStretch}`;
}

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
    selection: new RuleIndex(),
  };
  /** The author's rules that could style a shape in a drawing: the ones
   *  that declare a property a shape has (`shapes.ts`) and whose subject
   *  is no element of HTML's alone. They are in `_index` too, for the
   *  elements that have boxes; these are asked of the ones in an inline
   *  `<svg>`, which have none (`shapeStyles`). */
  private _shapes = new RuleIndex();
  private _shapeNeeds: ShapeNeeds | null = null;
  private _adapter: CssSelectAdapter;
  /**
   * The tree a `<use>`'s copy is in, for `_copyAdapter`: the element it is
   * a copy of, which is its top (`ShapeStyles.used`). A copy is its own
   * tree, a shadow tree of the `<use>`'s (SVG 2, 5.5.1), so a selector is
   * matched against its original with nothing above that element and
   * nothing beside it — the top of a copy is its tree's first child and
   * its last, whichever of its parent's it is. And nothing in it is under
   * the pointer, as nothing in a drawing is: it has no box to be.
   */
  private _copyTop: Element | null = null;
  private _copyAdapter: CssSelectAdapter;
  /** What the selectors that test the pointer, and the ones that test the
   *  focus, say of the elements a change of it reaches. */
  private _hoverRules = new StateRules(HOVER_STATE);
  private _focusRules = new StateRules(FOCUS_STATE);
  private _pointer: PointerState = NO_POINTER;
  private _focus: FocusState = NO_FOCUS;
  readonly initial: ComputedStyle;
  readonly look: RootLook;
  /** Viewport width the media queries were evaluated at, in device pixels
   *  like every other length here. */
  viewportWidth: number;
  viewportHeight: number;
  /** Whether the desktop has asked for less motion, which
   *  `prefers-reduced-motion` is answered from: set before a restyle, as
   *  the viewport is, so a change of it restyles over the sheets as they
   *  were parsed. */
  reducedMotion = false;
  /** Device pixels per CSS pixel. Every computed length is device; a
   *  `@media` width is the one CSS-pixel comparison left, and it divides. */
  readonly scale: number;
  /** Every width at which some `@media` rule changes its mind, in CSS
   *  pixels — the unit the author wrote them in. */
  readonly breakpoints: number[];
  /** The counter styles the sheets define, over the predefined ones. */
  readonly counterStyles: CounterStyles;
  /** The document's rules: its elements', and the ones of its tree's
   *  edges (`TreeRules`) — its `::part()` rules — and its `@keyframes`,
   *  by name, in document order: which one a name finds turns on the
   *  media in force (`keyframes`). */
  private _document: TreeRules = newTreeRules(0);
  private _docInfo: TreeInfo = { root: null, depth: 0, rules: this._document };
  /** Each set of shadow trees' rules, by how their sheets read
   *  (`ShadowSheets.key`), and the trees bound to each (`bindShadows`). */
  private _byKey = new Map<string, TreeRules>();
  private _nextTree = 1;
  private _bound = new Map<ShadowRoot, TreeRules>();
  /** What is known of each shadow tree (`_rootInfo`), and of the tree each
   *  element is in, for a build (`_treeInfo`). */
  private _roots = new Map<ShadowRoot, TreeInfo>();
  private _trees = new WeakMap<Element, TreeInfo>();
  /** Whether there is a shadow tree to tell an element's from the
   *  document's: where there is none, nothing asks which tree an element
   *  is in, and a document styles as it did before there were any. */
  private _scoped = false;
  /** The ids of the rules of the trees' edges in a sharing key, below
   *  every index's. */
  private _scopedId = -1;
  /** The pseudo-elements a rule of a tree's edge is for. */
  private _scopedPseudos = new Set<PseudoTarget>();
  /** Whether any tree has a `@keyframes`. */
  private _anyKeyframes = false;
  /** The style an element has in the document as it is drawn, or a
   *  pseudo-element's (`pseudo`, '' for the element's own): what a
   *  transition starts from (`AnimationTimeline.transition`). Null where it
   *  has none, which starts none. */
  previous: ((el: Element, pseudo: string) => ComputedStyle | null) | null =
    null;

  /** The document's timeline, where its animations run, and the time on
   *  it the styles are computed at; null where none runs, and a document
   *  is drawn as it stands once each has run (`restingFrames`). */
  timeline: AnimationTimeline | null = null;

  /** A face's x-height, for `ex`, where the fonts can say. */
  private _xHeightOf: FaceMetric | null;
  private _xHeights = new Map<string, number>();
  /** The advance of a face's "0", for `ch`, likewise. */
  private _zeroWidthOf: FaceMetric | null;
  private _zeroWidths = new Map<string, number>();
  /** A face's own line height, for `lh` where `line-height` is `normal`,
   *  likewise. */
  private _normalLineOf: FaceMetric | null;
  private _normalLines = new Map<string, number>();
  /** Whether any declaration sets a custom property or reads one: without
   *  one, no element's style asks about them. */
  private _vars = false;
  /** Whether any declaration is in a unit of the viewport's width — `vw`,
   *  `vmin`, `vmax` — or of its height, `vh` and the same two: a style
   *  holds such a length as a number, so it is computed again when that
   *  side of the viewport moves (`HtmlViewNode._update`). */
  readsViewportWidth = false;
  readsViewportHeight = false;
  /** The families the document loads itself (`fonts.ts`), or null for a
   *  document with no `@font-face`. */
  private _families: FontFamilies | null;
  /** The root element's computed style: its `font-size` is what a `rem`
   *  is and its line height what an `rlh` is (CSS Values 4, 6.1.1), in
   *  every element but the root, whose own declarations measure them from
   *  the initial values. Set as the root's style is computed, which a build
   *  does ahead of every element under it. */
  private _root: ComputedStyle | null = null;
  private _mapFamilies: ((list: string) => string) | undefined;
  /** Whether any declaration has a length in `lh` or `rlh`: only then is
   *  the line height settled ahead of the declarations that read it. */
  private _lh = false;
  /** The pseudo-classes css-select is handed: `:root` this cascade's, and
   *  the focus's three answered from `_focus`. */
  private _pseudos: typeof PSEUDOS;
  /** The colour schemes the page says it supports with a `<meta
   *  name="color-scheme">` (HTML 4.2.5.4), which its root element takes
   *  as it takes a presentational attribute: under any rule that sets its
   *  `color-scheme`. Set by the box builder from the document. */
  pageColorScheme: string | null = null;
  /** The element whose `width` and `height` size an `<img>`: its
   *  dimension attribute source (HTML 15.4.3), which is the `<source>` its
   *  `<picture>` chose where that has either (`ImageSources`), and the
   *  `<img>` where none says otherwise. */
  dimensionSource: ((img: Element) => Element) | null = null;
  /** Each system colour as the `light-dark()` it is: the palette's where
   *  the element's scheme is the palette's, and Chrome's in an SVG image,
   *  which has none. */
  private _systemColors: Map<string, string>;
  /** The host's code face as a computed list (`UnitContext.codeFamily`). */
  private _codeFamily: string | null;

  constructor(
    sheets: Stylesheet[],
    look: RootLook,
    viewportWidth: number,
    viewportHeight: number,
    scale = 1,
    xHeight: FaceMetric | null = null,
    zeroWidth: FaceMetric | null = null,
    normalLine: FaceMetric | null = null,
    families: FontFamilies | null = null,
    /** The document's element where it is not an `<html>`: an SVG image's
     *  `<svg>`, which is `:root` there (Selectors 4, 14.1). */
    documentElement: Element | null = null,
    /** The element the document's URL names by its fragment, which is
     *  `:target` (Selectors 4, 9.1): an SVG image's, `image.svg#icon`. */
    target: Element | null = null,
    /** The shadow trees' sheets, a set for each way they read: what each
     *  styles is in the trees bound to it (`bindShadows`). */
    shadows: readonly ShadowSheets[] = [],
  ) {
    // css-select has none of the focus's three, and a pseudo-class is
    // handed only the element, so they are this cascade's own closures
    this._pseudos = {
      ...PSEUDOS,
      ...(documentElement && {
        root: (el: Element) => el === documentElement,
      }),
      ...(target && { target: (el: Element) => el === target }),
      focus: (el: Element) => this._focus.element === el,
      'focus-visible': (el: Element) =>
        this._focus.visible && this._focus.element === el,
      'focus-within': (el: Element) => this._focus.within.has(el),
    };
    this._xHeightOf = xHeight;
    this._zeroWidthOf = zeroWidth;
    this._normalLineOf = normalLine;
    this._families = families;
    this._mapFamilies = families
      ? (list: string) => families.map(list)
      : undefined;
    this.look = look;
    this._codeFamily = familyList(look.monoFamily);
    this._systemColors = systemColorTable(documentElement ? null : look);
    this.initial = initialStyle(look, scale);
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.scale = scale;
    // Before the sheets, whose rules at a shadow tree's edges are compiled
    // as they are read (`_addScoped`).
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
    this._copyAdapter = {
      ...this._adapter,
      getParent: (el) => (el === this._copyTop ? null : DomUtils.getParent(el)),
      getSiblings: (el) =>
        el === this._copyTop ? [el] : DomUtils.getSiblings(el),
      prevElementSibling: (el) =>
        el === this._copyTop ? null : DomUtils.prevElementSibling(el),
      isHovered: () => false,
      isActive: () => false,
    };
    const breakpoints = new Set<number>();
    const counterStyles = new Map<string, CounterStyleRule>();
    for (const sheet of sheets) {
      // a counter style's rule whole over any before it of its name
      for (const { prelude, declarations } of sheet.counterStyles ?? []) {
        const style = counterStyleRule(prelude, declarations);
        if (style) counterStyles.set(style.name, style.rule);
      }
      this._addSheet(sheet, this._document, breakpoints);
    }
    // A shadow tree's sheets go in the same indexes, each rule filed
    // under its tree (`IndexedRule.scope`) and asked of that tree's
    // elements alone (`_matchInto`): one look in a bucket for every
    // element, whichever tree it is in, and the trees whose sheets read
    // the same — a component's, stamped out on every card — share one set
    // of rules, parsed and indexed once. Its `@counter-style` and
    // `@font-face` rules are not read: the document's are what count.
    for (const { key, sheets: own } of shadows) {
      const rules = this._treeRules(key);
      for (const sheet of own) this._addSheet(sheet, rules, breakpoints);
    }
    this._scoped = shadows.length > 0;
    this.breakpoints = [...breakpoints].sort((a, b) => a - b);
    this.counterStyles = new CounterStyles(counterStyles);
  }

  /**
   * A sheet's rules into the indexes, filed under the tree they are for —
   * the user agent's for every tree — and its `@keyframes` into that
   * tree's. The rules written from inside a shadow tree about what is
   * outside it — `:host`, `::slotted()` — and from outside it about what is
   * inside — `::part()` — are the tree's own (`_addScoped`).
   */
  private _addSheet(
    sheet: Stylesheet,
    rules: TreeRules,
    breakpoints: Set<number>,
  ): void {
    for (const rule of sheet.rules) {
      if (!this._vars && usesVars(rule.declarations)) this._vars = true;
      this._noteViewportUnits(rule.declarations);
      if (!this._lh && usesLh(rule.declarations)) this._lh = true;
      const scope = rule.order < 0 ? UA_SCOPE : rules.id;
      if (SCOPING.test(rule.selector) && this._addScoped(rule, rules)) {
        continue;
      }
      const pseudo = splitPseudoElement(rule);
      if (pseudo) this._pseudo[pseudo.which].add(pseudo.rule, undefined, scope);
      else {
        const key = rightmostKey(rule.selector);
        this._index.add(rule, key, scope);
        if (
          rule.order >= 0 &&
          (key.kind !== 'tag' || SHAPE_TAGS.has(key.name)) &&
          declaresShape(rule.declarations)
        ) {
          this._shapes.add(rule, key, scope);
        }
      }
      const selector = (pseudo?.rule ?? rule).selector;
      this._hoverRules.note(selector);
      this._focusRules.note(selector);
    }
    for (const rule of sheet.keyframes ?? []) {
      let named = rules.keyframes.get(rule.name);
      if (!named) rules.keyframes.set(rule.name, (named = []));
      named.push(rule);
      this._anyKeyframes = true;
      for (const frame of rule.frames) {
        const declarations = frame.declarations;
        if (!this._vars && usesVars(declarations)) this._vars = true;
        this._noteViewportUnits(declarations);
        if (!this._lh && usesLh(declarations)) this._lh = true;
      }
    }
    for (const bp of sheet.breakpoints) breakpoints.add(bp);
    // a query on the viewport's height reads it as a `vh` does
    if (sheet.readsHeight) this.readsViewportHeight = true;
    if (sheet.readsWidth) this.readsViewportWidth = true;
  }

  /** Whether declarations read the viewport's width or height (`vw`,
   *  `vh`, `vmin`, `vmax`), noted on the cascade. */
  private _noteViewportUnits(declarations: readonly Declaration[]): void {
    if (this.readsViewportWidth && this.readsViewportHeight) return;
    for (const d of declarations) {
      if (!VIEWPORT_UNIT.test(d.value)) continue;
      for (const m of d.value.matchAll(VIEWPORT_UNITS)) {
        const unit = viewportUnit(m[1]);
        if (unit !== 'vh') this.readsViewportWidth = true;
        if (unit !== 'vw') this.readsViewportHeight = true;
      }
    }
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

  /** Whether a widget taking the focus or giving it up can change what this
   *  cascade produces. */
  get focusSensitive(): boolean {
    return (
      this._index.focusSensitive ||
      this._pseudo.before.focusSensitive ||
      this._pseudo.after.focusSensitive ||
      this._pseudo['first-letter'].focusSensitive ||
      this._pseudo['first-line'].focusSensitive ||
      this._pseudo.marker.focusSensitive
    );
  }

  setFocus(focus: FocusState): void {
    this._focus = focus;
  }

  /** Whether a pointer move can be restyled where it happened
   *  (`HtmlViewNode._hoverInPlace`): false where a selector tests the
   *  pointer inside a functional pseudo-class, which reaches elements no
   *  compound names. */
  get hoverLocal(): boolean {
    return this._hoverRules.local;
  }

  /** …and a focus change. */
  get focusLocal(): boolean {
    return this._focusRules.local;
  }

  /**
   * Which pseudo-elements' rules test the pointer: none's
   * (`HOVER_PSEUDO_NONE`); a `::before`'s or an `::after`'s only
   * (`HOVER_PSEUDO_GENERATED`), whose boxes a move restyles where they are
   * as it does an element's; or a `::first-line`'s, a `::first-letter`'s
   * or a `::marker`'s (`HOVER_PSEUDO_OTHER`), which layout styles and a
   * move cannot.
   */
  get hoverPseudo(): 0 | 1 | 2 {
    return this._pseudoRules('hoverSensitive');
  }

  /** …and which test the focus. */
  get focusPseudo(): 0 | 1 | 2 {
    return this._pseudoRules('focusSensitive');
  }

  private _pseudoRules(state: 'hoverSensitive' | 'focusSensitive'): 0 | 1 | 2 {
    if (
      this._pseudo['first-letter'][state] ||
      this._pseudo['first-line'][state] ||
      this._pseudo.marker[state]
    ) {
      return HOVER_PSEUDO_OTHER;
    }
    return this._pseudo.before[state] || this._pseudo.after[state]
      ? HOVER_PSEUDO_GENERATED
      : HOVER_PSEUDO_NONE;
  }

  /**
   * Whether the pointer entering or leaving `el` can change a style: one of
   * the compounds a selector tests the pointer in matches it, the pointer
   * aside. A move between two paragraphs of a page whose only such rule is
   * `a:hover` touches nothing, and restyles nothing. `HOVER_FOLLOWED`
   * where a sibling combinator follows one that matches, so the element's
   * later siblings can change with it — those rules' elements alone: a
   * sheet with one `.peer:hover ~ *` in it does not make every row of a
   * table restyle the rows after it.
   */
  hoverTouches(el: Element): HoverTouch {
    return this._hoverRules.touches(el, (selector) => this._compile(selector));
  }

  /** `hoverTouches` for the focus: whether `el` taking the focus or giving
   *  it up, or its `:focus-within` changing, can change a style. */
  focusTouches(el: Element): HoverTouch {
    return this._focusRules.touches(el, (selector) => this._compile(selector));
  }

  /**
   * The elements whose `:has()` may have changed its answer as `el` was
   * hovered or left: the ancestors of it a compound whose `:has()` tests
   * the pointer names, and their earlier siblings and its own where the
   * argument starts at a sibling — a superset, which is restyled and found
   * the same where it did not. Into `into`, each with whether its later
   * siblings can change with it (`hoverTouches`).
   */
  hoverAnchors(el: Element, into: Map<Element, HoverTouch>): void {
    this._hoverRules.anchors(el, into, (selector) => this._compile(selector));
  }

  /** `hoverAnchors` for the focus: `form:has(input:focus)`'s form. */
  focusAnchors(el: Element, into: Map<Element, HoverTouch>): void {
    this._focusRules.anchors(el, into, (selector) => this._compile(selector));
  }

  /** A selector compiled as a rule's is, or null where css-select refuses
   *  it, as a rule it refuses drops out of the cascade. */
  private _compile(selector: string): ((el: Element) => boolean) | null {
    try {
      return compileSelector(selector, this._adapter, this._pseudos);
    } catch {
      return null;
    }
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
   * The `@keyframes` an animation's name finds, or null. A name is
   * tree-scoped (CSS Scoping 1, 3.5): it is looked for in the tree whose
   * rule named it — `tree`, null for the document's (`animationTree`) —
   * and then in each tree around that one out to the document's, so a
   * shadow tree's `@keyframes` is its own, and a `::part()` rule of the
   * page's names the page's whatever the part's tree has.
   */
  keyframes(
    name: string,
    tree: ShadowRoot | null = null,
  ): KeyframesRule | null {
    for (let root = tree; root; root = shadowRootAround(root.host)) {
      const found = this._keyframesIn(this._rootInfo(root).rules, name);
      if (found) return found;
    }
    return this._keyframesIn(this._document, name);
  }

  /**
   * The `@keyframes` of a name one tree has, or null: of its rules of the
   * name whose media hold, the one in the latest layer — no layer
   * outranking any, as for a style rule — and the last of those, but that
   * an `@-webkit-keyframes` never takes the place of an `@keyframes`, as in
   * Blink (`ScopedStyleResolver::AddKeyframeStyle`).
   */
  private _keyframesIn(rules: TreeRules, name: string): KeyframesRule | null {
    const named = rules.keyframes.get(name);
    if (!named) return null;
    const width = this.viewportWidth / this.scale;
    const height = this.viewportHeight / this.scale;
    let found: KeyframesRule | null = null;
    for (const rule of named) {
      if (
        !mediaMatches(
          rule.media,
          width,
          this.look.colorScheme,
          height,
          this.scale,
          this.reducedMotion,
        )
      ) {
        continue;
      }
      if (found) {
        const by = compareLayers(rule.layer, found.layer);
        if (by < 0 || (by === 0 && rule.prefixed && !found.prefixed)) {
          continue;
        }
      }
      found = rule;
    }
    return found;
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

  /** The styles kept from the build before, while a build that keeps them
   *  runs, and what each kept element shares under in this one. */
  private _kept: KeptStyles | null = null;
  private _keptShared = new Map<Element, SharedStyle>();

  /**
   * A box tree is about to be built: the styles shared in the last build
   * were computed against a pointer and a viewport that may have moved.
   *
   * With `kept`, only its `restyle` elements are matched: a build the
   * pointer asked for — a hover that moved something — changes the styles
   * of the elements the move reached, and every other element's is what it
   * was. Matching them all again was most of such a build: a frame of 550 ms
   * on a page with a Tailwind sheet, and 150 without it.
   */
  beginSharing(kept: KeptStyles | null = null): void {
    this._namesKept.clear();
    this._keepNames = true;
    this._shared.clear();
    this._sharedByMatch.clear();
    // the kept styles' custom properties are the sets in here, which the
    // elements styled under them find again
    if (!kept) this._customs.clear();
    this._kept = kept;
    this._keptShared.clear();
  }

  /** The build is over: nothing later is answered from what it kept. */
  endSharing(): void {
    this._kept = null;
    this._keptShared.clear();
    this._namesKept.clear();
    this._keepNames = false;
  }

  /**
   * The ids and the classes some rule asks of an ancestor (`_needsOf`),
   * as the rules are first asked of: what is known of the names above an
   * element is kept to these, so a page of utility classes keeps the few
   * its variants name — `.dark`, `.group` — and most of its elements none.
   * `_askedGen` counts the names noted, since what was worked out before
   * one was noted is short of it.
   */
  private _askedIds = new Set<string>();
  private _askedClasses = new Set<string>();
  private _askedGen = 0;

  /**
   * The asked names of an element and of every element above it, as the
   * matcher climbs to them — an element's parents, up to the root of the
   * tree it is in — kept for a build (`beginSharing`), whose elements are
   * styled from the top down and ask for their parents' in turn: one set
   * for an element and every element under it that adds no name. Outside
   * a build — a hover's restyle in place — they are worked out once for
   * each element matched and not kept, since nothing then says the
   * document has not changed under them.
   */
  private _namesKept = new Map<Element, ReadonlySet<string>>();
  private _keepNames = false;

  /** The names a rule asks of its subject's ancestors (`IndexedRule.needs`),
   *  worked out once, with each a rule had not asked before noted. */
  private _needsOf(indexed: IndexedRule): readonly string[] {
    if (indexed.needs) return indexed.needs;
    const needs = (indexed.needs = ancestorKeys(indexed.rule.selector));
    for (const name of needs) {
      const asked = name[0] === '#' ? this._askedIds : this._askedClasses;
      if (asked.has(name.slice(1))) continue;
      asked.add(name.slice(1));
      this._askedGen += 1;
      this._namesKept.clear();
    }
    return needs;
  }

  /** The names of `el`'s own that a rule asks of an ancestor, or null. */
  private _ownAsked(el: Element): string[] | null {
    let own: string[] | null = null;
    if (this._askedIds.size) {
      const id = attr(el, 'id');
      if (id && this._askedIds.has(id)) own = [`#${id}`];
    }
    if (this._askedClasses.size) {
      const className = attr(el, 'class');
      if (className) {
        for (const name of className.split(/\s+/)) {
          if (name && this._askedClasses.has(name)) {
            (own ??= []).push(`.${name}`);
          }
        }
      }
    }
    return own;
  }

  /** The asked names of `el` and of everything above it (`_namesKept`). */
  private _namesAbove(el: Element): ReadonlySet<string> {
    if (!this._keepNames) {
      let names: Set<string> | null = null;
      for (let at: Element | null = el; at; at = elementParent(at)) {
        const own = this._ownAsked(at);
        if (own) for (const name of own) (names ??= new Set()).add(name);
      }
      return names ?? NO_NAMES;
    }
    const kept = this._namesKept.get(el);
    if (kept) return kept;
    // the ones not known yet, the nearest first, under the nearest that is
    const chain: Element[] = [];
    let base: ReadonlySet<string> = NO_NAMES;
    for (let at: Element | null = el; at; at = elementParent(at)) {
      const known = this._namesKept.get(at);
      if (known) {
        base = known;
        break;
      }
      chain.push(at);
    }
    // and then down: each one's are those above it and its own
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const at = chain[i];
      const own = this._ownAsked(at);
      if (own) {
        const names = new Set(base);
        for (const name of own) names.add(name);
        base = names;
      }
      this._namesKept.set(at, base);
    }
    return base;
  }

  /**
   * The document's shadow trees, each with how its sheets read — the key
   * of the `ShadowSheets` it was handed, which a tree with no sheet has as
   * `''` — as they are now: asked again whenever the document is restyled,
   * since a cascade outlives the tree it was made for where the sheets read
   * the same.
   */
  bindShadows(roots: ReadonlyMap<ShadowRoot, string>): void {
    this._bound.clear();
    this._roots.clear();
    this._trees = new WeakMap();
    for (const [root, key] of roots)
      this._bound.set(root, this._treeRules(key));
    this._scoped = this._byKey.size > 0 || roots.size > 0;
  }

  /** The rules of the shadow trees whose sheets read as `key`. */
  private _treeRules(key: string): TreeRules {
    let rules = this._byKey.get(key);
    if (!rules) {
      rules = newTreeRules(this._nextTree++);
      this._byKey.set(key, rules);
    }
    return rules;
  }

  /** What is known of a shadow tree: how deep it is, and its rules — the
   *  user agent's alone, where it was bound to none. */
  private _rootInfo(root: ShadowRoot): TreeInfo {
    let info = this._roots.get(root);
    if (info) return info;
    const outer = shadowRootAround(root.host);
    info = {
      root,
      depth: (outer ? this._rootInfo(outer).depth : 0) + 1,
      rules: this._bound.get(root) ?? this._treeRules(''),
    };
    this._roots.set(root, info);
    return info;
  }

  /** The tree an element is in, found once a build. */
  private _treeInfo(el: Element): TreeInfo {
    if (!this._scoped) return this._docInfo;
    let info = this._trees.get(el);
    if (info) return info;
    const root = shadowRootAround(el);
    info = root ? this._rootInfo(root) : this._docInfo;
    this._trees.set(el, info);
    return info;
  }

  /**
   * A rule that says something of a shadow tree's edge (`SCOPING`), into
   * its tree's lists, or into the indexes as the rest of it with a test of
   * the host (`IndexedRule.host`). True where it was taken — whether or not
   * it can ever match: one of the document's for a `:host` or a slot,
   * which no element of it is from inside, matches nothing — and false
   * where it says nothing of one after all, a `:host` in an attribute's
   * value, and is an ordinary rule.
   */
  private _addScoped(rule: StyleRule, rules: TreeRules): boolean {
    const pseudo = splitPseudoElement(rule);
    const which: PseudoTarget = pseudo?.which ?? '';
    const subject = pseudo?.rule ?? rule;
    const selector = subject.selector;
    const shadow = rules !== this._document;
    const slotted = readSlotted(selector);
    if (slotted !== undefined) {
      this._noteEdge(rule.selector);
      if (!slotted || !shadow) return true;
      const slot = this._matcherIn(slotted.slot, true);
      const el = this._compile(slotted.arg);
      if (!slot || !el) return true;
      rules.slotted.push({
        rule: subject,
        id: this._scopedId--,
        pseudo: which,
        slot,
        el,
      });
      this._scopedPseudos.add(which);
      return true;
    }
    const part = readPart(selector);
    if (part !== undefined) {
      this._noteEdge(rule.selector);
      if (!part) return true;
      // `:host::part()` is the tree's own host's, and every other the parts
      // of a host in the tree
      const own = readHost(part.host);
      const inner = own.kind === 'subject';
      if (inner && !shadow) return true;
      const host = inner
        ? this._hostTest(own.host)
        : this._matcherIn(part.host, shadow);
      const el = part.after ? this._compile(`*${part.after}`) : null;
      if (!host || (part.after && !el)) return true;
      rules.parts.push({
        rule: subject,
        id: this._scopedId--,
        pseudo: which,
        host,
        names: part.names,
        el,
        inner,
      });
      this._scopedPseudos.add(which);
      return true;
    }
    const reading = readHost(selector);
    if (reading.kind === 'none') return false;
    if (!shadow || reading.kind === 'never') return true;
    const test = this._hostTest(reading.host);
    if (!test) return true;
    if (reading.kind === 'subject') {
      this._noteEdge(rule.selector);
      rules.host.push({
        rule: subject,
        id: this._scopedId--,
        pseudo: which,
        host: test,
      });
      this._scopedPseudos.add(which);
      return true;
    }
    // `:host(.dark) .x`: the rest, which is in the tree, matched as any
    // rule of the tree's, and then its host asked
    const derived = { ...subject, selector: reading.rest };
    const key = rightmostKey(reading.rest);
    if (which) this._pseudo[which].add(derived, key, rules.id, test);
    else {
      this._index.add(derived, key, rules.id, test);
      if (
        (key.kind !== 'tag' || SHAPE_TAGS.has(key.name)) &&
        declaresShape(subject.declarations)
      ) {
        this._shapes.add(derived, key, rules.id, test);
      }
    }
    // what its host is asked can test the state too, `:host(:hover) .x`
    if (HOVER_STATE.mentions.test(rule.selector)) {
      this._index.hoverSensitive = true;
    }
    if (FOCUS_STATE.mentions.test(rule.selector)) {
      this._index.focusSensitive = true;
    }
    this._hoverRules.note(rule.selector);
    this._focusRules.note(rule.selector);
    if (UNSHAREABLE.test(rule.selector)) this._index.ownStyleEverywhere = true;
    return true;
  }

  /**
   * A rule of a tree's edge that tests the pointer or the focus, or where
   * an element sits: what makes a restyle in place safe is asked of the
   * indexes, which the rule is not in, so a change of the state builds the
   * boxes again, and no element shares a style a sibling could change.
   */
  private _noteEdge(selector: string): void {
    if (HOVER_STATE.mentions.test(selector)) {
      this._index.hoverSensitive = true;
      this._hoverRules.local = false;
    }
    if (FOCUS_STATE.mentions.test(selector)) {
      this._index.focusSensitive = true;
      this._focusRules.local = false;
    }
    if (UNSHAREABLE.test(selector)) this._index.ownStyleEverywhere = true;
  }

  /** A selector for an element of a tree, compiled, with its `:host` read
   *  where it is written in a shadow tree (`readHost`). Null where it can
   *  match nothing. */
  private _matcherIn(
    selector: string,
    shadow: boolean,
  ): ((el: Element) => boolean) | null {
    const reading = readHost(selector);
    if (reading.kind === 'none') return this._compile(selector);
    if (!shadow || reading.kind !== 'anchored') return null;
    const rest = this._compile(reading.rest);
    const test = this._hostTest(reading.host);
    if (!rest || !test) return null;
    return (el) => {
      if (!rest(el)) return false;
      const root = shadowRootAround(el);
      return root !== null && test(root.host);
    };
  }

  /** What a `:host` compound asks of the host, compiled: nothing, of
   *  `:host`; its argument, of `:host()`; and of `:host-context()`, its
   *  argument of the host or of an element around it, outside the tree. */
  private _hostTest(found: HostCompound): ((host: Element) => boolean) | null {
    if (found.arg === null) return () => true;
    const match = this._compile(found.arg);
    if (!match || !found.context) return match;
    return (host) => {
      for (let at: Element | null = host; at; at = shadowIncludingParent(at)) {
        if (match(at)) return true;
      }
      return false;
    };
  }

  /**
   * The rules of the trees at an element's edges that reach it, or its
   * pseudo-element `pseudo`, into `out` — each in its own tree's context
   * (`Candidate.context`), and its id into `matched`:
   *
   *  - where it hosts a shadow tree, that tree's `:host` rules, an inner
   *    tree's;
   *  - for each slot it is assigned to, that slot's tree's `::slotted()`
   *    rules, and on through a slot assigned to another slot;
   *  - where it is in a shadow tree and has a `part`, the `::part()`
   *    rules of the tree its host is in, and of each tree further out its
   *    names are exported to, through the hosts' `exportparts` (CSS
   *    Shadow Parts 1, 3.2) — outer trees'.
   */
  private _scopedInto(
    el: Element,
    pseudo: PseudoTarget,
    out: Candidate[],
    matched?: number[],
  ): void {
    const shadow = shadowRootOf(el);
    if (shadow) {
      const inner = this._rootInfo(shadow);
      for (const r of inner.rules.host) {
        if (r.pseudo !== pseudo || !this._holds(r.rule) || !r.host(el)) {
          continue;
        }
        matched?.push(r.id);
        pushRule(out, r.rule, Origin.Author, inner.depth, shadow);
      }
    }
    for (let slot = assignedSlot(el); slot; slot = assignedSlot(slot)) {
      const where = this._treeInfo(slot);
      for (const r of where.rules.slotted) {
        if (
          r.pseudo !== pseudo ||
          !this._holds(r.rule) ||
          !r.el(el) ||
          !r.slot(slot)
        ) {
          continue;
        }
        matched?.push(r.id);
        pushRule(out, r.rule, Origin.Author, where.depth, where.root);
      }
    }
    const part = el.attribs.part;
    if (part === undefined) return;
    // a part of each host out from it, by the names it has there: the
    // host's own tree's `:host::part()` rules, and the rules of the tree
    // the host is in
    let names = tokensOf(part);
    for (let tree = this._treeInfo(el); names.length && tree.root;) {
      const host = tree.root.host;
      const outer = this._treeInfo(host);
      this._partsInto(el, pseudo, names, host, tree, true, out, matched);
      this._partsInto(el, pseudo, names, host, outer, false, out, matched);
      const exported = host.attribs.exportparts;
      if (exported === undefined) break;
      names = exportedNames(names, exported);
      tree = outer;
    }
  }

  /** The `::part()` rules of one tree that reach `el` as a part of `host`
   *  named `names`, into `out`: its `:host::part()` ones (`inner`), or the
   *  rest. */
  private _partsInto(
    el: Element,
    pseudo: PseudoTarget,
    names: readonly string[],
    host: Element,
    tree: TreeInfo,
    inner: boolean,
    out: Candidate[],
    matched?: number[],
  ): void {
    for (const r of tree.rules.parts) {
      if (
        r.inner !== inner ||
        r.pseudo !== pseudo ||
        !this._holds(r.rule) ||
        !r.names.every((name) => names.includes(name)) ||
        (r.el !== null && !r.el(el)) ||
        !r.host(host)
      ) {
        continue;
      }
      matched?.push(r.id);
      pushRule(out, r.rule, Origin.Author, tree.depth, tree.root);
    }
  }

  /** Whether a rule's media queries hold now. */
  private _holds(rule: StyleRule): boolean {
    return mediaMatches(
      rule.media,
      this.viewportWidth / this.scale,
      this.look.colorScheme,
      this.viewportHeight / this.scale,
      this.scale,
      this.reducedMotion,
    );
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
    const kept = this._kept;
    if (kept !== null && !kept.restyle.has(el)) {
      // An element the change did not reach keeps its style, under a key
      // of its own: a key stands for an element's ancestors, which the
      // elements styled again under it have in common, and two kept
      // elements with one style need not — a hover restyled in place
      // leaves a hovered card's children the styles its neighbours' have.
      let shared = this._keptShared.get(el);
      if (shared !== undefined) return shared;
      const was = kept.styles.get(el);
      if (was !== undefined && was.inFlex === inFlexContainer) {
        shared = { style: was.style, key: this._nextShareKey++ };
        this._keptShared.set(el, shared);
        return shared;
      }
    }
    let key = `${parentKey}\u0001${inFlexContainer ? 1 : 0}`;
    const tag = tagOf(el);
    key += `\u0001${tag.length}:${tag}`;
    if (this._index.hoverSensitive) {
      if (this._pointer.hovered.has(el)) key += '\u0001:hover';
      if (this._pointer.active.has(el)) key += '\u0001:active';
    }
    // `:focus-within` is not shared under (`UNSHAREABLE`), and the focus
    // is on one element
    if (this._focus.element === el && this._index.focusSensitive) {
      key += this._focus.visible ? '\u0001:focus-visible' : '\u0001:focus';
    }
    const attribs = el.attribs;
    for (const name in attribs) {
      const value = attribs[name];
      key += `\u0001${name.length}:${name}=${value.length}:${value}`;
    }
    // which tree's rules it is styled by, and where it hosts a tree, that
    // tree's `:host` rules: a `<b>` assigned to a slot in one card and the
    // `<b>` the slot falls back to in another have parents of one key, and
    // two `<my-card>`s alike in every way can host trees of other sheets
    if (this._scoped) {
      const tree = this._treeInfo(el).rules.id;
      if (tree) key += `\u0001s${tree}`;
      const shadow = shadowRootOf(el);
      if (shadow) key += `\u0001h${this._rootInfo(shadow).rules.id}`;
    }
    // and an image's hints are the attributes of the source it chose, where
    // that sizes it (`presentationHints`)
    if (tag === 'img' && this.dimensionSource) {
      const source = this.dimensionSource(el);
      if (source !== el) {
        const w = attr(source, 'width');
        const h = attr(source, 'height');
        key += `\u0001sized by=${w?.length ?? -1}:${w ?? ''}=${h?.length ?? -1}:${h ?? ''}`;
      }
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
            true,
            '',
          ),
          key: this._nextShareKey++,
        };
        if (!this._running(shared.style, el)) {
          this._sharedByMatch.set(key, shared);
        }
      }
      return shared;
    }
    let shared = this._shared.get(key);
    if (shared === undefined) {
      shared = {
        style: this.styleFor(el, parentStyle, inFlexContainer),
        key: this._nextShareKey++,
      };
      if (!this._running(shared.style, el)) this._shared.set(key, shared);
    }
    return shared;
  }

  /** Whether a style is an element's alone: one its animations run in is
   *  as far through them as its own started, and no other element's, and
   *  one its transitions run in is where its own are. */
  private _running(style: ComputedStyle, el: Element): boolean {
    const timeline = this.timeline;
    if (timeline === null) return false;
    return style.animations !== NO_ANIMATIONS || timeline.transiting(el);
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
    /** Whether the element is one of the document's, whose animations run
     *  on its timeline: not one `rootStyle` made up. */
    inDocument = true,
  ): ComputedStyle {
    return this._computeStyle(
      el,
      parentStyle,
      inFlexContainer,
      this._candidates(el),
      true,
      inDocument ? '' : null,
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
    const indexed = index.size > 0 && index.reaches(el);
    const edges = this._scoped && this._scopedPseudos.has(which);
    if (!indexed && !edges) return null;
    const candidates: Candidate[] = [];
    if (indexed) this._matchInto(index, el, candidates);
    if (edges) this._scopedInto(el, which, candidates);
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
      false,
      which,
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

  /** Whether any rule styles a `::selection`: a document with none draws
   *  a selection in the palette's colour, and asks nothing. */
  get hasSelection(): boolean {
    return this._pseudo.selection.size > 0;
  }

  /**
   * An element's `::selection`, over its parent's (`parent`, null for the
   * palette's own): the colour and the background the rules that reach it
   * set, and its parent's for either they leave alone. Both inherit along
   * the chain of highlights rather than the elements' (CSS Pseudo 4, 3.5,
   * "highlight inheritance"), which is what Chrome draws: a `<span>` in a
   * `div::selection { background: red }` is selected in red, and a `<p>`
   * whose own rule sets only a colour keeps the red under it.
   *
   * The palette's highlight is taken only where no rule has set either
   * (3.6, "paired defaults"): one that sets a colour and no background is
   * selected over none, as Chrome has it. A rule that sets neither — a
   * `text-shadow` only — leaves the element where its parent was.
   */
  selectionStyle(
    el: Element,
    style: ComputedStyle,
    parent: SelectionStyle | null,
  ): SelectionStyle | null {
    const index = this._pseudo.selection;
    if (!index.size || !index.reaches(el)) return parent;
    const candidates: Candidate[] = [];
    this._matchInto(index, el, candidates);
    let color = false;
    let background = false;
    for (const candidate of candidates) {
      for (const d of candidate.declarations) {
        if (d.prop === 'color') color = true;
        else if (d.prop === 'background' || d.prop === 'background-color') {
          background = true;
        }
      }
    }
    if (!color && !background) return parent;
    candidates.sort(byCascade);
    const own = this._computeStyle(el, style, false, candidates);
    return {
      color: color ? own.color : (parent?.color ?? null),
      background: background
        ? own.backgroundColor
        : (parent?.background ?? null),
    };
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

  /** The x-height of a style's font: the font's own, asked once per face,
   *  or half an em. */
  private _exOf(style: FaceSource): number {
    const key = faceKey(style);
    let ex = this._xHeights.get(key);
    if (ex === undefined) {
      ex = this._xHeightOf?.(faceOf(style)) ?? NaN;
      if (!(ex > 0)) ex = style.fontSize * 0.5;
      this._xHeights.set(key, ex);
    }
    return ex;
  }

  /** The advance of a style's font's "0": the font's own, asked once per
   *  face, or half an em. */
  private _chOf(style: FaceSource): number {
    const key = faceKey(style);
    let ch = this._zeroWidths.get(key);
    if (ch === undefined) {
      ch = this._zeroWidthOf?.(faceOf(style)) ?? NaN;
      if (!(ch > 0)) ch = style.fontSize * 0.5;
      this._zeroWidths.set(key, ch);
    }
    return ch;
  }

  /** A style's computed line height as a length, for `lh`: `normal` as
   *  its font's own, asked once per face, or 1.2em. */
  private _lineHeightOf(style: LineSource): number {
    const set = style.lineHeight;
    if (set !== 'normal') {
      return style.lineHeightIsLength ? set : set * style.fontSize;
    }
    const key = faceKey(style);
    let line = this._normalLines.get(key);
    if (line === undefined) {
      line = this._normalLineOf?.(faceOf(style)) ?? NaN;
      if (!(line > 0)) line = style.fontSize * 1.2;
      this._normalLines.set(key, line);
    }
    return line;
  }

  /**
   * `styleFor`, from the rules and hints already gathered for `el`, and
   * what its animations make of it. Which animations an element has is the
   * cascade's answer, so an animated element is styled again with what they
   * come to among its declarations, at the animation origin: over the
   * author's normal ones and under their `!important` ones. Where its
   * animations run (`timeline`), that is the values they pass through now
   * (`_animatedDeclarations`); where none runs, the frame each that fills
   * forwards ends on (`restingFrames`).
   */
  private _computeStyle(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
    candidates: Candidate[],
    /** Whether the style is the element's own, and not that of one of its
     *  pseudo-elements. */
    own = false,
    /** Which of the element's animations run: its own (''), a `::before`'s
     *  or an `::after`'s. Null for a style whose animations do not run, and
     *  are drawn at rest: a marker's, a first letter's or line's, and an
     *  element's that `rootStyle` made up. */
    target: string | null = null,
  ): ComputedStyle {
    let style = this._cascadeStyle(
      el,
      parentStyle,
      inFlexContainer,
      candidates,
      own,
    );
    // where the names are looked for: in the tree whose rule named them
    const tree = ANIMATION_TREES.get(style.animations) ?? null;
    const keyframesOf = (name: string) => this.keyframes(name, tree);
    const timeline = target === null ? null : this.timeline;
    // the fields its animations set now, which no transition starts on
    let animated: ReadonlySet<string> | null = null;
    if (
      style.animations === NO_ANIMATIONS ||
      !this._anyKeyframes ||
      // one not displayed runs none (CSS Animations 1, 3)
      (timeline && style.display === 'none')
    ) {
      if (timeline && !timeline.empty) timeline.drop(el, target!);
    } else if (timeline) {
      const samples = timeline.sample(
        el,
        target!,
        style.animations,
        keyframesOf,
      );
      animated = fieldsAnimatedBy(samples);
      if (samples) {
        style = this._cascadeStyle(
          el,
          parentStyle,
          inFlexContainer,
          withAnimations(
            candidates,
            this._animatedDeclarations(
              el,
              parentStyle,
              inFlexContainer,
              candidates,
              own,
              style,
              samples,
            ),
          ),
          own,
        );
      }
      // what its animations set acts as named in `will-change`, in a delay
      // as much as under way (Web Animations 1, 5.6): a style made here is
      // the element's alone (`_alone`)
      style.willChange |= timeline.willChange(el, target!);
    } else {
      const frames = restingFrames(style.animations, keyframesOf);
      if (frames) {
        style = this._cascadeStyle(
          el,
          parentStyle,
          inFlexContainer,
          withAnimations(candidates, frames),
          own,
        );
      }
      // and at rest, each that fills forwards is in effect
      style.willChange |= restingWillChange(style.animations, keyframesOf);
    }
    // and what its transitions make of it, from the style the document has
    // for it now (CSS Transitions 1, 3): none for one not displayed, and
    // none on what its animations set, now or in the style before
    if (timeline) {
      const pseudo = target!;
      if (style.display === 'none') timeline.dropTransitions(el, pseudo);
      else {
        style = timeline.transition(
          el,
          pseudo,
          style,
          () => this.previous?.(el, pseudo) ?? null,
          animated,
        );
        if (animated) noteAnimated(style, animated);
      }
    }
    // which faces of the document's own families this family, weight and
    // slant ask for — known only now, with all three computed
    this._families?.note(style);
    return style;
  }

  /**
   * What an element's animations come to at the timeline's time: for each
   * animation, a declaration of each property its frames set, holding the
   * computed value between the two frames around its progress (`spanAt`),
   * interpolated field by field (`interpolateField`) — or, for a property
   * whose values cannot be, the nearer one's (`discrete`). A frame's value
   * is computed as the frame's declarations would be at the animation
   * origin, so its `em`, its `var()` and its percentages are the element's;
   * a frame the animation makes of the element's own value is `base`.
   */
  private _animatedDeclarations(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
    candidates: Candidate[],
    own: boolean,
    base: ComputedStyle,
    samples: readonly Sample[],
  ): Declaration[][] {
    const styles = new Map<Keyframe, ComputedStyle>();
    const styleAt = (frame: Keyframe | null): ComputedStyle => {
      if (!frame) return base;
      let style = styles.get(frame);
      if (!style) {
        style = this._cascadeStyle(
          el,
          parentStyle,
          inFlexContainer,
          withAnimations(candidates, [frame.declarations]),
          own,
        );
        styles.set(frame, style);
      }
      return style;
    };
    const out: Declaration[][] = [];
    for (const { rule, progress, easing } of samples) {
      const declarations: Declaration[] = [];
      for (const [prop, frames] of tracksOf(rule)) {
        const { from, to, q } = spanAt(frames, progress, easing);
        const fields = animatedFields(prop);
        if (!fields) {
          // a property whose values this cannot read goes over half-way,
          // as its declaration: the element's own, where that end is it
          const at = discrete(from, to, q);
          if (at) declarations.push(at.declaration);
          continue;
        }
        const a = styleAt(from?.frame ?? null) as unknown as Record<
          string,
          unknown
        >;
        const b = styleAt(to?.frame ?? null) as unknown as Record<
          string,
          unknown
        >;
        const computed: Record<string, unknown> = {};
        let flips = false;
        for (const key of fields) {
          const value = interpolateField(key, a[key], b[key], q);
          if (value === undefined) {
            flips = true;
            break;
          }
          computed[key] = value;
        }
        if (flips) {
          const at = discrete(a, b, q);
          for (const key of fields) computed[key] = at[key];
        }
        declarations.push({ prop, value: '', important: false, computed });
      }
      if (declarations.length) out.push(declarations);
    }
    return out;
  }

  /** The style the candidates come to, in their order. */
  private _cascadeStyle(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
    candidates: Candidate[],
    own: boolean,
  ): ComputedStyle {
    const style = inherit(parentStyle, this.initial);
    // custom properties first, in cascade order, so every `var()` in the
    // declarations below finds the one that wins
    if (this._vars) style.custom = this._customFor(parentStyle, candidates);

    // The unit context has to be built twice: once with the parent's font
    // size, so a `font-size: 1.2em` in the cascade resolves against the
    // right em, and again after the font size is settled so every *other*
    // em-relative length in the same rule resolves against this element's.
    const root = isRootElement(el);
    const rootStyle = root ? this.initial : (this._root ?? this.initial);
    // whose declaration is being applied: the UA sheet's families are the
    // host's own faces, and its lists end where they end
    let authored = true;
    const ctxParent: UnitContext = {
      em: parentStyle.fontSize,
      rem: rootStyle.fontSize,
      initial: this.initial,
      fallbackFamily: () => (authored ? this.initial.fontFamily : null),
      codeFamily: () => (authored ? null : this._codeFamily),
      vw: this.viewportWidth,
      vh: this.viewportHeight,
      scale: this.scale,
      ex: () => this._exOf(parentStyle),
      ch: () => this._chOf(parentStyle),
      families: this._mapFamilies,
      lh: () => this._lineHeightOf(parentStyle),
      rlh: () => this._lineHeightOf(rootStyle),
      focusRing: this.look.focusRing,
      paletteScheme: this.look.colorScheme,
      systemColors: this._systemColors,
    };
    // The family, the weight, the slant and the width go with the size:
    // together they pick the face an `ex`, a `ch` or an `lh` in any
    // declaration is measured in, however the declarations are ordered. A
    // `width: 10ex` in a sheet under an inline `font-weight: 900` was
    // measured in the family's regular face. The colour scheme goes ahead of
    // the rest for the same reason: every `light-dark()` among them is read
    // by it.
    for (const c of candidates) {
      authored = !fromUserAgent(c.origin);
      for (const d of pick(c)) {
        if (
          d.prop === 'font-family' ||
          d.prop === 'font-weight' ||
          d.prop === 'font-style' ||
          d.prop === 'font-stretch' ||
          d.prop === 'color-scheme' ||
          d.prop === 'font-size' ||
          d.prop === 'font'
        ) {
          this._apply(style, parentStyle, d, ctxParent);
        }
      }
    }
    // The generic `monospace` alone is set smaller than any other family:
    // 13px where the rest are 16, the fixed-width default every browser
    // keeps beside its standard one, and why a `<pre>` is 13px. A size
    // that is a keyword is read from that family's row of the table, and
    // one relative to a keyword's — an `em` or a percentage of one, all
    // the way up to the root's `medium` — is scaled by 13/16 where the
    // family becomes the generic and back where it stops being it, set on
    // the element or not; a length of its own, or a size under one, is
    // what it says in any family. Blink's CheckForGenericFamilyChange,
    // which WebKit shares; Gecko scales only a size that comes of a
    // keyword, and reads an `em` of one from the keyword's row as well.
    const basis = style.fontSizeBasis;
    const mono = style.genericMonospace;
    if (basis !== 'absolute' && (mono || parentStyle.genericMonospace)) {
      if (basis !== 'relative') {
        style.fontSize = keywordFontSize(
          basis,
          parentStyle.fontSize,
          this.initial.fontSize,
          mono,
        )!;
      } else if (mono !== parentStyle.genericMonospace) {
        style.fontSize *= mono ? FIXED_SIZE : 1 / FIXED_SIZE;
      }
    }
    // The face as the first pass settled it. The second applies every
    // declaration again in cascade order, the font's among them, so the
    // style passes through the fonts of every rule on the way: read from
    // it, the `10ex` in `div { font-family: foo; width: 10ex }` was `foo`'s
    // under an inline `font-family: Ahem` that came after it.
    const face: FaceSource = {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      fontStretch: style.fontStretch,
    };
    let line: LineSource | null = null;
    // the root's other declarations measure a `rem` from its own size
    if (root) this._root = style;
    const ctx: UnitContext = {
      ...ctxParent,
      em: style.fontSize,
      rem: root ? style.fontSize : ctxParent.rem,
      ex: () => this._exOf(face),
      ch: () => this._chOf(face),
      lh: () => this._lineHeightOf(line ?? style),
    };
    // the line height, which an `lh` in any other declaration reads, ahead
    // of them — a `font` sets one too — and read as it is then, for the
    // same reason as the face: set again with the rest, in its place among
    // them. A `font` sets the size as well, which the first pass settled.
    if (this._lh) {
      for (const c of candidates) {
        authored = !fromUserAgent(c.origin);
        for (const d of pick(c)) {
          if (d.prop === 'line-height' || d.prop === 'font') {
            this._apply(style, parentStyle, d, ctx);
          }
        }
      }
      style.fontSize = face.fontSize;
      line = {
        ...face,
        lineHeight: style.lineHeight,
        lineHeightIsLength: style.lineHeightIsLength,
      };
    }
    const settled = style.fontSize;
    // the tree whose rule named the animations, where it is a shadow tree
    let animationTree: ShadowRoot | null = null;
    const scoped = this._scoped;
    for (const c of candidates) {
      authored = !fromUserAgent(c.origin);
      for (const d of pick(c)) {
        if (d.prop === 'font-size' || d.custom) continue;
        this._apply(style, parentStyle, d, ctx);
        if (scoped && ANIMATION_NAMES.has(d.prop)) animationTree = c.tree;
      }
    }
    // kept beside the lists, which are shared by what they were read from
    if (animationTree && style.animations !== NO_ANIMATIONS) {
      const named = { ...style.animations };
      ANIMATION_TREES.set(named, animationTree);
      style.animations = named;
    }
    // A `font` is applied again, to keep its other longhands in cascade
    // order, and it sets the size it names as well: the size is the first
    // pass's, which the declarations that outrank the `font` had their say
    // in, and the scale after them. `span { font: 15px/1 Ahem }` under
    // `.b > span { font-size: 3.75em }` was 15px, its `em`s 3.75 of its
    // parent's.
    style.fontSize = settled;
    style.fontSizeBasis = basis;

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
    settleAlign(style, parentStyle);
    settleOverflow(style);
    settleOutline(style, this.look, this.scale);
    settleContentVisibility(style);
    // after the containment, which keeps a body's `overflow` its own
    if (own && el.name.length === 4) propagateOverflow(el, style, parentStyle);
    blockify(style, inFlexContainer);
    // the answer that took the palette's chrome from the control, if it
    // had any (`_candidates`), for what draws its box (`styledField`)
    if (
      own &&
      el.name.length >= 5 &&
      el.name.length <= 8 &&
      CONTROL_TAGS.has(tagOf(el)) &&
      stylesControl(candidates)
    ) {
      style.styledControl = true;
    }
    // a button is laid out as one, whatever `display` it was given
    if (own && el.name.length === 6 && tagOf(el) === 'button') {
      settleButton(style);
    }
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
    // an animation's value, computed already (`_animatedDeclarations`)
    if (d.computed) {
      Object.assign(style, d.computed);
      return;
    }
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
   *
   * `html` is the implied `<html>`'s own style where the root box stands in
   * for the body inside it, and null otherwise: what an `html { … }` or a
   * `:root { … }` rule gives it that is not inherited has no box to be
   * drawn on, and its background is the canvas's (`paintDocument`).
   */
  rootStyle(
    hasBody: boolean,
    hasHtml = true,
  ): { style: ComputedStyle; html: ComputedStyle | null } {
    const style = copyStyle(this.initial);
    style.display = 'block';
    if (hasBody && hasHtml) return { style, html: null };
    const synthetic = new DomElement('body', {}, []);
    let parent = style;
    let html: ComputedStyle | null = null;
    if (!hasHtml) {
      const element = new DomElement('html', {}, hasBody ? [] : [synthetic]);
      synthetic.parent = element;
      parent = this.styleFor(element, style, false, false);
      if (hasBody) return { style: asRoot(parent), html: null };
      html = parent;
    }
    // Only the box the body would have drawn is taken, not its layout role:
    // the root is still the initial containing block.
    return {
      style: asRoot(this.styleFor(synthetic, parent, false, false)),
      html,
    };
  }

  /** Whether a pointer move can change what a rule gives a shape in a
   *  drawing. */
  get shapesFollowPointer(): boolean {
    return this._shapes.hoverSensitive;
  }

  /**
   * What the rules give the elements of an inline drawing, `root` and what
   * is in it, or null where none reaches one: the narrow cascade of
   * `shapes.ts`. `style` is the root's computed style — its `color`, its
   * custom properties and its font size are what a value in the drawing is
   * read against, as though every element in it had inherited them, which
   * all but one a rule gives its own has.
   *
   * An element's rules and its `style` attribute are put in cascade order,
   * and each property is the last valid declaration's. The presentation
   * attributes are below them all (SVG 2, 6.2), and `SvgView` reads those
   * itself. The root's box has its paint, its opacity and whether it is
   * shown from its computed style, so those are left out for it.
   *
   * What a `<use>` draws is a copy, styled in a tree of its own
   * (`ShapeStyles.used`): the element it names is looked for as `copyTree`
   * looks — the drawing's own first, then the document's — and what is in
   * it asked of where it stands in that tree, once a build for all the
   * `<use>`s that name it (`ShapeCopies`). An icon sprite's `<symbol>`,
   * outside the drawing in a hidden `<svg>` of them, is styled that way,
   * and so is one of the drawing's own.
   *
   * A presentation attribute with a `var()` in it is a declaration of the
   * element's under all of those (`Origin.Presentation`), substituted
   * against the custom properties the element has: the root's, and those
   * a `style` in the drawing sets on the way down to it. What a `<use>`
   * draws has the root's.
   *
   * Asked as a drawing is first painted (`BoxTree.shapeStyler`), of the
   * rules in `_shapes` alone: a page of hundreds of icons pays for the ones
   * it shows, a look in the buckets for each of their elements where no
   * rule reaches them, and a document with no such rule a look at the
   * attributes of the shapes' properties (`drawingVars`).
   */
  shapeStyles(
    root: Element,
    style: ComputedStyle,
    copies: ShapeCopies | null = null,
  ): ShapeStyles | null {
    const index = this._shapes;
    // the drawing's tree, whose rules and attributes are of one context,
    // and whose ids are its own: the build's index is of the document's
    const tree = this._scoped ? this._treeInfo(root) : this._docInfo;
    const byId =
      copies && !tree.root
        ? copies.byId
        : (id: string) => elementById(root, id);
    // A presentation attribute is a declaration too (SVG 2, 6.2), and one
    // with a `var()` in it is read here, where the drawing's custom
    // properties are: `SvgView` reads the attribute as it is written, and
    // `var(--color-primary)` is no colour it can paint with. So a drawing
    // with one is asked of whether a rule reaches it or not.
    const vars = !index.size ? drawingVars(root, byId) : true;
    if (!vars) return null;
    // The rules kept by a class or an id are asked of the elements with
    // that name. The rest — `.dark .logo path`, `.menu [aria-hidden]` — are
    // asked of every `<path>`, or of every element, and nearly all of them
    // are for some other part of the page: each says so by the class or the
    // id it asks of an ancestor, which is looked for once for the drawing,
    // around it and in it, where matching the rule would look for it from
    // each of its elements. On a page with none of them around a drawing,
    // nothing is matched at all. A copy's tree has nothing around it.
    const needs = (this._shapeNeeds ??= this._needsOfShapes());
    let found = new Set<string>();
    const asks = needs.classes.size > 0 || needs.ids.size > 0;
    const note = (el: Element): void => {
      if (needs.ids.size) {
        const id = attr(el, 'id');
        if (id && needs.ids.has(id)) found.add(`#${id}`);
      }
      if (needs.classes.size) {
        const className = attr(el, 'class');
        if (className) {
          for (const name of className.split(/\s+/)) {
            if (needs.classes.has(name)) found.add(`.${name}`);
          }
        }
      }
    };
    if (asks) {
      let at = root.parent;
      while (at && at.type === 'tag') {
        note(at as Element);
        at = at.parent;
      }
    }
    const live = (indexed: IndexedRule): boolean => {
      const keys = indexed.needs;
      if (keys) for (const key of keys) if (!found.has(key)) return false;
      return true;
    };
    // The root's box has its paint from its computed style, so most of the
    // rules that name a drawing by its class — an icon set's — have
    // nothing else to say of it.
    const liveForRoot = (indexed: IndexedRule): boolean =>
      (indexed.root ??= declaresRootShape(indexed.rule.declarations)) &&
      live(indexed);

    /** The elements under `top` and it, in document order, the top first:
     *  its ancestors are noted before an element is asked of. Each with
     *  the rules it matched, in cascade order, where it matched any. */
    const walk = (
      top: Element,
      inCopy: boolean,
      each: (el: Element, candidates: Candidate[] | null) => void,
    ): void => {
      const stack: Element[] = [top];
      while (stack.length) {
        const el = stack.pop()!;
        // what is in a `<foreignObject>` is not the drawing's to draw
        if (el.name !== 'foreignobject' && el.name !== 'foreignObject') {
          const children = el.children;
          for (let i = children.length - 1; i >= 0; i -= 1) {
            const child = children[i];
            if (child.type === 'tag') stack.push(child as Element);
          }
        }
        if (asks) note(el);
        const tag = tagOf(el);
        const asked = found.size
          ? index.universal.length > 0 || index.byTag.has(tag)
          : needs.universal || needs.tags.has(tag);
        const ruled = index.size > 0 && (asked || index.names(el));
        // its attributes with a `var()` in them, and whether its `style`
        // has one, where the drawing has any (`drawingVars`)
        const presented = vars ? attributeVars(el) : null;
        const inline = attr(el, 'style');
        const inlineVars = !!inline && hasVar(inline);
        if (!ruled && !presented && !inlineVars) {
          each(el, null);
          continue;
        }
        const candidates: Candidate[] = [];
        if (ruled) {
          this._matchInto(
            index,
            el,
            candidates,
            undefined,
            el === root && !inCopy ? liveForRoot : live,
            inCopy,
          );
        }
        if (presented) {
          // under every rule, as an HTML element's presentational
          // attributes are (`presentationHints`)
          candidates.push({
            origin: Origin.Presentation,
            context: tree.depth,
            tree: tree.root,
            layer: null,
            specificity: 0,
            order: 0,
            declarations: presented,
            only: -1,
          });
        }
        if (candidates.length || inlineVars) {
          if (inline) {
            pushInlineShapes(candidates, inline, tree.depth, tree.root);
          }
          candidates.sort(byCascade);
        }
        each(el, candidates.length ? candidates : null);
      }
    };

    let ctx: ShapeContext | null = null;
    /** What an element's rules come to, against the drawing's style and
     *  the custom properties the element has. */
    const resolve = (
      candidates: Candidate[],
      isRoot: boolean,
      custom: CustomProps | null = style.custom,
    ): Record<string, string> | null => {
      ctx ??= {
        color: style.color,
        scheme: style.colorScheme,
        units: {
          em: style.fontSize,
          rem: (this._root ?? this.initial).fontSize,
          vw: this.viewportWidth,
          vh: this.viewportHeight,
          scale: this.scale,
          initial: this.initial,
          systemColors: this._systemColors,
        },
      };
      let own: Record<string, string> | null = null;
      for (const c of candidates) {
        for (const d of pick(c)) {
          if (!isShapeProp(d.prop)) continue;
          if (isRoot && ROOT_BOX_PROPS.has(d.prop)) {
            // the box has it, from the same attribute (`presentationHints`),
            // and hands it over (`SvgDrawing.draw`): the attribute, as
            // written, is taken away from under it
            if (c.origin === Origin.Presentation) {
              (own ??= {})[d.prop] = 'inherit';
            }
            continue;
          }
          // a `var()` with nothing to stand for it, or that stands for
          // something the property does not take, is invalid at
          // computed-value time, and the property as though `unset`
          let value: string | null;
          if (d.vars) {
            const raw = substituteIn(d.value, custom);
            value =
              (raw === null ? null : shapeValue(d.prop, raw, ctx)) ??
              shapeValue(d.prop, 'unset', ctx);
          } else value = shapeValue(d.prop, d.value, ctx);
          if (value !== null) (own ??= {})[d.prop] = value;
        }
      }
      return own;
    };
    // an element's place in the walks is what the key names it by
    let key = '';
    let place = -1;
    const named = (own: Record<string, string>, at: number): string => {
      let part = `${at}{`;
      for (const prop in own) part += `${prop}:${own[prop]};`;
      return `${part}}`;
    };

    // (made as they are first needed: most drawings need none of them)
    let of = null as Map<Element, ShapeStyle> | null;
    // the `<use>`s met, and the drawing's own elements by their ids, which
    // one looks in first
    let uses = null as Element[] | null;
    let ids = null as Map<string, Element> | null;
    // The custom properties a `style` in the drawing sets, by the element
    // that sets them, over its parent's: the root's are its box's, and an
    // element's parent is walked before it.
    let customs: Map<Element, CustomProps | null> | null = null;
    const customOf = (el: Element): CustomProps | null => {
      let at: Element | null = customs ? el : null;
      while (at && at !== root) {
        const found = customs!.get(at);
        if (found !== undefined) return found;
        at = at.parent && isTag(at.parent) ? (at.parent as Element) : null;
      }
      return style.custom;
    };
    walk(root, false, (el, candidates) => {
      place += 1;
      if (isUse(el)) (uses ??= []).push(el);
      if (el !== root) {
        const id = el.attribs.id;
        if (id && !ids?.has(id)) (ids ??= new Map()).set(id, el);
        const set = vars ? ownCustoms(el) : null;
        if (set) {
          const parent = el.parent && isTag(el.parent) ? el.parent : root;
          (customs ??= new Map()).set(
            el,
            customProperties(set, customOf(parent as Element)),
          );
        }
      }
      const own = candidates && resolve(candidates, el === root, customOf(el));
      if (!own) return;
      (of ??= new Map()).set(el, own);
      key += named(own, place);
    });
    if (!uses) return of ? { of, used: null, key } : null;

    // Each element a `<use>` names, in the tree of its copy: once however
    // many name it, and one a copy's `<use>` names in turn, however deep —
    // `copyTree` stops at a depth, and a `<use>` that names what it is in
    // finds it being walked. What is matched there is the same for every
    // drawing, and kept for the build (`ShapeCopies`); what it comes to is
    // the drawing's, since every property the copy inherits is the
    // `<use>`'s, and its custom properties and its colour are the
    // drawing's, as they are for the rest of it — kept too, for each
    // style a drawing has, which the icons of a page mostly share.
    const matched = copies?.matched ?? new Map<Element, CopyMatch>();
    let styled = copies?.resolved.get(style);
    if (!styled) {
      styled = new Map();
      copies?.resolved.set(style, styled);
    }
    const match = (target: Element): CopyMatch => {
      let copy = matched.get(target);
      if (copy) return copy;
      const rules: CopyMatch['rules'] = [];
      const inner: Element[] = [];
      let size = 0;
      found = new Set();
      this._copyTop = target;
      try {
        walk(target, true, (el, candidates) => {
          if (isUse(el)) inner.push(el);
          if (candidates) rules.push({ el, at: size, candidates });
          size += 1;
        });
      } finally {
        this._copyTop = null;
      }
      copy = { rules, size, uses: inner };
      matched.set(target, copy);
      return copy;
    };
    let used: Map<Element, ReadonlyMap<Element, ShapeStyle>> | null = null;
    let made: Set<Element> | null = null;
    for (let i = 0; i < uses.length; i += 1) {
      const use = uses[i];
      const id = useHref(use);
      if (id === null) continue;
      const target = ids?.get(id) ?? byId(id);
      if (!target) continue;
      const copy = match(target);
      let done = styled.get(target);
      if (!done) {
        let into: Map<Element, ShapeStyle> | null = null;
        let part = '';
        for (const { el, at, candidates } of copy.rules) {
          const own = resolve(candidates, false);
          if (!own) continue;
          (into ??= new Map()).set(el, own);
          part += named(own, at);
        }
        done = { into, key: part };
        styled.set(target, done);
      }
      if (!made?.has(target)) {
        (made ??= new Set()).add(target);
        for (const next of copy.uses) uses.push(next);
        // its place in the key is after what came before it
        if (done.key) key += `@${place + 1}:${done.key}`;
        place += copy.size;
      }
      if (done.into) (used ??= new Map()).set(use, done.into);
    }
    return of || used ? { of: of ?? NO_SHAPES, used, key } : null;
  }

  /** `ShapeNeeds`, and each such rule's own (`IndexedRule.needs`). */
  private _needsOfShapes(): ShapeNeeds {
    const index = this._shapes;
    const needs: ShapeNeeds = {
      classes: new Set(),
      ids: new Set(),
      universal: false,
      tags: new Set(),
    };
    const read = (bucket: IndexedRule[]): boolean => {
      let free = false;
      for (const indexed of bucket) {
        const keys = this._needsOf(indexed);
        if (!keys.length) free = true;
        for (const key of keys) {
          (key[0] === '#' ? needs.ids : needs.classes).add(key.slice(1));
        }
      }
      return free;
    };
    needs.universal = read(index.universal);
    for (const [tag, bucket] of index.byTag) {
      if (read(bucket)) needs.tags.add(tag);
    }
    return needs;
  }

  /**
   * Whether the pointer's move from `was` to where it is changed which
   * rules match `el`, or its `::before`, `::after` or another of its
   * pseudo-elements: the rules that test `:hover` asked under both, and
   * nothing else, since no other rule's answer is the pointer's. An element
   * they answer the same for, under a parent whose style is what it was, has
   * the style it had — which is most of what a move reaches: the rows of a
   * hovered table body, what is in a hovered card. The focus's move from
   * `wasFocus` likewise, the rules that test it asked under both.
   */
  pointerChanged(
    el: Element,
    was: PointerState,
    wasFocus: FocusState = this._focus,
  ): boolean {
    const now = this._pointer;
    const nowFocus = this._focus;
    const after = this._pointerAnswers(el);
    this._pointer = was;
    this._focus = wasFocus;
    const before = this._pointerAnswers(el);
    this._pointer = now;
    this._focus = nowFocus;
    return before !== after;
  }

  /** The ids of the rules testing the pointer or the focus that match
   *  `el` as things stand, the element's and each pseudo-element's. */
  private _pointerAnswers(el: Element): string {
    let answers = '';
    const ask = (index: RuleIndex, name: string): void => {
      const pointer = index.pointer;
      if (!pointer || !pointer.reaches(el)) return;
      const matched: number[] = [];
      this._matchInto(pointer, el, null, matched);
      if (matched.length) answers += `${name}${matched.join(',')};`;
    };
    ask(this._index, '');
    for (const which of POINTER_PSEUDO_ELEMENTS)
      ask(this._pseudo[which], which);
    return answers;
  }

  /** The rules of `index` that match `el`, pushed onto `out` as candidates,
   *  and their ids onto `matched` in the order they were tried. */
  private _matchInto(
    index: RuleIndex,
    el: Element,
    out: Candidate[] | null,
    matched?: number[],
    /** The rules to try, where some are known not to match without it. */
    live?: (indexed: IndexedRule) => boolean,
    /** Whether `el` is matched where a `<use>` draws a copy of it
     *  (`_copyTop`). */
    inCopy = false,
  ): void {
    // A media query's width is CSS pixels; the viewport is kept in device.
    const width = this.viewportWidth / this.scale;
    const height = this.viewportHeight / this.scale;
    // the rules of the tree the element is in, and the user agent's
    const scoped = this._scoped;
    const tree = scoped ? this._treeInfo(el) : this._docInfo;
    const scope = tree.rules.id;

    // the asked names above the element (`_namesAbove`), worked out where a
    // rule first asks for them, and again after one notes a name
    let above: ReadonlySet<string> = NO_NAMES;
    let aboveGen = -1;
    const hasAncestors = (needs: readonly string[]): boolean => {
      if (aboveGen !== this._askedGen) {
        const parent = elementParent(el);
        above = parent ? this._namesAbove(parent) : NO_NAMES;
        aboveGen = this._askedGen;
      }
      for (const name of needs) if (!above.has(name)) return false;
      return true;
    };
    const consider = (bucket: IndexedRule[] | undefined): void => {
      if (!bucket) return;
      for (const indexed of bucket) {
        if (scoped && indexed.scope !== scope && indexed.scope !== UA_SCOPE) {
          continue;
        }
        if (live !== undefined && !live(indexed)) continue;
        const rule = indexed.rule;
        if (
          !mediaMatches(
            rule.media,
            width,
            this.look.colorScheme,
            height,
            this.scale,
            this.reducedMotion,
          )
        ) {
          continue;
        }
        // filed under the class or the id that is all it asks
        if (indexed.keyOnly && !inCopy) {
          if (indexed.host !== null && !indexed.host(tree.root!.host)) {
            continue;
          }
          matched?.push(indexed.id);
          if (out === null) continue;
          const origin = rule.order < 0 ? Origin.UserAgent : Origin.Author;
          pushRule(out, rule, origin, tree.depth, tree.root);
          continue;
        }
        // naming an ancestor no ancestor of the element is: not its, with
        // no walk up the tree to say so
        if (!inCopy) {
          const needs = this._needsOf(indexed);
          if (needs.length && !hasAncestors(needs)) continue;
        }
        let match: ((el: Element) => boolean) | null;
        if (inCopy) {
          if (!indexed.inCopyCompiled) {
            indexed.inCopyCompiled = true;
            try {
              // what it finds above an element depends on which copy it is
              // in, so none of it is kept
              indexed.inCopy = compileSelector(
                rule.selector,
                this._copyAdapter,
                this._pseudos,
                false,
              );
            } catch {
              indexed.inCopy = null;
            }
          }
          match = indexed.inCopy;
        } else {
          if (!indexed.compiled) {
            indexed.compiled = true;
            try {
              indexed.match = compileSelector(
                rule.selector,
                this._adapter,
                this._pseudos,
              );
            } catch {
              // A selector this matcher does not know (`::-moz-…`, a CSS4
              // form it has not learnt) drops out of the cascade rather than
              // out of the render.
              indexed.match = null;
            }
          }
          match = indexed.match;
        }
        if (!match || !match(el)) continue;
        if (indexed.host !== null && !indexed.host(tree.root!.host)) continue;
        matched?.push(indexed.id);
        if (out === null) continue;
        const origin = rule.order < 0 ? Origin.UserAgent : Origin.Author;
        pushRule(out, rule, origin, tree.depth, tree.root);
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
    const tree = this._scoped ? this._treeInfo(el) : this._docInfo;
    if (this._scoped) this._scopedInto(el, '', out, matched);

    const hints = presentationHints(el, this.dimensionSource);
    // the page's colour schemes are its root's where no rule sets them
    if (
      this.pageColorScheme &&
      el.name === 'html' &&
      tree.root === null &&
      !(el.parent && isTag(el.parent as Element))
    ) {
      hints.push({
        prop: 'color-scheme',
        value: this.pageColorScheme,
        important: false,
      });
    }
    if (hints.length) {
      out.push({
        origin: Origin.Presentation,
        context: tree.depth,
        tree: tree.root,
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
      this._noteViewportUnits(declarations);
      if (!this._lh && usesLh(declarations)) this._lh = true;
      pushInline(out, declarations, tree.depth, tree.root);
    }

    out.sort(byCascade);
    dropPaletteChrome(out);
    return out;
  }
}

/**
 * Takes the palette's control chrome (`PALETTE_CHROME`) out of an element's
 * candidates where the page styles the control (`stylesControl`), so what
 * shows through is the web's UA values the page was written against. `out`
 * is in cascade order, so the UA's candidates are the ones before the first
 * of any other origin.
 */
function dropPaletteChrome(out: Candidate[]): void {
  let chrome = false;
  let i = 0;
  for (; i < out.length && out[i].origin === Origin.UserAgent; i += 1) {
    if (PALETTE_CHROME.has(out[i].declarations)) chrome = true;
  }
  if (!chrome || !stylesControl(out)) return;
  let kept = 0;
  for (const c of out) {
    if (c.origin === Origin.UserAgent && PALETTE_CHROME.has(c.declarations)) {
      continue;
    }
    out[kept++] = c;
  }
  out.length = kept;
}

/** The elements whose look is a control's own until the page styles it
 *  (`stylesControl`): the fields a widget is mounted for, and a button. */
const CONTROL_TAGS = new Set(['input', 'textarea', 'select', 'button']);

/**
 * Whether the page styles a control: declares one of its background or
 * border properties, a radius among them, or an `appearance` of `none`.
 * Who declared them decides, not what to: CSS UI 4 devolves a widget for
 * any of them declared in the author origin (7.2.1), and Blink
 * (`LayoutTheme::IsControlStyled`, over the author's declarations its
 * cascade applies), Gecko and WebKit all do, so `border: none; background:
 * transparent` takes the native look off as a red border does. The
 * palette's chrome goes on this answer (`dropPaletteChrome`), and the
 * document draws a field on it (`ComputedStyle.styledControl`). An
 * animation's values are not the page's declarations, and do not count.
 */
function stylesControl(candidates: readonly Candidate[]): boolean {
  // `appearance` by the value that wins: `appearance: none; appearance:
  // auto` keeps the control's look, as a reset a page takes back does
  let appearance = '';
  for (const c of candidates) {
    if (fromUserAgent(c.origin) || c.origin === Origin.Animation) {
      continue;
    }
    for (const d of pick(c)) {
      if (d.prop === 'appearance' || d.prop === '-webkit-appearance') {
        const v = d.value.trim().toLowerCase();
        if (/^[a-z-]+$/.test(v)) appearance = v;
      } else if (stylesChrome(d)) return true;
    }
  }
  return appearance === 'none';
}

/** Whether a declaration styles what a control's native look draws: Blink's
 *  `is_background` and `is_border` properties and their shorthands. An
 *  `appearance` of `none` does too, where it is the one that wins
 *  (`stylesControl`). */
function stylesChrome(d: Declaration): boolean {
  const prop = d.prop;
  if (prop.startsWith('background')) {
    return prop !== 'background-repeat' && prop !== 'background-blend-mode';
  }
  if (prop.startsWith('border')) {
    return prop !== 'border-collapse' && prop !== 'border-spacing';
  }
  return false;
}

/** The declarations that name an element's animations. */
const ANIMATION_NAMES = new Set([
  'animation',
  'animation-name',
  '-webkit-animation',
  '-webkit-animation-name',
]);

/** The shadow tree whose rule named an element's animations, by its lists
 *  (`Cascade._cascadeStyle`): where their names are looked for first. The
 *  document's are in none. */
const ANIMATION_TREES = new WeakMap<Animations, ShadowRoot>();

/** The tree an element's animations' names are looked for in first
 *  (`Cascade.keyframes`): null for the document's. */
export function animationTree(animations: Animations): ShadowRoot | null {
  return ANIMATION_TREES.get(animations) ?? null;
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
 *  fragment's top-level elements, which css-select would take for it.
 *
 *  `:focus` and its two kin are here as matching nothing, and each cascade
 *  answers them from where the focus is (`Cascade.setFocus`): no element
 *  of the document takes it itself — a control's widget does, beside it.
 *  css-select has none of the three and throws on them, which dropped
 *  every rule that named one, `:not(:focus)` among them: Wikipedia's skip
 *  link hides with `.mw-jump-link:not(:focus)`, and without it stood in
 *  the flow at the top of every page. */
const PSEUDOS = {
  root: (el: Element) =>
    el.name === 'html' && !(el.parent && isTag(el.parent as Element)),
  // the top of a shadow tree, where `:host > .x`'s `.x` is (`readHost`)
  '-rx-top': (el: Element) => el.parent instanceof ShadowRoot,
  // the host, which nothing in its tree is: a `:host` this reads in a
  // compound of its own is the host's (`readHost`), and one inside a
  // function's list, `:not(:host)`, is nothing's
  host: (_el: Element) => false,
  // a slot something is assigned to, through the slots assigned to it —
  // white space included, as a text node is assigned like any other —
  // and not its own fallback (CSS Scoping 1, 3.2.3)
  'has-slotted': (el: Element) => el.name === 'slot' && hasSlotted(el),
  focus: (_el: Element) => false,
  'focus-visible': (_el: Element) => false,
  'focus-within': (_el: Element) => false,
  // css-select has none, and threw on one, so `:not(:target)` matched
  // nothing: a document is drawn at no fragment, an SVG image at its own
  target: (_el: Element) => false,
  // css-select's, but its ranges and tags lower-cased as ASCII has it, and
  // no other script (CSS 2.1 4.1.3): Unicode's took `:lang(\u212Al)`, a
  // Kelvin sign for the K, for `:lang(kl)`
  lang: (el: Element, code: string | null): boolean => {
    const ranges = (code ?? '')
      .split(',')
      .map((range) => range.trim().replace(/^['"]|['"]$/g, ''))
      .filter((range) => range.length > 0)
      .map((range) => asciiLower(range).split('-'));
    const value = languageOf(el);
    if (!value) return ranges.some((range) => range[0] === '');
    const tag = asciiLower(value).split('-');
    return ranges.some((range) => langRangeMatches(tag, range));
  },
};

/**
 * An element's language: the `lang` or `xml:lang` of the nearest element
 * from it up that says one, or with none saying, the document's, as its
 * `<meta http-equiv="content-language">` sets it — searched from the
 * document, where a fragment's `<meta>` is a sibling of what it covers.
 * '' where none does, or the nearest says ''.
 */
export function languageOf(el: Element): string {
  let root = el;
  for (let node: Element | null = el; node;) {
    const value = node.attribs['xml:lang'] ?? node.attribs.lang;
    if (value != null) return value;
    root = node;
    const parent: Element['parent'] = node.parent;
    // the top of a shadow tree is in its host's language (HTML 3.2.6.2)
    node =
      parent instanceof ShadowRoot
        ? parent.host
        : parent && isTag(parent as Element)
          ? (parent as Element)
          : null;
  }
  return pragmaLanguage(root.parent ?? root);
}

/** A length in a unit of the viewport: a number, then the unit, and no
 *  more of a name after it. */
const VIEWPORT_UNIT = /\d[sld]?v(?:w|h|i|b|min|max)(?![\w-])/i;
const VIEWPORT_UNITS = /\d([sld]?v(?:w|h|i|b|min|max))(?![\w-])/gi;

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
    // in document order: the last one pushed is taken first; and not into
    // a <template>, whose content is no part of the document
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i] as Element;
      if (isTag(child) && !NON_RENDERED.has(child.name)) stack.push(child);
    }
  }
  PRAGMA_LANGUAGE.set(root, lang);
  return lang;
}

const PRAGMA_LANGUAGE = new WeakMap<object, string>();

/**
 * The page's supported colour schemes: the content of the first `<meta
 * name="color-scheme">` that is a `color-scheme` value (HTML 4.2.5.4), or
 * null. Looked for where a `<meta>` is, at the top of a fragment and in
 * the `<html>` and its `<head>`, and not through the body.
 */
export function metaColorScheme(root: { children: unknown[] }): string | null {
  const stack: { children: unknown[] }[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    for (const child of node.children) {
      if (!isTag(child as Element)) continue;
      const el = child as Element;
      if (el.name === 'meta') {
        const name = el.attribs.name?.trim().toLowerCase();
        const content = el.attribs.content?.trim();
        if (name === 'color-scheme' && content && usedColorScheme(content)) {
          return content;
        }
      } else if (el.name === 'html' || el.name === 'head') {
        stack.push(el);
      }
    }
  }
  return null;
}

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

/** The document's first element with an id, looked for from one of its
 *  elements: `shapeStyles`' answer where no index of them is handed in. */
function elementById(from: Element, id: string): Element | null {
  let top: Element['parent'] | Element = from;
  while (top.parent) top = top.parent;
  const stack = [...top.children].reverse();
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type !== 'tag') continue;
    const el = node as Element;
    if (el.attribs.id === id) return el;
    for (let i = el.children.length - 1; i >= 0; i -= 1) {
      stack.push(el.children[i]);
    }
  }
  return null;
}

/**
 * Whether a drawing has a `var()` in a presentation attribute of a shape's
 * properties or in a `style`, or sets a custom property in a `style` —
 * in it, or in what a `<use>` in it draws — for `shapeStyles` to read where
 * no rule reaches the drawing. Only the attributes by those names are
 * looked at: a path's `d` may be thousands of characters long, and is no
 * declaration.
 */
export function drawingVars(
  root: Element,
  byId: (id: string) => Element | null,
): boolean {
  const stack: Element[] = [root];
  let targets: Set<Element> | null = null;
  for (let el = stack.pop(); el; el = stack.pop()) {
    if (attributeVars(el)) return true;
    // the root's own custom properties are its box's already
    const style = el.attribs.style;
    if (style && (hasVar(style) || (el !== root && style.includes('--')))) {
      return true;
    }
    if (isUse(el)) {
      const id = useHref(el);
      const target = id === null ? null : byId(id);
      if (target && !(targets ??= new Set()).has(target)) {
        targets.add(target);
        stack.push(target);
      }
    }
    const children = el.children;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      if (children[i].type === 'tag') stack.push(children[i] as Element);
    }
  }
  return false;
}

/** An element's presentation attributes of a shape's properties that have
 *  a `var()` in them, as declarations to substitute, or null for none. One
 *  whose `var()` is no `var()` is invalid as it is parsed, and left out as
 *  an invalid declaration is. Kept by the element, whose attributes do not
 *  change. */
function attributeVars(el: Element): Declaration[] | null {
  let found = ATTRIBUTE_VARS.get(el);
  if (found !== undefined) return found;
  found = null;
  const attribs = el.attribs;
  for (const name in attribs) {
    if (!isShapeProp(name) || !hasVar(attribs[name])) continue;
    for (const d of parseDeclarations(`${name}:${attribs[name]}`)) {
      if (d.prop === name && d.vars && !d.important) (found ??= []).push(d);
    }
  }
  ATTRIBUTE_VARS.set(el, found);
  return found;
}
const ATTRIBUTE_VARS = new WeakMap<Element, Declaration[] | null>();

/** The custom properties an element's `style` sets, in order, or null for
 *  none. */
function ownCustoms(el: Element): Map<string, string> | null {
  const style = el.attribs.style;
  if (!style || !style.includes('--')) return null;
  let out: Map<string, string> | null = null;
  for (const d of parseDeclarations(style)) {
    if (d.custom) (out ??= new Map()).set(d.prop, d.value);
  }
  return out;
}

/** Whether declarations set a property a shape in a drawing has. */
function declaresShape(declarations: readonly Declaration[]): boolean {
  for (const d of declarations) if (isShapeProp(d.prop)) return true;
  return false;
}

/** Whether declarations set one a drawing's root does not have from its
 *  box's style (`ROOT_BOX_PROPS`). */
function declaresRootShape(declarations: readonly Declaration[]): boolean {
  for (const d of declarations) {
    if (isShapeProp(d.prop) && !ROOT_BOX_PROPS.has(d.prop)) return true;
  }
  return false;
}

/** A `style` attribute's declarations of a shape's properties, as
 *  candidates: over every rule, and its `!important` ones over theirs —
 *  of the tree `context` deep, the drawing's. */
function pushInlineShapes(
  out: Candidate[],
  inline: string,
  context: number,
  tree: ShadowRoot | null,
): void {
  const declarations = parseDeclarations(inline).filter((d) =>
    isShapeProp(d.prop),
  );
  pushInline(out, declarations, context, tree);
}

/** A `style` attribute's declarations as candidates, element-attached
 *  (CSS Cascade 5, 6.1): over every rule of its tree, and its
 *  `!important` ones over theirs. */
function pushInline(
  out: Candidate[],
  declarations: Declaration[],
  context: number,
  tree: ShadowRoot | null,
): void {
  const normal = declarations.filter((d) => !d.important);
  const important = declarations.filter((d) => d.important);
  if (normal.length) {
    out.push({
      origin: Origin.Inline,
      context,
      tree,
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
      context,
      tree,
      layer: null,
      specificity: 0,
      order: 0,
      declarations: important,
      only: -1,
    });
  }
}

function pick(c: Candidate): Declaration[] {
  return c.only < 0 ? c.declarations : [c.declarations[c.only]];
}

/** Candidates in cascade order with what an element's animations leave
 *  among them: after every normal declaration and before the first
 *  `!important` one, a later animation after an earlier. */
function withAnimations(
  candidates: readonly Candidate[],
  frames: readonly Declaration[][],
): Candidate[] {
  let at = 0;
  while (at < candidates.length && candidates[at].origin < Origin.Animation) {
    at += 1;
  }
  return [
    ...candidates.slice(0, at),
    ...frames.map((declarations, order) => ({
      origin: Origin.Animation,
      context: 0,
      tree: null,
      layer: null,
      specificity: 0,
      order,
      declarations,
      only: -1,
    })),
    ...candidates.slice(at),
  ];
}

/** A rule's declarations as candidates, for an element of the tree
 *  `context` deep — the rule's tree, `tree` — at its origin, and its
 *  `!important` ones at theirs. */
function pushRule(
  out: Candidate[],
  rule: StyleRule,
  origin: Origin,
  context = 0,
  tree: ShadowRoot | null = null,
): void {
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
      context,
      tree,
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
          ? Origin.UserAgentImportant
          : Origin.AuthorImportant
        : origin,
      context,
      tree,
      layer: rule.layer,
      specificity: rule.specificity,
      order: rule.order,
      declarations: rule.declarations,
      only: i,
    });
  }
}

/**
 * Cascade order, the last declaration winning: by origin and importance,
 * then — between two of the same — by context, an outer tree's normal
 * declaration over an inner one's and an inner tree's `!important` one over
 * an outer one's (CSS Cascade 5, 6.1): a page's `my-card { color }` over
 * the card's own `:host { color }`, whatever their specificity, and its
 * `::part()` rules over the part's own tree's rules and its `style`. Then a
 * `style` attribute over its tree's rules; then layers, specificity and
 * order. The presentational hints are under every author rule, whatever
 * its tree — a host's `align` under its tree's `:host { text-align }`, as
 * Chrome has it. In a document with no shadow tree every context is 0, and
 * the order is the one by origin.
 */
function byCascade(a: Candidate, b: Candidate): number {
  if (a.origin !== b.origin) {
    const by = IMPORTANCE[a.origin] - IMPORTANCE[b.origin];
    if (by !== 0) return by;
  }
  if (a.context !== b.context) {
    return a.origin >= Origin.AuthorImportant
      ? a.context - b.context
      : b.context - a.context;
  }
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

/** Each origin's place by origin and importance alone: the user agent's;
 *  the presentational hints; the author's normal declarations, `style`
 *  attributes among them; the animations'; the author's `!important`; the
 *  user agent's `!important`. One for each `Origin`, in its order. */
const IMPORTANCE: readonly number[] = [0, 1, 2, 2, 3, 4, 4, 5];

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
function presentationHints(
  el: Element,
  dimensionSource: ((img: Element) => Element) | null = null,
): Declaration[] {
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
  if (
    SIZED.has(tag) ||
    // an image button's are its image's, as an `<img>`'s are (HTML 15.4.3)
    (tag === 'input' &&
      (attr(el, 'type') ?? '').trim().toLowerCase() === 'image')
  ) {
    const width = attr(el, 'width');
    const height = attr(el, 'height');
    // an `<img>` whose `<picture>` chose a `<source>` with a `width` or a
    // `height` is sized by that source's (HTML 15.4.3, its "dimension
    // attribute source"): an art-directed picture reserves another shape
    // at each breakpoint
    const source = tag === 'img' && dimensionSource ? dimensionSource(el) : el;
    if (source === el) {
      if (width) push('width', lengthAttr(width));
      if (height) push('height', lengthAttr(height));
      // and, both numbers, an image's the ratio it has before it loads, or
      // where it has none of its own (HTML 15.4.3, "map to the
      // aspect-ratio property")
      if (RATIO_SIZED.has(tag)) ratioHint(width, height, push);
    } else {
      // The source's in place of the image's own, which stay where the
      // source's are there and do not parse — a `width="abc"` leaves the
      // image's, and so does a `width="50%"` its ratio — and go where the
      // source has none: a source with a `width` alone leaves the height to
      // the image's ratio. Chrome, Firefox and Safari all map them so,
      // each the image's own and then the source's over them, which is why
      // an invalid one here is followed by nothing that drops it.
      const w = attr(source, 'width');
      const h = attr(source, 'height');
      if (w !== undefined) {
        if (width) push('width', lengthAttr(width));
        if (w) push('width', lengthAttr(w));
      }
      if (h !== undefined) {
        if (height) push('height', lengthAttr(height));
        if (h) push('height', lengthAttr(h));
      }
      if (w !== undefined && h !== undefined) {
        ratioHint(width, height, push);
        ratioHint(w, h, push);
      }
    }
  } else if (tag === 'svg') {
    // an SVG's are CSS lengths of their own, units and all (SVG 2, 5.1.1)
    const width = attr(el, 'width');
    const w = width ? svgSizeHint(width) : null;
    if (w) push('width', w);
    const height = attr(el, 'height');
    const h = height ? svgSizeHint(height) : null;
    if (h) push('height', h);
    // and its paint is its `fill` and `stroke` properties' (13.2), which a
    // rule of the document's then sets over the attribute
    // — a `var()` in either among it, which the cascade substitutes as it
    // does one in a rule
    for (const prop of ['fill', 'stroke']) {
      const value = attr(el, prop);
      if (!value) continue;
      if (!hasVar(value)) push(prop, value);
      else if (validVars(value)) {
        out.push({ prop, value, important: false, vars: true });
      }
    }
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

/** What the `width` and `height` attributes give a ratio as well. */
const RATIO_SIZED = new Set(['img', 'video']);

/** The `aspect-ratio` a `width` and a `height` attribute map to, where both
 *  are numbers and neither a percentage. */
function ratioHint(
  width: string | undefined,
  height: string | undefined,
  push: (prop: string, value: string) => void,
): void {
  if (!width || !height) return;
  const w = parseFloat(width);
  const h = parseFloat(height);
  if (w > 0 && h > 0 && !/%/.test(width + height)) {
    push('aspect-ratio', `auto ${w} / ${h}`);
  }
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

/** A number and a unit, as an SVG's `width` and `height` are written. */
const SVG_LENGTH =
  /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i;

/**
 * The `width`/`height` of an inline `<svg>` as CSS: they are presentation
 * attributes for the properties of the same names (SVG 2, 5.1.1), so
 * `height="50%"` is a percentage of the containing block like a style's.
 * A bare number is pixels; null for what CSS would not parse.
 */
function svgSizeHint(value: string): string | null {
  const v = value.trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%$/i.test(v)) return v;
  const m = SVG_LENGTH.exec(v);
  if (!m) return null;
  return m[2] ? v : `${parseFloat(m[1])}px`;
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

/** Whether an element is the document's root: its parent the document, or
 *  none, as the `<html>` the cascade supplies where the markup has none. */
function isRootElement(el: Element): boolean {
  return !el.parent || el.parent.type === 'root';
}

/** The styles of root elements whose `overflow` went to the viewport other
 *  than `visible` (`propagateOverflow`). */
const VIEWPORT_OVERFLOW = new WeakSet<ComputedStyle>();

/**
 * The root element's `overflow` is the viewport's, and so is the first
 * `<body>`'s where the root's is `visible` — and the element it went to the
 * viewport from has a used `overflow` of `visible` (CSS Overflow 3, 3.3).
 * The viewport here is the element, as tall as the document, which a host
 * scrolls. Kept on the `<html>`, bun.sh's `html { height: 100%;
 * overflow-y: scroll }` made it a box a window tall that held the page in
 * it, and the document came out a window tall, with everything below cut
 * off; kept on a `<body>`, an `overflow: hidden` made it a formatting
 * context, which a first child's margin did not collapse through and which
 * grew to hold a float. Containment on either element keeps the body's to
 * the body (CSS Containment 2, 3), and a body that makes no box has none to
 * give.
 *
 * The root's is `visible` afterwards whatever it was, so whether it went
 * is kept beside its style (`VIEWPORT_OVERFLOW`): the body's goes only
 * where the root's did not.
 */
function propagateOverflow(
  el: Element,
  style: ComputedStyle,
  parentStyle: ComputedStyle,
): void {
  const tag = tagOf(el);
  if (tag === 'html') {
    if (!isRootElement(el)) return;
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      VIEWPORT_OVERFLOW.add(style);
    }
  } else if (tag === 'body') {
    // the root `<html>`'s, or one written with none, in the `<html>` the
    // cascade supplies
    const parent = el.parent;
    if (
      parent &&
      parent.type !== 'root' &&
      !(
        isRootElement(parent as Element) &&
        tagOf(parent) === 'html' &&
        firstBody(parent as Element) === el
      )
    ) {
      return;
    }
    if (VIEWPORT_OVERFLOW.has(parentStyle)) return;
    if (style.contain || parentStyle.contain) return;
    if (style.display === 'none' || style.display === 'contents') return;
  } else {
    return;
  }
  style.overflowX = 'visible';
  style.overflowY = 'visible';
}

function firstBody(html: Element): Element | null {
  for (const child of html.children) {
    if (child.type === 'tag' && tagOf(child) === 'body') {
      return child as Element;
    }
  }
  return null;
}

/** What the animations that fill forwards make of an element at rest, as
 *  `will-change` naming what they set would: each is in effect for good
 *  (Web Animations 1, 5.6; `animatedWillChange`). */
function restingWillChange(
  animations: ComputedStyle['animations'],
  keyframesOf: (name: string) => KeyframesRule | null,
): number {
  let bits = 0;
  const { names, fillModes } = animations;
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (name === null) continue;
    const fill = fillModes[i % fillModes.length];
    if (fill !== 'forwards' && fill !== 'both') continue;
    const rule = keyframesOf(name);
    if (rule) bits |= animatedWillChange(rule);
  }
  return bits;
}
