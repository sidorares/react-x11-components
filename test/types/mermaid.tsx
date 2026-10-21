// Type-level test: the declarations compile against react-x11's JSX
// namespace, both as a component and as the raw `<mermaid>` element the
// component's augmentation adds.
import { Mermaid, useOndine } from '../../src/index.js';
import type {
  FenceInfo,
  MermaidProps,
  MermaidScene,
  OndineError,
} from '../../src/index.js';

const VARS = { '--ondine-accent': '#2980b9', '--ondine-radius': '4px' };
const OPTIONS = { now: 0, maxWidth: 640 };

export const asComponent = (
  <box style={{ flexGrow: 1 }}>
    <Mermaid
      source={'flowchart LR\n  A --> B'}
      partial
      fontSize={14}
      vars={VARS}
      options={OPTIONS}
      onLink={(href, ev) => console.log(href, ev.x)}
      onError={(e: OndineError) => console.log(e.code, e.message)}
      errorColor="#cc0000"
      selectable
      selectionColor="rgba(41,128,185,0.35)"
      style={{ padding: 12 }}
      data-testname="diagram"
    />
  </box>
);

// the minimal form
export const minimal = <Mermaid source="pie\n  'a' : 1" />;

// the raw element the component registers
const scene: MermaidScene = { width: 10, height: 10, items: [], texts: [] };
export const asElement = (
  <mermaid scene={scene} links style={{ marginTop: 4 }} />
);

// the fence seam accepts a Mermaid renderer
export const fences: Record<string, (f: FenceInfo) => React.ReactNode> = {
  mermaid: ({ text, partial }) => <Mermaid source={text} partial={partial} />,
};

// the engine hook narrows
export function Gate(): React.ReactNode {
  const engine = useOndine();
  if (engine === null || engine === 'unavailable') return null;
  return <text>{engine.render('info').type}</text>;
}

// @ts-expect-error — source is required
export const missingSource = <Mermaid partial />;

export const fontInOptions: MermaidProps = {
  source: 'x',
  // @ts-expect-error — fontSize is a prop of its own, not an ondine option
  options: { fontSize: 3 },
};

const p: MermaidProps = { source: 'info' };
void p;
