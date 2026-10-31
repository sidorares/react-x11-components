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
import type { AnyNode, Element } from 'domhandler';

import {
  NON_RENDERED,
  ShadowRoot,
  assignedSlot,
  attr,
  flatParentOf,
  isDefinedElement,
  isElement,
  isInputButton,
  inActiveTransition,
  isModal,
  isFullscreen,
  isDropDown,
  isPickerOpen,
  isPopoverOpen,
  isMuted,
  hasMediaFlag,
  isPaused,
  mutationGeneration,
  shadowRootAround,
  shadowRootOf,
  tagOf,
  treeGeneration,
  treesChanged,
} from '../dom.js';
import {
  BLOCK_AXIS,
  INLINE_AXIS,
  NO_SCROLL_STATES,
  containerHolds,
} from './containers.js';
import type {
  ContainerQuery,
  ContainerSize,
  ScrollStates,
} from './containers.js';
import {
  LIGHT_DARK,
  lightDark,
  systemColorTable,
  usedColorScheme,
} from './color.js';
import {
  asciiLower,
  escapeEnd,
  mediaMatches,
  parseMediaQuery,
  readIdent,
  specificityOf,
  startsIdent,
  supportsCondition,
} from './parse.js';
import type { MediaCondition, SheetSource } from './parse.js';
import type {
  Declaration,
  FunctionRule,
  KeyframesRule,
  StyleRule,
  Stylesheet,
} from './parse.js';
import { matchesSyntax } from './syntax.js';
import { readsAnchor } from './anchor.js';
import { computedText } from '../computed.js';
import {
  NO_ANIMATIONS,
  restingFrames,
  spanAt,
  steepest as steepestOf,
  tracksOf,
} from './animation.js';
import type { Animations } from './animation.js';
import type { Keyframe } from './parse.js';
import {
  discrete,
  interpolateField,
  keywordSizes,
  visibleSpan,
} from './interpolate.js';
import type { AnimationTimeline, Sample } from './timeline.js';
import {
  animatedWillChange,
  fieldsAnimatedBy,
  noteAnimated,
} from './timeline.js';
import { sampleScripts } from './scripted.js';
import type { ScriptAnimations } from './scripted.js';
import {
  animatedFields,
  applyDeclaration,
  blockify,
  settleAlign,
  settleButton,
  settleContainer,
  settleContentVisibility,
  settleOverflow,
  settleOutline,
  settleClamp,
  copyStyle,
  decorate,
  familyList,
  inherit,
  zoomedBy,
  initialOne,
  initialStyle,
  isInherited,
  sameStyle,
} from './style.js';
import type { BoxShadow, ComputedStyle, RootLook } from './style.js';
import type { FontFamilies } from '../fonts.js';
import { parseDeclarations } from './parse.js';
import { CounterStyles, counterStyleRule } from './counter-styles.js';
import type { CounterStyleRule } from './counter-styles.js';
import { PALETTE_CHROME } from './ua.js';
import type { UnitContext } from './values.js';
import {
  FIXED_SIZE,
  keywordFontSize,
  parseColor,
  parseLength,
} from './values.js';
import {
  CustomProps,
  customProperties,
  hasInherit,
  hasVar,
  substitute,
  substituteIn,
  validVars,
} from './vars.js';
import type { IfEnvironment, Registration } from './vars.js';
import {
  ROOT_BOX_PROPS,
  SHAPE_TAGS,
  isShapeProp,
  isUse,
  shapeFont,
  shapeValue,
  urlIds,
  useHref,
} from './shapes.js';
import type {
  DrawingUnits,
  ShapeContext,
  ShapeStyle,
  ShapeStyles,
} from './shapes.js';

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

/** A rule that matches an element, as `Cascade.matchedRules` lists it. */
export interface MatchedRule {
  /** As written, or null for the element's own `style` and for HTML's
   *  presentational hints. */
  selector: string | null;
  origin: 'inline' | 'author' | 'presentation' | 'user-agent';
  /** Its ids, classes and types. */
  specificity: [number, number, number];
  /** The media it is under, in words, or null for none. */
  media: string | null;
  declarations: { property: string; value: string; important: boolean }[];
  /** Where it was written, or null for what no sheet holds: the element's
   *  own `style`, HTML's presentational hints and the user agent's rules. */
  source: RuleSource | null;
}

/** Where a rule was written. A list of selectors is a rule each, so this is
 *  where the one that matched starts: `.b` in `.a, .b { … }`. */
export interface RuleSource {
  sheet: SheetSource;
  /** The selector's offset in `sheet.text`. */
  offset: number;
  /** The line and the column of that offset, each counted from 1 as an
   *  editor counts them. */
  line: number;
  column: number;
}

/** Where each line of a sheet's text starts, made once a rule of it is
 *  placed, and only for a sheet a developer's tools read. */
const LINE_STARTS = new WeakMap<SheetSource, readonly number[]>();

/** Where a rule stands in its sheet's text. */
function ruleSource(sheet: SheetSource, offset: number): RuleSource {
  let starts = LINE_STARTS.get(sheet);
  if (!starts) {
    const found = [0];
    const { text } = sheet;
    for (
      let at = text.indexOf('\n');
      at >= 0;
      at = text.indexOf('\n', at + 1)
    ) {
      found.push(at + 1);
    }
    LINE_STARTS.set(sheet, (starts = found));
  }
  let lo = 0;
  let hi = starts.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid;
  }
  return { sheet, offset, line: lo + 1, column: offset - starts[lo] + 1 };
}

/** A rule's media, as a developer's tools print them: each block's
 *  conditions joined by `and`, the blocks by `and`, a block's list by
 *  `,`. What a condition does not keep in words is said as `(…)`. */
function mediaText(media: readonly (readonly MediaCondition[])[]): string {
  const one = (c: MediaCondition): string => {
    const parts: string[] = [];
    if (c.min !== undefined) parts.push(`(min-width: ${c.min}px)`);
    if (c.max !== undefined) parts.push(`(max-width: ${c.max}px)`);
    if (c.minHeight !== undefined) parts.push(`(min-height: ${c.minHeight}px)`);
    if (c.maxHeight !== undefined) parts.push(`(max-height: ${c.maxHeight}px)`);
    if (c.minResolution !== undefined)
      parts.push(`(min-resolution: ${c.minResolution}dppx)`);
    if (c.maxResolution !== undefined)
      parts.push(`(max-resolution: ${c.maxResolution}dppx)`);
    if (c.scheme) parts.push(`(prefers-color-scheme: ${c.scheme})`);
    if (c.motion) parts.push(`(prefers-reduced-motion: ${c.motion})`);
    if (c.scripting) parts.push(`(scripting: ${c.scripting})`);
    return parts.join(' and ') || '(…)';
  };
  return media.map((block) => block.map(one).join(', ')).join(' and ');
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
  /**
   * Whether `restyle` names the elements a change reached and nothing under
   * them (`Cascade.crossed`): an element under one is styled again only
   * where its parent's style came out other than it was, which is all its
   * own is computed from beside the rules — so a band that changes a
   * page's grid at its top styles the grid's children again and keeps
   * their children's. Without it, `restyle` holds everything it reaches.
   */
  follow?: boolean;
  /** The root box's style in the build the styles were kept from: the
   *  parent of an element with no element above it — `<html>`, or the top
   *  of a fragment — for `follow`. */
  root?: ComputedStyle;
}

/** Whether a container query finds in two styles of one element what it
 *  finds (`Cascade._containerFor`): its type, the names it goes by, and
 *  whether it is an inline box, which takes no size containment. */
function sameContainer(a: ComputedStyle, b: ComputedStyle): boolean {
  return (
    a.containerType === b.containerType &&
    a.containerName === b.containerName &&
    a.scrollStateContainer === b.scrollStateContainer &&
    a.anchoredContainer === b.anchoredContainer &&
    (a.containerType === 'normal' ||
      (a.display === 'inline') === (b.display === 'inline'))
  );
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
  /** Its `@position-try` rules' declarations, the last of each name. */
  positionTries: Map<string, Declaration[]>;
}

function newTreeRules(id: number): TreeRules {
  return {
    id,
    host: [],
    slotted: [],
    parts: [],
    keyframes: new Map(),
    positionTries: new Map(),
  };
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
 *  (`Cascade.hoverTouches`): nothing; the element alone, and what is in it
 *  only through what it inherits (`HOVER_SELF`); the element and what is in
 *  it; those and the siblings after it; or those through a rule at a
 *  shadow tree's edge, which no restyle in place can answer
 *  (`StateRules.edge`). Each reaches more than the one before. */
export type HoverTouch = 0 | 1 | 2 | 3 | 4;
export const HOVER_UNTOUCHED = 0;
export const HOVER_SELF = 1;
export const HOVER_TOUCHED = 2;
export const HOVER_FOLLOWED = 3;
export const HOVER_EDGE = 4;

/**
 * The elements under one whose state changed that a compound leading below
 * reaches (`PointerCompounds.below`): those `match` names, among its
 * children where `child`, and anywhere under it otherwise. One `match` a
 * subject, so that a walk under an ancestor can be seen to cover a walk
 * under an element in it.
 */
export interface BelowReach {
  readonly match: (el: Element) => boolean;
  readonly child: boolean;
}

/** The sides of the viewport a style reads (`Cascade.viewportReaders`). */
export const VIEWPORT_WIDTH = 1;
export const VIEWPORT_HEIGHT = 2;
/** What sides of the viewport each style holds a length of, by the style:
 *  a style is shared by every element alike in what it is computed from. */
const VIEWPORT_SIDES = new WeakMap<ComputedStyle, number>();

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

/** What a length in a container's units asks of the containers above
 *  an element: the nearest that has the axis, by no name (`_containerUnit`).
 *  Its answer is a size, which these are told apart by. */
const CQ_INLINE: ContainerQuery = {
  name: null,
  condition: '',
  axes: INLINE_AXIS,
};
const CQ_BLOCK: ContainerQuery = {
  name: null,
  condition: '',
  axes: BLOCK_AXIS,
};
/** The axis each read of a container unit's basis is of: `CQ_INLINE`'s and
 *  `CQ_BLOCK`'s, and those of a query's lengths (`_queryUnitKey`), whose
 *  answer is a size as theirs is. */
const UNIT_AXIS = new WeakMap<ContainerQuery, 'inline' | 'block'>([
  [CQ_INLINE, 'inline'],
  [CQ_BLOCK, 'block'],
]);

/** What a style reads of the root element's: a `rem` its font size, an
 *  `rlh` its line height (`Cascade.rootReaders`). */
export const ROOT_FONT_SIZE = 1;
export const ROOT_LINE_HEIGHT = 2;
/** What each style read of the root's, by the style, as `VIEWPORT_SIDES`. */
const ROOT_READS = new WeakMap<ComputedStyle, number>();

/**
 * The styles that hold a length read from a face: an `ex`, a `ch`, an `lh`
 * of a `normal` line height. What a face that arrives changes in a style is
 * its family list, which a style can take where it is
 * (`HtmlViewNode._takeFaces`); these come out otherwise, and are computed
 * again. Noted by the style, since a style is shared, as `ROOT_READS` is.
 */
const FACE_READS = new WeakSet<ComputedStyle>();

/** Whether a length in a style was read from a face (`FACE_READS`). */
export function readsFace(style: ComputedStyle): boolean {
  return FACE_READS.has(style);
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
  /[+~]|:(?:first|last|only)-(?:child|of-type)|:nth-|:empty|:blank|:has\(|:has-slotted|:focus-within|:target|:scope|:(?:checked|selected|disabled|enabled|parent|defined|modal)\b|:i?contains\(/;

/**
 * Rules bucketed by the key of their rightmost compound selector. An element
 * only ever tries `id`, its classes, its tag and the universal bucket.
 */
class RuleIndex {
  readonly byId = new Map<string, IndexedRule[]>();
  readonly byClass = new Map<string, IndexedRule[]>();
  readonly byTag = new Map<string, IndexedRule[]>();
  /** By the attribute their subject has to have, lower-cased. */
  readonly byAttr = new Map<string, IndexedRule[]>();
  /** Those whose subject is `:root`: asked of an element with no element
   *  above it. */
  readonly rootRules: IndexedRule[] = [];
  readonly universal: IndexedRule[] = [];
  /** Whether any rule in here is pointer-sensitive, so the renderer knows
   *  whether a pointer move can change the cascade at all. */
  hoverSensitive = false;
  /** …and focus-sensitive, for a widget taking the focus or giving it up. */
  focusSensitive = false;
  /** …and whether one tests `:target`, for the document's URL taking
   *  another fragment (`Cascade.setTarget`). */
  targetSensitive = false;
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
  readonly ownStyleAttrs = new Set<string>();
  ownStyleRoot = false;
  ownStyleEverywhere = false;
  /** How many rules are in here, so an empty index costs one comparison. */
  size = 0;
  /** The rules under a media query, which a width can turn on or off
   *  (`Cascade.crossed`). */
  readonly withMedia: IndexedRule[] = [];
  private _nextId = 0;

  /** `self`: whether the index is a pseudo-element's, whose element is
   *  one of the containers its `@container` rules may ask — a `::before`
   *  asks the element it is in (CSS Conditional 5, 3.1). */
  constructor(readonly self = false) {}

  /** Every rule filed here, bucket by bucket. */
  *all(): IterableIterator<IndexedRule> {
    for (const map of [this.byId, this.byClass, this.byTag, this.byAttr]) {
      for (const bucket of map.values()) yield* bucket;
    }
    yield* this.rootRules;
    yield* this.universal;
  }

  /** A rule of another index, filed here under its key as it is. */
  adopt(indexed: IndexedRule): void {
    this.size += 1;
    this._bucket(rightmostKey(indexed.rule.selector)).push(indexed);
  }

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

  /** Whether a bucket here is for `el`'s id, a class of its, an attribute
   *  it has, or `:root` where nothing is above it. */
  names(el: Element): boolean {
    if (this.byAttr.size && this.attrs(el)) return true;
    if (this.rootRules.length && !elementParent(el)) return true;
    if (this.byId.size) {
      const id = attr(el, 'id');
      if (id && this.byId.has(id)) return true;
    }
    if (this.byClass.size) {
      const className = attr(el, 'class');
      if (className) {
        for (const name of className.split(CLASS_SPACE)) {
          if (name && this.byClass.has(name)) return true;
        }
      }
    }
    return false;
  }

  /** Whether a bucket here is for an attribute `el` has. */
  attrs(el: Element): boolean {
    const attribs = el.attribs;
    for (const name in attribs) {
      if (this.byAttr.has(name)) return true;
      const lower = name.toLowerCase();
      if (lower !== name && this.byAttr.has(lower)) return true;
    }
    return false;
  }

  add(
    rule: StyleRule,
    key = rightmostKey(rule.selector),
    scope = 0,
    host: ((host: Element) => boolean) | null = null,
  ): IndexedRule {
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
    if (TARGET_PSEUDO.test(rule.selector)) this.targetSensitive = true;
    // and one under `@container`, whose answer is the container's an
    // element finds above it, which no sharing key says
    if (UNSHAREABLE.test(rule.selector) || rule.containers) {
      if (key.kind === 'id') this.ownStyleIds.add(key.name);
      else if (key.kind === 'class') this.ownStyleClasses.add(key.name);
      else if (key.kind === 'tag') this.ownStyleTags.add(key.name);
      else if (key.kind === 'attr') this.ownStyleAttrs.add(key.name);
      else if (key.kind === 'root') this.ownStyleRoot = true;
      else this.ownStyleEverywhere = true;
    }
    this._bucket(key).push(indexed);
    if (rule.media) this.withMedia.push(indexed);
    if (focus || HOVER.test(rule.selector)) {
      this.pointer ??= new RuleIndex(this.self);
      this.pointer.size += 1;
      this.pointer._bucket(key).push(indexed);
    }
    return indexed;
  }

  private _bucket(key: SelectorKey): IndexedRule[] {
    return key.kind === 'id'
      ? mapBucket(this.byId, key.name)
      : key.kind === 'class'
        ? mapBucket(this.byClass, key.name)
        : key.kind === 'tag'
          ? mapBucket(this.byTag, key.name)
          : key.kind === 'attr'
            ? mapBucket(this.byAttr, key.name)
            : key.kind === 'root'
              ? this.rootRules
              : this.universal;
  }
}

/** Both bars, hidden by nothing (`scrollbarHidden`). */
const SHOWN = { x: false, y: false };

/** The pseudo-elements a rule can style here. */
type PseudoElement =
  | 'before'
  | 'after'
  | 'first-letter'
  | 'first-line'
  | 'marker'
  | 'selection'
  | 'placeholder'
  | 'scrollbar'
  | 'backdrop'
  | 'details-content';

/** A selector's trailing `::before`, `::after`, `::first-letter`,
 *  `::first-line`, `::marker`, `::selection`, `::placeholder`,
 *  `::backdrop`, `::target-text` or a `::highlight()`, or CSS 2's
 *  single-colon spelling of any of its first four. `::-webkit-input-
 *  placeholder` is `::placeholder` under the name WebKit gave it, which
 *  Chrome and Safari still take, and pages written before the standard
 *  name still use. */
const PSEUDO_ELEMENT =
  /::?(before|after|first-letter|first-line)$|::(marker|selection|placeholder|backdrop|details-content|target-text|spelling-error|grammar-error|-webkit-input-placeholder|-webkit-scrollbar)$|::highlight\(\s*((?:\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^\n\r\f]|[^\s()\\])+)\s*\)$/i;

/**
 * The name `::target-text`'s rules are kept under among the custom
 * highlights' (`Cascade.highlightStyle`): the text a URL's text directive
 * matched (`text-fragments.ts`) is a highlight like any other, with a look
 * the UA sheet gives it, and painted above them (CSS Pseudo 4, 3.5). No
 * `::highlight()` can name it, since no identifier starts with a space.
 */
export const TARGET_TEXT = ' target-text';

/** The names `::spelling-error`'s and `::grammar-error`'s rules are kept
 *  under, as `TARGET_TEXT` is: nothing here checks a spelling, so they
 *  paint nothing, and `getComputedStyle` reads them all the same. */
const SPELLING_ERROR = ' spelling-error';
const GRAMMAR_ERROR = ' grammar-error';
/** And the one `highlightPseudoStyle` asks for `::selection`'s, whose
 *  rules are indexed with the other pseudo-elements'. */
const SELECTION = ' selection';

/**
 * The key a highlight pseudo-element's rules are kept under, from its name
 * as `getComputedStyle` hands it over without its colons: `selection`,
 * `target-text`, `spelling-error`, `grammar-error`, or `highlight(name)`
 * with the custom highlight's name unescaped. Null for any other.
 */
export function highlightKey(pseudo: string): string | null {
  switch (pseudo) {
    case 'selection':
      return SELECTION;
    case 'target-text':
      return TARGET_TEXT;
    case 'spelling-error':
      return SPELLING_ERROR;
    case 'grammar-error':
      return GRAMMAR_ERROR;
  }
  const m = /^highlight\(([\s\S]+)\)$/.exec(pseudo);
  return m ? m[1] : null;
}

/** A highlight pseudo-element's style as `getComputedStyle` reads it
 *  (`Cascade.highlightPseudoStyle`), and whether its `color` is
 *  `currentColor`, the originating element's, which a descendant's that
 *  inherits it is its own originating element's. */
export interface HighlightPseudoStyle {
  style: ComputedStyle;
  currentColor: boolean;
}

/** What each property a highlight pseudo-element takes sets of its
 *  computed style (CSS Pseudo 4, 3.2): the rest are its originating
 *  element's. */
const HIGHLIGHT_FIELDS: Record<string, readonly HighlightField[]> = {
  color: ['color'],
  'background-color': ['backgroundColor', 'backgroundColorSource'],
  background: ['backgroundColor', 'backgroundColorSource'],
  'text-decoration': [
    'textDecorationLine',
    'textDecorationColor',
    'textDecorationStyle',
    'textDecorationThickness',
  ],
  'text-decoration-line': ['textDecorationLine'],
  'text-decoration-color': ['textDecorationColor'],
  'text-decoration-style': ['textDecorationStyle'],
  'text-decoration-thickness': ['textDecorationThickness'],
  'text-underline-offset': ['textUnderlineOffset'],
  'text-shadow': ['textShadow'],
  fill: ['fill'],
  stroke: ['stroke'],
  'stroke-width': ['strokeWidth'],
};
type HighlightField =
  | 'color'
  | 'backgroundColor'
  | 'backgroundColorSource'
  | 'textDecorationLine'
  | 'textDecorationColor'
  | 'textDecorationStyle'
  | 'textDecorationThickness'
  | 'textUnderlineOffset'
  | 'textShadow'
  | 'fill'
  | 'stroke'
  | 'strokeWidth';
const HIGHLIGHT_FIELD_LIST: readonly HighlightField[] = [
  ...new Set(Object.values(HIGHLIGHT_FIELDS).flat()),
];

/**
 * What a `::selection` makes of the text it covers (CSS Pseudo 4, 3.2): the
 * colour the text is drawn in, null for its own, and the band under it,
 * null for none.
 */
export interface SelectionStyle {
  color: string | null;
  background: string | null;
  /** A custom highlight's own `text-decoration`, as a style whose
   *  `underline` and `lineThrough` are its lines and nothing it inherits:
   *  drawn over the text it lights (`paintHighlightRules`). Null or absent
   *  for none. */
  decoration?: ComputedStyle | null;
  /** A custom highlight's own `text-shadow`, with the colour a shadow in
   *  `currentColor` takes: cast from the text it lights
   *  (`paintHighlightShadows`). Null or absent for none. */
  shadow?: { shadows: BoxShadow[]; color: string } | null;
}

/** The properties of a highlight's `text-decoration`, which it draws over
 *  the text it lights (CSS Pseudo 4, 3.6). */
const DECORATION_PROPS = new Set([
  'text-decoration',
  'text-decoration-line',
  'text-decoration-color',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-underline-offset',
]);

/**
 * A rule for a pseudo-element, as the pseudo-element it styles and a rule
 * for the element it hangs off, which is what gets matched. The specificity
 * is the whole selector's, the pseudo-element counted in. `p::before`
 * matches `p`; `p ::before` and `p > ::before` have nothing left of their
 * last compound and match any child, `p *` and `p > *`.
 */
function splitPseudoElement(rule: StyleRule): {
  which: PseudoElement | 'highlight';
  rule: StyleRule;
  name?: string;
} | null {
  const m = PSEUDO_ELEMENT.exec(rule.selector);
  if (!m) return null;
  const head = rule.selector.slice(0, m.index);
  const trimmed = head.trimEnd();
  const selector = !trimmed
    ? '*'
    : head !== trimmed || /[>+~]$/.test(trimmed)
      ? `${trimmed} *`
      : trimmed;
  // a custom highlight's, by its name, which is case-sensitive and may be
  // written with escapes: `::highlight(multi\ word)` is `multi word`'s
  if (m[3] !== undefined) {
    const ident = startsIdent(m[3], 0) ? readIdent(m[3], 0) : null;
    if (!ident || ident.end !== m[3].length) return null;
    return {
      which: 'highlight',
      rule: { ...rule, selector },
      name: ident.value,
    };
  }
  const name = (m[1] ?? m[2]).toLowerCase();
  if (
    name === 'target-text' ||
    name === 'spelling-error' ||
    name === 'grammar-error'
  ) {
    return {
      which: 'highlight',
      rule: { ...rule, selector },
      name: ` ${name}`,
    };
  }
  return {
    which: (name === '-webkit-input-placeholder'
      ? 'placeholder'
      : name === '-webkit-scrollbar'
        ? 'scrollbar'
        : name) as PseudoElement,
    rule: { ...rule, selector },
  };
}

/**
 * Which of a view transition's pseudo-elements a rule styles (CSS View
 * Transitions 1, 3.2): the tree's root, a group, an image pair, an old or
 * a new image — the name its argument names, `*` for any, the classes it
 * asks the element to have had, and whether it asks to be the only child
 * of its parent (`:only-child`, the one pseudo-class it may take).
 */
export interface TransitionPart {
  part: 'view-transition' | 'group' | 'image-pair' | 'old' | 'new';
  name: string;
  classes: readonly string[];
  onlyChild: boolean;
}

const TRANSITION_PART =
  /::view-transition(?:-(group|image-pair|old|new)\(\s*([^()]*?)\s*\))?(:only-child)?$/i;

/** What each rule for a view transition's pseudo-element styles, by the
 *  rule for its originating element (`splitTransitionPart`). */
const TRANSITION_PARTS = new WeakMap<StyleRule, TransitionPart>();

/**
 * A rule for a view transition's pseudo-element, as the part it styles and
 * a rule for its originating element, which is what gets matched — `*`
 * where the selector names none. A name or a class in its argument makes
 * it as specific as a type selector, and `*` alone as no selector at all
 * (CSS View Transitions 1, 3.2; 2, 3.2). Null for a rule for none, or one
 * whose argument is no name or class list.
 */
function splitTransitionPart(
  rule: StyleRule,
): { rule: StyleRule; part: TransitionPart } | null {
  const m = TRANSITION_PART.exec(rule.selector);
  if (!m) return null;
  const head = rule.selector.slice(0, m.index).trimEnd();
  const selector = !head ? '*' : /[>+~]$/.test(head) ? `${head} *` : head;
  let name = '*';
  const classes: string[] = [];
  let typed = true;
  if (m[1]) {
    const arg = m[2];
    let i = 0;
    if (arg[0] === '*') i = 1;
    else if (arg[0] !== '.') {
      if (!startsIdent(arg, 0)) return null;
      const ident = readIdent(arg, 0);
      name = ident.value;
      i = ident.end;
    }
    while (i < arg.length) {
      if (arg[i] !== '.' || !startsIdent(arg, i + 1)) return null;
      const ident = readIdent(arg, i + 1);
      classes.push(ident.value);
      i = ident.end;
    }
    typed = name !== '*' || classes.length > 0;
  }
  const part: TransitionPart = {
    part: (m[1]?.toLowerCase() ?? 'view-transition') as TransitionPart['part'],
    name,
    classes,
    onlyChild: !!m[3],
  };
  const specificity =
    specificityOf(head) + (typed ? 1 : 0) + (m[3] ? 1_000 : 0);
  return { rule: { ...rule, selector, specificity }, part };
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
    subjects: [],
    siblings: false,
    nested: false,
    has: [],
    followed: [],
    below: [],
    host: false,
  };
  scanComplex(selector, out, kind, true);
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
  /** The compounds in `compounds` that are their selector's subject, at
   *  its top: `.card:hover`'s, and `.card:hover::before`'s. A change of
   *  the state changes the style of the element one matches and no other,
   *  and of what is in it only through what that inherits. */
  subjects: string[];
  siblings: boolean;
  nested: boolean;
  has: { anchor: string; siblings: boolean }[];
  /** The compounds and anchors a sibling combinator follows: the ones
   *  whose elements' later siblings change with them. */
  followed: string[];
  /**
   * The compounds that test the state and lead below to the selector's
   * subject, and are not it: `.anchor-link`'s `:hover > .anchor-link`,
   * which changes the children of the element that matches `*` named so
   * and nothing else. Each with its subject, without what tests a state or
   * names a pseudo-element, and whether the subject is its child. The
   * compound is not in `compounds`, which reach all that is in their
   * element.
   */
  below: { compound: string; subject: string; child: boolean }[];
  /** Whether a `:host()` tests the state: what the host's flip changes is
   *  in its tree, matched by rules no restyle in place asks
   *  (`StateRules.edge`). */
  host: boolean;
}

/** The functions that take a selector list and match the element they are
 *  written on (Selectors 4, 4.2 to 4.4), under the names css-select and
 *  older sheets know them by. */
const MATCHES_ANY = /^(?:is|where|not|matches|any|-webkit-any|-moz-any)$/i;

/** The compounds of a complex selector, each with the combinator after it. */
/**
 * The classes, or the ids, a selector's subject asks for: the names in its
 * last compound, escapes resolved, and none inside a functional
 * pseudo-class, which may ask for them only in part (`:not(.x)`, `:is(.a,
 * .b)`).
 */
function subjectNames(selector: string, attribute: 'class' | 'id'): string[] {
  const parts = compoundsOf(selector);
  const compound = parts[parts.length - 1]?.text ?? '';
  const mark = attribute === 'class' ? '.' : '#';
  const out: string[] = [];
  let i = 0;
  while (i < compound.length) {
    const c = compound[i];
    if (c === '.' || c === '#') {
      const name = readIdent(compound, i + 1);
      if (c === mark && name.value) out.push(name.value);
      i = Math.max(name.end, i + 1);
    } else if (c === '[') {
      i = balancedEnd(compound, i, '[', ']');
    } else if (c === '(') {
      i = balancedEnd(compound, i, '(', ')');
    } else if (c === '\\') {
      i = escapeEnd(compound, i);
    } else i += 1;
  }
  return out;
}

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

/** `pointerCompounds` for one complex selector, into `out` — `top` where it
 *  is a rule's own, whose last compound is its subject, and not one nested
 *  in a function. */
function scanComplex(
  selector: string,
  out: PointerCompounds,
  kind: StateKind,
  top = false,
): void {
  const parts = compoundsOf(selector);
  for (let p = 0; p < parts.length; p += 1) {
    const { text, next } = parts[p];
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
    // a compound that leads below, by a descendant or a child combinator,
    // reaches what in its element the subject names: every element in it
    // can be one only where the subject is a compound this cannot read
    const subject =
      found.pointer && top && p < parts.length - 1 && !sibling
        ? subjectOf(parts[parts.length - 1].text)
        : null;
    if (subject) {
      out.below.push({
        compound: found.bare.trim() || '*',
        subject,
        child: next === '>' && p === parts.length - 2,
      });
    } else if (found.pointer) {
      out.compounds.push(found.bare.trim() || '*');
      if (top && p === parts.length - 1) {
        out.subjects.push(found.bare.trim() || '*');
      }
    }
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

/** The legacy pseudo-elements, written with one colon (CSS 2.1, 5.12). */
const LEGACY_PSEUDO_ELEMENT =
  /^:(?:before|after|first-line|first-letter)(?![\w-])/i;

/**
 * A subject compound as `PointerCompounds.below` matches elements by: what
 * it asks of an element, without a pseudo-element and what follows it, and
 * without the states this renderer keeps, so that it names every element
 * that can match it in any state — and without its functional
 * pseudo-classes, each of which only narrows what the rest matches, whatever
 * it asks of other elements. A `:hover` inside one is the subject's own,
 * which its compound answers for (`scanComplex`). Angular's docs write
 * `*:hover > kbd:not(:has(kbd))`, which read as a compound of `*`'s reached
 * all that every hovered element holds, the `<body>` among them, and every
 * move built the boxes.
 */
function subjectOf(compound: string): string {
  let bracket = 0;
  let quote = '';
  let own = '';
  /** Where the pseudo-class being read starts, which a `(` after its name
   *  makes a function to leave out. */
  let colon = -1;
  for (let i = 0; i < compound.length; i += 1) {
    const c = compound[i];
    if (quote) {
      if (c === quote && compound[i - 1] !== '\\') quote = '';
      own += c;
      continue;
    }
    if (c === '\\') {
      const end = escapeEnd(compound, i);
      own += compound.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === '(' && bracket === 0 && colon >= 0) {
      own = own.slice(0, own.length - (i - colon));
      i = closeOf(compound, i);
      colon = -1;
      continue;
    } else if (c === ':' && bracket === 0) {
      if (
        compound[i + 1] === ':' ||
        LEGACY_PSEUDO_ELEMENT.test(compound.slice(i))
      ) {
        break;
      }
      colon = i;
    } else if (bracket === 0 && !/[\w-]/.test(c)) colon = -1;
    own += c;
  }
  return own.replace(new RegExp(STATE_PSEUDO.source, 'gi'), '').trim() || '*';
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
        if (name === 'host') {
          // the host's own state, whose flip changes its tree
          out.host = true;
          bare += whole;
        } else if (name === 'has') {
          // the compound is kept without it: its argument is what the
          // pointer changes, and whatever holds the `:hover` in there, the
          // element it tests is in the anchor's subtree or a later
          // sibling's — but for one a selector in a function there names,
          // which may be above the anchor or before it (`readsApart`)
          args.push(arg);
          if (testsApart(arg, kind)) out.nested = true;
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

/**
 * Whether `entry`, a selector in a function in a `:has()`'s argument, reads
 * what no walk from a change finds. It is the document's (`compileHoisted`),
 * so what a combinator in it climbs to may be above the `:has()`'s element.
 * What a sibling combinator reaches is beside what it was tested from, which
 * is inside the `:has()`'s element unless the argument starts at a sibling
 * (`siblings`), when it may be before the element: Tailwind's `peer` in a
 * `has-`, `:has(:is(.peer ~ *))`, stays inside it.
 */
function readsApart(entry: string, siblings: boolean): boolean {
  const parts = compoundsOf(entry);
  if (parts.length < 2) return false;
  return (
    siblings ||
    parts.slice(0, -1).some(({ next }) => next !== '+' && next !== '~')
  );
}

/** Whether a `:has()`'s argument has a function in it that holds a selector
 *  testing `kind`'s state that `readsApart`. */
function testsApart(arg: string, kind: StateKind): boolean {
  const siblings = selectorsOf(arg).some((one) => /^\s*[+~]/.test(one));
  for (let i = arg.indexOf(':'); i >= 0; i = arg.indexOf(':', i + 1)) {
    const fn = FUNCTION_AT.exec(arg.slice(i));
    if (!fn || !MATCHES_ANY.test(fn[1])) continue;
    const open = i + fn[0].length - 1;
    const entries = selectorsOf(arg.slice(open + 1, closeOf(arg, open)));
    if (
      entries.some(
        (entry) => kind.any.test(entry) && readsApart(entry, siblings),
      )
    ) {
      return true;
    }
  }
  return false;
}

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

/** `:target` anywhere in a selector, and not `::target-text`. */
const TARGET_PSEUDO = /:target(?![\w-])/i;

/** A selector whose matcher keeps answers (`cacheResults`): css-select
 *  keeps what a `:has()`, a `:contains()` or an `:icontains()` answered for
 *  an element, and what a descendant combinator after one found above it.
 *  Every other matcher is told to keep nothing (`compileSelector`). */
const KEEPS_ANSWERS = /:(?:has|i?contains)\(/i;

/** css-select's `aliases`, which it does not export: pseudo-classes it
 *  compiles as an `:is()` of a selector it holds. */
const SELECTOR_ALIASES =
  /^(?:any-link|link|disabled|enabled|checked|required|optional|read-only|read-write|selected|checkbox|file|password|radio|reset|image|submit|parent|header|button|input|text)$/i;

/** Whether a functional pseudo-class compiles a selector of its own: one
 *  that takes a list, and `:nth-child()` with an `of`. */
function compilesSelector(name: string, arg: string): boolean {
  return (
    MATCHES_ANY.test(name) ||
    (/^nth-(?:last-)?child$/.test(name) && /\sof\s/i.test(arg))
  );
}

/** A combinator at a selector's start, past white space and comments: a
 *  sheet's comments are gone by here, and a page's own selector keeps them. */
const STARTS_AT_COMBINATOR = /^(?:\s|\/\*[^]*?\*\/)*[>+~]/;

/**
 * A `:has()`'s argument with `* > ` before each entry that starts at no
 * combinator and has one in it.
 *
 * css-select reads `:has(X Y)` as `:scope X Y`, and the descendant combinator
 * it puts after `:scope` there may take the element itself
 * (`_flexibleDescendant`, fb55/css-select#1928), so `.a:has(.a .b)` held of an
 * `.a` with a `.b` in it, where `X` has to be inside the element (Selectors 4,
 * 4.5). Under `* > X Y` that combinator has the `*` to take for the element:
 * `X`'s parent is the element or is inside it, which is `X` inside it. An
 * entry of one compound is that already, being what the element is searched
 * for.
 *
 * This form because of what each of the others costs. css-select keeps a
 * `:has()`'s answers to answer what is under an element with, unless an entry
 * starts at a combinator or names `:scope`, so `> X Y, > * X Y` and `:scope
 * X:not(:scope) Y` took some fifteen times as long over a deep tree. And
 * `* X Y` says the same, but walks up from each of `X`'s ancestors in turn,
 * which took thirteen times as long forty levels of `X` down.
 *
 * A `:scope` in the argument is compiled apart by then (`hoistFromHas`), so no
 * entry here names it: an entry that did would be anchored at nothing.
 */
function insideHas(arg: string): string {
  return selectorsOf(arg)
    .map((entry) =>
      compoundsOf(entry).length < 2 || STARTS_AT_COMBINATOR.test(entry)
        ? entry
        : `* > ${entry}`,
    )
    .join(',');
}

/**
 * `text` with what `compileHoisted` compiles apart taken out of each
 * `:has()` in it, into `hoisted`, and `:-rx-hoisted(n)` left in its place,
 * and each such argument held inside its element (`insideHas`). `inHas` says
 * `text` is such a `:has()`'s argument.
 */
function hoistFromHas(text: string, hoisted: string[], inHas: boolean): string {
  const hoist = (whole: string): string => {
    hoisted.push(whole);
    return `:-rx-hoisted(${hoisted.length - 1})`;
  };
  let out = '';
  let i = 0;
  while (i < text.length) {
    let end = i + 1;
    let piece = '';
    if (text[i] === '\\') end = escapeEnd(text, i);
    else if (text[i] === '[') end = bracketEnd(text, i) + 1;
    else if (text[i] === ':') {
      const fn = FUNCTION_AT.exec(text.slice(i));
      if (fn) {
        const open = i + fn[0].length - 1;
        const close = closeOf(text, open);
        const name = fn[1].toLowerCase();
        const arg = text.slice(open + 1, close);
        const own = compilesSelector(name, arg);
        end = close + 1;
        if (name === 'has' || own) {
          const held = hoistFromHas(arg, hoisted, name === 'has');
          const whole =
            text.slice(i, open + 1) +
            (name === 'has' ? insideHas(held) : held) +
            text.slice(close, end);
          piece = own && inHas ? hoist(whole) : whole;
        }
      } else if (inHas) {
        const name = /^:([\w-]+)/.exec(text.slice(i))?.[1];
        if (name && (SELECTOR_ALIASES.test(name) || /^scope$/i.test(name))) {
          end = i + 1 + name.length;
          piece = hoist(text.slice(i, end));
        }
      }
    }
    out += piece || text.slice(i, end);
    i = end;
  }
  return out;
}

/**
 * A selector compiled by `make`, with what a `:has()` holds compiled apart.
 *
 * css-select hands the `:has()`'s element, as a context, to whatever in its
 * argument compiles a selector of its own, and reads that selector as
 * relative to the element, where one has a combinator in it
 * (fb55/css-select#1930): so
 * `.p:has(+ .a:not(.b))` asked for a `.b` inside the `.p`, which its sibling
 * never is, and held of every `.a`, and `.p:has(+ :is(.a))` of none. An
 * `:is()`, a `:where()` and a `:not()` take a selector of the document's
 * (Selectors 4, 4.2 to 4.4), which reads above the `:has()`'s element as
 * freely as anywhere: `:has(> .a:is(.x .a))` with the `.x` around it. Apple's
 * product pages style a section by `:has(+ .section.theme-dark:not(.alt))`.
 * Each of them is compiled by itself, with no context to read, and
 * `:nth-child(… of S)` and css-select's `aliases` with it, which are `:is()`s
 * under other names: `:has(+ input:checked)` matched nothing. So is a `:scope`,
 * which is the query's and not the `:has()`'s element (fb55/css-select#1931):
 * `el.closest(':has(:scope .a)')` found `el` for an `.a` in it, where it finds
 * what `el` is in. What is left of an argument goes through `insideHas`.
 *
 * Only what is compiled changes: what reads a rule for what it reaches reads
 * it as written, and never sees `-rx-hoisted` or the `* > `.
 */
export function compileHoisted<Pseudos extends object>(
  selector: string,
  pseudos: Pseudos,
  make: (selector: string, pseudos: Pseudos) => (el: Element) => boolean,
): (el: Element) => boolean {
  if (!/:has\(/i.test(selector)) return make(selector, pseudos);
  const hoisted: string[] = [];
  const text = hoistFromHas(selector, hoisted, false);
  if (!hoisted.length) return make(text, pseudos);
  const matchers: ((el: Element) => boolean)[] = [];
  const own = {
    ...pseudos,
    // `?.`: a sheet can write the name too, with any number
    '-rx-hoisted': (el: Element, at: string | null) =>
      matchers[Number(at)]?.(el) === true,
  };
  for (const one of hoisted) matchers.push(make(one, own));
  return make(text, own);
}

/**
 * A selector compiled to a matcher over this adapter. css-select keeps the
 * answers of a `:has()` above the subject, or of the ancestors a
 * descendant combinator tried under one, for as long as the matcher lives
 * (`cacheResults`) — which is the cascade's life, and neither a pointer
 * move nor a change to the tree is a new cascade while the sheets read as
 * they did. So a selector that tests the pointer or the focus keeps none:
 * with them, `#box:has(a:hover) .m` answered what it did before the first
 * move, for good. And one that keeps answers is compiled again once a tree
 * has changed (`treeGeneration`): `div:has(img)` answered what it did
 * before a stream's next chunk brought the image in, before a checkbox
 * under `label:has(:checked)` was ticked, and before an application's
 * `refresh()`. Only those, and only once they are next asked: compiling
 * one is a few microseconds, and a page's rules are mostly not them.
 *
 * Any other selector keeps nothing, and has to be told: a descendant
 * combinator after an `:is()` or a `:not()` with a combinator in it keeps
 * what it found as one after a `:has()` does (fb55/css-select#1929), so
 * `:is(.x .a) .y` answered what it did before the `.x` came. Telling them
 * changes nothing else, and a selector with no such function has nothing
 * to turn off. A release that narrows that cache leaves this as it is:
 * these matchers outlive a change, which is what the option is for.
 */
function compileSelector(
  selector: string,
  adapter: CssSelectAdapter,
  pseudos: typeof PSEUDOS = PSEUDOS,
  /** Whether what it answers may be kept: not where the adapter's tree
   *  moves under it, as a `<use>`'s copy's does (`Cascade.shapeStyles`). */
  cache = true,
): (el: Element) => boolean {
  const keep =
    cache && KEEPS_ANSWERS.test(selector) && !STATE_PSEUDO.test(selector);
  // where the siblings are the tree's own: a `<use>`'s copy has its own
  const kept =
    adapter.getSiblings === DomUtils.getSiblings ? nthKept : (s: string) => s;
  const text = kept(classesBeyondAscii(noEmptyWords(selector)));
  const make = () =>
    compileHoisted(
      text,
      pseudos,
      (one, own) =>
        compile(one, {
          adapter,
          xmlMode: false,
          pseudos: own,
          cacheResults: keep,
        } as unknown as Parameters<typeof compile>[1]) as unknown as (
          node: Element,
        ) => boolean,
    );
  // compiled here, so a selector css-select refuses throws to the caller
  let match = make();
  if (!keep) return match;
  let at = treeGeneration();
  return (el) => {
    const now = treeGeneration();
    if (now !== at) {
      match = make();
      at = now;
    }
    return match(el);
  };
}

/**
 * Where an element is among its parent's element children: how many come
 * before it and after it, of all and of its own name — as css-select
 * counts them for `:nth-child()` and its kin, each sibling by name
 * (`getName`'s, an XHTML `<svg:svg>` an `svg`). Worked out for every child
 * of the parent at once and kept by the element until a tree changes
 * (`treeGeneration`): css-select counts the siblings before an element
 * every time it is asked, so a table of 10,000 rows under
 * `tr:nth-child(odd)` was 50 million steps to style.
 */
interface Place {
  gen: number;
  index: number;
  fromEnd: number;
  ofType: number;
  ofTypeFromEnd: number;
}
const PLACES = new WeakMap<Element, Place>();

const nameOf = (el: Element): string =>
  el.name.endsWith(':svg') ? tagOf(el) : el.name;

function placeOf(el: Element): Place {
  const gen = treeGeneration();
  const kept = PLACES.get(el);
  if (kept !== undefined && kept.gen === gen) return kept;
  const siblings = DomUtils.getSiblings(el);
  const elements: Element[] = [];
  const ofName = new Map<string, number>();
  for (const sibling of siblings) {
    if (!isTag(sibling as Element)) continue;
    const element = sibling as Element;
    elements.push(element);
    const name = nameOf(element);
    ofName.set(name, (ofName.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i];
    const name = nameOf(element);
    const before = seen.get(name) ?? 0;
    seen.set(name, before + 1);
    PLACES.set(element, {
      gen,
      index: i,
      fromEnd: elements.length - 1 - i,
      ofType: before,
      ofTypeFromEnd: ofName.get(name)! - 1 - before,
    });
  }
  return (
    PLACES.get(el) ?? { gen, index: 0, fromEnd: 0, ofType: 0, ofTypeFromEnd: 0 }
  );
}

/** An `An+B`, read as Selectors 3 has it (6.6.5.2) — `odd`, `even`, `3`,
 *  `-n+3`, `2n + 1` — as the A and the B; null for anything else, which is
 *  left to css-select. */
function nthOf(arg: string): [number, number] | null {
  const text = arg.trim().toLowerCase();
  if (text === 'odd') return [2, 1];
  if (text === 'even') return [2, 0];
  const m = /^([+-]?\d*)n\s*(?:([+-])\s*(\d+))?$|^([+-]?\d+)$/.exec(text);
  if (!m) return null;
  if (m[4] !== undefined) return [0, Number(m[4])];
  const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
  const b = m[3] !== undefined ? Number(m[3]) * (m[2] === '-' ? -1 : 1) : 0;
  return [a, b];
}

const NTH_CHECKS = new Map<string, [number, number] | null>();

/** Whether an element matches an `An+B` counted from `from`. One every
 *  position matches, `n`, is css-select's "has an element for a parent". */
function nthHolds(
  arg: string | null,
  el: Element,
  from: 'index' | 'fromEnd' | 'ofType' | 'ofTypeFromEnd',
): boolean {
  let ab = NTH_CHECKS.get(arg ?? '');
  if (ab === undefined) {
    ab = nthOf(arg ?? '');
    NTH_CHECKS.set(arg ?? '', ab);
  }
  if (!ab) return false;
  const [a, b] = ab;
  if (a === 1 && b <= 0) {
    const parent = el.parent;
    return !!parent && isTag(parent as Element);
  }
  const i = placeOf(el)[from] + 1;
  if (a === 0) return i === b;
  const n = (i - b) / a;
  return Number.isInteger(n) && n >= 0;
}

/** `:nth-child()` and its kin, where their argument is a plain `An+B`, as
 *  the pseudo-classes that answer them from `placeOf`. */
function nthKept(selector: string): string {
  if (!/:nth-/i.test(selector)) return selector;
  return selector.replace(
    /(?<!\\):nth-(child|last-child|of-type|last-of-type)\(([^()]*)\)/gi,
    (whole, kind: string, arg: string) =>
      nthOf(arg) ? `:-rx-nth-${kind.toLowerCase()}(${arg})` : whole,
  );
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
/**
 * The bucket a rule is filed under (`rightmostKey`): an id, a class, a
 * type, an attribute its subject has to have, `:root`, or none. The first
 * three name what an element is, the next two what only some elements
 * have, which the universal bucket held: GitHub's 1,443 rules there —
 * Primer's `[data-color-mode=…][data-light-theme=…]` themes, its `:root`
 * tokens, `[hidden]`, `[popover]` — were asked of every element.
 */
type SelectorKey = {
  kind: 'id' | 'class' | 'tag' | 'attr' | 'root' | 'any';
  name: string;
};

function rightmostKey(selector: string): SelectorKey {
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
function keyOnly(selector: string, key: SelectorKey): boolean {
  if (key.kind !== 'class' && key.kind !== 'id') return false;
  const text = selector.trim();
  if (text[0] !== (key.kind === 'class' ? '.' : '#')) return false;
  const name = readIdent(text, 1);
  return name.end === text.length && name.value === key.name;
}

/**
 * A compound selector's most selective key (`rightmostKey`): its id, else
 * its first class, its type, the first attribute it tests, or `:root` —
 * and of an `:is()` or a `:where()` of one complex selector, the key of
 * that selector's subject, which is this compound's too: `:is(.a .b)`
 * matches only what `.b` does. An attribute in a namespace, or any, is no
 * key, nor is anything inside `:not()`.
 */
function compoundKey(compound: string): SelectorKey {
  let id: string | null = null;
  let cls: string | null = null;
  let tag: string | null = null;
  let attrName: string | null = null;
  let root = false;
  /** The best key an `:is()` or a `:where()` in it gave. */
  let inner: SelectorKey | null = null;
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
      const end = balancedEnd(compound, i, '[', ']');
      if (attrName === null)
        attrName = attributeTested(compound.slice(i + 1, end - 1));
      i = end;
    } else if (c === ':') {
      const skip = compound[i + 1] === ':' ? 2 : 1;
      const ident = readIdent(compound, i + skip);
      const end = Math.max(ident.end, i + skip);
      if (compound[end] === '(') {
        const close = balancedEnd(compound, end, '(', ')');
        const fn = ident.value.toLowerCase();
        if (skip === 1 && (fn === 'is' || fn === 'where') && !inner) {
          const arg = compound.slice(end + 1, close - 1);
          if (selectorsOf(arg).length === 1) {
            const key = rightmostKey(arg.trim());
            if (key.kind !== 'any') inner = key;
          }
        }
        i = close;
      } else {
        if (skip === 1 && ident.value.toLowerCase() === 'root') root = true;
        i = end;
      }
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
  if (inner && (inner.kind === 'id' || inner.kind === 'class')) return inner;
  if (tag && tag !== '*') return { kind: 'tag', name: tag };
  if (inner && inner.kind === 'tag') return inner;
  if (attrName !== null) return { kind: 'attr', name: attrName };
  if (inner) return inner;
  if (root) return { kind: 'root', name: '' };
  return { kind: 'any', name: '' };
}

/**
 * The attribute an attribute selector's inside (`[…]` without its
 * brackets) tests, lower-cased as the matcher compares an HTML document's:
 * null where it names a namespace, or any, which a name alone does not
 * say.
 */
function attributeTested(inside: string): string | null {
  let i = 0;
  while (i < inside.length && /\s/.test(inside[i])) i += 1;
  if (!startsIdent(inside, i)) return null;
  const name = readIdent(inside, i);
  let j = name.end;
  while (j < inside.length && /\s/.test(inside[j])) j += 1;
  // `ns|name`, where the `|` is no `|=`
  if (inside[j] === '|' && inside[j + 1] !== '=') return null;
  return name.value.toLowerCase();
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
  resolved = new WeakMap<
    ComputedStyle,
    Map<Element, { into: Map<Element, ShapeStyle> | null; key: string }>
  >();
  constructor(public byId: (id: string) => Element | null) {}

  /** All of it forgotten, the ids looked up in `byId` from now on: what a
   *  `<use>` names came, or grew, in a stream's chunk, which builds none
   *  of the drawings that name it (`HtmlViewNode._parsedChanges`). */
  forget(byId: (id: string) => Element | null): void {
    this.matched.clear();
    this.resolved = new WeakMap();
    this.byId = byId;
  }
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

/** Whether a rule at a shadow tree's edge can test `el`'s state: it hosts a
 *  tree, is in one, or is a host's light child, which a slot may take. */
function atShadowEdge(el: Element): boolean {
  if (shadowRootOf(el) || shadowRootAround(el)) return true;
  const parent = el.parent;
  return (
    !!parent && isTag(parent as Element) && !!shadowRootOf(parent as Element)
  );
}

/**
 * What the selectors that test one state — the pointer, or the focus — say
 * of the elements a change of it can restyle: the compounds that test it,
 * each without it and with whether a sibling combinator follows it, and
 * the anchors of the `:has()`s that test it (`pointerCompounds`).
 */
class StateRules {
  /** The compounds, each without the state, with what a change of it
   *  reaches from an element one matches (`HoverTouch`), the most any
   *  selector has it reach; and their matchers, compiled when a change
   *  first asks (`touches`). */
  private _compounds = new Map<string, HoverTouch>();
  private _matchers:
    { match: (el: Element) => boolean; touch: HoverTouch }[] | null = null;
  /** Whether a change can be restyled where it happened
   *  (`HtmlViewNode._hoverInPlace`): false where a selector tests the
   *  state inside a functional pseudo-class, which reaches elements no
   *  compound names. */
  local = true;
  /** Whether a rule at a shadow tree's edge tests the state: a flip of a
   *  host, of an element in a tree or of one assigned to a slot is then
   *  answered by building the boxes (`HOVER_EDGE`), since those rules are
   *  in no index a restyle in place asks. */
  edge = false;
  /** The compounds that lead below (`PointerCompounds.below`), each with
   *  its subjects and whether each is only ever a child; and their
   *  matchers, compiled when a change first asks. */
  private _below = new Map<string, Map<string, boolean>>();
  private _belowMatchers:
    { match: (el: Element) => boolean; reaches: BelowReach[] }[] | null = null;
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

  /** These rules for another cascade, whose matchers its own adapter
   *  compiles. */
  rebound(): this {
    this._matchers = null;
    this._belowMatchers = null;
    this._anchorMatchers = null;
    return this;
  }

  note(selector: string): void {
    if (!this._kind.mentions.test(selector)) return;
    const found = pointerCompounds(selector, this._kind);
    if (found.nested) this.local = false;
    if (found.host) this.noteEdge(selector);
    for (const { compound, subject, child } of found.below) {
      let subjects = this._below.get(compound);
      if (!subjects) this._below.set(compound, (subjects = new Map()));
      subjects.set(subject, child && (subjects.get(subject) ?? true));
    }
    const followed = new Set(found.followed);
    // a compound that is a subject here may be followed or lead elsewhere
    // in the same selector, which reaches more
    const subjects = found.subjects.filter(
      (c) => found.compounds.indexOf(c) === found.compounds.lastIndexOf(c),
    );
    for (const c of found.compounds) {
      const touch = followed.has(c)
        ? HOVER_FOLLOWED
        : subjects.includes(c)
          ? HOVER_SELF
          : HOVER_TOUCHED;
      const was = this._compounds.get(c) ?? HOVER_UNTOUCHED;
      if (touch > was) this._compounds.set(c, touch);
    }
    for (const { anchor, siblings } of found.has) {
      const was = this._anchors.get(anchor);
      this._anchors.set(anchor, {
        siblings: siblings || (was?.siblings ?? false),
        followed: followed.has(anchor) || (was?.followed ?? false),
      });
    }
  }

  /**
   * A rule at a shadow tree's edge that tests the state (`edge`): one that
   * reads the state of an element no host, tree or slot holds — an
   * ancestor of a host's, through `:host-context()`, `:has()` or a compound
   * before a `::part()`'s host — is answered by no restyle at all.
   */
  noteEdge(selector: string): void {
    if (!this._kind.mentions.test(selector)) return;
    const part = /::part\(/i.exec(selector);
    const before = part ? compoundsOf(selector.slice(0, part.index)) : [];
    if (
      /:host-context\(|:has\(/i.test(selector) ||
      before.slice(0, -1).some((c) => this._kind.mentions.test(c.text))
    ) {
      this.local = false;
    } else this.edge = true;
  }

  /** `Cascade.hoverTouches`, for this state. */
  touches(
    el: Element,
    compile: (selector: string) => ((el: Element) => boolean) | null,
    below?: BelowReach[],
  ): HoverTouch {
    if (this.edge && atShadowEdge(el)) return HOVER_EDGE;
    // the ones that reach most first, so the first that matches is the
    // answer
    this._matchers ??= [...this._compounds]
      .sort(([, a], [, b]) => b - a)
      .flatMap(([compound, touch]) => {
        const match = compile(compound);
        return match ? [{ match, touch }] : [];
      });
    let found: HoverTouch = HOVER_UNTOUCHED;
    for (const { match, touch } of this._matchers) {
      if (match(el)) {
        found = touch;
        break;
      }
    }
    // the element alone is all a subject reaches, so what a compound that
    // leads below reaches from it is asked for as well
    if (found > HOVER_SELF) return found;
    if (!this._below.size) return found;
    if (!this._belowMatchers) {
      // one matcher a subject, shared by every compound that leads to it
      const subjects = new Map<string, ((el: Element) => boolean) | null>();
      const subjectMatch = (subject: string) => {
        if (!subjects.has(subject)) subjects.set(subject, compile(subject));
        return subjects.get(subject)!;
      };
      const reaches = new Map<string, BelowReach>();
      this._belowMatchers = [];
      for (const [compound, of] of this._below) {
        const match = compile(compound);
        if (!match) continue;
        const list: BelowReach[] = [];
        for (const [subject, child] of of) {
          // one that compiles to nothing names no element: nor does its
          // rule, which the cascade drops
          const m = subjectMatch(subject);
          if (!m) continue;
          const key = `${child ? '>' : ' '}${subject}`;
          let reach = reaches.get(key);
          if (!reach) reaches.set(key, (reach = { match: m, child }));
          list.push(reach);
        }
        if (list.length) this._belowMatchers.push({ match, reaches: list });
      }
    }
    for (const { match, reaches } of this._belowMatchers) {
      if (!match(el)) continue;
      if (below) for (const r of reaches) if (!below.includes(r)) below.push(r);
    }
    return found;
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
      else if ((into.get(at) ?? HOVER_UNTOUCHED) < HOVER_TOUCHED) {
        into.set(at, HOVER_TOUCHED);
      }
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

// --- what a change to the DOM can restyle ---------------------------------
//
// An application that changed the tree and says how (`refresh(changes)`)
// restyles what the change can reach, where every element was styled again.
// What it can reach is the selectors': a class, an id or an attribute a
// selector tests, or what an element holds, is something a change makes
// another answer for, and where in the selector it is tested says for which
// elements — the one changed, what is in it, its later siblings, or,
// through a `:has()`, those around it. `Cascade.crossed` is the same
// question asked of a width, and `StateRules` of the pointer.

/** A change can restyle the element it was made to: a selector tests what
 *  changed in its subject. */
export const CHANGES_SELF = 1;
/** …what is in it: tested in a compound a descendant or a child combinator
 *  follows. */
export const CHANGES_BELOW = 2;
/** …its later siblings and what is in them: tested in a compound a sibling
 *  combinator follows. */
export const CHANGES_LATER = 4;
/** Elements this cannot say: what `:nth-child(… of …)` counts by, which
 *  is any sibling's. */
export const CHANGES_ANYWHERE = 64;

/**
 * An element a change can change the answer to a `:has()` of, as the
 * change finds it (`HtmlViewNode._scopeOf`): one that matches `compound`,
 * among the elements around what changed. A `:has()` asks what is below
 * its element, or after it where its argument starts at a sibling, so the
 * element whose answer changed is an ancestor of what changed, or with
 * `siblings` an earlier sibling of it or of an ancestor. What changes with
 * its answer is what its compound's place in its selector (`at`,
 * `CHANGES_*`) says.
 *
 * The compound is the `:has()`'s, with nothing in it a change to the tree
 * can change the answer to (`stableCompound`): its type, classes, ids and
 * attribute tests, which are the element's own. So an element whose answer
 * changed matches it before the change and after, and it is asked after.
 * Where one of those is what changed, the element's own test of it
 * reaches as far as the anchor would (`CHANGES_*` on its key).
 *
 * Where its argument goes down child combinators alone, and tests nothing
 * of an element but the element (`childLevels`), the element whose answer
 * changed is at most `levels` above the one a key is tested of, and no
 * ancestor further up: `:has(> .caption)` asks only of an element's
 * children, so a change to a `.caption` reaches its parent's answer.
 */
export interface HasAnchor {
  readonly compound: string;
  readonly at: number;
  readonly siblings: boolean;
  readonly levels?: number;
  /** The stable part of the subject of the rule, for a `:has()` above it in
   *  the rule's own selector: all it can restyle in its element. */
  readonly subject?: string;
}

/** A `:has()` somewhere a change reaches elements no compound names —
 *  inside `:nth-child(… of …)`, or one every element is the anchor of
 *  that reaches past itself: what it reaches is noted `CHANGES_ANYWHERE`. */
const ANYWHERE_ANCHOR: HasAnchor = {
  compound: '*',
  at: CHANGES_ANYWHERE,
  siblings: true,
};

const EMPTY_ANCHORS: ReadonlySet<HasAnchor> = new Set();
const EMPTY_NODES: readonly AnyNode[] = [];

/** The most elements of what came or went that are matched against the
 *  subjects of the `:has()`s that ask only of those (`Cascade.
 *  _heldReached`), past which every such `:has()` is taken to be reached:
 *  what a framework renders a page's section with is restyled with its
 *  anchors, as it was. */
const HELD_WALK = 512;

/** The anchor of a `:has()` in a compound at `at` whose element matches
 *  `stable` (`stableCompound`), its argument starting at a sibling where
 *  `siblings` says, and asking only so many levels down where `levels`
 *  says (`childLevels`). */
function anchorOf(
  stable: string,
  at: number,
  siblings: boolean,
  levels?: number,
  subject?: string | null,
): HasAnchor {
  if (at & CHANGES_ANYWHERE) return ANYWHERE_ANCHOR;
  const compound = stable || '*';
  // every element's answer, past which what changes is everything — but
  // for one that asks only a few levels down, whose answer changes only
  // for the few elements that far above what changed: Apple's product
  // pages style `:has(>.caption-primary) .caption`, and every change to
  // their tree restyled, built and laid out all of it
  if (
    compound === '*' &&
    levels === undefined &&
    at & (CHANGES_BELOW | CHANGES_LATER)
  ) {
    return ANYWHERE_ANCHOR;
  }
  return {
    compound,
    at,
    siblings,
    ...(levels !== undefined && { levels }),
    ...(subject && subject !== '*' && { subject }),
  };
}

/** The pseudo-classes an element's answer to is read from elements above
 *  it (`PSEUDO_INHERITED`, `READS_AROUND`'s `:lang()` and `:dir()`). */
const READS_ABOVE = /:(?:disabled|enabled|read-only|read-write|dir|lang)\b/i;

/** The pseudo-classes an element's answer to is read from what it holds
 *  (`HOLDS_TESTS`): a level below it. */
const READS_HELD = /:(?:empty|blank|parent)\b/i;

/**
 * How many levels below a `:has()`'s element the elements its argument
 * `entry` tests are, at most (`HasAnchor.levels`), counting a sibling of
 * its element as none: where it starts at a child or a sibling, goes on
 * with child and sibling combinators alone and tests nothing of an element
 * but the element — no functional pseudo-class but an `:is()`, a `:where()`
 * or a `:not()` of names and attributes (`stableCompound`), whose argument
 * could read anything above (`:is(.a .b)`), and none an element takes from
 * its ancestors or from what it holds. Undefined for any other. Apple's
 * `.section:has(+ .section:not(.background-alt))` asks of the next section
 * its own classes, and every change anywhere in a page of sections built
 * all of them again.
 */
function childLevels(entry: string): number | undefined {
  const start = /^\s*([>+~])\s*/.exec(entry);
  if (!start) return undefined;
  const parts = compoundsOf(entry.slice(start[0].length));
  if (!parts.length) return undefined;
  let levels = start[1] === '>' ? 1 : 0;
  for (let i = 0; i < parts.length; i += 1) {
    const { text, next } = parts[i];
    if (i < parts.length - 1) {
      if (next === '>') levels += 1;
      else if (next !== '+' && next !== '~') return undefined;
    }
    if (READS_ABOVE.test(text) || READS_HELD.test(text)) return undefined;
    if (text.includes('(') && stableCompound(text) !== text.trim()) {
      return undefined;
    }
  }
  return levels;
}

/** An anchor whose argument starts at a sibling: its own, or a `:has()`'s
 *  around it in whose argument it is. */
function withSiblings(anchor: HasAnchor): HasAnchor {
  return anchor.siblings ? anchor : { ...anchor, siblings: true };
}

/** What an element matching both of two stable compounds matches. */
function bothOf(a: string, b: string): string {
  if (!a || a === '*') return b;
  if (!b || b === '*') return a;
  return `${a}:is(${b})`;
}

/**
 * What of a compound no change to the tree can change an element's answer
 * to (`HasAnchor`): its type, classes, ids and attribute selectors, and an
 * `:is()`, a `:where()` or a `:not()` of compounds of only those — each the
 * element's own name or attributes. A pseudo-class reads the element's
 * place among its siblings, what it holds, the pointer or the focus, and
 * goes. '' where nothing is left.
 */
function stableCompound(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const end = escapeEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === '[') {
      const close = bracketEnd(text, i);
      out += text.slice(i, close + 1);
      i = close + 1;
    } else if (c === ':') {
      const fn = FUNCTION_AT.exec(text.slice(i));
      if (fn) {
        const open = i + fn[0].length - 1;
        const close = closeOf(text, open);
        if (MATCHES_ANY.test(fn[1])) {
          const entries = selectorsOf(text.slice(open + 1, close));
          const stable = entries.every((entry) => {
            const one = entry.trim();
            return (
              one !== '' &&
              compoundsOf(one).length === 1 &&
              stableCompound(one) === one
            );
          });
          if (stable) out += text.slice(i, close + 1);
        }
        i = close + 1;
      } else {
        const m = /^::?[\w-]*/.exec(text.slice(i));
        i += Math.max(1, m ? m[0].length : 1);
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out.trim();
}

/**
 * What a simple pseudo-class reads that a change to the DOM can change: the
 * attributes it is answered from (`a:`), or what an element holds (`s`),
 * and none for one answered from something else — the pointer, the focus,
 * the URL's fragment's target as the cascade is told it. One not here is
 * one css-select refuses, which drops the rule out of the cascade (a
 * vendor's `:-moz-focusring`), so it reads nothing either.
 */
const PSEUDO_READS: Record<string, readonly string[]> = {
  root: [],
  scope: [],
  hover: [],
  active: [],
  focus: [],
  'focus-visible': [],
  'focus-within': [],
  // an upgrade, which the script engine tells as a change of this
  // attribute nothing has (`DomHost`'s `ceDefined`)
  defined: ['a:-rx-defined'],
  // a dialog `showModal()` opened, which the script engine tells as a
  // change of this attribute nothing has (`DomHost`'s `modal`)
  modal: ['a:-rx-modal'],
  fullscreen: ['a:-rx-fullscreen'],
  autofill: [],
  '-webkit-autofill': [],
  host: [],
  '-rx-top': [],
  'has-slotted': [],
  // what the URL's fragment names, which an `id` or a link's `name` is
  target: ['a:id', 'a:name'],
  checked: ['a:checked', 'a:selected', 'a:type'],
  selected: ['a:selected'],
  default: ['a:checked', 'a:selected', 'a:type', 's'],
  indeterminate: ['a:indeterminate', 'a:type', 'a:checked', 'a:name'],
  disabled: ['a:disabled', 'a:type'],
  enabled: ['a:disabled', 'a:type'],
  required: ['a:required'],
  optional: ['a:required'],
  'read-only': ['a:readonly', 'a:disabled', 'a:contenteditable', 'a:type'],
  'read-write': ['a:readonly', 'a:disabled', 'a:contenteditable', 'a:type'],
  'placeholder-shown': ['a:placeholder', 'a:value', 'a:type'],
  link: ['a:href'],
  'any-link': ['a:href'],
  'local-link': ['a:href'],
  visited: ['a:href'],
  // a `<select>`'s picker open or shut is told as a change of this
  // attribute nothing has (`useForms`'s `pickerChanged`), and whether it is
  // a drop-down box at all by the two it is read from
  open: ['a:open', 'a:-rx-picker-open'],
  closed: ['a:open', 'a:-rx-picker-open', 'a:multiple', 'a:size'],
  'popover-open': ['a:popover', 'a:-rx-popover-open'],
  // a view transition begun, ended or given other types, which the script
  // engine tells as a change of this attribute nothing has (`vtActive`)
  'active-view-transition': ['a:-rx-view-transition'],
  'active-view-transition-type': ['a:-rx-view-transition'],
  muted: ['a:muted', 'a:-rx-muted'],
  'volume-locked': [],
  playing: ['a:autoplay', 'a:-rx-paused'],
  paused: ['a:autoplay', 'a:-rx-paused'],
  seeking: ['a:-rx-seeking'],
  buffering: ['a:-rx-buffering'],
  stalled: ['a:-rx-stalled'],
  'in-range': ['a:min', 'a:max', 'a:value', 'a:type', 'a:step'],
  'out-of-range': ['a:min', 'a:max', 'a:value', 'a:type', 'a:step'],
  // what an element holds, and so where its own later siblings are
  // reached from (`treeChange`), beside where it sits
  empty: ['s', 'h'],
  // and whether it holds text of its own, which a text written on to that
  // was white space alone changes (`'k'`)
  blank: ['s', 'h', 'k'],
  parent: ['s', 'h'],
  // and where it sits from the end, which a child put in at the end of
  // its parent changes for the one that was last (`'e'`)
  'first-child': ['s'],
  'last-child': ['s', 'e'],
  'only-child': ['s', 'e'],
  'first-of-type': ['s'],
  'last-of-type': ['s', 'e'],
  'only-of-type': ['s', 'e'],
  // css-select's own, after jQuery's
  header: [],
  checkbox: ['a:type'],
  file: ['a:type'],
  password: ['a:type'],
  radio: ['a:type'],
  reset: ['a:type'],
  image: ['a:type'],
  submit: ['a:type'],
  button: ['a:type'],
  input: [],
  text: ['a:type'],
};

/** The keys of what an element holds or where it sits among its siblings
 *  (`PSEUDO_READS`, `scanFunctionChanges`), its text among them: a
 *  `:has()` whose argument tests one asks it of elements that stay. */
const SITS_KEYS = new Set(['s', 'h', 'e', 'n', 'k', 't']);

/** The pseudo-classes whose answer for an element is read from elements
 *  around it that no key says: a focus inside it, a slot's assigned
 *  nodes, a radio's group, a direction from its text. */
const READS_AROUND =
  /:(?:focus-within|has-slotted|indeterminate|default|dir|lang)\b/i;

/** The pseudo-classes whose answer an element's descendants take from it —
 *  a fieldset's `disabled`, an editing host's — so a change of what they
 *  read reaches what is in the element too. */
const PSEUDO_INHERITED = new Set([
  'disabled',
  'enabled',
  'read-only',
  'read-write',
]);

/** A selector's keys and where each is tested, as `MutationRules.note`
 *  takes them: at `bits`, or in a `:has()`'s argument, through `anchor`. */
type NoteChange = (
  key: string,
  bits: number,
  anchor: HasAnchor | null,
  /** For a key tested above its rule's subject, what of that subject no
   *  change to the tree can change (`stableCompound`): the elements below
   *  the one changed that the rule can style. Absent, or '', for any. For
   *  a sibling combinator (`'+'`, `'~'`), that of the compound it leads
   *  to. */
  subject?: string | null,
  /** For a key a pseudo-class tests, what of the compound it is in no
   *  change to the tree can change, the elements around it in an `:is()`
   *  or a `:not()` with it: what the element whose answer to it changes
   *  has to match for the compound to (`MutationRules.tested`). Absent, or
   *  '', for any. For a sibling combinator, that of the compound it
   *  follows. */
  where?: string | null,
  /** And what the pseudo-class tests of that element: what it holds
   *  (`:empty`), or where it sits among its siblings (`:first-child`);
   *  absent for anything else. */
  tests?: Tests,
  /** For one that tests where an element sits, what of the compound a
   *  child or a descendant combinator leads to it from no change to the
   *  tree can change, and that combinator: what is around the element it
   *  sits in has to match. */
  parent?: string | null,
) => void;

/** What a pseudo-class tests of its element (`NoteChange`). */
type Tests = 'holds' | 'sits';

/** The pseudo-classes that test what an element holds, which a change to
 *  what it holds can change the answer to of that element alone. */
const HOLDS_TESTS = new Set(['empty', 'blank', 'parent']);

/** Those that test where an element sits among its siblings, which a
 *  change to what holds it can change the answer to of its siblings. */
const SITS_TESTS = new Set([
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
]);

/**
 * The keys a complex selector tests, each with where (`CHANGES_*`): `at`
 * for its subject compound, or `has` for every compound where the selector
 * is a `:has()`'s argument, which reaches only the elements whose answer
 * to that `:has()` changed whatever compound tests it. `outer` is what the
 * subject's element matches besides, where the selector is an entry of an
 * `:is()` or a `:not()` in a compound (`stableCompound` of it). `subject`
 * is the subject compound's stable part, handed to the keys tested above
 * it, for a rule's own selector; none for one inside a function.
 */
function scanChanges(
  selector: string,
  at: number,
  has: HasAnchor | null,
  note: NoteChange,
  outer = '',
  subject: string | null = null,
  /** Where this is a function's argument above a rule's subject, that
   *  subject's stable part (`scanFunctionChanges`). */
  above: string | null = null,
): void {
  const parts = compoundsOf(selector);
  for (let i = 0; i < parts.length; i += 1) {
    const { text, next } = parts[i];
    const last = i === parts.length - 1;
    const bits = last
      ? at
      : next === '+' || next === '~'
        ? CHANGES_LATER
        : CHANGES_BELOW;
    // a sibling combinator, with what it follows and what it leads to
    if (has === null && (next === '+' || next === '~')) {
      const trail = bothOf(
        i + 1 === parts.length - 1 ? outer : '',
        stableCompound(parts[i + 1].text),
      );
      note(next, bits, null, trail || '*', stableCompound(text) || '*');
    }
    // what a combinator leads to a compound of the rule's own from, with it
    const lead =
      subject !== null && i > 0 && /[> ]/.test(parts[i - 1].next)
        ? stableCompound(parts[i - 1].text)
        : '';
    const parent =
      lead && lead !== '*'
        ? `${lead}${parts[i - 1].next === '>' ? ' > ' : ' '}`
        : null;
    scanCompoundChanges(
      text,
      bits,
      has,
      note,
      last ? outer : '',
      last ? above : (subject ?? above),
      parent,
    );
  }
}

/** The keys one compound tests (`scanChanges`). An attribute selector is a
 *  key of its own (`v:`), whose answer for the values an attribute had and
 *  has says whether a change of it is one (`MutationRules.tests`). */
function scanCompoundChanges(
  text: string,
  bits: number,
  has: HasAnchor | null,
  note: NoteChange,
  outer = '',
  subject: string | null = null,
  parent: string | null = null,
): void {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i = escapeEnd(text, i);
    } else if (c === '.' || c === '#') {
      const name = readIdent(text, i + 1);
      note(`${c === '.' ? 'c' : 'i'}:${name.value}`, bits, has, subject);
      i = Math.max(name.end, i + 1);
    } else if (c === '[') {
      const close = bracketEnd(text, i);
      const name = attributeNameOf(text.slice(i + 1, close));
      note(`v:${name}\u0000${text.slice(i, close + 1)}`, bits, has, subject);
      i = close + 1;
    } else if (c === ':' && text[i + 1] === ':') {
      // a pseudo-element left in a compound — `::slotted()`, `::part()` —
      // is a shadow tree's, which a document with one restyles whole
      i += 2;
      while (i < text.length && /[\w-]/.test(text[i])) i += 1;
      if (text[i] === '(') i = closeOf(text, i) + 1;
    } else if (c === ':') {
      const fn = FUNCTION_AT.exec(text.slice(i));
      if (fn) {
        const open = i + fn[0].length - 1;
        const close = closeOf(text, open);
        scanFunctionChanges(
          fn[1].toLowerCase(),
          text.slice(open + 1, close),
          bothOf(outer, stableCompound(text)),
          bits,
          has,
          note,
          parent,
          subject,
        );
        i = close + 1;
        continue;
      }
      const m = /^:([\w-]+)/.exec(text.slice(i));
      const name = (m?.[1] ?? '').toLowerCase();
      const reads = PSEUDO_READS[name] ?? [];
      // What is inside the element takes the answer too, and in a
      // `:has()`'s argument so does the element whose answer it changes,
      // which is inside it too: no attribute one of these reads is a
      // style-only one, and a change of any other restyles its element
      // and everything in it (`HtmlViewNode._scopeOf`).
      const inherited = has === null && PSEUDO_INHERITED.has(name);
      const tests: Tests | undefined = HOLDS_TESTS.has(name)
        ? 'holds'
        : SITS_TESTS.has(name)
          ? 'sits'
          : undefined;
      for (const key of reads) {
        note(
          key,
          inherited ? bits | CHANGES_BELOW : bits,
          has,
          inherited ? null : subject,
          bothOf(outer, stableCompound(text)),
          tests,
          parent,
        );
      }
      i += m ? m[0].length : 1;
    } else {
      // a type, `*`, or what is between: no change to the DOM can make an
      // element another type
      i += 1;
    }
  }
}

/** The keys a functional pseudo-class tests (`scanCompoundChanges`), in a
 *  compound whose element matches `stable` (`stableCompound`). */
function scanFunctionChanges(
  name: string,
  arg: string,
  stable: string,
  bits: number,
  has: HasAnchor | null,
  note: NoteChange,
  /** What a child combinator leads to the compound from, in a rule's own
   *  selector (`NoteChange`'s `parent`). */
  parent: string | null = null,
  /** The stable part of the subject of the rule, where the compound is
   *  above it in the rule's own selector (`scanChanges`). */
  subject: string | null = null,
): void {
  if (name === 'has') {
    // a `:has()` inside another's argument: the outer one's element is the
    // one whose answer changes with the inner one's, and is around it
    for (const entry of selectorsOf(arg)) {
      // one that starts at a sibling asks what is after its element
      const sibling = /^\s*[+~]/.test(entry);
      const anchored =
        has ?? anchorOf(stable, bits, false, childLevels(entry), subject);
      const at = sibling ? withSiblings(anchored) : anchored;
      const relative = entry.replace(/^\s*[>+~]\s*/, '');
      const parts = compoundsOf(relative);
      // And what an element holds is what a `:has()` asks — any of it,
      // where the argument reads where an element sits or what it holds
      // (`'s'`). One that reads neither, only each element's own name and
      // attributes down a line of descendants, answers otherwise for a
      // child put in or taken out only where what came or went holds an
      // element its subject can be: no element that stays gains or loses
      // an ancestor, and what it is matched on is its own (`'g'`).
      // joshwcomeau.com's `html:has([data-disable-document-scroll=true])`
      // put the root among what every sparkle its like button made
      // reached, which built the whole document three times a second.
      let sits =
        sibling ||
        !parts.length ||
        READS_AROUND.test(relative) ||
        parts.some(({ next }) => next === '+' || next === '~');
      scanChanges(relative, bits, at, (key, b, anchor, subject) => {
        if (SITS_KEYS.has(key)) sits = true;
        note(key, b, anchor, subject);
      });
      if (sits) note('s', bits, at);
      else {
        const subject = stableCompound(parts[parts.length - 1].text);
        note('g', bits, at, subject || '*');
      }
    }
  } else if (MATCHES_ANY.test(name)) {
    // the element it is written on, as the compound it is in — whose
    // element the subject of each entry is, so a `:has()` there is that
    // element's: `.b:not(:has(> .c))`'s is a `.b`
    for (const entry of selectorsOf(arg)) {
      if (has && readsApart(entry, has.siblings)) {
        scanChanges(entry, CHANGES_ANYWHERE, ANYWHERE_ANCHOR, note);
      } else scanChanges(entry, bits, has, note, stable, null, subject);
    }
  } else if (name === 'lang' || name === 'dir') {
    // what the nearest element up that says one says: a change to one
    // reaches what is in it, and in a `:has()`'s argument the element
    // whose answer it changes is in it, as for `PSEUDO_INHERITED`
    const keys = name === 'lang' ? ['a:lang', 'a:xml:lang'] : ['a:dir'];
    for (const key of keys) {
      note(key, has ? bits : bits | CHANGES_BELOW, has);
    }
  } else if (/^nth-(?:last-)?(?:child|of-type)$/.test(name)) {
    note('s', bits, has, null, stable, 'sits', parent);
    // counted from the end: every child's place, where one is put in at it
    if (name.startsWith('nth-last-')) note('n', bits, has, null, stable);
    // `of S`: what S tests decides where an element's siblings count it
    const of = /\bof\b/i.exec(arg);
    if (of) {
      const list = arg.slice(of.index + 2);
      for (const entry of selectorsOf(list)) {
        scanChanges(entry, CHANGES_ANYWHERE, ANYWHERE_ANCHOR, note);
      }
    }
  } else if (name === 'contains' || name === 'icontains') {
    // the text of everything in the element: the element's own, and that
    // of every element around it, as a `:has()` asks
    if (has) note('t', bits, has);
    else {
      note('t', bits, null);
      note('t', bits, anchorOf(stable, bits, false));
    }
  }
  // `:host()` and `:host-context()` are a shadow tree's, which a document
  // with one restyles whole; any other css-select refuses
}

/** Where the attribute selector opened at `open` closes. */
function bracketEnd(text: string, open: number): number {
  let quote = '';
  for (let i = open + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = '';
    } else if (c === '\\') i = escapeEnd(text, i) - 1;
    else if (c === '"' || c === "'") quote = c;
    else if (c === ']') return i;
  }
  return text.length;
}

/** The name an attribute selector's body tests, lower-cased as HTML's
 *  attribute names are, and without a namespace: `[xlink|href]` tests
 *  `href`, and `[lang|=en]` tests `lang`. */
function attributeNameOf(body: string): string {
  return asciiLower(attributeNameAsWritten(body));
}

/** `attributeNameOf` as the selector spells it, which is the name
 *  css-select asks an element for. */
function attributeNameAsWritten(body: string): string {
  let name = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '|' && body[i + 1] !== '=') {
      name = '';
      continue;
    }
    if (/[\s=~|^$*\]]/.test(c)) {
      if (name) break;
      continue;
    }
    name += c;
  }
  return name;
}

/** The white space a `class` lists names between: HTML's, which is ASCII's
 *  — an em space is part of a name, and Acid3 asks for `f\2003g`. */
const CLASS_SPACE = /[\t\n\f\r ]+/;

/** An element's classes as its `class` lists them, split at HTML's white
 *  space. */
function classesOf(value: string | null): string[] {
  return value ? value.split(CLASS_SPACE).filter(Boolean) : [];
}

/** The names a declaration's `attr()`s read, as written: a `var()` or a
 *  namespace's prefix and its bar among them. */
const ATTR_FUNCTION = /\battr\(\s*([^\s,)]+)/gi;

/**
 * Every rule's selector, read for what a change to the DOM can make another
 * answer for (`Cascade.attributeChange`, `treeChange`): by key — `c:` a
 * class, `i:` an id, `a:` an attribute a pseudo-class or an `attr()` reads,
 * `v:` an attribute selector, `s` what an element holds, `t` its text —
 * where it is tested, the `:has()`s whose answer it can change, and the
 * pseudo-elements whose rules test it.
 */
/** A subject into what a key reaches (`MutationRules`): null once one of
 *  its rules reaches everything there, for `whole`. */
function noteReach(
  reach: Map<string, Set<string> | null>,
  key: string,
  subject: string | null | undefined,
  whole: boolean,
): void {
  const kept = reach.get(key);
  if (kept === null) return;
  if (whole) reach.set(key, null);
  else if (kept) kept.add(subject!);
  else reach.set(key, new Set([subject!]));
}

/** The keys a change to the tree reaches (`MutationRules.treePseudo`):
 *  where an element sits, what it holds, its text, a sibling combinator. */
const TREE_KEYS = new Set(['s', 'h', 'k', 't', 'e', 'n', 'g', '+', '~']);

/** How many sheets a cascade's reading of its rules may hold that its
 *  document no longer has before it reads them afresh (`Cascade`). */
const SHEETS_GONE = 16;

class MutationRules {
  private _bits = new Map<string, number>();
  /** What each key tested above a rule's subject can restyle below the
   *  element it changes: the subjects' stable compounds, or null for all
   *  that is there (`below`). */
  private _below = new Map<string, Set<string> | null>();
  /** And what it can restyle among the element's later siblings, from a
   *  test before a sibling combinator: the same, of what they hold as well
   *  (`later`). */
  private _later = new Map<string, Set<string> | null>();
  /** What a test of what an element holds or where it sits is of
   *  (`tested`), by where it reaches and whom. */
  private _tested = new Map<string, Set<string> | null>();
  private _pseudo = new Map<string, 0 | 1 | 2>();
  private _anchors = new Map<string, Set<HasAnchor>>();
  /** Each attribute's selectors (`v:` keys), by the attribute's name. */
  private _tests = new Map<string, Set<string>>();
  /** One anchor for each compound, place and kind, so that a set of them
   *  holds each once. */
  private _interned = new Map<string, HasAnchor>();
  /** For each anchor of a `:has()` that asks what an element holds only of
   *  the elements its subject can be (`'g'`), those subjects, as stable
   *  compounds (`Cascade.treeChange`). */
  private _held = new Map<HasAnchor, Set<string>>();
  /** Every class's, and every id's, for a change whose old value is not
   *  known: what any class a selector tests can reach. */
  anyClass = 0;
  anyId = 0;
  anyClassPseudo: 0 | 1 | 2 = 0;
  /** Which pseudo-elements' rules can answer otherwise for a change to the
   *  tree: those that test what an element holds or where it sits, that
   *  have a sibling combinator or that have a `:has()`
   *  (`TreeReach.pseudo`). */
  treePseudo: 0 | 1 | 2 = 0;
  anyIdPseudo: 0 | 1 | 2 = 0;
  readonly anyClassAnchors = new Set<HasAnchor>();
  readonly anyIdAnchors = new Set<HasAnchor>();
  /** Every `:has()`'s anchor, for a change to what an element holds, which
   *  any of them may ask of whatever was added or taken away. */
  readonly everyAnchor = new Set<HasAnchor>();
  /** Whether a `:has()` is in any rule, and whether one is where what a
   *  change reaches cannot be said (`ANYWHERE_ANCHOR`). */
  asksHas = false;
  hasAnywhere = false;
  /** Whether a sibling combinator is in a selector outside a `:has()`: a
   *  child added or taken away is another element's earlier sibling. */
  siblings = false;
  /** What of the compounds a `~` follows, and of those it leads to from
   *  each, no change to the tree can change (`stableCompound`): what a
   *  child whose answer changed has to be, and what a later sibling of it,
   *  for that sibling's answer to change with it; `'*'` and null for any
   *  element. And the same of a `+`, whose later sibling is the next. */
  readonly tilde = new Map<string, Set<string> | null>();
  readonly plus = new Map<string, Set<string> | null>();
  /** Whether a rule reaches across a shadow tree's edge (`noteEdge`), so
   *  that what a change reaches below an element is what is below it in
   *  its shadow tree and in its slots too (`HtmlViewNode._scopeOf`). */
  crossesTrees = false;

  /** A rule's selector — its origin's, for a pseudo-element's (`pseudo`
   *  1 for a `::before`'s or an `::after`'s, 2 for any other's) — and the
   *  attributes its declarations read with `attr()`. */
  note(
    selector: string,
    pseudo: 0 | 1 | 2,
    declarations: readonly Declaration[],
  ): void {
    this._scan(selector, pseudo, declarations, 0);
  }

  /**
   * A rule at a shadow tree's edge (`Cascade._addScoped`): a `:host`, a
   * `:host()` or a `:host-context()`, which a tree's rule tests of the host
   * and of what is around it, a `::slotted()`, of what the host's slots
   * are given, and a `::part()`, which a rule outside a tree tests of what
   * is in it. Where each compound is tested is across an edge from where
   * the rule's subject is, so every key it tests is taken to reach the
   * element it is tested of and everything below it, across those edges
   * as well — more than it may, never less — and each function read as
   * the `:is()` its argument is matched as.
   */
  noteEdge(
    selector: string,
    pseudo: 0 | 1 | 2,
    declarations: readonly Declaration[],
  ): void {
    this.crossesTrees = true;
    const read = selector.replace(
      /::?(?:host-context|host|slotted)\(/gi,
      ':is(',
    );
    // a `::part()`'s names are its element's `part`, which no style-only
    // attribute is: a change of it restyles its element and what is in it
    this._scan(
      read.replace(/::part\([^)]*\)/gi, ''),
      pseudo,
      declarations,
      CHANGES_SELF | CHANGES_BELOW,
    );
  }

  /** `note`, every key's bits, and every anchor's place, widened by
   *  `wider`. */
  private _scan(
    selector: string,
    pseudo: 0 | 1 | 2,
    declarations: readonly Declaration[],
    wider: number,
  ): void {
    const note: NoteChange = (
      key,
      narrow,
      anchor,
      subject,
      where,
      tests,
      parent,
    ) => {
      if (pseudo > this.treePseudo && (anchor || TREE_KEYS.has(key))) {
        this.treePseudo = pseudo;
      }
      if (key === '+' || key === '~') {
        this.siblings = true;
        const pairs = key === '~' ? this.tilde : this.plus;
        const lead = wider || !where ? '*' : where;
        const trail = wider || !subject || subject === '*' ? null : subject;
        const trails = pairs.get(lead);
        if (trail === null) pairs.set(lead, null);
        else if (trails === undefined) pairs.set(lead, new Set([trail]));
        else trails?.add(trail);
        return;
      }
      // a rule at a tree's edge reaches past what its selector says, and
      // asks what an element holds of all of it
      if (key === 'g' && wider) key = 's';
      if (key[0] === 'v' && key[1] === ':') {
        const name = key.slice(2, key.indexOf('\u0000'));
        let tests = this._tests.get(name);
        if (!tests) this._tests.set(name, (tests = new Set()));
        tests.add(key);
      }
      const isClass = key[0] === 'c' && key[1] === ':';
      const isId = key[0] === 'i' && key[1] === ':';
      // in a `:has()`'s argument, a key reaches the elements whose answer
      // to it changed, and where it is in the argument says nothing
      let bits = wider | (anchor ? 0 : narrow);
      if (anchor) {
        this.asksHas = true;
        if (anchor.at & CHANGES_ANYWHERE) {
          this.hasAnywhere = true;
          bits |= CHANGES_ANYWHERE;
        } else {
          const one = this._intern(anchor, wider);
          let set = this._anchors.get(key);
          if (!set) this._anchors.set(key, (set = new Set()));
          set.add(one);
          this.everyAnchor.add(one);
          if (key === 'g') {
            let subjects = this._held.get(one);
            if (!subjects) this._held.set(one, (subjects = new Set()));
            subjects.add(subject || '*');
          }
          if (isClass) this.anyClassAnchors.add(one);
          else if (isId) this.anyIdAnchors.add(one);
        }
      }
      if (bits) this._bits.set(key, (this._bits.get(key) ?? 0) | bits);
      // below the element it changes, a key tested above a subject reaches
      // what the subject can match; a rule at a tree's edge, or one whose
      // subject says nothing stable, reaches everything there
      const whole = !subject || subject === '*' || !!wider || !!anchor;
      if (bits & CHANGES_BELOW) noteReach(this._below, key, subject, whole);
      // and among its later siblings, and in them, from before a `+` or a
      // `~`: `#nav.dark ~ #curtain` is one element, where a class of the
      // local nav on Apple's pages restyled all that came after it
      if (bits & CHANGES_LATER) noteReach(this._later, key, subject, whole);
      // and of what holds what came or went, or of its children, which
      // elements its compound names
      if (key === 's' || key === 'h') {
        this._noteTested(bits, tests, where, parent, !!wider || !!anchor);
      }
      if (isClass) {
        this.anyClass |= bits;
        if (pseudo > this.anyClassPseudo) this.anyClassPseudo = pseudo;
      } else if (isId) {
        this.anyId |= bits;
        if (pseudo > this.anyIdPseudo) this.anyIdPseudo = pseudo;
      }
      if (pseudo > (this._pseudo.get(key) ?? 0)) this._pseudo.set(key, pseudo);
    };
    const parts = compoundsOf(selector);
    const subject =
      parts.length > 1 ? stableCompound(parts[parts.length - 1].text) : null;
    scanChanges(selector, CHANGES_SELF, null, note, '', subject);
    for (const declaration of declarations) {
      if (!declaration.value.includes('attr(')) continue;
      for (const m of declaration.value.matchAll(ATTR_FUNCTION)) {
        // a name a `var()` gives, or one in a namespace, which the element
        // holds under a prefix of its own, could be any attribute's
        const name = /[|(]/.test(m[1]) ? '*' : asciiLower(m[1]);
        note(`a:${name}`, CHANGES_SELF, null);
      }
    }
  }

  /**
   * A test of what an element holds or where it sits, into `tested`: of
   * the holder of what came or went, for one of what an element holds, or
   * of its children, for one of where an element sits; for the element's
   * own style, or for what is below it. By the compound it is in, and for
   * a child in a rule's subject the one a child combinator leads to it
   * from as well, which the holder has to match; or any, where it says
   * none, is no such test, or is wider than its selector.
   */
  private _noteTested(
    bits: number,
    tests: Tests | undefined,
    where: string | null | undefined,
    parent: string | null | undefined,
    wider: boolean,
  ): void {
    for (const [bit, at] of [
      [CHANGES_SELF, 'self'],
      [CHANGES_BELOW, 'below'],
      [CHANGES_LATER, 'later'],
    ] as const) {
      if (!(bits & bit)) continue;
      if (!tests || wider) {
        this._tested.set(`${at} holder`, null);
        this._tested.set(`${at} kid`, null);
        continue;
      }
      const who = tests === 'holds' ? 'holder' : 'kid';
      const named = where && where !== '*' ? where : null;
      // a child a combinator leads to is one of what the compound it leads
      // from names: as a selector of the two, matched of the child.
      // `.group > :first-child .button` and Wikipedia's
      // `table.mw-collapsible :first-child tr` ask nothing of a `<body>`'s
      // children, and every child put in the `<body>` reached all of it
      const from = who === 'kid' ? parent : null;
      const one = from ? `${from}${named ?? '*'}` : named;
      const key = `${at} ${who}`;
      const kept = this._tested.get(key);
      if (kept === null) continue;
      if (!one) this._tested.set(key, null);
      else if (kept) kept.add(one);
      else this._tested.set(key, new Set([one]));
    }
  }

  /** The one anchor like `anchor`, its place widened by `wider`. */
  private _intern(anchor: HasAnchor, wider: number): HasAnchor {
    const at = anchor.at | wider;
    // a rule at a tree's edge reaches past what its subject says
    const subject = wider ? undefined : anchor.subject;
    const id = `${at} ${+anchor.siblings} ${anchor.levels ?? ''} ${anchor.compound}\u0000${subject ?? ''}`;
    let one = this._interned.get(id);
    if (!one) {
      one = { ...anchor, at, subject };
      this._interned.set(id, one);
    }
    return one;
  }

  /** Where a key is tested, as `CHANGES_*` bits; 0 for nowhere. */
  bits(key: string): number {
    return this._bits.get(key) ?? 0;
  }

  /** The subjects a key's reach below the element it changes can
   *  restyle, as stable compounds; null for everything there. */
  below(key: string): ReadonlySet<string> | null {
    return this._below.get(key) ?? null;
  }

  /** What a key tested before a sibling combinator can restyle among the
   *  later siblings of the element it changes, and in them, or null for
   *  all that is there. */
  later(key: string): ReadonlySet<string> | null {
    return this._later.get(key) ?? null;
  }

  /**
   * Which elements a test of what an element holds or where it sits can
   * change the answer of, to their own style (`self`), to what is below
   * them (`below`) or to their later siblings (`later`): of the holder of
   * what came or went (`holder`), or of its children (`kid`). Stable
   * compounds, a child's with the one its parent is to match before it;
   * null for any element, and undefined for none.
   */
  tested(
    at: 'self' | 'below' | 'later',
    who: 'holder' | 'kid',
  ): ReadonlySet<string> | null | undefined {
    return this._tested.get(`${at} ${who}`);
  }

  /** The anchors of the `:has()`s whose argument tests a key. */
  anchors(key: string): ReadonlySet<HasAnchor> | undefined {
    return this._anchors.get(key);
  }

  /** The anchors a child put in or taken out reaches only where what came
   *  or went holds an element one of its subjects names (`'g'`), with
   *  those subjects — less the ones another `:has()` with the same anchor
   *  asks anything of what an element holds (`'s'`), which it reaches
   *  whatever came. */
  held(): ReadonlyMap<HasAnchor, ReadonlySet<string>> {
    const sits = this._anchors.get('s');
    if (sits) for (const anchor of sits) this._held.delete(anchor);
    return this._held;
  }

  /** The attribute selectors that test an attribute, as `v:` keys. */
  tests(name: string): ReadonlySet<string> | undefined {
    return this._tests.get(name);
  }

  /** The pseudo-elements whose rules test a key: 0 none, 1 a `::before`
   *  or an `::after` only, 2 another. */
  pseudo(key: string): 0 | 1 | 2 {
    return this._pseudo.get(key) ?? 0;
  }
}

/**
 * The `:has()`s a change can change the answer to (`Cascade.
 * attributeChange`, `treeChange`), for the elements around it to be asked
 * whether they are one's (`at`), and whether any asks what is after its
 * element (`siblings`), which says which elements those are
 * (`HtmlViewNode`'s `spreadAnchors`). An element is asked only about the
 * anchors its id or one of its classes could match (`anchorKey`), and
 * those that need neither: a treeChange asks every `:has()` in the sheets.
 */
export class ChangeAnchors {
  readonly siblings: boolean;
  /** How far above what changed the elements whose answers it changed can
   *  be: the most of the anchors' `levels`, or Infinity where one has
   *  none. */
  readonly levels: number;
  /** Each anchor's matcher and place, by the id or the class an element
   *  has to have to match it, compiled when an element is first asked
   *  about; null where one cannot be. */
  private _byKey: Map<string, AnchorMatcher[]> | null | undefined = undefined;
  private _rest: AnchorMatcher[] = [];

  constructor(
    private readonly _anchors: readonly HasAnchor[],
    private readonly _compile: (
      anchor: HasAnchor,
    ) => ((el: Element) => boolean) | null,
    private readonly _compileSubject: (
      subject: string,
    ) => ((el: Element) => boolean) | null,
  ) {
    this.siblings = _anchors.some((a) => a.siblings);
    this.levels = Math.max(..._anchors.map((a) => a.levels ?? Infinity));
  }

  /** The places (`CHANGES_*`) of the anchors whose compound `el` matches,
   *  `distance` levels above what changed, or fewer: 0 for none, null
   *  where a compound cannot be asked. `beside` is for an element that is
   *  no ancestor of what changed, an earlier sibling of what is, which
   *  only an anchor that starts at a sibling can answer otherwise for:
   *  Apple's `.section:has(.all-access-pass)` is asked of the sections
   *  around a change for no reason but that a card's `:has(~ .card-control)`
   *  is among the anchors, and every section was built again for it.
   *  What a `:has()` above its rule's subject reaches in `el` is what that
   *  subject names, each into `subjects`, and is no bit: Apple's
   *  `:has(>.caption-primary) .caption` is asked of the `<body>` at every
   *  change to what it holds, and all that is in it was styled again. */
  at(
    el: Element,
    distance = 0,
    beside = false,
    subjects: Set<(el: Element) => boolean> | null = null,
  ): number | null {
    if (this._byKey === undefined) this._prepare();
    const byKey = this._byKey;
    if (!byKey) return null;
    let bits = 0;
    const ask = (list: readonly AnchorMatcher[] | undefined): void => {
      if (!list) return;
      for (const { match, at, levels, siblings, subject } of list) {
        if (beside && !siblings) continue;
        if ((bits | at) === bits || distance > levels) continue;
        const narrowed = subject && subjects && at === CHANGES_BELOW;
        if ((!narrowed || !subjects.has(subject)) && match(el)) {
          if (narrowed) subjects.add(subject);
          else bits |= at;
        }
      }
    };
    const id = el.attribs.id;
    if (id) ask(byKey.get(`#${id}`));
    for (const name of classesOf(el.attribs.class ?? null)) {
      ask(byKey.get(`.${name}`));
    }
    ask(this._rest);
    return bits;
  }

  private _prepare(): void {
    const byKey = new Map<string, AnchorMatcher[]>();
    for (const anchor of this._anchors) {
      const match = this._compile(anchor);
      if (!match) {
        this._byKey = null;
        return;
      }
      const key = anchorKey(anchor.compound);
      const one = {
        match,
        at: anchor.at,
        levels: anchor.levels ?? Infinity,
        siblings: anchor.siblings,
        subject:
          anchor.subject !== undefined
            ? this._compileSubject(anchor.subject)
            : null,
      };
      if (!key) {
        this._rest.push(one);
        continue;
      }
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      list.push(one);
    }
    this._byKey = byKey;
  }
}

interface AnchorMatcher {
  match: (el: Element) => boolean;
  at: number;
  levels: number;
  siblings: boolean;
  /** What it can restyle in its element (`HasAnchor.subject`); null for
   *  all that is there. */
  subject: ((el: Element) => boolean) | null;
}

/** What a change to an element's attribute reaches, from the element
 *  (`Cascade.attributeChange`). */
export interface AttributeReach {
  bits: number;
  pseudo: 0 | 1 | 2;
  anchors: ChangeAnchors | null;
  /** What a reach below the element can restyle there, as one matcher of
   *  the subjects of the rules that test the change; null for everything
   *  there. */
  below: ((el: Element) => boolean) | null;
  /** And among the element's later siblings and what they hold, for a
   *  reach of them. */
  later: ((el: Element) => boolean) | null;
}

/** What a change to what an element holds reaches, from the element
 *  (`Cascade.treeChange`). */
export interface TreeReach {
  bits: number;
  /** Whether what came or went reaches the holder's children and what is
   *  in them, past `bits`: a test of where an element sits that a sibling
   *  combinator follows, which asks how all the children line up. */
  kidsLater: boolean;
  /** Whether it reaches the children after where it came or went and what
   *  is in them: a sibling combinator, which reads an element's earlier
   *  siblings and no later one. */
  followers: boolean;
  /** Which of the children after where it came or went `followers` and
   *  `kidsLater` reach, by what the sibling combinators follow and lead to
   *  (`MutationRules.tilde`, `plus`); null for every one of them, with
   *  what is in them. */
  siblings: SiblingReach | null;
  /** Where `bits` reach the holder and its children themselves, which of
   *  them a test of what an element holds or where it sits in a rule's
   *  subject can change; null for every one. */
  self: TreeTested | null;
  /** Where `bits` reach below: from which of them a test of that above a
   *  subject reaches, and what there it can restyle (`subjects`, null for
   *  anything); null for everything in the holder. */
  below: TreeBelow | null;
  /** Where `kidsLater` reaches from: the children a test of where an
   *  element sits before a sibling combinator is of, by the compound it is
   *  in, whose later siblings are what it reaches — `.card:first-child:
   *  nth-last-child(2) ~ .card` changes nothing in a holder of no `.card`.
   *  True for any child. */
  later: Tested;
  anchors: ChangeAnchors | null;
  /** Which pseudo-elements' rules it can change the answer to, which a
   *  restyle compares no style of (`HtmlViewNode._seedsThatMoved`). */
  pseudo: 0 | 1 | 2;
}

/** Which elements a test reaches (`TreeTested`): those a matcher takes,
 *  every one, or none. */
export type Tested = ((el: Element) => boolean) | boolean;

/**
 * `TreeReach.siblings`: what of the compounds the sibling combinators
 * follow (`lead`) and lead to from them (`trail`) no change to the tree
 * can change (`MutationRules.tilde`, `plus`). A `~` reaches the children
 * after one it follows whose answer changed that it leads to from it; a
 * `+`, the child after it, where it leads to that. Apple's forms style
 * `:checked ~ .form-label`, its cards `.headline + *` and its page
 * `#ac-ln-menustate:checked ~ #main`, and a banner put in at the top of a
 * `<body>` restyled all of it.
 */
export interface SiblingReach {
  tilde: readonly SiblingPair[];
  plus: readonly SiblingPair[];
}

export interface SiblingPair {
  lead: Tested;
  trail: Tested;
}

/** `TreeReach.self`: of the holder of what came or went, and of each of its
 *  children, which a test can change the answer for. */
export interface TreeTested {
  holder: Tested;
  kids: Tested;
}

/** `TreeReach.below`. */
export interface TreeBelow extends TreeTested {
  subjects: ((el: Element) => boolean) | null;
}

/** What children put in at the end of an element reach, from where
 *  (`Cascade.appendChange`). */
export interface AppendReach {
  empty: number;
  blank: number;
  text: number;
  last: number;
  every: number;
  anchors: ChangeAnchors | null;
  /** As `TreeReach.pseudo`. */
  pseudo: 0 | 1 | 2;
}

/** An element of one attribute, under each of `names`, or of none, for an
 *  attribute selector to be asked about (`Cascade._flips`). */
function holding(names: readonly string[], value: string | null): Element {
  const attribs: Record<string, string> = {};
  if (value !== null) for (const name of names) attribs[name] = value;
  return new DomElement('div', attribs);
}

/** An id (`#…`) or a class (`.…`) an element has to have to match a
 *  compound — its id where it names one — or '' where it needs neither. */
function anchorKey(compound: string): string {
  let found = '';
  let i = 0;
  while (i < compound.length) {
    const c = compound[i];
    if (c === '\\') i = escapeEnd(compound, i);
    else if (c === '[') i = bracketEnd(compound, i) + 1;
    else if (c === '(') i = closeOf(compound, i) + 1;
    else if (c === '#' || c === '.') {
      const name = readIdent(compound, i + 1);
      if (name.value && c === '#') return `#${name.value}`;
      if (name.value && !found) found = `.${name.value}`;
      i = Math.max(name.end, i + 1);
    } else i += 1;
  }
  return found;
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
  /** The media queries over what is no rule of an index here — a
   *  `@keyframes`, a rule at a shadow tree's edge — which a width that
   *  turns one of them changes in ways `crossed` does not look for. Those
   *  that turn on no width a resize moves through are no matter: GitHub
   *  keeps its `@keyframes` under `prefers-reduced-motion`, and every
   *  breakpoint a drag crossed styled the whole page again. */
  private _mediaOutsideRules: MediaCondition[][][] = [];
  /** …and those over a `@keyframes`, read from the sheets by each cascade. */
  private _keyframeMedia: MediaCondition[][][] = [];
  /** The rules for pseudo-elements, kept apart: they never style the
   *  element itself, and a document with none of them asks nothing. */
  private _pseudo: Record<PseudoElement, RuleIndex> = {
    before: new RuleIndex(true),
    after: new RuleIndex(true),
    'first-letter': new RuleIndex(true),
    'first-line': new RuleIndex(true),
    marker: new RuleIndex(true),
    selection: new RuleIndex(true),
    placeholder: new RuleIndex(true),
    scrollbar: new RuleIndex(true),
    backdrop: new RuleIndex(true),
    'details-content': new RuleIndex(true),
  };
  /** The rules for each custom highlight's `::highlight()`, by its name
   *  (CSS Highlight API 1, 3): a document with none asks nothing. */
  private _highlights = new Map<string, RuleIndex>();
  /** The rules for a view transition's pseudo-elements, by their
   *  originating element, each part's own (`TRANSITION_PARTS`). */
  private _transitionRules = new RuleIndex(true);
  /** The `@keyframes` a view transition under way makes, each group's
   *  from where its element was to where it is (CSS View Transitions 1,
   *  7.8), found before any sheet's. */
  transitionKeyframes: ReadonlyMap<string, KeyframesRule> | null = null;
  /** The author's rules that could style a shape in a drawing: the ones
   *  that declare a property a shape has (`shapes.ts`) and whose subject
   *  is no element of HTML's alone. They are in `_index` too, for the
   *  elements that have boxes; these are asked of the ones in an inline
   *  `<svg>`, which have none (`shapeStyles`). */
  private _shapes = new RuleIndex();
  private _shapeNeeds: ShapeNeeds | null = null;
  private _adapter!: CssSelectAdapter;
  /** The rules of the indexes by id, for `matchedRules`, made once asked. */
  private _rulesById: Map<number, IndexedRule> | null = null;
  /** The sheets it was made from, the document's and the shadow trees',
   *  for what a developer's tools ask of them… */
  private readonly _sheets: readonly Stylesheet[];
  /** …and where each rule of them came from, made once asked. */
  private _sourceOf: Map<StyleRule, SheetSource> | null = null;
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
  private _copyAdapter!: CssSelectAdapter;
  /** What the selectors that test the pointer, and the ones that test the
   *  focus, say of the elements a change of it reaches. */
  private _hoverRules = new StateRules(HOVER_STATE);
  private _focusRules = new StateRules(FOCUS_STATE);
  /** …and the ones that test what a change to the DOM can change
   *  (`attributeChange`, `treeChange`). */
  private _changeRules = new MutationRules();
  /** The sheets those three have read. */
  private _noted = new Set<Stylesheet>();
  /** The sheets whose rules are in the indexes, by the tree they are filed
   *  under (`_stillHolds`). */
  private _filed = new Map<Stylesheet, TreeRules>();
  /** The rules filed by this cascade, in `_index` and `_pseudo`: all of
   *  them, or those it added to the indexes it took over (`addedReach`). */
  private _latest: IndexedRule[] = [];
  /** Each rule of the indexes made from a sheet's under another selector,
   *  followed by the sheet's: its place in the cascade is the sheet's rule's,
   *  which a sheet put in before it moves (`_takeOver`). */
  private _restated: StyleRule[] = [];
  /** The cascade in force, which the matchers ask for the pointer, the focus
   *  and the target: one is compiled once, and may outlive the cascade it
   *  was compiled for (`_takeOver`). */
  private _current: { cascade: Cascade } = { cascade: this };
  /** What `attributeChange` asks: each attribute selector compiled alone
   *  (`_flips`), each anchor's compound, and each set of anchors as one. */
  private _attributeTests = new Map<
    string,
    ((el: Element) => boolean) | null
  >();
  private _anchorMatchers = new Map<
    HasAnchor,
    ((el: Element) => boolean) | null
  >();
  private _anchorSets = new WeakMap<ReadonlySet<HasAnchor>, ChangeAnchors>();
  private _pointer: PointerState = NO_POINTER;
  private _focus: FocusState = NO_FOCUS;
  private _target: Element | null = null;
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
  /** Whether the host runs the document's scripts: what a `scripting`
   *  media query is answered from (`<Html scripting>`). */
  scripting = false;
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
  private _treesAt = -1;
  /** Whether there is a shadow tree to tell an element's from the
   *  document's: where there is none, nothing asks which tree an element
   *  is in, and a document styles as it did before there were any. */
  private _scoped = false;
  /** Whether a rule says something across a shadow tree's edge — `:host`,
   *  `::slotted()`, `::part()` — which the change index does not hold, so
   *  what a change reaches cannot be said (`attributeChange`). */
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
  /** The animations the page's scripts made (`Element.animate()`), which
   *  run on `timeline`'s clock where it is given and are drawn at rest
   *  where it is not, as a CSS animation is. */
  scripts: ScriptAnimations | null = null;

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
  /**
   * Whether a style holds a length in a unit of the viewport's width —
   * `vw`, `vmin`, `vmax` — or of its height, `vh` and the same two: a style
   * holds such a length as a number, so it is computed again when that
   * side of the viewport moves (`HtmlViewNode._update`). Or whether a
   * `@media` rule tests the viewport's height or its aspect ratio, which a
   * resize that crosses no breakpoint changes too.
   *
   * A length is noted as it is resolved (`_viewportRead`), for the styles
   * computed since a build styled every element (`beginSharing`), and not
   * as a sheet mentions one: Wikipedia's skin has a `75vw` under a class
   * its pages are not served with, and noted from the sheet, every pixel of
   * a resize styled the whole article again and built its boxes again.
   */
  get readsViewportWidth(): boolean {
    return this._queriesWidth || this._heldWidth || this._mediaWidth;
  }
  get readsViewportHeight(): boolean {
    return this._queriesHeight || this._heldHeight || this._mediaHeight;
  }
  /**
   * Whether what reads that side of the viewport is something no style
   * holds and no media band says — a container query's length in a
   * viewport unit — so that a move of it can change what any element
   * matches, and every style is computed again. Where it is not, the
   * styles to compute again are those that hold a length of it
   * (`viewportReaders`), and the rules a `@media` on the height or the
   * aspect ratio turns on or off (`mediaBand`, `crossed`).
   */
  get queriesViewportWidth(): boolean {
    return this._queriesWidth;
  }
  get queriesViewportHeight(): boolean {
    return this._queriesHeight;
  }
  private _queriesWidth = false;
  private _queriesHeight = false;
  /** Whether a `@media` rule tests the viewport's height, or its aspect
   *  ratio, which its width moves too: the conditions that do
   *  (`Stylesheet.sized`). */
  private _mediaWidth = false;
  private _mediaHeight = false;
  private _sized: MediaCondition[] = [];
  private _heldWidth = false;
  private _heldHeight = false;
  /** The sides of the viewport read since the style being computed began
   *  (`_computeStyle`): `VIEWPORT_WIDTH`, `VIEWPORT_HEIGHT`. */
  private _sidesRead = 0;
  /** The elements one of whose pseudo-elements' styles held a length of
   *  the viewport, with the sides: a style kept for a pseudo-element is
   *  kept by its element's (`pseudoStyleFor`), so the element is what is
   *  styled again. */
  private _pseudoSides = new Map<Element, number>();
  /** What of the root element's font the document reads (`ROOT_FONT_SIZE`,
   *  `ROOT_LINE_HEIGHT`): a length in `rem` or `rlh`, in a style or in what
   *  a container query compares (`remRead`, `rlhRead`) — and whether this
   *  build found what it reads moved: then no style is kept, since one far
   *  from the root reads it. */
  private _rootRead = 0;
  private _rootMoved = false;
  /** What of the root's the style being computed read (`_computeStyle`),
   *  noted on it (`ROOT_READS`), as `_sidesRead` is. */
  private _rootBits = 0;
  /** The elements one of whose pseudo-elements' styles read the root's
   *  font, and those a container query of whose compared a length that
   *  does, with what each read: what is styled again when it moves
   *  (`rootReaders`), the element being what keeps both. */
  private _pseudoRoot = new Map<Element, number>();
  private _queryRoot = new Map<Element, number>();
  private _remRead = (): void => {
    this._rootRead |= ROOT_FONT_SIZE;
    this._rootBits |= ROOT_FONT_SIZE;
  };
  private _rlhRead(): void {
    this._rootRead |= ROOT_LINE_HEIGHT;
    this._rootBits |= ROOT_LINE_HEIGHT;
  }
  /** Whether a length in the style being computed was read from a face
   *  (`FACE_READS`), as `_sidesRead` is. */
  private _faceRead = false;
  private _viewportRead = (unit: 'vw' | 'vh' | 'vmin' | 'vmax'): void => {
    if (unit !== 'vh') {
      this._heldWidth = true;
      this._sidesRead |= VIEWPORT_WIDTH;
    }
    if (unit !== 'vw') {
      this._heldHeight = true;
      this._sidesRead |= VIEWPORT_HEIGHT;
    }
  };
  /** A viewport unit in a container query's length: read as rules are
   *  matched, before any style is, so one that moves can change what any
   *  element matches (`queriesViewportWidth`). */
  private _queryViewportRead = (unit: 'vw' | 'vh' | 'vmin' | 'vmax'): void => {
    if (unit !== 'vh') this._queriesWidth = true;
    if (unit !== 'vw') this._queriesHeight = true;
  };

  /**
   * The elements whose styles hold a length of a side of the viewport in
   * `sides`, among `styles` — a build's — with the elements whose
   * pseudo-elements' do: what a move of that side changes, where nothing
   * else reads it (`queriesViewportWidth`). An element under one is
   * computed again only where its parent's style came out other than it
   * was (`KeptStyles.follow`), as a font size of `2vw` hands on. Python's
   * documentation sets a `vw` on a few elements, and each pixel of a drag
   * styled all 19,680 of them again, 46% of a frame.
   */
  /** Whether a style holds a length of a side of the viewport in `sides`:
   *  the root box's, which belongs to no element and is computed again in
   *  every build. */
  holdsViewport(style: ComputedStyle, sides: number): boolean {
    return ((VIEWPORT_SIDES.get(style) ?? 0) & sides) !== 0;
  }

  /** Whether a pseudo-element's style holds a length of those sides of
   *  the viewport (`_pseudoSides`), which its element's restyle in place
   *  does not make again. */
  pseudoReadsViewport(sides: number): boolean {
    for (const read of this._pseudoSides.values())
      if (read & sides) return true;
    return false;
  }

  viewportReaders(
    styles: ReadonlyMap<Element, { style: ComputedStyle }>,
    sides: number,
  ): Set<Element> {
    const readers = new Set<Element>();
    for (const [el, { style }] of styles) {
      if ((VIEWPORT_SIDES.get(style) ?? 0) & sides) readers.add(el);
    }
    for (const [el, read] of this._pseudoSides) {
      if (read & sides) readers.add(el);
    }
    return readers;
  }

  /** What of the root element's font some style of the document, or some
   *  container query, reads (`ROOT_FONT_SIZE`, `ROOT_LINE_HEIGHT`). */
  get readsRoot(): number {
    return this._rootRead;
  }

  /**
   * The elements among `styles` — a build's — that read what `bits` names
   * of the root element's font: whose style holds a length in `rem` or
   * `rlh`, whose pseudo-element's does, or a container query of whose
   * compares one (`_queryRoot`). What a move of the root's font changes
   * wherever it is, where an element is otherwise styled again only where
   * its parent's style moved (`KeptStyles.follow`): a `<body>` with a size
   * of its own keeps every `rem` under it from hearing of the root's.
   */
  rootReaders(
    styles: ReadonlyMap<Element, { style: ComputedStyle }>,
    bits: number,
  ): Set<Element> {
    const readers = new Set<Element>();
    if (!(this._rootRead & bits)) return readers;
    for (const [el, { style }] of styles) {
      if ((ROOT_READS.get(style) ?? 0) & bits) readers.add(el);
    }
    for (const notes of [this._pseudoRoot, this._queryRoot]) {
      for (const [el, read] of notes) {
        if (read & bits && styles.has(el)) readers.add(el);
      }
    }
    return readers;
  }

  /** Whether a pseudo-element's style reads what `bits` names of the
   *  root's font, which its element's restyle in place does not make
   *  again (`pseudoReadsViewport`). */
  pseudoReadsRoot(bits: number): boolean {
    for (const read of this._pseudoRoot.values()) if (read & bits) return true;
    return false;
  }

  /** What of the root element's font differs between two of its styles,
   *  of what the document reads of it: its size, a `rem`; its line height,
   *  an `rlh`, which its size moves where it is `normal` or a number. */
  rootMetricsMoved(was: ComputedStyle, now: ComputedStyle): number {
    let moved = 0;
    const read = this._rootRead;
    if (read & ROOT_FONT_SIZE && was.fontSize !== now.fontSize) {
      moved |= ROOT_FONT_SIZE;
    }
    if (
      read & ROOT_LINE_HEIGHT &&
      this._lineHeightOf(was) !== this._lineHeightOf(now)
    ) {
      moved |= ROOT_LINE_HEIGHT;
    }
    return moved;
  }
  /**
   * What an `if()` asks beyond the element's custom properties (`vars.ts`):
   * a `media()` is answered for the viewport, and read as a `vmin` is, so a
   * style that took a branch by one is computed again when the viewport
   * moves; a `supports()` as a `@supports` block's condition is.
   */
  private _ifEnv: IfEnvironment = {
    media: (query) => {
      this._viewportRead('vmin');
      let conditions = this._ifMedia.get(query);
      if (!conditions) {
        conditions = parseMediaQuery(query);
        this._ifMedia.set(query, conditions);
      }
      return mediaMatches(
        [conditions],
        this.viewportWidth / this.scale,
        this.look.colorScheme,
        this.viewportHeight / this.scale,
        this.scale,
        this.reducedMotion,
        this.scripting,
      );
    },
    supports: (condition) => supportsCondition(condition) !== false,
    fn: (name) => this._functionNamed(name),
    matches: matchesSyntax,
  };
  private _ifMedia = new Map<string, MediaCondition[]>();
  /** The document's `@function` rules by name, in the order written; null
   *  for a document with none. */
  private _functions: Map<string, FunctionRule[]> | null = null;
  /** Whether any tree has a `@position-try` rule (`TreeRules`). */
  private _positionTries = false;
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
  /** The element whose style is being computed (`_cascadeStyle`). */
  private _styling: Element | null = null;
  /** Its attribute of a name, for an `attr()` (`IfEnvironment.attribute`,
   *  `attributeIn`). */
  private _attributeOf = (
    name: string,
    namespace?: string | null,
  ): string | undefined => attributeIn(this._styling, name, namespace);
  private _lh = false;
  /** The properties the user agent's sheet declares (`UnitContext.uaSets`). */
  private _uaProps = new Set<string>();
  private _uaSets = (name: string): boolean => {
    const props = this._uaProps;
    if (props.has(name)) return true;
    // a shorthand over it, or a longhand of it, the UA sheet sets
    for (let at = name.indexOf('-'); at > 0; at = name.indexOf('-', at + 1)) {
      if (props.has(name.slice(0, at))) return true;
    }
    for (const p of props) if (p.startsWith(`${name}-`)) return true;
    return false;
  };
  /** Whether a declaration anywhere sets `scroll-snap-type`: what makes a
   *  layout ask whether a snap container is at rest where it should be
   *  (`HtmlViewNode._resnap`). */
  snaps = false;
  /** Whether a declaration anywhere sets `zoom`, which only then is looked
   *  for ahead of an element's other declarations (`_ownZoom`). */
  private _zoom = false;
  /** Whether any sheet or `style` attribute declares a writing mode: what
   *  the writing mode and the direction are applied ahead of the rest for
   *  (`_cascadeStyle`), so that a logical property among them maps by the
   *  element's own, wherever it is declared (CSS Writing Modes 4, 6.4). */
  private _writing = false;
  /** The pseudo-classes css-select is handed: `:root` this cascade's, and
   *  the focus's three answered from `_focus`. */
  private _pseudos!: typeof PSEUDOS;
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
     *  `:target` (Selectors 4, 9.1): an SVG image's, `image.svg#icon`. A
     *  document's moves with its URL (`setTarget`). */
    target: Element | null = null,
    /** The shadow trees' sheets, a set for each way they read: what each
     *  styles is in the trees bound to it (`bindShadows`). */
    shadows: readonly ShadowSheets[] = [],
    /** The cascade this one takes over from: its reading of its sheets
     *  (`_noted`), and its indexes where it holds nothing that has gone
     *  (`_takeOver`). */
    before: Cascade | null = null,
  ) {
    this._sheets = [...sheets, ...shadows.flatMap((tree) => tree.sheets)];
    const takes = before !== null && before._stillHolds(sheets, shadows);
    // What a rule says it tests is the same in every cascade it is in, and
    // reading that is most of what making one costs: a page that links five
    // sheets late read every rule of all of them for each, a second of
    // GitHub's load. A reading only ever says more, and what a rule that
    // has gone left in it reaches more than it need, never less, so it is
    // kept but for a few sheets gone.
    if (
      before &&
      (takes || before._noted.size <= this._sheets.length + SHEETS_GONE)
    ) {
      this._hoverRules = before._hoverRules.rebound();
      this._focusRules = before._focusRules.rebound();
      this._changeRules = before._changeRules;
      this._noted = before._noted;
    }
    this._target = target;
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
    if (takes) this._takeOver(before);
    else this._makeMatchers(documentElement);
    const breakpoints = new Set<number>();
    const counterStyles = new Map<string, CounterStyleRule>();
    for (const sheet of sheets) {
      // a counter style's rule whole over any before it of its name
      for (const { prelude, declarations } of sheet.counterStyles ?? []) {
        const style = counterStyleRule(prelude, declarations);
        if (style) counterStyles.set(style.name, style.rule);
      }
      // and a registration, so: the last valid one for a name
      for (const { name, inherits, initial, syntax } of sheet.properties ??
        []) {
        (this._registered ??= new Map()).set(name, {
          inherits,
          initial,
          syntax,
        });
      }
      // and the functions, every one of a name: which one a call finds is
      // asked as it is made (`_functionNamed`)
      for (const rule of sheet.functions ?? []) {
        this._functions ??= new Map();
        let named = this._functions.get(rule.name);
        if (!named) this._functions.set(rule.name, (named = []));
        named.push(rule);
        if (rule.media || rule.readsMedia)
          this._ifEnv.functionsReadMedia = true;
      }
      this._addSheet(sheet, this._document, breakpoints);
    }
    if (this._registered) {
      // A registered property has its initial value where nothing sets it
      // (CSS Properties and Values 1, 2.4), which the root inherits from
      // the start, and one that does not inherit is reset to it under
      // anything that set it (`_customFor`). Unregistered, a `var()` of one
      // nobody sets is no value: a page that draws a gradient's stops from
      // `--blob-core`, registered at `0%` and set only on some elements,
      // drew no gradient on the rest.
      this._registeredBase = new CustomProps(null);
      // which every element has, whether or not anything sets one
      this._vars = true;
      for (const [name, { inherits, initial }] of this._registered) {
        if (initial !== null) this._registeredBase.own.set(name, initial);
        if (!inherits) (this._nonInherited ??= new Map()).set(name, initial);
      }
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

  /** What a matcher is compiled over: made before the sheets, whose rules
   *  at a shadow tree's edges are compiled as they are read (`_addScoped`),
   *  and reaching what they ask through `_current`, not `this`. */
  private _makeMatchers(documentElement: Element | null): void {
    const now = this._current;
    // css-select has none of the focus's three, and a pseudo-class is
    // handed only the element, so they are closures of the cascade's own
    this._pseudos = {
      ...PSEUDOS,
      ...(documentElement && {
        root: (el: Element) => el === documentElement,
      }),
      target: (el: Element) => el === now.cascade._target,
      focus: (el: Element) => now.cascade._focus.element === el,
      'focus-visible': (el: Element) =>
        now.cascade._focus.visible && now.cascade._focus.element === el,
      'focus-within': (el: Element) => now.cascade._focus.within.has(el),
    };
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
      isHovered: (el: Element) => now.cascade._pointer.hovered.has(el),
      isActive: (el: Element) => now.cascade._pointer.active.has(el),
      isVisited: () => false,
    };
    this._copyAdapter = {
      ...this._adapter,
      getParent: (el) =>
        el === now.cascade._copyTop ? null : DomUtils.getParent(el),
      getSiblings: (el) =>
        el === now.cascade._copyTop ? [el] : DomUtils.getSiblings(el),
      prevElementSibling: (el) =>
        el === now.cascade._copyTop ? null : DomUtils.prevElementSibling(el),
      isHovered: () => false,
      isActive: () => false,
    };
  }

  /**
   * Whether the indexes here hold nothing but what a cascade of `sheets` and
   * `shadows` would: every sheet filed in them is among those, for the tree
   * it is filed under. Each sheet is its parse (`_parseSheet`), so one that
   * reads otherwise, or was taken out, is not there, and one that moved from
   * a tree to another is under other rules' id.
   */
  private _stillHolds(
    sheets: readonly Stylesheet[],
    shadows: readonly ShadowSheets[],
  ): boolean {
    let held = 0;
    for (const sheet of sheets) {
      if (this._filed.get(sheet) === this._document) held += 1;
    }
    for (const { key, sheets: own } of shadows) {
      const rules = this._byKey.get(key);
      if (!rules) continue;
      for (const sheet of own) if (this._filed.get(sheet) === rules) held += 1;
    }
    return held === this._filed.size;
  }

  /**
   * The indexes of `before`, and all a walk of its rules left, for this
   * cascade to add the rules of its new sheets to: the rest of a sheet's
   * reading is done again from the sheet's short lists (`_addSheet`). A page
   * of 28,000 rules that puts in a sheet of two walked all of them, which
   * every chunk of GitHub's and YouTube's scripts did, some 60 ms each.
   *
   * It stands on three things. A rule's place in the cascade is read as it
   * is matched, from `order`, which `_restyle`'s `place` sets on the sheets'
   * own rules, so which bucket holds what in what order says nothing, and a
   * sheet may land anywhere: GitHub's land before the sheets in its `<body>`.
   * What was made from a rule under another selector has its own `order`,
   * put right here. A matcher reads what changes through `_current`, so it
   * can be kept with its index, compiled. And `before` is not asked again:
   * its indexes are this cascade's now.
   */
  private _takeOver(before: Cascade): void {
    this._index = before._index;
    this._pseudo = before._pseudo;
    this._highlights = before._highlights;
    this._transitionRules = before._transitionRules;
    this._shapes = before._shapes;
    this._filed = before._filed;
    this._restated = before._restated;
    this._mediaOutsideRules = before._mediaOutsideRules;
    this._document = before._document;
    this._docInfo = before._docInfo;
    this._byKey = before._byKey;
    this._nextTree = before._nextTree;
    this._scopedId = before._scopedId;
    this._scopedPseudos = before._scopedPseudos;
    // what an `IndexedRule.needs` it holds has noted
    this._askedIds = before._askedIds;
    this._askedClasses = before._askedClasses;
    this._uaProps = before._uaProps;
    this._vars = before._vars;
    this._lh = before._lh;
    this.snaps = before.snaps;
    this._zoom = before._zoom;
    this._writing = before._writing;
    this._adapter = before._adapter;
    this._copyAdapter = before._copyAdapter;
    this._pseudos = before._pseudos;
    this._current = before._current;
    this._current.cascade = this;
    const restated = this._restated;
    for (let i = 0; i < restated.length; i += 2) {
      restated[i].order = restated[i + 1].order;
    }
    // listed in the order of the sheets, which may have one between them now
    for (const rules of [this._document, ...this._byKey.values()]) {
      rules.keyframes.clear();
    }
  }

  /**
   * A sheet read into this cascade, under the tree it is for: its rules
   * where they are not in the indexes yet (`_fileRules`), and each time
   * what is found from its short lists, in the order of the sheets.
   */
  private _addSheet(
    sheet: Stylesheet,
    rules: TreeRules,
    breakpoints: Set<number>,
  ): void {
    if (!this._filed.has(sheet)) {
      this._filed.set(sheet, rules);
      this._fileRules(sheet, rules);
    }
    // a position option, the last of a name in the tree
    for (const { name, declarations } of sheet.positionTries ?? []) {
      rules.positionTries.set(name, declarations);
      this._positionTries = true;
    }
    for (const rule of sheet.keyframes ?? []) {
      let named = rules.keyframes.get(rule.name);
      if (!named) rules.keyframes.set(rule.name, (named = []));
      named.push(rule);
      this._anyKeyframes = true;
      if (rule.media) this._keyframeMedia.push(rule.media);
    }
    for (const bp of sheet.breakpoints) breakpoints.add(bp);
    // a query on the viewport's height reads it, and one on its aspect
    // ratio its width as well: each in the media band (`mediaBand`)
    if (sheet.readsHeight) this._mediaHeight = true;
    if (sheet.readsWidth) this._mediaWidth = true;
    if (sheet.sized) this._sized.push(...sheet.sized);
  }

  /**
   * A sheet's rules into the indexes, filed under the tree they are for —
   * the user agent's for every tree. The rules written from inside a shadow
   * tree about what is outside it — `:host`, `::slotted()` — and from
   * outside it about what is inside — `::part()` — are the tree's own
   * (`_addScoped`). Anything new a walk of them leaves on the cascade is
   * taken over with the indexes (`_takeOver`).
   */
  private _fileRules(sheet: Stylesheet, rules: TreeRules): void {
    const noted = this._noted.has(sheet);
    this._noted.add(sheet);
    for (const rule of sheet.rules) {
      if (rule.order < 0) {
        for (const d of rule.declarations) this._uaProps.add(d.prop);
      }
      if (!this._vars && usesVars(rule.declarations)) this._vars = true;
      if (!this._lh && usesLh(rule.declarations)) this._lh = true;
      if (!this.snaps && usesSnap(rule.declarations)) this.snaps = true;
      if (!this._zoom && usesZoom(rule.declarations)) this._zoom = true;
      if (!this._writing && usesWritingMode(rule.declarations)) {
        this._writing = true;
      }
      const scope = rule.order < 0 ? UA_SCOPE : rules.id;
      if (SCOPING.test(rule.selector) && this._addScoped(rule, rules)) {
        if (noted) continue;
        const split = splitPseudoElement(rule);
        this._changeRules.noteEdge(
          (split?.rule ?? rule).selector,
          !split
            ? 0
            : split.which === 'before' || split.which === 'after'
              ? 1
              : 2,
          rule.declarations,
        );
        continue;
      }
      const transition = splitTransitionPart(rule);
      if (transition) {
        TRANSITION_PARTS.set(transition.rule, transition.part);
        this._transitionRules.add(transition.rule, undefined, scope);
        this._restated.push(transition.rule, rule);
        continue;
      }
      const pseudo = splitPseudoElement(rule);
      if (pseudo?.which === 'highlight') {
        let index = this._highlights.get(pseudo.name!);
        if (!index)
          this._highlights.set(pseudo.name!, (index = new RuleIndex(true)));
        index.add(pseudo.rule, undefined, scope);
        this._restated.push(pseudo.rule, rule);
      } else if (pseudo) {
        this._latest.push(
          this._pseudo[pseudo.which].add(pseudo.rule, undefined, scope),
        );
        this._restated.push(pseudo.rule, rule);
      } else {
        const key = rightmostKey(rule.selector);
        this._latest.push(this._index.add(rule, key, scope));
        if (
          rule.order >= 0 &&
          (key.kind !== 'tag' || SHAPE_TAGS.has(key.name)) &&
          declaresShape(rule.declarations)
        ) {
          this._shapes.add(rule, key, scope);
        }
      }
      if (noted) continue;
      const selector = (pseudo?.rule ?? rule).selector;
      this._hoverRules.note(selector);
      this._focusRules.note(selector);
      this._changeRules.note(
        selector,
        !pseudo
          ? 0
          : pseudo.which === 'before' || pseudo.which === 'after'
            ? 1
            : 2,
        rule.declarations,
      );
    }
    for (const rule of sheet.keyframes ?? []) {
      for (const frame of rule.frames) {
        const declarations = frame.declarations;
        if (!this._vars && usesVars(declarations)) this._vars = true;
        if (!this._lh && usesLh(declarations)) this._lh = true;
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
      this._pseudo.marker.hoverSensitive ||
      this._pseudo.placeholder.hoverSensitive
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
      this._pseudo.marker.focusSensitive ||
      this._pseudo.placeholder.focusSensitive
    );
  }

  setFocus(focus: FocusState): void {
    this._focus = focus;
  }

  /** The element the fragment of the document's URL names, `:target`
   *  (Selectors 4, 9.1), or null for none. It is in no tree, so a matcher
   *  that kept what a `:has()` answered of the last one is told as one of a
   *  tree that changed is (`compileSelector`): `div:has(:target)` answered
   *  what it first did through every fragment after it. */
  setTarget(target: Element | null): void {
    if (target === this._target) return;
    this._target = target;
    treesChanged();
  }

  /** Whether a rule tests `:target`: whether a new one can restyle
   *  anything. */
  get targetSensitive(): boolean {
    return (
      this._index.targetSensitive ||
      Object.values(this._pseudo).some((index) => index.targetSensitive)
    );
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
   * move cannot. A `::placeholder`'s is none of them: it is no box's
   * (`placeholderFollows`).
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
   * table restyle the rows after it. A compound that leads below to a
   * subject touches only what in the element the subject names, pushed
   * onto `below` (`BelowReach`): Bootstrap's docs write `:hover >
   * .anchor-link`, and every element the pointer crossed reached all that
   * was in it, the whole page of 7,800 elements built again a move.
   * `HOVER_EDGE` where a rule at a shadow tree's edge can test it.
   */
  hoverTouches(el: Element, below?: BelowReach[]): HoverTouch {
    return this._hoverRules.touches(
      el,
      (selector) => this._compile(selector),
      below,
    );
  }

  /** `hoverTouches` for the focus: whether `el` taking the focus or giving
   *  it up, or its `:focus-within` changing, can change a style. */
  focusTouches(el: Element, below?: BelowReach[]): HoverTouch {
    return this._focusRules.touches(
      el,
      (selector) => this._compile(selector),
      below,
    );
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

  /**
   * What a change to an element's attribute can restyle (`CHANGES_*`, from
   * the element), the `:has()`s whose answer it can change, and which
   * pseudo-elements' rules test it — or null where that cannot be said:
   * where a selector tests the attribute somewhere a change reaches
   * elements no compound names (`CHANGES_ANYWHERE`).
   *
   * A document with shadow trees is answered as one without: every tree's
   * rules are noted in the one index, so what a change reaches is said of
   * all of them at once, and a tree's element is restyled by its tree's
   * rules alone. Next.js mounts one tree on every page, its route
   * announcer, which no sheet styles. A rule at a tree's edge is noted
   * as reaching below across it (`MutationRules.noteEdge`): GitHub's
   * `<tool-tip>` brings a tree of `:host()` rules, and every change
   * restyled the whole page while one did.
   *
   * A class's or an id's change is the tokens that came or went, where the
   * old value is known (`was`), and every class's or id's where it is not
   * (`undefined`): a class a selector tests that the element lost is as
   * much a change as one it took. An attribute selector is a change where
   * it answers otherwise for the value the attribute had than for the one
   * it has (`_flips`): Primer's `[class*=PricingOptions__item]` is no
   * change of a heading's class, and made every one of them unscopable.
   */
  attributeChange(
    name: string,
    was: string | null | undefined,
    now: string | null,
  ): AttributeReach | null {
    const rules = this._changeRules;
    let bits = 0;
    let pseudo: 0 | 1 | 2 = 0;
    const found: ReadonlySet<HasAnchor>[] = [];
    // what the reach below the element can restyle, and among what comes
    // after it: the subjects of every rule that tests the change there, or
    // everything
    let below: Set<string> | null = new Set();
    let later: Set<string> | null = new Set();
    const add = (key: string): void => {
      const own = rules.bits(key);
      if (own & CHANGES_BELOW && below) {
        const subjects = rules.below(key);
        if (!subjects) below = null;
        else for (const s of subjects) below.add(s);
      }
      if (own & CHANGES_LATER && later) {
        const subjects = rules.later(key);
        if (!subjects) later = null;
        else for (const s of subjects) later.add(s);
      }
      bits |= own;
      const p = rules.pseudo(key);
      if (p > pseudo) pseudo = p;
      const anchors = rules.anchors(key);
      if (anchors) found.push(anchors);
    };
    add(`a:${name}`);
    // what an `attr()` reads by a name not known until it is read
    add('a:*');
    const tests = rules.tests(name);
    if (tests) {
      // an element with the value it had and one with the value it has, by
      // how a selector spells the attribute's name
      const holders = new Map<string, [Element, Element]>();
      for (const key of tests) {
        if (was === undefined || this._flips(key, was, now, holders)) add(key);
      }
    }
    if (name === 'class') {
      if (was === undefined) {
        below = null;
        later = null;
        bits |= rules.anyClass;
        if (rules.anyClassPseudo > pseudo) pseudo = rules.anyClassPseudo;
        found.push(rules.anyClassAnchors);
      } else {
        const before = new Set(classesOf(was));
        const after = new Set(classesOf(now));
        for (const c of before) if (!after.has(c)) add(`c:${c}`);
        for (const c of after) if (!before.has(c)) add(`c:${c}`);
      }
    } else if (name === 'id') {
      if (was === undefined) {
        below = null;
        later = null;
        bits |= rules.anyId;
        if (rules.anyIdPseudo > pseudo) pseudo = rules.anyIdPseudo;
        found.push(rules.anyIdAnchors);
      } else {
        if (was) add(`i:${was}`);
        if (now) add(`i:${now}`);
      }
    }
    if (bits & CHANGES_ANYWHERE) return null;
    // `add` may have set them null, which the compiler does not see
    const narrowed = below as Set<string> | null;
    const after = later as Set<string> | null;
    return {
      bits,
      pseudo,
      anchors: this._changeAnchors(found),
      below: narrowed && narrowed.size ? this._subjectsMatcher(narrowed) : null,
      later: after && after.size ? this._subjectsMatcher(after) : null,
    };
  }

  /**
   * Whether an attribute selector (a `v:` key) answers otherwise for the
   * value its attribute had (`was`, null for none) than for the one it has
   * (`now`): asked of an element with that attribute alone, which is all
   * one reads, by css-select, so its case rules and its operators are the
   * matcher's own. True where css-select refuses it.
   */
  private _flips(
    key: string,
    was: string | null,
    now: string | null,
    holders: Map<string, [Element, Element]>,
  ): boolean {
    let test = this._attributeTests.get(key);
    if (test === undefined) {
      test = this._compile(key.slice(key.indexOf('\u0000') + 1));
      this._attributeTests.set(key, test);
    }
    if (!test) return true;
    const written = attributeNameAsWritten(
      key.slice(key.indexOf('\u0000') + 2, -1),
    );
    let pair = holders.get(written);
    if (!pair) {
      const names = [written, asciiLower(written)];
      pair = [holding(names, was), holding(names, now)];
      holders.set(written, pair);
    }
    return test(pair[0]) !== test(pair[1]);
  }

  /** The anchors in `sets`, as one set to ask elements about; null for
   *  none. A set a key keeps is kept as it is, and asked as one set for
   *  as long as the cascade lives. */
  private _changeAnchors(
    sets: readonly ReadonlySet<HasAnchor>[],
  ): ChangeAnchors | null {
    const full = sets.filter((set) => set.size > 0);
    if (!full.length) return null;
    let set: ReadonlySet<HasAnchor> = full[0];
    if (full.length > 1) {
      const union = new Set<HasAnchor>();
      for (const one of full) for (const a of one) union.add(a);
      set = union;
    }
    let anchors = this._anchorSets.get(set);
    if (!anchors) {
      anchors = new ChangeAnchors(
        [...set],
        (anchor) => {
          let match = this._anchorMatchers.get(anchor);
          if (match === undefined) {
            match = this._compile(anchor.compound);
            this._anchorMatchers.set(anchor, match);
          }
          return match;
        },
        (subject) => this._subjectsMatcher(new Set([subject])),
      );
      this._anchorSets.set(set, anchors);
    }
    return anchors;
  }

  /** Whether a rule reaches across a shadow tree's edge, so that a
   *  change reaches across one below the element it is made to
   *  (`MutationRules.crossesTrees`). */
  get changesCrossTrees(): boolean {
    return this._changeRules.crossesTrees;
  }

  /** Whether a `:has()` is in any rule: what an element holds, wherever it
   *  is — inside a drawing too — may be what one asks. */
  get asksWhatElementsHold(): boolean {
    return this._changeRules.asksHas;
  }

  /**
   * What a change to what an element holds can restyle, from that element
   * (`CHANGES_*`): the selectors that read what an element holds —
   * `:empty`, `:first-child` and their kin — or its text, `:contains()`,
   * where `text` says the change was a text's; and the children after
   * what came or went, where a sibling combinator is in play. And every `:has()`
   * that asks what an element holds or where it sits, and those that ask
   * only of the elements their subject can be where `nodes`, what came or
   * went, holds one (`MutationRules.held`). Null as `attributeChange`.
   */
  treeChange(
    text = false,
    nodes: readonly AnyNode[] = EMPTY_NODES,
  ): TreeReach | null {
    const rules = this._changeRules;
    if (rules.hasAnywhere) return null;
    // A child coming or going changes where its siblings sit and how they
    // line up, which a sibling combinator reaches past: the holder's
    // children and what is in them. Its own later siblings only a test of
    // what it holds before one reaches (`'h'`), and a text's change only
    // that and a test of text: a script a page puts in its `<head>`
    // restyled the whole `<body>` wherever a page had a `+`.
    const sits = text ? 0 : rules.bits('s');
    let bits = sits | rules.bits('h');
    if (text) bits |= rules.bits('t');
    if ((bits | rules.bits('s')) & CHANGES_ANYWHERE) return null;
    const kidsLater = !text && (sits & CHANGES_LATER) !== 0;
    let later = rules.bits('h') & CHANGES_LATER;
    if (text) later |= rules.bits('t') & CHANGES_LATER;
    bits = (bits & ~CHANGES_LATER) | later;
    const asked = rules.anchors('s') ?? EMPTY_ANCHORS;
    // Below the holder, a test of what an element holds or where it sits
    // reaches from an element its compound names, and what there its
    // rule's subject does: the webmail page's split buttons hide a
    // separator `.button:not(:first-child) .content`, and every popup it
    // put in its `<body>` restyled and built all 13,000 of its elements.
    const below =
      bits & CHANGES_BELOW && !(text && rules.bits('t') & CHANGES_BELOW)
        ? this._treeBelow()
        : null;
    // and of the holder and its children themselves, the ones a subject's
    // compound names: what else a child coming or going holds and sits
    // beside is no test of where it is
    const self =
      bits & CHANGES_SELF && !(text && rules.bits('t') & CHANGES_SELF)
        ? this._treeSelf()
        : null;
    return {
      bits,
      kidsLater,
      followers: !text && rules.siblings,
      siblings: rules.siblings ? this._siblingReach() : null,
      below,
      self,
      later: kidsLater ? this._treeLater() : false,
      anchors: this._changeAnchors([
        text ? asked : this._heldReached(asked, nodes),
      ]),
      pseudo: rules.treePseudo,
    };
  }

  private _heldIds = new Map<HasAnchor, number>();
  private _heldSets = new Map<string, Set<HasAnchor>>();

  /**
   * `sits` and the anchors that ask what an element holds only of the
   * elements their subject can be (`MutationRules.held`) whose subjects an
   * element in `nodes`, or in what they hold, matches: as one set, the same
   * set for the same anchors, which `_changeAnchors` keeps as one. Past
   * `HELD_WALK` elements, every one of them, as though each matched. One
   * that asks only so many levels down (`HasAnchor.levels`) is reached
   * only by what is no further into what came than that: the rest of it
   * came with it, and is styled whole. A dialog Apple's pages move into the
   * `<body>` holds a `.caption-primary`, which `:has(>.caption-primary)`
   * asks of the `<body>`'s children alone.
   */
  private _heldReached(
    sits: ReadonlySet<HasAnchor>,
    nodes: readonly AnyNode[],
  ): ReadonlySet<HasAnchor> {
    const held = this._changeRules.held();
    if (!held.size || !nodes.length) return sits;
    const pending = new Map<HasAnchor, ((el: Element) => boolean) | null>();
    for (const [anchor, subjects] of held) {
      pending.set(anchor, this._subjectsMatcher(subjects));
    }
    const reached: HasAnchor[] = [];
    const reach = (anchor: HasAnchor): void => {
      reached.push(anchor);
      pending.delete(anchor);
    };
    // what css-select refuses is reached by anything
    for (const [anchor, match] of pending) if (!match) reach(anchor);
    const stack: [AnyNode, number][] = nodes.map((node) => [node, 1]);
    let walked = 0;
    while (stack.length && pending.size) {
      const [node, depth] = stack.pop()!;
      if (!isTag(node)) continue;
      if ((walked += 1) > HELD_WALK) {
        // what is left to walk is no shallower than what the stack holds
        let left = depth;
        for (const [, at] of stack) if (at < left) left = at;
        for (const anchor of [...pending.keys()]) {
          if ((anchor.levels ?? Infinity) >= left) reach(anchor);
        }
        break;
      }
      let deeper = false;
      for (const [anchor, match] of pending) {
        const levels = anchor.levels ?? Infinity;
        if (depth <= levels && match!(node)) reach(anchor);
        else if (depth < levels) deeper = true;
      }
      if (!deeper) continue;
      for (const child of node.children) stack.push([child, depth + 1]);
    }
    if (!reached.length) return sits;
    for (const anchor of reached) {
      if (!this._heldIds.has(anchor)) {
        this._heldIds.set(anchor, this._heldIds.size);
      }
    }
    const key = `${sits.size} ${reached
      .map((anchor) => this._heldIds.get(anchor)!)
      .sort((a, b) => a - b)
      .join(' ')}`;
    let set = this._heldSets.get(key);
    if (!set) {
      set = new Set([...sits, ...reached]);
      this._heldSets.set(key, set);
    }
    return set;
  }

  /**
   * What putting children in at the end of an element, or writing on to
   * the text that ends one, can restyle besides what is new (`treeChange`
   * for any change of what one holds), from where (`CHANGES_*`): `empty`,
   * from the element, what tests whether it holds anything, `:empty` and
   * its kin, and of those `blank`, whether it holds text; `text`, from the
   * element, a test of its text; `last`, from the children before what
   * came that were last, or last of their type — `:last-child` and its kin;
   * and `every`, from every child before it — what counts from the end,
   * `:nth-last-child()`. A sibling combinator reaches only what is after
   * the child it follows, which is what came. And every `:has()`. Null as
   * `attributeChange`.
   */
  appendChange(): AppendReach | null {
    const rules = this._changeRules;
    if (rules.hasAnywhere) return null;
    const empty = rules.bits('h');
    const blank = rules.bits('k');
    const text = rules.bits('t');
    const last = rules.bits('e');
    const every = rules.bits('n');
    if ((empty | text | last | every | rules.bits('s')) & CHANGES_ANYWHERE) {
      return null;
    }
    return {
      empty,
      blank,
      text,
      last,
      every,
      anchors: this._changeAnchors([rules.everyAnchor]),
      pseudo: rules.treePseudo,
    };
  }

  private _subjects = new Map<string, ((el: Element) => boolean) | null>();

  /** One matcher for a set of stable compounds (`AttributeReach.below`),
   *  kept for the cascade's life; null where css-select refuses it. */
  /** `TreeReach.below` for this cascade's rules: what the tests of what an
   *  element holds and where it sits above a subject are of
   *  (`MutationRules.tested`), and those subjects; null where a compound
   *  could not be compiled. */
  private _treeBelow(): TreeBelow | null {
    if (this._treeBelowKept !== undefined) return this._treeBelowKept;
    const rules = this._changeRules;
    let subjects: Set<string> | null = new Set();
    for (const key of ['s', 'h']) {
      if (!(rules.bits(key) & CHANGES_BELOW)) continue;
      const below = rules.below(key);
      if (!below) subjects = null;
      else if (subjects) for (const one of below) subjects.add(one);
    }
    const tested = this._treeTested('below');
    this._treeBelowKept = tested && {
      ...tested,
      subjects:
        subjects && subjects.size ? this._subjectsMatcher(subjects) : null,
    };
    return this._treeBelowKept;
  }

  private _treeBelowKept: TreeBelow | null | undefined = undefined;

  /** `TreeReach.self` for this cascade's rules. */
  private _treeSelf(): TreeTested | null {
    if (this._treeSelfKept === undefined) {
      this._treeSelfKept = this._treeTested('self');
    }
    return this._treeSelfKept;
  }

  private _treeSelfKept: TreeTested | null | undefined = undefined;

  /** `TreeReach.later` for this cascade's rules: any child, where a
   *  compound could not be compiled. */
  private _treeLater(): Tested {
    if (this._treeLaterKept === undefined) {
      this._treeLaterKept = this._treeTested('later')?.kids ?? true;
    }
    return this._treeLaterKept;
  }

  private _treeLaterKept: Tested | undefined = undefined;

  /** `TreeReach.siblings` for this cascade's rules: any element, where a
   *  compound could not be compiled. */
  private _siblingReach(): SiblingReach {
    if (this._siblingReachKept) return this._siblingReachKept;
    const rules = this._changeRules;
    const pairsOf = (
      pairs: ReadonlyMap<string, ReadonlySet<string> | null>,
    ): SiblingPair[] =>
      [...pairs].map(([lead, trails]) => ({
        lead:
          lead === '*'
            ? true
            : (this._subjectsMatcher(new Set([lead])) ?? true),
        trail: trails === null ? true : (this._subjectsMatcher(trails) ?? true),
      }));
    this._siblingReachKept = {
      tilde: pairsOf(rules.tilde),
      plus: pairsOf(rules.plus),
    };
    return this._siblingReachKept;
  }

  private _siblingReachKept: SiblingReach | null = null;

  /** What the tests of what an element holds and where it sits are of,
   *  where they reach (`MutationRules.tested`), as matchers; null where
   *  one could not be compiled. */
  private _treeTested(at: 'self' | 'below' | 'later'): TreeTested | null {
    const rules = this._changeRules;
    const one = (set: ReadonlySet<string> | null | undefined): Tested | null =>
      set === undefined
        ? false
        : set === null
          ? true
          : this._subjectsMatcher(set);
    const holder = one(rules.tested(at, 'holder'));
    const kids = one(rules.tested(at, 'kid'));
    if (holder === null || kids === null) return null;
    return { holder, kids };
  }

  private _subjectsMatcher(
    subjects: ReadonlySet<string>,
  ): ((el: Element) => boolean) | null {
    const key = [...subjects].sort().join(', ');
    let match = this._subjects.get(key);
    if (match === undefined) {
      match = this._compile(key);
      this._subjects.set(key, match);
    }
    return match;
  }

  /**
   * The rules that match `el`, as a developer's tools list them: the
   * element's own `style` first, then the rules of its tree in the order
   * they win — the author's before the user agent's, a later layer before
   * an earlier, the more specific first and, of two alike, the later — and
   * HTML's presentational hints, each with its declarations as written and
   * whether it is under media. Under the media as they hold now, and with
   * the pointer and the focus where they are (`HtmlHandle.matchedRules`).
   * Which declaration wins a property is the reader's to work out from the
   * order: `!important` turns it round, as it does in the cascade.
   */
  matchedRules(el: Element): MatchedRule[] {
    // the rules at a shadow tree's edge — `:host`, `::slotted()` — are
    // kept apart from the indexes, under ids of their own, and not listed
    const ids: number[] = [];
    this._matchInto(this._index, el, null, ids);
    // made again where the index has grown since
    let byId = this._rulesById;
    if (!byId || byId.size !== this._index.size) {
      byId = new Map();
      for (const indexed of this._index.all()) byId.set(indexed.id, indexed);
      this._rulesById = byId;
    }
    const seen = new Set<number>();
    const rules: StyleRule[] = [];
    for (const id of ids) {
      const indexed = byId.get(id);
      if (!indexed || seen.has(id)) continue;
      seen.add(id);
      rules.push(indexed.rule);
    }
    rules.sort(
      (a, b) =>
        Number(a.order < 0) - Number(b.order < 0) ||
        compareLayers(b.layer, a.layer) ||
        b.specificity - a.specificity ||
        b.order - a.order,
    );
    const written = (declarations: readonly Declaration[]) =>
      declarations
        .filter((d) => !d.computed)
        .map((d) => ({
          property: d.prop,
          value: d.value,
          important: d.important,
        }));
    const out: MatchedRule[] = [];
    const inline = attr(el, 'style');
    if (inline) {
      out.push({
        selector: null,
        origin: 'inline',
        specificity: [1, 0, 0],
        media: null,
        declarations: written(parseDeclarations(inline)),
        source: null,
      });
    }
    let sources = this._sourceOf;
    if (!sources) {
      sources = this._sourceOf = new Map();
      for (const sheet of this._sheets) {
        if (!sheet.source) continue;
        for (const rule of sheet.rules) sources.set(rule, sheet.source);
      }
    }
    for (const rule of rules) {
      const spec = rule.specificity;
      const sheet = sources.get(rule);
      out.push({
        selector: rule.selector,
        origin: rule.order < 0 ? 'user-agent' : 'author',
        specificity: [
          Math.floor(spec / 1_000_000),
          Math.floor(spec / 1_000) % 1_000,
          spec % 1_000,
        ],
        media: rule.media ? mediaText(rule.media) : null,
        declarations: written(rule.declarations),
        source:
          sheet && rule.at !== undefined ? ruleSource(sheet, rule.at) : null,
      });
    }
    const hints = presentationHints(el, this.dimensionSource);
    if (hints.length) {
      // above the user agent's rules, as the cascade has them
      const ua = out.findIndex((r) => r.origin === 'user-agent');
      out.splice(ua < 0 ? out.length : ua, 0, {
        selector: null,
        origin: 'presentation',
        specificity: [0, 0, 0],
        media: null,
        declarations: written(hints),
        source: null,
      });
    }
    return out;
  }

  /** The sheets the document is styled by, in the cascade's order, each one
   *  what a rule's `source.sheet` is (`HtmlHandle.styleSheets`): an imported
   *  sheet before the one importing it, and the shadow trees' after the
   *  document's. */
  sheetSources(): SheetSource[] {
    const out: SheetSource[] = [];
    for (const sheet of this._sheets) {
      if (sheet.source) out.push(sheet.source);
    }
    return out;
  }

  /**
   * The classes, or the ids, that would bring one more of the author's
   * rules onto `el` were it to carry them, besides what it has: each name a
   * rule's subject asks for, where the rule's selector matches the element
   * as though it had that name too — a class added to its classes, an id
   * in place of its own — under the media as they hold now, with the
   * pointer and the focus taken to be wherever the rule wants them. What a
   * developer's tools offer as a class or an id is typed: only a name some
   * style would answer (`HtmlHandle.namesThatStyle`).
   *
   * Each rule is matched through an adapter of its own, which answers the
   * element's attribute with the name in it, compiled for the question and
   * keeping no answer: no matcher of the cascade's is asked, nothing it
   * keeps is touched, and the element is not changed.
   */
  namesThatStyle(el: Element, attribute: 'class' | 'id'): string[] {
    const own = (el.attribs[attribute] ?? '').split(/\s+/).filter(Boolean);
    const have = new Set(own);
    const scope = (this._scoped ? this._treeInfo(el) : this._docInfo).rules.id;
    // the rules whose subject asks for a name the element does not have
    const asking = new Map<string, StyleRule[]>();
    for (const indexed of this._index.all()) {
      if (indexed.scope === UA_SCOPE) continue;
      if (this._scoped && indexed.scope !== scope) continue;
      for (const name of subjectNames(indexed.rule.selector, attribute)) {
        if (have.has(name)) continue;
        let rules = asking.get(name);
        if (!rules) asking.set(name, (rules = []));
        rules.push(indexed.rule);
      }
    }
    if (!asking.size) return [];
    let trying = '';
    const value = (): string =>
      attribute === 'class' ? [...own, trying].join(' ') : trying;
    const base = this._adapter;
    const adapter: CssSelectAdapter = {
      ...base,
      getAttributeValue: (e: Element, name: string) =>
        e === el && name === attribute
          ? value()
          : base.getAttributeValue(e, name),
      hasAttrib: (e: Element, name: string) =>
        (e === el && name === attribute) || base.hasAttrib(e, name),
    };
    const width = this.viewportWidth / this.scale;
    const height = this.viewportHeight / this.scale;
    const matchers = new Map<StyleRule, ((e: Element) => boolean) | null>();
    const matcherOf = (rule: StyleRule) => {
      if (matchers.has(rule)) return matchers.get(rule)!;
      let match: ((e: Element) => boolean) | null = null;
      try {
        // a state the user can put an element in is one it can be in
        const stateless = rule.selector.replace(
          /:(?:hover|active|focus(?:-visible|-within)?)(?![\w-])/gi,
          ':is(*)',
        );
        match = compileSelector(stateless, adapter, this._pseudos, false);
      } catch {
        match = null;
      }
      matchers.set(rule, match);
      return match;
    };
    const out: string[] = [];
    for (const [name, rules] of asking) {
      trying = name;
      for (const rule of rules) {
        if (
          !mediaMatches(
            rule.media,
            width,
            this.look.colorScheme,
            height,
            this.scale,
            this.reducedMotion,
            this.scripting,
          )
        ) {
          continue;
        }
        if (matcherOf(rule)?.(el)) {
          out.push(name);
          break;
        }
      }
    }
    return out.sort();
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

  /** Whether a rule at a shadow tree's edge styles a pseudo-element: what
   *  a restyle in place of an edge's move cannot reach (`_restyleHover`). */
  get pseudoAtEdges(): boolean {
    for (const which of this._scopedPseudos) if (which !== '') return true;
    return false;
  }

  /**
   * The elements whose styles a viewport `from` device pixels wide and one
   * `to` wide make differently, for a resize that crossed a breakpoint:
   * each one a rule matches whose media hold at one width and not at the
   * other, or a pseudo-element of it is — or null where that cannot be
   * told from the rules here, as for a rule at a shadow tree's edge or a
   * `@keyframes` under a media query. A shadow tree's own rules are in the
   * indexes, filed under the tree, and the walk goes into every tree. A
   * band changes few elements: Wikipedia's 1120px
   * breakpoint turns 55 rules over, which match 27 of 4,386 elements, and
   * its 1400px one 2, which match none — where every element was styled
   * again and every box built again.
   */
  crossed(
    from: number,
    to: number,
    root: { children?: readonly unknown[] },
    /** The viewport's height before and after, which a query on it or on
     *  the aspect ratio reads. */
    fromHeight = this.viewportHeight,
    toHeight = this.viewportHeight,
  ): Set<Element> | null {
    const answers = (
      media: MediaCondition[][] | null,
      width: number,
      height: number,
    ): boolean =>
      mediaMatches(
        media,
        width / this.scale,
        this.look.colorScheme,
        height / this.scale,
        this.scale,
        this.reducedMotion,
        this.scripting,
      );
    for (const list of [this._mediaOutsideRules, this._keyframeMedia]) {
      for (const media of list) {
        if (answers(media, from, fromHeight) !== answers(media, to, toHeight)) {
          return null;
        }
      }
    }
    const holds = (rule: StyleRule, width: number, height: number): boolean =>
      answers(rule.media, width, height);
    const turned = new RuleIndex();
    for (const index of [this._index, ...Object.values(this._pseudo)]) {
      for (const indexed of index.withMedia) {
        if (
          holds(indexed.rule, from, fromHeight) !==
          holds(indexed.rule, to, toHeight)
        ) {
          turned.adopt(indexed);
        }
      }
    }
    const reached = new Set<Element>();
    if (!turned.size) return reached;
    const stack: unknown[] = [...(root.children ?? [])];
    while (stack.length) {
      const node = stack.pop();
      if (!isElement(node as never)) continue;
      const el = node as Element;
      if (turned.reaches(el)) {
        const matched: number[] = [];
        this._matchInto(turned, el, null, matched, undefined, false, true);
        if (matched.length) reached.add(el);
      }
      for (const child of el.children) stack.push(child);
      // and the tree it hosts, whose rules are asked of its elements alone
      // (`_matchInto`): MDN's pages are custom elements with trees of their
      // own, and every breakpoint a drag crossed styled the page again
      const shadow = this._scoped ? shadowRootOf(el) : null;
      if (shadow) for (const child of shadow.children) stack.push(child);
    }
    return reached;
  }

  /**
   * The elements the rules `added` can style, for a cascade made again
   * where all the sheets did is add them (`HtmlViewNode._sheetsAdded`):
   * each one an added rule's selector matches, whatever media it is under,
   * or whose pseudo-element it does — the rest are styled as they were, by
   * the rules they were. Found as `crossed` finds what a breakpoint turns
   * rules on and off for, from the rules this cascade filed, where each is
   * known by its declarations, which a pseudo-element's rule keeps: an added
   * rule is in a sheet no cascade had filed. Null where one is in neither
   * `_index` nor `_pseudo`: a rule at a shadow tree's edge, a highlight's, a
   * view transition's.
   */
  addedReach(
    added: readonly StyleRule[],
    root: { children?: readonly unknown[] },
    /** Whether the markup writes no `<html>`, and a style the cascade makes
     *  stands for the root's: one no element's rules are asked for, which
     *  a rule that may match the root changes (`impliedHtml`). */
    impliedRoot = false,
  ): Set<Element> | null {
    const reached = new Set<Element>();
    if (!added.length) return reached;
    if (impliedRoot) {
      for (const rule of added) {
        const key = rightmostKey(rule.selector);
        if (
          key.kind === 'root' ||
          key.kind === 'any' ||
          (key.kind === 'tag' && key.name === 'html')
        ) {
          return null;
        }
      }
    }
    const declarations = new Set(added.map((rule) => rule.declarations));
    const turned = new RuleIndex();
    for (const indexed of this._latest) {
      if (declarations.has(indexed.rule.declarations)) turned.adopt(indexed);
    }
    if (turned.size < added.length) return null;
    const stack: unknown[] = [...(root.children ?? [])];
    while (stack.length) {
      const node = stack.pop();
      if (!isElement(node as never)) continue;
      const el = node as Element;
      if (turned.reaches(el)) {
        const matched: number[] = [];
        this._matchInto(turned, el, null, matched, undefined, false, true);
        if (matched.length) reached.add(el);
      }
      for (const child of el.children) stack.push(child);
      const shadow = this._scoped ? shadowRootOf(el) : null;
      if (shadow) for (const child of shadow.children) stack.push(child);
    }
    return reached;
  }

  /** Which media band a viewport of device pixels falls in: the width's
   *  among the breakpoints, and the answer of each condition on the height
   *  or the aspect ratio. Two viewports in the same band produce identical
   *  styles, which is what lets a resize skip restyling. Tailwind's docs
   *  have an `(orientation: portrait)`, and read as a `vw` it styled the
   *  page again at every step of a drag. */
  mediaBand(width: number, height: number): string {
    const cssWidth = width / this.scale;
    let band = 0;
    for (const bp of this.breakpoints) {
      if (cssWidth >= bp) band += 1;
      else break;
    }
    let key = String(band);
    for (const c of this._sized) {
      key += mediaMatches(
        [[c]],
        cssWidth,
        this.look.colorScheme,
        height / this.scale,
        this.scale,
        this.reducedMotion,
        this.scripting,
      )
        ? '1'
        : '0';
    }
    return key;
  }

  /**
   * The `@position-try` rule a position option's name finds, and the tree
   * it is in, or null. Its name is tree-scoped, as a `@keyframes` name is
   * (CSS Shadow 1, 3.5): looked for in the tree whose rule named it, then
   * in each tree around that one out to the document's.
   */
  private _positionTry(
    name: string,
    tree: ShadowRoot | null,
  ): { declarations: Declaration[]; tree: ShadowRoot | null } | null {
    for (let root = tree; root; root = shadowRootAround(root.host)) {
      const found = this._rootInfo(root).rules.positionTries.get(name);
      if (found) return { declarations: found, tree: root };
    }
    const found = this._document.positionTries.get(name);
    return found ? { declarations: found, tree: null } : null;
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
    const made = this.transitionKeyframes?.get(name);
    if (made) return made;
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
          this.scripting,
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

  /**
   * The `@function` a call of `name` finds, or null (CSS Mixins 1, 2.1): of
   * the document's rules of the name whose media hold, the one in the
   * latest layer — no layer outranking any, as for a style rule — and the
   * last of those. A rule under a media query is read as a `vmin` is, so a
   * style that called it is computed again when the viewport moves.
   */
  private _functionNamed(name: string): FunctionRule | null {
    const named = this._functions?.get(name);
    if (!named) return null;
    let found: FunctionRule | null = null;
    for (const rule of named) {
      if (rule.media) {
        this._viewportRead('vmin');
        if (
          !mediaMatches(
            rule.media,
            this.viewportWidth / this.scale,
            this.look.colorScheme,
            this.viewportHeight / this.scale,
            this.scale,
            this.reducedMotion,
            this.scripting,
          )
        ) {
          continue;
        }
      }
      if (found && compareLayers(rule.layer, found.layer) < 0) continue;
      found = rule;
    }
    return found;
  }

  /** A sharing key no element has: for what a box no element makes holds,
   *  a `::details-content`'s children, whose parent style is the box's and
   *  not their element's parent's (`sharedStyleFor`). */
  freshShareKey(): number {
    return this._nextShareKey++;
  }

  /** Computed styles by sharing key, for one build (`sharedStyleFor`): one
   *  map for the elements shared without matching, one for the elements
   *  shared by what they matched. */
  private _shared = new Map<string, SharedStyle>();
  private _sharedByMatch = new Map<string, SharedStyle>();
  private _nextShareKey = 1;
  /** Custom property sets by what made them, for one build (`_customFor`). */
  private _customs = new Map<string, CustomProps>();
  /** The custom properties the document's `@property` rules register, the
   *  last rule for a name over any before it; null for none. */
  private _registered: Map<string, Registration> | null = null;
  /** What the root inherits: each registered property's initial value. */
  private _registeredBase: CustomProps | null = null;
  /** The registered properties that do not inherit, with their initial
   *  values, and for each set an element inherits, those it holds at
   *  another value, which the element's own are reset from. */
  private _nonInherited: Map<string, string | null> | null = null;
  private _resets = new WeakMap<
    CustomProps,
    ReadonlyMap<string, string | null> | null
  >();
  private _ids = new WeakMap<object, number>();
  private _nextId = 1;

  /** The styles kept from the build before, while a build that keeps them
   *  runs, and what each kept element shares under in this one. */
  private _kept: KeptStyles | null = null;
  /** Whether a build is styling the document (`beginSharing`). */
  private _inBuild = false;
  /** The timeline the last build ran its animations on: the document's,
   *  where a style `pseudoStyleFor` keeps has to have been worked out. */
  private _buildTimeline: AnimationTimeline | null = null;
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
    // every style there is is about to be computed: whether one holds a
    // length of the viewport's, or a `rem`, is for this build to find out
    if (!kept) {
      this._heldWidth = false;
      this._heldHeight = false;
      this._pseudoSides.clear();
      this._rootRead = 0;
      this._pseudoRoot.clear();
      this._queryRoot.clear();
    }
    this._rootMoved = false;
    this._namesKept.clear();
    this._keepNames = true;
    this._inBuild = true;
    this._buildTimeline = this.timeline;
    this._shared.clear();
    this._sharedByMatch.clear();
    // the kept styles' custom properties are the sets in here, which the
    // elements styled under them find again
    if (!kept) this._customs.clear();
    // and every element's container queries are about to be asked again
    if (!kept) this._containerReads.clear();
    this._kept = kept;
    this._keptShared.clear();
    this._newContainers.clear();
    // which tree each element is in, found again: an element a script
    // moved into another tree since the last build is styled by its rules
    this._trees = new WeakMap();
  }

  /** Whether an element's parent has the style it had before the build,
   *  what the element's own is computed from beside the rules (`follow`). */
  private _parentAsWas(
    el: Element,
    parentStyle: ComputedStyle,
    kept: KeptStyles,
  ): boolean {
    // the parent a style inherits from: the host above a shadow tree's
    // top, the slot a light child is assigned to
    const parent = flatParentOf(el);
    const was = parent ? kept.styles.get(parent)?.style : kept.root;
    return (
      was !== undefined && (was === parentStyle || sameStyle(was, parentStyle))
    );
  }

  /** The build is over: nothing later is answered from what it kept. */
  endSharing(): void {
    this._kept = null;
    this._keptShared.clear();
    this._namesKept.clear();
    this._keepNames = false;
    this._inBuild = false;
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
        for (const name of className.split(CLASS_SPACE)) {
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

  /** The tree an element is in, found once a build, and again once the
   *  tree has changed (`treeGeneration`): a refresh that builds nothing —
   *  one in place, or of what no box draws — styles an element a script
   *  moved into a shadow tree by that tree's rules, where it took the
   *  document's. */
  private _treeInfo(el: Element): TreeInfo {
    if (!this._scoped) return this._docInfo;
    const at = treeGeneration();
    if (at !== this._treesAt) {
      this._trees = new WeakMap();
      this._treesAt = at;
    }
    let info = this._trees.get(el);
    if (info) return info;
    const root = shadowRootAround(el);
    info = root ? this._rootInfo(root) : this._docInfo;
    this._trees.set(el, info);
    return info;
  }

  /** A rule a crossing cannot ask the indexes about (`crossed`): its media
   *  noted, so that a width they turn at styles the whole document. */
  private _outsideIndexes(rule: StyleRule): void {
    if (rule.media) this._mediaOutsideRules.push(rule.media);
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
    // a custom highlight's is the document's, by its name, wherever it is
    if (pseudo?.which === 'highlight') return false;
    if (pseudo) this._restated.push(pseudo.rule, rule);
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
      this._outsideIndexes(rule);
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
      this._outsideIndexes(rule);
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
      this._outsideIndexes(rule);
      return true;
    }
    // `:host(.dark) .x`: the rest, which is in the tree, matched as any
    // rule of the tree's, and then its host asked
    const derived = { ...subject, selector: reading.rest };
    this._restated.push(derived, rule);
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
    if (TARGET_PSEUDO.test(rule.selector)) this._index.targetSensitive = true;
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
      this._hoverRules.noteEdge(selector);
    }
    if (FOCUS_STATE.mentions.test(selector)) {
      this._index.focusSensitive = true;
      this._focusRules.noteEdge(selector);
    }
    if (TARGET_PSEUDO.test(selector)) this._index.targetSensitive = true;
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
        if (
          r.pseudo !== pseudo ||
          !this._holds(r.rule, el, pseudo !== '') ||
          !r.host(el)
        ) {
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
          !this._holds(r.rule, el, pseudo !== '') ||
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
        !this._holds(r.rule, el, pseudo !== '') ||
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

  /** Whether a rule's media queries hold now, and its container queries
   *  for `el` — or its pseudo-element, for `self`. */
  private _holds(rule: StyleRule, el: Element, self: boolean): boolean {
    return (
      mediaMatches(
        rule.media,
        this.viewportWidth / this.scale,
        this.look.colorScheme,
        this.viewportHeight / this.scale,
        this.scale,
        this.reducedMotion,
        this.scripting,
      ) &&
      (!rule.containers || this._containersHold(rule.containers, el, self))
    );
  }

  // --- container queries ----------------------------------------------------
  //
  // An `@container` rule holds for an element where its query holds of the
  // element's query container (CSS Conditional 5, 3): the nearest ancestor
  // in the flat tree that can answer it — a size container of the axes its
  // size features read, of the name it gives — or for a pseudo-element its
  // element. A size is layout's, and layout comes after the styles, so a
  // query is answered for the size the last layout left the container
  // (`_containerSizes`) and each answer is noted (`_containerReads`); a
  // layout then says which elements' answers it changed
  // (`containersMoved`), and only those are styled again, as a browser
  // styles a container's contents once it knows the container's size. A
  // container no layout has sized yet — the first — answers no size query,
  // so a document whose queries hold is laid out twice the first time.

  /** The styles of the elements styled so far, by element: a build's as it
   *  goes, which is the tree's once it is built (`BoxBuilder.run`), and a
   *  container's style is what a query finds it by — its type, its names,
   *  its font, its custom properties. */
  stylesOf: ((el: Element) => ComputedStyle | undefined) | null = null;
  /** Each size container's content box as the last layout left it, in
   *  device pixels, or null for one it gave no box. */
  private _containerSizes = new Map<Element, ContainerSize | null>();
  /** Each scroll-state container's scroll states as the renderer last
   *  told them (`containersMoved`), none where it has not. */
  private _scrollStates = new Map<Element, ScrollStates>();
  private _scrollRead = false;
  /** What each element's style read of size containers: for each query,
   *  the container it found and how it answered — and for a length in
   *  `cqw` or its kin, in its style or in what one of its queries
   *  compares, the size it was read as (`UNIT_AXIS`). */
  private _containerReads = new Map<
    Element,
    Map<ContainerQuery, { container: Element; answer: boolean | number }>
  >();
  /** Whether the style being computed holds a length in a container's
   *  units, which is the element's alone: two elements of one key and one
   *  set of rules are in containers of other sizes (`sharedStyleFor`). */
  private _containerUnitRead = false;

  /**
   * A container unit's basis for `el`, or its pseudo-element for `self`:
   * the content box in `axis` of the nearest size container that has the
   * axis (CSS Conditional 5, 3.4), in device pixels — the viewport's where
   * there is none, or where no layout has sized it yet — noted as a query's
   * answer is, for the layout after to say whether it still holds.
   */
  private _containerUnit(
    el: Element,
    self: boolean,
    axis: 'inline' | 'block',
  ): number {
    const query = axis === 'inline' ? CQ_INLINE : CQ_BLOCK;
    const found = this._containerFor(query, el, self);
    this._containerUnitRead = true;
    const value = this._unitBasis(
      query,
      found ? (this._containerSizes.get(found[0]) ?? null) : null,
    );
    if (found) {
      let reads = this._containerReads.get(el);
      if (!reads) this._containerReads.set(el, (reads = new Map()));
      reads.set(this._readKey(query, self), {
        container: found[0],
        answer: value,
      });
    }
    return value;
  }

  /** What a read of `query` is noted under: the query, or for a
   *  pseudo-element a copy of it, since a pseudo-element's query finds its
   *  element where the element's own finds what is above it, and one
   *  element with `.a` and `.a::after` under one `@container` has read two
   *  containers. */
  private _selfReads = new WeakMap<ContainerQuery, ContainerQuery>();
  private _readKey(query: ContainerQuery, self: boolean): ContainerQuery {
    if (!self) return query;
    let key = this._selfReads.get(query);
    if (!key) {
      key = { ...query };
      const axis = UNIT_AXIS.get(query);
      if (axis) UNIT_AXIS.set(key, axis);
      this._selfReads.set(query, key);
    }
    return key;
  }

  /** What a container unit of `query`'s axis is a hundredth of, for a
   *  container of `size`: the viewport's side where it has none. */
  private _unitBasis(
    query: ContainerQuery,
    size: ContainerSize | null,
  ): number {
    const inline = UNIT_AXIS.get(query) === 'inline';
    if (size) return inline ? size.width : size.height;
    this._viewportRead(inline ? 'vw' : 'vh');
    return inline ? this.viewportWidth : this.viewportHeight;
  }

  /**
   * A container unit's basis in a query asked of `container`: the content
   * box in `axis` of the nearest size container above it that has the
   * axis, since a query's lengths are the container's and no element is
   * the container of its own (CSS Conditional 5, 3.4) — the viewport's, at
   * the container's zoom, where there is none or no layout has sized it.
   * Noted for `reader`, the element whose rule asked, as its own units
   * are (`_containerUnit`), for the layout after to say whether it holds.
   */
  private _queryUnit(
    container: Element | null,
    axis: 'inline' | 'block',
    zoom: number,
    reader: Element | null,
  ): number {
    const inline = axis === 'inline';
    const found = container
      ? this._containerFor(inline ? CQ_INLINE : CQ_BLOCK, container, false)
      : null;
    const size = found ? this._sizeOf(found[0]) : null;
    const viewport = inline ? this.viewportWidth : this.viewportHeight;
    if (found && reader) {
      let reads = this._containerReads.get(reader);
      if (!reads) this._containerReads.set(reader, (reads = new Map()));
      reads.set(this._queryUnitKey(found[0], axis), {
        container: found[0],
        answer: size ? (inline ? size.width : size.height) : viewport,
      });
    }
    if (size) return inline ? size.width : size.height;
    this._queryViewportRead(inline ? 'vw' : 'vh');
    return viewport * zoom;
  }

  /** What a query's container unit is noted under (`_queryUnit`): one for
   *  each container and axis, read as `CQ_INLINE` and `CQ_BLOCK` are, so
   *  that two queries of one element that find other containers keep a
   *  read each. */
  private _queryUnitKeys = new WeakMap<
    Element,
    { inline?: ContainerQuery; block?: ContainerQuery }
  >();
  private _queryUnitKey(
    container: Element,
    axis: 'inline' | 'block',
  ): ContainerQuery {
    let keys = this._queryUnitKeys.get(container);
    if (!keys) this._queryUnitKeys.set(container, (keys = {}));
    let key = keys[axis];
    if (!key) {
      key = {
        name: null,
        condition: '',
        axes: axis === 'inline' ? INLINE_AXIS : BLOCK_AXIS,
      };
      UNIT_AXIS.set(key, axis);
      keys[axis] = key;
    }
    return key;
  }

  /** Whether a rule's `@container` blocks all hold for `el`: one query of
   *  each block's list. */
  private _containersHold(
    blocks: ContainerQuery[][],
    el: Element,
    self: boolean,
  ): boolean {
    for (const queries of blocks) {
      let any = false;
      for (const query of queries) {
        if (this._queryHolds(query, el, self)) {
          any = true;
          break;
        }
      }
      if (!any) return false;
    }
    return true;
  }

  private _queryHolds(
    query: ContainerQuery,
    el: Element,
    self: boolean,
  ): boolean {
    const found = this._containerFor(query, el, self);
    // no container is an unknown, and holds nowhere
    if (!found) return false;
    const [container, style] = found;
    const size = query.axes
      ? (this._containerSizes.get(container) ?? null)
      : null;
    const scroll =
      query.scroll || query.anchored
        ? (this._scrollStates.get(container) ?? NO_SCROLL_STATES)
        : null;
    // what it compares in a `rem` or an `rlh` is the root's, wherever the
    // element is (`rootReaders`)
    const outerRoot = this._rootBits;
    this._rootBits = 0;
    const answer = this._ask(query, size, style, scroll, container, el);
    const rootRead = this._rootBits;
    this._rootBits = outerRoot;
    if (rootRead) {
      this._queryRoot.set(el, (this._queryRoot.get(el) ?? 0) | rootRead);
    }
    if (query.axes || query.scroll || query.anchored) {
      if (query.scroll) this._scrollRead = true;
      let reads = this._containerReads.get(el);
      if (!reads) this._containerReads.set(el, (reads = new Map()));
      reads.set(this._readKey(query, self), { container, answer });
    }
    return answer;
  }

  /** A query's answer for a container of a size and a style. */
  private _ask(
    query: ContainerQuery,
    size: ContainerSize | null,
    style: ComputedStyle,
    scroll: ScrollStates | null = null,
    /** The container, whose attributes an `attr()` in a feature reads. */
    container: Element | null = null,
    /** The element whose rule asks, for whom the containers its container
     *  units read are noted (`_queryUnit`): none where an answer is only
     *  compared with the last (`containersMoved`). */
    reader: Element | null = null,
  ): boolean {
    return containerHolds(
      query,
      size,
      (name) => style.custom?.get(name),
      (text) => {
        // a query's relative lengths are the container's (3.2), and its
        // lengths at the container's zoom, since its size is: a query is
        // in the container's CSS pixels (CSS Viewport 1, 5)
        const zoom = style.effectiveZoom;
        const root = this._root;
        const ctx: UnitContext = {
          em: style.fontSize,
          rem: root
            ? (root.fontSize * zoom) / root.effectiveZoom
            : style.fontSize,
          remRead: this._remRead,
          rlh: () => {
            this._rlhRead();
            return root
              ? (this._lineHeightOf(root) * zoom) / root.effectiveZoom
              : this._lineHeightOf(style);
          },
          vw: this.viewportWidth * zoom,
          vh: this.viewportHeight * zoom,
          viewport: this._queryViewportRead,
          cq: (axis) => this._queryUnit(container, axis, zoom, reader),
          scale: this.scale * zoom,
        };
        const len = parseLength(text, ctx);
        return typeof len === 'number' ? len : null;
      },
      scroll,
      // a `var()` in what a feature compares with is the container's,
      // and so is an attribute an `attr()` reads (CSS Values 5, 7.7)
      (text) => {
        const attr = !!container && ATTR_IN.test(text);
        if (!attr && !hasVar(text)) return text;
        return substitute(
          text,
          style.custom ?? this._registeredBase,
          attr
            ? {
                ...this._ifEnv,
                attribute: (name, namespace) =>
                  attributeIn(container, name, namespace),
              }
            : null,
        );
      },
      (name) => this._registered?.get(name) ?? null,
      (text) => {
        const picked = LIGHT_DARK.test(text)
          ? lightDark(text, style.colorScheme)
          : text;
        return picked === null ? null : parseColor(picked);
      },
      // an `inherit` is what the container inherits: its parent's in the
      // flat tree, and at the top the initial values of what is registered
      (name) => {
        const parent = container && flatParentOf(container);
        const from = parent ? this.stylesOf?.(parent) : undefined;
        return (from?.custom ?? this._registeredBase)?.get(name);
      },
    );
  }

  /** The container a query asks for `el`, and its style: the nearest
   *  ancestor in the flat tree — or `el`, for its pseudo-element — of the
   *  query's name, if it gives one, and that is a size container of the
   *  axes it reads. An inline box takes no size containment, and is no
   *  size container; an element of no box — `display: contents` — still
   *  is one, whose size features are unknown (CSS Conditional 5, 3.1), so
   *  a style feature beside them in an `or` still answers. */
  private _containerFor(
    query: ContainerQuery,
    el: Element,
    self: boolean,
  ): [Element, ComputedStyle] | null {
    const stylesOf = this.stylesOf;
    if (!stylesOf) return null;
    for (let at = self ? el : flatParentOf(el); at; at = flatParentOf(at)) {
      const style = stylesOf(at);
      if (!style) continue;
      if (
        query.name !== null &&
        !` ${style.containerName} `.includes(` ${query.name} `)
      ) {
        continue;
      }
      if (query.axes) {
        const type = style.containerType;
        if (type === 'normal' || style.display === 'inline') continue;
        if (query.axes & BLOCK_AXIS && type !== 'size') continue;
      }
      // a scroll-state query, of a scroll-state container, and an anchored
      // one of an anchored container
      if (query.scroll && !style.scrollStateContainer) continue;
      if (query.anchored && !style.anchoredContainer) continue;
      return [at, style];
    }
    return null;
  }

  /** Whether any rule is under an `@container` whose answer is a size's. */
  get readsContainers(): boolean {
    return this._containerReads.size > 0;
  }

  /** Moves whenever what a custom highlight's style reads may have
   *  changed — a container's size (`sizeContainers`), or the tree, which
   *  an element's own style may not show (`HtmlViewNode.touchDocument`):
   *  what a highlight's styler keeps is good while it stands. */
  highlightGeneration = 0;

  /**
   * Every size container's content box as a layout left it, whether or not
   * a style read it (`sizeOf` as `containersMoved` takes it): a custom
   * highlight's style is worked out as the document is painted, after the
   * layout that `containersMoved` hears of, and its `@container` rules and
   * container units read the containers no element's style did.
   */
  sizeContainers(
    containers: Iterable<Element>,
    sizeOf: (el: Element) => ContainerSize | null | undefined,
  ): void {
    for (const el of containers) {
      const size = sizeOf(el);
      if (size === undefined) continue;
      const had = this._containerSizes.get(el);
      if (
        had === size ||
        (had && size && had.width === size.width && had.height === size.height)
      ) {
        continue;
      }
      // a style that read it still hears of it from `containersMoved`,
      // which compares what it read with what `sizeOf` says, not with this
      this._containerSizes.set(el, size);
      this.highlightGeneration += 1;
    }
  }

  /** Whether some style read a container's scroll state, which a scroll
   *  can move with no layout (`containersMoved`'s `scrollOf`). */
  get readsScrollState(): boolean {
    return this._scrollRead && this._containerReads.size > 0;
  }

  /**
   * A layout came to these sizes: `sizeOf` a size container's content box,
   * in device pixels, null for one it gave no box, or undefined where it
   * did not lay the container out and its size stands. The elements whose
   * container queries answer otherwise for them, which the boxes are
   * built again for, keeping every other element's style — or null for
   * none, which is a layout most of the time: a width a query does not
   * turn on changes no answer.
   */
  containersMoved(
    sizeOf: (el: Element) => ContainerSize | null | undefined,
    /** A scroll-state container's scroll states, as `sizeOf` its size:
     *  undefined where they stand as they were told last. */
    scrollOf: ((el: Element) => ScrollStates | undefined) | null = null,
  ): Set<Element> | null {
    if (!this._containerReads.size) return null;
    const sizes = new Map<Element, ContainerSize | null | undefined>();
    const scrolls = new Map<Element, ScrollStates | undefined>();
    const moved = new Set<Element>();
    // a query asked again reads the containers its units are of at the
    // sizes this layout gave them, which no style may have read yet
    this._moving = (container) => {
      if (!sizes.has(container)) sizes.set(container, sizeOf(container));
      return sizes.get(container);
    };
    try {
      for (const [el, reads] of this._containerReads) {
        for (const [query, read] of reads) {
          let size: ContainerSize | null | undefined;
          if (query.axes) {
            size = sizes.get(read.container);
            if (!sizes.has(read.container)) {
              size = sizeOf(read.container);
              sizes.set(read.container, size);
            }
          } else size = this._containerSizes.get(read.container) ?? null;
          let scroll: ScrollStates | undefined;
          if (query.scroll || query.anchored) {
            if (!scrolls.has(read.container)) {
              scrolls.set(read.container, scrollOf?.(read.container));
            }
            scroll = scrolls.get(read.container);
          }
          // nothing it reads is told otherwise
          if (size === undefined && scroll === undefined) continue;
          if (query.axes && size === undefined) {
            size = this._containerSizes.get(read.container) ?? null;
          }
          const style = this.stylesOf?.(read.container);
          if (!style) continue;
          const now = UNIT_AXIS.has(query)
            ? this._unitBasis(query, size ?? null)
            : this._ask(
                query,
                size ?? null,
                style,
                query.scroll || query.anchored
                  ? (scroll ??
                      this._scrollStates.get(read.container) ??
                      NO_SCROLL_STATES)
                  : null,
                read.container,
              );
          if (now !== read.answer) {
            moved.add(el);
            break;
          }
        }
      }
    } finally {
      this._moving = null;
    }
    for (const [container, size] of sizes) {
      if (size !== undefined) this._containerSizes.set(container, size);
    }
    for (const [container, scroll] of scrolls) {
      if (scroll !== undefined) this._scrollStates.set(container, scroll);
    }
    return moved.size ? moved : null;
  }

  /** A layout's sizes, while `containersMoved` asks the queries again. */
  private _moving:
    ((container: Element) => ContainerSize | null | undefined) | null = null;

  /** A size container's content box: as the layout being heard of left it
   *  (`_moving`), or as the last one did. */
  private _sizeOf(container: Element): ContainerSize | null {
    const now = this._moving?.(container);
    return now !== undefined
      ? now
      : (this._containerSizes.get(container) ?? null);
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
    let inherits = false;
    // a set that reads the element's attributes is the element's alone
    let attributes = false;
    for (const c of candidates) {
      if (!this._hasCustom(c)) continue;
      key += `${this._idOf(c.declarations)}:${c.only},`;
      if (!inherits && customInherits(c)) inherits = true;
      if (!attributes) {
        for (const d of pick(c)) {
          if (d.custom && ATTR_IN.test(d.value)) attributes = true;
        }
      }
    }
    // what an `inherit()` of a property finds is the parent's style, not
    // only its custom properties, so the set is the parent's style's own
    if (inherits) key = `${this._idOf(parentStyle)}^${key}`;
    const parent = parentStyle.custom ?? this._registeredBase;
    // what a registered property that does not inherit holds above, it
    // does not hold here: a function of the parent's set, so of the key
    const resets =
      parent && this._nonInherited ? this._resetsUnder(parent) : null;
    if (!key && !resets) return parent;
    key = `${parent ? this._idOf(parent) : 0}|${key}`;
    const hit = attributes ? undefined : this._customs.get(key);
    if (hit) return hit;
    const own = new Map<string, string>();
    if (resets) {
      for (const [name, initial] of resets) own.set(name, initial ?? 'initial');
    }
    for (const c of candidates) {
      for (const d of pick(c)) if (d.custom) own.set(d.prop, d.value);
    }
    const env = inherits ? this._inheritEnv(parentStyle, '') : this._ifEnv;
    const made = customProperties(
      own,
      parent,
      attributes ? { ...env, attribute: this._attributeOf } : env,
      this._registered,
    );
    if (!attributes) this._customs.set(key, made);
    return made;
  }

  /** The registered properties that do not inherit and that `parent`
   *  holds at other than their initial values, with those values: what an
   *  element under it is reset to. Null for none. */
  private _resetsUnder(
    parent: CustomProps,
  ): ReadonlyMap<string, string | null> | null {
    let known = this._resets.get(parent);
    if (known !== undefined) return known;
    let out: Map<string, string | null> | null = null;
    for (const [name, initial] of this._nonInherited!) {
      if (parent.get(name) !== (initial ?? undefined)) {
        (out ??= new Map()).set(name, initial);
      }
    }
    this._resets.set(parent, out);
    return out;
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
    if (
      kept !== null &&
      !this._rootMoved &&
      !kept.restyle.has(el) &&
      (!kept.follow || this._parentAsWas(el, parentStyle, kept)) &&
      !this._underNewContainer(el)
    ) {
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
    const made = this._styleToShare(
      el,
      parentStyle,
      parentKey,
      inFlexContainer,
    );
    if (kept !== null) {
      const was = kept.styles.get(el)?.style;
      if (was && !sameContainer(was, made.style)) this._newContainers.add(el);
    }
    return made;
  }

  /** The elements this build found another kind of container than they
   *  were, or stopped being one: what a query in anything under one finds
   *  has changed, whatever its parent's style came to (`sameContainer`). */
  private _newContainers = new Set<Element>();
  private _underNewContainer(el: Element): boolean {
    if (!this._newContainers.size) return false;
    for (let at = flatParentOf(el); at; at = flatParentOf(at)) {
      if (this._newContainers.has(at)) return true;
    }
    return false;
  }

  /** The style of an element no style kept answers for, shared where it
   *  can be. */
  private _styleToShare(
    el: Element,
    parentStyle: ComputedStyle,
    parentKey: number,
    inFlexContainer: boolean,
  ): SharedStyle {
    // one a script animates is as far through its animations as the page
    // has it, and another element alike in every way is not: two `<li>`s
    // with one faded in shared the fade
    if (this.scripts?.has(el)) {
      return {
        style: this.styleFor(el, parentStyle, inFlexContainer),
        key: this._nextShareKey++,
      };
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
        this._containerUnitRead = false;
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
        if (!this._running(shared.style, el) && !this._containerUnitRead) {
          this._sharedByMatch.set(key, shared);
        }
      }
      return shared;
    }
    let shared = this._shared.get(key);
    if (shared === undefined) {
      this._containerUnitRead = false;
      shared = {
        style: this.styleFor(el, parentStyle, inFlexContainer),
        key: this._nextShareKey++,
      };
      if (!this._running(shared.style, el) && !this._containerUnitRead) {
        this._shared.set(key, shared);
      }
    }
    return shared;
  }

  /** Whether a style is an element's alone: one its animations run in is
   *  as far through them as its own started, and no other element's, and
   *  one its transitions run in is where its own are. */
  private _running(style: ComputedStyle, el: Element): boolean {
    // and one a script animates, at rest as much as on a clock
    if (this.scripts?.has(el)) return true;
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
    if (index.ownStyleRoot && !elementParent(el)) return false;
    if (index.ownStyleAttrs.size) {
      for (const name in el.attribs) {
        if (index.ownStyleAttrs.has(name.toLowerCase())) return false;
      }
    }
    if (index.ownStyleIds.size) {
      const id = attr(el, 'id');
      if (id && index.ownStyleIds.has(id)) return false;
    }
    if (index.ownStyleClasses.size) {
      const className = attr(el, 'class');
      if (className) {
        for (const name of className.split(CLASS_SPACE)) {
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
    // Worked out already under this very style, in a build: the builder
    // asks again for the counters, and a build that keeps an element's
    // style keeps what it was worked out from — what else changes one in a
    // build, the pointer, a band crossed, an animation's clock, styles the
    // element again (`KeptStyles`), into a style of its own. A crossing's
    // build matched a document's every `::before` and `::after` again, half
    // of it on Wikipedia. Not outside one: a hover or an animation frame
    // restyled in place changes a pseudo-element and not the element, and
    // what that comes to is kept for the next build to start from — where
    // it was worked out on the document's timeline. A layer's frames are
    // sampled on a fork of it (`sprites.ts`), at times through a cycle, and
    // a build that kept the element gave its pseudo-element the last.
    const style = (): ComputedStyle | null =>
      this._pseudoStyle(el, which, elementStyle, indexed, edges);
    if (this.timeline !== this._buildTimeline) return style();
    let kept = this._pseudoKept.get(el);
    if (kept?.from !== elementStyle) {
      kept = { from: elementStyle, before: undefined, after: undefined };
      this._pseudoKept.set(el, kept);
    } else if (this._inBuild && kept[which] !== undefined) {
      return kept[which];
    }
    return (kept[which] = style());
  }

  /** What `pseudoStyleFor` keeps, by element: the style worked out from,
   *  and each pseudo-element's style under it, undefined until asked. */
  private _pseudoKept = new WeakMap<
    Element,
    {
      from: ComputedStyle;
      before: ComputedStyle | null | undefined;
      after: ComputedStyle | null | undefined;
    }
  >();

  /**
   * A `::before`'s or an `::after`'s style as `getComputedStyle` reads it:
   * the one `pseudoStyleFor` makes where the element has one, and where it
   * has none, what the rules that reach it make of it all the same — a
   * browser answers for a pseudo-element its rules style whether or not
   * they give it a `content`. Null where no rule reaches it. Kept nowhere,
   * and its animations at rest: a style of no content makes no box.
   */
  pseudoComputedStyle(
    el: Element,
    which: 'before' | 'after',
    elementStyle: ComputedStyle,
  ): ComputedStyle | null {
    const generated = this.pseudoStyleFor(el, which, elementStyle);
    if (generated) return generated;
    const index = this._pseudo[which];
    const indexed = index.size > 0 && index.reaches(el);
    const edges = this._scoped && this._scopedPseudos.has(which);
    if (!indexed && !edges) return null;
    return this._pseudoStyle(el, which, elementStyle, indexed, edges, false);
  }

  private _pseudoStyle(
    el: Element,
    which: 'before' | 'after',
    elementStyle: ComputedStyle,
    indexed: boolean,
    edges: boolean,
    /** Whether only one with a `content` is a style: one that makes a box,
     *  whose animations run. */
    generated = true,
  ): ComputedStyle | null {
    const candidates: Candidate[] = [];
    if (indexed) this._matchInto(this._pseudo[which], el, candidates);
    if (edges) this._scopedInto(el, which, candidates);
    if (!candidates.length) return null;
    // One that no rule gives a `content` is none, whatever else reaches it —
    // `content` is not inherited, and its initial `normal` is nothing here.
    // Tailwind's `*, ::before, ::after` reaches both of every element's.
    if (generated && !candidates.some(setsContent)) return null;
    candidates.sort(byCascade);
    const style = this._computeStyle(
      el,
      elementStyle,
      elementStyle.display === 'flex' || elementStyle.display === 'inline-flex',
      candidates,
      false,
      generated ? which : null,
    );
    if (!generated) return style;
    if (style.content === 'normal' || style.content === 'none') return null;
    // what `auto` is on a `::before` or an `::after` (CSS UI 4, 6.1): text
    // a stylesheet made up, which no browser selects or copies
    if (style.userSelect === 'auto') style.userSelect = 'none';
    return style;
  }

  /**
   * The style of one of a view transition's pseudo-elements (CSS View
   * Transitions 1, 3): the rules for its part whose argument it answers —
   * its name or `*`, and classes its element had — over what the
   * transition gives it itself (`dynamic`: the user agent's, after its
   * sheet, 7.8), inheriting from `parentStyle`, the style of the part it
   * hangs in, and the root element's for the tree's root. Its animations
   * run on `timeline`, which is the transition's, as `key`.
   */
  transitionStyle(
    root: Element,
    part: TransitionPart['part'],
    name: string,
    classes: readonly string[],
    onlyChild: boolean,
    parentStyle: ComputedStyle,
    dynamic: readonly Declaration[],
    timeline: AnimationTimeline,
    key: string,
    /** The style under its animations, which `getKeyframes()` reads an
     *  end the rule has no frame at from. */
    underlying = false,
  ): ComputedStyle {
    const candidates: Candidate[] = [];
    if (this._transitionRules.size > 0) {
      this._matchInto(
        this._transitionRules,
        root,
        candidates,
        undefined,
        (indexed) => {
          const p = TRANSITION_PARTS.get(indexed.rule);
          return (
            !!p &&
            p.part === part &&
            (p.name === '*' || p.name === name) &&
            p.classes.every((c) => classes.includes(c)) &&
            (!p.onlyChild || onlyChild)
          );
        },
      );
    }
    if (dynamic.length) {
      candidates.push({
        origin: Origin.UserAgent,
        context: 0,
        tree: null,
        layer: null,
        // as `:root::view-transition-group(name)` is, over the sheet's
        // `(*)` rules
        specificity: 1_001,
        order: -1,
        declarations: dynamic as Declaration[],
        only: -1,
      });
    }
    candidates.sort(byCascade);
    if (underlying) {
      return this._cascadeStyle(root, parentStyle, false, candidates, false);
    }
    const was = this.timeline;
    this.timeline = timeline;
    try {
      return this._computeStyle(
        root,
        parentStyle,
        false,
        candidates,
        false,
        key,
      );
    } finally {
      this.timeline = was;
    }
  }

  /** An element's style under its animations and transitions: what an
   *  animation's keyframes run from and to where they give no value. */
  underlyingStyleFor(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
  ): ComputedStyle {
    return this._cascadeStyle(
      el,
      parentStyle,
      inFlexContainer,
      this._candidates(el),
      true,
    );
  }

  /**
   * The style of the `::backdrop` of an element in its top layer (CSS
   * Position 4, 3.2): a box fixed to the viewport, all of it, under the
   * element and over everything before it in the layer, in the UA sheet's
   * dim — Primer's search dialog sets its own. It inherits from its element
   * (CSS Position 4 since 2023, and Chrome), so a dialog's `color` is its
   * backdrop's `currentColor`. Drawn at rest: a backdrop's animations, a
   * fade in as the dialog opens, run on no clock here.
   */
  /**
   * The style of a `<details>`'s `::details-content` (CSS Pseudo 4, 3.4):
   * the box all it holds but its summary is in, which inherits from it —
   * the UA sheet's `display: block`, and `content-visibility: hidden` while
   * it is shut, which leaves it a box of no size with nothing in it. Its
   * animations and transitions run on the element's clock as a `::before`'s
   * do, so an accordion can open a height to `auto` (`interpolate-size`).
   */
  detailsContentStyleFor(
    el: Element,
    elementStyle: ComputedStyle,
  ): ComputedStyle {
    const index = this._pseudo['details-content'];
    const candidates: Candidate[] = [];
    if (index.size > 0 && index.reaches(el)) {
      this._matchInto(index, el, candidates);
    }
    if (this._scoped && this._scopedPseudos.has('details-content')) {
      this._scopedInto(el, 'details-content', candidates);
    }
    candidates.sort(byCascade);
    return this._computeStyle(
      el,
      elementStyle,
      elementStyle.display === 'flex' || elementStyle.display === 'inline-flex',
      candidates,
      false,
      'details-content',
    );
  }

  backdropStyleFor(el: Element, elementStyle: ComputedStyle): ComputedStyle {
    const index = this._pseudo.backdrop;
    const candidates: Candidate[] = [];
    if (index.size > 0 && index.reaches(el)) {
      this._matchInto(index, el, candidates);
    }
    if (this._scoped && this._scopedPseudos.has('backdrop')) {
      this._scopedInto(el, 'backdrop', candidates);
    }
    candidates.sort(byCascade);
    const style = this._computeStyle(
      el,
      elementStyle,
      false,
      candidates,
      false,
      null,
    );
    // in the top layer with its element, and out of the flow as it is
    if (style.position !== 'absolute' && style.position !== 'fixed') {
      style.position = 'absolute';
      blockify(style, false);
    }
    return style;
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

  /** Whether any rule styles a `::first-letter`, which a block's letter is
   *  looked for through its first blocks for (`buildSubtrees`). */
  get hasFirstLetter(): boolean {
    return this._pseudo['first-letter'].size > 0;
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

  /** Whether any rule styles a custom highlight or `::target-text`
   *  (`highlightStyle`), which the UA sheet's does. */
  get hasHighlights(): boolean {
    return this._highlights.size > 0;
  }

  /**
   * An element's `::highlight(name)`, over its parent's: the colour and
   * the background the rules for that highlight set, and its parent's for
   * either they leave alone, inherited along the chain of that highlight as
   * `::selection`'s is (CSS Pseudo 4, 3.5). A custom highlight has no
   * default look: text no rule reaches is drawn as it was. `::target-text`
   * is the highlight named `TARGET_TEXT`, which the UA sheet gives one.
   */
  highlightStyle(
    el: Element,
    style: ComputedStyle,
    name: string,
    parent: SelectionStyle | null,
  ): SelectionStyle | null {
    const index = this._highlights.get(name);
    if (!index || !index.size || !index.reaches(el)) return parent;
    const candidates: Candidate[] = [];
    this._matchInto(index, el, candidates);
    let color = false;
    let background = false;
    let decorated = false;
    let shadowed = false;
    for (const candidate of candidates) {
      for (const d of candidate.declarations) {
        if (d.prop === 'color') color = true;
        else if (d.prop === 'background' || d.prop === 'background-color') {
          background = true;
        } else if (DECORATION_PROPS.has(d.prop)) decorated = true;
        else if (d.prop === 'text-shadow') shadowed = true;
      }
    }
    if (!color && !background && !decorated && !shadowed) return parent;
    candidates.sort(byCascade);
    const own = this._computeStyle(el, style, false, candidates);
    let decoration = parent?.decoration ?? null;
    if (decorated) {
      // its own lines alone: the ones the element's text is drawn with are
      // the element's to draw, and the highlight's computed style inherits
      // them as any style does
      const ruled = { ...own, underline: null, lineThrough: null };
      decorate(ruled);
      decoration = ruled.underline || ruled.lineThrough ? ruled : null;
    }
    let shadow = parent?.shadow ?? null;
    if (shadowed) {
      shadow = own.textShadow?.length
        ? { shadows: own.textShadow, color: own.color }
        : null;
    }
    return {
      color: color ? own.color : (parent?.color ?? null),
      background: background
        ? own.backgroundColor
        : (parent?.background ?? null),
      decoration,
      shadow,
    };
  }

  /**
   * A highlight pseudo-element's computed style, as `getComputedStyle`
   * reads it (CSS Pseudo 4, 7.3), over its originating element's parent's
   * (`parent`, null at the root): `key` is `highlightKey`'s. Only the
   * properties a highlight takes are its own (3.2) — the colour, the
   * background colour, the text decoration, the text shadow, the fill and
   * the stroke — and each the rules leave alone, or set to `inherit` or
   * `unset`, is the parent's highlight's, inherited or not (3.5). At the
   * root it is its initial value, and the colour `currentColor`. Every
   * other property is the element's, which is what a font-relative length
   * is resolved against, and a custom property is the element's where the
   * highlight's rules set none.
   *
   * Worked out as it is asked for, and kept nowhere: the painter has its
   * own (`highlightStyle`), which is what a frame draws.
   */
  highlightPseudoStyle(
    el: Element,
    style: ComputedStyle,
    key: string,
    parent: HighlightPseudoStyle | null,
  ): HighlightPseudoStyle {
    const index =
      key === SELECTION ? this._pseudo.selection : this._highlights.get(key);
    // the value each field is last given, in cascade order
    const given = new Map<HighlightField, string>();
    let own: ComputedStyle | null = null;
    if (index?.size && index.reaches(el)) {
      const matched: Candidate[] = [];
      this._matchInto(index, el, matched);
      const candidates: Candidate[] = [];
      for (const c of matched) {
        // the user agent's look — `::target-text`'s marks — is a paired
        // default (3.3.1) the painter falls back on, and no part of what
        // the cascade computes: Chrome reads the originating element's
        // colour where no author's rule sets one
        if (
          c.origin === Origin.UserAgent ||
          c.origin === Origin.UserAgentImportant
        ) {
          continue;
        }
        const declarations = pick(c).filter(
          (d) => d.custom || Object.hasOwn(HIGHLIGHT_FIELDS, d.prop),
        );
        if (declarations.length) {
          candidates.push({ ...c, declarations, only: -1 });
        }
      }
      if (candidates.length) {
        candidates.sort(byCascade);
        for (const c of candidates) {
          for (const d of c.declarations) {
            for (const field of HIGHLIGHT_FIELDS[d.prop] ?? []) {
              given.set(field, d.value.trim().toLowerCase());
            }
          }
        }
        own = this._computeStyle(el, style, false, candidates);
      }
    }
    const out: ComputedStyle = {
      ...style,
      custom: own?.custom ?? style.custom,
    };
    const set = (field: HighlightField): boolean => {
      const value = given.get(field);
      return value !== undefined && value !== 'inherit' && value !== 'unset';
    };
    for (const field of HIGHLIGHT_FIELD_LIST) {
      if (field === 'color') continue;
      const from = set(field) ? own! : (parent?.style ?? this.initial);
      (out as unknown as Record<string, unknown>)[field] = from[field];
    }
    // the colour with the colour it was read from (`colorSource`)
    let currentColor: boolean;
    let from: ComputedStyle;
    if (set('color')) {
      currentColor = given.get('color') === 'currentcolor';
      from = currentColor ? style : own!;
    } else if (parent && !parent.currentColor) {
      currentColor = false;
      from = parent.style;
    } else {
      currentColor = true;
      from = style;
    }
    out.color = from.color;
    out.colorSource = from.colorSource;
    return { style: out, currentColor };
  }

  /**
   * Whether a rule for a `::placeholder` tests the pointer
   * (`hoverSensitive`) or the focus (`focusSensitive`). A move of either
   * restyles no box for it, where one for any other pseudo-element does
   * (`hoverPseudo`): what it changes is a widget's, which is told the look
   * again (`HtmlViewNode._reportControls`). `input:focus::placeholder {
   * color: transparent }`, which takes the hint away as the field is
   * typed into, is the one pages write.
   */
  placeholderFollows(state: 'hoverSensitive' | 'focusSensitive'): boolean {
    return this._pseudo.placeholder[state];
  }

  /**
   * A text field's `::placeholder` style, inheriting from its own (CSS
   * Pseudo 4), or null where no rule reaches it — and the UA sheet's
   * reaches every field. Only the properties that apply to a `::first-line`
   * apply to it, and the widget it is handed to draws the colour and the
   * opacity of them (`controlRectsOf`).
   *
   * Kept by element, under the style it inherits from and the rules that
   * matched: the controls are reported at every layout, and a focus that
   * changes which rules match asks again and comes to another answer.
   */
  placeholderStyle(el: Element, style: ComputedStyle): ComputedStyle | null {
    const index = this._pseudo.placeholder;
    const indexed = index.size > 0 && index.reaches(el);
    const edges = this._scoped && this._scopedPseudos.has('placeholder');
    if (!indexed && !edges) return null;
    const candidates: Candidate[] = [];
    const matched: number[] = [];
    if (indexed) this._matchInto(index, el, candidates, matched);
    if (edges) this._scopedInto(el, 'placeholder', candidates, matched);
    if (!candidates.length) return null;
    const key = matched.join(',');
    const kept = this._placeholders.get(el);
    if (kept?.from === style && kept.key === key) return kept.style;
    candidates.sort(byCascade);
    const out = this._computeStyle(el, style, false, candidates);
    this._placeholders.set(el, { from: style, key, style: out });
    return out;
  }

  /**
   * Which of a scroll container's bars its `::-webkit-scrollbar` hides:
   * both at `display: none`, and the vertical one at `width: 0` and the
   * horizontal one at `height: 0`, as Chrome and Safari have it. Pages
   * hide a carousel's bar so, often beside `scrollbar-width: none`, which
   * the computed style holds. Kept by element, as a placeholder's is.
   */
  scrollbarHidden(
    el: Element,
    style: ComputedStyle,
  ): { x: boolean; y: boolean } {
    const index = this._pseudo.scrollbar;
    if (!index.size || !index.reaches(el)) return SHOWN;
    const candidates: Candidate[] = [];
    const matched: number[] = [];
    this._matchInto(index, el, candidates, matched);
    if (!candidates.length) return SHOWN;
    const key = matched.join(',');
    const kept = this._scrollbars.get(el);
    if (kept?.from === style && kept.key === key) return kept.hidden;
    candidates.sort(byCascade);
    const out = this._computeStyle(el, style, false, candidates);
    const none = out.display === 'none';
    const hidden = { x: none || out.height === 0, y: none || out.width === 0 };
    this._scrollbars.set(el, { from: style, key, hidden });
    return hidden;
  }

  /** What `scrollbarHidden` keeps, by element. */
  private _scrollbars = new WeakMap<
    Element,
    { from: ComputedStyle; key: string; hidden: { x: boolean; y: boolean } }
  >();

  /** What `placeholderStyle` keeps, by element. */
  private _placeholders = new WeakMap<
    Element,
    { from: ComputedStyle; key: string; style: ComputedStyle }
  >();

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

  /** Faces came or changed: what was read of one is read again, the list
   *  it is kept under being the same where a family has another weight now
   *  (`HtmlViewNode._takeFaces`). */
  facesChanged(): void {
    this._xHeights.clear();
    this._zeroWidths.clear();
    this._normalLines.clear();
  }

  /** The x-height of a style's font: the font's own, asked once per face,
   *  or half an em. */
  private _exOf(style: FaceSource): number {
    this._faceRead = true;
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
    this._faceRead = true;
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
    this._faceRead = true;
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
    // which sides of the viewport it reads, noted on the style
    // (`viewportReaders`), and on any style being computed around it; and
    // what of the root's font, the same way (`rootReaders`)
    const outer = this._sidesRead;
    const outerRoot = this._rootBits;
    const outerFace = this._faceRead;
    this._sidesRead = 0;
    this._rootBits = 0;
    this._faceRead = false;
    const style = this._computeStyleOf(
      el,
      parentStyle,
      inFlexContainer,
      candidates,
      own,
      target,
    );
    const sides = this._sidesRead;
    this._sidesRead = outer | sides;
    if (sides) {
      VIEWPORT_SIDES.set(style, (VIEWPORT_SIDES.get(style) ?? 0) | sides);
      if (!own) {
        this._pseudoSides.set(el, (this._pseudoSides.get(el) ?? 0) | sides);
      }
    }
    if (this._faceRead) FACE_READS.add(style);
    this._faceRead ||= outerFace;
    const rootBits = this._rootBits;
    this._rootBits = outerRoot | rootBits;
    if (rootBits) {
      ROOT_READS.set(style, (ROOT_READS.get(style) ?? 0) | rootBits);
      if (!own) {
        this._pseudoRoot.set(el, (this._pseudoRoot.get(el) ?? 0) | rootBits);
      }
    }
    // where the root's font moved in a build that keeps styles, every one
    // that reads it is computed again, wherever it is: its parent's can
    // come out as it was (`sharedStyleFor`)
    if (own && this._rootRead && this._kept && isRootElement(el)) {
      const was = this._kept.styles.get(el)?.style;
      if (was && this.rootMetricsMoved(was, style)) this._rootMoved = true;
    }
    return style;
  }

  private _computeStyleOf(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
    candidates: Candidate[],
    own: boolean,
    target: string | null,
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
    // what they come to, a list of declarations each, at the animation
    // origin; and what they make of the element as `will-change` would
    let layers: Declaration[][] | null = null;
    let willChange = 0;
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
        style.animationTimeline,
        style.animationRangeStart,
        style.animationRangeEnd,
      );
      animated = fieldsAnimatedBy(samples);
      if (samples) {
        layers = this._animatedDeclarations(
          el,
          parentStyle,
          inFlexContainer,
          candidates,
          own,
          style,
          samples,
        );
        // its next frame is when what they draw next changes
        timeline.pace(el, target!, timeline.now + this._unchangedFor);
      }
      // what its animations set acts as named in `will-change`, in a delay
      // as much as under way (Web Animations 1, 5.6): a style made here is
      // the element's alone (`_alone`)
      willChange |= timeline.willChange(el, target!);
    } else {
      layers = restingFrames(style.animations, keyframesOf);
      // and at rest, each that fills forwards is in effect
      willChange |= restingWillChange(style.animations, keyframesOf);
    }
    // And the animations the page's scripts made for it, over its CSS
    // animations, as they composite (Web Animations 1, 5.4.2): a frame they
    // leave a property out of at either end is the element's value under
    // the CSS ones. On the timeline's clock, which asks for their frames as
    // it does a CSS animation's, or at rest.
    const scripted =
      target === null ? null : (this.scripts?.of(el, target) ?? null);
    if (scripted) {
      const sampling = sampleScripts(scripted, timeline ? timeline.now : null);
      let unchanged = Infinity;
      if (sampling.samples) {
        const under = layers
          ? this._cascadeStyle(
              el,
              parentStyle,
              inFlexContainer,
              withAnimations(candidates, layers),
              own,
            )
          : style;
        const declarations = this._animatedDeclarations(
          el,
          parentStyle,
          inFlexContainer,
          candidates,
          own,
          under,
          sampling.samples,
        );
        unchanged = this._unchangedFor;
        layers = layers ? [...layers, ...declarations] : declarations;
        const fields = fieldsAnimatedBy(sampling.samples)!;
        animated = animated ? new Set([...animated, ...fields]) : fields;
      }
      timeline?.noteScripts(el, target!, sampling, timeline.now + unchanged);
      willChange |= sampling.willChange;
    } else if (timeline?.hasScripts(el, target!)) {
      // a script's last animation of it is over
      timeline.noteScripts(el, target!, null);
    }
    if (layers) {
      style = this._cascadeStyle(
        el,
        parentStyle,
        inFlexContainer,
        withAnimations(candidates, layers),
        own,
      );
    }
    style.willChange |= willChange;
    // and what its transitions make of it, from the style the document has
    // for it now (CSS Transitions 1, 3): none for one not displayed, and
    // none on what its animations set, now or in the style before
    if (timeline) {
      const pseudo = target!;
      if (style.display === 'none') timeline.dropTransitions(el, pseudo);
      else {
        const settled = style;
        style = timeline.transition(
          el,
          pseudo,
          style,
          () => this.previous?.(el, pseudo) ?? null,
          animated,
        );
        if (animated) noteAnimated(style, animated);
        // a `content-visibility` a transition runs brings its own
        // containment, which the cascade settled for the value after
        if (style.contentVisibility !== settled.contentVisibility) {
          settleContentVisibility(style);
        }
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
    // how long from now what they draw changes by nothing anyone sees
    // (`_unchangedFor`), and how far from where a transform turns or scales
    // what it moves can be: twice the box's sides where its style says
    // them, and twice the viewport's longer side where it does not
    let unchanged = Infinity;
    const w = base.width;
    const h = base.height;
    const reach =
      typeof w === 'number' && typeof h === 'number'
        ? 2 * (w + h)
        : 2 * Math.max(this.viewportWidth, this.viewportHeight, 2048);
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
    for (const sample of samples) {
      const { rule, progress, easing } = sample;
      const declarations: Declaration[] = [];
      for (const [prop, frames] of tracksOf(rule)) {
        const span = spanAt(frames, progress, easing);
        const { from, to, q } = span;
        const fields = animatedFields(prop);
        if (!fields) {
          // a property whose values this cannot read goes over half-way,
          // as its declaration: the element's own, where that end is it
          const at = discrete(from, to, q);
          if (at) declarations.push(at.declaration);
          unchanged = 0;
          continue;
        }
        let a = styleAt(from?.frame ?? null) as unknown as Record<
          string,
          unknown
        >;
        let b = styleAt(to?.frame ?? null) as unknown as Record<
          string,
          unknown
        >;
        // a size between a length and a keyword, as a `calc-size()` of the
        // keyword, where `interpolate-size` lets it run (`keywordSizes`)
        if (
          (prop === 'height' || prop === 'width') &&
          base.interpolateSize === 'allow-keywords'
        ) {
          const pair = keywordSizes(
            a as unknown as ComputedStyle,
            b as unknown as ComputedStyle,
          );
          if (pair) {
            a = { ...a, ...pair.was };
            b = { ...b, ...pair.now };
          }
        }
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
          unchanged = 0;
        } else if (unchanged > 0 && sample.left > 0) {
          let most = 0;
          for (const key of fields) {
            most = Math.max(most, visibleSpan(key, a[key], b[key], reach));
          }
          unchanged = Math.min(unchanged, unchangedFor(sample, span, most));
        }
        declarations.push({ prop, value: '', important: false, computed });
      }
      if (declarations.length) out.push(declarations);
    }
    this._unchangedFor = unchanged;
    return out;
  }

  /** How long from now the animations `_animatedDeclarations` last worked
   *  out change nothing anyone sees. */
  private _unchangedFor = 0;

  /** The style the candidates come to, in their order. */
  private _cascadeStyle(
    el: Element,
    parentStyle: ComputedStyle,
    inFlexContainer: boolean,
    candidates: Candidate[],
    own: boolean,
  ): ComputedStyle {
    // whose attributes an `attr()` in any declaration reads
    this._styling = el;
    let style = inherit(parentStyle, this.initial);
    // custom properties first, in cascade order, so every `var()` in the
    // declarations below finds the one that wins
    if (this._vars) style.custom = this._customFor(parentStyle, candidates);
    // then the element's own `zoom` (CSS Viewport 1, 5), which every length
    // after it is scaled by: the parent is seen at the element's zoom
    // (`zoomedBy`), so what it inherits, an `inherit` and an `em` in its
    // `font-size` are the parent's lengths zoomed, and the units below
    // resolve at the display scale times the zooms from the root down
    if (this._zoom) {
      const own = this._ownZoom(style, parentStyle, candidates);
      if (own !== 1) {
        const custom = style.custom;
        parentStyle = zoomedBy(parentStyle, own);
        style = inherit(parentStyle, this.initial);
        style.custom = custom;
        style.zoom = own;
      }
    }
    const zoom = style.effectiveZoom;

    // The unit context has to be built twice: once with the parent's font
    // size, so a `font-size: 1.2em` in the cascade resolves against the
    // right em, and again after the font size is settled so every *other*
    // em-relative length in the same rule resolves against this element's.
    const root = isRootElement(el);
    const rootStyle = root ? this.initial : (this._root ?? this.initial);
    // whose declaration is being applied: the UA sheet's families are the
    // host's own faces, and its lists end where they end
    let authored = true;
    // the root's lengths are at its own zoom, and a `rem` here is at this
    // element's
    const rootZoom = zoom / rootStyle.effectiveZoom;
    const ctxParent: UnitContext = {
      em: parentStyle.fontSize,
      rem: rootStyle.fontSize * rootZoom,
      remRead: this._remRead,
      initial: this.initial,
      uaSets: this._uaSets,
      fallbackFamily: () => (authored ? this.initial.fontFamily : null),
      codeFamily: () => (authored ? null : this._codeFamily),
      vw: this.viewportWidth * zoom,
      vh: this.viewportHeight * zoom,
      viewport: this._viewportRead,
      cq: (axis) => this._containerUnit(el, !own, axis),
      scale: this.scale * zoom,
      zoom,
      ex: () => this._exOf(parentStyle),
      ch: () => this._chOf(parentStyle),
      families: this._mapFamilies,
      lh: () => this._lineHeightOf(parentStyle),
      rlh: () => {
        this._rlhRead();
        return this._lineHeightOf(rootStyle) * rootZoom;
      },
      focusRing: this.look.focusRing,
      paletteScheme: this.look.colorScheme,
      systemColors: this._systemColors,
    };
    // The writing mode and the direction first, where a sheet declares a
    // writing mode: a logical property maps by the element's own
    // (CSS Writing Modes 4, 6.4), and is read before the declaration that
    // sets it wherever that comes later in cascade order — `margin-block:
    // 8px` in a rule ahead of the one that makes the element `vertical-rl`
    // was its top and bottom margins. Applied again in their places below,
    // which comes to what this does.
    if (this._writing) {
      for (const c of candidates) {
        for (const d of pick(c)) {
          if (MAPPING_PROPS.has(d.prop)) {
            this._apply(style, parentStyle, d, ctxParent);
          }
        }
      }
    }
    // The family, the weight, the slant and the width go with the size:
    // together they pick the face an `ex`, a `ch` or an `lh` in any
    // declaration is measured in, however the declarations are ordered. A
    // `width: 10ex` in a sheet under an inline `font-weight: 900` was
    // measured in the family's regular face. The colour scheme goes ahead of
    // the rest for the same reason: every `light-dark()` among them is read
    // by it. An `all` sets each of them too, in its place among them: a
    // `button { all: unset }` is the parent's size, not the UA sheet's.
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
          d.prop === 'font' ||
          d.prop === 'all'
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
          this.initial.fontSize * zoom,
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
    // an `lh` in `line-height` is the parent's line height, as an `em` in
    // `font-size` is its size (CSS Values 4, 6.1.1): read as the element's,
    // `line-height: 2lh` doubled itself in each pass that set it
    const ctxLine: UnitContext = { ...ctx, lh: ctxParent.lh };
    // the line height, which an `lh` in any other declaration reads, ahead
    // of them — a `font` sets one too — and read as it is then, for the
    // same reason as the face: set again with the rest, in its place among
    // them. A `font` sets the size as well, which the first pass settled.
    if (this._lh) {
      for (const c of candidates) {
        authored = !fromUserAgent(c.origin);
        for (const d of pick(c)) {
          if (
            d.prop === 'line-height' ||
            d.prop === 'font' ||
            d.prop === 'all'
          ) {
            this._apply(
              style,
              parentStyle,
              d,
              d.prop === 'line-height' ? ctxLine : ctx,
            );
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
        this._apply(
          style,
          parentStyle,
          d,
          d.prop === 'line-height' ? ctxLine : ctx,
        );
        if (scoped && ANIMATION_NAMES.has(d.prop)) animationTree = c.tree;
        if (scoped && TREE_SCOPED.has(d.prop)) noteTree(style, d, c.tree);
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
    // `auto` is the parent's used value where that is `none` or `all`
    // (CSS UI 4, 6.1), which is what the parent's style holds: so text in
    // a `user-select: none` toolbar is none however deep
    if (
      style.userSelect === 'auto' &&
      (parentStyle.userSelect === 'none' || parentStyle.userSelect === 'all')
    ) {
      style.userSelect = parentStyle.userSelect;
    }
    settleOverflow(style);
    settleOutline(style, this.look, this.scale * zoom);
    settleContainer(style);
    settleContentVisibility(style);
    // after the containment, which keeps a body's `overflow` its own
    if (own && el.name.length === 4) propagateOverflow(el, style, parentStyle);
    // An element in its document's top layer is drawn over all of it
    // (`overlay`), positioned against the initial containing block or the
    // viewport whatever is around it, and out of the flow whatever it was
    // given: `static`, `relative` and `sticky` are `absolute` (CSS Position
    // 4, 3.1), as Chrome computes them. A dialog `showModal()` opened is in
    // one here, and a popover shown.
    if (
      own &&
      ((el.name.length === 6 && isModal(el)) ||
        isPopoverOpen(el) ||
        isFullscreen(el))
    ) {
      style.overlay = 'auto';
      if (style.position !== 'absolute' && style.position !== 'fixed') {
        style.position = 'absolute';
      }
    }
    blockify(style, inFlexContainer);
    // a box in another writing mode than its parent's is no inline box: an
    // inline one is an inline-block, the root of a flow of its own (CSS
    // Writing Modes 4, 3.1)
    if (
      this._writing &&
      style.writingMode !== parentStyle.writingMode &&
      style.display === 'inline' &&
      !root
    ) {
      style.display = 'inline-block';
    }
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
    // a button is laid out as one, whatever `display` it was given, and
    // so is an input button the page draws (`styledControl`)
    if (
      own &&
      ((el.name.length === 6 && tagOf(el) === 'button') ||
        (style.styledControl && isInputButton(el)))
    ) {
      settleButton(style);
    }
    // each `@position-try` rule its fallbacks name, its declarations over
    // the style as though they were the element's own, for layout to try
    // in turn (`positionTryStyles`); an option naming no rule is none
    if (this._positionTries && style.positionTryFallbacks) {
      let rules = '';
      style.positionTryStyles = style.positionTryFallbacks.map((option) => {
        const found =
          option.name === null
            ? null
            : this._positionTry(
                option.name,
                style.positionTryTree as ShadowRoot | null,
              );
        if (!found) return null;
        rules += `${option.name}{${found.declarations
          .map((d) => `${d.prop}:${d.value}`)
          .join(';')}}`;
        const tried = copyStyle(style);
        for (const d of found.declarations) {
          this._apply(tried, parentStyle, d, ctx);
          if (TREE_SCOPED.has(d.prop)) noteTree(tried, d, found.tree);
        }
        tried.positionTryStyles = null;
        return tried;
      });
      style.positionTryRules = rules;
    }
    decorate(style);
    return style;
  }

  /** The element's own `zoom`, its declarations applied to `style` ahead
   *  of the rest. */
  private _ownZoom(
    style: ComputedStyle,
    parentStyle: ComputedStyle,
    candidates: Candidate[],
  ): number {
    let ctx: UnitContext | null = null;
    for (const c of candidates) {
      for (const d of pick(c)) {
        if (d.prop !== 'zoom') continue;
        ctx ??= {
          em: parentStyle.fontSize,
          rem: parentStyle.fontSize,
          vw: this.viewportWidth,
          vh: this.viewportHeight,
          scale: this.scale,
          initial: this.initial,
        };
        this._apply(style, parentStyle, d, ctx);
      }
    }
    return style.zoom;
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
    let env = hasInherit(d.value)
      ? this._inheritEnv(parentStyle, d.prop)
      : this._ifEnv;
    if (ATTR_IN.test(d.value)) env = { ...env, attribute: this._attributeOf };
    const value = substituteIn(d.value, style.custom, env);
    if (value !== null)
      applyDeclaration(style, parentStyle, d.prop, value, ctx);
  }

  /**
   * What an `inherit()` in a declaration of `property` finds (CSS Values 5,
   * 7.6): the parent's custom property of a name, and the parent's
   * computed value of a property as a declaration reads it back
   * (`computedText`) — so `border-radius: calc(inherit() - 4px)` is the
   * parent's radius less four pixels.
   */
  private _inheritEnv(
    parentStyle: ComputedStyle,
    property: string,
  ): IfEnvironment {
    return {
      ...this._ifEnv,
      property,
      inherited: (name) =>
        name.startsWith('--')
          ? (parentStyle.custom ?? this._registeredBase)?.read(name)
          : computedText(parentStyle, name, this.scale),
    };
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

  /** What a `rem`, a `vw` and its kin in an inline drawing's geometry are
   *  of, as the document has them now, in its user units (`DrawingUnits`):
   *  the root's font size and the viewport, in CSS pixels, unzoomed. */
  drawingUnits(): DrawingUnits {
    const root = this._root ?? this.initial;
    const css = (device: number): number =>
      Number.isFinite(device) && device > 0 ? device / this.scale : 0;
    return {
      rem: css(root.fontSize / root.effectiveZoom),
      vw: css(this.viewportWidth),
      vh: css(this.viewportHeight),
    };
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
          for (const name of className.split(CLASS_SPACE)) {
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
      // at the drawing's zoom, as its box's lengths are (`_computeStyle`):
      // what they come to is user units, CSS pixels the zoom then scales
      const zoom = style.effectiveZoom;
      const rootStyle = this._root ?? this.initial;
      ctx ??= {
        color: style.color,
        scheme: style.colorScheme,
        units: {
          em: style.fontSize,
          rem: (rootStyle.fontSize * zoom) / rootStyle.effectiveZoom,
          remRead: this._remRead,
          vw: this.viewportWidth * zoom,
          vh: this.viewportHeight * zoom,
          viewport: this._viewportRead,
          scale: this.scale * zoom,
          zoom,
          initial: this.initial,
          systemColors: this._systemColors,
          families: this._mapFamilies,
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
          const raw = d.vars
            ? substituteIn(d.value, custom, this._ifEnv)
            : d.value;
          if (d.prop === 'font') {
            // a shorthand, which sets its longhands, or is `unset` where
            // a `var()` in it made it nothing
            const set =
              (raw === null ? null : shapeFont(raw, ctx)) ??
              (d.vars ? shapeFont('unset', ctx) : null);
            if (set) Object.assign((own ??= {}), set);
            continue;
          }
          let value: string | null;
          if (d.vars) {
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
    // the ids its elements name by a `url(#…)`, some of which may be of
    // elements outside it
    let refs: string[] | null = null;
    const refer = (id: string): void => void (refs ??= []).push(id);
    const each = (el: Element, candidates: Candidate[] | null): void => {
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
      urlIds(el.name, el.attribs, refer);
      const own = candidates && resolve(candidates, el === root, customOf(el));
      if (!own) return;
      urlIds('', own, refer);
      (of ??= new Map()).set(el, own);
      key += named(own, place);
    };
    walk(root, false, each);
    // What it names outside itself — the `<marker>`s of a flow editor's
    // arrowheads in an `<svg>` of their own, a gradient kept in a hidden
    // one — is styled where it stands, as its own elements are, with what
    // the drawing's root has where nothing between sets its own; and drawn
    // from a copy (`copyTree`). An id it has an element of is its own.
    if (refs) {
      const list: string[] = refs;
      let outside: Set<Element> | null = null;
      for (let i = 0; i < list.length; i += 1) {
        const id = list[i];
        if (ids?.has(id) || root.attribs.id === id) continue;
        const target = byId(id);
        if (!target || outside?.has(target)) continue;
        (outside ??= new Set()).add(target);
        if (asks) {
          for (let at = target.parent; at && isTag(at); at = at.parent) {
            note(at as Element);
          }
        }
        walk(target, false, each);
      }
    }
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
    /** Whether a rule matches whatever its media say (`crossed`). */
    anyMedia = false,
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
          !anyMedia &&
          !mediaMatches(
            rule.media,
            width,
            this.look.colorScheme,
            height,
            this.scale,
            this.reducedMotion,
            this.scripting,
          )
        ) {
          continue;
        }
        // (its container queries are asked last, below: only of an element
        // the selector is the element's, since each is a read of a container
        // the layout after has to measure, `containersMoved`)
        // filed under the class or the id that is all it asks
        if (indexed.keyOnly && !inCopy) {
          if (indexed.host !== null && !indexed.host(tree.root!.host)) {
            continue;
          }
          if (
            rule.containers !== undefined &&
            !anyMedia &&
            !this._containersHold(rule.containers, el, index.self)
          ) {
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
        if (
          rule.containers !== undefined &&
          !anyMedia &&
          !this._containersHold(rule.containers, el, index.self)
        ) {
          continue;
        }
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
      for (const name of className.split(CLASS_SPACE)) {
        if (name) consider(index.byClass.get(name));
      }
    }
    consider(index.byTag.get(tagOf(el)));
    if (index.byAttr.size) {
      const attribs = el.attribs;
      for (const name in attribs) {
        const bucket = index.byAttr.get(name);
        if (bucket) consider(bucket);
        else {
          const lower = name.toLowerCase();
          if (lower !== name) consider(index.byAttr.get(lower));
        }
      }
    }
    if (index.rootRules.length && (inCopy || !elementParent(el))) {
      consider(index.rootRules);
    }
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
    // the page's colour schemes are its root's where no rule sets them —
    // the scheme it is drawn in, and not its computed `color-scheme`, which
    // stays `normal` (CSS Color Adjust 1, 3), as `getComputedStyle` reads it
    if (
      this.pageColorScheme &&
      el.name === 'html' &&
      tree.root === null &&
      !(el.parent && isTag(el.parent as Element))
    ) {
      const scheme = usedColorScheme(
        this.pageColorScheme,
        this.look.colorScheme,
        this.initial.colorScheme,
      );
      hints.push({
        prop: 'color-scheme',
        value: this.pageColorScheme,
        important: false,
        ...(scheme && { computed: { colorScheme: scheme } }),
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
      if (!this._lh && usesLh(declarations)) this._lh = true;
      if (!this._zoom && usesZoom(declarations)) this._zoom = true;
      if (!this.snaps && usesSnap(declarations)) this.snaps = true;
      if (!this._writing && usesWritingMode(declarations)) {
        this._writing = true;
      }
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
  // every one of them, and `appearance` back to `none`, but where it
  // takes the UA sheet's values back
  if (prop === 'all') return !/^\s*revert/i.test(d.value);
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

/** The declarations whose names are tree-scoped references, or define
 *  tree-scoped names, for anchor positioning (`noteTree`). */
const TREE_SCOPED = new Set([
  'anchor-name',
  'position-anchor',
  'anchor-scope',
  'position-try-fallbacks',
  'position-try',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'inset-block',
  'inset-inline',
  'inset-block-start',
  'inset-block-end',
  'inset-inline-start',
  'inset-inline-end',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'block-size',
  'inline-size',
  'min-block-size',
  'min-inline-size',
  'max-block-size',
  'max-inline-size',
]);

/** Note the tree of the rule a declaration came from beside what it set,
 *  where it names anchors or `@position-try` rules: what a name matches is
 *  a name of the same tree (CSS Anchor Positioning 1, 2.1). */
function noteTree(
  style: ComputedStyle,
  d: Declaration,
  tree: ShadowRoot | null,
): void {
  switch (d.prop) {
    case 'anchor-name':
      style.anchorNamesTree = tree;
      return;
    case 'position-anchor':
      style.positionAnchorTree = tree;
      return;
    case 'anchor-scope':
      style.anchorScopeTree = tree;
      return;
    case 'position-try-fallbacks':
    case 'position-try':
      style.positionTryTree = tree;
      return;
    default:
      if (readsAnchor(d.value)) style.anchorFunctionsTree = tree;
  }
}

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
  // a class name `classesBeyondAscii` read out of a selector, as code
  // points in hex
  '-rx-class': (el: Element, points: string | null): boolean => {
    const value = el.attribs.class;
    if (!value || !points) return false;
    const name = points
      .split(' ')
      .map((hex) => String.fromCodePoint(parseInt(hex, 16)))
      .join('');
    return value.split(CLASS_SPACE).includes(name);
  },
  // no child but a comment, as every engine has it: css-select 7 takes an
  // element of white space for an empty one, the Selectors 4 draft's
  // reading, which none ships, and Acid3's test 38 asks the difference
  empty: (el: Element) =>
    el.children.every(
      (k) =>
        k.type === 'comment' ||
        k.type === 'directive' ||
        (k.type === 'text' && (k as unknown as { data: string }).data === ''),
    ),
  // a custom element's to be that no definition has made one yet: a
  // page's scripts upgrade it (`isDefinedElement`)
  defined: (el: Element) => isDefinedElement(el),
  // `:nth-child()` and its three kin, without `of`, from where each
  // element is among its siblings, worked out once a parent and a tree
  // (`placeOf`, `nthKept`)
  '-rx-nth-child': (el: Element, arg: string | null) =>
    nthHolds(arg, el, 'index'),
  '-rx-nth-last-child': (el: Element, arg: string | null) =>
    nthHolds(arg, el, 'fromEnd'),
  '-rx-nth-of-type': (el: Element, arg: string | null) =>
    nthHolds(arg, el, 'ofType'),
  '-rx-nth-last-of-type': (el: Element, arg: string | null) =>
    nthHolds(arg, el, 'ofTypeFromEnd'),
  // a dialog in its document's top layer, which only a page's scripts put
  // one in (`isModal`)
  modal: (el: Element) => isModal(el),
  // a popover a page's scripts showed (`isPopoverOpen`)
  'popover-open': (el: Element) => isPopoverOpen(el),
  // the root while a view transition is active, and of one of the types
  // named (CSS View Transitions 1, 3.3; 2, 3.3), which are case-sensitive
  'active-view-transition': (el: Element) => inActiveTransition(el),
  'active-view-transition-type': (el: Element, types: string | null) =>
    !!types &&
    inActiveTransition(
      el,
      types
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  // a media element muted, by its attribute or a page's script (`isMuted`)
  muted: (el: Element) => isMuted(el),
  'volume-locked': (_el: Element) => false,
  // the document's fullscreen element (`isFullscreen`, Fullscreen 2, 4)
  fullscreen: (el: Element) => isFullscreen(el),
  // a media element playing or paused, as its `paused` is (`isPaused`),
  // and seeking, buffering or stalled as the page's script engine loads
  // it (`hasMediaFlag`)
  playing: (el: Element) => isPaused(el) === false,
  paused: (el: Element) => isPaused(el) === true,
  seeking: (el: Element) => hasMediaFlag(el, 'seeking'),
  buffering: (el: Element) => hasMediaFlag(el, 'buffering'),
  stalled: (el: Element) => hasMediaFlag(el, 'stalled'),
  // a `<details>` or a `<dialog>` open, and one shut (Selectors 4, 14.1):
  // css-select has neither, and dropped every rule that named one — and a
  // `<select>` whose drop-down box is down or up (HTML 16.6.1), as its
  // widget says (`isPickerOpen`)
  open: (el: Element) =>
    opens(el) ? el.attribs.open !== undefined : isPickerOpen(el),
  closed: (el: Element) =>
    opens(el)
      ? el.attribs.open === undefined
      : isDropDown(el) && !isPickerOpen(el),
  focus: (_el: Element) => false,
  'focus-visible': (_el: Element) => false,
  'focus-within': (_el: Element) => false,
  // css-select has none, and threw on one, so `:not(:target)` matched
  // nothing; the element the URL's fragment names is the cascade's to say
  // (`setTarget`)
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

/** Whether an element opens and shuts by its `open` attribute: a
 *  `<details>` or a `<dialog>`. */
function opens(el: Element): boolean {
  return el.name === 'details' || el.name === 'dialog';
}

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

/**
 * A selector with each class name that has white space in it beyond
 * ASCII's — an em space, a no-break space — asked by `:-rx-class()`
 * instead: css-select refuses any `~=` word with `\s` in it, which takes
 * the class selector with it, though HTML splits a `class` at ASCII white
 * space alone and such a name is one class (Acid3's test 33,
 * `.f\2003g\3000h`). The name goes over as its code points in hex, so
 * nothing in it is read again as a selector. Asked only of a selector
 * with an escape or a character past ASCII in it.
 */
function classesBeyondAscii(selector: string): string {
  if (!/[\\\u0080-\uffff]/.test(selector)) return selector;
  return selector.replace(CLASS_TOKEN, (token, raw: string) => {
    const name = raw.replace(
      /\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^])/g,
      (_m, hex: string | undefined, char: string | undefined) => {
        if (!hex) return char!;
        // what CSS Syntax 3 (4.3.7) reads no code point as is U+FFFD
        const n = parseInt(hex, 16);
        return n && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff)
          ? String.fromCodePoint(n)
          : '\ufffd';
      },
    );
    if (!/\s/.test(name) || /[\t\n\f\r ]/.test(name)) return token;
    const points = Array.from(name, (c) => c.codePointAt(0)!.toString(16));
    return `:-rx-class(${points.join(' ')})`;
  });
}
/** A class selector, its name with any escapes in it. */
const CLASS_TOKEN =
  /\.((?:[A-Za-z0-9_-]|[^\x00-\x7f]|\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[^\n\r\f0-9a-fA-F]))+)/g;

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
 * than one — by the document's root element, found once while the tree
 * holds still (`treeGeneration`): a stream's next chunk may bring the
 * `<meta>`, and an application change its `content` and `refresh()`.
 */
function pragmaLanguage(root: { children: unknown[] }): string {
  const at = treeGeneration();
  if (at !== pragmaLanguageAt) {
    PRAGMA_LANGUAGE = new WeakMap();
    pragmaLanguageAt = at;
  }
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

let PRAGMA_LANGUAGE = new WeakMap<object, string>();
let pragmaLanguageAt = -1;

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
/** An `attr()` in a value (`IfEnvironment.attribute`). */
const ATTR_IN = /(?:^|[^\w-])attr\(/i;

/**
 * An element's attribute of a name, for an `attr()`: HTML's names are its
 * lowercase ones. In a namespace, one the element holds as `prefix:name`
 * whose prefix an `xmlns:prefix` on it or around it binds to that
 * namespace (Namespaces in XML 1.0, 6.1), as an XHTML document read as
 * HTML keeps it; `xml` and `xlink` are bound where nothing declares them,
 * as HTML's parser binds them on its foreign elements.
 */
function attributeIn(
  el: Element | null,
  name: string,
  namespace?: string | null,
): string | undefined {
  const attribs = el?.attribs;
  if (!attribs) return undefined;
  if (!namespace) return attribs[name] ?? attribs[name.toLowerCase()];
  const local = name.toLowerCase();
  for (const key in attribs) {
    const colon = key.indexOf(':');
    if (colon <= 0 || key.slice(colon + 1).toLowerCase() !== local) continue;
    if (prefixBinding(el!, key.slice(0, colon)) === namespace) {
      return attribs[key];
    }
  }
  return undefined;
}

/** The namespace a prefix is bound to at an element, by the `xmlns:`
 *  attributes on it and its ancestors; undefined for none. */
function prefixBinding(el: Element, prefix: string): string | undefined {
  const declaration = `xmlns:${prefix}`;
  for (let at: Element | null = el; at;) {
    const bound =
      at.attribs[declaration] ?? at.attribs[declaration.toLowerCase()];
    if (bound !== undefined) return bound;
    const parent: Element['parent'] = at.parent;
    at = parent && isTag(parent) ? parent : null;
  }
  return BOUND_PREFIXES.get(prefix.toLowerCase());
}

const BOUND_PREFIXES = new Map([
  ['xml', 'http://www.w3.org/XML/1998/namespace'],
  ['xmlns', 'http://www.w3.org/2000/xmlns/'],
  ['xlink', 'http://www.w3.org/1999/xlink'],
]);

function usesSnap(declarations: readonly Declaration[]): boolean {
  for (const d of declarations) if (d.prop === 'scroll-snap-type') return true;
  return false;
}

function usesLh(declarations: readonly Declaration[]): boolean {
  for (const d of declarations) if (LH.test(d.value)) return true;
  return false;
}
const LH = /\d\.?r?lh\b/i;

function usesZoom(declarations: readonly Declaration[]): boolean {
  for (const d of declarations) if (d.prop === 'zoom') return true;
  return false;
}

/** The names a writing mode is declared by, its prefixed ones among them,
 *  and the direction's, which a logical property maps by as well. */
const WRITING_PROPS = new Set([
  'writing-mode',
  '-webkit-writing-mode',
  '-ms-writing-mode',
  '-epub-writing-mode',
]);
const MAPPING_PROPS = new Set([...WRITING_PROPS, 'direction']);

function usesWritingMode(declarations: readonly Declaration[]): boolean {
  for (const d of declarations) if (WRITING_PROPS.has(d.prop)) return true;
  return false;
}

/** Whether a candidate declares `content`. */
function setsContent(c: Candidate): boolean {
  for (const d of pick(c)) if (d.prop === 'content') return true;
  return false;
}

/** Whether a rule's declarations set a custom property, by the array. */
const CUSTOM_IN = new WeakMap<Declaration[], boolean>();

/** Whether a candidate sets a custom property with an `inherit()` in it,
 *  which reads the parent's style (`_customFor`). */
function customInherits(c: Candidate): boolean {
  if (c.only >= 0) {
    const d = c.declarations[c.only];
    return !!d.custom && hasInherit(d.value);
  }
  let has = INHERIT_IN.get(c.declarations);
  if (has === undefined) {
    has = c.declarations.some((d) => !!d.custom && hasInherit(d.value));
    INHERIT_IN.set(c.declarations, has);
  }
  return has;
}

const INHERIT_IN = new WeakMap<Declaration[], boolean>();

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
 * in it, in what a `<use>` in it draws, or in what it names by a `url(#…)`
 * — for `shapeStyles` to read where no rule reaches the drawing. Only the
 * attributes by those names are looked at: a path's `d` may be thousands
 * of characters long, and is no declaration.
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
    const follow = (id: string | null): void => {
      const target = id === null ? null : byId(id);
      if (target && !(targets ??= new Set()).has(target)) {
        targets.add(target);
        stack.push(target);
      }
    };
    if (isUse(el)) follow(useHref(el));
    // and in what it names by a `url(#…)`, which `shapeStyles` styles too
    urlIds(el.name, el.attribs, follow);
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
 *  an invalid declaration is. Kept by the element until an application
 *  says it changed the DOM (`mutationGeneration`): the parser sets an
 *  element's attributes once, and a `setAttribute` and a `refresh()` left
 *  a `fill="var(--brand)"` made `fill="#00f"` painting the brand colour. */
function attributeVars(el: Element): Declaration[] | null {
  const at = mutationGeneration();
  if (at !== attributeVarsAt) {
    ATTRIBUTE_VARS = new WeakMap();
    attributeVarsAt = at;
  }
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
let ATTRIBUTE_VARS = new WeakMap<Element, Declaration[] | null>();
let attributeVarsAt = -1;

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
  } else if (tag === 'foreignobject') {
    // what it holds is cut to it, as SVG's UA sheet has it (SVG 2,
    // appendix D) — a hint and not a rule of the UA sheet's, since a type
    // selector here matches no element with a capital in its name — unless
    // its `overflow` attribute, a presentation attribute, says otherwise
    push('overflow', attr(el, 'overflow') ?? 'hidden');
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
 *  none, as the `<html>` the cascade supplies where the markup has none —
 *  and not a shadow tree, whose top is under its host. Taken for the root,
 *  the top of every tree was what a `rem` styled after it measured from,
 *  and GitHub's, sized in `rem`s, measured each build from the last. */
function isRootElement(el: Element): boolean {
  const parent = el.parent;
  return !parent || (parent.type === 'root' && !(parent instanceof ShadowRoot));
}

/**
 * The `overflow` a document gives the box that scrolls it, on each axis, as
 * a viewport uses it: `visible` is `auto` there, and `clip` is `hidden`
 * (CSS Overflow 3, 3.3).
 */
export interface ViewportOverflow {
  x: 'auto' | 'hidden' | 'scroll';
  y: 'auto' | 'hidden' | 'scroll';
}

/** What a document whose root and body leave `overflow` alone gives its
 *  viewport. */
export const VIEWPORT_AUTO: ViewportOverflow = Object.freeze({
  x: 'auto',
  y: 'auto',
});

/** The `overflow` that went to the viewport other than `visible`, by the
 *  style of the root element or the `<body>` it went from
 *  (`propagateOverflow`). */
const VIEWPORT_OVERFLOW = new WeakMap<ComputedStyle, ViewportOverflow>();

/** What an element's style gave the viewport (`propagateOverflow`), or
 *  undefined where it gave nothing. */
export function overflowGivenToViewport(
  style: ComputedStyle | null | undefined,
): ViewportOverflow | undefined {
  return style ? VIEWPORT_OVERFLOW.get(style) : undefined;
}

function viewportValue(
  value: ComputedStyle['overflowX'],
): ViewportOverflow['x'] {
  return value === 'visible' ? 'auto' : value === 'clip' ? 'hidden' : value;
}

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
 * The element's is `visible` afterwards whatever it was, so what went is
 * kept beside its style (`VIEWPORT_OVERFLOW`): the body's goes only where
 * the root's did not, and the host that scrolls the document is told what
 * the viewport has (`BoxTree.viewportOverflow`) — Acid2's `html { overflow:
 * hidden }` is there to hide a browser's scrollbars.
 */
function propagateOverflow(
  el: Element,
  style: ComputedStyle,
  parentStyle: ComputedStyle,
): void {
  const tag = tagOf(el);
  if (tag === 'html') {
    if (!isRootElement(el)) return;
  } else if (tag === 'body') {
    // the root `<html>`'s, or one written with none, in the `<html>` the
    // cascade supplies
    const parent = el.parent;
    if (parent instanceof ShadowRoot) return;
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
  if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
    VIEWPORT_OVERFLOW.set(style, {
      x: viewportValue(style.overflowX),
      y: viewportValue(style.overflowY),
    });
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

/**
 * How long from now an animation's span between two frames changes nothing
 * anyone sees, where all it changes across the span is `visible` of the
 * least changes anyone sees (`visibleSpan`): as long as the easing at its
 * steepest takes to move it one of them, and no longer than the span, or
 * the animation, goes on — where another span's values, or none, begin. 0
 * where it changes as soon as it can, at a frame from now.
 */
function unchangedFor(
  sample: Sample,
  span: ReturnType<typeof spanAt>,
  visible: number,
): number {
  const { duration, forwards, left, progress } = sample;
  if (!(duration > 0)) return 0;
  // to the end of the span, the way the progress is going
  const across = forwards ? span.end - progress : progress - span.start;
  const out = Math.min(Math.max(0, across) * duration, left);
  if (visible === 0) return out;
  const steepest = steepestOf(span.easing);
  if (!(visible < Infinity) || !(steepest < Infinity)) return 0;
  const width = span.end - span.start;
  return Math.min(out, (width * duration) / (visible * steepest));
}
