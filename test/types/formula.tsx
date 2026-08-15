// Type-level test: the declarations compile against react-x11's JSX
// namespace, both as a component and as the raw `<formula>` element the
// component's augmentation adds.
import { Formula, useKatex } from '../../src/index.js';
import type { FenceInfo, FormulaProps, KatexNode } from '../../src/index.js';

export const asComponent = (
  <box style={{ flexGrow: 1 }}>
    <Formula
      tex="x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}"
      display
      partial
      size={18}
      color="#222"
      errorColor="#cc0000"
      macros={{ '\\RR': '\\mathbb{R}' }}
      selectable
      selectionColor="rgba(41,128,185,0.35)"
      style={{ padding: 12 }}
      data-testname="quadratic"
    />
  </box>
);

// the minimal form
export const minimal = <Formula tex="e^{i\pi} + 1 = 0" />;

// the raw element the component registers
const tree: KatexNode = { classes: ['katex'], children: [] };
export const asElement = (
  <formula tree={tree} size={16} color="black" style={{ marginTop: 4 }} />
);

// the fence seam accepts a Formula renderer
export const fences: Record<string, (f: FenceInfo) => React.ReactNode> = {
  math: ({ text, partial }) => <Formula tex={text} display partial={partial} />,
};

// the engine hook narrows
export function Gate(): React.ReactNode {
  const engine = useKatex();
  if (engine === null || engine === 'unavailable') return null;
  return <Formula tex="\sqrt{2}" size={14} />;
}

// @ts-expect-error — tex is required
export const missingTex = <Formula display />;

const p: FormulaProps = { tex: 'x' };
void p;
