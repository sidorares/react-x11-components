// <ColorPicker> and <ColorField> — the colour input.
//
// Nothing here registers a host element: both are compositions of `<box>`,
// `<text>`, `<textinput>` and `<canvas>`, so there is no `registerElement`
// call, no JSX augmentation, and **no side effect at import time at all**.
// An app that names neither pays for neither.
//
// The colour arithmetic is exported too, for the same reason `<Calendar>`
// exports its date arithmetic: an app that renders a picker almost always
// ends up doing a little of the same — measuring a contrast, formatting a
// value for a label, reading a hue.
//
// What is *not* here: `tint`, `readableInk` and `interpolate`. They are
// core's, on `react-x11/style`; a subpath of this package forwarding a core
// symbol under its own name is a claim of ownership that is not true.
export {
  ColorPicker,
  COLOR_PICKER_WIDTH,
  colorPickerHeight,
} from './ColorPicker.js';
export type {
  ColorChangeEvent,
  ColorPickerHandle,
  ColorPickerPart,
  ColorPickerProps,
  ColorSwatch,
} from './ColorPicker.js';

export { ColorField } from './ColorField.js';
export type { ColorFieldProps } from './ColorField.js';

export {
  channelsFromHsl,
  channelsFromHsv,
  channelsFromRgb,
  contrastGrade,
  contrastRatio,
  formatColor,
  formatOf,
  hslOf,
  hsvToRgb,
  opaqueHex,
  parseColor,
  relativeLuminance,
  rgbToHsv,
  wrapHue,
} from './color.js';
export type { ColorChannels, ColorFormat } from './color.js';

export type { WidgetChangeEvent } from '../internal/widget.js';
