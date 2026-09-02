// Run with: npm run examples:html   (needs an X server / DISPLAY)
//
// A document with headings, a float, lists, a table, a flex row and a
// working form, rendered by <Html>. Both seams are driven for real rather
// than stubbed:
//
//   - `onResource` reads from one whitelisted directory and nothing else, so
//     the local image loads and the remote one does not. That *is* the
//     policy — the component has no network client to disable.
//   - `onScript` reports what it was handed. Nothing runs it, and the panel
//     showing the script's own text is the proof: the document says
//     `document.body.style.background = 'red'` and the window is not red.
//   - The stylesheet is light on its own and re-tints under
//     `@media (prefers-color-scheme: dark)`, which `<Html>` answers from
//     the react-x11 palette in force: run this on a dark desktop, or pin one
//     with `<ThemeProvider colorScheme="dark">`, and the boxes follow.
//
// Select across the whole document with the mouse (double-click a word,
// triple-click a block), Ctrl+A / Ctrl+C, or middle-click-paste the PRIMARY
// selection into a terminal. The form controls are real widgets: Tab moves
// through them, the select drops a real menu.
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoot } from 'react-x11';

import { Html, useHtmlHandle } from '../src/index.js';
import type {
  HtmlResourceRequest,
  HtmlResourceResult,
  HtmlScriptRequest,
} from '../src/index.js';

// The one directory resources may come from. Everything else is declined,
// which is what makes this a policy rather than a suggestion.
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/img');

const DOCUMENT = `<!doctype html>
<html>
<head>
  <title>A rendered document</title>
  <style>
    body { margin: 16px; font-size: 14px; line-height: 1.5; }
    h1 { font-size: 24px; margin: 0 0 4px; padding-bottom: 6px;
         border-bottom: 2px solid #4a90d9; }
    h2 { font-size: 17px; margin: 18px 0 6px; }
    .lead { color: #c0392b; }
    .note { border-left: 3px solid #4a90d9; background: #f2f7fc;
            padding: 8px 12px; margin: 12px 0; }
    .pull { float: right; width: 120px; height: 70px; background: #dbe7f3;
            border: 1px solid #a8bed6; margin: 0 0 8px 12px; }
    .row { display: flex; gap: 10px; margin: 12px 0; }
    .row > div { flex: 1; background: #eef2f7; border-radius: 5px;
                 padding: 8px; text-align: center; }
    .row > .wide { flex: 2; }
    table { border-collapse: collapse; margin: 10px 0; }
    th, td { border: 1px solid #b9c3ce; padding: 4px 10px; }
    th { background: #eef2f7; }
    code { font-family: monospace; background: #eef0f2; }
    form p { margin: 8px 0; }
    a { text-decoration: underline; }
    @media (max-width: 520px) { .row { display: block } }
    /* The values above are the document's light face. A dark host answers
       this query and the same boxes re-tint, the way they would in a
       browser — nothing here reads the palette directly. */
    @media (prefers-color-scheme: dark) {
      h1 { border-bottom-color: #5aa4e6; }
      .lead { color: #ec6a5e; }
      .note { border-left-color: #5aa4e6; background: #232a33; }
      .pull { background: #2a3038; border-color: #454d55; }
      .row > div { background: #2a3038; }
      th, td { border-color: #454d55; }
      th { background: #2a3038; }
      code { background: #2f3640; }
    }
  </style>
  <script>
    // Never evaluated. If it were, this window would be red.
    document.body.style.background = 'red';
  </script>
</head>
<body>
  <h1>A rendered document</h1>
  <p class="lead">Selectable text, real form controls, and
  <strong>no network access</strong> — every external reference goes through a
  seam the host controls.</p>

  <div class="pull"></div>
  <p>This paragraph flows beside a floated block, shortening its lines while
  the float is beside it and taking the full width again once it has passed.
  Block flow, margin collapsing, floats and the inline formatting context are
  this renderer's own; <code>display: flex</code> below is Yoga's, which is
  already in the process.</p>

  <h2>Lists</h2>
  <ul>
    <li>markers are chrome, so a copy of this list has no bullets in it</li>
    <li>nested lists change marker: <ul><li>circle</li></ul></li>
    <li>ordered lists count properly: <ol><li>one</li><li>two</li></ol></li>
  </ul>

  <h2>A flex row</h2>
  <div class="row">
    <div>flex: 1</div>
    <div class="wide">flex: 2</div>
    <div>flex: 1</div>
  </div>

  <h2>A table</h2>
  <table>
    <tr><th>stage</th><th>re-runs on a resize?</th></tr>
    <tr><td>parse</td><td>no</td></tr>
    <tr><td>cascade</td><td>no — unless a media band was crossed</td></tr>
    <tr><td>layout</td><td>yes</td></tr>
  </table>

  <div class="note">Resize the window: the text rewraps, the table re-sizes
  its columns, and under 520px the flex row becomes a stack. None of that
  re-parses or re-cascades.</div>

  <h2>Images go through the seam</h2>
  <p><img src="does-not-exist.png" alt="declined" width="120" height="60">
  a declined image keeps its box and draws a frame, so the document does not
  reflow under the reader when one is refused.</p>

  <h2>A form of real widgets</h2>
  <form>
    <p>Name <input type="text" size="14" value="Ada"> &nbsp;
       Role <select><option>reader</option><option>editor</option></select></p>
    <p><input type="checkbox" checked> keep me signed in &nbsp;
       <input type="radio" name="plan" checked> monthly
       <input type="radio" name="plan"> yearly</p>
    <p><button>Submit</button> &nbsp;
       <a href="https://github.com/sidorares/react-x11-components">and a link</a></p>
  </form>
</body>
</html>
`;

function App(): ReactElement {
  const handle = useHtmlHandle();
  const [log, setLog] = useState<string[]>([]);
  const say = useCallback((line: string) => {
    setLog((lines) => [line, ...lines].slice(0, 6));
  }, []);

  const onResource = useCallback(
    async (
      request: HtmlResourceRequest,
    ): Promise<HtmlResourceResult | null> => {
      // The whole policy: one directory, no traversal out of it, nothing
      // remote. A URL that escapes is declined rather than clamped, because
      // a clamped path silently loads the wrong file.
      const target = normalize(join(ASSETS, request.url));
      if (!target.startsWith(ASSETS) || /^[a-z]+:/i.test(request.url)) {
        say(`declined ${request.kind}: ${request.url}`);
        return null;
      }
      try {
        if (request.kind === 'stylesheet') {
          return { kind: 'stylesheet', text: await readFile(target, 'utf8') };
        }
        const bytes = await readFile(target);
        say(`loaded image: ${request.url}`);
        return { kind: 'image', bytes: new Uint8Array(bytes) };
      } catch {
        say(`missing ${request.kind}: ${request.url}`);
        return null;
      }
    },
    [say],
  );

  const onScript = useCallback(
    (script: HtmlScriptRequest) => {
      const what = script.src
        ? `src=${script.src}`
        : `${script.text.trim().length} chars, not run`;
      say(`script (${script.type}): ${what}`);
    },
    [say],
  );

  const status = useMemo(
    () => (log.length ? log.join('\n') : 'seam activity appears here'),
    [log],
  );

  return (
    <window title="react-x11 — <Html>" width={780} height={720}>
      <box style={{ flexDirection: 'column', flexGrow: 1 }}>
        <box style={{ overflow: 'scroll', flexGrow: 1 }}>
          <Html
            source={DOCUMENT}
            partial={false}
            ref={handle.ref}
            onResource={onResource}
            onScript={onScript}
            onLink={(href) => say(`link: ${href}`)}
            onControlChange={(element, value) => {
              say(
                `${element.name}[${element.attribs.name ?? element.attribs.type ?? ''}] = ${String(value)}`,
              );
            }}
          />
        </box>
        <box
          style={{
            flexShrink: 0,
            borderTopWidth: 1,
            borderTopColor: '$border',
            padding: 8,
            gap: 4,
            flexDirection: 'column',
            backgroundColor: '$surface',
          }}
        >
          <text style={{ fontSize: 11, color: '$textMuted' }}>
            {handle.title ?? 'no <title>'} — the window is not red, so the
            script did not run
          </text>
          <text style={{ fontSize: 11, fontFamily: 'monospace' }}>
            {status}
          </text>
        </box>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
