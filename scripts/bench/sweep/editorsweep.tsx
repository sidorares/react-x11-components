// One cell of the editors sweep, on whichever backend REACT_X11_BACKEND names.
// Prints one JSON line; `lat` is from an input to the end of the flush that
// first painted after it.
//   COMP=code  <CodeEditor> with javascript({ typescript: true }), lineNumbers
//     LINES    lines of generated TypeScript (default 50,000)
//     PLAIN=1  no language: the same file, untokenized
//     ACTION   mount        render; time to the first painted frame and to idle
//              scroll       wheel down, 60 notches a second
//              type-end     a character at the end of the file every 16 ms
//              type-start   a character at the start of line 1 every 16 ms
//              type-mid     …in the middle of the file, the caret revealed
//              undo         mid-file, a character and its undo, every 50 ms
//              long-mount   one line of LONG chars (default 1,000,000)
//              long-type    a character at the end of that line every 16 ms
//              replace      select all + replace with the same text, every 250 ms
//   COMP=rte   <RichTextEditor> over the generated report (./docgen.ts)
//     SIZE     sections (default 300)
//     ACTION   mount | scroll | type-mid (a character mid-document every 16 ms)
//              type-hidden (the same, into a block the window is not drawing)
//              type-long (a character at the end of one LONG-char paragraph)
//              bold-all (select all, toggle bold, every 500 ms)
//              paste (insert a 100 KB markdown chunk mid-document, every 1 s)
import * as gen from './docgen.js';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { createRoot } from 'react-x11';
import { WindowNode } from 'react-x11/node';
process.env.REACT_X11_NO_AUTORUN = '1';
// The tree under test: this checkout by default, or another one's root
// when the probe is copied into that tree's node_modules/.bench (README).
const ROOT =
  process.env.BENCH_ROOT ??
  fileURLToPath(new URL('../../../', import.meta.url));
const COMP = process.env.COMP ?? 'code';
const ACTION = process.env.ACTION ?? 'mount';
const h = React.createElement;
const W = 1100,
  H = 780;

const frames: { t: number; end: number; ms: number }[] = [];
const damage = { passes: 0, area: 0, full: 0, frames: 0 };
const byKind: Record<string, { frames: number; area: number }> = {};
let frameKind = 'none';
let blitted = false;
if (process.env.DAMAGE === '1') {
  const proto = (WindowNode as any).prototype;
  const inner = proto._paintRegion;
  proto._paintRegion = function (
    this: any,
    ctx: any,
    rect: any,
    w: number,
    h: number,
  ) {
    damage.passes++;
    const a = rect ? (rect.width * rect.height) / (w * h) : 1;
    if (!rect) damage.full++;
    damage.area += a;
    const k = blitted ? 'blit' : frameKind;
    (byKind[k] ??= { frames: 0, area: 0 }).area += a;
    return inner.call(this, ctx, rect, w, h);
  };
  const apply = proto._applyScrollBlits;
  proto._applyScrollBlits = function (this: any, ...a: any[]) {
    const p = this._pendingScrolls;
    const from = p?.size ? [...p][0]._pendingBlitFrom : undefined;
    frameKind = !p?.size
      ? 'no-scroll'
      : from?.poisoned
        ? 'poisoned'
        : from
          ? 'declined'
          : 'unarmed';
    const d0 = this._damage;
    const r = apply.apply(this, a);
    if (p !== undefined && frameKind === 'declined' && this._damage !== d0)
      blitted = true;
    return r;
  };
  const inv = proto.invalidate;
  proto.invalidate = function (
    this: any,
    layoutChanged: any,
    dmg: any,
    reason: any,
    source: any,
  ) {
    try {
      const b = dmg && dmg._claimBounds ? dmg._claimBounds() : dmg;
      const W = this.abs?.width || 1,
        H = this.abs?.height || 1;
      const frac =
        b && b.width ? (b.width * b.height) / (W * H) : dmg == null ? 1 : 0;
      if (process.env.TIMELINE === '1') {
        const who = (dmg && dmg.kind) || (dmg == null ? 'null' : 'rect');
        ((globalThis as any).__claims ??= []).push(
          `${reason ?? '-'} ${who}${source?.kind ? ' src=' + source.kind : ''} ${b && b.width ? Math.round(b.width) + 'x' + Math.round(b.height) + '@' + Math.round(b.y) : dmg == null ? 'ALL' : '0'} laidOut=${this._laidOut}`,
        );
      }
      if (frac > 0.3) {
        const who =
          (dmg && dmg.kind) ||
          (source && source.kind) ||
          (dmg == null ? 'null' : 'rect');
        const k = `${reason ?? '-'} ${who}${source && dmg && !dmg.kind ? ' src=' + source.kind : ''} ${frac >= 0.95 ? 'FULL' : Math.round(frac * 100) + '%'}`;
        const c = (calls['claim ' + k] ??= { n: 0, ms: 0 });
        c.n++;
      }
    } catch {}
    return inv.call(this, layoutChanged, dmg, reason, source);
  };
  const tl: string[] = [];
  (globalThis as any).__tl = tl;
  if (process.env.TIMELINE === '1') {
    const take = proto._takeDamage;
    proto._takeDamage = function (this: any, ...a: any[]) {
      const d = take.apply(this, a);
      ((globalThis as any).__claims ??= []).push(
        'DAMAGE ' +
          (d
            ? d
                .map(
                  (r: any) =>
                    `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`,
                )
                .join(' ')
            : 'FULL'),
      );
      return d;
    };
    const { Node: NodeClass } = await import('react-x11/node');
    const assign = (NodeClass as any).prototype._assignAbs;
    const { layoutDiff } = await import(
      `${ROOT}/node_modules/react-x11/src/nodes/damage.js`
    );
    (NodeClass as any).prototype._assignAbs = function (
      this: any,
      x: number,
      y: number,
      w: number,
      h: number,
    ) {
      const old = this.abs;
      const sh = (layoutDiff as any).shift;
      if (
        sh &&
        old &&
        old.width > 0 &&
        (old.y + sh.y !== y || old.height !== h)
      ) {
        ((globalThis as any).__claims ??= []).push(
          `OFF ${this.kind} dy=${(y - (old.y + sh.y)).toFixed(2)} dh=${(h - old.height).toFixed(2)} at y=${Math.round(y)}`,
        );
      }
      const moved =
        !old ||
        old.x !== x ||
        old.y !== y ||
        old.width !== w ||
        old.height !== h;
      if (moved && w * h > 200000)
        ((globalThis as any).__claims ??= []).push(
          `ABS ${this.kind} ${old ? `${Math.round(old.x)},${Math.round(old.y)} ${Math.round(old.width)}x${Math.round(old.height)}` : '-'} -> ${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}`,
        );
      return assign.call(this, x, y, w, h);
    };
  }
  const flush = proto._flushFrame;
  proto._flushFrame = function (this: any, ...a: any[]) {
    frameKind = 'none';
    blitted = false;
    const tl0 = (globalThis as any).__tl as string[];
    if (process.env.TIMELINE === '1')
      tl0.push(
        `${(performance.now() % 100000).toFixed(1)} FLUSH start pending=${this._pendingScrolls?.size ?? 0}`,
      );
    const r = flush.apply(this, a);
    if (process.env.TIMELINE === '1') {
      const cl = ((globalThis as any).__claims ?? []) as string[];
      const k = blitted ? 'blit' : frameKind;
      // where the content is: the pane's offset, and the first drawn block
      // whose top is inside the viewport — its y on screen and its key
      let pane: any = null;
      const find = (n: any) => {
        if (!pane && n?.style?.overflow === 'scroll' && !n.isWindow) pane = n;
        for (const c of n?.children ?? []) find(c);
      };
      find(this);
      let probe = '';
      if (pane) {
        const col = pane.children?.[0];
        const kids = col?.children ?? [];
        for (const c of kids) {
          if (c.abs && c.abs.y >= pane.abs.y && c.abs.height > 0) {
            probe = `first=${Math.round(c.abs.y)}h${Math.round(c.abs.height)} kids=${kids.length} top=${Math.round(kids[0]?.abs?.height ?? -1)}`;
            break;
          }
        }
        probe = `scrollY=${pane.scrollY} ${probe}`;
      }
      tl0.push(
        `${(performance.now() % 100000).toFixed(1)} FLUSH end kind=${k} painted=${r} claims=${cl.length} ${probe}`,
      );
      if (k !== 'blit' && process.env.CLAIMS === '1') {
        const agg = new Map<string, number>();
        for (const c of cl) {
          const key = c
            .replace(/\d+x\d+@-?\d+(,-?\d+)?/g, 'R')
            .replace(/-?\d+,-?\d+ \d+x\d+ -> -?\d+,-?\d+ \d+x\d+/, 'MOVE');
          agg.set(key, (agg.get(key) ?? 0) + 1);
        }
        for (const [c, n] of agg) tl0.push(`     ${n}x ${c}`);
        for (const c of cl
          .filter((c) => c.startsWith('scroll') || c.startsWith('DAMAGE'))
          .slice(0, 3))
          tl0.push('       ' + c);
      }
      (globalThis as any).__claims = [];
    }
    if (r)
      (byKind[blitted ? 'blit' : frameKind] ??= { frames: 0, area: 0 })
        .frames++;
    return r;
  };
}
let windowNode: any = null;
{
  const inner = (WindowNode as any).prototype._flushFrame;
  (WindowNode as any).prototype._flushFrame = function (
    this: any,
    ...a: any[]
  ) {
    windowNode ??= this;
    const t0 = performance.now();
    const painted = inner.apply(this, a);
    const end = performance.now();
    if (painted) frames.push({ t: t0, end, ms: end - t0 });
    return painted;
  };
}

// --- the code: a TypeScript file, every construct the tokenizer has a state for
function tsFile(lines: number): string {
  const out: string[] = [];
  let i = 0;
  while (out.length < lines) {
    out.push(
      `/** Measures block ${i}: the floors, the spans, the ${i % 7} passes. */`,
    );
    out.push(
      `export function measure${i}(node: Node, width: number): Extent {`,
    );
    out.push(
      `  const span = node.children.reduce((a, c) => a + c.extent * ${i % 13}, 0);`,
    );
    out.push(
      `  if (span > ${i * 3} && width !== 0) return { width, height: span / 2 }; // clamp`,
    );
    out.push(
      `  const label = \`block \${node.kind}\` + "${'x'.repeat(i % 20)}";`,
    );
    out.push(
      `  return { width: Math.max(width, ${i}.5), height: [1, 2, 3].length };`,
    );
    out.push('}');
    out.push('');
    i++;
  }
  return out.slice(0, lines).join('\n');
}
function longLine(chars: number): string {
  const parts: string[] = [];
  let n = 0,
    i = 0;
  while (n < chars) {
    const s = `var a${i}=function(b,c){return b*${i}+c.x${i % 9}||"s${i}"};`;
    parts.push(s);
    n += s.length;
    i++;
  }
  return parts.join('').slice(0, chars);
}

const calls: Record<string, { n: number; ms: number }> = {};
if (process.env.DIAG === '1' && COMP === 'code') {
  const { CodeEditorNode } = await import(`${ROOT}/src/code-editor/node.js`);
  for (const name of [
    '_caretX',
    '_lineEntry',
    '_posAt',
    'paint',
    '_revealCaret',
    '_scrollCaretIntoView',
    'insertText',
    'select',
  ]) {
    const inner = CodeEditorNode.prototype[name];
    if (typeof inner !== 'function') continue;
    CodeEditorNode.prototype[name] = function (this: any, ...a: any[]) {
      const t = performance.now();
      try {
        return inner.apply(this, a);
      } finally {
        const c = (calls[name] ??= { n: 0, ms: 0 });
        c.n++;
        c.ms += performance.now() - t;
      }
    };
  }
}
if (process.env.RUNS === '1') {
  const { RichTextNode } = await import(`${ROOT}/src/richtext/node.js`);
  const inner = RichTextNode.prototype.applyProps;
  const same = (a: any[], b: any[]) =>
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((r, i) => {
      const q = b[i];
      const ka = Object.keys(r),
        kb = Object.keys(q);
      return ka.length === kb.length && ka.every((k) => r[k] === q[k]);
    });
  RichTextNode.prototype.applyProps = function (
    this: any,
    next: any,
    prev: any,
  ) {
    if (next.runs !== prev.runs) {
      const k = same(next.runs, prev.runs)
        ? 'runs.newArraySameContent'
        : 'runs.changed';
      const c = (calls[k] ??= { n: 0, ms: 0 });
      c.n++;
    }
    return inner.call(this, next, prev);
  };
}
const handle: { current: any } = { current: null };
const wref: { current: any } = { current: null };
let initial = '';
let element: React.ReactElement;
if (COMP === 'code') {
  const { CodeEditor, javascript } = await import(
    `${ROOT}/src/code-editor/index.js`
  );
  const long = ACTION.startsWith('long');
  initial = long
    ? longLine(Number(process.env.LONG ?? 1_000_000))
    : tsFile(Number(process.env.LINES ?? 50_000));
  element = h(CodeEditor, {
    ref: handle,
    defaultValue: initial,
    language:
      process.env.PLAIN === '1' ? null : javascript({ typescript: true }),
    lineNumbers: true,
    style: { flexGrow: 1 },
  });
} else {
  const { RichTextEditor } = await import(
    `${ROOT}/src/rich-text-editor/index.js`
  );
  const secs = gen.sections(Number(process.env.SIZE ?? 300));
  initial = gen.markdownDoc(secs);
  if (ACTION === 'type-long') {
    const para = Array.from({ length: 2000 }, (_, i) => `word${i % 97}`)
      .join(' ')
      .slice(0, Number(process.env.LONG ?? 50_000));
    initial = `# A long paragraph\n\n${para}\n\nAfter it.\n`;
  }
  element = h(RichTextEditor, {
    ref: handle,
    defaultValue: initial,
    style: { flexGrow: 1 },
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = async (gap: number, max: number) => {
  const start = performance.now();
  for (;;) {
    await wait(50);
    const last = frames.length ? frames[frames.length - 1].end : start;
    if (performance.now() - last > gap || performance.now() - start > max)
      return;
  }
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const q = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
};

const root = await createRoot({ glPolicy: 'auto' });
const c0 = process.cpuUsage();
const tMount = performance.now();
root.render(
  h(
    'window',
    { ref: wref, width: W, height: H, x: 20, y: 40, title: 'editorsweep' },
    h('box', { style: { flexGrow: 1, padding: 8 } }, element),
  ),
);
await quiet(1000, 60000);
const mountCpu = process.cpuUsage(c0);
const mountFrames = frames.filter((f) => f.t >= tMount);
const out: any = {
  suite: 'editors',
  comp: COMP,
  action: ACTION,
  chars: initial.length,
  variant: [
    process.env.PLAIN === '1' ? 'plain' : '',
    process.env.SIZE ? `size ${process.env.SIZE}` : '',
    process.env.LINES ? `${process.env.LINES} lines` : '',
  ]
    .filter(Boolean)
    .join(', '),
  backend: typeof wref.current?.app?._route === 'function' ? 'cocoa' : 'x11',
  firstPaint: r2(mountFrames.length ? mountFrames[0].end - tMount : NaN),
  firstFlush: r2(mountFrames.length ? mountFrames[0].ms : NaN),
  idle: r2(
    mountFrames.length ? mountFrames[mountFrames.length - 1].end - tMount : NaN,
  ),
  mountFrames: mountFrames.length,
  mountCpu: Math.round((mountCpu.user + mountCpu.system) / 1000),
};

if (ACTION !== 'mount' && ACTION !== 'long-mount') {
  const ed = handle.current;
  const wnd = wref.current;
  if (process.env.DIAG === '1') {
    let edNode: any = null;
    const walkN = (n: any) => {
      if (typeof n?._lineEntry === 'function') edNode = n;
      for (const c of n?.children ?? []) walkN(c);
    };
    walkN(wnd);
    edNode ??= typeof ed?._lineEntry === 'function' ? ed : null;
    if (edNode && COMP === 'code') {
      const bump = (k: string) => {
        const c = (calls[k] ??= { n: 0, ms: 0 });
        c.n++;
      };
      const m = edNode._lineCache as Map<number, unknown>;
      const oc = m.clear.bind(m),
        od = m.delete.bind(m);
      m.clear = () => {
        bump(
          'lineCache.clear:' +
            (new Error().stack!.split('\n')[2] ?? '').trim().slice(0, 90),
        );
        oc();
      };
      m.delete = (k: number) => {
        bump('lineCache.delete');
        return od(k);
      };
      const why: Record<string, number> = {};
      const inner = edNode._lineEntry;
      edNode._lineEntry = function (this: any, line: number) {
        const c = this._lineCache.get(line);
        if (!c) {
          why.absent = (why.absent ?? 0) + 1;
          if (this._lineCache !== m) why.replaced = (why.replaced ?? 0) + 1;
          (why as any).size = this._lineCache.size;
          (why as any).lastLine = line;
          (why as any).keys = [...this._lineCache.keys()].slice(0, 5);
        } else {
          const tokens = this._tokenizer()?.lineTokens(line) ?? [];
          if (c.raw !== this._lines[line]) why.raw = (why.raw ?? 0) + 1;
          else if (c.tabSize !== this._tabSize()) why.tab = (why.tab ?? 0) + 1;
          else if (c.tokens !== tokens) why.tokens = (why.tokens ?? 0) + 1;
          else if (c.styleKey !== this._metricsKey) {
            why.style = (why.style ?? 0) + 1;
            (why as any).sample = [c.styleKey, this._metricsKey];
          } else why.hit = (why.hit ?? 0) + 1;
        }
        return inner.call(this, line);
      };
      const sb = edNode._scrollByDevice;
      const deltas: number[] = [];
      edNode._scrollByDevice = function (this: any, dx: number, dy: number) {
        deltas.push(dy);
        return sb.call(this, dx, dy);
      };
      process.on('exit', () =>
        console.log(
          'WHY ' +
            JSON.stringify(why) +
            ' scrolls ' +
            deltas.length +
            ' dy ' +
            JSON.stringify(deltas.slice(0, 6)) +
            ' lineH ' +
            edNode._lineH +
            ' scrollY ' +
            edNode._scrollY,
        ),
      );
    }
    const fonts = wnd.app.fonts;
    const inner = fonts.layout.bind(fonts);
    const lru = fonts._layouts as Map<string, unknown> | undefined;
    fonts.layout = (spans: any, base: any, o?: any) => {
      const t = performance.now();
      const before = lru?.size;
      try {
        return inner(spans, base, o);
      } finally {
        const c = (calls['fonts.layout'] ??= { n: 0, ms: 0 });
        c.n++;
        c.ms += performance.now() - t;
        const mw = o?.maxWidth;
        const k =
          mw === undefined || mw === null || !Number.isFinite(mw)
            ? 'layout.oneLine'
            : mw <= 0
              ? 'layout.minContent'
              : 'layout.wrapped';
        const d = (calls[k] ??= { n: 0, ms: 0 });
        d.n++;
        d.ms += performance.now() - t;
        if (process.env.STACKS === '1') {
          const st = (new Error().stack ?? '')
            .split('\n')
            .slice(3, 9)
            .map((l) => l.trim().replace(/\(.*\/(src|node_modules)\//, '($1/'))
            .join(' < ');
          const sk =
            k +
            ' w=' +
            (typeof mw === 'number' ? Math.round(mw) : mw) +
            ' :: ' +
            st;
          const e = (calls[sk] ??= { n: 0, ms: 0 });
          e.n++;
        }
        void before;
      }
    };
  }
  const cocoa = typeof wnd.app?._route === 'function';
  const s = wnd.scale ?? 1;
  const tm = () => Date.now() & 0x7fffffff;
  const DUR = Number(process.env.DUR ?? 4000);
  // Setup that is not the measured action: the caret put mid-document and
  // scrolled to, so the blocks around it are mounted before the clock runs.
  if (COMP === 'rte' && ACTION === 'type-mid') {
    const { TextSelection } = await import('prosemirror-state');
    const view = ed.view;
    const doc = view.state.doc;
    let pos = Math.floor(doc.content.size / 2);
    if (!doc.resolve(pos).parent.inlineContent)
      pos = Math.min(doc.content.size, pos + 1);
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, pos))
        .scrollIntoView(),
    );
    await quiet(300, 5000);
    for (const k of Object.keys(calls)) delete calls[k];
  }
  const marks: number[] = [];
  const f0 = frames.length;
  const c1 = process.cpuUsage();
  const t0 = performance.now();
  const every = (ms: number, fn: (i: number) => void) =>
    new Promise<void>((done) => {
      let i = 0;
      const timer = setInterval(() => {
        if (performance.now() - t0 >= DUR) {
          clearInterval(timer);
          done();
          return;
        }
        marks.push(performance.now());
        fn(i++);
      }, ms);
    });
  if (process.env.TIMELINE === '1') {
    // every scrollTo on a node, with who asked
    const tl = (globalThis as any).__tl as string[];
    let pane: any = null;
    const find = (n: any) => {
      if (!pane && n?.style?.overflow === 'scroll' && n !== wnd) pane = n;
      for (const c of n?.children ?? []) find(c);
    };
    find(wnd);
    if (pane) {
      const st = pane.scrollTo.bind(pane);
      pane.scrollTo = (...a: any[]) => {
        const who = (new Error().stack ?? '')
          .split('\n')
          .slice(2, 6)
          .map((l) =>
            l
              .trim()
              .replace(/^at /, '')
              .replace(/\(.*\/(src|node_modules)\//, '($1/')
              .replace(/:\d+\)$/, ')'),
          )
          .join(' < ');
        tl.push(
          `${(performance.now() % 100000).toFixed(1)} scrollTo ${JSON.stringify(a[0])} from=${pane.scrollY} laidOut=${wnd._laidOut} :: ${who.slice(0, 220)}`,
        );
        return st(...a);
      };
    }
    const Rec = await import('react-x11');
    void Rec;
  }
  const wheel = () => {
    const cx = W / 2,
      cy = H / 2;
    if (cocoa)
      wnd.app._route({
        type: 'wheel',
        handle: wnd._key,
        x: cx,
        y: cy,
        gx: cx,
        gy: cy,
        dx: 0,
        dy: -1,
        precise: false,
        time: tm(),
      });
    else
      wnd.emit('wheel', {
        name: 'wheel',
        x: Math.round(cx * s),
        y: Math.round(cy * s),
        rootx: 0,
        rooty: 0,
        buttons: 0,
        deltaX: 0,
        deltaY: 1,
        deltaMode: 'line',
        smooth: false,
        source: 'button',
        time: tm(),
      });
  };
  if (COMP === 'code') {
    const lines = ed.lines ?? initial.split('\n');
    const lineCount = Array.isArray(lines)
      ? lines.length
      : initial.split('\n').length;
    const at = (line: number, ch: number) => ({ line, ch });
    if (ACTION === 'scroll') await every(16, wheel);
    else if (ACTION === 'type-end' || ACTION === 'long-type') {
      const last = lineCount - 1;
      const end = at(last, (Array.isArray(lines) ? lines[last] : '').length);
      ed.select(end, end);
      await every(16, () => ed.insertText('x'));
    } else if (ACTION === 'type-start') {
      ed.select(at(0, 0), at(0, 0));
      await every(16, () => ed.insertText('x'));
    } else if (ACTION === 'type-mid') {
      const mid = Math.floor(lineCount / 2);
      ed.select(at(mid, 0), at(mid, 0));
      await every(16, () => ed.insertText('x'));
    } else if (ACTION === 'undo') {
      const mid = Math.floor(lineCount / 2);
      ed.select(at(mid, 0), at(mid, 0));
      await every(50, (i) => {
        if (i % 2 === 0) ed.insertText('x');
        else ed.undo();
      });
    } else if (ACTION === 'replace') {
      await every(250, () => {
        ed.selectAll();
        ed.insertText(initial);
      });
    }
  } else {
    const { AllSelection, TextSelection } = await import('prosemirror-state');
    const view = ed.view;
    const midPos = () => {
      const doc = view.state.doc;
      let pos = Math.floor(doc.content.size / 2);
      // a text position: walk to the next textblock start
      const $p = doc.resolve(pos);
      return $p.parent.inlineContent
        ? pos
        : Math.min(doc.content.size, pos + 1);
    };
    if (ACTION === 'scroll') await every(16, wheel);
    else if (ACTION === 'type-mid') {
      // typing where the caret is shown (set up before the clock)
      await every(16, () =>
        view.dispatch(view.state.tr.insertText('x').scrollIntoView()),
      );
    } else if (ACTION === 'type-hidden') {
      // typing into a block the window is not drawing: the cost of a
      // transaction with nothing to paint
      const at = midPos();
      await every(16, (i) =>
        view.dispatch(view.state.tr.insertText('x', at + i)),
      );
    } else if (ACTION === 'type-long') {
      // the end of the long paragraph: the second block
      const para = view.state.doc.child(1);
      const start = view.state.doc.child(0).nodeSize + 1;
      await every(16, (i) =>
        view.dispatch(
          view.state.tr.insertText('x', start + para.content.size + i),
        ),
      );
    } else if (ACTION === 'bold-all') {
      await every(500, () => {
        view.dispatch(
          view.state.tr.setSelection(new AllSelection(view.state.doc)),
        );
        ed.toggleMark('strong');
      });
    } else if (ACTION === 'paste') {
      const chunk = gen.markdownDoc(gen.sections(50, 7));
      await every(1000, () => {
        const at = midPos();
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.near(view.state.doc.resolve(at)),
          ),
        );
        ed.insertContent(chunk);
      });
    }
  }
  await quiet(300, 8000);
  const cu = process.cpuUsage(c1);
  const dt = (performance.now() - t0) / 1000;
  const run = frames.slice(f0);
  const lats: number[] = [];
  for (const m of marks) {
    const f = run.find((x) => x.end > m);
    if (f) lats.push(f.end - m);
  }
  const iv = run.slice(1).map((f, i) => f.t - run[i].t);
  Object.assign(out, {
    inputs: marks.length,
    fps: r2(run.length / dt),
    p50: r2(q(iv, 0.5)),
    p95: r2(q(iv, 0.95)),
    frame50: r2(
      q(
        run.map((f) => f.ms),
        0.5,
      ),
    ),
    frame95: r2(
      q(
        run.map((f) => f.ms),
        0.95,
      ),
    ),
    frameMax: r2(Math.max(...run.map((f) => f.ms))),
    lat50: r2(q(lats, 0.5)),
    lat95: r2(q(lats, 0.95)),
    latMax: r2(Math.max(...lats)),
    cpu: Math.round((cu.user + cu.system) / 1e4 / dt),
  });
}
if ((globalThis as any).__gate) out.gates = (globalThis as any).__gate;
if (process.env.DAMAGE === '1')
  out.byKind = Object.fromEntries(
    Object.entries(byKind).map(([k, v]) => [
      k,
      { frames: v.frames, windows: Math.round(v.area * 100) / 100 },
    ]),
  );
if (process.env.DAMAGE === '1')
  out.damage = {
    passes: damage.passes,
    fullPasses: damage.full,
    windowsPainted: Math.round(damage.area * 100) / 100,
  };
if (process.env.TIMELINE === '1') {
  const tl = (globalThis as any).__tl as string[];
  const mid = Math.floor(tl.length / 2);
  console.log(tl.slice(mid, mid + 70).join('\n'));
}
console.log('RESULT ' + JSON.stringify(out));
if (process.env.DIAG === '1')
  console.log(
    'CALLS ' +
      JSON.stringify(
        Object.fromEntries(
          Object.entries(calls).map(([k, v]) => [
            k,
            { n: v.n, ms: Math.round(v.ms) },
          ]),
        ),
      ),
  );
process.exit(0);
