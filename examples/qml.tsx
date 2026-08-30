// Run with: npm run examples:qml   (needs an X server / DISPLAY)
//
// A QML document rendered by react-x11 — the `qml` family end to end:
// bindings, anchors, a Repeater in a Row, a Behavior and a state
// Transition riding the renderer's own transition engine, a Timer, a
// windowed ListView over an inline ListModel, a two-way TextInput, and a
// react-x11 <Button> instantiated *from* the QML source.
//
// While it runs, edit qml-demo.qml: the file is watched, the tree is
// rebuilt from the new source, and interactive state (the `count` you
// clicked up) is carried across by id — the hot-reload story from
// docs/components/qml.md.
import React, { useEffect, useState } from 'react';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRoot, Button } from 'react-x11';

import { QmlView, registerControls } from '../src/index.js';

registerControls({ Button });

const QML_FILE = fileURLToPath(new URL('./qml-demo.qml', import.meta.url));

export function App(): React.ReactElement {
  const [source, setSource] = useState(() => fs.readFileSync(QML_FILE, 'utf8'));
  useEffect(() => {
    const watcher = fs.watch(QML_FILE, () => {
      try {
        setSource(fs.readFileSync(QML_FILE, 'utf8'));
      } catch {
        // mid-save torn read; the next event delivers the full file
      }
    });
    return () => watcher.close();
  }, []);
  return (
    <window
      title="QML on react-x11"
      width={600}
      height={460}
      style={{ backgroundColor: '#0b0e12', padding: 20 }}
    >
      <QmlView source={source} file="qml-demo.qml" />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
