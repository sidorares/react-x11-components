// What a page has been allowed: the seam `<Html scripts>` asks before it
// lets a script at anything of the machine's that a user has to agree to.
//
// A browser asks its user and remembers the answer, and the question and the
// remembering are its own, so all that is here is the shape. With no host to
// ask, nothing has been granted and nothing can be: `navigator.permissions`
// says `prompt`, as a browser does before it has asked, and asking refuses.
// A component that shows a page does not agree to anything for its reader.

/** Where a permission stands for an origin (Permissions, 3.3). */
export type HtmlPermissionState = 'granted' | 'denied' | 'prompt';

export interface HtmlPermissions {
  /** Where `name` stands for `origin`, now: what
   *  `navigator.permissions.query()` answers, and asked as often. */
  state(name: string, origin: string): HtmlPermissionState;
  /** Ask the user, and answer where it stands after. Asked only after a
   *  press or a key of theirs in the page. */
  request(name: string, origin: string): Promise<HtmlPermissionState>;
}
