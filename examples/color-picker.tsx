// Run with: npm run examples:color-picker   (needs an X server / DISPLAY)
//
// The ladder in one window: the panel on its own, the same panel with alpha
// and swatches, the palette-only shape, and the popup form — every one of
// them the same component with one more prop on it.
//
// The eyedropper button appears by itself wherever core can sample the
// screen (react-x11#360). Press it and the pointer takes a crosshair; click
// anywhere on the desktop and the colour lands in the picker.
import { useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot, useTheme } from 'react-x11';

import { ColorPicker, ColorField, contrastRatio } from '../src/index.js';

const BRAND = [
  '#2980b9',
  '#27ae60',
  '#c0392b',
  '#8e44ad',
  '#f39c12',
  '#16a085',
  '#2c3e50',
  '#7f8c8d',
];

function Swatch({
  colour,
  label,
}: {
  colour: string;
  label: string;
}): ReactElement {
  const theme = useTheme();
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <box
        style={{
          width: 44,
          height: 28,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: theme.radius,
          backgroundColor: colour,
        }}
      />
      <box>
        <text style={{ fontSize: 11, color: theme.textMuted }}>{label}</text>
        <text style={{ fontFamily: theme.monoFamily }}>{colour}</text>
      </box>
    </box>
  );
}

function App(): ReactElement {
  const theme = useTheme();
  const [accent, setAccent] = useState('#2980b9');
  const [fill, setFill] = useState('rgba(41, 128, 185, 0.4)');
  const [committed, setCommitted] = useState(fill);
  const [recent, setRecent] = useState<string[]>([]);

  const remember = (colour: string): void =>
    setRecent((list) =>
      [colour, ...list.filter((c) => c !== colour)].slice(0, 8),
    );

  const ratio = contrastRatio(accent, theme.background) ?? 0;

  return (
    <window width={1180} height={600} title="@react-x11/components — colour">
      <box style={{ flexGrow: 1, padding: 16, gap: 16, flexDirection: 'row' }}>
        <box style={{ gap: 8 }}>
          <text style={{ fontWeight: 'bold' }}>Rung 0 — a colour</text>
          <ColorPicker
            value={accent}
            onChange={(ev) => setAccent(ev.value)}
            onChangeEnd={(ev) => remember(ev.value)}
            contrast={theme.background}
          />
          <Swatch
            colour={accent}
            label={`accent · ${ratio.toFixed(1)}:1 on the page`}
          />
        </box>

        <box style={{ gap: 8 }}>
          <text style={{ fontWeight: 'bold' }}>
            …with alpha, swatches, recents
          </text>
          <ColorPicker
            value={fill}
            onChange={(ev) => setFill(ev.value)}
            // `onChangeEnd` is the one an expensive consumer wants: it fires
            // on the release, not on every pointer step of the drag.
            onChangeEnd={(ev) => {
              setCommitted(ev.value);
              remember(ev.value);
            }}
            alpha
            swatches={BRAND}
            recent={recent}
          />
          <Swatch colour={committed} label="committed on release" />
        </box>

        <box style={{ gap: 16, width: 260 }}>
          <box style={{ gap: 8 }}>
            <text style={{ fontWeight: 'bold' }}>The popup form</text>
            <ColorField
              value={accent}
              onChange={(ev) => setAccent(ev.value)}
              swatches={BRAND}
              style={{ width: 220 }}
            />
          </box>

          <box style={{ gap: 8 }}>
            <text style={{ fontWeight: 'bold' }}>Palette only</text>
            <ColorPicker
              value={accent}
              onChange={(ev) => setAccent(ev.value)}
              swatches={BRAND}
              parts={['swatches']}
              style={{ padding: 0 }}
            />
          </box>

          <box style={{ gap: 8 }}>
            <text style={{ fontWeight: 'bold' }}>Disabled</text>
            <ColorField value={accent} disabled style={{ width: 220 }} />
          </box>
        </box>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
