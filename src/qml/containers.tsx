// Containers: the positioners (bindings the Row installs on its children),
// Repeater, Loader, and the scroll pair — Flickable over core's
// `overflow: 'scroll'` box, ListView over Flickable with windowed
// delegates: only the visible range (plus a buffer) is instantiated, and
// scrolling moves the window.

import { useEffect } from 'react';
import type { ReactElement } from 'react';
import type { ScrollableNode } from 'react-x11';

import {
  QmlInstance,
  instantiateTemplate,
  type QmlTypeDef,
} from './objects.js';
import { renderQmlChildren, geometryStyle } from './react.js';
import {
  applyMotion,
  captureNode,
  hostNode,
  initItem,
  num,
} from './view-utils.js';
import { delegateExtras, resolveModel } from './models.js';
import { warn } from './globals.js';

// --- positioners -----------------------------------------------------------

function positionerLayout(inst: QmlInstance): void {
  const horizontal = inst.typeInfo.name === 'Row';
  const main = horizontal ? 'x' : 'y';
  const mainSize = horizontal ? 'width' : 'height';
  const crossSize = horizontal ? 'height' : 'width';
  for (const kid of inst.visualChildren()) {
    kid.slot(main).setBinding(() => {
      let pos = 0;
      const spacing = num(inst.slot('spacing').get());
      for (const prev of inst.visualChildren()) {
        if (prev === kid) break;
        if (prev.slot('visible').get() === false) continue;
        pos += num(prev.slot(mainSize).get()) + spacing;
      }
      return pos;
    });
  }
  const extent = (): number => {
    let sum = 0;
    let count = 0;
    const spacing = num(inst.slot('spacing').get());
    for (const kid of inst.visualChildren()) {
      if (kid.slot('visible').get() === false) continue;
      sum += num(kid.slot(mainSize).get());
      count++;
    }
    return sum + spacing * Math.max(0, count - 1);
  };
  const crossExtent = (): number => {
    let max = 0;
    for (const kid of inst.visualChildren()) {
      if (kid.slot('visible').get() === false) continue;
      max = Math.max(max, num(kid.slot(crossSize).get()));
    }
    return max;
  };
  inst.slot(horizontal ? 'implicitWidth' : 'implicitHeight').setBinding(extent);
  inst
    .slot(horizontal ? 'implicitHeight' : 'implicitWidth')
    .setBinding(crossExtent);
}

function positionerInit(inst: QmlInstance): void {
  initItem(inst);
  positionerLayout(inst);
}

// --- Repeater --------------------------------------------------------------

interface RepeaterState {
  items?: QmlInstance[];
  revOff?: (() => void) | null;
}

function repeaterRebuild(inst: QmlInstance): void {
  const parent = inst.parentInst;
  const tpl = inst.templates.get('delegate');
  if (!parent || !tpl) return;
  const state = inst.state as RepeaterState;
  for (const item of state.items ?? []) {
    const at = parent.children.indexOf(item);
    if (at >= 0) parent.children.splice(at, 1);
    item.destroy();
  }
  const { rows } = resolveModel(inst.slot('model').peek());
  const items = rows.map(
    (_, index) =>
      instantiateTemplate(
        tpl,
        inst.doc,
        inst.context,
        parent,
        delegateExtras(rows, index),
      ).inst,
  );
  const at = parent.children.indexOf(inst);
  parent.children.splice(at + 1, 0, ...items);
  state.items = items;
  inst.slot('count').assign(items.length);
  parent._structChanged();
}

function repeaterModelChanged(inst: QmlInstance): void {
  const state = inst.state as RepeaterState;
  state.revOff?.();
  state.revOff = null;
  const { revSlot } = resolveModel(inst.slot('model').peek());
  if (revSlot) state.revOff = revSlot.watch(() => repeaterRebuild(inst));
  repeaterRebuild(inst);
}

// --- Flickable -------------------------------------------------------------

function FlickableView({ inst }: { inst: QmlInstance }): ReactElement {
  const style = geometryStyle(inst);
  style.overflow = 'scroll';
  applyMotion(inst, style);
  const cw = num(inst.slot('contentWidth').peek());
  const ch = num(inst.slot('contentHeight').peek());
  const cx = num(inst.slot('contentX').peek());
  const cy = num(inst.slot('contentY').peek());
  useEffect(() => {
    const node = hostNode(inst) as ScrollableNode | null;
    if (!node || typeof node.scrollTo !== 'function') return;
    if (node.scrollX !== cx || node.scrollY !== cy)
      node.scrollTo({ x: cx, y: cy });
  }, [inst, cx, cy]);
  return (
    <box
      ref={captureNode(inst)}
      style={style}
      onScroll={(ev: { scrollX: number; scrollY: number }) => {
        inst.slot('contentX').assign(ev.scrollX);
        inst.slot('contentY').assign(ev.scrollY);
      }}
    >
      <box
        style={{
          position: 'relative',
          width: cw || undefined,
          height: ch || undefined,
        }}
      >
        {renderQmlChildren(inst)}
      </box>
    </box>
  );
}

// --- ListView --------------------------------------------------------------

interface ListState {
  items?: Map<number, QmlInstance>;
  revOff?: (() => void) | null;
  measuredWatch?: boolean;
}

function listViewInit(lv: QmlInstance): void {
  initItem(lv);
  const state = lv.state as ListState;
  const items = new Map<number, QmlInstance>();
  state.items = items;

  const destroyItem = (i: number): void => {
    const it = items.get(i);
    if (!it) return;
    const at = lv.children.indexOf(it);
    if (at >= 0) lv.children.splice(at, 1);
    it.destroy();
    items.delete(i);
  };

  const update = (): void => {
    if (lv.destroyed) return;
    const tpl = lv.templates.get('delegate');
    if (!tpl) return;
    const { rows } = resolveModel(lv.slot('model').peek());
    const spacing = num(lv.slot('spacing').peek());
    const count = rows.length;
    for (const i of [...items.keys()]) if (i >= count) destroyItem(i);
    if (count === 0) {
      lv.slot('contentHeight').assign(0);
      lv._structChanged();
      return;
    }
    const ensure = (i: number): QmlInstance => {
      let it = items.get(i);
      if (!it) {
        it = instantiateTemplate(
          tpl,
          lv.doc,
          lv.context,
          lv,
          delegateExtras(rows, i),
        ).inst;
        items.set(i, it);
        lv.children.push(it);
      }
      return it;
    };
    const first = ensure(0);
    if (!state.measuredWatch) {
      state.measuredWatch = true;
      first.slot('height').watch(update); // implicit sizes settle late
    }
    const h = num(first.slot('height').peek());
    if (!h) {
      // Nothing measurable yet: stack whatever heights the delegates say.
      let y = 0;
      for (let i = 0; i < count; i++) {
        const it = ensure(i);
        it.slot('y').assign(y);
        y += num(it.slot('height').peek()) + spacing;
      }
      lv.slot('contentHeight').assign(Math.max(0, y - spacing));
    } else {
      // Uniform rows (the first row's height): window the range.
      const stride = h + spacing;
      const viewH = num(lv.slot('height').peek());
      const cy = num(lv.slot('contentY').peek());
      const buffer = Math.max(2, Math.ceil((viewH || stride) / stride));
      const start = Math.max(0, Math.floor(cy / stride) - buffer);
      const end = Math.min(
        count - 1,
        Math.ceil((cy + (viewH || stride)) / stride) + buffer,
      );
      for (const i of [...items.keys()]) {
        if (i !== 0 && (i < start || i > end)) destroyItem(i);
      }
      for (let i = start; i <= end; i++)
        ensure(i)
          .slot('y')
          .assign(i * stride);
      first.slot('y').assign(0);
      lv.slot('contentHeight').assign(count * stride - spacing);
    }
    lv._structChanged();
  };

  const fullRebuild = (): void => {
    for (const i of [...items.keys()]) destroyItem(i);
    state.measuredWatch = false;
    update();
  };
  const modelChanged = (): void => {
    state.revOff?.();
    state.revOff = null;
    const { revSlot } = resolveModel(lv.slot('model').peek());
    if (revSlot) state.revOff = revSlot.watch(fullRebuild);
    fullRebuild();
  };

  lv.slot('model').watch(modelChanged);
  lv.slot('contentY').watch(update);
  lv.slot('height').watch(update);
  lv.slot('spacing').watch(fullRebuild);
  modelChanged();
}

// --- Loader ----------------------------------------------------------------

function loaderInit(ld: QmlInstance): void {
  initItem(ld);
  let child: QmlInstance | null = null;
  const sync = (): void => {
    if (child) {
      const at = ld.children.indexOf(child);
      if (at >= 0) ld.children.splice(at, 1);
      child.destroy();
      child = null;
      ld.slot('item').assign(null);
      ld.slot('implicitWidth').assign(0);
      ld.slot('implicitHeight').assign(0);
    }
    const tpl = ld.templates.get('sourceComponent');
    const active = ld.slot('active').peek() !== false;
    if (!ld.destroyed && active && tpl) {
      const loaded = instantiateTemplate(tpl, ld.doc, ld.context, ld).inst;
      child = loaded;
      ld.children.push(loaded);
      ld.slot('item').assign(loaded.facade);
      ld.slot('implicitWidth').setBinding(() =>
        num(loaded.slot('width').get()),
      );
      ld.slot('implicitHeight').setBinding(() =>
        num(loaded.slot('height').get()),
      );
      ld.emit('loaded');
    }
    ld._structChanged();
  };
  if (ld.slots.has('source') && ld.slot('source').peek()) {
    warn(
      'QML: Loader.source (a url) needs the document resolver planned with ' +
        'directory imports; use sourceComponent for now.',
    );
  }
  ld.slot('active').watch(sync);
  sync();
}

// --- the type definitions --------------------------------------------------

export const containerTypes: Record<string, QmlTypeDef> = {
  Row: {
    extends: 'Item',
    properties: { spacing: { default: 0 } },
    init: positionerInit,
    onStructure: positionerLayout,
  },
  Column: {
    extends: 'Item',
    properties: { spacing: { default: 0 } },
    init: positionerInit,
    onStructure: positionerLayout,
  },

  Repeater: {
    nonVisual: true,
    capture: 'delegate',
    properties: { model: { default: 0 }, count: { default: 0 } },
    init(inst) {
      inst.slot('model').watch(() => repeaterModelChanged(inst));
      repeaterModelChanged(inst);
    },
    dispose(inst) {
      const state = inst.state as RepeaterState;
      state.revOff?.();
      for (const item of state.items ?? []) item.destroy();
    },
  },

  Flickable: {
    extends: 'Item',
    view: FlickableView,
    properties: {
      contentWidth: { default: 0 },
      contentHeight: { default: 0 },
      contentX: { default: 0 },
      contentY: { default: 0 },
    },
    init: initItem,
  },

  ListView: {
    extends: 'Flickable',
    capture: 'delegate',
    properties: {
      model: { default: 0 },
      spacing: { default: 0 },
    },
    init: listViewInit,
    dispose(lv) {
      const state = lv.state as ListState;
      state.revOff?.();
    },
  },

  Loader: {
    extends: 'Item',
    capture: 'sourceComponent',
    properties: {
      active: { default: true },
      item: { default: null },
      source: { default: '' },
    },
    signals: { loaded: [] },
    init: loaderInit,
  },
};
