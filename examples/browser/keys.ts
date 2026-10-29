// The browser's own keys, as one table the window and every page read.
//
// The window checks them in its `onKeyDown`. That is not enough on X11,
// where a tab's page is a real child window: X hands a key to the deepest
// window under the pointer, so while the pointer rests on a page its pane
// is sent the key directly and no handler of the browser's runs (core's
// `<foreign>` says as much). The page therefore watches for the same chords
// and passes them back, and a chord works wherever the pointer is. Where a
// pane is not a window of its own — Cocoa, Windows, or a page run inline —
// the browser sees every key first, and the page passes nothing back.
//
// The developer tools' chords are the menu bar's (`DEVELOP`): a `MenuBar`
// binds the chords of its items, and on macOS the system's menu bar runs
// them itself, so the window's handler leaves them alone or they would run
// twice. The page still passes them back, since on X11 the menu bar's
// binding hears no key the page's window was sent.
import type { MenuShortcut } from 'react-x11';

export type Command =
  | 'newTab'
  | 'closeTab'
  | 'address'
  | 'reload'
  | 'reloadFresh'
  | 'back'
  | 'forward'
  | 'nextTab'
  | 'previousTab'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'stop'
  | 'devtools'
  | 'console'
  | 'pick'
  | 'viewSource'
  | 'tab1'
  | 'tab2'
  | 'tab3'
  | 'tab4'
  | 'tab5'
  | 'tab6'
  | 'tab7'
  | 'tab8'
  | 'tab9';

/** Every command and its chords, on the platform's shortcut modifier —
 *  `Super` (Cmd) on macOS, `Control` elsewhere. */
export function shortcuts(mod: 'Super' | 'Control'): [Command, MenuShortcut][] {
  return [
    ['newTab', [[mod, 'T']]],
    ['closeTab', [[mod, 'W']]],
    ['address', [[mod, 'L'], ['F6'], ['Alt', 'D']]],
    ['reload', [[mod, 'R'], ['F5']]],
    [
      'reloadFresh',
      [
        [mod, 'Shift', 'R'],
        ['Shift', 'F5'],
      ],
    ],
    [
      'back',
      [
        ['Alt', 'Left'],
        [mod, 'bracketleft'],
      ],
    ],
    [
      'forward',
      [
        ['Alt', 'Right'],
        [mod, 'bracketright'],
      ],
    ],
    [
      'nextTab',
      [
        ['Control', 'Tab'],
        ['Control', 'Page_Down'],
      ],
    ],
    [
      'previousTab',
      [
        ['Control', 'Shift', 'Tab'],
        ['Control', 'Page_Up'],
      ],
    ],
    [
      'zoomIn',
      [
        [mod, 'plus'],
        [mod, 'equal'],
      ],
    ],
    ['zoomOut', [[mod, 'minus']]],
    ['zoomReset', [[mod, '0']]],
    ['stop', [['Escape']]],
    ...developShortcuts(mod),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): [Command, MenuShortcut] => [
      `tab${n}` as Command,
      [[mod, `${n}`]],
    ]),
  ];
}

/** The Develop menu's commands, which its items run. */
export const DEVELOP: ReadonlySet<Command> = new Set<Command>([
  'devtools',
  'console',
  'pick',
  'viewSource',
]);

/** Their chords: Safari's and Chrome's on a Mac, and Chrome's elsewhere. */
export function developShortcuts(
  mod: 'Super' | 'Control',
): [Command, MenuShortcut][] {
  const mac = mod === 'Super';
  return [
    ['devtools', [mac ? [mod, 'Alt', 'I'] : [mod, 'Shift', 'I'], ['F12']]],
    ['console', [mac ? [mod, 'Alt', 'J'] : [mod, 'Shift', 'J']]],
    ['pick', [[mod, 'Shift', 'C']]],
    ['viewSource', [mac ? [mod, 'Alt', 'U'] : [mod, 'U']]],
  ];
}
