// The Console panel: what the tab's pages wrote to their console, and a
// prompt that runs JavaScript in the page shown.
//
// What is typed runs in the document's own realm through `<Html>`'s
// `evaluate` — the page's scripts' engine, at the page's global scope, under
// the timeout every script of the page's runs under — and what comes back
// is a string the realm wrote, never a page's object. So the prompt answers
// only where the page's scripts run, which the toolbar's JS switch decides
// for its site: a console with nothing to run in says so rather than
// pretending to evaluate.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Icon, useTheme } from 'react-x11';
import type {
  KeyboardEvent as X11KeyboardEvent,
  ScrollableNode,
} from 'react-x11';
import { XK_DOWN, XK_KP_ENTER, XK_RETURN, XK_UP } from 'react-x11/keysyms';

import {
  CodeEditor,
  javascript,
  keywordCompletionSource,
} from '../../../src/code-editor/index.js';
import type { CodeEditorHandle } from '../../../src/code-editor/index.js';
import { autoTokenStyles, codeRuns } from '../../../src/code-language/index.js';
import type { HtmlHandle } from '../../../src/html/index.js';
import { useStore } from './model.js';
import type { ConsoleEntry, ConsoleLevel, ConsoleLog } from './model.js';

const MONO = { fontFamily: '$monoFamily', fontSize: 12 } as const;

/** The language the prompt and what it echoes are highlighted in, made
 *  once: a `Language` keeps the tokenizer state its lines are read with. */
const JS = javascript();
const COMPLETIONS = [keywordCompletionSource()];

/** How many lines the prompt grows to before it scrolls. */
const MOST_PROMPT_LINES = 8;

/** The mark and the colours a message is drawn in, by its level. A
 *  warning's and an error's marks are drawn (`LevelGlyph`): they are nouns,
 *  which core's icon set has none of, and a font may have no ⚠ either. */
function lookOf(level: ConsoleLevel): {
  mark: string;
  ink: string;
  ground?: string;
  rule: string;
} {
  switch (level) {
    case 'warn':
      return {
        mark: '',
        ink: '$warning',
        ground: 'rgba(255, 200, 0, 0.12)',
        rule: 'rgba(255, 200, 0, 0.35)',
      };
    case 'error':
      return {
        mark: '',
        ink: '$danger',
        ground: 'rgba(255, 0, 0, 0.07)',
        rule: 'rgba(255, 0, 0, 0.22)',
      };
    case 'input':
      return { mark: '›', ink: '$text', rule: '$border' };
    case 'result':
      return { mark: '‹', ink: '$text', rule: '$border' };
    case 'navigation':
      return { mark: '', ink: '$accent', rule: '$border' };
    case 'debug':
    case 'info':
    case 'log':
      return { mark: '', ink: '$text', rule: '$border' };
  }
}

function Message({
  entry,
  styles,
}: {
  entry: ConsoleEntry;
  styles: ReturnType<typeof autoTokenStyles>;
}): ReactElement {
  const theme = useTheme();
  const look = lookOf(entry.level);
  const code = entry.level === 'input' || entry.level === 'result';
  // what was typed, and what it came to, highlighted as the prompt is
  const runs = useMemo(
    () =>
      code
        ? codeRuns(entry.text, 'js', {
            styles,
            color: theme.text,
            language: JS,
          })
        : null,
    [entry.text, code, styles, theme.text],
  );
  return (
    <box
      style={{
        flexDirection: 'row',
        flexShrink: 0,
        gap: 6,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        borderBottomWidth: 1,
        borderColor: look.rule,
        ...(look.ground && { backgroundColor: look.ground }),
      }}
    >
      {entry.level === 'warn' || entry.level === 'error' ? (
        <LevelGlyph level={entry.level} />
      ) : (
        <text
          style={{
            ...MONO,
            width: 12,
            flexShrink: 0,
            color: entry.level === 'input' ? '$accent' : '$textMuted',
          }}
        >
          {look.mark}
        </text>
      )}
      <text
        selectable
        style={{
          ...MONO,
          flexGrow: 1,
          flexShrink: 1,
          color: look.ink,
          ...(entry.level === 'navigation' && { fontStyle: 'italic' }),
        }}
      >
        {runs
          ? runs.map((run, i) => (
              <text
                key={i}
                style={{
                  color: run.color ?? theme.text,
                  ...(run.weight &&
                    run.weight >= 600 && { fontWeight: 'bold' }),
                  ...(run.style === 'italic' && { fontStyle: 'italic' }),
                }}
              >
                {run.text}
              </text>
            ))
          : entry.text}
      </text>
      {entry.count > 1 ? (
        <box
          style={{
            flexShrink: 0,
            alignSelf: 'flex-start',
            paddingLeft: 5,
            paddingRight: 5,
            borderRadius: 7,
            backgroundColor: '$surfaceHover',
          }}
        >
          <text style={{ fontSize: 10, color: '$textMuted' }}>
            {String(entry.count)}
          </text>
        </box>
      ) : null}
    </box>
  );
}

/** A warning's triangle and an error's disc, each with its mark cut out. */
function LevelGlyph({ level }: { level: 'warn' | 'error' }): ReactElement {
  const theme = useTheme();
  const fill = level === 'warn' ? theme.warning : theme.danger;
  return (
    <box
      style={{ width: 12, height: 15, flexShrink: 0, justifyContent: 'center' }}
    >
      <canvas
        style={{ width: 11, height: 11 }}
        onDraw={(ctx, info) => {
          const w = info.width;
          const c = w / 2;
          ctx.fillStyle = fill;
          ctx.beginPath();
          if (level === 'warn') {
            ctx.moveTo(c, 0.5 * info.scale);
            ctx.lineTo(w - 0.5 * info.scale, w - info.scale);
            ctx.lineTo(0.5 * info.scale, w - info.scale);
            ctx.closePath();
          } else ctx.arc(c, c, c, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = level === 'warn' ? '#000' : '#fff';
          ctx.lineWidth = 1.4 * info.scale;
          ctx.lineCap = 'round';
          ctx.beginPath();
          if (level === 'warn') {
            ctx.moveTo(c, w * 0.36);
            ctx.lineTo(c, w * 0.62);
            ctx.moveTo(c, w * 0.76);
            ctx.lineTo(c, w * 0.78);
          } else {
            const d = w * 0.2;
            ctx.moveTo(c - d, c - d);
            ctx.lineTo(c + d, c + d);
            ctx.moveTo(c + d, c - d);
            ctx.lineTo(c - d, c + d);
          }
          ctx.stroke();
        }}
      />
    </box>
  );
}

export function ConsolePanel({
  handle,
  log,
  shown,
  focusSeq,
}: {
  handle: HtmlHandle;
  log: ConsoleLog;
  /** Whether the panel is the one in view. */
  shown: boolean;
  /** Bumped when the browser asks for the console: the prompt takes the
   *  focus. */
  focusSeq: number;
}): ReactElement {
  const theme = useTheme();
  const styles = useMemo(
    () => autoTokenStyles(theme.background),
    [theme.background],
  );
  const entries = useStore(log);
  const [code, setCode] = useState('');
  const editor = useRef<CodeEditorHandle | null>(null);
  const list = useRef<ScrollableNode | null>(null);
  // the list follows what arrives while it is scrolled to its end, and
  // stays where it was put while someone reads further up
  const following = useRef(true);
  // what was typed before, for Up and Down; `at` is where Up has gone
  const history = useRef<string[]>([]);
  const at = useRef(-1);
  const draft = useRef('');

  useLayoutEffect(() => {
    if (following.current) list.current?.scrollTo(Infinity);
  }, [entries]);
  useEffect(() => {
    if (shown && focusSeq) editor.current?.focus();
  }, [focusSeq, shown]);

  const run = (text: string) => {
    if (!text.trim()) return;
    history.current = [
      ...history.current.filter((h) => h !== text),
      text,
    ].slice(-100);
    at.current = -1;
    log.write('input', text);
    const answer = handle.evaluate(text);
    if (!answer) {
      log.write(
        'error',
        handle.document
          ? 'Scripts do not run on this page, so there is nothing to run this in: the toolbar’s JS switch turns them on for its site.'
          : 'There is no page to run this in.',
      );
    } else log.write(answer.threw ? 'error' : 'result', answer.text);
    following.current = true;
    setCode('');
  };

  const onKeyDown = (ev: X11KeyboardEvent) => {
    const lines = code.split('\n');
    const caret = editor.current?.selection.head;
    if (
      (ev.keysym === XK_RETURN || ev.keysym === XK_KP_ENTER) &&
      !ev.shiftKey
    ) {
      // Enter runs it, and Shift+Enter is a new line, as a browser's
      // console has them
      ev.preventDefault();
      run(code);
      return;
    }
    // Up on the first line and Down on the last walk what was typed before
    if (ev.keysym === XK_UP && caret?.line === 0 && history.current.length) {
      ev.preventDefault();
      if (at.current < 0) {
        draft.current = code;
        at.current = history.current.length;
      }
      at.current = Math.max(0, at.current - 1);
      setCode(history.current[at.current]);
      return;
    }
    if (
      ev.keysym === XK_DOWN &&
      caret?.line === lines.length - 1 &&
      at.current >= 0
    ) {
      ev.preventDefault();
      at.current += 1;
      if (at.current >= history.current.length) {
        at.current = -1;
        setCode(draft.current);
      } else setCode(history.current[at.current]);
    }
  };

  const promptLines = Math.min(
    MOST_PROMPT_LINES,
    Math.max(1, code.split('\n').length),
  );

  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
          gap: 6,
          paddingLeft: 4,
          paddingRight: 8,
          height: 28,
          borderBottomWidth: 1,
          borderColor: '$border',
          backgroundColor: '$surface',
        }}
      >
        <Button
          variant="ghost"
          size="small"
          aria-label="Clear the console"
          onPress={() => log.clear()}
        >
          <Icon name="close" size={8} />
        </Button>
        <text style={{ fontSize: 12, color: '$textMuted', flexGrow: 1 }}>
          {`${entries.length} message${entries.length === 1 ? '' : 's'}`}
        </text>
      </box>
      <box
        ref={list}
        style={{ overflow: 'scroll', flexGrow: 1, minHeight: 0 }}
        onScroll={(ev) => {
          following.current =
            ev.scrollY + ev.viewportHeight >= ev.contentHeight - 4;
        }}
      >
        {entries.map((entry) => (
          <Message key={entry.id} entry={entry} styles={styles} />
        ))}
      </box>
      <box
        style={{
          flexDirection: 'row',
          flexShrink: 0,
          gap: 6,
          paddingLeft: 8,
          paddingTop: 4,
          paddingBottom: 4,
          borderTopWidth: 1,
          borderColor: '$border',
        }}
      >
        <text style={{ ...MONO, color: '$accent', paddingTop: 2 }}>›</text>
        <CodeEditor
          ref={editor}
          language={JS}
          tokenStyles={styles}
          completionSources={COMPLETIONS}
          autoComplete={false}
          value={code}
          onChange={(ev) => setCode(ev.value)}
          onKeyDown={onKeyDown}
          rows={promptLines}
          placeholder="Run JavaScript in this page"
          matchBrackets
          style={{
            flexGrow: 1,
            flexShrink: 1,
            fontFamily: '$monoFamily',
            fontSize: 12,
            borderWidth: 0,
            backgroundColor: 'transparent',
          }}
        />
      </box>
    </box>
  );
}
