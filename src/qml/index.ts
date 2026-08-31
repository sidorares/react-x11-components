// `@react-x11/components/qml` — QML as an authoring layer over react-x11.
//
// A zero-dependency QML engine: the parser, the reactive slot graph with
// QML's binding-breaking assignment, the object model with Qt's scoping
// rules, and a QtQuick subset whose every pixel is an ordinary
// `<box>`/`<text>`/`<image>` committed through the renderer. The docs page
// is docs/components/qml.md; the design record is react-x11's QML RFC.
//
// Importing this module populates the QtQuick registry — the family's own
// module-level registry, no core state touched. That is this family's one
// import-time side effect, the same shape as a component registering its
// element (AGENTS.md, "Tree-shaking"): it lives here so a bundler that
// keeps the family runs it, and one that shakes the family drops it.

import { registerQtQuick } from './qtquick.js';

registerQtQuick();

export { parseQml, ParseError } from './parse.js';
export type {
  QmlDocument,
  QmlImport,
  ObjectIR,
  MemberIR,
  ValueIR,
} from './ir.js';
export {
  Qt,
  QmlInstance,
  Context,
  instantiateDocument,
  instantiateTemplate,
  migrateUserState,
  registerQmlModule,
  instanceOf,
  lookupType,
} from './objects.js';
export type {
  QmlFacade,
  QmlTypeDef,
  QmlTypeInfo,
  QmlPropertyDef,
  ValueSourceHookup,
  InstantiateResult,
  QtNamespace,
  TemplateRef,
} from './objects.js';
export { Slot, flushBindings } from './slots.js';
export {
  QmlView,
  QmlNode,
  registerReactComponent,
  renderQmlChildren,
  useQmlVersion,
} from './react.js';
export type {
  QmlViewProps,
  QmlViewHandle,
  RegisterReactComponentOptions,
} from './react.js';
export { qmlColor, registerQtQuick } from './qtquick.js';
export { createFileResolver } from './resolver.js';
export type { QmlResolver, DocLoad } from './resolver.js';
export { geometryStyle } from './react.js';
export { registerControls } from './controls.js';
export type { ControlsWidgets } from './controls.js';
