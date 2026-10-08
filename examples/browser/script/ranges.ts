// DOM ranges over the host's tree (DOM Standard, 5 "Ranges"): live ones,
// which every insertion, removal and change of a text's data moves as the
// standard says, since the host makes every change to the tree and tells
// this one of each. The algorithms are the standard's, step for step;
// what changes the tree goes back through the host, so a range's own
// edits are recorded, observed and drawn as a page's are. A node
// iterator's place is the same kind of thing (`NodeIterators`), moved by
// a removal under it.
import { Comment, Document, Text } from 'domhandler';
import type { AnyNode, ChildNode, ParentNode } from 'domhandler';

/** What a range does to the tree, through the host that keeps it. */
export interface RangeHost {
  /** An error a page sees as a `DOMException` of `kind`. */
  error(kind: string, message: string): Error;
  /** `node` put into `parent` before `before`, as `insertBefore` puts it,
   *  checks and all. */
  insert(parent: ParentNode, node: ChildNode, before: ChildNode | null): void;
  /** Whether `insert` would take `node` there, thrown where not. */
  check(parent: ParentNode, node: ChildNode, before: ChildNode | null): void;
  remove(node: ChildNode): void;
  replaceData(
    node: CharacterData,
    offset: number,
    count: number,
    data: string,
  ): void;
  split(node: Text, offset: number): Text;
  /** A copy of a node, of what it holds too where `deep`. */
  clone(node: AnyNode, deep: boolean): ChildNode;
  /** A new fragment of the document `node` is in. */
  fragment(node: AnyNode): Document;
  isFragment(node: AnyNode): boolean;
  isDocument(node: AnyNode): boolean;
}

/** A text, a comment or a processing instruction: a node with data. */
export type CharacterData = Text | Comment;

/** A range: its two boundary points. */
export class LiveRange {
  constructor(
    public sc: AnyNode,
    public so: number,
    public ec: AnyNode,
    public eo: number,
  ) {}
  get collapsed(): boolean {
    return this.sc === this.ec && this.so === this.eo;
  }
}

export const isDoctype = (node: AnyNode): boolean => node.type === 'directive';
export const isCharacterData = (node: AnyNode): node is CharacterData =>
  node instanceof Text || node instanceof Comment;

/** A node's length (DOM 4.2): a doctype's none, a text's its data's, and
 *  anything else's its children. */
export function nodeLength(node: AnyNode): number {
  if (isDoctype(node)) return 0;
  if (isCharacterData(node)) return node.data.length;
  return (node as ParentNode).children?.length ?? 0;
}

export function indexOf(node: AnyNode): number {
  return node.parent ? node.parent.children.indexOf(node as ChildNode) : 0;
}

export function rootOf(node: AnyNode): AnyNode {
  let at = node;
  while (at.parent) at = at.parent;
  return at;
}

/** Whether `a` is `b` or one of its ancestors. */
export function inclusiveAncestor(a: AnyNode, b: AnyNode): boolean {
  for (let at: AnyNode | null = b; at; at = at.parent)
    if (at === a) return true;
  return false;
}

/** Where `a` is from `b` in tree order, in one tree: -1 before, 1 after. */
function treeOrder(a: AnyNode, b: AnyNode): number {
  if (a === b) return 0;
  const path = (n: AnyNode): AnyNode[] => {
    const out: AnyNode[] = [];
    for (let at: AnyNode | null = n; at; at = at.parent) out.unshift(at);
    return out;
  };
  const pa = path(a);
  const pb = path(b);
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i += 1;
  if (i === pa.length) return -1; // a holds b, and comes first
  if (i === pb.length) return 1;
  return indexOf(pa[i]) < indexOf(pb[i]) ? -1 : 1;
}

/** Where one boundary point is from another (DOM 5.2, "position"). */
export function compareBoundaryPoints(
  an: AnyNode,
  ao: number,
  bn: AnyNode,
  bo: number,
): number {
  if (an === bn) return ao === bo ? 0 : ao < bo ? -1 : 1;
  if (treeOrder(an, bn) > 0) return -compareBoundaryPoints(bn, bo, an, ao);
  if (inclusiveAncestor(an, bn)) {
    let child: AnyNode = bn;
    while (child.parent !== an) child = child.parent!;
    if (indexOf(child) < ao) return 1;
  }
  return -1;
}

/** The ranges of a document's tree, live. */
export class Ranges {
  private _live = new Map<number, LiveRange>();
  private _seq = 0;

  constructor(private readonly _host: RangeHost) {}

  /** A new range, collapsed at the start of `doc`. */
  make(doc: AnyNode): number {
    this._seq += 1;
    this._live.set(this._seq, new LiveRange(doc, 0, doc, 0));
    return this._seq;
  }
  add(range: LiveRange): number {
    this._seq += 1;
    this._live.set(this._seq, range);
    return this._seq;
  }
  drop(id: number): void {
    this._live.delete(id);
  }
  get(id: number): LiveRange {
    const range = this._live.get(id);
    if (!range)
      throw this._host.error('InvalidStateError', 'The range is gone.');
    return range;
  }

  // --- what the tree's changes do to the ranges in it

  /** `count` nodes put into `parent` at `index` (DOM 4.2.3, "insert"). */
  inserted(parent: AnyNode, index: number, count: number): void {
    for (const r of this._live.values()) {
      if (r.sc === parent && r.so > index) r.so += count;
      if (r.ec === parent && r.eo > index) r.eo += count;
    }
  }

  /** `node` about to leave its parent (DOM 4.2.3, "remove", step 4–7). */
  removing(node: AnyNode): void {
    const parent = node.parent;
    if (!parent) return;
    const index = indexOf(node);
    for (const r of this._live.values()) {
      if (inclusiveAncestor(node, r.sc)) {
        r.sc = parent;
        r.so = index;
      }
      if (inclusiveAncestor(node, r.ec)) {
        r.ec = parent;
        r.eo = index;
      }
      if (r.sc === parent && r.so > index) r.so -= 1;
      if (r.ec === parent && r.eo > index) r.eo -= 1;
    }
  }

  /** A node's data replaced from `offset`, `count` code units of it with
   *  `length` (DOM 4.10, "replace data"). */
  replacedData(
    node: AnyNode,
    offset: number,
    count: number,
    length: number,
  ): void {
    for (const r of this._live.values()) {
      if (r.sc === node && r.so > offset && r.so <= offset + count)
        r.so = offset;
      if (r.ec === node && r.eo > offset && r.eo <= offset + count)
        r.eo = offset;
      if (r.sc === node && r.so > offset + count) r.so += length - count;
      if (r.ec === node && r.eo > offset + count) r.eo += length - count;
    }
  }

  /** A text split at `offset`, its rest in `added` after it (DOM 4.11,
   *  "split a Text node", step 7). */
  split(node: AnyNode, offset: number, added: AnyNode): void {
    const parent = node.parent;
    for (const r of this._live.values()) {
      if (r.sc === node && r.so > offset) {
        r.sc = added;
        r.so -= offset;
      }
      if (r.ec === node && r.eo > offset) {
        r.ec = added;
        r.eo -= offset;
      }
    }
    if (!parent) return;
    const index = indexOf(node);
    for (const r of this._live.values()) {
      if (r.sc === parent && r.so === index + 1) r.so += 1;
      if (r.ec === parent && r.eo === index + 1) r.eo += 1;
    }
  }

  // --- what a page asks of a range

  /** `setStart` and `setEnd` (DOM 5.5, "set the start or end"). */
  set(r: LiveRange, node: AnyNode, offset: number, start: boolean): void {
    if (isDoctype(node)) {
      throw this._host.error(
        'InvalidNodeTypeError',
        'A doctype holds no boundary point.',
      );
    }
    if (offset > nodeLength(node)) {
      throw this._host.error(
        'IndexSizeError',
        `There is no child at offset ${offset}.`,
      );
    }
    const other = rootOf(r.sc) !== rootOf(node);
    if (start) {
      if (other || compareBoundaryPoints(node, offset, r.ec, r.eo) > 0) {
        r.ec = node;
        r.eo = offset;
      }
      r.sc = node;
      r.so = offset;
    } else {
      if (other || compareBoundaryPoints(node, offset, r.sc, r.so) < 0) {
        r.sc = node;
        r.so = offset;
      }
      r.ec = node;
      r.eo = offset;
    }
  }

  /** `setStartBefore` and its kin: a boundary point beside a node. */
  setBeside(r: LiveRange, node: AnyNode, start: boolean, after: boolean): void {
    const parent = node.parent;
    if (!parent) {
      throw this._host.error('InvalidNodeTypeError', 'The node has no parent.');
    }
    this.set(r, parent, indexOf(node) + (after ? 1 : 0), start);
  }

  selectNode(r: LiveRange, node: AnyNode): void {
    const parent = node.parent;
    if (!parent) {
      throw this._host.error('InvalidNodeTypeError', 'The node has no parent.');
    }
    const index = indexOf(node);
    r.sc = parent;
    r.so = index;
    r.ec = parent;
    r.eo = index + 1;
  }

  selectNodeContents(r: LiveRange, node: AnyNode): void {
    if (isDoctype(node)) {
      throw this._host.error(
        'InvalidNodeTypeError',
        'A doctype has no contents.',
      );
    }
    r.sc = node;
    r.so = 0;
    r.ec = node;
    r.eo = nodeLength(node);
  }

  collapse(r: LiveRange, toStart: boolean): void {
    if (toStart) {
      r.ec = r.sc;
      r.eo = r.so;
    } else {
      r.sc = r.ec;
      r.so = r.eo;
    }
  }

  /** `compareBoundaryPoints` (DOM 5.5). */
  compare(r: LiveRange, how: number, source: LiveRange): number {
    if (how < 0 || how > 3) {
      throw this._host.error(
        'NotSupportedError',
        'That comparison is not one.',
      );
    }
    if (rootOf(r.sc) !== rootOf(source.sc)) {
      throw this._host.error(
        'WrongDocumentError',
        'The two ranges are in two trees.',
      );
    }
    const [tn, to] = how === 0 || how === 3 ? [r.sc, r.so] : [r.ec, r.eo];
    const [sn, so] =
      how === 0 || how === 1 ? [source.sc, source.so] : [source.ec, source.eo];
    return compareBoundaryPoints(tn, to, sn, so);
  }

  commonAncestor(r: LiveRange): AnyNode {
    let container: AnyNode = r.sc;
    while (!inclusiveAncestor(container, r.ec)) container = container.parent!;
    return container;
  }

  /** Whether a node is wholly in a range (DOM 5.2, "contained"). */
  contained(r: LiveRange, node: AnyNode): boolean {
    return (
      rootOf(node) === rootOf(r.sc) &&
      compareBoundaryPoints(node, 0, r.sc, r.so) > 0 &&
      compareBoundaryPoints(node, nodeLength(node), r.ec, r.eo) < 0
    );
  }

  /** Whether a node is partly in a range: around one end and not the
   *  other. */
  partlyContained(r: LiveRange, node: AnyNode): boolean {
    return inclusiveAncestor(node, r.sc) !== inclusiveAncestor(node, r.ec);
  }

  /** Where a range's contents leave it once they are taken: the start, or
   *  past the child of the common ancestor that holds the start. */
  private _afterRemoval(r: LiveRange): [AnyNode, number] {
    if (inclusiveAncestor(r.sc, r.ec)) return [r.sc, r.so];
    let reference: AnyNode = r.sc;
    while (!inclusiveAncestor(reference.parent!, r.ec))
      reference = reference.parent!;
    return [reference.parent!, indexOf(reference) + 1];
  }

  /** The nodes a range wholly holds, in tree order, none inside another. */
  private _containedTops(r: LiveRange): ChildNode[] {
    const out: ChildNode[] = [];
    const ancestor = this.commonAncestor(r);
    const walk = (node: AnyNode): void => {
      for (const child of (node as ParentNode).children ?? []) {
        if (this.contained(r, child)) out.push(child);
        else if (this.partlyContained(r, child)) walk(child);
      }
    };
    walk(ancestor);
    return out;
  }

  /** `deleteContents` (DOM 5.5). */
  deleteContents(r: LiveRange): void {
    if (r.collapsed) return;
    const { sc, so, ec, eo } = r;
    if (sc === ec && isCharacterData(sc)) {
      this._host.replaceData(sc, so, eo - so, '');
      return;
    }
    const removing = this._containedTops(r);
    const [newNode, newOffset] = this._afterRemoval(r);
    if (isCharacterData(sc)) {
      this._host.replaceData(sc, so, nodeLength(sc) - so, '');
    }
    for (const node of removing) if (node.parent) this._host.remove(node);
    if (isCharacterData(ec)) this._host.replaceData(ec, 0, eo, '');
    r.sc = newNode;
    r.so = newOffset;
    r.ec = newNode;
    r.eo = newOffset;
  }

  /** `extractContents` and `cloneContents` (DOM 5.5, "extract" and "clone
   *  the contents"): the same walk, the first taking what it copies. */
  contents(r: LiveRange, take: boolean): Document {
    const fragment = this._host.fragment(r.sc);
    if (r.collapsed) return fragment;
    const { sc, so, ec, eo } = r;
    const copy = (node: CharacterData, from: number, count: number): void => {
      const clone = this._host.clone(node, false) as CharacterData;
      clone.data = node.data.substr(from, count);
      this._host.insert(fragment, clone, null);
      if (take) this._host.replaceData(node, from, count, '');
    };
    if (sc === ec && isCharacterData(sc)) {
      copy(sc, so, eo - so);
      return fragment;
    }
    let ancestor: AnyNode = sc;
    while (!inclusiveAncestor(ancestor, ec)) ancestor = ancestor.parent!;
    const children = (ancestor as ParentNode).children ?? [];
    const firstPartly = inclusiveAncestor(sc, ec)
      ? null
      : (children.find((c) => this.partlyContained(r, c)) ?? null);
    const lastPartly = inclusiveAncestor(ec, sc)
      ? null
      : ([...children].reverse().find((c) => this.partlyContained(r, c)) ??
        null);
    const wholly = children.filter((c) => this.contained(r, c));
    if (wholly.some(isDoctype)) {
      throw this._host.error(
        'HierarchyRequestError',
        'A range cannot take a doctype.',
      );
    }
    const [newNode, newOffset] = take ? this._afterRemoval(r) : [sc, so];
    if (firstPartly && isCharacterData(firstPartly)) {
      copy(sc as CharacterData, so, nodeLength(sc) - so);
    } else if (firstPartly) {
      const clone = this._host.clone(firstPartly, false);
      this._host.insert(fragment, clone, null);
      const inner = new LiveRange(sc, so, firstPartly, nodeLength(firstPartly));
      const sub = this.contents(inner, take);
      this._host.insert(clone as ParentNode, sub as unknown as ChildNode, null);
    }
    for (const child of wholly) {
      if (take) this._host.insert(fragment, child, null);
      else this._host.insert(fragment, this._host.clone(child, true), null);
    }
    if (lastPartly && isCharacterData(lastPartly)) {
      copy(ec as CharacterData, 0, eo);
    } else if (lastPartly) {
      const clone = this._host.clone(lastPartly, false);
      this._host.insert(fragment, clone, null);
      const inner = new LiveRange(lastPartly, 0, ec, eo);
      const sub = this.contents(inner, take);
      this._host.insert(clone as ParentNode, sub as unknown as ChildNode, null);
    }
    if (take) {
      r.sc = newNode;
      r.so = newOffset;
      r.ec = newNode;
      r.eo = newOffset;
    }
    return fragment;
  }

  /** `insertNode` (DOM 5.5, "insert"). */
  insertNode(r: LiveRange, node: ChildNode): void {
    const start = r.sc;
    if (
      start instanceof Comment ||
      isDoctype(start) ||
      (start instanceof Text && !start.parent) ||
      start === node
    ) {
      throw this._host.error(
        'HierarchyRequestError',
        'The node cannot go there.',
      );
    }
    const at: ChildNode | null =
      start instanceof Text
        ? start
        : (((start as ParentNode).children ?? [])[r.so] ?? null);
    this._host.check((at === null ? start : at.parent) as ParentNode, node, at);
    let reference: ChildNode | null =
      start instanceof Text
        ? start
        : (((start as ParentNode).children ?? [])[r.so] ?? null);
    const parent = (
      reference === null ? start : reference.parent
    ) as ParentNode;
    if (start instanceof Text) reference = this._host.split(start, r.so);
    if (node === reference) reference = node.next;
    if (node.parent) this._host.remove(node);
    let newOffset =
      reference === null ? nodeLength(parent) : indexOf(reference);
    newOffset += this._host.isFragment(node)
      ? (node as unknown as ParentNode).children.length
      : 1;
    const collapsed = r.collapsed;
    this._host.insert(parent, node, reference);
    if (collapsed) {
      r.ec = parent;
      r.eo = newOffset;
    }
  }

  /** `surroundContents` (DOM 5.5). */
  surround(r: LiveRange, parent: ChildNode): void {
    // what is partly in a range is what holds one end and not the other:
    // the ancestors of each end below the one they share
    const ancestor = this.commonAncestor(r);
    const partly = (end: AnyNode): boolean => {
      for (let at: AnyNode = end; at !== ancestor; at = at.parent!) {
        if (!(at instanceof Text)) return true;
      }
      return false;
    };
    if (partly(r.sc) || partly(r.ec)) {
      throw this._host.error(
        'InvalidStateError',
        'The range holds part of a node that is not text.',
      );
    }
    if (
      this._host.isDocument(parent) ||
      isDoctype(parent) ||
      this._host.isFragment(parent)
    ) {
      throw this._host.error(
        'InvalidNodeTypeError',
        'That node cannot hold a range.',
      );
    }
    const fragment = this.contents(r, true);
    const held = parent as unknown as ParentNode;
    for (const child of held.children.slice()) this._host.remove(child);
    this.insertNode(r, parent);
    this._host.insert(held, fragment as unknown as ChildNode, null);
    this.selectNode(r, parent);
  }

  /** `toString` (DOM 5.5, "stringification behavior"). */
  text(r: LiveRange): string {
    const { sc, so, ec, eo } = r;
    if (sc === ec && sc instanceof Text) return sc.data.slice(so, eo);
    let out = sc instanceof Text ? sc.data.slice(so) : '';
    // every text a contained node holds, and what those partly in it hold
    const all = (node: AnyNode): void => {
      if (node instanceof Text) out += node.data;
      else for (const child of (node as ParentNode).children ?? []) all(child);
    };
    const walk = (node: AnyNode): void => {
      for (const child of (node as ParentNode).children ?? []) {
        if (this.contained(r, child)) all(child);
        else if (this.partlyContained(r, child)) walk(child);
      }
    };
    walk(this.commonAncestor(r));
    if (ec instanceof Text) out += ec.data.slice(0, eo);
    return out;
  }

  /** `isPointInRange` and `comparePoint` (DOM 5.5). */
  point(
    r: LiveRange,
    node: AnyNode,
    offset: number,
    compare: boolean,
  ): number | boolean {
    if (rootOf(node) !== rootOf(r.sc)) {
      if (compare) {
        throw this._host.error(
          'WrongDocumentError',
          'The point is in another tree.',
        );
      }
      return false;
    }
    if (isDoctype(node)) {
      throw this._host.error(
        'InvalidNodeTypeError',
        'A doctype holds no point.',
      );
    }
    if (offset > nodeLength(node)) {
      throw this._host.error(
        'IndexSizeError',
        `There is no child at offset ${offset}.`,
      );
    }
    if (compareBoundaryPoints(node, offset, r.sc, r.so) < 0)
      return compare ? -1 : false;
    if (compareBoundaryPoints(node, offset, r.ec, r.eo) > 0)
      return compare ? 1 : false;
    return compare ? 0 : true;
  }

  /** `intersectsNode` (DOM 5.5). */
  intersects(r: LiveRange, node: AnyNode): boolean {
    if (rootOf(node) !== rootOf(r.sc)) return false;
    const parent = node.parent;
    if (!parent) return true;
    const index = indexOf(node);
    return (
      compareBoundaryPoints(parent, index, r.ec, r.eo) < 0 &&
      compareBoundaryPoints(parent, index + 1, r.sc, r.so) > 0
    );
  }
}

/** Where a node iterator is: a node, and whether it is before it. */
interface IteratorPoint {
  node: AnyNode;
  before: boolean;
}
interface LiveIterator {
  root: AnyNode;
  reference: IteratorPoint;
  /** The node a traversal is at while its filter runs, which a removal
   *  the filter makes moves as it moves the reference. */
  candidate: IteratorPoint | null;
}

/** `node`'s next in tree order, without leaving `root` (Blink's
 *  `NodeTraversal::Next`). */
function nextWithin(node: AnyNode, root: AnyNode): AnyNode | null {
  const kids = (node as ParentNode).children;
  if (kids?.length) return kids[0];
  for (let at: AnyNode | null = node; at && at !== root; at = at.parent) {
    if (at.next) return at.next;
  }
  return null;
}
function previousWithin(node: AnyNode, root: AnyNode): AnyNode | null {
  if (node === root) return null;
  let at = node.prev;
  if (!at) return node.parent;
  for (;;) {
    const kids: ChildNode[] | undefined = (at as ParentNode).children;
    if (!kids?.length) return at;
    at = kids[kids.length - 1];
  }
}
const isDescendant = (node: AnyNode, of: AnyNode): boolean =>
  node !== of && inclusiveAncestor(of, node);

/**
 * The page's `NodeIterator`s (DOM 6.1), by id: each one's reference, and
 * the place a traversal has got to while the page's filter runs. A
 * removal moves both out from under the node going, as Blink moves them
 * (`NodeIterator::UpdateForNodeRemoval`) — Acid3's test 2 removes the node
 * its filter is asked about, and asks where the iterator went.
 */
export class NodeIterators {
  private _live = new Map<number, LiveIterator>();
  private _seq = 0;

  make(root: AnyNode): number {
    this._seq += 1;
    this._live.set(this._seq, {
      root,
      reference: { node: root, before: true },
      candidate: null,
    });
    return this._seq;
  }
  drop(id: number): void {
    this._live.delete(id);
  }
  get(id: number): LiveIterator | undefined {
    return this._live.get(id);
  }

  /** A traversal's next step from where it is, its candidate made first
   *  from the reference: the node to ask the filter about, or null. */
  step(it: LiveIterator, next: boolean): AnyNode | null {
    const at = (it.candidate ??= { ...it.reference });
    if (next) {
      if (at.before) at.before = false;
      else {
        const node = nextWithin(at.node, it.root);
        if (!node) return null;
        at.node = node;
      }
    } else if (!at.before) at.before = true;
    else {
      const node = previousWithin(at.node, it.root);
      if (!node) return null;
      at.node = node;
    }
    return at.node;
  }

  /** `node` about to leave its parent. */
  removing(node: AnyNode): void {
    for (const it of this._live.values()) {
      if (!isDescendant(node, it.root)) continue;
      this._moveOff(it.reference, node, it.root);
      if (it.candidate) this._moveOff(it.candidate, node, it.root);
    }
  }

  private _moveOff(at: IteratorPoint, removed: AnyNode, root: AnyNode): void {
    const ancestor = isDescendant(at.node, removed);
    if (at.node !== removed && !ancestor) return;
    const out = (node: AnyNode | null, next: boolean): AnyNode | null => {
      while (node && isDescendant(node, removed)) {
        node = next ? nextWithin(node, root) : previousWithin(node, root);
      }
      return node;
    };
    if (at.before) {
      const next = out(nextWithin(removed, root), true);
      if (next) {
        at.node = next;
        return;
      }
      const previous = ancestor
        ? out(previousWithin(removed, root), false)
        : previousWithin(removed, root);
      if (previous) {
        at.node = previous;
        at.before = false;
      }
      return;
    }
    const previous = ancestor
      ? out(previousWithin(removed, root), false)
      : previousWithin(removed, root);
    if (previous) {
      at.node = previous;
      return;
    }
    const next = ancestor
      ? out(nextWithin(removed, root), true)
      : nextWithin(removed, root);
    if (next) at.node = next;
  }
}
