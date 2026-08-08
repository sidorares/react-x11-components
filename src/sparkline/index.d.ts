import type { ReactElement } from 'react';
import type { Style } from 'react-x11/style';

export interface SparklineProps {
  /** The series. Fewer than two points draws nothing. */
  data: number[];
  /** Stroke colour. Falls back to `style.color`, then black. */
  color?: string;
  /** Pen width in pixels. Default `1`. */
  strokeWidth?: number;
  /** No intrinsic size — give it a width and a height. */
  style?: Style | Style[];
}

export declare function Sparkline(props: SparklineProps): ReactElement;

/** The host element name, for apps that would rather write `<sparkline>`. */
export declare const SPARKLINE_ELEMENT: 'sparkline';

// Importing this module teaches JSX the element too, so `<sparkline>` is a
// typed tag and not an error. This is the module-augmentation shape
// react-x11's docs/typescript.md prescribes for a third-party element.
declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      sparkline: SparklineProps;
    }
  }
}
