// <ColorField> — a `<ColorPicker>` on a `<popup>`, hung off a field that
// shows the colour and its value.
//
// This is `<DatePicker>`'s file with a different panel in it, deliberately:
// the popup lifecycle out here is subtle enough — override-redirect windows
// that never take focus, anchor tracking, dismiss-on-window-blur — that a
// second widget inventing its own would be a second set of bugs.
import React, { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createStyles } from 'react-x11/style';
import type { Style, StyleProperties } from 'react-x11/style';
import { useAnchor, useAnchorTracking, useTheme } from 'react-x11';
import type {
  AnchorOptions,
  AnchorRect,
  DrawnNode,
  KeyboardEvent,
} from 'react-x11';
import { XK_DOWN, XK_ESCAPE, XK_RETURN, XK_UP } from 'react-x11/keysyms';

import { hx } from '../internal/hx.js';
import { useDismissOnWindowBlur } from '../internal/widget.js';
import {
  ColorPicker,
  COLOR_PICKER_WIDTH,
  colorPickerHeight,
} from './ColorPicker.js';
import type {
  ColorChangeEvent,
  ColorPickerHandle,
  ColorPickerPart,
  ColorPickerProps,
} from './ColorPicker.js';
import { formatColor, parseColor } from './color.js';

// A hairline round the sheet, as the menus and `<DatePicker>` use: this
// border is where the popup meets the desktop, not a control's outline.
const SHEET_BORDER = 1;

/** `'@supports transparency'` is a real style block that `Style` does not
 *  model — the same local widening `<DatePicker>` makes, and for the same
 *  reason: installing this package should not quietly widen what type-checks
 *  in an app. */
type SupportsStyle = Style & {
  '@supports transparency'?: StyleProperties;
};

const s = createStyles({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    paddingLeft: 10,
    paddingRight: 10,
    cursor: 'pointer',
  },
  swatch: { width: 16, height: 16, flexShrink: 0 },
  label: { flexGrow: 1 },
  sheet: { flexGrow: 1, flexShrink: 1, borderWidth: SHEET_BORDER },
});

export interface ColorFieldProps extends Omit<
  ColorPickerProps,
  'focusable' | 'focusVisible' | 'ref' | 'style'
> {
  /** What the trigger says. Defaults to the value in the picker's own output
   *  spelling. */
  format?: ColorPickerProps['format'];
  /** Shown when there is no colour yet. */
  placeholder?: string;
  /** Where the sheet hangs. Defaults to below the trigger. */
  anchor?: Partial<AnchorOptions>;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  style?: Style | Style[];
}

/**
 * `<ColorField value onChange>` — the colour picker as a form control.
 *
 *   <ColorField value={fill} onChange={(ev) => setFill(ev.value)} />
 *   <ColorField … alpha swatches={brand.colors} />
 *
 * Every `<ColorPicker>` prop passes straight through, and the value has the
 * same shape here as there.
 *
 * The sheet opens on the **press**, not the release, for the reason
 * `<Select>`'s menu does. It closes on Escape, on a second press of the
 * trigger, and when the window loses focus — but *not* on a change, because
 * a colour is chosen by dragging and there is no moment at which the choice
 * is obviously finished.
 *
 * The popup is override-redirect and never takes focus, so the **trigger
 * keeps the keyboard** and hands the panel its keys: Down/Up/Enter/Space
 * open it, and once it is open the arrows drive the active axis and Tab
 * moves between them. Escape stays here.
 */
export function ColorField(props: ColorFieldProps): ReactElement {
  const {
    value,
    defaultValue,
    onChange,
    onChangeEnd,
    name,
    alpha = false,
    format = 'auto',
    swatches,
    recent,
    parts,
    eyedropper,
    contrast,
    disabled = false,
    placeholder,
    anchor: anchorOverrides,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    style,
    children,
  } = props;

  const theme = useTheme();
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [focused, setFocused] = useState(false);
  const [ownValue, setOwnValue] = useState<string | undefined>(defaultValue);
  const triggerRef = useRef<DrawnNode | null>(null);
  const pickerRef = useRef<ColorPickerHandle | null>(null);

  const measureAnchor = useAnchor(triggerRef);
  const open = openProp ?? ownOpen;
  const current = value === undefined ? ownValue : value;
  const channels = current === undefined ? null : parseColor(current);

  // The sheet is sized before it has laid anything out, so its height is
  // computed from the parts rather than measured — `colorPickerHeight` and
  // the picker read the same constants, which is what keeps a popup from
  // clipping its own swatch row.
  const shown: ColorPickerPart[] =
    parts !== undefined
      ? [...parts]
      : [
          'area',
          'hue',
          ...(alpha ? (['alpha'] as const) : []),
          'fields',
          ...(swatches?.length ? (['swatches'] as const) : []),
          ...(recent?.length ? (['recent'] as const) : []),
          ...(contrast ? (['contrast'] as const) : []),
        ];
  const width = COLOR_PICKER_WIDTH + SHEET_BORDER * 2;
  const height =
    colorPickerHeight(shown, {
      swatches: swatches?.length ?? 0,
      recent: recent?.length ?? 0,
    }) +
    SHEET_BORDER * 2;

  const anchorOptions = (): AnchorOptions => ({
    placement: 'bottom',
    width,
    height,
    ...anchorOverrides,
  });

  const setOpen = (next: boolean): void => {
    if (openProp === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const close = (): void => setOpen(false);
  const openSheet = (): void => {
    const rect = measureAnchor(anchorOptions());
    if (!rect) return;
    setAnchor(rect);
    setOpen(true);
  };
  const toggle = (): void => (open ? close() : openSheet());

  useAnchorTracking(triggerRef, open, anchorOptions, setAnchor, close);
  useDismissOnWindowBlur(triggerRef, open, close);

  const handleChange = (ev: ColorChangeEvent): void => {
    if (value === undefined) setOwnValue(ev.value);
    onChange?.(ev);
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.keysym === XK_ESCAPE) {
      if (open) close();
      return;
    }
    if (open && pickerRef.current?.handleKey(ev)) return;
    if (
      ev.keysym === XK_DOWN ||
      ev.keysym === XK_UP ||
      ev.keysym === XK_RETURN ||
      ev.codepoint === 32
    ) {
      if (!open) openSheet();
    }
  };

  const label =
    channels === null
      ? (placeholder ?? 'Pick a colour…')
      : formatColor(channels, format === 'auto' ? 'hex' : format, alpha);

  return hx(
    'box',
    {
      theme,
      role: 'combobox',
      'aria-expanded': Boolean(open),
      'aria-haspopup': 'dialog',
      'aria-label': 'Colour',
      disabled: disabled || undefined,
      ref: triggerRef,
      focusable: !disabled,
      onMouseDown: disabled ? undefined : toggle,
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        close();
      },
      onKeyDown: disabled ? undefined : onKeyDown,
      style: [
        s.trigger,
        {
          cursor: disabled ? 'default' : 'pointer',
          borderWidth: theme.borderWidth,
          borderRadius: theme.radius,
          borderColor: focused || open ? theme.borderFocus : theme.border,
          backgroundColor: disabled ? theme.surfaceHover : theme.background,
        },
        !disabled &&
          !open && {
            ':hover': { backgroundColor: theme.surfaceHover },
            ':active': { backgroundColor: theme.surfaceActive },
          },
        style,
      ],
    },
    hx('box', {
      key: 'swatch',
      style: [
        s.swatch,
        {
          borderWidth: theme.borderWidth,
          borderColor: theme.border,
          borderRadius: 3,
          backgroundColor: channels
            ? formatColor(channels, 'hex', alpha)
            : 'transparent',
        },
      ],
    }),
    hx(
      'text',
      {
        key: 'label',
        style: [
          s.label,
          {
            color: disabled || channels === null ? theme.textMuted : theme.text,
            fontFamily: channels === null ? undefined : theme.monoFamily,
          },
        ],
      },
      label,
    ),
    open &&
      anchor &&
      hx(
        'popup',
        {
          key: 'sheet',
          theme,
          x: anchor.x,
          y: anchor.y,
          width,
          height,
          grab: true,
          onDismiss: close,
          transparent: true,
          style: {
            backgroundColor: theme.background,
            '@supports transparency': { backgroundColor: 'transparent' },
          } as SupportsStyle,
        },
        hx(
          'box',
          {
            style: [
              s.sheet,
              {
                borderColor: theme.border,
                backgroundColor: theme.background,
                '@supports transparency': { borderRadius: theme.radiusPopup },
              } as SupportsStyle,
            ],
          },
          React.createElement(ColorPicker, {
            ref: pickerRef,
            value: current,
            onChange: handleChange,
            onChangeEnd,
            name,
            alpha,
            format,
            swatches,
            recent,
            parts,
            eyedropper,
            contrast,
            disabled,
            // The trigger owns the keyboard: the popup is override-redirect
            // and never takes focus, so a focusable panel inside it would
            // take focus on the press instead — blurring the trigger, whose
            // onBlur closes the sheet, unmounting the pane under the pointer
            // before the release could turn into a click.
            focusable: false,
            // …and because it does not hold the focus, it would not draw the
            // axis cursor either, leaving the arrow keys moving something
            // invisible.
            focusVisible: true,
            children,
          } as ColorPickerProps),
        ),
      ),
  );
}
