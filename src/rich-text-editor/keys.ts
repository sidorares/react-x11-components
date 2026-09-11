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
import type { Mappable } from 'prosemirror-transform';

export class BlockKeys {
  private counter = 0;
  /** Block start position → key, for the current document. */
  private byPos = new Map<number, string>();
  private posByKey = new Map<string, number>();
  private nodeByKey = new Map<string, PMNode>();

  constructor(doc: PMNode) {
    this.update(doc, null);
  }

  /** How many blocks the document has — every non-inline node but the
   *  document itself. */
  get size(): number {
    return this.byPos.size;
  }

  /** The key of the block that starts at `pos`, if one does. */
  keyAt(pos: number): string | undefined {
    return this.byPos.get(pos);
  }

  /** Where the block under `key` starts now. */
  posOf(key: string): number | undefined {
    return this.posByKey.get(key);
  }

  /** The node the block under `key` is now. */
  nodeOf(key: string): PMNode | undefined {
    return this.nodeByKey.get(key);
  }

  /**
   * Re-key for a new document. `mapping` is the transaction (or the run of
   * transactions) that produced it from the one the keys were last built
   * for; null when nothing knows how the two relate.
   *
   * O(blocks), which is the right order: 10,000 paragraphs is a millisecond,
   * and the render that follows touches only the blocks whose node changed.
   */
  update(doc: PMNode, mapping: Mappable | null): void {
    // 1. Where each old block's start went.
    const carried = new Map<number, string>();
    if (mapping) {
      for (const [pos, key] of this.byPos) {
        const result = mapping.mapResult(pos, 1);
        // the token after the start is the block's own opening — gone means
        // the block is gone, merged into whatever preceded it
        if (result.deletedAfter) continue;
        if (!carried.has(result.pos)) carried.set(result.pos, key);
      }
    }
    // 2. Which old node objects are still here, for when nothing mapped.
    const byNode = new Map<PMNode, string[]>();
    const carriedKeys = new Set(carried.values());
    for (const [key, node] of this.nodeByKey) {
      if (carriedKeys.has(key)) continue;
      const list = byNode.get(node);
      if (list) list.push(key);
      else byNode.set(node, [key]);
    }

    const byPos = new Map<number, string>();
    const posByKey = new Map<string, number>();
    const nodeByKey = new Map<string, PMNode>();
    doc.descendants((node, pos) => {
      if (node.isInline) return false;
      let key = carried.get(pos);
      if (key !== undefined && posByKey.has(key)) key = undefined;
      if (key === undefined) {
        const list = byNode.get(node);
        while (list && list.length > 0) {
          const candidate = list.shift()!;
          if (!posByKey.has(candidate)) {
            key = candidate;
            break;
          }
        }
      }
      if (key === undefined) key = `b${(this.counter++).toString(36)}`;
      byPos.set(pos, key);
      posByKey.set(key, pos);
      nodeByKey.set(key, node);
      // a textblock's children are inline: nothing below it has a key
      return !node.isTextblock;
    });
    this.byPos = byPos;
    this.posByKey = posByKey;
    this.nodeByKey = nodeByKey;
  }
}
