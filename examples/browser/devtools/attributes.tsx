// The Attributes tab: the chosen element's attributes, each one's value
// edited in place and completed from what it can mean in this document
// (`suggest.ts`), copied or removed from icons shown on hover, and a row
// to add one; and, under them, the element's text where its only child is
// text.
//
// An edit is made to the document as `<Html>` holds it: the attribute or
// the text node changed, and the handle told what changed (`refresh` with
// its records), so only what a selector testing it reaches is styled
// again. A page's own `MutationObserver`s do not hear it, nor do its
// custom elements' reactions run: it is the host's edit, not a script's.
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Icon, useClipboard, useTheme } from 'react-x11';
import type {
  DrawnNode,
  KeyboardEvent as X11KeyboardEvent,
  TextInputNode,
} from 'react-x11';
import {
  XK_DOWN,
  XK_ESCAPE,
  XK_KP_ENTER,
  XK_RETURN,
  XK_TAB,
  XK_UP,
} from 'react-x11/keysyms';

import type { Element, HtmlHandle } from '../../../src/html/index.js';
import {
  accept,
  filtered,
  nameCompletion,
  valueCompletion,
} from './suggest.js';
import type { Completion, Suggestion } from './suggest.js';
import { syntaxColours } from './colours.js';
import type { Inspection } from './model.js';

const MONO = { fontFamily: '$monoFamily', fontSize: 12 } as const;

// --- changing the document ------------------------------------------------------

function setAttribute(
  handle: HtmlHandle,
  inspection: Inspection,
  el: Element,
  name: string,
  value: string,
): void {
  const oldValue = el.attribs[name] ?? null;
  if (oldValue === value) return;
  el.attribs[name] = value;
  handle.refresh([
    { type: 'attributes', target: el, attributeName: name, oldValue },
  ]);
  inspection.touch();
}

function removeAttribute(
  handle: HtmlHandle,
  inspection: Inspection,
  el: Element,
  name: string,
): void {
  if (!(name in el.attribs)) return;
  const oldValue = el.attribs[name];
  delete el.attribs[name];
  handle.refresh([
    { type: 'attributes', target: el, attributeName: name, oldValue },
  ]);
  inspection.touch();
}

/** The element's text, where its one child is a text node. */
function onlyText(el: Element): { data: string } | null {
  if (el.children.length !== 1) return null;
  const child = el.children[0];
  return child.type === 'text' ? (child as unknown as { data: string }) : null;
}

// --- a field that completes ----------------------------------------------------

/**
 * A `<textinput>` and, under it while it has the focus, the suggestions
 * for what it holds: Down and Up walk them, Enter or Tab takes the one lit,
 * a click takes one, and Escape puts them away — or, with none showing,
 * gives the edit up. Enter with none lit is the edit's commit. The list is
 * a `<popup>` placed under the field, which leaves the keyboard with it.
 */
function SuggestField({
  value,
  onChange,
  onCommit,
  onCancel,
  completion,
  placeholder,
  autoFocus,
  width,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Enter, or the focus leaving: `next` where Tab asked for the field
   *  after it. */
  onCommit: (value: string, next?: boolean) => void;
  onCancel: () => void;
  /** Asked once the field takes the focus, since asking can cost a match
   *  of the page's rules. */
  completion: () => Completion;
  placeholder?: string;
  autoFocus?: boolean;
  width?: number;
}): ReactElement {
  const theme = useTheme();
  const field = useRef<TextInputNode | null>(null);
  const [asked, setAsked] = useState<Completion | null>(null);
  const [lit, setLit] = useState(-1);
  const [shut, setShut] = useState(false);
  const focused = useRef(false);
  // committed or given up: the focus leaving after it is no second commit
  const done = useRef(false);
  useEffect(
    () => () => {
      done.current = true;
    },
    [],
  );
  const commit = (next: string, more?: boolean) => {
    if (done.current) return;
    done.current = true;
    onCommit(next, more);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  const latest = useRef(value);
  latest.current = value;
  const items = asked && !shut ? filtered(asked, value) : [];
  useEffect(() => setLit(-1), [value]);
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, []);

  const take = (item: Suggestion) => {
    const next = accept(value, asked?.separator ?? null, item.text);
    onChange(next);
    setShut(false);
    field.current?.focus();
  };
  const onKeyDown = (ev: X11KeyboardEvent<TextInputNode>) => {
    const enter = ev.keysym === XK_RETURN || ev.keysym === XK_KP_ENTER;
    if (ev.keysym === XK_DOWN || ev.keysym === XK_UP) {
      if (!items.length) return;
      const n = items.length;
      setLit((at) =>
        ev.keysym === XK_DOWN ? (at + 1) % n : at <= 0 ? n - 1 : at - 1,
      );
      ev.preventDefault();
    } else if ((enter || ev.keysym === XK_TAB) && lit >= 0 && items[lit]) {
      take(items[lit]);
      ev.preventDefault();
    } else if (enter) {
      commit(value);
      ev.preventDefault();
    } else if (ev.keysym === XK_TAB && !ev.shiftKey) {
      commit(value, true);
      ev.preventDefault();
    } else if (ev.keysym === XK_ESCAPE) {
      if (items.length) setShut(true);
      else cancel();
      ev.preventDefault();
      ev.stopPropagation();
    }
  };

  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
      <textinput
        ref={field}
        value={value}
        placeholder={placeholder}
        onChange={(ev) => {
          setShut(false);
          onChange(ev.value);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          focused.current = true;
          setAsked((was) => was ?? completion());
        }}
        onBlur={() => {
          focused.current = false;
          // a click on a suggestion takes the focus a moment, and gives it
          // back: the edit is over only if it stays away
          setTimeout(() => {
            if (!focused.current) commit(latest.current);
          }, 150);
        }}
        style={{
          ...MONO,
          height: 20,
          paddingLeft: 4,
          paddingRight: 4,
          borderRadius: 3,
          borderWidth: 1,
          borderColor: '$borderFocus',
          backgroundColor: '$background',
          color: '$text',
          ...(width ? { width } : { flexGrow: 1 }),
        }}
      />
      {items.length ? (
        <popup
          // a popup is a window of its own, with no palette but the one
          // handed over
          theme={theme as unknown as Record<string, string | number>}
          width={300}
          anchor={{ to: field, placement: 'bottom', align: 'start' }}
          style={{ backgroundColor: '$background' }}
        >
          <box
            role="listbox"
            style={{
              flexGrow: 1,
              padding: 3,
              borderWidth: 1,
              borderColor: '$border',
              backgroundColor: '$background',
            }}
          >
            {items.map((item, i) => (
              <box
                key={item.text}
                role="option"
                aria-selected={i === lit}
                onMouseEnter={() => setLit(i)}
                onMouseDown={() => take(item)}
                style={{
                  flexDirection: 'row',
                  gap: 8,
                  paddingLeft: 6,
                  paddingRight: 6,
                  paddingTop: 2,
                  paddingBottom: 2,
                  borderRadius: 3,
                  cursor: 'pointer',
                  ...(i === lit && { backgroundColor: '$surfaceHover' }),
                }}
              >
                <text style={{ ...MONO, color: '$text', flexShrink: 0 }}>
                  {item.text}
                </text>
                {item.hint ? (
                  <text
                    style={{
                      fontSize: 11,
                      color: '$textMuted',
                      flexShrink: 1,
                      textWrap: 'nowrap',
                      maxLines: 1,
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {item.hint}
                  </text>
                ) : null}
              </box>
            ))}
          </box>
        </popup>
      ) : null}
    </box>
  );
}

// --- one attribute -------------------------------------------------------------

function AttributeRow({
  handle,
  inspection,
  element,
  name,
  value,
}: {
  handle: HtmlHandle;
  inspection: Inspection;
  element: Element;
  name: string;
  value: string;
}): ReactElement {
  const clipboard = useClipboard();
  const colours = syntaxColours(useTheme());
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const commit = (next: string) => {
    setDraft(null);
    setAttribute(handle, inspection, element, name, next);
  };
  return (
    <box
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 24,
        gap: 6,
        paddingLeft: 10,
        paddingRight: 4,
        ...(hover && !editing && { backgroundColor: '$surfaceHover' }),
      }}
    >
      <text
        style={{
          ...MONO,
          color: colours.attr,
          flexShrink: 0,
          maxWidth: 160,
          textWrap: 'nowrap',
          maxLines: 1,
          textOverflow: 'ellipsis',
        }}
      >
        {name}
      </text>
      <text style={{ ...MONO, color: '$textMuted', flexShrink: 0 }}>=</text>
      {editing ? (
        <SuggestField
          value={draft}
          onChange={setDraft}
          onCommit={commit}
          onCancel={() => setDraft(null)}
          completion={() => valueCompletion(handle, element, name)}
          autoFocus
        />
      ) : (
        <box
          role="button"
          aria-label={`Edit ${name}`}
          onClick={() => setDraft(value)}
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, cursor: 'text' }}
        >
          <text
            selectable
            style={{
              ...MONO,
              color: colours.value,
              maxLines: 3,
              textOverflow: 'ellipsis',
            }}
          >
            {value === '' ? '""' : value}
          </text>
        </box>
      )}
      {/* the row's actions, where the pointer is; held in place, so a row
          does not move as they come and go */}
      <box
        style={{
          flexDirection: 'row',
          flexShrink: 0,
          width: 52,
          justifyContent: 'flex-end',
        }}
      >
        {hover && !editing ? (
          <>
            <Button
              variant="ghost"
              size="small"
              aria-label={`Copy ${name}`}
              onPress={() => {
                clipboard.write(`${name}="${value}"`).catch(() => {});
              }}
            >
              <CopyGlyph />
            </Button>
            <Button
              variant="ghost"
              size="small"
              aria-label={`Remove ${name}`}
              onPress={() => removeAttribute(handle, inspection, element, name)}
            >
              <TrashGlyph />
            </Button>
          </>
        ) : null}
      </box>
    </box>
  );
}

// --- adding one ------------------------------------------------------------------

/**
 * The row an attribute is added from: a name, completed from what the
 * element may take, then a value, completed once the name is known — Tab
 * or Enter from the name goes to the value, and Enter there adds it.
 * Escape gives it up.
 */
function AddAttribute({
  handle,
  inspection,
  element,
  onDone,
}: {
  handle: HtmlHandle;
  inspection: Inspection;
  element: Element;
  onDone: () => void;
}): ReactElement {
  const colours = syntaxColours(useTheme());
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [step, setStep] = useState<'name' | 'value'>('name');
  return (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingLeft: 10,
        paddingRight: 8,
        minHeight: 26,
      }}
    >
      {step === 'name' ? (
        <SuggestField
          value={name}
          onChange={setName}
          onCommit={(next) => {
            const typed = next.trim();
            if (!typed) return onDone();
            // a name HTML could not have is no attribute: start again
            if (!ATTRIBUTE_NAME.test(typed)) return onDone();
            setName(typed);
            setStep('value');
          }}
          onCancel={onDone}
          completion={() => ({
            items: nameCompletion(handle, element),
            separator: null,
          })}
          placeholder="name"
          autoFocus
          width={150}
        />
      ) : (
        <>
          <text style={{ ...MONO, color: colours.attr, flexShrink: 0 }}>
            {name}
          </text>
          <text style={{ ...MONO, color: '$textMuted' }}>=</text>
          <SuggestField
            value={value}
            onChange={setValue}
            onCommit={(next) => {
              setAttribute(handle, inspection, element, name, next);
              onDone();
            }}
            onCancel={onDone}
            completion={() => valueCompletion(handle, element, name)}
            placeholder="value"
            autoFocus
          />
        </>
      )}
    </box>
  );
}

/** What an attribute's name may be: no space, quote, `>`, `/` or `=`. */
const ATTRIBUTE_NAME = /^[^\s"'>/=]+$/;

// --- the element's text ------------------------------------------------------------

/**
 * The element's text, where its only child is text, in a field: what is
 * typed is applied when the field lets the focus go or on Ctrl+Enter, and
 * Escape puts back what the document has.
 */
function TextChild({
  handle,
  inspection,
  element,
}: {
  handle: HtmlHandle;
  inspection: Inspection;
  element: Element;
}): ReactElement | null {
  const node = onlyText(element);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [element]);
  if (!node) return null;
  const text = draft ?? node.data;
  const changed = draft !== null && draft !== node.data;
  const apply = () => {
    if (!changed) return setDraft(null);
    node.data = draft;
    handle.refresh([{ type: 'characterData', target: node as never }]);
    inspection.touch();
    setDraft(null);
  };
  return (
    <box style={{ gap: 6, paddingLeft: 10, paddingRight: 10, paddingTop: 6 }}>
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <text style={{ fontSize: 11, color: '$textMuted', flexGrow: 1 }}>
          TEXT
        </text>
        {changed ? (
          <>
            <Button variant="ghost" size="small" onPress={() => setDraft(null)}>
              Revert
            </Button>
            <Button size="small" onPress={apply}>
              Apply
            </Button>
          </>
        ) : null}
      </box>
      <textarea
        value={text}
        rows={Math.min(6, Math.max(2, text.split('\n').length))}
        onChange={(ev) => setDraft(ev.value)}
        onBlur={apply}
        onKeyDown={(ev: X11KeyboardEvent<DrawnNode>) => {
          if (
            (ev.keysym === XK_RETURN || ev.keysym === XK_KP_ENTER) &&
            (ev.ctrlKey || ev.metaKey)
          ) {
            apply();
            ev.preventDefault();
          } else if (ev.keysym === XK_ESCAPE && changed) {
            setDraft(null);
            ev.preventDefault();
          }
        }}
        style={{
          ...MONO,
          paddingLeft: 6,
          paddingRight: 6,
          paddingTop: 4,
          paddingBottom: 4,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: '$border',
          backgroundColor: '$background',
          color: '$text',
        }}
      />
    </box>
  );
}

// --- the pane -----------------------------------------------------------------------

export function AttributesPane({
  handle,
  inspection,
  element,
}: {
  handle: HtmlHandle;
  inspection: Inspection;
  element: Element;
}): ReactElement {
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [element]);
  const entries = Object.entries(element.attribs);
  return (
    <box style={{ overflow: 'scroll', flexGrow: 1, minHeight: 0 }}>
      <box style={{ flexShrink: 0, paddingBottom: 10 }}>
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: 10,
            paddingRight: 4,
            height: 28,
          }}
        >
          <text style={{ fontSize: 11, color: '$textMuted', flexGrow: 1 }}>
            {`ATTRIBUTES OF <${element.name}>`}
          </text>
          <Button
            variant="ghost"
            size="small"
            aria-label="Add an attribute"
            onPress={() => setAdding(true)}
          >
            <Icon name="plus" size={9} />
          </Button>
        </box>
        {entries.length === 0 && !adding ? (
          <box style={{ paddingLeft: 10, paddingBottom: 4 }}>
            <text style={{ fontSize: 12, color: '$textMuted' }}>
              No attributes.
            </text>
          </box>
        ) : null}
        {entries.map(([name, value]) => (
          <AttributeRow
            key={name}
            handle={handle}
            inspection={inspection}
            element={element}
            name={name}
            value={value}
          />
        ))}
        {adding ? (
          <AddAttribute
            handle={handle}
            inspection={inspection}
            element={element}
            onDone={() => setAdding(false)}
          />
        ) : (
          <box
            role="button"
            onClick={() => setAdding(true)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingLeft: 10,
              height: 24,
              cursor: 'pointer',
            }}
          >
            <Icon name="plus" size={8} />
            <text style={{ fontSize: 12, color: '$accent' }}>
              Add attribute
            </text>
          </box>
        )}
        <TextChild handle={handle} inspection={inspection} element={element} />
      </box>
    </box>
  );
}

// --- glyphs ---------------------------------------------------------------------------

/** Two sheets, one over the other. */
function CopyGlyph(): ReactElement {
  const theme = useTheme();
  return (
    <canvas
      style={{ width: 12, height: 12 }}
      onDraw={(ctx, info) => {
        const s = info.width / 12;
        ctx.strokeStyle = theme.textMuted;
        ctx.lineWidth = info.scale;
        ctx.strokeRect(3.5 * s, 0.5 * s, 8 * s, 8.5 * s);
        ctx.fillStyle = theme.background;
        ctx.fillRect(0.5 * s, 3 * s, 8 * s, 8.5 * s);
        ctx.strokeRect(0.5 * s, 3 * s, 8 * s, 8.5 * s);
      }}
    />
  );
}

/** A bin with a lid. */
function TrashGlyph(): ReactElement {
  const theme = useTheme();
  return (
    <canvas
      style={{ width: 12, height: 12 }}
      onDraw={(ctx, info) => {
        const s = info.width / 12;
        ctx.strokeStyle = theme.textMuted;
        ctx.lineWidth = info.scale;
        ctx.beginPath();
        ctx.moveTo(1 * s, 2.5 * s);
        ctx.lineTo(11 * s, 2.5 * s);
        ctx.moveTo(4.5 * s, 2.5 * s);
        ctx.lineTo(4.5 * s, 0.8 * s);
        ctx.lineTo(7.5 * s, 0.8 * s);
        ctx.lineTo(7.5 * s, 2.5 * s);
        ctx.moveTo(2.5 * s, 2.5 * s);
        ctx.lineTo(3.2 * s, 11.2 * s);
        ctx.lineTo(8.8 * s, 11.2 * s);
        ctx.lineTo(9.5 * s, 2.5 * s);
        ctx.moveTo(5 * s, 5 * s);
        ctx.lineTo(5 * s, 9 * s);
        ctx.moveTo(7 * s, 5 * s);
        ctx.lineTo(7 * s, 9 * s);
        ctx.stroke();
      }}
    />
  );
}
