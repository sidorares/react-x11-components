// The Sources panel: the page's scripts and style sheets (`source-files.ts`)
// in a tree by where they came from — an origin, its folders, and the
// page's own file holding what is written in it — and the one chosen in a
// read-only `<CodeEditor>`, highlighted as JavaScript or as CSS, set out a
// line at a time where it is minified.
//
// A style sheet the document read is shown as it read it, and a script the
// page loaded is read from the tab's network, whose cache has it from when
// the page asked for it: nothing goes to the server again unless the cache
// let it go. One written in the page is the element's text as the document
// holds it now, a script's changes to it included.
//
// The Styles tab sends a rule here (`Inspection.source`): its file is chosen
// and shown with what was asked for selected, set a third of the way down.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, SplitPane, useClipboard, useTheme } from 'react-x11';

import { Tree } from '../../../src/tree/index.js';
import type { TreeHandle, TreeRowState } from '../../../src/tree/index.js';
import { CodeEditor, css, javascript } from '../../../src/code-editor/index.js';
import type { CodeEditorHandle } from '../../../src/code-editor/index.js';
import { autoTokenStyles } from '../../../src/code-language/index.js';
import type { HtmlHandle } from '../../../src/html/index.js';
import { useTicks } from './elements.js';
import { CopyGlyph } from './glyphs.js';
import { useStore } from './model.js';
import type { Inspection, SourceTarget } from './model.js';
import { bytesText } from './network.js';
import {
  formatCss,
  formatJs,
  inlineText,
  looksMinified,
  sheetFile,
  shownRange,
  sourcesOf,
} from './source-files.js';
import type { SourceFile } from './source-files.js';

/** What the panel asks for a file the page loaded: its text, from the
 *  tab's network, or null where there is none. */
export type SourceLoader = (
  url: string,
  kind: SourceFile['kind'],
) => Promise<string | null>;

/** A row of the tree: a folder, or a file. */
interface Row {
  id: string;
  label: string;
  file?: SourceFile;
  children?: Row[];
}

/** The files as a tree of their folders, each folder before its files and
 *  both in the order the page has them. */
function treeOf(files: readonly SourceFile[]): Row[] {
  const roots: Row[] = [];
  const folders = new Map<string, Row>();
  for (const file of files) {
    let level = roots;
    let path = '';
    for (const name of file.folders) {
      path += `/${name}`;
      let folder = folders.get(path);
      if (!folder) {
        folder = { id: `folder:${path}`, label: name, children: [] };
        folders.set(path, folder);
        level.push(folder);
      }
      level = folder.children!;
    }
    level.push({ id: file.id, label: file.name, file });
  }
  const order = (rows: Row[]): Row[] =>
    rows
      .sort((a, b) => Number(!a.children) - Number(!b.children))
      .map((r) => (r.children ? { ...r, children: order(r.children) } : r));
  return order(roots);
}

const getId = (r: Row) => r.id;
const getText = (r: Row) => r.label;
const getChildren = (r: Row) => r.children;

/** Every folder's id, so the tree opens on all of them. */
function folderIds(rows: readonly Row[]): string[] {
  return rows.flatMap((r) =>
    r.children ? [r.id, ...folderIds(r.children)] : [],
  );
}

/** The folders around a file, by their ids. */
function foldersOf(file: SourceFile): string[] {
  let path = '';
  return file.folders.map((name) => `folder:${(path += `/${name}`)}`);
}

export function SourcesPanel({
  handle,
  docKey,
  inspection,
  load,
  shown,
}: {
  handle: HtmlHandle;
  docKey: number;
  inspection: Inspection;
  load: SourceLoader;
  shown: boolean;
}): ReactElement {
  // read again each second while shown: a page's script adds sources
  const tick = useTicks(shown);
  const target = useStore(inspection.source);
  const files = useMemo(
    () =>
      handle.document
        ? sourcesOf(handle.document, handle.base, handle.styleSheets())
        : [],
    [docKey, tick, handle.document, target],
  );
  const rows = useMemo(() => treeOf(files), [files]);
  const [expanded, setExpanded] = useState<readonly string[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const file = files.find((f) => f.id === chosen) ?? null;
  const [width, setWidth] = useState(0);
  const tree = useRef<TreeHandle<Row>>(null);
  useEffect(() => setChosen(null), [docKey]);
  useEffect(() => {
    const asked = target && sheetFile(files, target.sheet);
    if (!asked) return;
    setChosen(asked.id);
    setExpanded((was) => was && [...new Set([...was, ...foldersOf(asked)])]);
    // once the rows are there
    setTimeout(() => tree.current?.scrollToItem(asked.id), 0);
  }, [target]);

  return (
    <box
      style={{ flexGrow: 1, minHeight: 0 }}
      onLayout={(ev) => setWidth(ev.width)}
    >
      <SplitPane
        direction="row"
        size={Math.min(300, Math.max(170, width * 0.28))}
        min={140}
        minSecond={280}
      >
        <box
          style={{
            flexGrow: 1,
            minHeight: 0,
            minWidth: 0,
            backgroundColor: '$surface',
          }}
        >
          {rows.length ? (
            <Tree<Row>
              ref={tree}
              aria-label="Sources"
              items={rows}
              getId={getId}
              getText={getText}
              getChildren={getChildren}
              expanded={expanded ?? folderIds(rows)}
              onExpandedChange={(ids) => setExpanded(ids as string[])}
              selected={chosen}
              onSelect={(id, r) => {
                if (!r.file) return;
                setChosen(String(id));
                inspection.source.set(null);
              }}
              rowHeight={20}
              renderLabel={(state) => <FileLabel state={state} />}
              styles={{ label: { textWrap: 'nowrap' } }}
              style={{ flexGrow: 1, minHeight: 0, paddingTop: 4 }}
            />
          ) : (
            <Note>This page has no scripts and no style sheets.</Note>
          )}
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
          {file ? (
            <SourceView
              key={file.id}
              file={file}
              load={load}
              tick={tick}
              target={target && sheetFile([file], target.sheet) ? target : null}
            />
          ) : (
            <Note>
              Choose a script or a style sheet, on the left, to read it.
            </Note>
          )}
        </box>
      </SplitPane>
    </box>
  );
}

function FileLabel({ state }: { state: TreeRowState<Row> }): ReactElement {
  const theme = useTheme();
  const file = state.item.file;
  return (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        minWidth: 0,
      }}
    >
      {file ? (
        <box
          style={{
            paddingLeft: 3,
            paddingRight: 3,
            borderRadius: 3,
            flexShrink: 0,
            backgroundColor: file.kind === 'script' ? '#d9a514' : '#2f7fd6',
          }}
        >
          <text style={{ fontSize: 9, fontWeight: 'bold', color: '#fff' }}>
            {file.kind === 'script' ? 'JS' : 'CSS'}
          </text>
        </box>
      ) : null}
      <text
        style={{
          fontSize: 12,
          color: state.selected ? state.color : theme.text,
          textWrap: 'nowrap',
          maxLines: 1,
          textOverflow: 'ellipsis',
          flexShrink: 1,
        }}
      >
        {state.item.label}
      </text>
    </box>
  );
}

function Note({ children }: { children: string }): ReactElement {
  return (
    <box style={{ padding: 16 }}>
      <text style={{ fontSize: 12, color: '$textMuted' }}>{children}</text>
    </box>
  );
}

/** One file, read and shown: a bar that says what it is, and its text. */
function SourceView({
  file,
  load,
  target,
}: {
  file: SourceFile;
  load: SourceLoader;
  /** The panel's tick, which reads a file written in the page again. */
  tick: number;
  /** What the Styles tab asked to see in it. */
  target: SourceTarget | null;
}): ReactElement {
  const theme = useTheme();
  const clipboard = useClipboard();
  const styles = useMemo(
    () => autoTokenStyles(theme.background),
    [theme.background],
  );
  // a file written in the page is read off its element, as it is now, and
  // a sheet the document read is what it read: a rule's place counts in it
  const known =
    file.url === null && file.element
      ? inlineText(file)
      : (file.sheet?.text ?? null);
  const [loaded, setLoaded] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!file.url || known !== null) return;
    let live = true;
    load(file.url, file.kind).then(
      (text) => live && setLoaded(text),
      () => live && setLoaded(null),
    );
    return () => {
      live = false;
    };
  }, [file.url, known === null]);
  const text = known ?? loaded;
  const minified = useMemo(() => (text ? looksMinified(text) : false), [text]);
  const [pretty, setPretty] = useState<boolean | null>(null);
  const formatted = pretty ?? minified;
  const shownText = useMemo(
    () =>
      text == null
        ? ''
        : formatted
          ? file.kind === 'script'
            ? formatJs(text)
            : formatCss(text)
          : text,
    [text, formatted, file.kind],
  );
  // a line break at the end ends the last line, and starts none
  const lines = useMemo(
    () => shownText.replace(/\n$/, '').split('\n').length,
    [shownText],
  );
  // what was asked for, once there is a text to show it in and the editor
  // has a height to place it in: the caret at its start, which keeps its
  // start in view however far it runs
  const editor = useRef<CodeEditorHandle>(null);
  const [height, setHeight] = useState(0);
  const shownTarget = useRef<SourceTarget | null>(null);
  useEffect(() => {
    const view = editor.current;
    if (!view || !target || text == null || !height) return;
    if (shownTarget.current === target) return;
    shownTarget.current = target;
    const [from, to] = shownRange(file, target, text, formatted);
    view.select(to, from);
    view.scrollBy(0, view.caretRect().y - height / 3);
    view.focus();
  }, [target, text, height]);

  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
          gap: 8,
          height: 30,
          paddingLeft: 10,
          paddingRight: 6,
          borderBottomWidth: 1,
          borderColor: '$border',
          backgroundColor: '$surface',
        }}
      >
        <text
          selectable
          style={{
            fontSize: 12,
            color: '$text',
            flexGrow: 1,
            flexShrink: 1,
            textWrap: 'nowrap',
            maxLines: 1,
            textOverflow: 'ellipsis',
          }}
        >
          {file.url ?? `${file.name}, written in the page`}
        </text>
        {text != null ? (
          <text style={{ fontSize: 11, color: '$textMuted', flexShrink: 0 }}>
            {`${lines} ${lines === 1 ? 'line' : 'lines'} · ${bytesText(new TextEncoder().encode(text).length)}`}
          </text>
        ) : null}
        {file.url ? (
          <Button
            variant="ghost"
            size="small"
            aria-label="Copy the address"
            onPress={() => {
              clipboard.write(file.url!).catch(() => {});
            }}
          >
            <CopyGlyph />
          </Button>
        ) : null}
        <Button
          variant={formatted ? 'solid' : 'ghost'}
          size="small"
          aria-pressed={formatted}
          aria-label={
            formatted ? 'Show it as written' : 'Set it out a line at a time'
          }
          disabled={text == null}
          onPress={() => setPretty(!formatted)}
        >
          {'{ }'}
        </Button>
      </box>
      {text === undefined ? (
        <Note>Reading it…</Note>
      ) : text === null ? (
        <Note>
          It could not be read: the network’s cache let it go, and the server
          answered nothing.
        </Note>
      ) : (
        <box
          style={{ flexGrow: 1, minHeight: 0 }}
          onLayout={(ev) => setHeight(ev.height)}
        >
          <CodeEditor
            ref={editor}
            value={shownText}
            readOnly
            language={file.kind === 'script' ? javascript() : css()}
            tokenStyles={styles}
            lineNumbers
            activeLine
            style={{
              flexGrow: 1,
              minHeight: 0,
              fontFamily: '$monoFamily',
              fontSize: 12,
              borderWidth: 0,
            }}
          />
        </box>
      )}
    </box>
  );
}
