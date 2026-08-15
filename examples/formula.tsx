// Run with: npm run examples:formula   (needs an X server / DISPLAY)
//
// TeX mathematics rendered natively — KaTeX's layout, ntk's glyphs, and
// core's selection: drag across a formula (or Ctrl+A) and middle-click
// what you copied into a terminal. The `selectable` prop makes each
// formula its own surface here; inside a `<Markdown>` document the
// document's surface does it instead (see examples/markdown.tsx).
import type { ReactElement } from 'react';
import { createRoot } from 'react-x11';

import { Formula } from '../src/index.js';

const SAMPLES: Array<{ label: string; tex: string; display?: boolean }> = [
  {
    label: 'The quadratic formula',
    tex: 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}',
    display: true,
  },
  {
    label: 'A sum with limits',
    tex: '\\sum_{i=0}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}',
    display: true,
  },
  {
    label: 'A Gaussian integral',
    tex: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
    display: true,
  },
  {
    label: 'A matrix',
    tex: 'A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}, \\quad \\det A = ad - bc',
    display: true,
  },
  {
    label: 'Inline, beside text',
    tex: 'e^{i\\pi} + 1 = 0 \\quad \\text{and} \\quad \\hbar = \\frac{h}{2\\pi}',
  },
  {
    label: 'Fonts and colours',
    tex: '\\mathbb{R} \\subset \\mathbb{C}, \\quad \\mathcal{L}(f) = {\\color{teal} \\int f\\,e^{-st}\\,dt}',
  },
];

function App(): ReactElement {
  return (
    <window width={560} height={620} title="Formula — TeX mathematics">
      <box style={{ flexGrow: 1, overflow: 'scroll' }}>
        <box style={{ flexDirection: 'column', gap: 18, padding: 20 }}>
          {SAMPLES.map((s) => (
            <box key={s.tex} style={{ flexDirection: 'column', gap: 6 }}>
              <text style={{ fontSize: 12, color: '$textMuted' }}>
                {s.label}
              </text>
              <Formula tex={s.tex} display={s.display} selectable />
            </box>
          ))}
        </box>
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
