// The Network panel: every request the tab's network made while the tools
// were open (`network-log.ts`), as a table with a waterfall, and the one
// chosen in a pane of its own — its headers, what it sent, its response
// drawn and as text, and where its time went.
//
// The Preview of an HTML response is an `<Html>` of its own: the response
// drawn by the renderer the page is drawn by, with nothing it asks for
// fetched and no script run.
import { useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button, Icon, SplitPane } from 'react-x11';

import { Table } from '../../../src/table/index.js';
import type { TableColumn } from '../../../src/table/index.js';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../../src/tabs/index.js';
import { Code } from '../../../src/code/index.js';
import { Html } from '../../../src/html/index.js';
import type { HtmlRequestKind } from '../../../src/html/index.js';
import { bodyBytes, headerOf, mimeOf } from './network-log.js';
import type { NetworkEntry, NetworkLog } from './network-log.js';
import { useStore } from './model.js';
import { ClearGlyph } from './glyphs.js';
import { ValueTree, jsonValue } from './value-tree.js';

const MONO = { fontFamily: '$monoFamily', fontSize: 12 } as const;
const SMALL = { fontSize: 12, color: '$text' } as const;
const ONE_LINE = {
  textWrap: 'nowrap',
  maxLines: 1,
  textOverflow: 'ellipsis',
} as const;

const PANEL = {
  paddingTop: 0,
  flexGrow: 1,
  flexShrink: 1,
  minHeight: 0,
} as const;

/** The panel's filters by what a request was for. */
const KINDS: readonly {
  id: string;
  label: string;
  kinds: readonly HtmlRequestKind[] | null;
}[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'doc', label: 'Doc', kinds: ['document'] },
  { id: 'css', label: 'CSS', kinds: ['stylesheet'] },
  { id: 'js', label: 'JS', kinds: ['script'] },
  { id: 'font', label: 'Font', kinds: ['font'] },
  { id: 'img', label: 'Img', kinds: ['image'] },
  { id: 'fetch', label: 'Fetch', kinds: ['fetch'] },
];

// --- what a row says ----------------------------------------------------------

/** A request's name in the table: the last part of its path, or its host. */
function nameOf(entry: NetworkEntry): string {
  try {
    const url = new URL(entry.url);
    const last = url.pathname.split('/').filter(Boolean).pop();
    return (last ? decodeURIComponent(last) : url.host) + url.search;
  } catch {
    return entry.url;
  }
}

export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function msText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function statusText(entry: NetworkEntry): string {
  if (entry.error)
    return entry.error === 'canceled' ? '(canceled)' : '(failed)';
  if (entry.status === undefined) return '(pending)';
  return String(entry.status);
}

function sizeText(entry: NetworkEntry): string {
  if (entry.cache) return `(${entry.cache} cache)`;
  return entry.status === undefined && !entry.error
    ? ''
    : bytesText(entry.size);
}

/** When a request was over, or now, for one still going. */
const endOf = (entry: NetworkEntry, now: number): number =>
  entry.ended ?? (entry.error ? entry.queued : now);

// --- the waterfall ------------------------------------------------------------

/** The phases a request's time goes in, and their colours. */
const PHASES = {
  queued: '#b0b7c3',
  waiting: '#3fb950',
  download: '#4a8dff',
};

/**
 * A request's bar, placed on the span of every request in the table: a
 * row of boxes whose `flexGrow` is each phase's share of that span, so the
 * row lays itself out at any width with no measuring.
 */
function Waterfall({
  entry,
  from,
  to,
  now,
}: {
  entry: NetworkEntry;
  from: number;
  to: number;
  now: number;
}): ReactElement {
  const end = endOf(entry, now);
  const sent = entry.sent ?? entry.responded ?? end;
  const responded = entry.responded ?? end;
  const parts: [number, string | null][] = [
    [entry.queued - from, null],
    [sent - entry.queued, PHASES.queued],
    [responded - sent, PHASES.waiting],
    [end - responded, PHASES.download],
    [to - end, null],
  ];
  return (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        height: 10,
        flexGrow: 1,
        minWidth: 0,
      }}
    >
      {parts.map(([span, colour], i) => (
        <box
          key={i}
          style={{
            flexGrow: Math.max(0, span),
            flexBasis: 0,
            height: 6,
            // the least a phase that took any time is drawn, so it shows
            ...(colour && {
              backgroundColor: colour,
              minWidth: span > 0 ? 1 : 0,
              borderRadius: 1,
            }),
          }}
        />
      ))}
    </box>
  );
}

// --- the panel -------------------------------------------------------------------

export function NetworkPanel({ log }: { log: NetworkLog }): ReactElement {
  const entries = useStore(log);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState('all');
  const [chosen, setChosen] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const now = Date.now();
  const shown = useMemo(() => {
    const kinds = KINDS.find((k) => k.id === kind)?.kinds ?? null;
    const q = filter.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (!kinds || kinds.includes(e.kind)) &&
        (!q || e.url.toLowerCase().includes(q)),
    );
  }, [entries, filter, kind]);
  const from = Math.min(...entries.map((e) => e.queued), now);
  const to = Math.max(from + 1, ...entries.map((e) => endOf(e, now)));
  const entry = chosen === null ? null : entries.find((e) => e.id === chosen);

  const columns = useMemo<TableColumn<NetworkEntry>[]>(() => {
    const name: TableColumn<NetworkEntry> = {
      id: 'name',
      label: 'Name',
      flex: 2,
      minWidth: 120,
      value: nameOf,
      render: (e) => (
        <text
          style={{
            ...SMALL,
            ...ONE_LINE,
            ...(e.error && { color: '$danger' }),
            ...(e.status !== undefined &&
              e.status >= 400 && { color: '$danger' }),
          }}
        >
          {nameOf(e)}
        </text>
      ),
    };
    const status: TableColumn<NetworkEntry> = {
      id: 'status',
      label: 'Status',
      width: 70,
      value: (e) => e.status ?? 0,
      render: (e) => (
        <text style={{ ...SMALL, ...ONE_LINE, color: '$textMuted' }}>
          {statusText(e)}
        </text>
      ),
    };
    if (entry) return [name, status];
    return [
      name,
      status,
      {
        id: 'kind',
        label: 'Type',
        width: 84,
        value: (e) => e.kind,
        render: (e) => (
          <text style={{ ...SMALL, ...ONE_LINE, color: '$textMuted' }}>
            {e.kind}
          </text>
        ),
      },
      {
        id: 'size',
        label: 'Size',
        width: 116,
        align: 'end',
        value: (e) => e.size,
        render: (e) => (
          <text style={{ ...SMALL, ...ONE_LINE, color: '$textMuted' }}>
            {sizeText(e)}
          </text>
        ),
      },
      {
        id: 'time',
        label: 'Time',
        width: 72,
        align: 'end',
        value: (e) => endOf(e, now) - e.queued,
        render: (e) => (
          <text style={{ ...SMALL, ...ONE_LINE, color: '$textMuted' }}>
            {e.ended === undefined && !e.error
              ? 'Pending'
              : msText(endOf(e, now) - e.queued)}
          </text>
        ),
      },
      {
        id: 'waterfall',
        label: 'Waterfall',
        flex: 3,
        minWidth: 120,
        sortable: false,
        render: (e) => <Waterfall entry={e} from={from} to={to} now={now} />,
      },
    ];
  }, [entry !== null, from, to, now]);

  const total = entries.reduce((n, e) => n + (e.cache ? 0 : e.size), 0);
  const finished = entries.length
    ? Math.max(...entries.map((e) => endOf(e, now))) - from
    : 0;

  const table = (
    <Table<NetworkEntry>
      rows={shown}
      columns={columns}
      getId={getEntryId}
      rowHeight={22}
      rowInset={0}
      selected={chosen}
      onSelect={(id) => setChosen(id as number)}
      renderEmpty={() => (
        <box style={{ padding: 16, alignItems: 'center' }}>
          <text style={{ fontSize: 12, color: '$textMuted' }}>
            {entries.length
              ? 'No request matches the filter.'
              : 'Requests the page makes while the tools are open show here. Reload to see the page’s own.'}
          </text>
        </box>
      )}
      style={{ flexGrow: 1, minHeight: 0, minWidth: 0 }}
    />
  );

  const DETAIL = 6;
  const detailWidth = Math.max(320, Math.round(width * 0.62));
  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
          gap: 4,
          paddingLeft: 4,
          paddingRight: 8,
          height: 30,
          borderBottomWidth: 1,
          borderColor: '$border',
          backgroundColor: '$surface',
        }}
      >
        <Button
          variant="ghost"
          size="small"
          aria-label="Clear the network log"
          onPress={() => {
            log.clear();
            setChosen(null);
          }}
        >
          <ClearGlyph />
        </Button>
        <textinput
          value={filter}
          placeholder="Filter"
          onChange={(ev) => setFilter(ev.value)}
          style={{
            width: 180,
            height: 22,
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
        <box style={{ flexDirection: 'row', gap: 1, marginLeft: 6 }}>
          {KINDS.map((k) => (
            <Button
              key={k.id}
              variant={k.id === kind ? 'solid' : 'ghost'}
              size="small"
              aria-pressed={k.id === kind}
              onPress={() => setKind(k.id)}
            >
              {k.label}
            </Button>
          ))}
        </box>
      </box>
      <box
        style={{ flexGrow: 1, minHeight: 0 }}
        onLayout={(ev) => setWidth(ev.width)}
      >
        {entry ? (
          <SplitPane
            direction="row"
            size={Math.max(180, width - DETAIL - detailWidth)}
            min={180}
            minSecond={300}
          >
            <box style={{ flexGrow: 1, minHeight: 0, minWidth: 0 }}>
              {table}
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
              <RequestDetail entry={entry} onClose={() => setChosen(null)} />
            </box>
          </SplitPane>
        ) : (
          table
        )}
      </box>
      <box
        style={{
          flexDirection: 'row',
          flexShrink: 0,
          gap: 14,
          paddingLeft: 10,
          height: 22,
          alignItems: 'center',
          borderTopWidth: 1,
          borderColor: '$border',
          backgroundColor: '$surface',
        }}
      >
        <text style={{ fontSize: 11, color: '$textMuted' }}>
          {`${shown.length} / ${entries.length} requests`}
        </text>
        <text style={{ fontSize: 11, color: '$textMuted' }}>
          {`${bytesText(total)} transferred`}
        </text>
        {entries.length ? (
          <text style={{ fontSize: 11, color: '$textMuted' }}>
            {`Finish: ${msText(finished)}`}
          </text>
        ) : null}
      </box>
    </box>
  );
}

const getEntryId = (e: NetworkEntry) => e.id;

// --- one request ---------------------------------------------------------------

function RequestDetail({
  entry,
  onClose,
}: {
  entry: NetworkEntry;
  onClose: () => void;
}): ReactElement {
  const [tab, setTab] = useState('headers');
  return (
    <Tabs
      value={tab}
      onValueChange={(e) => setTab(e.value)}
      size="sm"
      ground="$background"
      style={{ flexGrow: 1, minHeight: 0, minWidth: 0 }}
    >
      <TabsList
        style={{
          paddingLeft: 2,
          paddingRight: 4,
          backgroundColor: '$surface',
          alignItems: 'center',
        }}
      >
        <Button
          variant="ghost"
          size="small"
          aria-label="Close the request"
          onPress={onClose}
        >
          <Icon name="close" size={8} />
        </Button>
        <TabsTrigger value="headers">Headers</TabsTrigger>
        <TabsTrigger value="payload">Payload</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="response">Response</TabsTrigger>
        <TabsTrigger value="timing">Timing</TabsTrigger>
      </TabsList>
      <TabsContent value="headers" style={PANEL}>
        <Scroll>
          <Section title="General">
            <Pairs
              pairs={[
                ['Request URL', entry.url],
                ['Request Method', entry.method],
                [
                  'Status Code',
                  entry.status === undefined
                    ? statusText(entry)
                    : `${entry.status} ${entry.statusText ?? ''}`.trim(),
                ],
                [
                  'Served From',
                  entry.cache ? `the ${entry.cache} cache` : 'the network',
                ],
                ...(entry.redirected && entry.finalUrl
                  ? ([['Redirected To', entry.finalUrl]] as [string, string][])
                  : []),
                ...(entry.error
                  ? ([['Error', entry.error]] as [string, string][])
                  : []),
              ]}
            />
          </Section>
          <Section
            title={`Response Headers (${entry.responseHeaders?.length ?? 0})`}
          >
            <Pairs pairs={entry.responseHeaders ?? []} />
          </Section>
          <Section title="Request Headers">
            <Pairs pairs={Object.entries(entry.requestHeaders)} />
            <Note>
              What the network adds on the way — a cookie, the host — is not
              among them.
            </Note>
          </Section>
        </Scroll>
      </TabsContent>
      <TabsContent value="payload" style={PANEL}>
        <Payload entry={entry} />
      </TabsContent>
      <TabsContent value="preview" style={PANEL}>
        <Preview entry={entry} />
      </TabsContent>
      <TabsContent value="response" style={PANEL}>
        <ResponseText entry={entry} />
      </TabsContent>
      <TabsContent value="timing" style={PANEL}>
        <Timing entry={entry} />
      </TabsContent>
    </Tabs>
  );
}

function Scroll({ children }: { children: ReactNode }): ReactElement {
  return (
    <box style={{ overflow: 'scroll', flexGrow: 1, minHeight: 0 }}>
      <box style={{ flexShrink: 0, padding: 10, gap: 12 }}>{children}</box>
    </box>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <box style={{ gap: 4, flexShrink: 0 }}>
      <text style={{ fontSize: 12, fontWeight: 'bold', color: '$text' }}>
        {title}
      </text>
      {children}
    </box>
  );
}

function Note({ children }: { children: string }): ReactElement {
  return (
    <text style={{ fontSize: 11, color: '$textMuted', paddingTop: 2 }}>
      {children}
    </text>
  );
}

function Pairs({
  pairs,
}: {
  pairs: readonly (readonly [string, string])[];
}): ReactElement {
  if (!pairs.length) return <Note>None.</Note>;
  return (
    <box style={{ gap: 2, paddingLeft: 8 }}>
      {pairs.map(([name, value], i) => (
        <box key={`${name}${i}`} style={{ flexDirection: 'row', gap: 8 }}>
          <text
            style={{
              ...MONO,
              color: '$textMuted',
              width: 180,
              flexShrink: 0,
              ...ONE_LINE,
            }}
          >
            {name}
          </text>
          <text selectable style={{ ...MONO, color: '$text', flexShrink: 1 }}>
            {value}
          </text>
        </box>
      ))}
    </box>
  );
}

/** A body's text, decoded as its `Content-Type` says. */
function textOf(entry: NetworkEntry, bytes: Uint8Array): string {
  const charset = /charset=([^;]+)/i.exec(
    headerOf(entry, 'content-type') ?? '',
  );
  try {
    return new TextDecoder(charset?.[1]?.trim() || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** The JSON in a text, or undefined where it holds none. */
function parsedJson(text: string): unknown {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function Payload({ entry }: { entry: NetworkEntry }): ReactElement {
  let query: [string, string][] = [];
  try {
    query = [...new URL(entry.url).searchParams];
  } catch {
    query = [];
  }
  const raw = entry.requestBody;
  const body =
    raw === null
      ? null
      : typeof raw === 'string'
        ? raw
        : new TextDecoder().decode(raw);
  const type = (entry.requestHeaders['content-type'] ?? '').toLowerCase();
  const json = body === null ? undefined : parsedJson(body);
  return (
    <Scroll>
      {query.length ? (
        <Section title="Query String Parameters">
          <Pairs pairs={query} />
        </Section>
      ) : null}
      {body !== null ? (
        <Section title="Request Payload">
          {type.includes('application/x-www-form-urlencoded') ? (
            <Pairs pairs={[...new URLSearchParams(body)]} />
          ) : json !== undefined ? (
            <ValueTree root={jsonValue(json)} />
          ) : (
            <text selectable style={{ ...MONO, color: '$text' }}>
              {body}
            </text>
          )}
        </Section>
      ) : null}
      {!query.length && body === null ? (
        <Note>This request sent no query and no body.</Note>
      ) : null}
    </Scroll>
  );
}

/** How much of a text the Response tab draws. */
const MOST_SHOWN = 200 * 1024;

function Unkept({ entry }: { entry: NetworkEntry }): ReactElement | null {
  if (entry.ended === undefined && !entry.error) {
    return <Note>The response is still arriving.</Note>;
  }
  if (entry.truncated && !entry.body.length) {
    return <Note>The body was too large to keep.</Note>;
  }
  if (!entry.size) return <Note>This response has no body.</Note>;
  return null;
}

function Preview({ entry }: { entry: NetworkEntry }): ReactElement {
  const bytes = useMemo(() => bodyBytes(entry), [entry.body]);
  const unkept = <Unkept entry={entry} />;
  if (!bytes.length) return <Scroll>{unkept}</Scroll>;
  const mime = mimeOf(entry);
  if (mime === 'image/svg+xml') {
    return (
      <Scroll>
        <svg
          source={textOf(entry, bytes)}
          style={{ maxWidth: 400, maxHeight: 400 }}
        />
      </Scroll>
    );
  }
  if (mime.startsWith('image/') || entry.kind === 'image') {
    return (
      <Scroll>
        <image src={bytes} style={{ alignSelf: 'flex-start' }} />
        <Note>{`${bytesText(bytes.length)}, ${mime || 'an image'}`}</Note>
      </Scroll>
    );
  }
  const text = textOf(entry, bytes);
  if (mime === 'text/html' || entry.kind === 'document') {
    // drawn as a page is, with nothing it asks for fetched and no script run
    return (
      <box style={{ overflow: 'scroll', flexGrow: 1, minHeight: 0 }}>
        <Html
          source={text.slice(0, MOST_SHOWN * 5)}
          partial={false}
          fontSize={16}
          defaultColorScheme="light"
        />
      </box>
    );
  }
  const json = parsedJson(text);
  if (json !== undefined) {
    return (
      <Scroll>
        <ValueTree root={jsonValue(json)} />
      </Scroll>
    );
  }
  return <ResponseText entry={entry} />;
}

/** A fence tag for a response, for its highlighting. */
function langOf(entry: NetworkEntry): string {
  const mime = mimeOf(entry);
  if (mime.includes('json')) return 'json';
  if (mime.includes('javascript') || entry.kind === 'script') return 'js';
  return '';
}

function ResponseText({ entry }: { entry: NetworkEntry }): ReactElement {
  const bytes = useMemo(() => bodyBytes(entry), [entry.body]);
  if (!bytes.length) return <Scroll>{<Unkept entry={entry} />}</Scroll>;
  if (mimeOf(entry).startsWith('image/') && mimeOf(entry) !== 'image/svg+xml') {
    return (
      <Scroll>
        <Note>{`${bytesText(bytes.length)} of image data: see the Preview.`}</Note>
      </Scroll>
    );
  }
  const text = textOf(entry, bytes);
  const shown = text.length > MOST_SHOWN ? text.slice(0, MOST_SHOWN) : text;
  return (
    <box style={{ overflow: 'scroll', flexGrow: 1, minHeight: 0 }}>
      <Code
        source={shown}
        lang={langOf(entry)}
        lineNumbers
        style={{ margin: 0 }}
      />
      {shown !== text ? (
        <box style={{ padding: 8 }}>
          <Note>{`The first ${bytesText(MOST_SHOWN)} of ${bytesText(text.length)}.`}</Note>
        </box>
      ) : null}
    </box>
  );
}

function Timing({ entry }: { entry: NetworkEntry }): ReactElement {
  const end = endOf(entry, Date.now());
  if (entry.cache) {
    return (
      <Scroll>
        <Note>{`Served from the ${entry.cache} cache: nothing was sent.`}</Note>
      </Scroll>
    );
  }
  const sent = entry.sent ?? end;
  const responded = entry.responded ?? end;
  const span = Math.max(1, end - entry.queued);
  const rows: [string, number, number, string][] = [
    ['Queueing', entry.queued, sent, PHASES.queued],
    ['Waiting for server response', sent, responded, PHASES.waiting],
    ['Content download', responded, end, PHASES.download],
  ];
  return (
    <Scroll>
      <Section title="Where the time went">
        <box style={{ gap: 6, paddingLeft: 8 }}>
          {rows.map(([label, from, to, colour]) => (
            <box
              key={label}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
            >
              <text style={{ ...SMALL, width: 190, flexShrink: 0 }}>
                {label}
              </text>
              <box
                style={{
                  flexDirection: 'row',
                  flexGrow: 1,
                  height: 10,
                  alignItems: 'center',
                }}
              >
                <box style={{ flexGrow: from - entry.queued, flexBasis: 0 }} />
                <box
                  style={{
                    flexGrow: Math.max(0, to - from),
                    flexBasis: 0,
                    minWidth: to > from ? 2 : 0,
                    height: 8,
                    borderRadius: 2,
                    backgroundColor: colour,
                  }}
                />
                <box style={{ flexGrow: end - to, flexBasis: 0 }} />
              </box>
              <text
                style={{
                  ...MONO,
                  width: 70,
                  flexShrink: 0,
                  textAlign: 'right',
                  color: '$textMuted',
                }}
              >
                {msText(Math.max(0, to - from))}
              </text>
            </box>
          ))}
          <box style={{ flexDirection: 'row', gap: 10, paddingTop: 4 }}>
            <text style={{ ...SMALL, width: 190, fontWeight: 'bold' }}>
              Total
            </text>
            <box style={{ flexGrow: 1 }} />
            <text
              style={{
                ...MONO,
                width: 70,
                textAlign: 'right',
                fontWeight: 'bold',
                color: '$text',
              }}
            >
              {msText(span)}
            </text>
          </box>
        </box>
      </Section>
      <Note>
        Queueing is the wait for the network to let the request go, which it
        holds a few to a host at a time. The time to connect is part of the wait
        for the server, which the network does not tell apart.
      </Note>
    </Scroll>
  );
}
