// The QML object model: documents → live instances wired into the slot
// graph.
//
// Scope rules follow Qt's documented order (ids outrank the scope object's
// own properties; the component root is consulted before context
// properties; unresolved names fall through `with` to the JS globals, which
// is how Math, JSON and console work without us lifting a finger).
//
// Expressions compile once per document via `new Function` and are shared
// by every instance (a Repeater with 1000 delegates compiles each binding
// once).
//
// This module is deliberately renderer-free: no react-x11, and React only
// as a type (the `view` field a registered type may carry). It is the half
// that a future compiler shares with the interpreter.

import type { ComponentType } from 'react';
import type {
  AliasTargetIR,
  MemberIR,
  ObjectIR,
  QmlDocument,
  ValueIR,
} from './ir.js';
import { Slot, flushBindings, type BindingFn } from './slots.js';
import { warn } from './globals.js';

/**
 * How expressions see an object: live property access, callable signals
 * and methods. Deliberately `any`-valued — a facade is QML's dynamic edge,
 * and `view.id('meter').width = 40` reading naturally is the point.
 */
// eslint does not see TypeScript here (AGENTS.md, "Linting"); the explicit
// `any` is a deliberate choice for this one boundary type.
export type QmlFacade = Record<string, any>;

export interface QmlPropertyDef {
  default?: unknown;
}

export interface ValueSourceHookup {
  targetSlot: Slot;
  target: QmlInstance;
}

/** What `registerQmlModule` takes, per type. */
export interface QmlTypeDef {
  extends?: string;
  nonVisual?: boolean;
  /** Object children become templates under this key (Repeater's
   * `delegate`, Loader's `sourceComponent`) instead of instantiating. */
  capture?: string;
  /** Bindings to undeclared names create slots (`PropertyChanges`,
   * `ListElement`) instead of failing. */
  dynamicProperties?: boolean;
  /** `on<Signal>` members are collected, not attached — the type wires
   * them itself (`Connections`). */
  deferHandlers?: boolean;
  properties?: Record<string, QmlPropertyDef>;
  signals?: Record<string, string[]>;
  enums?: Record<string, number>;
  init?: (inst: QmlInstance, hookup?: ValueSourceHookup) => void;
  dispose?: (inst: QmlInstance) => void;
  /** The instance's effective children changed (Repeater splice). */
  onStructure?: (inst: QmlInstance) => void;
  view?: ComponentType<{ inst: QmlInstance }>;
}

export interface QmlTypeInfo {
  name: string;
  base: QmlTypeInfo | null;
  nonVisual: boolean;
  capture: string | null;
  dynamicProperties: boolean;
  deferHandlers: boolean;
  properties: Record<string, QmlPropertyDef>;
  signals: Record<string, string[]>;
  enums: Record<string, number>;
  init: ((inst: QmlInstance, hookup?: ValueSourceHookup) => void) | null;
  dispose: ((inst: QmlInstance) => void) | null;
  onStructure: ((inst: QmlInstance) => void) | null;
  view: ComponentType<{ inst: QmlInstance }> | null;
}

// --- type registry ---------------------------------------------------------

const modules = new Map<string, { types: Map<string, QmlTypeInfo> }>();

export function registerQmlModule(
  name: string,
  { types }: { version?: string; types: Record<string, QmlTypeDef> },
): void {
  const mod = modules.get(name) ?? { types: new Map<string, QmlTypeInfo>() };
  modules.set(name, mod); // visible before resolution: types extend siblings
  for (const [typeName, def] of Object.entries(types)) {
    mod.types.set(typeName, resolveTypeInfo(typeName, def));
  }
}

function resolveTypeInfo(name: string, def: QmlTypeDef): QmlTypeInfo {
  let base: QmlTypeInfo | null = null;
  if (def.extends) {
    for (const mod of modules.values()) {
      const hit = mod.types.get(def.extends);
      if (hit) base = hit;
    }
    if (!base)
      throw new Error(`QML type ${name} extends unknown ${def.extends}`);
  }
  return {
    name,
    base,
    properties: { ...base?.properties, ...def.properties },
    signals: { ...base?.signals, ...def.signals },
    enums: { ...base?.enums, ...def.enums },
    nonVisual: def.nonVisual ?? base?.nonVisual ?? false,
    capture: def.capture ?? base?.capture ?? null,
    dynamicProperties:
      def.dynamicProperties ?? base?.dynamicProperties ?? false,
    deferHandlers: def.deferHandlers ?? base?.deferHandlers ?? false,
    init: def.init ?? base?.init ?? null,
    dispose: def.dispose ?? base?.dispose ?? null,
    onStructure: def.onStructure ?? base?.onStructure ?? null,
    view: def.view ?? base?.view ?? null,
  };
}

export function lookupType(doc: QmlDocument, typeName: string): QmlTypeInfo {
  // `alias.Type` from `import … as alias`
  let name = typeName;
  let onlyModule: string | null = null;
  const dot = typeName.indexOf('.');
  if (dot !== -1) {
    const alias = typeName.slice(0, dot);
    const imp = doc.imports.find((i) => i.alias === alias);
    if (imp?.module) {
      onlyModule = imp.module;
      name = typeName.slice(dot + 1);
    }
  }
  for (const imp of doc.imports) {
    if (!imp.module) continue;
    if (onlyModule && imp.module !== onlyModule) continue;
    const info = modules.get(imp.module)?.types.get(name);
    if (info) return info;
  }
  const known = [...modules.keys()].join(', ');
  throw new Error(
    `Unknown QML type '${typeName}' in ${doc.fileName}. Imported modules ` +
      `were searched; registered modules: ${known}. Register your own with ` +
      `registerQmlModule(module, { types }).`,
  );
}

// --- expression compilation ------------------------------------------------

type CompiledExpr = (this: QmlFacade, scope: object) => unknown;
type HandlerFactory = (scope: object) => (...args: unknown[]) => unknown;

const compiledCache = new WeakMap<object, unknown>();

function compileExpr(
  node: Extract<ValueIR, { kind: 'expr' }>,
  doc: QmlDocument,
): CompiledExpr {
  let fn = compiledCache.get(node) as CompiledExpr | undefined;
  if (!fn) {
    try {
      fn = new Function(
        '$scope',
        `with($scope){ return (${node.src}\n) }`,
      ) as CompiledExpr;
    } catch (e) {
      throw new Error(
        `QML: bad expression in ${doc.fileName}: \`${node.src}\` (${message(e)})`,
      );
    }
    compiledCache.set(node, fn);
  }
  return fn;
}

function compileHandler(
  node: { kind: string; src: string },
  params: string[],
  doc: QmlDocument,
): HandlerFactory {
  let fn = compiledCache.get(node) as HandlerFactory | undefined;
  if (!fn) {
    const body = node.kind === 'block' ? node.src : `return (${node.src}\n)`;
    try {
      fn = new Function(
        '$scope',
        `with($scope){ return function(${params.join(', ')}){ ${body} \n} }`,
      ) as HandlerFactory;
    } catch (e) {
      throw new Error(
        `QML: bad handler in ${doc.fileName}: \`${node.src}\` (${message(e)})`,
      );
    }
    compiledCache.set(node, fn);
  }
  return fn;
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// --- contexts --------------------------------------------------------------

export class Context {
  parent: Context | null;
  doc: QmlDocument;
  ids = new Map<string, QmlInstance>();
  extras = new Map<string, Slot>(); // context properties
  root: QmlInstance | null = null;

  constructor(parent: Context | null, doc: QmlDocument) {
    this.parent = parent;
    this.doc = doc;
  }

  lookupId(name: string): QmlInstance | null {
    for (let c: Context | null = this; c; c = c.parent) {
      const inst = c.ids.get(name);
      if (inst) return inst;
    }
    return null;
  }

  lookupExtra(name: string): Slot | null {
    for (let c: Context | null = this; c; c = c.parent) {
      const slot = c.extras.get(name);
      if (slot) return slot;
    }
    return null;
  }
}

const QtBindingMark = Symbol('Qt.binding');

export interface QtNamespace {
  [key: string]: unknown;
  rgba(r: number, g: number, b: number, a?: number): string;
  hsla(h: number, s: number, l: number, a?: number): string;
  point(x: number, y: number): { x: number; y: number };
  size(width: number, height: number): { width: number; height: number };
  rect(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { x: number; y: number; width: number; height: number };
  binding(fn: () => unknown): unknown;
  qsTr(s: string): string;
}

export const Qt: QtNamespace = {
  rgba: (r, g, b, a = 1) =>
    `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`,
  hsla: (h, s, l, a = 1) =>
    `hsla(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`,
  point: (x, y) => ({ x, y }),
  size: (width, height) => ({ width, height }),
  rect: (x, y, width, height) => ({ x, y, width, height }),
  binding: (fn) => ({ [QtBindingMark]: fn }),
  qsTr: (s) => s,
};

function makeScopeProxy(inst: QmlInstance): object {
  const scopeHas = (name: string): boolean => {
    if (name === 'Qt' || name === 'parent' || name === 'this') return true;
    if (inst.context.lookupId(name)) return true;
    if (inst.resolveMember(name) !== undefined) return true;
    const root = inst.context.root;
    if (root && root !== inst && root.resolveMember(name) !== undefined)
      return true;
    if (inst.context.lookupExtra(name)) return true;
    if (enumHolder(inst, name)) return true;
    return false; // fall through `with` to the real JS globals
  };
  return new Proxy(Object.create(null) as object, {
    has: (_, name) => (typeof name === 'string' ? scopeHas(name) : false),
    get: (_, name) => {
      if (typeof name !== 'string') return undefined;
      if (name === 'Qt') return Qt;
      if (name === 'parent') return inst.parentInst?.facade ?? null;
      const idHit = inst.context.lookupId(name);
      if (idHit) return idHit.facade;
      let v = inst.getMember(name);
      if (v !== undefined) return v;
      const root = inst.context.root;
      if (root && root !== inst) {
        v = root.getMember(name);
        if (v !== undefined) return v;
      }
      const extra = inst.context.lookupExtra(name);
      if (extra) return extra.get();
      const holder = enumHolder(inst, name);
      if (holder) return holder;
      return undefined;
    },
    set: (_, name, value) => {
      if (typeof name !== 'string') return false;
      // Assignment in handlers: prefer the object that owns the property.
      if (inst.slots.has(name)) {
        inst.setMember(name, value);
        return true;
      }
      const root = inst.context.root;
      if (root && root !== inst && root.slots.has(name)) {
        root.setMember(name, value);
        return true;
      }
      throw new Error(`QML: cannot assign unknown name '${name}'`);
    },
  });
}

/** `Text.AlignHCenter` — uppercase names resolve to a type's enums. */
function enumHolder(
  inst: QmlInstance,
  name: string,
): Record<string, number> | null {
  if (!/^[A-Z]/.test(name)) return null;
  try {
    const info = lookupType(inst.doc, name);
    return Object.keys(info.enums).length ? info.enums : null;
  } catch {
    return null;
  }
}

// --- instances -------------------------------------------------------------

let nextInstanceId = 1;

export interface AnchorLine {
  inst: QmlInstance;
  edge: string;
}

export class QmlInstance {
  readonly uid: number;
  readonly typeInfo: QmlTypeInfo;
  readonly doc: QmlDocument;
  readonly context: Context;
  parentInst: QmlInstance | null;
  id: string | null = null;
  ir: ObjectIR | null = null;
  slots = new Map<string, Slot>();
  methods = new Map<string, (...args: unknown[]) => unknown>();
  signalParams = new Map<string, string[]>();
  signalSubs = new Map<string, Set<(...args: unknown[]) => void>>();
  /** Effective visual children — Repeater splices instances in here. */
  children: QmlInstance[] = [];
  /** Captured object templates (`delegate`, `sourceComponent`, …). */
  templates = new Map<string, ObjectIR>();
  valueSources: QmlInstance[] = [];
  /** `Keys.onPressed` and friends: attached handlers by dotted name. */
  attachedHandlers = new Map<string, (...args: unknown[]) => unknown>();
  /** `Connections`: raw `onX` members, wired by the type's init. */
  deferredHandlers: Array<{ name: string; value: ValueIR }> = [];
  onDestruction: Array<() => void> = [];
  anchorLines = new Map<string, AnchorLine>();
  version = 0;
  structVersion = 0;
  listeners = new Set<() => void>();
  destroyed = false;
  /** Per-type scratch: timers, behaviors, repeater items, host node… */
  state: Record<string, unknown> = {};
  scope: object;
  facade: QmlFacade;
  _activated = false;

  constructor(
    typeInfo: QmlTypeInfo,
    doc: QmlDocument,
    context: Context,
    parentInst: QmlInstance | null,
  ) {
    this.uid = nextInstanceId++;
    this.typeInfo = typeInfo;
    this.doc = doc;
    this.context = context;
    this.parentInst = parentInst;
    this.scope = makeScopeProxy(this);
    this.facade = makeFacade(this);
    for (const [name, decl] of Object.entries(typeInfo.properties)) {
      this.addSlot(name, decl.default);
    }
    for (const [name, params] of Object.entries(typeInfo.signals)) {
      this.signalParams.set(name, params);
    }
  }

  addSlot(name: string, value: unknown): Slot {
    const slot = new Slot(this, name, value);
    this.slots.set(name, slot);
    return slot;
  }

  slot(name: string): Slot {
    const s = this.slots.get(name);
    if (!s)
      throw new Error(
        `QML: ${this.typeInfo.name} has no property '${name}' (${this.doc.fileName})`,
      );
    return s;
  }

  /** undefined ⇒ not a member (so scope lookup continues up the chain). */
  resolveMember(name: string): unknown {
    if (this.slots.has(name)) return this.slots.get(name);
    if (this.methods.has(name)) return this.methods.get(name);
    if (this.signalParams.has(name)) return name;
    return undefined;
  }

  getMember(name: string): unknown {
    const slot = this.slots.get(name);
    if (slot) {
      const v = slot.get();
      return v === undefined ? null : v; // undefined would break the walk
    }
    if (this.methods.has(name)) return this.methods.get(name);
    if (this.signalParams.has(name)) {
      return (...args: unknown[]) => this.emit(name, ...args);
    }
    return undefined;
  }

  setMember(name: string, value: unknown): void {
    if (value && typeof value === 'object' && QtBindingMark in value) {
      const fn = (value as Record<symbol, () => unknown>)[QtBindingMark];
      this.slot(name).setBinding(() => fn.call(this.facade));
      return;
    }
    this.slot(name).set(value);
  }

  emit(name: string, ...args: unknown[]): void {
    const subs = this.signalSubs.get(name);
    if (subs) for (const fn of [...subs]) fn(...args);
    flushBindings();
  }

  onSignal(name: string, fn: (...args: unknown[]) => void): () => void {
    if (!this.signalParams.has(name) && !this.slots.has(stripChanged(name)))
      throw new Error(`QML: ${this.typeInfo.name} has no signal '${name}'`);
    let set = this.signalSubs.get(name);
    if (!set) this.signalSubs.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  anchorLine(edge: string): AnchorLine {
    let line = this.anchorLines.get(edge);
    if (!line) this.anchorLines.set(edge, (line = { inst: this, edge }));
    return line;
  }

  /** React bridge: any slot change bumps the version; one subscription
   * per object. */
  _changed(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  _structChanged(): void {
    this.structVersion++;
    this.typeInfo.onStructure?.(this); // positioners re-pin children
    this._changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  visualChildren(): QmlInstance[] {
    return this.children.filter((c) => !c.typeInfo.nonVisual);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const fn of this.onDestruction) fn();
    for (const child of this.children) child.destroy();
    for (const src of this.valueSources) src.destroy();
    this.typeInfo.dispose?.(this);
    for (const slot of this.slots.values()) slot.destroy();
    this.listeners.clear();
    this.signalSubs.clear();
  }
}

const stripChanged = (n: string): string =>
  /^on[A-Z].*Changed$/.test(n)
    ? n.slice(2, -7)[0].toLowerCase() + n.slice(3, -7)
    : '';

// --- facade ----------------------------------------------------------------

const FACADE = Symbol('qml-instance');

/** The instance behind a facade, or null for anything else. */
export const instanceOf = (facade: unknown): QmlInstance | null =>
  facade && typeof facade === 'object'
    ? (((facade as Record<symbol, unknown>)[FACADE] as QmlInstance | null) ??
      null)
    : null;

const ANCHOR_EDGES = new Set([
  'left',
  'right',
  'top',
  'bottom',
  'horizontalCenter',
  'verticalCenter',
]);

function makeFacade(inst: QmlInstance): QmlFacade {
  return new Proxy(Object.create(null) as QmlFacade, {
    has: (_, name) =>
      typeof name === 'string' &&
      (name === 'parent' ||
        ANCHOR_EDGES.has(name) ||
        inst.resolveMember(name) !== undefined),
    get: (_, name) => {
      if (name === FACADE) return inst;
      if (typeof name !== 'string') return undefined;
      if (name === 'parent') return inst.parentInst?.facade ?? null;
      if (ANCHOR_EDGES.has(name) && !inst.slots.has(name))
        return inst.anchorLine(name);
      return inst.getMember(name);
    },
    set: (_, name, value) => {
      if (typeof name !== 'string') return false;
      inst.setMember(name, value);
      return true;
    },
  });
}

// --- instantiation ---------------------------------------------------------

let activating = false;

export interface InstantiateResult {
  root: QmlInstance;
  context: Context;
}

export function instantiateDocument(
  doc: QmlDocument,
  {
    context = null,
    extras = null,
  }: {
    context?: Context | null;
    extras?: Record<string, unknown> | null;
  } = {},
): InstantiateResult {
  const ctx = new Context(context, doc);
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      ctx.extras.set(k, new Slot(null, k, v));
    }
  }
  const completedQueue: Array<() => void> = [];
  const root = createTree(doc.root, doc, ctx, null);
  ctx.root = root;
  const wasActivating = activating;
  activating = true;
  try {
    activate(root, doc, completedQueue);
    flushBindings();
  } finally {
    activating = wasActivating;
  }
  retryFailedBindings(root);
  for (const fn of completedQueue) fn(); // leaf-first: queued on the way up
  flushBindings();
  return { root, context: ctx };
}

/**
 * A delegate template instantiated into a child context (Repeater, Loader,
 * ListView). `extras` become context properties (index, modelData, roles);
 * ids inside the template scope to the child context while names from the
 * enclosing document keep resolving through the chain.
 */
export function instantiateTemplate(
  tpl: ObjectIR,
  doc: QmlDocument,
  parentContext: Context,
  parentInst: QmlInstance | null,
  extras: Record<string, unknown> | null = null,
): { inst: QmlInstance; context: Context } {
  const ctx = new Context(parentContext, doc);
  ctx.root = parentContext.root;
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      ctx.extras.set(k, new Slot(null, k, v));
    }
  }
  const completedQueue: Array<() => void> = [];
  const inst = createTree(tpl, doc, ctx, parentInst);
  const wasActivating = activating;
  activating = true;
  try {
    activate(inst, doc, completedQueue);
    flushBindings();
  } finally {
    activating = wasActivating;
  }
  retryFailedBindings(inst);
  for (const fn of completedQueue) fn();
  return { inst, context: ctx };
}

/**
 * Hot reload: carry interactive state (slots assigned at runtime —
 * toggles, counters, typed text) from the old tree onto the new one,
 * matched by id + property name. Everything else re-derives from the
 * edited source.
 */
export function migrateUserState(
  oldContext: Context,
  newContext: Context,
): number {
  let carried = 0;
  for (const [id, oldInst] of oldContext.ids) {
    const newInst = newContext.ids.get(id);
    if (!newInst) continue;
    for (const [name, oldSlot] of oldInst.slots) {
      if (!oldSlot.userSet) continue;
      const newSlot = newInst.slots.get(name);
      if (!newSlot) continue;
      newSlot.set(oldSlot.peek());
      carried++;
    }
  }
  flushBindings();
  return carried;
}

/** A binding still failing after the graph settled deserves its warning —
 * and a broken dependency read may have kept it from subscribing to
 * anything that would re-run it, so run it once more by hand. */
function retryFailedBindings(inst: QmlInstance): void {
  for (const child of inst.children) retryFailedBindings(child);
  for (const slot of inst.slots.values()) {
    if (slot.hasBinding() && slot.lastError) slot._reevaluate();
  }
}

function createTree(
  objIr: ObjectIR,
  doc: QmlDocument,
  ctx: Context,
  parentInst: QmlInstance | null,
): QmlInstance {
  const typeInfo = lookupType(doc, objIr.type);
  const inst = new QmlInstance(typeInfo, doc, ctx, parentInst);
  inst.ir = objIr;
  // Qt's default: an unset width tracks implicitWidth (`widthValid`). Any
  // later binding or assignment replaces this — binding-breaking gives the
  // exact semantics with no bookkeeping.
  if (inst.slots.has('width') && inst.slots.has('implicitWidth')) {
    inst
      .slot('width')
      .setBinding(() => inst.slot('implicitWidth').get(), { isDefault: true });
    inst
      .slot('height')
      .setBinding(() => inst.slot('implicitHeight').get(), { isDefault: true });
  }
  if (objIr.id) {
    inst.id = objIr.id;
    ctx.ids.set(objIr.id, inst);
  }
  for (const m of objIr.members) {
    if (m.kind === 'property') {
      if (m.propType !== 'alias') {
        inst.addSlot(m.name, defaultForPropType(m.propType));
      }
    } else if (m.kind === 'signal') {
      inst.signalParams.set(
        m.name,
        m.params.map((p) => p.name),
      );
    } else if (m.kind === 'object') {
      if (typeInfo.capture) {
        if (!inst.templates.has(typeInfo.capture))
          inst.templates.set(typeInfo.capture, m.object);
      } else {
        inst.children.push(createTree(m.object, doc, ctx, inst));
      }
    } else if (m.kind === 'binding' && m.value.kind === 'object') {
      const name = m.path.join('.');
      if (name === typeInfo.capture || m.value.object.type === 'Component') {
        // `delegate: Text { … }`, `sourceComponent: Component { … }` —
        // component-typed properties stay templates, instantiated on demand.
        inst.templates.set(name, unwrapComponent(m.value.object));
      } else {
        // `model: ListModel { … }` — an object rvalue instantiates, and the
        // property is assigned the reference (QML's rule).
        const child = createTree(m.value.object, doc, ctx, inst);
        inst.children.push(child);
        (
          (inst.state.objectAssigns ??= []) as Array<[string, QmlInstance]>
        ).push([name, child]);
      }
    } else if (m.kind === 'binding' && m.value.kind === 'array') {
      // `states: [State { … }]` — templates too, under the property name.
      const objects = m.value.items
        .filter(
          (it): it is Extract<ValueIR, { kind: 'object' }> =>
            it.kind === 'object',
        )
        .map((it) => it.object);
      if (objects.length === m.value.items.length && objects.length > 0) {
        inst.state[`templates:${m.path.join('.')}`] = objects;
      }
    } else if (m.kind === 'inline-component') {
      throw new Error(
        `QML: inline components (component ${m.name}: …) are planned with ` +
          `directory imports; for now define the type in JavaScript with ` +
          `registerQmlModule and import it.`,
      );
    }
  }
  return inst;
}

function defaultForPropType(propType: string): unknown {
  if (propType === 'int' || propType === 'real' || propType === 'double')
    return 0;
  if (propType === 'bool') return false;
  if (propType === 'string') return '';
  if (propType === 'list') return [];
  return undefined;
}

const unwrapComponent = (obj: ObjectIR): ObjectIR => {
  if (obj.type !== 'Component') return obj;
  const child = obj.members.find(
    (m): m is Extract<MemberIR, { kind: 'object' }> => m.kind === 'object',
  );
  if (!child) throw new Error('QML: Component {} needs exactly one child');
  return child.object;
};

function activate(
  inst: QmlInstance,
  doc: QmlDocument,
  completedQueue: Array<() => void>,
): void {
  if (inst._activated) return; // Repeater splices siblings mid-walk
  inst._activated = true;
  const objIr = inst.ir;
  if (!objIr) return;
  for (const child of [...inst.children]) activate(child, doc, completedQueue);

  const applyBinding = (path: string[], value: ValueIR): void => {
    if (path.length === 1 && /^on[A-Z]/.test(path[0])) {
      if (inst.typeInfo.deferHandlers) {
        inst.deferredHandlers.push({ name: path[0], value });
        return;
      }
      attachHandler(inst, path[0], value, doc);
      return;
    }
    if (/^[A-Z]/.test(path[0]) && path.length > 1) {
      attachAttached(inst, path, value, doc, completedQueue);
      return;
    }
    const name = path.join('.'); // grouped props live as dotted slot names
    if (value.kind === 'object') return; // captured as a template already
    if (value.kind === 'array') return; // captured as templates already
    let slot = inst.slots.get(name);
    if (!slot) {
      if (inst.typeInfo.dynamicProperties) slot = inst.addSlot(name, undefined);
      else slot = inst.slot(name); // throws with the readable message
    }
    if (value.kind === 'block') {
      // `width: { if (…) return a; return b }` — a script binding; QML
      // re-evaluates these like any binding when dependencies change.
      const h = compileHandler(value, [], doc)(inst.scope);
      installGuardedBinding(inst, slot, value, doc, name, () =>
        h.call(inst.facade),
      );
      return;
    }
    if (isLiteral(value.src)) {
      slot.assign(evalLiteral(value.src));
      return;
    }
    const fn = compileExpr(value, doc);
    installGuardedBinding(inst, slot, value, doc, name, () =>
      fn.call(inst.facade, inst.scope),
    );
  };

  for (const m of objIr.members) {
    if (m.kind === 'property' && m.value) {
      if (m.propType === 'alias') {
        installAlias(inst, m.name, m.value as AliasTargetIR);
      } else {
        applyBinding([m.name], m.value as ValueIR);
      }
    } else if (m.kind === 'binding') {
      applyBinding(m.path, m.value);
    } else if (m.kind === 'group') {
      for (const b of m.bindings) applyBinding(b.path, b.value);
    } else if (m.kind === 'function') {
      const factory = compileHandler(
        { kind: 'block', src: m.body },
        m.params,
        doc,
      );
      const f = factory(inst.scope);
      inst.methods.set(m.name, (...args: unknown[]) =>
        f.call(inst.facade, ...args),
      );
    } else if (m.kind === 'value-source') {
      installValueSource(inst, m, doc);
    }
  }

  // Object rvalues (`model: ListModel { … }`): the instance exists since
  // createTree; hand the property its reference before the type's init
  // reads it.
  const objectAssigns = inst.state.objectAssigns as
    Array<[string, QmlInstance]> | undefined;
  if (objectAssigns) {
    for (const [name, child] of objectAssigns) {
      const slot =
        inst.slots.get(name) ??
        (inst.typeInfo.dynamicProperties
          ? inst.addSlot(name, undefined)
          : inst.slot(name));
      slot.assign(child.facade);
    }
  }

  installAnchors(inst);
  inst.typeInfo.init?.(inst);
}

function installGuardedBinding(
  inst: QmlInstance,
  slot: Slot,
  value: ValueIR,
  doc: QmlDocument,
  name: string,
  evalFn: () => unknown,
): void {
  slot.setBinding(() => {
    try {
      const v = evalFn();
      slot.lastError = null;
      return v;
    } catch (e) {
      slot.lastError = e;
      // First-pass evaluation order is unspecified (a child's binding can
      // read a root property whose own binding has not run yet) — exactly
      // as in Qt. Stay quiet during activation; instantiateDocument
      // re-evaluates whatever is still broken once the graph settles, and
      // *that* failure warns.
      if (!activating) reportBindingError(doc, value, name, e);
      return slot.peek();
    }
  });
}

function isLiteral(src: string): boolean {
  return /^(-?\d+(\.\d+)?|true|false|null|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(
    src.trim(),
  );
}

function evalLiteral(src: string): unknown {
  const t = src.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t[0] === '"' || t[0] === "'")
    return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return Number(t);
}

const reportedBindingErrors = new Set<string>();
function reportBindingError(
  doc: QmlDocument,
  value: ValueIR,
  name: string,
  e: unknown,
): void {
  const key = `${doc.fileName}:${name}`;
  if (reportedBindingErrors.has(key)) return;
  reportedBindingErrors.add(key);
  const src = 'src' in value ? value.src : '';
  warn(
    `QML: binding for '${name}' in ${doc.fileName} threw: ${message(e)}\n  \`${src}\``,
  );
}

// `onFoo: expr-or-block` — but also the modern `onFoo: (args) => { … }`,
// where the RHS evaluates to the function to invoke with the signal's args.
const FN_VALUED = /^\s*(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;

function makeHandlerFn(
  inst: QmlInstance,
  value: ValueIR,
  params: string[],
  doc: QmlDocument,
): (...args: unknown[]) => unknown {
  if (value.kind === 'expr' && FN_VALUED.test(value.src)) {
    const arrow = compileExpr(value, doc).call(inst.facade, inst.scope) as (
      ...args: unknown[]
    ) => unknown;
    return (...args) => arrow.apply(inst.facade, args);
  }
  if (value.kind !== 'expr' && value.kind !== 'block')
    throw new Error(`QML: a handler cannot be an object (${doc.fileName})`);
  const f = compileHandler(value, params, doc)(inst.scope);
  return (...args) => f.call(inst.facade, ...args);
}

/** Compile a stored handler in an instance's scope — how `Connections`
 * wires its deferred `onX` members to another object's signals. */
export function makeHandlerFor(
  inst: QmlInstance,
  value: ValueIR,
  params: string[],
): (...args: unknown[]) => unknown {
  return makeHandlerFn(inst, value, params, inst.doc);
}

function attachHandler(
  inst: QmlInstance,
  onName: string,
  value: ValueIR,
  doc: QmlDocument,
): void {
  const base = onName[2].toLowerCase() + onName.slice(3);
  // Property-change handler?
  const changed = stripChanged(onName);
  if (changed && inst.slots.has(changed)) {
    const f = makeHandlerFn(inst, value, [], doc);
    inst.slots.get(changed)?.watch(() => f());
    return;
  }
  const params = inst.signalParams.get(base);
  if (!params)
    throw new Error(
      `QML: '${onName}' in ${doc.fileName} matches no signal or property on ${inst.typeInfo.name}`,
    );
  inst.onSignal(base, makeHandlerFn(inst, value, params, doc));
}

function attachAttached(
  inst: QmlInstance,
  path: string[],
  value: ValueIR,
  doc: QmlDocument,
  completedQueue: Array<() => void>,
): void {
  const ns = path[0];
  const name = path.slice(1).join('.');
  if (ns === 'Component' && name === 'onCompleted') {
    const f = makeHandlerFn(inst, value, [], doc);
    completedQueue.push(() => f());
    return;
  }
  if (ns === 'Component' && name === 'onDestruction') {
    const f = makeHandlerFn(inst, value, [], doc);
    inst.onDestruction.push(() => f());
    return;
  }
  if (/^on[A-Z]/.test(name)) {
    // `Keys.onPressed`, `Keys.onReturnPressed`: stored; the view wires
    // them to the focus/key system (qtquick.tsx).
    const params = ['event'];
    inst.attachedHandlers.set(
      `${ns}.${name}`,
      makeHandlerFn(inst, value, params, doc),
    );
    return;
  }
  // `Layout.fillWidth` and friends — attached values, namespaced slots.
  const slotName = `${ns}.${name}`;
  const slot = inst.slots.get(slotName) ?? inst.addSlot(slotName, undefined);
  if (value.kind === 'expr' && isLiteral(value.src)) {
    slot.assign(evalLiteral(value.src));
    return;
  }
  if (value.kind === 'expr') {
    const fn = compileExpr(value, doc);
    installGuardedBinding(inst, slot, value, doc, slotName, () =>
      fn.call(inst.facade, inst.scope),
    );
    return;
  }
  if (value.kind === 'block') {
    const h = compileHandler(value, [], doc)(inst.scope);
    installGuardedBinding(inst, slot, value, doc, slotName, () =>
      h.call(inst.facade),
    );
  }
}

function installAlias(
  inst: QmlInstance,
  name: string,
  target: AliasTargetIR,
): void {
  const [idName, ...rest] = target.path;
  const targetInst = inst.context.lookupId(idName);
  if (!targetInst)
    throw new Error(`QML: alias '${name}' targets unknown id '${idName}'`);
  if (!rest.length)
    throw new Error(`QML: alias '${name}' must target id.property`);
  const slot = targetInst.slot(rest.join('.'));
  inst.slots.set(name, slot); // the same Slot: reads and writes forward
}

function installValueSource(
  inst: QmlInstance,
  m: Extract<MemberIR, { kind: 'value-source' }>,
  doc: QmlDocument,
): void {
  const srcType = lookupType(doc, m.object.type);
  const propName = m.on.join('.');
  const slot = inst.slot(propName);
  const srcInst = createTree(m.object, doc, inst.context, inst);
  activate(srcInst, doc, []);
  inst.valueSources.push(srcInst);
  if (!srcType.init)
    throw new Error(`QML: ${m.object.type} cannot be a value source here`);
  srcType.init(srcInst, { targetSlot: slot, target: inst });
}

// --- anchors ---------------------------------------------------------------

const px = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

function lineCoord(line: AnchorLine, forInst: QmlInstance): number {
  const { inst, edge } = line;
  const horizontal =
    edge === 'left' || edge === 'right' || edge === 'horizontalCenter';
  if (inst === forInst.parentInst) {
    const size = px(inst.slot(horizontal ? 'width' : 'height').get());
    if (edge === 'left' || edge === 'top') return 0;
    if (edge === 'right' || edge === 'bottom') return size;
    return size / 2;
  }
  // Sibling: the same coordinate space (both relative to the parent).
  const pos = px(inst.slot(horizontal ? 'x' : 'y').get());
  const size = px(inst.slot(horizontal ? 'width' : 'height').get());
  if (edge === 'left' || edge === 'top') return pos;
  if (edge === 'right' || edge === 'bottom') return pos + size;
  return pos + size / 2;
}

const isAnchorLine = (v: unknown): v is AnchorLine =>
  !!v &&
  typeof v === 'object' &&
  'inst' in v &&
  'edge' in v &&
  (v as AnchorLine).inst instanceof QmlInstance;

const ANCHOR_CONFIG_NAMES = [
  'fill',
  'centerIn',
  'left',
  'right',
  'top',
  'bottom',
  'horizontalCenter',
  'verticalCenter',
] as const;

function installAnchors(inst: QmlInstance): void {
  if (!inst.slots.has('anchors.fill')) return; // non-Item types
  const a = (n: string): unknown => inst.slots.get(`anchors.${n}`)?.get();
  const margin = (side: string): number => {
    const m = a(`${side}Margin`);
    return px(m !== undefined && m !== null ? m : a('margins'));
  };
  const line = (v: unknown): AnchorLine | null => (isAnchorLine(v) ? v : null);

  const xSlot = inst.slot('x');
  const ySlot = inst.slot('y');
  const wSlot = inst.slot('width');
  const hSlot = inst.slot('height');

  const install = (): void => {
    const fill = instanceOf(a('fill'));
    const centerIn = instanceOf(a('centerIn'));
    const L = fill ? fill.anchorLine('left') : line(a('left'));
    const R = fill ? fill.anchorLine('right') : line(a('right'));
    const T = fill ? fill.anchorLine('top') : line(a('top'));
    const B = fill ? fill.anchorLine('bottom') : line(a('bottom'));
    const HC = centerIn
      ? centerIn.anchorLine('horizontalCenter')
      : line(a('horizontalCenter'));
    const VC = centerIn
      ? centerIn.anchorLine('verticalCenter')
      : line(a('verticalCenter'));

    if (L && R) {
      wSlot.setBinding(
        () =>
          lineCoord(R, inst) -
          margin('right') -
          (lineCoord(L, inst) + margin('left')),
      );
      xSlot.setBinding(() => lineCoord(L, inst) + margin('left'));
    } else if (L) {
      xSlot.setBinding(() => lineCoord(L, inst) + margin('left'));
    } else if (R) {
      xSlot.setBinding(
        () => lineCoord(R, inst) - margin('right') - px(wSlot.get()),
      );
    } else if (HC) {
      xSlot.setBinding(() => lineCoord(HC, inst) - px(wSlot.get()) / 2);
    }
    if (T && B) {
      hSlot.setBinding(
        () =>
          lineCoord(B, inst) -
          margin('bottom') -
          (lineCoord(T, inst) + margin('top')),
      );
      ySlot.setBinding(() => lineCoord(T, inst) + margin('top'));
    } else if (T) {
      ySlot.setBinding(() => lineCoord(T, inst) + margin('top'));
    } else if (B) {
      ySlot.setBinding(
        () => lineCoord(B, inst) - margin('bottom') - px(hSlot.get()),
      );
    } else if (VC) {
      ySlot.setBinding(() => lineCoord(VC, inst) - px(hSlot.get()) / 2);
    }
  };

  const configured = ANCHOR_CONFIG_NAMES.some((n) => {
    const s = inst.slots.get(`anchors.${n}`);
    return s && (s.hasBinding() || s.peek() !== undefined);
  });
  // Re-anchoring at runtime re-installs the geometry bindings.
  for (const n of ANCHOR_CONFIG_NAMES)
    inst.slots.get(`anchors.${n}`)?.watch(install);
  if (configured) install();
}

export type { BindingFn };
