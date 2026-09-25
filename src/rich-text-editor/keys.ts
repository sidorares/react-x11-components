// Stable identities for the blocks of a document, carried across edits.
//
// React needs a key per rendered block, and the three obvious ones are all
// wrong for an editor:
//
//   - **an index** shifts every block after an inserted paragraph, so Enter
//     at the top of a long document re-renders — and re-lays-out — every
//     paragraph below it;
//   - **a position** shifts on every keystroke, for the same reason;
//   - **a node's identity** changes whenever its content does, because
//     ProseMirror's nodes are immutable, so typing would remount the very
//     paragraph being typed in and throw its layout cache away.
//
// What survives an edit is what ProseMirror's own view keys its DOM on: a
// node's *place*, mapped through the transaction. A block whose start maps
// cleanly keeps its key; one whose opening token the transaction deleted —
// the second half of a join — loses it, and a block nobody had before (the
// second half of a split) gets a fresh one. When there is no mapping — a
// whole state handed in from outside, the controlled-state rung — the node
// objects that survived are matched by identity instead, which is the other
// thing ProseMirror's structural sharing guarantees.
//
// Pure: no React, no react-x11. The component asks it three questions — the
// key at a position, the position of a key, the node under a key — and
// `test/rich-text-editor-model.test.ts` asks it the rest.
import type { Node as PMNode } from 'prosemirror-model';
import { Mapping } from 'prosemirror-transform';
import type { Mappable } from 'prosemirror-transform';
import { spliceAll } from '../internal/splice.js';

/** A block: its key, where it starts, and the node it is. */
interface Entry {
  key: string;
  pos: number;
  node: PMNode;
}

export class BlockKeys {
  private counter = 0;
  /** Every block, in document order — which is the order of their starts,
   *  so a position is found by bisection. */
  private entries: Entry[] = [];
  private byKey = new Map<string, Entry>();
  /** The document the entries describe. */
  private doc: PMNode | null = null;

  constructor(doc: PMNode) {
    this.update(doc, null);
  }

  /** How many blocks the document has — every non-inline node but the
   *  document itself. */
  get size(): number {
    return this.entries.length;
  }

  /** The key of the block that starts at `pos`, if one does. */
  keyAt(pos: number): string | undefined {
    const entries = this.entries;
    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = entries[mid].pos;
      if (at === pos) return entries[mid].key;
      if (at < pos) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  /** Where the block under `key` starts now. */
  posOf(key: string): number | undefined {
    return this.byKey.get(key)?.pos;
  }

  /** The node the block under `key` is now. */
  nodeOf(key: string): PMNode | undefined {
    return this.byKey.get(key)?.node;
  }

  /**
   * Re-key for a new document. `mapping` is the transaction (or the run of
   * transactions) that produced it from the one the keys were last built
   * for; null when nothing knows how the two relate.
   *
   * The top-level blocks the two documents share at either end — the same
   * node objects, which is what ProseMirror's structural sharing leaves
   * everywhere an edit did not reach — keep their keys, and the blocks
   * after the edit only move. What lies between is keyed as the whole
   * document used to be, on every keystroke: a mapped start first, then a
   * surviving node, then a fresh key. So a keystroke costs the block it
   * lands in plus a pass that adds a number to each block after it, where
   * it cost a walk of the document and three maps built from scratch —
   * six milliseconds a key in a 2 MB document.
   */
  update(doc: PMNode, mapping: Mappable | null): void {
    const was = this.doc;
    this.doc = doc;
    // the top-level children the two documents share at either end
    let head = 0;
    let tail = 0;
    if (was) {
      const shared = Math.min(was.childCount, doc.childCount);
      while (head < shared && was.child(head) === doc.child(head)) head++;
      while (
        tail < shared - head &&
        was.child(was.childCount - 1 - tail) ===
          doc.child(doc.childCount - 1 - tail)
      ) {
        tail++;
      }
    }
    let from = 0; // where the changed children start, in both documents
    for (let i = 0; i < head; i++) from += doc.child(i).nodeSize;
    let wasTo = from;
    if (was) {
      for (let i = head; i < was.childCount - tail; i++) {
        wasTo += was.child(i).nodeSize;
      }
    }
    let to = from;
    for (let i = head; i < doc.childCount - tail; i++) {
      to += doc.child(i).nodeSize;
    }
    const entries = this.entries;
    const first = this._firstAtOrAfter(from);
    const end = this._firstAtOrAfter(wasTo);
    const old = entries.slice(first, end);

    // 1. Where each old block's start went — nowhere, when nothing in the
    // mapping moves a position: a mark added or taken off, an attribute set.
    // Bold over a whole document is one step a paragraph, and mapping every
    // block through every one of them was a third of the command.
    const carried = new Map<number, string>();
    if (mapping && !movesNothing(mapping)) {
      for (const { pos, key } of old) {
        const result = mapping.mapResult(pos, 1);
        // the token after the start is the block's own opening — gone means
        // the block is gone, merged into whatever preceded it
        if (result.deletedAfter) continue;
        if (!carried.has(result.pos)) carried.set(result.pos, key);
      }
    } else if (mapping) {
      for (const { pos, key } of old) {
        if (!carried.has(pos)) carried.set(pos, key);
      }
    }
    // 2. Which old node objects are still here, for when nothing mapped.
    const byNode = new Map<PMNode, string[]>();
    const carriedKeys = new Set(carried.values());
    for (const { key, node } of old) {
      if (carriedKeys.has(key)) continue;
      const list = byNode.get(node);
      if (list) list.push(key);
      else byNode.set(node, [key]);
    }
    for (const { key } of old) this.byKey.delete(key);

    // 3. The changed children, keyed.
    const fresh: Entry[] = [];
    const used = new Set<string>();
    const visit = (node: PMNode, pos: number): boolean => {
      if (node.isInline) return false;
      let key = carried.get(pos);
      if (key !== undefined && used.has(key)) key = undefined;
      if (key === undefined) {
        const list = byNode.get(node);
        while (list && list.length > 0) {
          const candidate = list.shift()!;
          if (!used.has(candidate)) {
            key = candidate;
            break;
          }
        }
      }
      if (key === undefined) key = `b${(this.counter++).toString(36)}`;
      used.add(key);
      const entry = { key, pos, node };
      fresh.push(entry);
      this.byKey.set(key, entry);
      // a textblock's children are inline: nothing below it has a key
      return !node.isTextblock;
    };
    let at = from;
    for (let i = head; i < doc.childCount - tail; i++) {
      const child = doc.child(i);
      if (visit(child, at)) {
        const base = at + 1;
        child.descendants((node, pos) => visit(node, base + pos));
      }
      at += child.nodeSize;
    }

    // 4. The blocks after them moved, and are otherwise as they were.
    const shift = to - wasTo;
    if (shift !== 0) {
      for (let i = end; i < entries.length; i++) entries[i].pos += shift;
    }
    spliceAll(entries, first, end - first, fresh);
  }

  /** The index of the first block starting at or after `pos`. */
  private _firstAtOrAfter(pos: number): number {
    const entries = this.entries;
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].pos < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/** Whether a mapping is made only of steps that move no position. */
function movesNothing(mapping: Mappable): boolean {
  if (!(mapping instanceof Mapping)) return false;
  for (const map of mapping.maps) {
    let moved = false;
    map.forEach(() => {
      moved = true;
    });
    if (moved) return false;
  }
  return true;
}
