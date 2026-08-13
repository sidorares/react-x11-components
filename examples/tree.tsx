// Run with: npm run examples:tree [-- <directory>]   (needs a real $DISPLAY)
//
// A file explorer: `<Tree>` as the left panel over the real filesystem, and
// whatever is selected on the right. Point it at a directory, or leave it on
// the working one.
//
// It is here to exercise the parts of `<Tree>` that a synthetic tree of
// objects would not:
//
//   - **The data is the app's own.** There is no `TreeItem` anywhere in this
//     file. `Entry` is `{ path, name, dir, children }`, and the accessors are
//     what makes `<Tree>` read it. That is the difference between a component
//     you render your data with and one you copy your data into.
//   - **Children arrive late.** A directory is a branch before anything has
//     listed it (`isBranch` says so from `dir`), and `onExpandedChange` is
//     where the listing is fetched. The twisty is clickable the whole time.
//   - **The look is overridden where the design goals said it should be**: a
//     lucide-style folder for the node, and a dotted branch edge down the
//     indent instead of the default plain indentation. Both go through the
//     seams; nothing here reaches inside the component.
//
// The glyphs are **drawn here rather than imported**, and that is the rule
// core's icon set draws: it ships affordances (the chevron on the twisty is
// core's) and never nouns, because a folder is a noun and an icon theme's
// job. These are lucide-shaped — same 2-on-24 stroke weight, same rounded
// joins — laid out as fractions of their box the way `<canvas mono>` wants,
// so one drawing serves both colour schemes and every row state.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { SplitPane, createRoot } from 'react-x11';
import type { DrawInfo } from 'react-x11';

import { Tree } from '../src/index.js';
import type { TreeGuideState, TreeRowState } from '../src/index.js';

// --- the app's own data ----------------------------------------------------

interface Entry {
  path: string;
  name: string;
  dir: boolean;
  /** Undefined until the directory has been listed — which is what makes
   *  this lazy rather than a tree that was built up front. */
  children?: Entry[];
  /** A directory that could not be read. It stops being a branch. */
  denied?: boolean;
}

async function listDir(dir: string): Promise<Entry[]> {
  const found = await readdir(dir, { withFileTypes: true });
  return (
    found
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({
        path: path.join(dir, e.name),
        name: e.name,
        dir: e.isDirectory(),
      }))
      // directories first, then by name — the order every file manager uses
      .sort((a, b) =>
        a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
      )
  );
}

/** The tree with one directory's children filled in. Immutable: `<Tree>`
 *  re-flattens when `items` changes identity, and a splice would not. */
function withChildren(
  entries: Entry[],
  target: string,
  children: Entry[] | 'denied',
): Entry[] {
  return entries.map((entry) => {
    if (entry.path === target) {
      return children === 'denied'
        ? { ...entry, denied: true }
        : { ...entry, children };
    }
    if (!entry.children || !target.startsWith(entry.path + path.sep)) {
      return entry;
    }
    return {
      ...entry,
      children: withChildren(entry.children, target, children),
    };
  });
}

// --- the drawings ----------------------------------------------------------

/**
 * The slice of ntk's 2d context these drawings use.
 *
 * `<canvas onDraw>` hands over `ctx: any` — the toolkit's context is not in
 * react-x11's declarations — so naming what is actually reached for is how an
 * example keeps a typo in a method name a compile error rather than a blank
 * icon at run time.
 */
interface DrawCtx {
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  setLineDash: (segments: number[]) => void;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  closePath: () => void;
  stroke: () => void;
}

/** The 2-on-a-24-grid stroke every outline set uses, with a floor: below
 *  about 1.25 a stroke stops reading as a line at all. */
const weight = (size: number): number => Math.max(1.25, size / 12);

/** Stroke a path given in fractions of the box. Never names a colour: under
 *  `mono` the ink is preset from `style.color`, and a drawing that named its
 *  own would collide with itself in the paint cache. */
function poly(
  ctx: DrawCtx,
  w: number,
  hgt: number,
  points: ReadonlyArray<readonly [number, number]>,
  close = false,
): void {
  ctx.lineWidth = weight(Math.min(w, hgt));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x * w, y * hgt);
    else ctx.lineTo(x * w, y * hgt);
  });
  if (close) ctx.closePath();
  ctx.stroke();
}

/**
 * The node glyphs. Module-level and never rebuilt: identity is what
 * `CanvasNode` compares to decide whether a re-render changed the picture, so
 * a factory per row would invalidate the paint cache on every keystroke.
 */
const glyphs = Object.freeze({
  folder: (ctx: DrawCtx, { width: w, height: h }: DrawInfo) =>
    poly(
      ctx,
      w,
      h,
      [
        [0.06, 0.82],
        [0.06, 0.22],
        [0.4, 0.22],
        [0.51, 0.36],
        [0.94, 0.36],
        [0.94, 0.82],
      ],
      true,
    ),
  // The open folder is the same back panel with the front swung down and
  // out — which is why the flap is a parallelogram rather than a rectangle.
  folderOpen: (ctx: DrawCtx, { width: w, height: h }: DrawInfo) => {
    poly(ctx, w, h, [
      [0.06, 0.78],
      [0.06, 0.22],
      [0.4, 0.22],
      [0.51, 0.36],
      [0.86, 0.36],
      [0.86, 0.48],
    ]);
    poly(
      ctx,
      w,
      h,
      [
        [0.06, 0.8],
        [0.22, 0.48],
        [0.99, 0.48],
        [0.82, 0.8],
      ],
      true,
    );
  },
  file: (ctx: DrawCtx, { width: w, height: h }: DrawInfo) => {
    poly(
      ctx,
      w,
      h,
      [
        [0.18, 0.9],
        [0.18, 0.1],
        [0.62, 0.1],
        [0.82, 0.32],
        [0.82, 0.9],
      ],
      true,
    );
    // the folded corner, which is what makes it a page rather than a card
    poly(ctx, w, h, [
      [0.62, 0.1],
      [0.62, 0.32],
      [0.82, 0.32],
    ]);
  },
});

/**
 * The branch edge, dotted — the seam the design goals name, drawn the way a
 * classic tree draws it.
 *
 * Three shapes, one per answer `renderGuide` can get: a line passing through
 * an ancestor's column, the tee for a row with siblings below it, and the
 * elbow for the last of them. A column with nothing in it draws nothing at
 * all rather than a transparent canvas.
 */
const DASH = [1, 3];

function dotted(
  ctx: DrawCtx,
  points: ReadonlyArray<readonly [number, number]>,
): void {
  ctx.lineWidth = 1;
  ctx.setLineDash(DASH);
  ctx.beginPath();
  points.forEach(([x, y], i) =>
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y),
  );
  ctx.stroke();
}

const edges = Object.freeze({
  // an ancestor's line, running the whole height of the row
  through: (ctx: DrawCtx, { width: w, height: h }: DrawInfo) =>
    dotted(ctx, [
      [w / 2, 0],
      [w / 2, h],
    ]),
  // this row, with more siblings under it
  tee: (ctx: DrawCtx, { width: w, height: h }: DrawInfo) => {
    dotted(ctx, [
      [w / 2, 0],
      [w / 2, h],
    ]);
    dotted(ctx, [
      [w / 2, h / 2],
      [w, h / 2],
    ]);
  },
  // the last of its siblings: the line stops here
  elbow: (ctx: DrawCtx, { width: w, height: h }: DrawInfo) => {
    dotted(ctx, [
      [w / 2, 0],
      [w / 2, h / 2],
    ]);
    dotted(ctx, [
      [w / 2, h / 2],
      [w, h / 2],
    ]);
  },
});

// --- the app ---------------------------------------------------------------

const ROOT = path.resolve(process.argv[2] ?? process.cwd());

function App(): ReactElement {
  const [items, setItems] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    listDir(ROOT).then(setItems, (err: Error) => setError(err.message));
  }, []);

  /** List a directory the first time it is opened, and never again. */
  const load = useCallback((entry: Entry): void => {
    if (entry.children || entry.denied) return;
    listDir(entry.path).then(
      (children) =>
        setItems((tree) => withChildren(tree, entry.path, children)),
      () => setItems((tree) => withChildren(tree, entry.path, 'denied')),
    );
  }, []);

  // The accessors, memoized so `<Tree>` does not re-flatten the whole
  // filesystem every time this component renders.
  const accessors = useMemo(
    () => ({
      getId: (e: Entry) => e.path,
      getLabel: (e: Entry) => e.name,
      // Type-ahead needs text, and the label is a folder icon beside a
      // `<text>` — an element, which nothing can read a name back out of.
      getText: (e: Entry) => e.name,
      getChildren: (e: Entry) => e.children,
      // A directory is a branch before anything has listed it. Without this
      // every folder would look like a file until it had been read, and
      // there would be nothing to click to read it.
      isBranch: (e: Entry) => e.dir && !e.denied,
    }),
    [],
  );

  return (
    <window
      width={880}
      height={560}
      title={`@react-x11/components — file explorer (${ROOT})`}
    >
      {/* Core's `<SplitPane>` rather than a hand-rolled row, and it is worth
          knowing why beyond the draggable divider: it gives **both** panes
          `minHeight: 0` and the second one a zero flex basis. A flex item's
          automatic minimum size is its content — CSS's `min-height: auto` —
          so a plain row here would refuse to shrink to the window and grow to
          the height of the whole expanded tree, and a scroll container inside
          something already taller than the window has nothing left to scroll:
          opening a folder would just make the window's content taller. The
          tree's own root already says `minHeight: 0`; every flex ancestor
          between it and the window has to as well, and this is a component
          that does. */}
      <SplitPane direction="row" defaultSize={280} min={160} minSecond={220}>
        <box
          style={{
            flexGrow: 1,
            minHeight: 0,
            backgroundColor: '$surfaceHover',
            borderEndWidth: 1,
            borderColor: '$border',
          }}
        >
          <text
            style={{
              fontSize: 11,
              color: '$textMuted',
              paddingStart: 10,
              paddingTop: 8,
              paddingBottom: 4,
            }}
          >
            {path.basename(ROOT) || ROOT}
          </text>

          <Tree<Entry>
            {...accessors}
            items={items}
            expanded={expanded}
            selected={selected}
            aria-label="Files"
            // Wider than the default 14, because the dotted edge needs room
            // to read as a line rather than as a smudge.
            indent={16}
            onExpandedChange={(ids, change) => {
              setExpanded(ids.map(String));
              if (change.open) load(change.item);
            }}
            onSelect={(id, item) => {
              setSelected(String(id));
              setDetails('');
              if (!item.dir) {
                stat(item.path).then(
                  (st) =>
                    setDetails(
                      `${st.size.toLocaleString()} bytes · modified ${st.mtime.toLocaleString()}`,
                    ),
                  (err: Error) => setDetails(err.message),
                );
              }
            }}
            // The node's glyph: a folder that opens, or a page. `state.color`
            // is the row's ink, and it has to be passed by name — colour does
            // not cascade into a drawing the way it does into text.
            renderLabel={(state: TreeRowState<Entry>) => (
              <box
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  flexShrink: 1,
                  minWidth: 0,
                }}
              >
                <canvas
                  mono
                  cacheKey={
                    state.branch
                      ? state.open
                        ? 'folderOpen'
                        : 'folder'
                      : 'file'
                  }
                  onDraw={
                    state.branch
                      ? state.open
                        ? glyphs.folderOpen
                        : glyphs.folder
                      : glyphs.file
                  }
                  style={{
                    width: 14,
                    height: 14,
                    flexShrink: 0,
                    // A folder is the accent colour when it is not on the
                    // selected row, which is where the eye goes first in
                    // every file manager; a page keeps the row's own ink.
                    color: state.selected
                      ? state.color
                      : state.branch
                        ? '$accent'
                        : state.color,
                  }}
                />
                {/* `textWrap: 'nowrap'` is on the default label, and a
                    `renderLabel` replaces the default label — so it has to
                    say it again. Without it a name too long for the pane
                    wraps to a second line inside a box that is `rowHeight`
                    tall: the row clips, so what you see is a horizontal slice
                    through two half-lines. One line, clipped at the pane's
                    edge, is what a file browser shows; drag the divider to
                    read the rest. */}
                <text
                  style={{ flexShrink: 1, minWidth: 0, textWrap: 'nowrap' }}
                >
                  {state.item.name}
                </text>
              </box>
            )}
            // The branch edge. `continues` says whether a line passes through
            // this column at all, and `own` marks the row's own column — the
            // one that gets the connector into the twisty.
            renderGuide={(guide: TreeGuideState<Entry>) => {
              const kind = guide.own
                ? guide.continues
                  ? 'tee'
                  : 'elbow'
                : guide.continues
                  ? 'through'
                  : null;
              if (!kind) return null;
              return (
                <canvas
                  mono
                  // Everything the drawing reads is in the key: the shape and
                  // the box. Nothing else changes it.
                  cacheKey={`edge:${kind}:${guide.width}x${guide.height}`}
                  onDraw={edges[kind]}
                  style={{
                    flexGrow: 1,
                    alignSelf: 'stretch',
                    color: '$border',
                  }}
                />
              );
            }}
          />
        </box>

        <box style={{ flexGrow: 1, padding: 20, gap: 8 }}>
          <text style={{ fontSize: 15, color: '$text' }}>
            {selected ? path.basename(selected) : 'Nothing selected'}
          </text>
          <text style={{ fontSize: 11, color: '$textMuted' }}>
            {error || details || selected || 'Pick something on the left.'}
          </text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ fontSize: 11, color: '$textMuted' }}>
            Arrows walk the tree · Right opens a folder and steps in · Left
            closes it and steps out · type a name to jump to it · drag the
            divider, or focus it and use the arrows
          </text>
        </box>
      </SplitPane>
    </window>
  );
}

if (!process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<App />);
}
