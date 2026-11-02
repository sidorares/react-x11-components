// What a page has been allowed: the seam `<Html scripts>` asks before it
// lets a script at anything of the machine's that a user has to agree to.
//
// A browser asks its user and remembers the answer, and the question and the
// remembering are its own, so all that is here is the shape. With no host to
// ask, nothing has been granted and nothing can be, and `navigator.permissions`
// says so: `denied`, since asking would refuse. What a host handed a seam for
// and says nothing about has that seam's own answer (`DomHost`'s
// `_permissionState`). A component that shows a page does not agree to anything
// for its reader.

/** Where a permission stands for an origin (Permissions, 3.3). */
export type HtmlPermissionState = 'granted' | 'denied' | 'prompt';

export interface HtmlPermissions {
  /** Where `name` stands for `origin`, now: what
   *  `navigator.permissions.query()` answers, and asked as often. */
  state(name: string, origin: string): HtmlPermissionState;
  /** Ask the user, and answer where it stands after. Asked only after a
   *  press or a key of theirs in the page. */
  request(name: string, origin: string): Promise<HtmlPermissionState>;
  /** Be told a permission moved, in any way but a `request` of this page's:
   *  what fires a `PermissionStatus`'s `change`. Answers how to stop. */
  watch?(listener: (name: string) => void): () => void;
}

/** The features a permission can name: each one Chrome's `PermissionName`
 *  takes, since a name past them is a `TypeError` a page can tell a missing
 *  feature by. */
export const PERMISSION_NAMES: readonly string[] = [
  'accelerometer',
  'accessibility-events',
  'ambient-light-sensor',
  'background-fetch',
  'background-sync',
  'bluetooth',
  'camera',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
  'fullscreen',
  'geolocation',
  'gyroscope',
  'idle-detection',
  'keyboard-lock',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'nfc',
  'notifications',
  'payment-handler',
  'periodic-background-sync',
  'persistent-storage',
  'push',
  'screen-wake-lock',
  'speaker-selection',
  'storage-access',
  'system-wake-lock',
  'top-level-storage-access',
  'window-management',
  'xr-spatial-tracking',
];

/** Those a Permissions Policy feature of the same name decides as well, so a
 *  frame of another origin has them only where its element's `allow` names
 *  them. */
export const POLICY_FEATURES: ReadonlySet<string> = new Set([
  'accelerometer',
  'ambient-light-sensor',
  'camera',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
  'fullscreen',
  'geolocation',
  'gyroscope',
  'idle-detection',
  'keyboard-lock',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'payment-handler',
  'screen-wake-lock',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'window-management',
  'xr-spatial-tracking',
]);
