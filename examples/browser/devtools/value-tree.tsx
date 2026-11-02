// A value drawn as a tree: an object or an array that opens a level at a
// time, each property its name and its value in a type's colour. The
// console draws what it came to so, its levels read from the page's realm
// as they are opened (`HtmlHandle.inspectValue`), the network's preview
// draws a JSON response so, from the parsed text, and the browser draws so
// a JSON or an XML document navigated to (`viewers.tsx`).
import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useTheme } from 'react-x11';
import type { Theme } from 'react-x11';
import type { AnyNode, Element as XmlElement } from 'domhandler';

import { Tree } from '../../../src/tree/index.js';
import type { TreeRowState } from '../../../src/tree/index.js';
import { isDarkBackground } from '../../../src/code-language/theme.js';
import type { ConsoleValue, HtmlHandle } from '../../../src/html/index.js';

/** One row of a value's tree. */
export interface ValueNode {
  /** Unique in its tree: the path of names from the root. */
  key: string;
  /** The property's name; null for the root. */
  name: string | null;
  /** What kind of value: `string`, `number`, `object`, `array`, … */
  type: string;
  text: string;
  /** A property that is not enumerable, drawn fainter. */
  faint?: boolean;
  /** Its properties, read when it is first opened. */
  load?: () => readonly ValueNode[];
}

/** A value the page's realm described, its levels read as they open. */
export function remoteValue(
  handle: HtmlHandle,
  value: ConsoleValue,
  key = 'root',
  name: string | null = null,
  faint = false,
): ValueNode {
  const id = value.id;
  return {
    key,
    name,
    type: value.type,
    text: value.text,
    faint,
    ...(id !== undefined &&
      value.type !== 'function' && {
        load: () =>
          (handle.inspectValue(id) ?? []).map((p) =>
            remoteValue(
              handle,
              p.value,
              `${key}.${p.name}`,
              p.name,
              !p.enumerable,
            ),
          ),
      }),
  };
}

/** How long a summary of an object's properties runs. */
const SUMMARY = 80;

/** A parsed JSON value as a tree. */
export function jsonValue(
  value: unknown,
  key = 'root',
  name: string | null = null,
): ValueNode {
  if (value === null) return { key, name, type: 'null', text: 'null' };
  if (Array.isArray(value)) {
    return {
      key,
      name,
      type: 'array',
      text: `(${value.length}) [${summary(value)}]`,
      load: () =>
        value.map((item, i) => jsonValue(item, `${key}.${i}`, String(i))),
    };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      key,
      name,
      type: 'object',
      text: `{${summary(entries.map(([k, v]) => `${k}: ${short(v)}`))}}`,
      // by place and not by name: `a.b` beside an `a` holding a `b` is one
      // path, and two rows of one id are one row to `<Tree>`
      load: () => entries.map(([k, v], i) => jsonValue(v, `${key}.${i}`, k)),
    };
  }
  return {
    key,
    name,
    type: typeof value,
    text: typeof value === 'string' ? JSON.stringify(value) : String(value),
  };
}

/** What of an element a row shows of its text: it is read, or it is noise. */
function xmlChildren(element: XmlElement): AnyNode[] {
  return element.children.filter(
    (node) => node.type !== 'text' || node.data.trim(),
  );
}

/** An XML node as a tree: an element its tag and attributes, opening on what
 *  it holds, and one holding only text that text on its own row. */
export function xmlValue(node: AnyNode, key = 'root'): ValueNode {
  if (node.type === 'text') {
    return { key, name: null, type: 'string', text: node.data.trim() };
  }
  if (node.type === 'comment') {
    return { key, name: null, type: 'more', text: `<!--${node.data}-->` };
  }
  if (node.type === 'cdata') {
    const text = node.children
      .map((child) => (child.type === 'text' ? child.data : ''))
      .join('');
    return { key, name: null, type: 'string', text };
  }
  if (node.type !== 'tag') {
    const text = node.type === 'directive' ? `<${node.data}>` : '';
    return { key, name: null, type: 'more', text };
  }
  const tag =
    node.name +
    Object.entries(node.attribs)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join('');
  const held = xmlChildren(node);
  if (!held.length) {
    return { key, name: null, type: 'node', text: `<${tag}/>` };
  }
  const only = held.length === 1 ? held[0] : null;
  if (only?.type === 'text') {
    const text = `<${tag}>${only.data.trim()}</${node.name}>`;
    return { key, name: null, type: 'node', text };
  }
  return {
    key,
    name: null,
    type: 'node',
    text: `<${tag}>`,
    load: () => held.map((child, i) => xmlValue(child, `${key}.${i}`)),
  };
}

function short(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === 'object') return '{…}';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function summary(items: readonly unknown[]): string {
  const text = items
    .map((item) => (typeof item === 'string' ? item : short(item)))
    .join(', ');
  return text.length > SUMMARY ? `${text.slice(0, SUMMARY)}…` : text;
}

/** The colour a type of value is drawn in, as a browser's console has it. */
function inkOf(type: string, theme: Theme): string {
  const dark = isDarkBackground(theme.background);
  switch (type) {
    case 'string':
      return dark ? '#f28b54' : '#c41a16';
    case 'number':
    case 'bigint':
      return dark ? '#9980ff' : '#1c00cf';
    case 'boolean':
    case 'null':
    case 'undefined':
    case 'symbol':
      return dark ? '#7ab3e8' : '#0d22aa';
    case 'function':
      return dark ? '#9bbbdc' : '#994500';
    case 'node':
      return dark ? '#5db0d7' : '#881280';
    case 'accessor':
    case 'more':
      return theme.textMuted;
    case 'error':
      return theme.danger;
    default:
      return theme.text;
  }
}

/** The most of a value a row sets. */
const MOST_TEXT = 4000;

/** The longest run a row that wraps keeps whole. Core's text breaks only
 *  where a line may, and a token, a hash or a data URL has nowhere to: it
 *  would stand out of the pane, and take the pane's width with it. */
const LONGEST_RUN = /\S{48}/g;

/** How many rows a document's tree comes to at first. */
const FIRST_ROWS = 200;

/** A value's text as a row sets it. */
function shownText(text: string, fills: boolean): string {
  const cut = text.length > MOST_TEXT ? `${text.slice(0, MOST_TEXT)}…` : text;
  return fills ? cut.replace(LONGEST_RUN, '$&\u200b') : cut;
}

/**
 * What a document's tree opens with: as many levels from the top as fit in
 * `rows`, a small file whole, and of a large one its top. The root is always
 * open: a tree of one closed row is a tree nobody asked for.
 */
function openedAtFirst(
  root: ValueNode,
  childrenOf: (node: ValueNode) => readonly ValueNode[] | undefined,
  rows: number,
): string[] {
  const opened: string[] = [];
  const queue = [root];
  let shown = 1;
  for (const node of queue) {
    const children = childrenOf(node);
    if (!children) continue;
    if (opened.length && shown + children.length > rows) break;
    shown += children.length;
    opened.push(node.key);
    if (shown <= rows) queue.push(...children);
  }
  return opened;
}

/**
 * A value's tree. Its levels are read once, as they are first opened, and
 * kept for the tree's life: the page's realm keeps what it described only
 * so long, and an object read again may have changed since, as in a
 * browser's console, which shows an object as it was when opened.
 *
 * A panel's tree is as tall as its open rows, in something that scrolls for
 * it. One that `fills` what it is in is a document: it scrolls itself,
 * builds only the rows on screen, opens as far as `FIRST_ROWS` goes and
 * wraps a long value, which nothing else would show.
 */
export function ValueTree({
  root,
  fontSize = 12,
  fills = false,
}: {
  root: ValueNode;
  fontSize?: number;
  fills?: boolean;
}): ReactElement {
  const theme = useTheme();
  // what each node's level came to, read on first opening
  const accessors = useMemo(() => {
    const read = new Map<string, readonly ValueNode[]>();
    return {
      getId: (n: ValueNode) => n.key,
      getText: (n: ValueNode) => n.name ?? n.text,
      isBranch: (n: ValueNode) => !!n.load,
      getChildren: (n: ValueNode) => {
        if (!n.load) return undefined;
        let children = read.get(n.key);
        if (!children) {
          children = n.load();
          read.set(n.key, children);
        }
        return children;
      },
    };
  }, [root]);
  const [expanded, setExpanded] = useState<readonly string[]>(() =>
    fills ? openedAtFirst(root, accessors.getChildren, FIRST_ROWS) : [],
  );
  const items = useMemo(() => [root], [root]);
  return (
    <Tree<ValueNode>
      items={items}
      {...accessors}
      expanded={expanded}
      onExpandedChange={(ids) => setExpanded(ids as string[])}
      indent={12}
      rowHeight={fills ? 20 : 16}
      virtual={fills ? 'auto' : false}
      renderLabel={(state: TreeRowState<ValueNode>) => (
        <text
          style={{
            fontFamily: '$monoFamily',
            fontSize,
            ...(!fills && {
              textWrap: 'nowrap',
              maxLines: 1,
              textOverflow: 'ellipsis',
            }),
          }}
        >
          {state.item.name !== null ? (
            <text
              style={{
                color: state.selected
                  ? state.color
                  : isDarkBackground(theme.background)
                    ? '#c58af9'
                    : '#881391',
                ...(state.item.faint && { color: theme.textMuted }),
              }}
            >
              {`${state.item.name}: `}
            </text>
          ) : null}
          <text
            style={{
              color: state.selected
                ? state.color
                : inkOf(state.item.type, theme),
              ...(state.item.type === 'function' && { fontStyle: 'italic' }),
            }}
          >
            {shownText(state.item.text, fills)}
          </text>
        </text>
      )}
      styles={{
        row: { paddingTop: 0, paddingBottom: 0, gap: 2 },
        label: fills ? { flexShrink: 1 } : { textWrap: 'nowrap' },
      }}
      style={
        fills
          ? { padding: 8 }
          : { flexGrow: 0, overflow: 'visible', minHeight: 0 }
      }
    />
  );
}
