// The Elements panel: the document as a tree, the path to the element
// chosen, and beside them what the element's box came to and the style it
// was computed with.
//
// Everything here is read from `<Html>`'s handle — the live DOM, and the
// element's rect and computed style, each laid out first — so a page whose
// scripts change it is shown as it is the next time the panel reads it,
// which it does each second while it shows (`useTicks`). Nothing is copied
// out of the document: the tree's accessors read domhandler's nodes as
// they stand, and a row is keyed by its node (`nodeId`), so a branch open
// stays open whatever its siblings do.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { SplitPane, useTheme } from 'react-x11';

import { Tree } from '../../../src/tree/index.js';
import type { TreeHandle, TreeRowState } from '../../../src/tree/index.js';
import { Table } from '../../../src/table/index.js';
import type { TableColumn } from '../../../src/table/index.js';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../../src/tabs/index.js';
import type { Element, HtmlHandle } from '../../../src/html/index.js';
import { syntaxColours } from './colours.js';
import { AttributesPane } from './attributes.js';
import {
  BOX_COLOURS,
  boxModelOf,
  childrenOf,
  initialExpanded,
  isBranch,
  labelOf,
  nodeId,
  pathTo,
  printPx,
  selectorOf,
  textOf,
  useStore,
} from './model.js';
import type {
  BoxModel,
  DomNode,
  Inspection,
  LabelPart,
  Sides,
} from './model.js';

const MONO = { fontFamily: '$monoFamily', fontSize: 12 } as const;

/** How often an open panel reads the document again. */
const TICK_MS = 1000;

/** A count that goes up each `ms` while `on`: what a panel reads the
 *  document again on. */
export function useTicks(on: boolean, ms = TICK_MS): number {
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTicks((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [on, ms]);
  return ticks;
}

// --- the tree -----------------------------------------------------------------

// the accessors, once: the tree flattens again when one is new
const getId = (node: DomNode) => nodeId(node);
const getText = (node: DomNode) => textOf(node);

function DomTree({
  handle,
  docKey,
  inspection,
  tick,
}: {
  handle: HtmlHandle;
  docKey: number;
  inspection: Inspection;
  tick: number;
}): ReactElement {
  const theme = useTheme();
  const colours = useMemo(() => syntaxColours(theme), [theme]);
  const tree = useRef<TreeHandle<DomNode>>(null);
  const doc = handle.document;
  const selected = useStore(inspection.selected);
  const revealed = useStore(inspection.revealed);
  const edited = useStore(inspection.edited);

  // a document the tab shows anew opens on its `<html>` and `<body>`
  const [expanded, setExpanded] = useState<readonly number[]>([]);
  const opened = useRef<object | null>(null);
  if (doc && opened.current !== doc) {
    opened.current = doc;
    setExpanded(initialExpanded(doc));
  }

  // what the page asked the tree to show — an Inspect, a pick — opened to
  const want = useRef(0);
  useEffect(() => {
    if (!revealed || revealed === want.current) return;
    want.current = revealed;
    const node = inspection.selected.value;
    if (!node) return;
    const path = pathTo(node);
    setExpanded((was) => [...new Set([...was, ...path.slice(0, -1)])]);
    // once the rows are there
    setTimeout(() => tree.current?.scrollToItem(nodeId(node)), 0);
  }, [revealed]);

  // the roots read again at every tick, which reads every open branch again
  const items = useMemo(
    () => (doc ? (childrenOf(doc) ?? []) : []),
    [doc, docKey, tick, edited],
  );

  return (
    <Tree<DomNode>
      ref={tree}
      aria-label="Document"
      items={items}
      getId={getId}
      getText={getText}
      getChildren={childrenOf}
      isBranch={isBranch}
      expanded={expanded}
      onExpandedChange={(ids) => setExpanded(ids as number[])}
      selected={selected ? nodeId(selected) : null}
      onSelect={(_id, node) => inspection.selected.set(node)}
      indent={12}
      rowHeight={18}
      onMouseLeave={() => inspection.hovered.set(null)}
      renderLabel={(state: TreeRowState<DomNode>) => (
        <RowLabel state={state} colours={colours} inspection={inspection} />
      )}
      styles={{
        row: { paddingTop: 1, paddingBottom: 1, gap: 2 },
        label: { textWrap: 'nowrap', maxLines: 1, textOverflow: 'ellipsis' },
      }}
      style={{ flexGrow: 1, minHeight: 0, paddingTop: 4 }}
    />
  );
}

function RowLabel({
  state,
  colours,
  inspection,
}: {
  state: TreeRowState<DomNode>;
  colours: Record<LabelPart['kind'], string>;
  inspection: Inspection;
}): ReactElement {
  const node = state.item;
  const parts = labelOf(node, state.open);
  // on the selected row the wash is the accent, and the row's ink is what
  // reads on it
  const ink = (kind: LabelPart['kind']) =>
    state.selected ? state.color : colours[kind];
  return (
    <box
      style={{ flexShrink: 1, minWidth: 0 }}
      onMouseEnter={() =>
        inspection.hovered.set(
          node.type === 'tag' || node.type === 'script' || node.type === 'style'
            ? (node as Element)
            : null,
        )
      }
    >
      <text
        style={{
          ...MONO,
          textWrap: 'nowrap',
          maxLines: 1,
          textOverflow: 'ellipsis',
        }}
      >
        {parts.map((part, i) => (
          <text key={i} style={{ color: ink(part.kind) }}>
            {part.text}
          </text>
        ))}
      </text>
    </box>
  );
}

/** `html › body › main.content › p`: the chosen element's ancestors, each
 *  a step up to choose. */
function Crumbs({ inspection }: { inspection: Inspection }): ReactElement {
  const selected = useStore(inspection.selected);
  const path: Element[] = [];
  for (let n: DomNode | null = selected; n; n = n.parent as DomNode | null) {
    if (n.type === 'tag' || n.type === 'script' || n.type === 'style') {
      path.unshift(n as Element);
    }
  }
  return (
    <box
      style={{
        flexDirection: 'row',
        flexShrink: 0,
        height: 22,
        alignItems: 'center',
        gap: 2,
        paddingLeft: 6,
        paddingRight: 6,
        borderTopWidth: 1,
        borderColor: '$border',
        backgroundColor: '$surface',
        overflow: 'hidden',
      }}
    >
      {path.map((element, i) => (
        <box
          key={nodeId(element)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexShrink: i === path.length - 1 ? 0 : 1,
            minWidth: 0,
          }}
        >
          {i ? (
            <text style={{ ...MONO, color: '$textMuted' }}>{' › '}</text>
          ) : null}
          <box
            role="button"
            onClick={() => inspection.reveal(element)}
            onMouseEnter={() => inspection.hovered.set(element)}
            onMouseLeave={() => inspection.hovered.set(null)}
            style={{
              paddingLeft: 3,
              paddingRight: 3,
              borderRadius: 3,
              cursor: 'pointer',
              minWidth: 0,
              flexShrink: 1,
              ...(i === path.length - 1 && {
                backgroundColor: '$surfaceHover',
              }),
            }}
          >
            <text
              style={{
                ...MONO,
                color: '$text',
                textWrap: 'nowrap',
                maxLines: 1,
                textOverflow: 'ellipsis',
              }}
            >
              {selectorOf(element)}
            </text>
          </box>
        </box>
      ))}
    </box>
  );
}

// --- the sidebar ----------------------------------------------------------------

/** What the sidebar shows of the chosen element, read once a tick. */
interface Inspected {
  element: Element;
  style: Record<string, string> | null;
  rect: { x: number; y: number; width: number; height: number } | null;
  offset: { parent: Element | null; left: number; top: number } | null;
}

function inspect(handle: HtmlHandle, element: Element): Inspected {
  const offset = handle.offsetRect(element);
  return {
    element,
    style: handle.computedStyle(element),
    rect: handle.elementRect(element),
    offset: offset && {
      parent: offset.parent,
      left: offset.x,
      top: offset.y,
    },
  };
}

function Sidebar({
  handle,
  inspection,
  tick,
}: {
  handle: HtmlHandle;
  inspection: Inspection;
  tick: number;
}): ReactElement {
  const selected = useStore(inspection.selected);
  const element =
    selected &&
    (selected.type === 'tag' ||
      selected.type === 'script' ||
      selected.type === 'style')
      ? (selected as Element)
      : null;
  const [tab, setTab] = useState('attributes');
  const edited = useStore(inspection.edited);
  const read = useMemo(
    () => (element && handle.document ? inspect(handle, element) : null),
    [element, tick, edited],
  );
  return (
    <Tabs
      value={tab}
      onValueChange={(e) => setTab(e.value)}
      size="sm"
      ground="$background"
      style={{ flexGrow: 1, minHeight: 0, minWidth: 0 }}
    >
      <TabsList style={{ paddingLeft: 6, backgroundColor: '$surface' }}>
        <TabsTrigger value="attributes">Attributes</TabsTrigger>
        <TabsTrigger value="styles">Styles</TabsTrigger>
        <TabsTrigger value="layout">Layout</TabsTrigger>
      </TabsList>
      <TabsContent value="attributes" style={PANEL_CONTENT}>
        {element ? (
          <AttributesPane
            handle={handle}
            inspection={inspection}
            element={element}
          />
        ) : (
          <Nothing />
        )}
      </TabsContent>
      <TabsContent value="styles" style={PANEL_CONTENT}>
        {read ? <StylesPane read={read} /> : <Nothing />}
      </TabsContent>
      <TabsContent value="layout" style={PANEL_CONTENT}>
        {read ? <LayoutPane read={read} /> : <Nothing />}
      </TabsContent>
    </Tabs>
  );
}

export const PANEL_CONTENT = {
  paddingTop: 0,
  flexGrow: 1,
  flexShrink: 1,
  minHeight: 0,
} as const;

function Nothing(): ReactElement {
  return (
    <box style={{ padding: 12 }}>
      <text style={{ fontSize: 12, color: '$textMuted' }}>
        Choose an element in the tree, or with the picker, to see its box and
        its styles.
      </text>
    </box>
  );
}

// --- Styles ---------------------------------------------------------------------

interface StyleRow {
  id: string;
  value: string;
}

/** A computed value that is a colour, which the table draws a swatch for. */
const COLOUR = /^(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|color\()/i;

function StylesPane({ read }: { read: Inspected }): ReactElement {
  const [filter, setFilter] = useState('');
  const inline = useMemo(
    () => declarationsOf(read.element.attribs.style ?? ''),
    [read.element.attribs.style],
  );
  const rows = useMemo(() => {
    const all = Object.entries(read.style ?? {})
      .filter(([name]) => !name.startsWith('--'))
      .map(([id, value]): StyleRow => ({ id, value }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const q = filter.trim().toLowerCase();
    return q
      ? all.filter(
          (row) => row.id.includes(q) || row.value.toLowerCase().includes(q),
        )
      : all;
  }, [read.style, filter]);
  const columns = useMemo<TableColumn<StyleRow>[]>(
    () => [
      {
        id: 'id',
        label: 'Property',
        flex: 1,
        minWidth: 90,
        render: (row) => (
          <text
            style={{
              ...MONO,
              color: '$text',
              textWrap: 'nowrap',
              maxLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {row.id}
          </text>
        ),
      },
      {
        id: 'value',
        label: 'Value',
        flex: 1.4,
        minWidth: 90,
        render: (row) => <StyleValue value={row.value} />,
      },
    ],
    [],
  );
  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <box style={{ padding: 6, flexShrink: 0 }}>
        <textinput
          value={filter}
          placeholder="Filter"
          onChange={(ev) => setFilter(ev.value)}
          style={{
            height: 24,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: '$border',
            backgroundColor: '$background',
            fontSize: 12,
            color: '$text',
          }}
        />
      </box>
      {inline.length ? (
        <box
          style={{
            flexShrink: 0,
            paddingLeft: 10,
            paddingRight: 10,
            paddingBottom: 6,
            gap: 1,
          }}
        >
          <text style={{ ...MONO, color: '$textMuted' }}>
            {'element.style {'}
          </text>
          {inline.map(([name, value], i) => (
            <text key={i} style={MONO}>
              <text style={{ color: '#c80000' }}>{`  ${name}`}</text>
              <text style={{ color: '$text' }}>{`: ${value};`}</text>
            </text>
          ))}
          <text style={{ ...MONO, color: '$textMuted' }}>{'}'}</text>
        </box>
      ) : null}
      <Table<StyleRow>
        rows={rows}
        columns={columns}
        rowHeight={20}
        rowInset={0}
        selectionMode="none"
        style={{ flexGrow: 1, minHeight: 0 }}
      />
    </box>
  );
}

function StyleValue({ value }: { value: string }): ReactElement {
  return (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minWidth: 0,
      }}
    >
      {COLOUR.test(value) ? (
        <box
          style={{
            width: 10,
            height: 10,
            flexShrink: 0,
            borderWidth: 1,
            borderColor: '$border',
            backgroundColor: value,
          }}
        />
      ) : null}
      <text
        style={{
          ...MONO,
          color: '$text',
          textWrap: 'nowrap',
          maxLines: 1,
          textOverflow: 'ellipsis',
          flexShrink: 1,
        }}
      >
        {value}
      </text>
    </box>
  );
}

/** A `style` attribute's declarations, as written. */
function declarationsOf(style: string): [string, string][] {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const at = d.indexOf(':');
      return at < 0 ? [d, ''] : [d.slice(0, at).trim(), d.slice(at + 1).trim()];
    });
}

// --- Layout ---------------------------------------------------------------------

/** The properties the layout pane lists under the box. */
const LAYOUT_PROPERTIES = [
  'display',
  'position',
  'box-sizing',
  'float',
  'z-index',
  'overflow-x',
  'overflow-y',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'grid-template-columns',
  'font-family',
  'font-size',
  'line-height',
  'color',
  'background-color',
];

function LayoutPane({ read }: { read: Inspected }): ReactElement {
  const style = read.style ?? {};
  const box = read.rect ? boxModelOf(style, read.rect) : null;
  const facts: [string, string][] = [];
  if (read.rect) {
    const { x, y, width, height } = read.rect;
    facts.push([
      'rect',
      `${printPx(x)}, ${printPx(y)} — ${printPx(width)} × ${printPx(height)}`,
    ]);
  }
  if (read.offset) {
    facts.push([
      'offset',
      `${read.offset.parent ? selectorOf(read.offset.parent) : 'none'} + ${printPx(
        read.offset.left,
      )}, ${printPx(read.offset.top)}`,
    ]);
  }
  for (const name of LAYOUT_PROPERTIES) {
    const value = style[name];
    if (value === undefined) continue;
    if (
      name.startsWith('flex') ||
      name === 'justify-content' ||
      name === 'align-items'
    ) {
      if (!/flex/.test(style.display ?? '')) continue;
    }
    if (name === 'grid-template-columns' && !/grid/.test(style.display ?? '')) {
      continue;
    }
    facts.push([name, value]);
  }
  return (
    <box style={{ overflow: 'scroll', flexGrow: 1, minHeight: 0 }}>
      <box style={{ padding: 12, gap: 14, flexShrink: 0 }}>
        {box ? (
          <BoxDiagram box={box} />
        ) : (
          <text style={{ fontSize: 12, color: '$textMuted' }}>
            This element has no box: it is not rendered.
          </text>
        )}
        <box style={{ gap: 3 }}>
          {facts.map(([name, value]) => (
            <box key={name} style={{ flexDirection: 'row', gap: 8 }}>
              <text
                style={{
                  ...MONO,
                  color: '$textMuted',
                  width: 110,
                  flexShrink: 0,
                }}
              >
                {name}
              </text>
              <text style={{ ...MONO, color: '$text', flexShrink: 1 }}>
                {value}
              </text>
            </box>
          ))}
        </box>
      </box>
    </box>
  );
}

/** Margin, border, padding and content, one inside the other, each with
 *  its four lengths: the diagram a browser's Layout pane draws. */
function BoxDiagram({ box }: { box: BoxModel }): ReactElement {
  const content = (
    <box
      style={{
        backgroundColor: BOX_COLOURS.content,
        borderWidth: 1,
        borderColor: '#5c8a96',
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 4,
        paddingBottom: 4,
        alignItems: 'center',
      }}
    >
      <text style={{ ...MONO, color: '#222' }}>
        {`${printPx(box.width)} × ${printPx(box.height)}`}
      </text>
    </box>
  );
  const padding = (
    <Ring name="padding" sides={box.padding} colour={BOX_COLOURS.padding}>
      {content}
    </Ring>
  );
  const border = (
    <Ring name="border" sides={box.border} colour={BOX_COLOURS.border}>
      {padding}
    </Ring>
  );
  return (
    <box style={{ alignItems: 'center' }}>
      <Ring name="margin" sides={box.margin} colour={BOX_COLOURS.margin} dashed>
        {border}
      </Ring>
    </box>
  );
}

function Ring({
  name,
  sides,
  colour,
  dashed,
  children,
}: {
  name: string;
  sides: Sides;
  colour: string;
  dashed?: boolean;
  children: ReactElement;
}): ReactElement {
  const n = (v: number) => (v ? printPx(v) : '–');
  const label = { ...MONO, fontSize: 11, color: '#222' };
  return (
    <box
      style={{
        backgroundColor: colour,
        borderWidth: 1,
        borderColor: dashed ? '#b98a56' : '#222',
        paddingLeft: 6,
        paddingRight: 6,
        paddingTop: 2,
        paddingBottom: 4,
        alignItems: 'center',
      }}
    >
      <box style={{ flexDirection: 'row', alignSelf: 'stretch' }}>
        <text style={{ ...label, flexGrow: 1, flexBasis: 0 }}>{name}</text>
        <text style={label}>{n(sides.top)}</text>
        <box style={{ flexGrow: 1, flexBasis: 0 }} />
      </box>
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <text style={label}>{n(sides.left)}</text>
        {children}
        <text style={label}>{n(sides.right)}</text>
      </box>
      <text style={label}>{n(sides.bottom)}</text>
    </box>
  );
}

// --- the panel --------------------------------------------------------------------

export function ElementsPanel({
  handle,
  docKey,
  inspection,
  shown,
}: {
  handle: HtmlHandle;
  /** Which document the tab shows: a new one is a new tree. */
  docKey: number;
  inspection: Inspection;
  /** Whether the panel is the one in view, which it reads the document
   *  again only while it is. */
  shown: boolean;
}): ReactElement {
  const tick = useTicks(shown);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  // Narrower than this — the tools docked at a side — the sidebar goes
  // under the tree rather than beside it, as a browser's does.
  const stacked = room.width > 0 && room.width < STACK_BELOW;
  // The sidebar keeps its size as the tools grow, and the tree takes the
  // rest: `<SplitPane>` sizes its first pane, so that is worked out from
  // the panel's size, along whichever way it is split. Each way keeps its
  // own size, so a move to a side and back finds the one it left.
  const [sidebar, setSidebar] = useState({ width: 320, height: 240 });
  const along = stacked ? room.height : room.width;
  const kept = stacked ? sidebar.height : sidebar.width;
  const least = stacked ? 80 : 160;
  const leastSecond = stacked ? 100 : 200;
  const size = Math.max(least, along - DIVIDER - kept);
  return (
    <box
      style={{ flexGrow: 1, minHeight: 0 }}
      onLayout={(ev) => setRoom({ width: ev.width, height: ev.height })}
    >
      <SplitPane
        direction={stacked ? 'column' : 'row'}
        size={size}
        min={least}
        minSecond={leastSecond}
        onResize={(first) => {
          const second = Math.max(leastSecond, along - DIVIDER - first);
          setSidebar((was) =>
            stacked ? { ...was, height: second } : { ...was, width: second },
          );
        }}
      >
        <box style={{ flexGrow: 1, minHeight: 0, minWidth: 0 }}>
          <DomTree
            handle={handle}
            docKey={docKey}
            inspection={inspection}
            tick={tick}
          />
          <Crumbs inspection={inspection} />
        </box>
        <box
          style={{
            flexGrow: 1,
            minHeight: 0,
            minWidth: 0,
            borderColor: '$border',
            ...(stacked ? { borderTopWidth: 1 } : { borderLeftWidth: 1 }),
          }}
        >
          <Sidebar handle={handle} inspection={inspection} tick={tick} />
        </box>
      </SplitPane>
    </box>
  );
}

/** How narrow the panel is before its sidebar goes under the tree. */
const STACK_BELOW = 620;

/** `<SplitPane>`'s divider, which its first pane's size leaves room for. */
const DIVIDER = 6;
