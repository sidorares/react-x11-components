// The React bridge: one small component per live QML object.
//
// Each QmlNode subscribes to exactly one instance (useSyncExternalStore on
// the instance's version counter), so a scalar property change re-renders
// one element's worth of tree and React reconciliation is reserved for
// structural change (Repeater rebuilds). The QML side never reaches around
// React: every pixel on screen is a `<box>`/`<text>`/`<image>` committed
// through the ordinary renderer.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { ComponentType, ReactElement, ReactNode, Ref } from 'react';
import type { DrawnNode } from 'react-x11';
import type { Style } from 'react-x11/style';
import { warn } from './globals.js';

import { parseQml } from './parse.js';
import {
  Context,
  QmlInstance,
  instantiateDocument,
  migrateUserState,
  registerQmlModule,
  type InstantiateResult,
  type QmlFacade,
  type QmlPropertyDef,
} from './objects.js';
import { flushBindings } from './slots.js';
import { afterLayout, cancelAfterLayout } from '../internal/timers.js';
import type { QmlResolver } from './resolver.js';

export function useQmlVersion(inst: QmlInstance): number {
  return useSyncExternalStore(
    (cb) => inst.subscribe(cb),
    () => inst.version,
  );
}

export function QmlNode({ inst }: { inst: QmlInstance }): ReactNode {
  useQmlVersion(inst);
  if (inst.destroyed) return null;
  const View = inst.typeInfo.view;
  if (!View) return null;
  return <View inst={inst} />;
}

export function renderQmlChildren(inst: QmlInstance): ReactNode[] {
  return inst.visualChildren().map((c) => <QmlNode key={c.uid} inst={c} />);
}

export interface QmlViewHandle {
  /** The root object, as expressions see it: live properties, callable
   * signals and methods. */
  root: QmlFacade;
  /** An object by its document id, or null. */
  id(name: string): QmlFacade | null;
  instance: QmlInstance;
}

export interface QmlViewProps {
  /** QML source text. When it changes the tree is rebuilt; interactive
   * state (assigned property values) is carried across by id — the
   * hot-reload story. Pass `hotReload={false}` for a cold swap. */
  source: string;
  /** Shown in errors; pass the file path when the source came from one. */
  file?: string;
  /** Context properties — names visible to every binding in the document.
   * Updated values ride ordinary commits. */
  context?: Record<string, unknown>;
  /** Subscriptions to the root object's signals, by signal name. */
  onSignal?: Record<string, (...args: unknown[]) => void>;
  hotReload?: boolean;
  /** Enables `.qml`-file resolution — the implicit same-directory import
   * and quoted-path imports. `createFileResolver(dir)` is the standard
   * filesystem one; any object with the `QmlResolver` shape works
   * (resolver.ts). Fixed for the lifetime of the view. */
  resolver?: QmlResolver;
  /** Rebuild (with the same state migration a `source` change gets) when
   * this value changes — how a watcher of *sibling* `.qml` files triggers
   * a hot reload the unchanged root source cannot. */
  reloadToken?: unknown;
  style?: Style | Style[];
}

interface Mounted {
  source: string;
  token: unknown;
  res: InstantiateResult;
}

/**
 * A QML document as a react-x11 element tree.
 *
 * The wrapper box takes the root object's declared size when it has one;
 * otherwise it is sized by the app (the `style` prop) and feeds its
 * laid-out size back into the root's implicit size, so `width`/`height`
 * bindings inside the document see the real number — the "root fills the
 * window" behavior.
 */
export const QmlView = forwardRef(function QmlView(
  {
    source,
    file,
    context,
    onSignal,
    hotReload = true,
    resolver,
    reloadToken,
    style,
  }: QmlViewProps,
  ref: Ref<QmlViewHandle>,
): ReactElement {
  const state = useRef<Mounted | null>(null);
  if (
    !state.current ||
    state.current.source !== source ||
    !Object.is(state.current.token, reloadToken)
  ) {
    const doc = parseQml(source, { fileName: file ?? '<inline>' });
    const next = instantiateDocument(doc, {
      extras: { ...context },
      resolver: resolver ?? null,
    });
    if (state.current) {
      if (hotReload) migrateUserState(state.current.res.context, next.context);
      state.current.res.root.destroy();
    }
    state.current = { source, token: reloadToken, res: next };
  }
  const { res } = state.current;
  const root = res.root;

  useQmlVersion(root); // the wrapper box tracks the root's size

  // Context-property updates ride ordinary commits.
  useEffect(() => {
    if (!context) return;
    for (const [k, v] of Object.entries(context)) {
      const slot = res.context.extras.get(k);
      if (slot && !Object.is(slot.peek(), v)) slot.assign(v);
    }
    flushBindings();
  });

  useEffect(() => {
    if (!onSignal) return;
    const offs = Object.entries(onSignal).map(([name, fn]) =>
      root.onSignal(name, fn),
    );
    return () => offs.forEach((off) => off());
  }, [root, onSignal]);

  useEffect(() => {
    const mounted = state.current;
    return () => {
      mounted?.res.root.destroy();
      if (state.current === mounted) state.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      root: root.facade,
      id: (name: string) => res.context.ids.get(name)?.facade ?? null,
      instance: root,
    }),
    [root, res],
  );

  // Root-size feedback. `afterLayout` (not a bare effect): react-x11 lays
  // out on the frame flush, so an effect body reads the geometry of the
  // previous pass — src/internal/timers.ts documents the shape.
  const wrapRef = useRef<DrawnNode>(null);
  const rootW = root.slots.get('width');
  const rootH = root.slots.get('height');
  const sized = !!rootW && !rootW.isDefault;
  useEffect(() => {
    if (sized) return;
    const tick = afterLayout(() => {
      const abs = wrapRef.current?.abs;
      if (!abs || root.destroyed) return;
      if (abs.width) root.slots.get('implicitWidth')?.assign(abs.width);
      if (abs.height) root.slots.get('implicitHeight')?.assign(abs.height);
      flushBindings();
    });
    return () => cancelAfterLayout(tick);
  });

  return (
    <box
      ref={wrapRef}
      style={[
        { position: 'relative' },
        sized && rootH
          ? { width: num(rootW.peek()), height: num(rootH.peek()) }
          : false,
        style,
      ]}
    >
      <QmlNode inst={root} />
    </box>
  );
});

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

export interface RegisterReactComponentOptions {
  properties?: Record<string, QmlPropertyDef>;
  signals?: Record<string, string[]>;
  /** Reshape when prop names don't line up one-to-one. */
  toProps?: (
    props: Record<string, unknown>,
    inst: QmlInstance,
  ) => Record<string, unknown>;
}

/**
 * Register a React component as a QML type — the "extend in code" seam.
 *
 *   registerReactComponent('Shop.Widgets', 'PriceTag', PriceTag, {
 *     properties: { amount: { default: 0 } },
 *     signals: { activated: [] },
 *   });
 *
 * Declared properties arrive as props (live: a binding update re-renders
 * the component); declared signals arrive as `on<Signal>` callback props
 * that emit back into QML.
 */
export function registerReactComponent(
  moduleName: string,
  typeName: string,
  Component: ComponentType<Record<string, unknown>>,
  {
    properties = {},
    signals = {},
    toProps,
  }: RegisterReactComponentOptions = {},
): void {
  const View = ({ inst }: { inst: QmlInstance }): ReactElement => {
    const props: Record<string, unknown> = {};
    for (const name of Object.keys(properties)) {
      props[name] = inst.slots.get(name)?.peek();
    }
    for (const name of Object.keys(signals)) {
      props[`on${name[0].toUpperCase()}${name.slice(1)}`] = (
        ...args: unknown[]
      ) => inst.emit(name, ...args);
    }
    const shaped = toProps ? toProps(props, inst) : props;
    const kids = renderQmlChildren(inst);
    return (
      <box style={geometryStyle(inst)}>
        <Component {...shaped}>
          {kids.length ? kids : (shaped.children as ReactNode)}
        </Component>
      </box>
    );
  };
  registerQmlModule(moduleName, {
    types: {
      [typeName]: { extends: 'Item', properties, signals, view: View },
    },
  });
}

// Shared with qtquick.tsx (kept here so registerReactComponent has no
// dependency on the QtQuick module being loaded).
export function geometryStyle(
  inst: QmlInstance,
  { contentSized = false } = {},
): Style {
  const s = inst.slots;
  const style: Style = {
    position: 'absolute',
    left: num(s.get('x')?.peek()),
    top: num(s.get('y')?.peek()),
  };
  const w = s.get('width');
  const h = s.get('height');
  if (w && !(contentSized && w.isDefault)) style.width = num(w.peek());
  if (h && !(contentSized && h.isDefault)) style.height = num(h.peek());
  if (s.get('visible')?.peek() === false) style.display = 'none';
  if (s.get('clip')?.peek() === true) style.overflow = 'hidden';
  const z = s.get('z')?.peek();
  if (typeof z === 'number' && z) style.zIndex = z;
  warnUnrenderable(inst);
  return style;
}

const INERT: Record<string, number> = { opacity: 1, rotation: 0, scale: 1 };
const warned = new Set<string>();
function warnUnrenderable(inst: QmlInstance): void {
  for (const name of Object.keys(INERT)) {
    const v = inst.slots.get(name)?.peek();
    if (v !== undefined && v !== INERT[name] && !warned.has(name)) {
      warned.add(name);
      warn(
        `QML: '${name}' is declared but react-x11 cannot render it yet ` +
          `(needs offscreen composition); the value is ignored.`,
      );
    }
  }
}

// Re-exported here so the family's public surface sits in one place.
export { Context, QmlInstance };
