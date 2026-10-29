// A value drawn as a tree: an object or an array that opens a level at a
// time, each property its name and its value in a type's colour. The
// console draws what it came to so, its levels read from the page's realm
// as they are opened (`HtmlHandle.inspectValue`), and the network's preview
// draws a JSON response so, from the parsed text.
import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useTheme } from 'react-x11';
import type { Theme } from 'react-x11';

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
      load: () => entries.map(([k, v]) => jsonValue(v, `${key}.${k}`, k)),
    };
  }
  return {
    key,
    name,
    type: typeof value,
    text: typeof value === 'string' ? JSON.stringify(value) : String(value),
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

/**
 * A value's tree. Its levels are read once, as they are first opened, and
 * kept for the tree's life: the page's realm keeps what it described only
 * so long, and an object read again may have changed since, as in a
 * browser's console, which shows an object as it was when opened.
 */
export function ValueTree({
  root,
  fontSize = 12,
}: {
  root: ValueNode;
  fontSize?: number;
}): ReactElement {
  const theme = useTheme();
  const [expanded, setExpanded] = useState<readonly string[]>([]);
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
  const items = useMemo(() => [root], [root]);
  return (
    <Tree<ValueNode>
      items={items}
      {...accessors}
      expanded={expanded}
      onExpandedChange={(ids) => setExpanded(ids as string[])}
      indent={12}
      rowHeight={16}
      virtual={false}
      renderLabel={(state: TreeRowState<ValueNode>) => (
        <text
          style={{
            fontFamily: '$monoFamily',
            fontSize,
            textWrap: 'nowrap',
            maxLines: 1,
            textOverflow: 'ellipsis',
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
            {state.item.text}
          </text>
        </text>
      )}
      styles={{
        row: { paddingTop: 0, paddingBottom: 0, gap: 2 },
        label: { textWrap: 'nowrap' },
      }}
      style={{ flexGrow: 0, overflow: 'visible', minHeight: 0 }}
    />
  );
}
