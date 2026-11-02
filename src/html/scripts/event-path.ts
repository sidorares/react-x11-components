// An event's path through the tree (DOM 2.9, "dispatch"), worked out on the
// host's side of the bridge, where a shadow tree's slots and hosts are, as one
// answer rather than an op a level.
//
// What it answers is a string of numbers, as everything that crosses does:
// whether a target has to be cleared once the event is over, then four for
// each step of the path. The node's id, the shadow-adjusted target's (0 where
// the step has none, and the last one that had goes on being `target`), the
// retargeted `relatedTarget`'s, and its flags.
import { assignedSlot, isElement, shadowRootOf, ShadowRoot } from '../dom.js';
import type { AnyNode, ChildNode, Element } from '../dom.js';

/** A step's flags. */
export const ROOT_OF_CLOSED_TREE = 1;
export const SLOT_IN_CLOSED_TREE = 2;
export const IN_SHADOW_TREE = 4;

function rootOf(node: AnyNode): AnyNode {
  let at = node;
  while (at.parent) at = at.parent;
  return at;
}

/** Whether `ancestor` is a shadow-including inclusive ancestor of `node`
 *  (DOM 4.2.2). */
export function shadowIncludingHolds(
  ancestor: AnyNode,
  node: AnyNode,
): boolean {
  for (let at: AnyNode | null = node; at;) {
    if (at === ancestor) return true;
    at = at.parent ?? (at instanceof ShadowRoot ? at.host : null);
  }
  return false;
}

/** DOM 4.2.2.2, "retarget `a` against `b`". */
function retarget(a: AnyNode | null, b: AnyNode): AnyNode | null {
  let at = a;
  while (at) {
    const root = rootOf(at);
    if (!(root instanceof ShadowRoot)) return at;
    if (shadowIncludingHolds(root, b)) return at;
    at = root.host;
  }
  return null;
}

/**
 * The path of an event at `target`, as the string above: empty where a
 * target is its own `relatedTarget` by retargeting alone, which is an event
 * no listener hears (a pointer moved inside one shadow tree, seen from
 * outside it).
 */
export function eventPath(
  target: AnyNode,
  composed: boolean,
  related: AnyNode | null,
  idOf: (node: AnyNode) => number,
): string {
  let adjusted: AnyNode = target;
  let relatedNow = related && retarget(related, target);
  if (target === relatedNow && target !== related) return '';
  const first = rootOf(target);
  /** The root of the tree the walk is in, which only a slot or a host
   *  changes: asked at each step it would be the square of the depth. */
  let tree = first;
  const out: number[] = [0];
  const push = (
    node: AnyNode,
    self: AnyNode | null,
    rel: AnyNode | null,
    closedSlot: boolean,
  ): void => {
    const shadow = tree instanceof ShadowRoot;
    out.push(
      idOf(node),
      self ? idOf(self) : 0,
      rel ? idOf(rel) : 0,
      (node instanceof ShadowRoot && node.mode === 'closed'
        ? ROOT_OF_CLOSED_TREE
        : 0) |
        (closedSlot ? SLOT_IN_CLOSED_TREE : 0) |
        (shadow ? IN_SHADOW_TREE : 0),
    );
  };
  /** DOM's "get the parent": the slot a node is assigned to, a shadow
   *  root's host where the event crosses it, and else its parent. */
  const parentOf = (node: AnyNode): AnyNode | null => {
    if (node instanceof ShadowRoot) {
      return !composed && node === first ? null : node.host;
    }
    const slot = assigned(node);
    return slot ?? node.parent;
  };
  const assigned = (node: AnyNode): Element | null =>
    node.parent && isElement(node.parent) && shadowRootOf(node.parent)
      ? assignedSlot(node as ChildNode)
      : null;
  push(target, target, relatedNow, false);
  let slottable: AnyNode | null = assigned(target) ? target : null;
  let parent = parentOf(target);
  let crossed = target instanceof ShadowRoot || assigned(target) !== null;
  let lastAdjusted: AnyNode = target;
  let lastRelated = relatedNow;
  while (parent) {
    let closedSlot = false;
    if (slottable) {
      slottable = null;
      const around = rootOf(parent);
      closedSlot = around instanceof ShadowRoot && around.mode === 'closed';
    }
    if (assigned(parent)) slottable = parent;
    relatedNow = related && retarget(related, parent);
    if (closedSlot || crossed) tree = rootOf(parent);
    const root = rootOf(adjusted);
    if (!(root instanceof ShadowRoot) || shadowIncludingHolds(root, parent)) {
      push(parent, null, relatedNow, closedSlot);
    } else if (parent === relatedNow) {
      break;
    } else {
      adjusted = parent;
      lastAdjusted = parent;
      lastRelated = relatedNow;
      push(parent, parent, relatedNow, closedSlot);
    }
    // a slot, or a host, is in another tree than what it led here from
    crossed = parent instanceof ShadowRoot || assigned(parent) !== null;
    parent = parentOf(parent);
  }
  // the event's targets are not left to a page once it is over where they
  // are in a shadow tree (DOM 2.9, "clearTargets")
  out[0] =
    rootOf(lastAdjusted) instanceof ShadowRoot ||
    (lastRelated && rootOf(lastRelated) instanceof ShadowRoot)
      ? 1
      : 0;
  return out.join(',');
}
