# codeblock

```ts
import {
  CODE_LINE_HEIGHT,
  codeBlockLook,
  codeBlockRuns,
  codeBlockStyle,
  codeTextStyle,
  themeTokenResolver,
} from '@react-x11/components/codeblock';
```

The **look** of a block of code: the palette, the runs and the chrome that
[`<Code>`](code.md) and [`<Markdown>`](markdown.md)'s fenced blocks share.
Extracting it is what makes the two agree inside one window instead of
drifting apart a colour at a time.

A shared module: pure functions, no element, no side effect at import time.

## `codeBlockLook(theme, options?) → CodeBlockLook`

Resolves everything the paint needs from the theme and a few overrides:

```ts
interface CodeBlockLookOptions {
  fontSize?: number; // the mono size outright — <Code>'s `fontSize`
  baseSize?: number; // the document's base text size; mono is 0.9 of it
  monoFamily?: string; // default 'monospace' — there is no theme token
  tokenStyles?: TokenStyles; // palette override
}
```

`fontSize` wins over `baseSize`. The 0.9 ratio is why a fenced block inside
`<Markdown>` sits a shade smaller than the prose around it without anyone
passing a size.

```ts
interface CodeBlockLook {
  size: number; // the mono size, in pixels
  family: string;
  color: string; // the ink: unstyled tokens, and the gaps between styled ones
  dim: string; // secondary ink — the line-number gutter
  fill: string; // the block's own background
  padding: number;
  radius: number;
  lineHeight: number;
  styles: TokenStyles; // picked against the theme background unless overridden
  resolveToken: (name: string) => string | undefined;
}
```

The palette is **picked against the theme background**, not against a
light/dark flag — `isDarkBackground()` from
[`code-language`](code-language.md) is what decides, so a custom theme with a
dark surface gets a dark palette without declaring itself dark.

## `codeBlockRuns(source, look, options?) → TextRun[]`

The highlighted source as [`<richtext>`](richtext.md) runs:

```ts
interface CodeBlockRunOptions {
  lang?: string; // a fence-style tag — 'js', 'tsx', 'bash'…
  language?: Language; // an explicit Language; takes precedence over `lang`
  highlight?: boolean; // false leaves the code unhighlighted, tag or no tag
}
```

## `codeBlockStyle(look)` and `codeTextStyle(look)`

The block's own `Style` (fill, padding, radius) and the text style
(family, size, colour, line height). Two functions rather than one because
the block and the text are different nodes.

## `themeTokenResolver(theme)`

Resolves the `'$token'` colour names a custom `TokenStyles` may use against
the live theme. This is what lets an app write a palette in theme tokens
rather than hex, and have it follow a theme switch.

## `CODE_LINE_HEIGHT`

`1.25`. Exported because a component laying out a code block needs the same
number to compute its height before it paints.
