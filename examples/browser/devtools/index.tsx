// The browser's developer tools: an Elements panel and a Console, docked
// under the page in the tab's own process.
//
// They live in the page's process rather than the browser's because that
// is where the document is. `<Html>`'s handle is the live DOM and answers a
// rect, a computed style and a line of JavaScript at once, where tools in
// the browser's process would need every one of those asked over the
// pane's one-way messages, as a browser's remote debugging protocol asks
// them. What the browser keeps is whether a tab's tools are open and which
// panel was asked for, so its menu bar can say so; the page tells it when
// they open from its own menu (Inspect) or close from their own button.
//
// Made of this package's components and core's, and nothing drawn in HTML:
// `<Tabs>` for the strip, `<Tree>` for the document, `<Table>` for the
// computed style, `<CodeEditor>` for the prompt, core's `<SplitPane>`
// between the tree and the sidebar. They are meant to be what finds where
// `<Html>`, and those components, fall short.
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Icon, useTheme } from 'react-x11';

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../../src/tabs/index.js';
import type { HtmlHandle } from '../../../src/html/index.js';
import { ConsolePanel } from './console.js';
import { ElementsPanel, PANEL_CONTENT } from './elements.js';
import { useStore } from './model.js';
import type { ConsoleLog, DevtoolsPanel, Inspection } from './model.js';

export type { DevtoolsPanel } from './model.js';

export interface DevToolsProps {
  /** The handle of the document the tab shows. */
  handle: HtmlHandle;
  /** Which document that is: a new one is a new tree. */
  docKey: number;
  inspection: Inspection;
  log: ConsoleLog;
  /** The panel the browser asked for last, and a count of its asks: each
   *  new one shows that panel. */
  panel: DevtoolsPanel;
  ask: number;
  onClose: () => void;
}

export function DevTools({
  handle,
  docKey,
  inspection,
  log,
  panel,
  ask,
  onClose,
}: DevToolsProps): ReactElement {
  const [tab, setTab] = useState<string>(panel);
  useEffect(() => setTab(panel), [ask]);
  const picking = useStore(inspection.picking);
  return (
    <Tabs
      value={tab}
      onValueChange={(e) => setTab(e.value)}
      variant="line"
      size="sm"
      ground="$background"
      style={{ flexGrow: 1, minHeight: 0 }}
    >
      <TabsList
        style={{
          paddingLeft: 4,
          paddingRight: 4,
          backgroundColor: '$surface',
          alignItems: 'center',
        }}
      >
        <Button
          variant={picking ? 'solid' : 'ghost'}
          size="small"
          aria-label={
            picking
              ? 'Stop choosing an element'
              : 'Choose an element in the page to inspect it'
          }
          onPress={() => {
            inspection.picking.set(!picking);
            setTab('elements');
          }}
        >
          <PickGlyph active={picking} />
        </Button>
        <TabsTrigger value="elements">Elements</TabsTrigger>
        <TabsTrigger value="console">Console</TabsTrigger>
        <box style={{ flexGrow: 1 }} />
        <Button
          variant="ghost"
          size="small"
          aria-label="Close the developer tools"
          onPress={onClose}
        >
          <Icon name="close" size={9} />
        </Button>
      </TabsList>
      <TabsContent value="elements" style={PANEL_CONTENT}>
        <ElementsPanel
          handle={handle}
          docKey={docKey}
          inspection={inspection}
          shown={tab === 'elements'}
        />
      </TabsContent>
      <TabsContent value="console" style={PANEL_CONTENT}>
        <ConsolePanel
          handle={handle}
          log={log}
          shown={tab === 'console'}
          focusSeq={panel === 'console' ? ask : 0}
        />
      </TabsContent>
    </Tabs>
  );
}

/** The picker's glyph: an arrow over a box, a browser's "select an element
 *  in the page". A noun, drawn here, as AGENTS.md has it for this package. */
function PickGlyph({ active }: { active: boolean }): ReactElement {
  const theme = useTheme();
  const ink = active ? theme.accent : theme.text;
  return (
    <canvas
      style={{ width: 14, height: 14 }}
      onDraw={(ctx, info) => {
        const s = info.width / 14;
        ctx.strokeStyle = ink;
        ctx.fillStyle = ink;
        ctx.lineWidth = 1.2 * info.scale;
        // the box, open where the arrow comes out of it
        ctx.beginPath();
        ctx.moveTo(7 * s, 11.5 * s);
        ctx.lineTo(1.5 * s, 11.5 * s);
        ctx.lineTo(1.5 * s, 1.5 * s);
        ctx.lineTo(11.5 * s, 1.5 * s);
        ctx.lineTo(11.5 * s, 7 * s);
        ctx.stroke();
        // the arrow
        ctx.beginPath();
        ctx.moveTo(6 * s, 6 * s);
        ctx.lineTo(13.5 * s, 9 * s);
        ctx.lineTo(10 * s, 10 * s);
        ctx.lineTo(9 * s, 13.5 * s);
        ctx.closePath();
        ctx.fill();
      }}
    />
  );
}

export default DevTools;
