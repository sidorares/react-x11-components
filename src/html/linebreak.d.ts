// Minimal ambient typings for `linebreak` 1.1, the UAX #14 breaker ntk
// breaks every line with and react-x11's CoreText engine measures a
// paragraph's least width with — only what `layout/pretty.ts` calls. The
// package ships none. Ambient, so nothing is emitted into `dist/` and
// nothing reaches a consumer's program: no exported declaration names it.
declare module 'linebreak' {
  /** A place a line may break: before the code unit at `position`, and
   *  must where `required` (after a line feed, say). */
  export interface Break {
    position: number;
    required: boolean;
  }

  export default class LineBreaker {
    constructor(text: string);
    /** The next place to break, in order; null past the text's end, whose
     *  length is the last one given. */
    nextBreak(): Break | null;
  }
}
