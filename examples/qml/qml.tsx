// Run with: npm run examples:qml   (needs an X server / DISPLAY)
//
// A QML document rendered by react-x11 — and the three ways a type name
// resolves, side by side:
//
//  - `Backdrop`  — the *implicit same-directory import*: Backdrop.qml sits
//    beside qml-demo.qml, no import line, found through the resolver seam;
//  - `Meter`     — an *explicit quoted import*, `import "./widgets"`,
//    through the same resolver;
//  - `Gauge`     — an *explicit module import*, `import Demo 1.0`,
//    registered below with registerQmlModule — no file involved;
//  - `Button`    — QtQuick.Controls over core's Button (registerControls).
//
// Placement is QtQuick.Layouts almost everywhere — ColumnLayout/RowLayout
// on the renderer's own flex engine, geometry readable back in bindings —
// with absolute x/y only for Backdrop's chrome and the Behavior-animated
// Meter.
//
// The resolver is the standard filesystem one (createFileResolver); any
// object with the QmlResolver shape works — a bundle, a cache, a test's
// in-memory map.
//
// While it runs, edit qml-demo.qml, Backdrop.qml or widgets/Meter.qml:
// every .qml file here is watched, the tree rebuilds, and interactive
// state (the `count` you clicked up) is carried across by id.
import React, { useEffect, useState } from 'react';
import fs from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoot, Button } from 'react-x11';

import {
  QmlView,
  captureNode,
  createFileResolver,
  geometryStyle,
  registerControls,
  registerQmlModule,
  type QmlInstance,
} from '../../src/index.js';

registerControls({ Button });

// The registry path, directly: a QML type is a property table and a view.
registerQmlModule('Demo', {
  version: '1.0',
  types: {
    Gauge: {
      extends: 'Item',
      properties: {
        value: { default: 0 },
        max: { default: 1 },
        track: { default: '#1d242d' },
        fill: { default: '#2f81f7' },
      },
      view: ({ inst }: { inst: QmlInstance }) => {
        const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
        const width = num(inst.slot('width').peek());
        const max = num(inst.slot('max').peek()) || 1;
        const frac = Math.max(
          0,
          Math.min(1, num(inst.slot('value').peek()) / max),
        );
        return (
          <box
            // captureNode lets QtQuick.Layouts reflect yoga's geometry back
            // into this item's slots — which is where `width` below comes
            // from when the Gauge sits in a layout with Layout.fillWidth.
            ref={captureNode(inst)}
            style={{
              ...geometryStyle(inst),
              backgroundColor: String(inst.slot('track').peek()),
              borderRadius: 5,
              overflow: 'hidden',
            }}
          >
            <box
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: Math.round(width * frac),
                height: num(inst.slot('height').peek()),
                backgroundColor: String(inst.slot('fill').peek()),
              }}
            />
          </box>
        );
      },
    },
  },
});

const DIR = dirname(fileURLToPath(import.meta.url));
const QML_FILE = `${DIR}/qml-demo.qml`;
const resolver = await createFileResolver(DIR);

export function App(): React.ReactElement {
  const [source, setSource] = useState(() => fs.readFileSync(QML_FILE, 'utf8'));
  // Sibling edits (Backdrop.qml, widgets/Meter.qml) leave `source`
  // unchanged; bumping `reloadToken` is what tells QmlView to rebuild —
  // with the same by-id state migration a source change gets.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const reload = (): void => {
      try {
        setSource(fs.readFileSync(QML_FILE, 'utf8'));
        setGeneration((g) => g + 1);
      } catch {
        // mid-save torn read; the next event delivers the full file
      }
    };
    const watchers = [DIR, `${DIR}/widgets`].map((d) => fs.watch(d, reload));
    return () => watchers.forEach((w) => w.close());
  }, []);
  return (
    <window
      title="QML on react-x11"
      width={600}
      height={460}
      style={{ backgroundColor: '#0b0e12', padding: 20 }}
    >
      <QmlView
        source={source}
        file={QML_FILE}
        resolver={resolver}
        reloadToken={generation}
      />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
