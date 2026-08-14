// Type-level test: the parts compile as JSX against react-x11's namespace,
// the two unions are closed (a typo in `size` or `variant` is an error, not a
// silent fallback), and every part takes the `style` and `data-testname` the
// package's conventions promise.
import React from 'react';
import { Icon } from 'react-x11';
import type { Style } from 'react-x11/style';

import {
  Timeline,
  TimelineConnector,
  TimelineContent,
  TimelineDescription,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from '../../src/index.js';
import type {
  TimelineIndicatorProps,
  TimelineProps,
  TimelineSize,
  TimelineVariant,
} from '../../src/index.js';

/** The shortest thing that works: prose in every slot. */
export const plain = (
  <Timeline>
    <TimelineItem>
      <TimelineConnector>
        <TimelineSeparator />
        <TimelineIndicator>1</TimelineIndicator>
      </TimelineConnector>
      <TimelineContent>
        <TimelineTitle>Product shipped</TimelineTitle>
        <TimelineDescription>13th May 2021</TimelineDescription>
      </TimelineContent>
    </TimelineItem>
  </Timeline>
);

/** Every root prop, and a glyph rather than a number in the mark. */
export const configured = (
  <Timeline
    size="lg"
    variant="outline"
    accent="$success"
    ground="$surface"
    showLastSeparator
    style={{ width: 320 }}
    data-testname="timeline"
  >
    <TimelineItem>
      <TimelineConnector>
        <TimelineIndicator>
          {/* the ink inherits; the size does not, so it is named */}
          <Icon name="check" size={12} />
        </TimelineIndicator>
        <TimelineSeparator />
      </TimelineConnector>
      <TimelineContent>
        <TimelineTitle>
          Delivered
          <text style={{ fontSize: 11, color: '$textMuted' }}>2 days ago</text>
        </TimelineTitle>
      </TimelineContent>
    </TimelineItem>
  </Timeline>
);

/** A step that overrides the timeline it is in. */
export const perStep = (
  <Timeline variant="solid">
    <TimelineItem>
      <TimelineConnector>
        <TimelineSeparator />
        <TimelineIndicator variant="outline" accent="$danger" color="$text">
          3
        </TimelineIndicator>
      </TimelineConnector>
      <TimelineContent style={[{ gap: 6 }, { paddingBottom: 24 }]}>
        <TimelineTitle>Failed</TimelineTitle>
      </TimelineContent>
    </TimelineItem>
  </Timeline>
);

/** The two unions are what an app switches on, so they are exported. */
export const sizes: TimelineSize[] = ['sm', 'md', 'lg', 'xl'];
export const variants: TimelineVariant[] = [
  'subtle',
  'solid',
  'outline',
  'plain',
];

/** A prop bag an app builds and spreads — the props are an interface, so it
 *  can be typed rather than inferred at the call site. */
export const rootProps: TimelineProps = { size: 'sm', variant: 'plain' };
export const dotProps: TimelineIndicatorProps = { accent: '#c0392b' };
export const spread = (
  <Timeline {...rootProps}>
    <TimelineItem>
      <TimelineConnector>
        <TimelineIndicator {...dotProps} />
      </TimelineConnector>
    </TimelineItem>
  </Timeline>
);

/** `style` takes the array form everywhere, as the rest of the package does. */
const bag: Style[] = [{ flexGrow: 1 }, { padding: 8 }];
export const styled = (
  <Timeline style={bag}>
    <TimelineItem style={{ gap: 20 }} data-testname="item">
      <TimelineConnector style={{ width: 24 }}>
        <TimelineSeparator style={{ backgroundColor: '$accent' }} />
        <TimelineIndicator style={{ borderRadius: 2 }}>1</TimelineIndicator>
      </TimelineConnector>
      <TimelineContent>
        <TimelineTitle style={{ fontSize: 16 }}>Square</TimelineTitle>
        <TimelineDescription style={{ color: '$danger' }}>
          overdue
        </TimelineDescription>
      </TimelineContent>
    </TimelineItem>
  </Timeline>
);

/** A timeline built from data, which is how one is normally written: the
 *  items are a mapped array and the root still knows which is last. */
const EVENTS = [
  { id: 'a', title: 'Ordered', when: '11th May' },
  { id: 'b', title: 'Shipped', when: '13th May' },
];

export function FromData(): React.ReactElement {
  return (
    <Timeline size="sm">
      {EVENTS.map((event, i) => (
        <TimelineItem key={event.id}>
          <TimelineConnector>
            <TimelineSeparator />
            <TimelineIndicator>{i + 1}</TimelineIndicator>
          </TimelineConnector>
          <TimelineContent>
            <TimelineTitle>{event.title}</TimelineTitle>
            <TimelineDescription>{event.when}</TimelineDescription>
          </TimelineContent>
        </TimelineItem>
      ))}
    </Timeline>
  );
}

// @ts-expect-error — the size union is closed
export const badSize = <Timeline size="huge" />;
// @ts-expect-error — and so is the variant union
export const badVariant = <Timeline variant="ghost" />;
