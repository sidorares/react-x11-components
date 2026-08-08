// Run with: npm run examples:sparkline   (needs an X server / DISPLAY)
// No `import React` — `jsx: react-jsx` compiles these tags through
// react-x11's automatic runtime, and an unused import is an error now that
// `noUnusedLocals` does the job eslint's react plugin used to.
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { Sparkline } from '../src/index.js';

const series = Array.from({ length: 48 }, (_, i) =>
  Math.round(50 + 30 * Math.sin(i / 4) + 10 * Math.sin(i / 1.7)),
);

function App(): ReactElement {
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
