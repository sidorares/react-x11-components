// One table, three terminals, and the reason `<Terminal>` has a nice API at
// all.
//
// Every terminal emulator that can be embedded takes the same three things —
// a window to draw into, a font, a colour scheme — and spells all three
// differently. xterm wants X resources, urxvt wants an Xft font string,
// alacritty wants TOML on the command line. That asymmetry is the *only*
// difference between the backends, so it lives here and the component never
// mentions a binary by name.
//
// Pure functions over a plain description: no spawning, no probing, nothing
// async. `test/terminal.test.ts` asserts the argv of all three without a
// terminal installed anywhere, which is the point.

/** Which emulator to embed. `'auto'` takes the first one installed. */
export type TerminalBackendName = 'auto' | 'xterm' | 'urxvt' | 'alacritty';

/**
 * The colours a terminal is asked to use.
 *
 * `<Terminal>` fills these from the react-x11 theme by default, which is what
 * makes an embedded terminal look like part of the app rather than a hole
 * punched in it.
 */
export interface TerminalColors {
  background?: string;
  foreground?: string;
  /** The block/bar the terminal draws at the caret. */
  cursor?: string;
  /**
   * ANSI 0–15, in the usual order (black, red, green, yellow, blue, magenta,
   * cyan, white, then the eight bright ones). A shorter array sets what it
   * has. Not every backend can take these from the command line — see
   * `palette` on the backend.
   */
  palette?: readonly string[];
}

/** Everything the argv builders read. */
export interface TerminalLaunch {
  /** The `<foreign>` container to draw into. */
  windowId: number;
  /** argv of the program to run. Empty means the user's shell. */
  command?: readonly string[];
  title?: string;
  fontFamily?: string;
  fontSize?: number;
  /** Lines of scrollback. */
  scrollback?: number;
  colors?: TerminalColors;
}

export interface TerminalBackend {
  name: Exclude<TerminalBackendName, 'auto'>;
  /** Binaries to look for, in order. */
  binaries: readonly string[];
  /** Whether `colors.palette` reaches this backend from the command line. */
  palette: boolean;
  args(launch: TerminalLaunch): string[];
}

/** The ANSI names alacritty's TOML uses, in palette-index order. */
const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
] as const;

const DEFAULT_FAMILY = 'monospace';
const DEFAULT_SIZE = 12;

/**
 * xterm.
 *
 * `-into` is the oldest and most reliable of the three embed flags — it
 * predates XEmbed and does plain reparenting, which is exactly what
 * `<foreign>`'s adopt path handles. `-b 0` drops the inner border, because a
 * pane in an application should not have a margin the application did not ask
 * for.
 *
 * Everything xterm cannot say as a flag it says as an X resource, which is
 * how the ANSI palette gets set: `-xrm 'XTerm*color4: #…'` is a per-invocation
 * resource and does not touch the user's database.
 */
export const xterm: TerminalBackend = {
  name: 'xterm',
  binaries: ['xterm'],
  palette: true,
  args(launch) {
    const args = ['-into', String(launch.windowId), '-b', '0'];
    if (launch.title) args.push('-T', launch.title);

    // `-fa` is what switches xterm to Xft at all; without it `-fs` is ignored
    // and the bitmap font stays. So asking for either means passing both.
    if (launch.fontFamily || launch.fontSize) {
      args.push('-fa', launch.fontFamily ?? DEFAULT_FAMILY);
      args.push('-fs', String(launch.fontSize ?? DEFAULT_SIZE));
    }
    if (launch.scrollback != null) args.push('-sl', String(launch.scrollback));

    const colors = launch.colors ?? {};
    if (colors.background) args.push('-bg', colors.background);
    if (colors.foreground) args.push('-fg', colors.foreground);
    if (colors.cursor) args.push('-cr', colors.cursor);
    for (const [index, color] of (colors.palette ?? []).entries()) {
      if (index > 15 || !color) continue;
      args.push('-xrm', `XTerm*color${index}: ${color}`);
    }

    // `-e` consumes the rest of the line, so it is last and nothing may be
    // appended after this point.
    if (launch.command?.length) args.push('-e', ...launch.command);
    return args;
  },
};

/**
 * rxvt-unicode.
 *
 * `-embed` rather than `-into`, and a single Xft font string rather than a
 * family and a size. The ANSI palette is reachable only through the X
 * resource database, which is the user's and not ours to write, so
 * `palette: false` — `<Terminal>` still themes the background, foreground and
 * cursor, which is most of what makes it look integrated.
 */
export const urxvt: TerminalBackend = {
  name: 'urxvt',
  binaries: ['urxvt', 'rxvt-unicode'],
  palette: false,
  args(launch) {
    const args = ['-embed', String(launch.windowId)];
    if (launch.title) args.push('-title', launch.title);
    if (launch.fontFamily || launch.fontSize) {
      const family = launch.fontFamily ?? DEFAULT_FAMILY;
      const size = launch.fontSize ?? DEFAULT_SIZE;
      args.push('-fn', `xft:${family}:size=${size}`);
    }
    if (launch.scrollback != null) args.push('-sl', String(launch.scrollback));

    const colors = launch.colors ?? {};
    if (colors.background) args.push('-bg', colors.background);
    if (colors.foreground) args.push('-fg', colors.foreground);
    if (colors.cursor) args.push('-cr', colors.cursor);

    if (launch.command?.length) args.push('-e', ...launch.command);
    return args;
  },
};

/**
 * alacritty.
 *
 * Configuration is a file, and `-o` is the escape hatch: one TOML assignment
 * per flag, applied over whatever the user's own config says. TOML means
 * strings are quoted *inside the argument value* — `font.normal.family="Fira
 * Code"` — which costs nothing here because each `-o` is its own argv element
 * and no shell ever sees it.
 */
export const alacritty: TerminalBackend = {
  name: 'alacritty',
  binaries: ['alacritty'],
  palette: true,
  args(launch) {
    const args = ['--embed', String(launch.windowId)];
    if (launch.title) args.push('--title', launch.title);

    const set = (key: string, value: string): void => {
      args.push('-o', `${key}=${value}`);
    };
    if (launch.fontFamily) set('font.normal.family', quote(launch.fontFamily));
    if (launch.fontSize != null) set('font.size', String(launch.fontSize));
    if (launch.scrollback != null) {
      set('scrolling.history', String(launch.scrollback));
    }

    const colors = launch.colors ?? {};
    if (colors.background)
      set('colors.primary.background', quote(colors.background));
    if (colors.foreground)
      set('colors.primary.foreground', quote(colors.foreground));
    if (colors.cursor) set('colors.cursor.cursor', quote(colors.cursor));
    for (const [index, color] of (colors.palette ?? []).entries()) {
      if (index > 15 || !color) continue;
      const group = index < 8 ? 'normal' : 'bright';
      set(`colors.${group}.${ANSI_NAMES[index % 8]}`, quote(color));
    }

    if (launch.command?.length) args.push('-e', ...launch.command);
    return args;
  },
};

/** A TOML string. Colours and font names have no quotes or backslashes in
 *  practice, but a family typed by a user is a user's string. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Auto-detection order, and it is deliberately not "nicest first".
 *
 * xterm's `-into` is the embed path with the fewest surprises and is on
 * almost every machine that has X at all; alacritty's `--embed` is newer and
 * its window is a winit window with its own ideas about focus. An app that
 * prefers a different one says so — `backend="alacritty"` is one prop.
 */
export const TERMINAL_BACKENDS: readonly TerminalBackend[] = [
  xterm,
  urxvt,
  alacritty,
];

/** The backends a `backend` prop selects. `'auto'` is all of them, in order. */
export function backendsFor(
  name: TerminalBackendName,
): readonly TerminalBackend[] {
  if (name === 'auto') return TERMINAL_BACKENDS;
  const found = TERMINAL_BACKENDS.filter((b) => b.name === name);
  return found;
}
