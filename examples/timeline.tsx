// Run with: npm run examples:timeline   (needs an X server / DISPLAY)
//
// A `<Timeline>` is composition, so everything interesting about it is what
// the composition lets an app say. Three panes:
//
//  - a live release pipeline, where the step that is running, the ones that
//    are done and the one that failed each pick their own variant and accent;
//  - the four sizes, side by side;
//  - the four variants, on the same three steps.
//
// Press the button (or Space on it) to run the pipeline forward.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Icon, createRoot } from 'react-x11';

import {
  Timeline,
  TimelineConnector,
  TimelineContent,
  TimelineDescription,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from '../src/index.js';
import type { TimelineSize, TimelineVariant } from '../src/index.js';

// The command each stage runs, so the detail line says the same thing
// whether the stage is queued, running or finished — the status is the
// description's job.
const STAGES = [
  { title: 'Checkout', detail: 'git fetch --depth=1' },
  { title: 'Install', detail: 'npm ci' },
  { title: 'Build', detail: 'tsc -p tsconfig.build.json' },
  { title: 'Test', detail: 'tsx --test test/*.test.ts' },
  { title: 'Publish', detail: 'npm publish --provenance' },
];

/** The stage that blows up the first time it is reached, so the danger accent
 *  has something to be about. */
const FAILS_AT = 3;

/** How far the pipeline has run, and whether the step it is on blew up. */
interface Run {
  at: number;
  failed: boolean;
}

function stageLook(
  run: Run,
  i: number,
): {
  variant: TimelineVariant;
  accent?: string;
  icon?: 'check' | 'close';
  label: string;
} {
  if (i < run.at)
    return { variant: 'solid', accent: '$success', icon: 'check', label: '' };
  if (i > run.at) return { variant: 'outline', label: String(i + 1) };
  return run.failed
    ? { variant: 'solid', accent: '$danger', icon: 'close', label: '' }
    : { variant: 'solid', label: String(i + 1) };
}

function Pipeline(): ReactElement {
  const [run, setRun] = useState<Run>({ at: 0, failed: false });
  const done = run.at >= STAGES.length;

  return (
    <box style={{ gap: 12, width: 300 }}>
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <text style={{ fontSize: 15, fontWeight: 'bold', color: '$text' }}>
          Release 0.2.0
        </text>
        <box style={{ flexGrow: 1 }} />
        <Button
          onClick={() =>
            setRun((r) =>
              r.at >= STAGES.length
                ? { at: 0, failed: false }
                : r.failed
                  ? // a failed stage is retried where it stands, so the
                    // danger accent gives way to the accent again
                    { at: r.at, failed: false }
                  : { at: r.at + 1, failed: r.at + 1 === FAILS_AT },
            )
          }
        >
          {done ? 'Run again' : run.failed ? 'Retry' : 'Advance'}
        </Button>
      </box>

      <Timeline>
        {STAGES.map((stage, i) => {
          const look = stageLook(run, i);
          return (
            <TimelineItem key={stage.title}>
              <TimelineConnector>
                <TimelineSeparator />
                <TimelineIndicator variant={look.variant} accent={look.accent}>
                  {look.icon ? (
                    // `size` does not inherit and has to be named; the ink
                    // does inherit, and the indicator has already set it.
                    <Icon name={look.icon} size={12} />
                  ) : (
                    look.label
                  )}
                </TimelineIndicator>
              </TimelineConnector>
              <TimelineContent>
                <TimelineTitle>{stage.title}</TimelineTitle>
                <TimelineDescription>
                  {i < run.at
                    ? 'done'
                    : i === run.at
                      ? run.failed
                        ? 'failed'
                        : 'running…'
                      : 'queued'}
                </TimelineDescription>
                <text style={{ fontSize: 12, color: '$textMuted' }}>
                  {stage.detail}
                </text>
              </TimelineContent>
            </TimelineItem>
          );
        })}
      </Timeline>
    </box>
  );
}

/** Two steps, at one size — the row the size demo repeats. */
function Sample({
  size,
  variant,
}: {
  size?: TimelineSize;
  variant?: TimelineVariant;
}): ReactElement {
  return (
    <Timeline size={size} variant={variant}>
      <TimelineItem>
        <TimelineConnector>
          <TimelineSeparator />
          <TimelineIndicator>
            <Icon name="check" size={size === 'sm' ? 9 : 12} />
          </TimelineIndicator>
        </TimelineConnector>
        <TimelineContent>
          <TimelineTitle>Product shipped</TimelineTitle>
          <TimelineDescription>13th May 2021</TimelineDescription>
        </TimelineContent>
      </TimelineItem>
      <TimelineItem>
        <TimelineConnector>
          <TimelineSeparator />
          <TimelineIndicator>2</TimelineIndicator>
        </TimelineConnector>
        <TimelineContent>
          <TimelineTitle>Order delivered</TimelineTitle>
          <TimelineDescription>15th May 2021</TimelineDescription>
        </TimelineContent>
      </TimelineItem>
    </Timeline>
  );
}

const SIZES: TimelineSize[] = ['sm', 'md', 'lg', 'xl'];
const VARIANTS: TimelineVariant[] = ['subtle', 'solid', 'outline', 'plain'];

function Gallery({ title, of }: { title: string; of: string[] }): ReactElement {
  return (
    <box style={{ gap: 10 }}>
      <text style={{ fontSize: 12, fontWeight: 'bold', color: '$textMuted' }}>
        {title}
      </text>
      {of.map((name) => (
        <box key={name} style={{ gap: 4 }}>
          <text style={{ fontSize: 11, color: '$textMuted' }}>{name}</text>
          {title === 'SIZE' ? (
            <Sample size={name as TimelineSize} />
          ) : (
            <Sample variant={name as TimelineVariant} />
          )}
        </box>
      ))}
    </box>
  );
}

function App(): ReactElement {
  return (
    <window width={980} height={640} title="@react-x11/components — timeline">
      <box
        style={{
          flexDirection: 'row',
          flexGrow: 1,
          padding: 20,
          gap: 28,
        }}
      >
        <Pipeline />
        <Gallery title="SIZE" of={SIZES} />
        <Gallery title="VARIANT" of={VARIANTS} />
      </box>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
