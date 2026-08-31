// QtQuick.Layouts — RowLayout and ColumnLayout, lowered onto yoga.
//
// This is react-x11's home turf: the container renders a flex `<box>` and
// every child renders as a flex item styled from its `Layout.*` attached
// properties (react.tsx, `layoutChildStyle`) — `fillWidth` is `flexGrow`,
// `preferredWidth` is the basis, `alignment` is `alignSelf`, margins are
// margins. Yoga decides the geometry; the renderer never re-implements it.
//
// What QML still needs from that arrangement is *readable geometry*:
// `item.x` and `item.width` are ordinary properties other bindings consume.
// After each layout pass the container reads its children's laid-out rects
// and `reflect()`s them into the x/y/width/height slots — a write that
// disturbs no binding and no flag, so the implicit-width default keeps
// meaning "content-sized" and an author `width:` keeps reading as a size
// hint. Expressions see yoga's answer; yoga sees the hints.
//
// GridLayout is not here yet — yoga has no grid, and a half-true one would
// be worse than the clear unknown-type error; RowLayout, ColumnLayout and
// the full Layout.* set cover the linked reference page.

import { useEffect } from 'react';
import type { ReactElement } from 'react';

import { QmlInstance, type QmlTypeDef } from './objects.js';
import { renderQmlChildren, geometryStyle, preferredSpan } from './react.js';
import {
  applyMotion,
  captureNode,
  hostNode,
  initItem,
  num,
} from './view-utils.js';
import {
  afterLayout,
  cancelAfterLayout,
  type LayoutTick,
} from '../internal/timers.js';

function isRow(inst: QmlInstance): boolean {
  return inst.typeInfo.name === 'RowLayout';
}

/** Reflect yoga's answers into the managed children's geometry slots. */
function feedbackLayout(inst: QmlInstance): void {
  if (inst.destroyed) return;
  const containerAbs = hostNode(inst)?.abs;
  if (!containerAbs) return;
  for (const child of inst.visualChildren()) {
    const abs = hostNode(child)?.abs;
    if (!abs) continue; // a custom view without captureNode: skip quietly
    child.slots.get('x')?.reflect(abs.x - containerAbs.x);
    child.slots.get('y')?.reflect(abs.y - containerAbs.y);
    child.slots.get('width')?.reflect(abs.width);
    child.slots.get('height')?.reflect(abs.height);
  }
}

function LayoutView({ inst }: { inst: QmlInstance }): ReactElement {
  const horizontal = isRow(inst);
  const style = geometryStyle(inst);
  style.display = 'flex';
  style.flexDirection = horizontal ? 'row' : 'column';
  style.gap = num(inst.slot('spacing').peek());
  applyMotion(inst, style);

  // Feed geometry back after the layout flush — and again whenever any
  // child re-renders (its size hints may have moved yoga). A reflect that
  // changes nothing notifies nobody, so this settles.
  useEffect(() => {
    let tick: LayoutTick = null;
    const schedule = (): void => {
      cancelAfterLayout(tick);
      tick = afterLayout(() => feedbackLayout(inst));
    };
    schedule();
    const offs = inst.visualChildren().map((c) => c.subscribe(schedule));
    return () => {
      cancelAfterLayout(tick);
      offs.forEach((off) => off());
    };
  });

  return (
    <box ref={captureNode(inst)} style={style}>
      {renderQmlChildren(inst)}
    </box>
  );
}

/** The container's own size hint: sum of children's preferred spans on the
 * main axis (plus spacing), max on the cross — tracked bindings, so a
 * child's hint change resizes a content-sized layout. */
function layoutImplicit(inst: QmlInstance): void {
  const horizontal = isRow(inst);
  const tracked = (slot: { get(): unknown }): unknown => slot.get();
  const mainExtent = (): number => {
    let sum = 0;
    let count = 0;
    const spacing = num(inst.slot('spacing').get());
    for (const child of inst.visualChildren()) {
      if (child.slot('visible').get() === false) continue;
      sum += preferredSpan(child, horizontal, tracked) ?? 0;
      count++;
    }
    return sum + spacing * Math.max(0, count - 1);
  };
  const crossExtent = (): number => {
    let max = 0;
    for (const child of inst.visualChildren()) {
      if (child.slot('visible').get() === false) continue;
      max = Math.max(max, preferredSpan(child, !horizontal, tracked) ?? 0);
    }
    return max;
  };
  inst
    .slot(horizontal ? 'implicitWidth' : 'implicitHeight')
    .setBinding(mainExtent);
  inst
    .slot(horizontal ? 'implicitHeight' : 'implicitWidth')
    .setBinding(crossExtent);
}

function layoutInit(inst: QmlInstance): void {
  initItem(inst);
  layoutImplicit(inst);
}

const layoutContainer: QmlTypeDef = {
  extends: 'Item',
  managesChildLayout: true,
  view: LayoutView,
  // Qt's RowLayout/ColumnLayout default spacing.
  properties: { spacing: { default: 5 } },
  init: layoutInit,
  onStructure: layoutImplicit, // a Repeater spliced new children in
};

export const layoutTypes: Record<string, QmlTypeDef> = {
  RowLayout: { ...layoutContainer },
  ColumnLayout: { ...layoutContainer },
};
