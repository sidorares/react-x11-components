// The User-Agent presets the toolbar's menu offers. One is the browser's
// own (react-x11-components); the rest name a browser a server is likely to
// know, so a page that sniffs for one sends the markup it sends that
// browser rather than the stripped-down page it sends an unknown client.
// This is a developer convenience — a page served to "Chrome" is still laid
// out and run by this engine — not a way past a site's own checks: a sign-in
// that runs an environment probe (Google's "this browser may not be secure")
// sees the engine for what it is whatever string this sends.
//
// `value` is the whole User-Agent. `null` means the browser's own default,
// which `page.tsx` computes from the host platform; choosing it leaves
// `BROWSER_USER_AGENT` unset, so the two never have to agree on a string.
// The desktop agents name the host's OS, as the default does, so the agent
// is one the machine could plausibly send (`page.tsx` says why the platform
// is matched). `navigator.platform` follows the OS the chosen agent names
// (`<Html scripts>`), so "Chrome (Android)" is how a page is told it is on a
// phone.

/** One entry in the User-Agent menu. */
export interface UserAgentPreset {
  /** Stable id, kept in the profile's preferences. */
  id: string;
  /** What the menu row reads. */
  label: string;
  /** A compact name for the toolbar button. */
  short: string;
  /** The User-Agent to send and to name as `navigator.userAgent`, or `null`
   *  to use the browser's own default. */
  value: string | null;
}

/**
 * The presets, with the desktop agents' OS token matched to the host — the
 * same choice the default agent makes — so Chrome and Firefox read as this
 * machine's. Safari is macOS's whatever the host is, since there is no
 * Safari anywhere else; "Chrome (Android)" is a phone whatever the host is,
 * which is the point of having it.
 */
export function userAgentPresets(platform: NodeJS.Platform): UserAgentPreset[] {
  const desktopOs =
    platform === 'darwin'
      ? {
          chrome: 'Macintosh; Intel Mac OS X 10_15_7',
          firefox: 'Macintosh; Intel Mac OS X 10.15',
        }
      : platform === 'win32'
        ? {
            chrome: 'Windows NT 10.0; Win64; x64',
            firefox: 'Windows NT 10.0; Win64; x64',
          }
        : { chrome: 'X11; Linux x86_64', firefox: 'X11; Linux x86_64' };
  return [
    {
      id: 'default',
      label: 'Default (react-x11-components)',
      short: 'UA',
      value: null,
    },
    {
      id: 'chrome',
      label: 'Chrome',
      short: 'Chrome',
      value:
        `Mozilla/5.0 (${desktopOs.chrome}) AppleWebKit/537.36 ` +
        '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    },
    {
      id: 'firefox',
      label: 'Firefox',
      short: 'Firefox',
      value:
        `Mozilla/5.0 (${desktopOs.firefox}; rv:134.0) ` +
        'Gecko/20100101 Firefox/134.0',
    },
    {
      id: 'safari',
      label: 'Safari (macOS)',
      short: 'Safari',
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 ' +
        'Safari/605.1.15',
    },
    {
      id: 'android',
      label: 'Chrome (Android)',
      short: 'Android',
      value:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    },
  ];
}

/** The preset for an id, or the first (the default) where it is unknown. */
export function presetFor(
  presets: UserAgentPreset[],
  id: string | undefined,
): UserAgentPreset {
  return presets.find((p) => p.id === id) ?? presets[0];
}
