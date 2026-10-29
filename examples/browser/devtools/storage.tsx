// The Storage panel: what the page's origin keeps — `localStorage`,
// `sessionStorage`, IndexedDB and cookies — in a tree, and what the one
// chosen holds in a table, with the entry chosen under it.
//
// It reads them where the tab's process keeps them: the profile's storage,
// which every tab shares and the next run finds (`profile.ts`), and the
// cookie jar the network sends with. So a value changed here is changed for
// the page and every tab of its origin, as it is in a browser's tools; the
// page hears of it as it would hear of another tab's change, a `storage`
// event, where the storage tells it. With no profile — a runtime without
// SQLite — the page's storage is its realm's own memory, and there is
// nothing here to read.
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button, Icon, SplitPane } from 'react-x11';

import { Table } from '../../../src/table/index.js';
import type { TableColumn } from '../../../src/table/index.js';
import { Tree } from '../../../src/tree/index.js';
import { domainMatch } from '../../../src/html/index.js';
import type {
  CookieJar,
  HtmlCookie,
  HtmlStorage,
} from '../../../src/html/index.js';
import { useTicks } from './elements.js';
import { ClearGlyph, TrashGlyph } from './glyphs.js';
import { ValueTree, jsonValue } from './value-tree.js';
import { decodeKey, decodeValue } from './storage-values.js';

const MONO = { fontFamily: '$monoFamily', fontSize: 12 } as const;
const ONE_LINE = {
  textWrap: 'nowrap',
  maxLines: 1,
  textOverflow: 'ellipsis',
} as const;

/** What the tree's rows are. */
type Place =
  | { kind: 'group'; id: string; label: string; children: Place[] }
  | {
      kind: 'local' | 'session' | 'cookies';
      id: string;
      label: string;
      origin: string;
    }
  | { kind: 'database'; id: string; label: string; children: Place[] }
  | {
      kind: 'store';
      id: string;
      label: string;
      origin: string;
      database: string;
      store: string;
    };

interface Row {
  id: string;
  key: string;
  value: string;
  cookie?: HtmlCookie;
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The cookies a page of `origin` is sent. */
function cookiesFor(jar: CookieJar, origin: string): HtmlCookie[] {
  const host = new URL(origin).hostname;
  return jar
    .all()
    .filter((c) =>
      c.hostOnly ? c.domain === host : domainMatch(host, c.domain),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A cookie gone: the jar told it expired, as a server tells it. */
function removeCookie(jar: CookieJar, cookie: HtmlCookie): void {
  const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path}`;
  const attributes = [
    `${cookie.name}=`,
    'Max-Age=0',
    `Path=${cookie.path}`,
    ...(cookie.hostOnly ? [] : [`Domain=${cookie.domain}`]),
    ...(cookie.secure ? ['Secure'] : []),
  ];
  jar.store(url, [attributes.join('; ')], {
    http: true,
    sameSite: true,
    topLevel: true,
  });
}

const getPlaceId = (p: Place) => p.id;
const getPlaceText = (p: Place) => p.label;
const getPlaceChildren = (p: Place) =>
  p.kind === 'group' || p.kind === 'database' ? p.children : undefined;
const getRowId = (r: Row) => r.id;

export function StoragePanel({
  url,
  cookies,
  storage,
  shown,
}: {
  /** The address of the document shown, whose origin's storage is read. */
  url: string;
  cookies: CookieJar;
  storage: HtmlStorage | null;
  shown: boolean;
}): ReactElement {
  const origin = originOf(url);
  // read again each second while shown, and as soon as something changes
  const tick = useTicks(shown);
  const [changes, setChanges] = useState(0);
  const touch = () => setChanges((n) => n + 1);
  useEffect(() => {
    const stops = [cookies.watch(touch), storage?.watch?.(touch) ?? (() => {})];
    return () => stops.forEach((stop) => stop());
  }, [cookies, storage]);

  const places = useMemo<Place[]>(() => {
    if (!origin) return [];
    const databases = storage?.indexedDB?.list(origin) ?? [];
    return [
      {
        kind: 'group',
        id: 'local-storage',
        label: 'Local storage',
        children: [{ kind: 'local', id: 'local', label: origin, origin }],
      },
      {
        kind: 'group',
        id: 'session-storage',
        label: 'Session storage',
        children: [{ kind: 'session', id: 'session', label: origin, origin }],
      },
      {
        kind: 'group',
        id: 'indexeddb',
        label: 'IndexedDB',
        children: databases.map((db) => ({
          kind: 'database' as const,
          id: `db:${db.name}`,
          label: `${db.name} (version ${db.version})`,
          children: (
            storage?.indexedDB?.load(origin, db.name)?.stores ?? []
          ).map((s) => ({
            kind: 'store' as const,
            id: `store:${db.name}:${s.name}`,
            label: s.name,
            origin,
            database: db.name,
            store: s.name,
          })),
        })),
      },
      {
        kind: 'group',
        id: 'cookie-jar',
        label: 'Cookies',
        children: [{ kind: 'cookies', id: 'cookies', label: origin, origin }],
      },
    ];
  }, [origin, storage, tick, changes]);

  const [chosen, setChosen] = useState<string>('local');
  const [expanded, setExpanded] = useState<readonly string[]>([
    'local-storage',
    'session-storage',
    'indexeddb',
    'cookie-jar',
  ]);
  // a database is open the first time it shows, its stores in view
  const [seen] = useState(() => new Set<string>());
  useEffect(() => {
    const group = places.find((p) => p.id === 'indexeddb');
    const fresh =
      group && group.kind === 'group'
        ? group.children.map((p) => p.id).filter((id) => !seen.has(id))
        : [];
    if (!fresh.length) return;
    for (const id of fresh) seen.add(id);
    setExpanded((was) => [...was, ...fresh]);
  }, [places]);
  const place = findPlace(places, chosen);
  const [width, setWidth] = useState(0);

  if (!origin) {
    return (
      <Empty>
        This page has no origin of its own to keep anything for: the browser’s
        own pages, a `data:` URL.
      </Empty>
    );
  }
  return (
    <box
      style={{ flexGrow: 1, minHeight: 0 }}
      onLayout={(ev) => setWidth(ev.width)}
    >
      <SplitPane
        direction="row"
        size={Math.min(260, Math.max(160, width * 0.3))}
        min={140}
        minSecond={260}
      >
        <box
          style={{
            flexGrow: 1,
            minHeight: 0,
            minWidth: 0,
            backgroundColor: '$surface',
          }}
        >
          <Tree<Place>
            aria-label="Storage"
            items={places}
            getId={getPlaceId}
            getText={getPlaceText}
            getChildren={getPlaceChildren}
            expanded={expanded}
            onExpandedChange={(ids) => setExpanded(ids as string[])}
            selected={chosen}
            onSelect={(id, p) => {
              if (p.kind !== 'group' && p.kind !== 'database')
                setChosen(String(id));
            }}
            rowHeight={20}
            styles={{ label: { textWrap: 'nowrap', fontSize: 12 } }}
            style={{ flexGrow: 1, minHeight: 0, paddingTop: 4 }}
          />
        </box>
        <box
          style={{
            flexGrow: 1,
            minHeight: 0,
            minWidth: 0,
            borderLeftWidth: 1,
            borderColor: '$border',
          }}
        >
          {place && place.kind !== 'group' && place.kind !== 'database' ? (
            <Entries
              key={place.id}
              place={place}
              cookies={cookies}
              storage={storage}
              version={tick + changes}
              onChange={touch}
            />
          ) : (
            <Empty>Choose what to look at, on the left.</Empty>
          )}
        </box>
      </SplitPane>
    </box>
  );
}

function findPlace(places: readonly Place[], id: string): Place | null {
  for (const p of places) {
    if (p.id === id) return p;
    if (p.kind === 'group' || p.kind === 'database') {
      const inner = findPlace(p.children, id);
      if (inner) return inner;
    }
  }
  return null;
}

function Empty({ children }: { children: ReactNode }): ReactElement {
  return (
    <box style={{ padding: 16 }}>
      <text style={{ fontSize: 12, color: '$textMuted' }}>{children}</text>
    </box>
  );
}

/** What a place holds, a table of it, and the entry chosen under it. */
function Entries({
  place,
  cookies,
  storage,
  version,
  onChange,
}: {
  place: Exclude<Place, { kind: 'group' } | { kind: 'database' }>;
  cookies: CookieJar;
  storage: HtmlStorage | null;
  version: number;
  onChange: () => void;
}): ReactElement {
  const area =
    place.kind === 'local'
      ? storage?.local(place.origin)
      : place.kind === 'session'
        ? storage?.session(place.origin)
        : null;
  const rows = useMemo<Row[]>(() => {
    if (place.kind === 'cookies') {
      return cookiesFor(cookies, place.origin).map((c) => ({
        id: `${c.domain}|${c.path}|${c.name}`,
        key: c.name,
        value: c.value,
        cookie: c,
      }));
    }
    if (place.kind === 'store') {
      const db = storage?.indexedDB?.load(place.origin, place.database);
      return (db?.records ?? [])
        .filter(([store]) => store === place.store)
        .map(([, key, value]) => ({
          id: key,
          key: JSON.stringify(decodeKey(key)),
          value: JSON.stringify(decodeValue(value)) ?? 'undefined',
        }));
    }
    return (area?.keys() ?? []).map((key) => ({
      id: key,
      key,
      value: area?.get(key) ?? '',
    }));
  }, [place, version]);
  const [chosen, setChosen] = useState<string | null>(null);
  const row = rows.find((r) => r.id === chosen) ?? null;
  const editable = place.kind === 'local' || place.kind === 'session';

  const columns = useMemo<TableColumn<Row>[]>(() => {
    const flag = (
      id: string,
      label: string,
      get: (c: HtmlCookie) => boolean,
      width: number,
    ): TableColumn<Row> => ({
      id,
      label,
      width,
      value: (r) => (get(r.cookie!) ? 1 : 0),
      render: (r) => (get(r.cookie!) ? <Icon name="check" size={9} /> : null),
    });
    const text = (get: (r: Row) => string, width?: number, flex?: number) => ({
      ...(width ? { width } : { flex: flex ?? 1 }),
      value: get,
      render: (r: Row) => (
        <text style={{ ...MONO, ...ONE_LINE, color: '$text' }}>{get(r)}</text>
      ),
    });
    if (place.kind === 'cookies') {
      return [
        { id: 'key', label: 'Name', minWidth: 90, ...text((r) => r.key, 0, 1) },
        {
          id: 'value',
          label: 'Value',
          minWidth: 90,
          ...text((r) => r.value, 0, 1.6),
        },
        {
          id: 'domain',
          label: 'Domain',
          ...text((r) => r.cookie!.domain, 130),
        },
        { id: 'path', label: 'Path', ...text((r) => r.cookie!.path, 70) },
        {
          id: 'expires',
          label: 'Expires',
          ...text(
            (r) =>
              r.cookie!.expires === null
                ? 'Session'
                : new Date(r.cookie!.expires).toISOString(),
            180,
          ),
        },
        flag('httpOnly', 'HttpOnly', (c) => c.httpOnly, 70),
        flag('secure', 'Secure', (c) => c.secure, 60),
        {
          id: 'sameSite',
          label: 'SameSite',
          ...text((r) => r.cookie!.sameSite, 76),
        },
      ];
    }
    return [
      { id: 'key', label: 'Key', minWidth: 100, ...text((r) => r.key, 0, 1) },
      {
        id: 'value',
        label: 'Value',
        minWidth: 100,
        ...text((r) => r.value, 0, 2),
      },
    ];
  }, [place.kind]);

  const remove = (r: Row) => {
    if (r.cookie) removeCookie(cookies, r.cookie);
    else area?.remove(r.key);
    setChosen(null);
    onChange();
  };
  const clear = () => {
    if (place.kind === 'cookies') {
      for (const r of rows) if (r.cookie) removeCookie(cookies, r.cookie);
    } else area?.clear();
    setChosen(null);
    onChange();
  };

  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          flexShrink: 0,
          height: 30,
          paddingLeft: 4,
          paddingRight: 8,
          borderBottomWidth: 1,
          borderColor: '$border',
          backgroundColor: '$surface',
        }}
      >
        {place.kind !== 'store' ? (
          <>
            <Button
              variant="ghost"
              size="small"
              aria-label="Clear all of them"
              onPress={clear}
            >
              <ClearGlyph />
            </Button>
            <Button
              variant="ghost"
              size="small"
              aria-label="Delete the one chosen"
              disabled={!row}
              onPress={() => row && remove(row)}
            >
              <TrashGlyph />
            </Button>
          </>
        ) : null}
        <text style={{ fontSize: 12, color: '$textMuted', flexGrow: 1 }}>
          {`${rows.length} ${place.kind === 'cookies' ? 'cookies' : 'entries'}`}
        </text>
      </box>
      <Table<Row>
        rows={rows}
        columns={columns}
        getId={getRowId}
        rowHeight={22}
        rowInset={0}
        selected={chosen}
        onSelect={(id) => setChosen(String(id))}
        renderEmpty={() => <Empty>Nothing is kept here.</Empty>}
        style={{ flexGrow: 1, minHeight: 0 }}
      />
      {row ? (
        <EntryValue
          key={row.id}
          row={row}
          editable={editable}
          onSave={(value) => {
            area?.set(row.key, value);
            onChange();
          }}
        />
      ) : null}
    </box>
  );
}

/** The entry chosen, under the table: its value as a tree where it is
 *  JSON, and in a field to change where it may be. */
function EntryValue({
  row,
  editable,
  onSave,
}: {
  row: Row;
  editable: boolean;
  onSave: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const json = useMemo(() => {
    if (!/^\s*[[{]/.test(row.value)) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  }, [row.value]);
  return (
    <box
      style={{
        flexShrink: 0,
        maxHeight: 200,
        borderTopWidth: 1,
        borderColor: '$border',
        padding: 8,
        gap: 6,
      }}
    >
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <text
          style={{
            fontSize: 11,
            color: '$textMuted',
            flexGrow: 1,
            ...ONE_LINE,
          }}
        >
          {row.key}
        </text>
        {editable && draft !== null && draft !== row.value ? (
          <Button
            size="small"
            onPress={() => {
              onSave(draft);
              setDraft(null);
            }}
          >
            Save
          </Button>
        ) : null}
      </box>
      {editable ? (
        <textarea
          value={draft ?? row.value}
          rows={3}
          onChange={(ev) => setDraft(ev.value)}
          style={{
            ...MONO,
            padding: 4,
            borderWidth: 1,
            borderRadius: 4,
            borderColor: '$border',
            backgroundColor: '$background',
            color: '$text',
          }}
        />
      ) : null}
      {json !== undefined ? (
        <box style={{ overflow: 'scroll', minHeight: 0, flexShrink: 1 }}>
          <ValueTree root={jsonValue(json)} />
        </box>
      ) : !editable ? (
        <text selectable style={{ ...MONO, color: '$text' }}>
          {row.value}
        </text>
      ) : null}
    </box>
  );
}
