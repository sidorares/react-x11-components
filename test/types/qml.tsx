// Type-level test: the QML surface compiles against react-x11's JSX
// namespace — QmlView's props and handle, a module registration with typed
// definitions, the deliberately-dynamic facade, and the mistakes that must
// not compile.
import React from 'react';
import {
  QmlView,
  registerQmlModule,
  registerReactComponent,
  Qt,
} from '../../src/index.js';
import type { QmlViewHandle, QmlTypeDef, QmlFacade } from '../../src/index.js';
import { instantiateDocument, parseQml } from '../../src/qml/index.js';
import type { QmlInstance } from '../../src/qml/index.js';

const ref = React.createRef<QmlViewHandle>();

export const view = (
  <QmlView
    ref={ref}
    source={'import QtQuick 2.15\nItem { }'}
    file="app.qml"
    context={{ userName: 'ada', level: 3 }}
    onSignal={{ submitted: (value: unknown) => void value }}
    hotReload={false}
    style={[{ backgroundColor: '$surface' }, { padding: 4 }]}
  />
);

// The handle: facades are the dynamic edge, ids are nullable.
if (ref.current) {
  const root: QmlFacade = ref.current.root;
  root.count = 3;
  const maybe = ref.current.id('meter');
  if (maybe) maybe.width = 40;
  const inst: QmlInstance = ref.current.instance;
  void inst.slot('width').peek();
}

// A registration is typed end to end.
const def: QmlTypeDef = {
  extends: 'Item',
  properties: { amount: { default: 0 } },
  signals: { activated: ['payload'] },
  init(inst) {
    inst.slot('amount').assign(1);
  },
};
registerQmlModule('Shop.Widgets', { types: { PriceTag: def } });

function Badge({ label }: { label?: unknown }): React.ReactElement {
  return <text>{String(label)}</text>;
}
registerReactComponent(
  'Shop.Widgets',
  'Badge',
  Badge as React.ComponentType<Record<string, unknown>>,
  { properties: { label: { default: '' } } },
);

// The headless half needs no React at all.
export const headless = instantiateDocument(
  parseQml('import QtQuick 2.15\nItem { width: 10 }'),
).root.slot('width');

export const rgba: string = Qt.rgba(1, 0, 0, 0.5);

// @ts-expect-error — source is required.
export const missingSource = <QmlView />;

// @ts-expect-error — hotReload is a boolean, not a string.
export const badFlag = <QmlView source="Item {}" hotReload="yes" />;
