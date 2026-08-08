// Run with: npm run examples:sparkline   (needs an X server / DISPLAY)
import React from 'react';
import { createRoot } from 'react-x11';

import { Sparkline } from '../src/index.js';

const series = Array.from({ length: 48 }, (_, i) =>
  Math.round(50 + 30 * Math.sin(i / 4) + 10 * Math.sin(i / 1.7)),
);

function App() {
  return (
    <window width={360} height={160} title="@react-x11/components">
      <box style={{ flexGrow: 1, padding: 16, gap: 12 }}>
        <text style={{ fontSize: 14, color: '$text' }}>Sparkline</text>
        <Sparkline
          data={series}
          color="#c0392b"
          strokeWidth={2}
          style={{
            width: 320,
            height: 80,
            backgroundColor: '$surfaceHover',
            borderRadius: 4,
            padding: 8,
          }}
        />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
