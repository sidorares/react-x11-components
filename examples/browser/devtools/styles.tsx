// The Styles tab: the element's own style, which it edits, and under it the
// rules that match the element in the order they win, each declaration that
// loses to another struck through (`HtmlHandle.matchedRules`, and
// `overridden` for which lose).
//
// A declaration of the element's own style is a row: a box that switches
// it off and on — kept in the attribute as a comment while it is off — its
// name and its value, each edited in place. A value that is one of a few
// keywords is a drop-down. One that is hard to write by hand — a shadow, a
// `flex`, grid tracks, a border, a background, a colour — has an editor that
// opens under its row and writes the value back as it changes.
import { useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button, Checkbox, Icon, Select, useTheme } from 'react-x11';
import type {
  KeyboardEvent as X11KeyboardEvent,
  TextInputNode,
} from 'react-x11';
import { XK_DOWN, XK_UP } from 'react-x11/keysyms';

import { ColorField } from '../../../src/color-picker/index.js';
import { registerRichText } from '../../../src/richtext/index.js';
import type { TextRun } from '../../../src/richtext/index.js';
import type {
  Element,
  HtmlHandle,
  HtmlMatchedRule,
} from '../../../src/html/index.js';
import { SuggestField, removeAttribute, setAttribute } from './attributes.js';
import { syntaxColours } from './colours.js';
import {
  editorFor,
  isColor,
  keywordsOf,
  lengthParts,
  overridden,
  parseBackground,
  parseBorder,
  parseFlex,
  parseInlineStyle,
  parseShadows,
  parseTracks,
  serializeBackground,
  serializeBorder,
  serializeFlex,
  serializeInlineStyle,
  serializeShadows,
  serializeTracks,
} from './css-values.js';
import type {
  Background,
  Border,
  EditorKind,
  InlineDeclaration,
  Shadow,
} from './css-values.js';
import { TrashGlyph } from './glyphs.js';
import type { Inspection } from './model.js';
import type { Completion } from './suggest.js';

const MONO = { fontFamily: '$monoFamily', fontSize: 12 } as const;

// a declaration that loses is struck through, which `<text>` draws no rule
// for: it is a `<richtext>` run with `strike`
registerRichText();

/** A line of code in runs, any of them struck through. */
function Runs({
  parts,
}: {
  parts: readonly { text: string; color: string; struck?: boolean }[];
}): ReactElement {
  const theme = useTheme();
  const runs: TextRun[] = parts.map((p) => ({
    text: p.text,
    color: p.color,
    family: theme.monoFamily,
    size: 12,
    ...(p.struck && { strike: p.color }),
  }));
  return <richtext runs={runs} wrap style={{ flexShrink: 1 }} />;
}

/** The element's own style, written back to its attribute — gone where it
 *  holds nothing. */
function writeStyle(
  handle: HtmlHandle,
  inspection: Inspection,
  el: Element,
  declarations: readonly InlineDeclaration[],
): void {
  const text = serializeInlineStyle(declarations);
  if (text) setAttribute(handle, inspection, el, 'style', text);
  else removeAttribute(handle, inspection, el, 'style');
}

// --- small fields ------------------------------------------------------------------

/**
 * A length, written as text, that Up and Down step: by 1, by 10 with
 * Shift and by 0.1 with Alt, its unit kept — the field a browser's tools
 * give a number.
 */
function LengthField({
  value,
  onChange,
  width = 64,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  width?: number;
  label: string;
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const step = (ev: X11KeyboardEvent<TextInputNode>) => {
    if (ev.keysym !== XK_UP && ev.keysym !== XK_DOWN) return;
    const parts = lengthParts(draft ?? value);
    if (!parts) return;
    const by =
      (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1) * (ev.keysym === XK_UP ? 1 : -1);
    const n = Math.round((parts.n + by) * 10) / 10;
    const next = `${n}${parts.unit || (n === 0 ? '' : 'px')}`;
    setDraft(null);
    onChange(next);
    ev.preventDefault();
  };
  return (
    <box style={{ gap: 2 }}>
      <text style={{ fontSize: 10, color: '$textMuted' }}>{label}</text>
      <textinput
        value={draft ?? value}
        onChange={(ev) => setDraft(ev.value)}
        onSubmit={(ev) => {
          setDraft(null);
          onChange(ev.value);
        }}
        onBlur={() => {
          if (draft !== null) onChange(draft);
          setDraft(null);
        }}
        onKeyDown={step}
        style={{ ...FIELD, width }}
      />
    </box>
  );
}

const FIELD = {
  ...MONO,
  height: 22,
  paddingLeft: 6,
  paddingRight: 6,
  borderRadius: 3,
  borderWidth: 1,
  borderColor: '$border',
  backgroundColor: '$background',
  color: '$text',
} as const;

function TextField({
  value,
  onChange,
  label,
  grow,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  grow?: boolean;
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <box
      style={{
        gap: 2,
        ...(grow && { flexGrow: 1, flexShrink: 1, minWidth: 0 }),
      }}
    >
      <text style={{ fontSize: 10, color: '$textMuted' }}>{label}</text>
      <textinput
        value={draft ?? value}
        onChange={(ev) => setDraft(ev.value)}
        onSubmit={(ev) => {
          setDraft(null);
          onChange(ev.value);
        }}
        onBlur={() => {
          if (draft !== null) onChange(draft);
          setDraft(null);
        }}
        style={{ ...FIELD, ...(grow ? { flexGrow: 1 } : { width: 120 }) }}
      />
    </box>
  );
}

function KeywordSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  label?: string;
}): ReactElement {
  // a value the list does not have is kept as one of its options, so the
  // drop-down shows what is written
  const all = options.includes(value) || !value ? options : [value, ...options];
  return (
    <box style={{ gap: 2 }}>
      {label ? (
        <text style={{ fontSize: 10, color: '$textMuted' }}>{label}</text>
      ) : null}
      <Select<string>
        value={value}
        options={all}
        onChange={(ev) => onChange(ev.value)}
        labelStyle={{ ...MONO }}
        style={{ height: 22, minWidth: 110 }}
      />
    </box>
  );
}

function ColourField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}): ReactElement {
  return (
    <box style={{ gap: 2 }}>
      {label ? (
        <text style={{ fontSize: 10, color: '$textMuted' }}>{label}</text>
      ) : null}
      <ColorField
        value={isColor(value) ? value : '#000000'}
        alpha
        onChangeEnd={(ev) => onChange(ev.value)}
      />
    </box>
  );
}

// --- the editors ----------------------------------------------------------------------

function ShadowEditor({
  value,
  onChange,
  text,
}: {
  value: string;
  onChange: (value: string) => void;
  /** A text shadow: no spread, no inset. */
  text?: boolean;
}): ReactElement {
  const shadows = parseShadows(value);
  const put = (next: Shadow[]) => onChange(serializeShadows(next, !text));
  const change = (i: number, patch: Partial<Shadow>) =>
    put(shadows.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <box style={{ gap: 8 }}>
      {shadows.map((s, i) => (
        <box
          key={i}
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          {!text ? (
            <Checkbox
              label="inset"
              checked={s.inset}
              onChange={(ev) => change(i, { inset: !!ev.target.checked })}
            />
          ) : null}
          <LengthField
            label="x"
            value={s.x}
            onChange={(x) => change(i, { x })}
          />
          <LengthField
            label="y"
            value={s.y}
            onChange={(y) => change(i, { y })}
          />
          <LengthField
            label="blur"
            value={s.blur}
            onChange={(blur) => change(i, { blur })}
          />
          {!text ? (
            <LengthField
              label="spread"
              value={s.spread}
              onChange={(spread) => change(i, { spread })}
            />
          ) : null}
          <ColourField
            label="colour"
            value={s.color}
            onChange={(color) => change(i, { color })}
          />
          <Button
            variant="ghost"
            size="small"
            aria-label="Remove this shadow"
            onPress={() => put(shadows.filter((_, j) => j !== i))}
          >
            <TrashGlyph />
          </Button>
        </box>
      ))}
      <AddButton
        label="Add a shadow"
        onPress={() =>
          put([
            ...shadows,
            {
              inset: false,
              x: '0',
              y: '2px',
              blur: '6px',
              spread: '0',
              color: 'rgba(0, 0, 0, 0.25)',
            },
          ])
        }
      />
    </box>
  );
}

function FlexEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  const flex = parseFlex(value);
  const put = (patch: Partial<typeof flex>) =>
    onChange(serializeFlex({ ...flex, ...patch }));
  return (
    <box style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
      <LengthField
        label="grow"
        value={flex.grow}
        onChange={(grow) => put({ grow })}
      />
      <LengthField
        label="shrink"
        value={flex.shrink}
        onChange={(shrink) => put({ shrink })}
      />
      <TextField
        label="basis"
        value={flex.basis}
        onChange={(basis) => put({ basis })}
      />
      <box style={{ flexDirection: 'row', gap: 2 }}>
        {(['none', 'auto', '1'] as const).map((preset) => (
          <Button
            key={preset}
            variant="ghost"
            size="small"
            onPress={() => onChange(preset)}
          >
            {preset}
          </Button>
        ))}
      </box>
    </box>
  );
}

/** The tracks of a grid template, each a field, and a strip that draws
 *  their shares: `fr` tracks by their fraction, lengths by their size. */
function TracksEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  const theme = useTheme();
  const tracks = parseTracks(value);
  const put = (next: string[]) => onChange(serializeTracks(next));
  return (
    <box style={{ gap: 8 }}>
      <box
        style={{
          flexDirection: 'row',
          height: 18,
          gap: 2,
          borderWidth: 1,
          borderColor: '$border',
          padding: 2,
        }}
      >
        {tracks.map((t, i) => {
          const fr = /^(\d*\.?\d+)fr$/.exec(t);
          const px = lengthParts(t);
          return (
            <box
              key={i}
              style={{
                ...(fr
                  ? { flexGrow: Number(fr[1]), flexBasis: 0 }
                  : px && px.unit === 'px'
                    ? { width: Math.min(px.n / 4, 120), flexShrink: 0 }
                    : { flexGrow: 1, flexBasis: 0 }),
                backgroundColor: theme.accent,
                opacity: fr ? 0.55 : 0.35,
                borderRadius: 2,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <text
                style={{
                  fontSize: 9,
                  color: theme.accentText,
                  textWrap: 'nowrap',
                  maxLines: 1,
                }}
              >
                {t}
              </text>
            </box>
          );
        })}
      </box>
      <box
        style={{
          flexDirection: 'row',
          gap: 6,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
        }}
      >
        {tracks.map((t, i) => (
          <box
            key={`${i}:${t}`}
            style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1 }}
          >
            <TextField
              label={`track ${i + 1}`}
              value={t}
              onChange={(next) =>
                put(tracks.map((x, j) => (j === i ? next : x)))
              }
            />
            <Button
              variant="ghost"
              size="small"
              aria-label={`Remove track ${i + 1}`}
              onPress={() => put(tracks.filter((_, j) => j !== i))}
            >
              <Icon name="close" size={7} />
            </Button>
          </box>
        ))}
        <AddButton
          label="Add a track"
          onPress={() => put([...tracks, '1fr'])}
        />
      </box>
    </box>
  );
}

const BORDER_STYLES = [
  'none',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
  'hidden',
];

function BorderEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  const border = parseBorder(value);
  const put = (patch: Partial<Border>) =>
    onChange(serializeBorder({ ...border, ...patch }));
  return (
    <box style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
      <LengthField
        label="width"
        value={border.width}
        onChange={(width) => put({ width })}
      />
      <KeywordSelect
        label="style"
        value={border.style}
        options={BORDER_STYLES}
        onChange={(style) => put({ style })}
      />
      <ColourField
        label="colour"
        value={border.color}
        onChange={(color) => put({ color })}
      />
    </box>
  );
}

function BackgroundEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  const background = parseBackground(value)!;
  const put = (patch: Partial<Background>) =>
    onChange(serializeBackground({ ...background, ...patch }));
  return (
    <box style={{ gap: 8 }}>
      <box style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
        <ColourField
          label="colour"
          value={background.color || 'transparent'}
          onChange={(color) => put({ color })}
        />
        <TextField
          label="image"
          value={background.image}
          onChange={(image) => put({ image })}
          grow
        />
      </box>
      <box
        style={{
          flexDirection: 'row',
          gap: 8,
          alignItems: 'flex-end',
          flexWrap: 'wrap',
        }}
      >
        <KeywordSelect
          label="position"
          value={background.position || '0% 0%'}
          options={[
            '0% 0%',
            'center',
            'top',
            'bottom',
            'left',
            'right',
            'top left',
            'bottom right',
          ]}
          onChange={(position) => put({ position })}
        />
        <KeywordSelect
          label="size"
          value={background.size || 'auto'}
          options={['auto', 'cover', 'contain', '100% 100%']}
          onChange={(size) => put({ size: size === 'auto' ? '' : size })}
        />
        <KeywordSelect
          label="repeat"
          value={background.repeat || 'repeat'}
          options={[
            'repeat',
            'no-repeat',
            'repeat-x',
            'repeat-y',
            'space',
            'round',
          ]}
          onChange={(repeat) =>
            put({ repeat: repeat === 'repeat' ? '' : repeat })
          }
        />
      </box>
    </box>
  );
}

function AddButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}): ReactElement {
  return (
    <box
      role="button"
      aria-label={label}
      onClick={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        height: 22,
        cursor: 'pointer',
      }}
    >
      <Icon name="plus" size={8} />
      <text style={{ fontSize: 12, color: '$accent' }}>{label}</text>
    </box>
  );
}

function ValueEditor({
  kind,
  value,
  onChange,
}: {
  kind: EditorKind;
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  switch (kind) {
    case 'shadow':
      return <ShadowEditor value={value} onChange={onChange} />;
    case 'text-shadow':
      return <ShadowEditor value={value} onChange={onChange} text />;
    case 'flex':
      return <FlexEditor value={value} onChange={onChange} />;
    case 'tracks':
      return <TracksEditor value={value} onChange={onChange} />;
    case 'border':
      return <BorderEditor value={value} onChange={onChange} />;
    case 'background':
      return <BackgroundEditor value={value} onChange={onChange} />;
    case 'color':
      return <ColourField value={value} onChange={onChange} />;
  }
}

// --- the element's own style --------------------------------------------------------

/** A value's swatch, where it is a colour, and the button that opens its
 *  editor: the mark of a value that has one. */
function EditorMark({
  kind,
  value,
  open,
  onToggle,
}: {
  kind: EditorKind;
  value: string;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  const swatch = kind === 'color' && isColor(value);
  return (
    <box
      role="button"
      aria-label={open ? 'Close the editor' : 'Open the editor'}
      aria-expanded={open}
      onClick={onToggle}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        borderRadius: 3,
        borderWidth: 1,
        borderColor: open ? '$accent' : '$border',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        ...(swatch
          ? { backgroundColor: value }
          : { backgroundColor: '$surface' }),
      }}
    >
      {!swatch ? <EditorGlyph kind={kind} /> : null}
    </box>
  );
}

/** What each editor's mark draws: a shadow's drop, a flex's arrows. */
function EditorGlyph({ kind }: { kind: EditorKind }): ReactElement {
  const theme = useTheme();
  return (
    <canvas
      style={{ width: 10, height: 10 }}
      onDraw={(ctx, info) => {
        const s = info.width / 10;
        ctx.strokeStyle = theme.textMuted;
        ctx.fillStyle = theme.textMuted;
        ctx.lineWidth = info.scale;
        if (kind === 'shadow' || kind === 'text-shadow') {
          ctx.globalAlpha = 0.4;
          ctx.fillRect(3 * s, 3 * s, 6 * s, 6 * s);
          ctx.globalAlpha = 1;
          ctx.strokeRect(1.5 * s, 1.5 * s, 5.5 * s, 5.5 * s);
        } else if (kind === 'tracks') {
          for (const x of [1, 4, 7]) ctx.fillRect(x * s, 1.5 * s, 2 * s, 7 * s);
        } else if (kind === 'flex') {
          ctx.fillRect(1 * s, 3 * s, 3 * s, 4 * s);
          ctx.fillRect(5 * s, 3 * s, 4 * s, 4 * s);
        } else if (kind === 'border') {
          ctx.strokeRect(1.5 * s, 1.5 * s, 7 * s, 7 * s);
        } else {
          ctx.fillRect(1 * s, 1 * s, 8 * s, 8 * s);
        }
      }}
    />
  );
}

/** The property names the name field completes from: every one the
 *  element's computed style has. */
function propertyCompletion(handle: HtmlHandle, el: Element): Completion {
  return {
    items: Object.keys(handle.computedStyle(el) ?? {})
      .filter((p) => !p.startsWith('--'))
      .sort()
      .map((text) => ({ text })),
    separator: null,
  };
}

function DeclarationRow({
  handle,
  inspection,
  element,
  declaration,
  onChange,
  onRemove,
  colours,
}: {
  handle: HtmlHandle;
  inspection: Inspection;
  element: Element;
  declaration: InlineDeclaration;
  onChange: (next: InlineDeclaration) => void;
  onRemove: () => void;
  colours: ReturnType<typeof syntaxColours>;
}): ReactElement {
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState<'name' | 'value' | null>(null);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const { name, value, enabled } = declaration;
  const keywords = keywordsOf(name);
  const kind = editorFor(name, value);
  const theme = useTheme();
  const faded = enabled ? {} : { color: '$textMuted' };
  return (
    <box>
      <box
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          minHeight: 22,
          paddingLeft: 4,
          paddingRight: 4,
          ...(hover && { backgroundColor: '$surfaceHover' }),
        }}
      >
        <Checkbox
          aria-label={enabled ? `Switch ${name} off` : `Switch ${name} on`}
          checked={enabled}
          onChange={(ev) =>
            onChange({ ...declaration, enabled: !!ev.target.checked })
          }
        />
        {editing === 'name' ? (
          <SuggestField
            value={draft}
            onChange={setDraft}
            onCommit={(next) => {
              setEditing(null);
              if (next.trim()) onChange({ ...declaration, name: next.trim() });
            }}
            onCancel={() => setEditing(null)}
            completion={() => propertyCompletion(handle, element)}
            autoFocus
            width={150}
          />
        ) : (
          <box
            role="button"
            aria-label={`Edit the name ${name}`}
            onClick={() => {
              setDraft(name);
              setEditing('name');
            }}
            style={{ flexShrink: 0, cursor: 'text' }}
          >
            <text style={{ ...MONO, color: colours.attr, ...faded }}>
              {name}
            </text>
          </box>
        )}
        <text style={{ ...MONO, color: '$textMuted' }}>:</text>
        {kind && editing !== 'value' ? (
          <EditorMark
            kind={kind}
            value={value}
            open={open}
            onToggle={() => setOpen(!open)}
          />
        ) : null}
        {keywords && editing !== 'value' ? (
          <KeywordSelect
            value={value}
            options={keywords}
            onChange={(next) => onChange({ ...declaration, value: next })}
          />
        ) : editing === 'value' ? (
          <SuggestField
            value={draft}
            onChange={setDraft}
            onCommit={(next) => {
              setEditing(null);
              onChange({ ...declaration, value: next.trim() });
            }}
            onCancel={() => setEditing(null)}
            completion={() => ({
              items: (keywords ?? []).map((text) => ({ text })),
              separator: null,
            })}
            autoFocus
          />
        ) : (
          <box
            role="button"
            aria-label={`Edit ${name}`}
            onClick={() => {
              setDraft(value);
              setEditing('value');
            }}
            style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, cursor: 'text' }}
          >
            <Runs
              parts={[
                {
                  text: `${value}${declaration.important ? ' !important' : ''};`,
                  color: enabled ? theme.text : theme.textMuted,
                  struck: !enabled,
                },
              ]}
            />
          </box>
        )}
        {keywords ? <box style={{ flexGrow: 1 }} /> : null}
        <box style={{ width: 24, flexShrink: 0, alignItems: 'flex-end' }}>
          {hover && !editing ? (
            <Button
              variant="ghost"
              size="small"
              aria-label={`Remove ${name}`}
              onPress={onRemove}
            >
              <TrashGlyph />
            </Button>
          ) : null}
        </box>
      </box>
      {open && kind ? (
        <box
          style={{
            marginLeft: 28,
            marginRight: 8,
            marginBottom: 6,
            padding: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: '$border',
            backgroundColor: '$surface',
          }}
        >
          <ValueEditor
            kind={kind}
            value={value}
            onChange={(next) => onChange({ ...declaration, value: next })}
          />
        </box>
      ) : null}
    </box>
  );
}

function InlineStyle({
  handle,
  inspection,
  element,
}: {
  handle: HtmlHandle;
  inspection: Inspection;
  element: Element;
}): ReactElement {
  const colours = syntaxColours(useTheme());
  const declarations = parseInlineStyle(element.attribs.style ?? '');
  const [adding, setAdding] = useState<'name' | 'value' | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const put = (next: InlineDeclaration[]) =>
    writeStyle(handle, inspection, element, next);
  return (
    <Card title="element.style" note="the element’s own" editable>
      {declarations.map((d, i) => (
        <DeclarationRow
          key={`${i}:${d.name}`}
          handle={handle}
          inspection={inspection}
          element={element}
          declaration={d}
          colours={colours}
          onChange={(next) =>
            put(declarations.map((x, j) => (j === i ? next : x)))
          }
          onRemove={() => put(declarations.filter((_, j) => j !== i))}
        />
      ))}
      {adding === 'name' ? (
        <box
          style={{
            flexDirection: 'row',
            paddingLeft: 28,
            gap: 4,
            minHeight: 24,
            alignItems: 'center',
          }}
        >
          <SuggestField
            value={name}
            onChange={setName}
            onCommit={(next) => {
              if (!next.trim()) return setAdding(null);
              setName(next.trim());
              setAdding('value');
            }}
            onCancel={() => setAdding(null)}
            completion={() => propertyCompletion(handle, element)}
            placeholder="property"
            autoFocus
            width={160}
          />
        </box>
      ) : adding === 'value' ? (
        <box
          style={{
            flexDirection: 'row',
            paddingLeft: 28,
            gap: 4,
            minHeight: 24,
            alignItems: 'center',
          }}
        >
          <text style={{ ...MONO, color: colours.attr }}>{name}</text>
          <text style={{ ...MONO, color: '$textMuted' }}>:</text>
          <SuggestField
            value={value}
            onChange={setValue}
            onCommit={(next) => {
              setAdding(null);
              setValue('');
              setName('');
              if (next.trim()) {
                put([
                  ...declarations,
                  { name, value: next.trim(), important: false, enabled: true },
                ]);
              }
            }}
            onCancel={() => setAdding(null)}
            completion={() => ({
              items: (keywordsOf(name) ?? []).map((text) => ({ text })),
              separator: null,
            })}
            placeholder="value"
            autoFocus
          />
        </box>
      ) : (
        <box style={{ paddingLeft: 28 }}>
          <AddButton
            label="Add a declaration"
            onPress={() => setAdding('name')}
          />
        </box>
      )}
    </Card>
  );
}

// --- the matched rules --------------------------------------------------------------

function Card({
  title,
  note,
  media,
  editable,
  children,
}: {
  title: string;
  note?: string;
  media?: string | null;
  editable?: boolean;
  children: ReactNode;
}): ReactElement {
  const colours = syntaxColours(useTheme());
  return (
    <box
      style={{
        flexShrink: 0,
        borderBottomWidth: 1,
        borderColor: '$border',
        paddingTop: 6,
        paddingBottom: 6,
        ...(editable && { backgroundColor: '$background' }),
      }}
    >
      {media ? (
        <text
          style={{
            ...MONO,
            fontSize: 11,
            color: '$textMuted',
            paddingLeft: 10,
          }}
        >
          {`@media ${media}`}
        </text>
      ) : null}
      <box
        style={{
          flexDirection: 'row',
          paddingLeft: 10,
          paddingRight: 10,
          gap: 6,
        }}
      >
        <text
          selectable
          style={{ ...MONO, color: colours.tag, flexGrow: 1, flexShrink: 1 }}
        >
          {`${title} {`}
        </text>
        {note ? (
          <text style={{ fontSize: 11, color: '$textMuted', flexShrink: 0 }}>
            {note}
          </text>
        ) : null}
      </box>
      <box
        style={{
          paddingLeft: editable ? 4 : 24,
          paddingTop: 2,
          paddingBottom: 2,
        }}
      >
        {children}
      </box>
      <text style={{ ...MONO, color: colours.tag, paddingLeft: 10 }}>
        {'}'}
      </text>
    </box>
  );
}

const ORIGIN_NOTES: Record<HtmlMatchedRule['origin'], string> = {
  inline: 'the element’s own',
  author: '',
  presentation: 'from its attributes',
  'user-agent': 'user agent stylesheet',
};

function RuleCard({
  rule,
  losing,
  filter,
}: {
  rule: HtmlMatchedRule;
  losing: readonly boolean[];
  filter: string;
}): ReactElement | null {
  const theme = useTheme();
  const colours = syntaxColours(theme);
  const shown = rule.declarations
    .map((d, i) => ({ d, lost: losing[i] }))
    .filter(
      ({ d }) =>
        !filter || d.property.includes(filter) || d.value.includes(filter),
    );
  if (filter && !shown.length) return null;
  return (
    <Card
      title={rule.selector ?? 'attribute styles'}
      note={`${ORIGIN_NOTES[rule.origin]}${
        rule.origin === 'author' ? `(${rule.specificity.join(', ')})` : ''
      }`}
      media={rule.media}
    >
      {shown.map(({ d, lost }, i) => (
        <Runs
          key={i}
          parts={[
            {
              text: d.property,
              color: lost ? theme.textMuted : colours.attr,
              struck: lost,
            },
            {
              text: `: ${d.value}${d.important ? ' !important' : ''};`,
              color: lost ? theme.textMuted : theme.text,
              struck: lost,
            },
          ]}
        />
      ))}
    </Card>
  );
}

// --- the pane ------------------------------------------------------------------------

export function StylesPane({
  handle,
  inspection,
  element,
  version,
}: {
  handle: HtmlHandle;
  inspection: Inspection;
  element: Element;
  /** Bumped when the panel reads the document again. */
  version: number;
}): ReactElement {
  const [filter, setFilter] = useState('');
  const rules = useMemo(
    () => (handle.document ? handle.matchedRules(element) : []),
    [element, version],
  );
  const losing = useMemo(() => overridden(rules), [rules]);
  const q = filter.trim().toLowerCase();
  return (
    <box style={{ flexGrow: 1, minHeight: 0 }}>
      <box style={{ padding: 6, flexShrink: 0 }}>
        <textinput
          value={filter}
          placeholder="Filter"
          onChange={(ev) => setFilter(ev.value)}
          style={{
            height: 24,
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
      </box>
      <box style={{ overflow: 'scroll', flexGrow: 1, minHeight: 0 }}>
        <box style={{ flexShrink: 0 }}>
          <InlineStyle
            handle={handle}
            inspection={inspection}
            element={element}
          />
          {rules.map((rule, i) =>
            rule.origin === 'inline' ? null : (
              <RuleCard key={i} rule={rule} losing={losing[i]} filter={q} />
            ),
          )}
        </box>
      </box>
    </box>
  );
}
