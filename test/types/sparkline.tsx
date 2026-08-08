// Type-level test: the declarations compile against react-x11's JSX
// namespace, both as a component and as the raw element the module
// augmentation adds.
import { Sparkline } from '../../src/index.js';
import type { SparklineProps } from '../../src/index.js';

export const asComponent = (
  <box style={{ flexGrow: 1 }}>
    <Sparkline
      data={[1, 4, 2, 8]}
      color="#c0392b"
      strokeWidth={2}
      style={{ width: 120, height: 40 }}
    />
  </box>
);

// `import`ing the component teaches JSX the element too
export const asElement = <sparkline data={[1, 2, 3]} style={{ width: 60 }} />;

export const props: SparklineProps = { data: [1, 2, 3] };

// @ts-expect-error data is required
export const missingData = <Sparkline style={{ width: 10 }} />;

// @ts-expect-error a sparkline takes no children
export const withChildren = <Sparkline data={[1, 2]}>nope</Sparkline>;
