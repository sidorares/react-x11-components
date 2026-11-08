// Run with: npm run examples:browser:app [-- <url>]
//
// The example browser as a macOS app of its own, so that macOS asks about
// the camera. macOS answers a camera or a microphone request for the app
// responsible for the process, which is the app at the top of the chain
// that started it: a terminal, an editor, an agent. That app has to declare
// the use in its Info.plist, or the request is refused without a prompt and
// the page hears `NotAllowedError` (react-x11's docs/media.md). A tab needs
// nothing of its own: its pane is forked by the browser, and asks the
// browser to open the device for it.
//
// So this builds `react-x11 browser.app` in `~/Library/Caches/
// react-x11-browser/` (`BROWSER_APP_DIR` moves it), the shape react-x11's
// docs/packaging.md gives a bundle: a copy of the node running this
// script as its executable, an Info.plist that declares the camera, the
// microphone and other applications' sound, and an ad hoc signature. Then
// it starts the browser in it through `open`, so that LaunchServices makes
// it the responsible app, and waits for it to quit. The bundle is built
// again only when this node or the Info.plist changes, and an ad hoc
// signature of the same files is the same signature, so what macOS was
// told about the camera holds from one run to the next.
//
// Inside the bundle this same file is the entry: it moves to the
// repository, where a tab's process finds the tsconfig, and imports
// `browser.tsx`. What the shell had of `PATH`, the locale, `NODE_*`,
// `BROWSER_*` and `REACT_X11_*` goes with it, since an app `open` starts
// gets none of the shell's environment. The output comes to this terminal,
// or to `browser.log` beside the bundle where there is no terminal. An
// instance already running is brought forward, and a URL given here is
// not opened in it.

import { execFileSync, spawn } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'react-x11 browser';
const EXECUTABLE = 'react-x11-browser';
const IDENTIFIER = 'com.github.sidorares.react-x11-components.browser';
const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Whether this process is the bundle's: its node is the copy inside it. */
const inBundle = /\.app\/Contents\/MacOS\/[^/]+$/.test(process.execPath);

if (inBundle) {
  // `open` starts an app in `/`, and a tab's process starts where this
  // one is, and finds the tsconfig from there
  process.chdir(REPO);
  await import('./browser.js');
} else {
  if (process.platform !== 'darwin') {
    console.error('examples:browser:app builds a macOS app; run it on a Mac.');
    process.exit(1);
  }
  const dir =
    process.env.BROWSER_APP_DIR ||
    join(homedir(), 'Library', 'Caches', 'react-x11-browser');
  const app = join(dir, `${NAME}.app`);
  build(dir, app);
  await launch(dir, app);
}

function plist(): string {
  const entries: [string, string | boolean][] = [
    ['CFBundleName', NAME],
    ['CFBundleDisplayName', NAME],
    ['CFBundleExecutable', EXECUTABLE],
    ['CFBundleIdentifier', IDENTIFIER],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleVersion', '1'],
    ['CFBundleShortVersionString', '1.0'],
    ['NSHighResolutionCapable', true],
    [
      'NSCameraUsageDescription',
      'A page you allow in the browser’s bar uses the camera.',
    ],
    [
      'NSMicrophoneUsageDescription',
      'A page you allow in the browser’s bar uses the microphone.',
    ],
    [
      'NSAudioCaptureUsageDescription',
      'A page that shares your screen with its sound hears other applications.',
    ],
  ];
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = entries
    .map(
      ([key, value]) =>
        `  <key>${key}</key>` +
        (typeof value === 'boolean'
          ? `<${value}/>`
          : `<string>${escape(value)}</string>`),
    )
    .join('\n');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
  );
}

/** The bundle, built where it is missing or made from another node or
 *  another Info.plist than this run's. */
function build(dir: string, app: string): void {
  const node = statSync(process.execPath);
  const info = plist();
  const stamp = JSON.stringify({
    node: process.execPath,
    version: process.version,
    size: node.size,
    mtimeMs: node.mtimeMs,
    info,
  });
  const stampFile = join(dir, 'stamp.json');
  const executable = join(app, 'Contents', 'MacOS', EXECUTABLE);
  if (
    existsSync(executable) &&
    existsSync(stampFile) &&
    readFileSync(stampFile, 'utf8') === stamp
  ) {
    return;
  }
  console.log(`Building ${app}`);
  rmSync(app, { recursive: true, force: true });
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  // a copy, not a link or a script: macOS finds the bundle from the path
  // of the executable that is running (react-x11's docs/packaging.md)
  copyFileSync(process.execPath, executable, constants.COPYFILE_FICLONE);
  writeFileSync(join(app, 'Contents', 'Info.plist'), info);
  // node's own signature does not cover the Info.plist, and macOS takes a
  // bundle whose signature is broken for no app at all
  execFileSync('codesign', ['--force', '--sign', '-', app], {
    stdio: 'inherit',
  });
  writeFileSync(stampFile, stamp);
}

/** Where the output goes: this terminal, where there is one. */
function terminal(dir: string): string {
  try {
    return execFileSync('tty', { stdio: ['inherit', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    const log = join(dir, 'browser.log');
    console.log(`The browser's output is in ${log}`);
    return log;
  }
}

async function launch(dir: string, app: string): Promise<void> {
  const out = terminal(dir);
  // the bundle's node finds the tsconfig by this, since it starts in `/`
  const env = ['--env', `TSX_TSCONFIG_PATH=${join(REPO, 'tsconfig.json')}`];
  const passed =
    /^(PATH|LANG|LANGUAGE|LC_[A-Z]+|TZ|NODE_[A-Z_]*|BROWSER_[A-Z_]+|REACT_X11_[A-Z_]+)$/;
  for (const [name, value] of Object.entries(process.env)) {
    if (passed.test(name) && value !== undefined) {
      env.push('--env', `${name}=${value}`);
    }
  }
  const args = [
    '-W',
    ...env,
    '--stdout',
    out,
    '--stderr',
    out,
    app,
    '--args',
    // tsx's loader by its path: the app starts in `/`, where `tsx` names
    // nothing
    '--import',
    import.meta.resolve('tsx'),
    '--experimental-vm-modules',
    '--disable-warning=ExperimentalWarning',
    fileURLToPath(import.meta.url),
    ...process.argv.slice(2),
  ];
  const child = spawn('open', args, { stdio: 'inherit' });
  const code = await new Promise<number>((resolve) =>
    child.on('exit', (status) => resolve(status ?? 1)),
  );
  process.exit(code);
}
