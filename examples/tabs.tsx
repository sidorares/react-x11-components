// Run with: npm run examples:tabs   (needs an X server / DISPLAY)
//
// A `<Tabs>` is composition, so everything interesting about it is what the
// composition lets an app say. Three panes:
//
//  - the five variants, on the same three tabs — one has a disabled trigger,
//    and `plain` shows what a `<TabsIndicator>` is for;
//  - the three sizes, and a `fitted` strip;
//  - the behaviours: panels that keep their state while hidden (type into
//    one, switch away and back), `unmountOnExit` giving it up, a strip on a
//    width you can drag so the overflow menu fills and empties, and a
//    vertical `manual` strip that selects on Enter/Space rather than as the
//    arrows move.
import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button, Icon, Slider, ThemeProvider, createRoot } from 'react-x11';

import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from '../src/index.js';
import type { TabsSize, TabsVariant } from '../src/index.js';

const VARIANTS: TabsVariant[] = [
  'line',
  'subtle',
  'enclosed',
  'outline',
  'plain',
];
const SIZES: TabsSize[] = ['sm', 'md', 'lg'];

/** A repository's own navigation, which is where the overflow menu's shape
 *  comes from. */
const NAV = [
  'Code',
  'Issues',
  'Pull requests',
  'Discussions',
  'Actions',
  'Projects',
  'Wiki',
];

function Caption({ children }: { children: ReactNode }): ReactElement {
  return <text style={{ fontSize: 11, color: '$textMuted' }}>{children}</text>;
}

/** The same three tabs every gallery entry shows. */
function Sample({
  variant,
  size,
  fitted,
}: {
  variant?: TabsVariant;
  size?: TabsSize;
  fitted?: boolean;
}): ReactElement {
  return (
    <Tabs
      defaultValue="members"
      variant={variant}
      size={size}
      fitted={fitted}
      // The gallery is about the variants; the pane below is where the
      // overflow menu has the floor.
      overflow="clip"
      style={{ flexGrow: 0, width: 300 }}
    >
      <TabsList>
        {/* `plain` draws nothing of its own; the indicator is its look */}
        {variant === 'plain' ? <TabsIndicator /> : null}
        <TabsTrigger value="members">
          <Icon name="dot" size={10} />
          Members
        </TabsTrigger>
        <TabsTrigger value="projects">Projects</TabsTrigger>
        <TabsTrigger value="tasks" disabled>
          Tasks
        </TabsTrigger>
      </TabsList>
      <TabsContent value="members">Manage your team members.</TabsContent>
      <TabsContent value="projects">Manage your projects.</TabsContent>
      <TabsContent value="tasks">Never shown — disabled.</TabsContent>
    </Tabs>
  );
}

/** A panel with state, so hiding versus unmounting is visible. */
function Counter({ label }: { label: string }): ReactElement {
  const [n, setN] = useState(0);
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Button onClick={() => setN((v) => v + 1)}>{label}</Button>
      <text>clicked {String(n)} times</text>
    </box>
  );
}

function KeptState(): ReactElement {
  return (
    <box style={{ gap: 4 }}>
      <Caption>
        default: a hidden panel keeps its state — click, switch away, return
      </Caption>
      <Tabs defaultValue="a" style={{ flexGrow: 0, width: 340 }}>
        <TabsList>
          <TabsTrigger value="a">Kept</TabsTrigger>
          <TabsTrigger value="b">Other</TabsTrigger>
        </TabsList>
        <TabsContent value="a">
          <Counter label="Count" />
        </TabsContent>
        <TabsContent value="b">Switch back — the count survives.</TabsContent>
      </Tabs>
      <Caption>unmountOnExit: the same panel, given up when it hides</Caption>
      <Tabs defaultValue="a" unmountOnExit style={{ flexGrow: 0, width: 340 }}>
        <TabsList>
          <TabsTrigger value="a">Forgotten</TabsTrigger>
          <TabsTrigger value="b">Other</TabsTrigger>
        </TabsList>
        <TabsContent value="a">
          <Counter label="Count" />
        </TabsContent>
        <TabsContent value="b">Switch back — the count is zero.</TabsContent>
      </Tabs>
    </box>
  );
}

/** Seven tabs on a width the slider moves, so the menu fills and empties.
 *  A real app resizes its window instead; this one is a strip in a pane. */
function Overflow(): ReactElement {
  const [width, setWidth] = useState(560);
  return (
    <box style={{ gap: 4 }}>
      <Caption>
        overflow: drag the width — the tabs that stop fitting go in the menu,
        and the selected one always keeps its place ({String(width)}px)
      </Caption>
      <Slider
        min={200}
        max={620}
        value={width}
        onChange={(ev) => setWidth(ev.value)}
        style={{ width: 340 }}
      />
      <Tabs defaultValue="code" style={{ flexGrow: 0, width }}>
        <TabsList>
          {NAV.map((label) => (
            <TabsTrigger key={label} value={label.toLowerCase()}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {NAV.map((label) => (
          <TabsContent key={label} value={label.toLowerCase()}>
            {label}, in a strip that may not have room for it.
          </TabsContent>
        ))}
      </Tabs>
    </box>
  );
}

function VerticalManual(): ReactElement {
  const [value, setValue] = useState('inbox');
  return (
    <box style={{ gap: 4 }}>
      <Caption>
        vertical + manual: arrows move focus, Enter or Space selects — and this
        one is controlled ({value})
      </Caption>
      <Tabs
        value={value}
        onValueChange={(e) => setValue(e.value)}
        orientation="vertical"
        activationMode="manual"
        variant="subtle"
        style={{ flexGrow: 0, width: 340, height: 130 }}
      >
        <TabsList>
          <TabsTrigger value="inbox">Inbox</TabsTrigger>
          <TabsTrigger value="drafts">Drafts</TabsTrigger>
          <TabsTrigger value="sent">Sent</TabsTrigger>
        </TabsList>
        <TabsContent value="inbox">Two unread messages.</TabsContent>
        <TabsContent value="drafts">One draft, half a sentence.</TabsContent>
        <TabsContent value="sent">Everything you regret.</TabsContent>
      </Tabs>
    </box>
  );
}

/** `colorScheme` is a seam for screenshots; by default it follows the
 *  desktop, which is what an example should do. */
function App({
  colorScheme = 'system',
}: {
  colorScheme?: 'light' | 'dark' | 'system';
}): ReactElement {
  return (
    <window width={1080} height={720} title="@react-x11/components — tabs">
      {/* The provider paints its own ground: a pinned scheme inside a window
          that follows the desktop would otherwise sit on the wrong colour. */}
      <ThemeProvider
        colorScheme={colorScheme}
        style={{ backgroundColor: '$background' }}
      >
        <box
          style={{ flexDirection: 'row', flexGrow: 1, padding: 20, gap: 32 }}
        >
          <box style={{ gap: 14 }}>
            <text
              style={{ fontSize: 12, fontWeight: 'bold', color: '$textMuted' }}
            >
              VARIANT
            </text>
            {VARIANTS.map((variant) => (
              <box key={variant} style={{ gap: 2 }}>
                <Caption>{variant}</Caption>
                <Sample variant={variant} />
              </box>
            ))}
          </box>
          <box style={{ gap: 14 }}>
            <text
              style={{ fontSize: 12, fontWeight: 'bold', color: '$textMuted' }}
            >
              SIZE
            </text>
            {SIZES.map((size) => (
              <box key={size} style={{ gap: 2 }}>
                <Caption>{size}</Caption>
                <Sample variant="enclosed" size={size} />
              </box>
            ))}
            <Caption>fitted: the triggers share the strip</Caption>
            <Sample variant="line" fitted />
          </box>
          <box style={{ gap: 18 }}>
            <text
              style={{ fontSize: 12, fontWeight: 'bold', color: '$textMuted' }}
            >
              BEHAVIOUR
            </text>
            <KeptState />
            <Overflow />
            <VerticalManual />
          </box>
        </box>
      </ThemeProvider>
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
