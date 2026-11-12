// Run with: npm run examples:type-lab
//           (an X server / DISPLAY, or REACT_X11_BACKEND=cocoa on a Mac)
//
// A lab for the type in a chat transcript: prose (<Markdown>), code blocks
// (<Code>, as a chat draws every fence), the code editor and the composer
// (<RichTextEditor>). Each knob is a real prop or style, so a value read off
// a slider is a value an app can pass:
//
//   prose      <Markdown fontSize lineHeight>
//   code       <Code fontSize lineHeight style={{ padding, borderRadius }}>
//   editor     <CodeEditor style={{ fontSize, lineHeight }}>
//
// Line heights are multiples of the font's own line, as a <text>'s are —
// not of the font size, as in CSS. Code block padding, radius and spacing
// are in ems of the code size, so a value holds at any size; the editor
// takes the same padding, radius and line height, in its own size.
//
// The conversation is examples/type-lab.json: edit it and run again.
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Slider, Switch, ThemeProvider, createRoot, useTheme } from 'react-x11';
import { tint } from 'react-x11/style';

import { Code } from '../src/code/index.js';
import {
  CODE_LINE_HEIGHT,
  CODE_PADDING_EM,
  CODE_RADIUS_EM,
  CODE_SPACING_EM,
} from '../src/codeblock/index.js';
import { CodeEditor } from '../src/code-editor/index.js';
import { javascript } from '../src/code-language/index.js';
import { Markdown } from '../src/markdown/index.js';
import {
  RichTextEditor,
  composerSchema,
} from '../src/rich-text-editor/index.js';

const MESSAGES: { who: string; text: string }[] = JSON.parse(
  readFileSync(new URL('./type-lab.json', import.meta.url), 'utf8'),
);

const EDITOR = `function greet(name) {
  // its rows are lineHeight × the font's line, as a code block's
  return \`hello, \${name}\`;
}
`;

const COMPOSER =
  'Fix the `401` in **loadUser**, then run the tests:\n```sh\nnpm test\n```';

interface Part {
  code: boolean;
  lang: string;
  text: string;
}

/** A message's top-level fences apart from the prose around them, as a chat
 *  that draws its own code blocks splits them. */
function split(text: string): Part[] {
  const out: Part[] = [];
  const re = /```(\w*)\n([\s\S]*?)\n```/g;
  let at = 0;
  for (let m; (m = re.exec(text));) {
    if (m.index > at) {
      out.push({ code: false, lang: '', text: text.slice(at, m.index) });
    }
    out.push({ code: true, lang: m[1], text: m[2] });
    at = m.index + m[0].length;
  }
  if (at < text.length) {
    out.push({ code: false, lang: '', text: text.slice(at) });
  }
  return out;
}

function Knob(p: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** What the value comes to, beside it. */
  shows?: string;
  note?: string;
  onChange: (v: number) => void;
}): ReactElement {
  return (
    <box style={{ flexDirection: 'column', gap: 4 }}>
      <box style={{ flexDirection: 'row' }}>
        <text style={{ color: '$text', fontSize: 12, flexGrow: 1 }}>
          {p.label}
        </text>
        <text style={{ color: '$text', fontSize: 12, fontWeight: 'bold' }}>
          {p.shows ?? String(p.value)}
        </text>
      </box>
      <Slider
        value={p.value}
        min={p.min}
        max={p.max}
        step={p.step}
        onChange={(ev) => p.onChange(Number(ev.target.value))}
      />
      {p.note ? (
        <text style={{ color: '$textMuted', fontSize: 11 }}>{p.note}</text>
      ) : null}
    </box>
  );
}

/** A message: yours on a tint of the ink, a little set in, as a chat draws
 *  it — a tint rather than `$surface`, which in a light palette is the
 *  page's own white. */
function Message(p: { who: string; children: ReactNode }): ReactElement {
  const theme = useTheme() as unknown as { text?: string };
  const mine = p.who === 'You';
  return (
    <box
      style={
        mine
          ? {
              padding: 14,
              borderRadius: 12,
              backgroundColor: tint(String(theme.text ?? '#000'), 0.05),
              marginLeft: 80,
            }
          : {}
      }
    >
      <text
        style={{
          color: '$textMuted',
          fontSize: 11,
          fontWeight: 'bold',
          marginBottom: 6,
        }}
      >
        {p.who}
      </text>
      {p.children}
    </box>
  );
}

function Lab(): ReactElement {
  const [prose, setProse] = useState(14);
  const [proseLh, setProseLh] = useState(1.4);
  const [code, setCode] = useState(13);
  const [codeLh, setCodeLh] = useState(CODE_LINE_HEIGHT);
  const [pad, setPad] = useState(CODE_PADDING_EM);
  const [radius, setRadius] = useState(CODE_RADIUS_EM);
  const [space, setSpace] = useState(CODE_SPACING_EM);
  const [editor, setEditor] = useState(13);
  const [editorLh, setEditorLh] = useState(CODE_LINE_HEIGHT);
  const [dark, setDark] = useState(true);

  const em = (v: number) => Math.round(code * v);
  const ems = (v: number) => `${v}em · ${em(v)}px`;

  const part = (s: Part, i: number): ReactNode =>
    s.code ? (
      <box
        key={i}
        style={{
          borderWidth: 1,
          borderColor: '$border',
          borderRadius: em(radius),
          overflow: 'hidden',
          marginTop: em(space),
          marginBottom: em(space),
        }}
      >
        <Code
          source={s.text}
          lang={s.lang}
          fontSize={code}
          lineHeight={codeLh}
          style={{ padding: em(pad), borderRadius: em(radius) }}
        />
      </box>
    ) : (
      <Markdown
        key={i}
        source={s.text}
        partial={false}
        fontSize={prose}
        lineHeight={proseLh}
      />
    );
  const sample: ReactNode[] = MESSAGES.map((m, i) => (
    <Message key={i} who={m.who}>
      {split(m.text).map(part)}
    </Message>
  ));

  return (
    <ThemeProvider colorScheme={dark ? 'dark' : 'light'}>
      <box
        style={{
          flexDirection: 'row',
          flexGrow: 1,
          backgroundColor: '$background',
        }}
      >
        <box
          style={{
            width: 260,
            padding: 14,
            gap: 14,
            borderRightWidth: 1,
            borderRightColor: '$border',
            overflow: 'scroll',
          }}
        >
          <text style={{ color: '$text', fontSize: 15, fontWeight: 'bold' }}>
            Type lab
          </text>
          <Knob
            label="Prose size"
            value={prose}
            min={11}
            max={20}
            step={0.5}
            onChange={setProse}
          />
          <Knob
            label="Prose line height"
            value={proseLh}
            min={1}
            max={2}
            step={0.05}
            note="× the font's line · 1 is its own, 1.4 the default"
            onChange={setProseLh}
          />
          <Knob
            label="Code size"
            value={code}
            min={10}
            max={18}
            step={0.5}
            onChange={setCode}
          />
          <Knob
            label="Code line height"
            value={codeLh}
            min={1}
            max={2}
            step={0.05}
            note={`× the font's line · ${CODE_LINE_HEIGHT} the default`}
            onChange={setCodeLh}
          />
          <Knob
            label="Code padding"
            value={pad}
            min={0}
            max={1.5}
            step={0.05}
            shows={ems(pad)}
            note={`${CODE_PADDING_EM}em the default`}
            onChange={setPad}
          />
          <Knob
            label="Code corner radius"
            value={radius}
            min={0}
            max={1.2}
            step={0.05}
            shows={ems(radius)}
            note={`${CODE_RADIUS_EM}em the default`}
            onChange={setRadius}
          />
          <Knob
            label="Space around code"
            value={space}
            min={0}
            max={2}
            step={0.05}
            shows={ems(space)}
            note={`${CODE_SPACING_EM}em the default, among prose`}
            onChange={setSpace}
          />
          <Knob
            label="Editor size"
            value={editor}
            min={10}
            max={18}
            step={0.5}
            onChange={setEditor}
          />
          <Knob
            label="Editor line height"
            value={editorLh}
            min={1}
            max={2}
            step={0.05}
            note={`× the font's line · ${CODE_LINE_HEIGHT} the default`}
            onChange={setEditorLh}
          />
          <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Switch
              checked={dark}
              onChange={(ev) => setDark(Boolean(ev.target.value))}
            />
            <text style={{ color: '$text', fontSize: 12 }}>Dark</text>
          </box>
          <box style={{ gap: 4, marginTop: 4 }}>
            <text style={{ color: '$text', fontSize: 11 }}>
              Claude Code chat, in CSS px (size / line)
            </text>
            <text style={{ color: '$textMuted', fontSize: 11 }}>
              compact: prose 14/20, code 12/17
            </text>
            <text style={{ color: '$textMuted', fontSize: 11 }}>
              comfortable: prose 16/24, code 13/19
            </text>
          </box>
        </box>
        <box
          style={{
            flexGrow: 1,
            flexShrink: 1,
            padding: 18,
            gap: 14,
            overflow: 'scroll',
          }}
        >
          <text style={{ color: '$textMuted', fontSize: 11 }}>
            CONVERSATION — Markdown + Code
          </text>
          <box style={{ gap: 18 }}>{sample}</box>
          <text style={{ color: '$textMuted', fontSize: 11 }}>CODE EDITOR</text>
          <CodeEditor
            defaultValue={EDITOR}
            language={javascript()}
            style={{
              fontSize: editor,
              lineHeight: editorLh,
              height: 140,
              padding: Math.round(editor * pad),
              borderRadius: Math.round(editor * radius),
            }}
          />
          <text style={{ color: '$textMuted', fontSize: 11 }}>
            COMPOSER — RichTextEditor
          </text>
          <RichTextEditor
            format="text"
            schema={composerSchema}
            markup="markdown"
            fontSize={prose}
            defaultValue={COMPOSER}
            style={{
              minHeight: 90,
              borderWidth: 1,
              borderColor: '$border',
              borderRadius: 8,
            }}
          />
        </box>
      </box>
    </ThemeProvider>
  );
}

const root = await createRoot();
root.render(
  <window width={1120} height={880} title="Type lab — Markdown & code">
    <Lab />
  </window>,
);
