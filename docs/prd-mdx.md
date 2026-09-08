# PRD: MDX in `<Markdown>` — components in the prose, and where the JavaScript stops

Status: **M1 shipped** — `components` on `<Markdown>`, block position, no
evaluation. M2 (expressions) and the inline half are not built.

Two things changed in the building, both recorded in place below:
`onUnknownComponent` is **cut** (it cannot mean anything under
map-membership gating — see "Public API"), and components are **block
position only**, because the inline half needs a `<richtext>` capability
that does not exist (see "The inline half").

## What it is

A document that can put a component in the middle of a sentence, or a chart
between two paragraphs, without leaving markdown:

```markdown
Revenue recovered in the second half:

<Chart data={quarters} height={240} />

…which is what the board saw, and why <Badge tone="warn">Q3</Badge> is the
one everybody remembers.
```

Two lines of prose, one block-level component, one inline component. The
prose is still markdown — still selectable across the component, still
streamable, still cached per block.

The component itself never arrives from an `import`. It arrives from a map
the application already holds:

```tsx
const COMPONENTS = { Chart, Badge };

<Markdown source={doc} components={COMPONENTS} />;
```

That is the whole feature at its first rung, and the rung is deliberately
low: **no JavaScript is evaluated to render the example above** — see "The
ladder", which is the argument this document exists to make.

## Prior art, and what it settles

### `@mdx-js/mdx` — the reference implementation, and why it is not taken

MDX is remark + rehype + an estree pass, compiled to a JS module that calls
`_jsx()` and takes a `components` map. It is the definition of the format
and it is very good at it.

It is not taken for three reasons, in increasing order of importance.

The small one is dependency weight: `@mdx-js/mdx` brings the unified
ecosystem — sixty-odd packages — into a component family whose largest
existing optional dependency is `katex`. That is a cost, not a
disqualification; `<Formula>` pays a comparable one.

The middle one is that it is the wrong pipeline. MDX compiles to a
**module**, evaluated once, producing a static tree. `<Markdown>` exists to
render a document _while it is still arriving_, re-reading the tail on every
chunk. A compile-then-evaluate step per keystroke of model output is not a
pipeline this component can adopt; the streaming tolerance, the per-block
cache and the implicit-close rules are all in the parser, and MDX's parser
is remark's.

The decisive one is that MDX evaluates arbitrary JavaScript by design, and
this component's primary input is **model output**. See "Security".

What is taken is the syntax, which is what users actually know, and the
lesson MDX v2 learned the hard way: the interesting complexity is not in
recognising a tag, it is in deciding where the tag ends and the markdown
resumes.

### Markdoc, and Astro's components — the restricted school

Markdoc (Stripe) deliberately refuses arbitrary JS: tags are declared, their
attributes are typed and validated, and the document cannot execute
anything. Astro's `.astro` components sit at the other end, with a full
module scope.

Markdoc is the closer relative of what M1 ships, and its argument is the one
adopted here: for a document you did not write, "which components may appear
and what may they be handed" is a question the _application_ answers, not the
document. The deviation is that Markdoc invents its own `{% tag %}` syntax to
make the restriction visible, and this does not — the syntax stays JSX, and
the restriction is expressed by what the parser will and will not evaluate.

### Streamdown / `remend` — already this parser's model

The behavioural spec for the streaming half is the one `parse.ts` already
follows: a construct that has only half arrived is held back rather than
leaked as raw syntax. A component tag is one more construct with that
obligation — `<Chart data=` at the live tail renders as nothing, not as
those eleven characters.

### `src/qml/parse.ts` — the in-repo precedent for the technique

The QML engine parses a whole foreign declarative language with no
dependencies, and it does it without ever parsing JavaScript:
`slurpExpression()` (`src/qml/parse.ts:243`) walks an expression as raw text
with bracket-depth, string and comment awareness, stops where the expression
must end, and hands the text to `new Function` — the split its own header
calls out as "what keeps this file honest".

That is exactly the machinery `{…}` needs here, and its existence is most of
the reason this PRD proposes hand-rolling rather than vendoring. The
extraction is a shared internal module; see "Parser design".

## Goals and non-goals

### Goals

- A component in a document, at block level and inline, with children.
- Backward compatible to the byte: a document that renders one way today
  renders the same way tomorrow unless the application opts in.
- Streaming-tolerant, on the same terms as every other construct.
- Cache-compatible: a component block that did not change does not re-render.
- Selection-compatible: a component's text joins the document's selection if
  it answers core's four accessors, with nothing to register.
- Safe by default for untrusted documents, which is the input this component
  was built for.

### Non-goals

- **`import` and `export` in a document.** Resolving a specifier is a
  bundler's job, and a renderer that does it is a module loader wearing a
  component's clothes. The `components` map is the substitute, and it is a
  better one: the application decides what a document may reach.
- **A second component.** No `<Mdx>`. See "The continuity contract".
- **HTML.** There is no HTML pass in this component and this does not add
  one. `<div>` is literal text before and after, unless an application puts
  `div` in its own map on purpose.
- **Layout or slots.** A component is handed children and props; how it
  arranges them is its business.
- **Full MDX conformance.** Named as a deviation, not a defect — see "The
  deliberate deviations".

## The ladder

The single most important decision in this document. JavaScript evaluation
is not a property of "MDX support"; it is three separate rungs, and an
application climbs only as far as it needs.

| rung               | opt-in                 | what parses                                  | what evaluates                  |
| ------------------ | ---------------------- | -------------------------------------------- | ------------------------------- |
| **1. Tags**        | `components`           | `<Name attr="s" flag {...json} />`, children | nothing                         |
| **2. Expressions** | `components` + `scope` | `{expr}` in attributes and prose             | `new Function`, against `scope` |
| **3. Modules**     | —                      | —                                            | — (non-goal)                    |

Rung 1 covers a documentation page, a chat message with a rendered chart, a
product tour, and every slide in a deck. Its attribute values are strings,
booleans, and — inside `{…}` — **JSON**: `height={240}`, `open={true}`,
`rows={[1,2,3]}`. Nothing is compiled and nothing is evaluated, so a
document from a stranger cannot do anything a document cannot already do.

Rung 2 is the same syntax with more power behind it. Supplying `scope` says
"expressions in this document may read these bindings, and I accept that the
document runs code". `{quarters}`, `{items.filter(Boolean)}`, `{n + 1}` start
working; nothing else about the document changes.

The escalation is deliberately invisible in the source text. That is the
point: an author writes `height={240}` once and never learns that it went
through `JSON.parse` on one rung and `new Function` on the next.

## The continuity contract

This package's law — one element, orthogonal opt-ins, no second API to
graduate to (AGENTS.md; `docs/prd-table.md` is the worked example) — settles
the "standalone or addition" question against a standalone `<Mdx>`.

A document with components is a document. It wants the same selection, the
same streaming, the same code fences, the same theming and the same block
cache, and every one of those would have to be either duplicated in a second
component or extracted into a third. So:

```tsx
<Markdown source={doc} />                                   // today, unchanged
<Markdown source={doc} components={{ Chart }} />            // rung 1
<Markdown source={doc} components={{ Chart }} scope={ctx} /> // rung 2
```

Each prop is an orthogonal addition on the element that was already there.
`components` without `scope` is meaningful; `scope` without `components` is
accepted and inert (expressions can appear in a document with no tags in it).

**`components` gates the parser.** Without it, `<Chart />` is literal text,
exactly as it is today — so this cannot change the rendering of any existing
document, and the gate is one truthy check rather than a mode flag.

## Public API

```tsx
interface MarkdownProps {
  // …existing props unchanged…

  /**
   * Components a document may name. A tag is a component **iff its name is
   * a key here** — there is no capitalisation rule and no HTML fallback, so
   * `<Chart/>` in a document with no `Chart` key stays literal text, the way
   * every unknown tag does today.
   *
   * Give the map a stable identity: a new object per render defeats the
   * block cache, the same way a new `fences` map does.
   */
  components?: Record<string, ComponentType<MdxComponentProps>>;

  /**
   * Bindings `{expressions}` in this document may read. **Supplying this
   * turns on expression evaluation** (`new Function`) — see "Security"
   * before passing it a document you did not write.
   *
   * Stable identity, as above.
   */
  scope?: Record<string, unknown>;
}
```

**`onUnknownComponent` was cut.** It was specified above as a way to make a
typo loud, and building the parser showed it cannot exist as specified: a
name absent from `components` never becomes a component node in the first
place — it is text before the renderer is reached, so there is nothing to
report. Making it reportable would need a _second_ rule for "this looks like
it wanted to be a component", which is the two-rule design that map
membership was chosen to avoid. If typo-detection is wanted it belongs in a
dev-mode lint over the source, not in a render prop. This closes open
question 1 as **no**.

```tsx

```

What a component is handed:

```tsx
interface MdxComponentProps {
  /** Attributes, after JSON or expression resolution. */
  [attr: string]: unknown;
  /** Rendered children — markdown, parsed and rendered as usual. */
  children?: ReactNode;
}
```

## The inline half, and why it is not in M1

`<Badge tone="warn">Q3</Badge>` in the middle of a sentence does not parse,
and the AST node for it stays reserved. The reason is not the parser — the
scanner in `src/markdown/tags.ts` does not care where it is called from —
it is the renderer.

A paragraph is laid out as **one `<richtext>`**, whose `runs` are a flat
array of styled text. A `TextRun` (`src/richtext/node.ts`) can say what a
run looks like, but it has no way to say _"reserve this much advance width
here for something another component paints"_. Without that, an inline
component can only be rendered beside the text rather than inside its flow,
which breaks wrapping — the one thing a paragraph is for.

`<Html>` does solve this, with `display: inline-block`, `box.replaced` and
its own line-box layout in `src/html/css/`. That is a CSS engine, and
`<Markdown>` deliberately does not have one.

So the inline half is its own piece of work, and its real content is a
`<richtext>` capability — an embedded-element run — plus the three questions
that come with it: baseline alignment, how a line wraps around an element
taller than its text, and what a selection dragged across one should copy.
Until then, a tag in the middle of a sentence is text, which is what it has
always been.

## Syntax, precisely

**A component tag** is `<Name`, `</Name>` or `<Name/>` where `Name` matches
`/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/` **and** resolves in `components`.
A dotted name resolves by walking the map (`Card.Header` is
`components['Card.Header']` first, then `components.Card?.Header`).

**Block or inline** is decided by position, as it is in MDX. A tag that
begins a line at ≤3 spaces of indent, and whose element closes with nothing
but whitespace after it on its last line, is a `component` **block**.
Anything else is a `component` **inline**, inside the paragraph it sits in.

**Attributes**:

| form                    | rung | value                                |
| ----------------------- | ---- | ------------------------------------ |
| `flag`                  | 1    | `true`                               |
| `name="…"` / `name='…'` | 1    | the string, entity-decoded           |
| `name={json}`           | 1    | `JSON.parse` of the braces' contents |
| `name={expr}`           | 2    | the expression's value               |
| `{...spread}`           | 2    | merged, left to right                |

A `{…}` that is not valid JSON on rung 1 is a parse failure for that tag,
which falls back to literal text — the same "cannot read it, do not pretend"
rule the rest of the parser follows. Object literals with unquoted keys are
the common casualty (`{{a: 1}}`); rung 2 accepts them.

**Children** are markdown. `<Callout>` … `</Callout>` around two paragraphs
gives the component a `children` of two rendered paragraphs, and the closing
tag's own line ends the block.

**A bare expression in prose** — `{count}` in the middle of a sentence — is
rung 2 only. On rung 1 it is literal text, which is what it is today, and
which keeps `{braces}` safe in ordinary documents. This repo's own docs are
full of them (AGENTS.md, "CommonMark and not MDX"), and that must keep
working.

### The deliberate deviations

Named the way `parse.ts` names its others, because they are choices:

- **Resolution is by map membership, not capitalisation.** MDX says
  lowercase is HTML and capitalised is a component. There is no HTML here,
  so the rule would only produce a class of tags that parse and then fail.
  Map membership is one rule instead of two, and it makes `<Foo/>` in an
  ordinary document inert rather than an error.
- **No imports.** See non-goals.
- **`{…}` is JSON before it is JavaScript.** MDX has one meaning for braces;
  this has two, and which one is in force is the application's decision.
- **An unknown tag is text, not an error.** The reserved-seam contract in
  `ast.ts` already promises this ("the renderer maps unknown names to plain
  text so a future parser upgrade cannot crash an older renderer").

## AST changes

Additive, and the inline half already exists:

```ts
// ast.ts — ComponentInline is unchanged except for its attribute type
export interface ComponentInline {
  type: 'component';
  name: string;
  attributes: Record<string, AttributeValue>; // was Record<string, string>
  children: InlineNode[];
}

// new, and added to the BlockNode union
export interface ComponentBlock {
  type: 'component';
  name: string;
  attributes: Record<string, AttributeValue>;
  children: BlockNode[];
}

/** Resolved at parse time on rung 1, held as source on rung 2. */
export type AttributeValue =
  { kind: 'literal'; value: unknown } | { kind: 'expression'; src: string };
```

`attributes` widening from `Record<string, string>` is the one breaking
change to a published type, and it is in a type nothing can currently
produce — the parser never emits a `component` node today. Recorded here so
that it is a decision rather than a surprise.

Holding an expression as **source** rather than a value is what keeps the
parse pure: parsing does not evaluate, so the same AST can be parsed once and
rendered against two different scopes, and the block cache stays keyed on
text.

## Parser design

Three hook points, all additive.

**Block layer** (`parseBlocks`, `parse.ts:111`). One new candidate in the
block-start scan, tried before paragraph continuation: a line whose first
non-space character is `<` and which opens a resolvable tag. It consumes to
the matching close, recursing into `parseBlocks` for children. `isBlockStart`
(`parse.ts:57`) grows the same test, so a component tag interrupts a
paragraph the way a fence does.

**Inline layer** (`parseInline`, `parse.ts:606`). One new item kind in the
delimiter walk, at the `<` branch that already exists (`parse.ts:703`). The autolink attempt on the next line
(`parse.ts:705`) stays first, so `<https://…>` and `<a@b.c>` keep their meaning;
a `<` that opens neither an autolink nor a resolvable tag stays the literal
character it is today.

**Expression slurping**, shared. `src/qml/parse.ts`'s `slurpExpression()` and
`skipString()` move to `src/internal/js-text.ts` and are imported by both.
This is a pure extraction — QML's behaviour must not change, and its tests
are the proof. The QML-specific parts (`expressionEndsHere`, QML's ASI rules)
stay in QML; what moves is the bracket-depth-and-strings walk, which is the
part that is about JavaScript's shape rather than about QML.

`new Function` compilation is cached in a module-level `Map` keyed on
`(src, scopeKeys.join(','))`, bounded like the layout cache in
`richtext/node.ts` — an expression in a streaming document is recompiled on
every chunk otherwise.

## Streaming

The obligations, in the parser rather than a repair pass, matching every
other construct:

- `<Cha`, `<Chart`, `<Chart data=`, `<Chart data={quar` at the live tail:
  **held back**, rendering nothing.
- `<Callout>` with children still arriving: the open tag is held, so the
  children render as ordinary markdown until the element can be read whole.
  The alternative — mounting the component and appending to its children —
  remounts on the chunk that closes it, and a component with state would lose
  it. Deferred as an optimisation with a real cost attached.
- At `partial: false` the tail is re-read under final-document rules, and an
  unclosed `<Callout>` becomes literal text.
- An expression that throws renders as nothing and warns once, the way a
  spanless run does in `richtext/runs.ts`. A half-typed expression must not
  take down a document that is still being typed.

## The block cache

`Document.raws` stays the key, and stays sufficient for rung 1: a component
block's raw source determines its AST, and its props are JSON of that source.

Rung 2 breaks that — the same source renders differently when `scope`
changes — so `scope` joins `components`, `fences` and `resolveLanguage` in
the `seamsRef` identity check (`index.ts:605-640`), invalidating the cache
when it changes. An application that mutates `scope` in place gets a stale
document, which is the same contract every other seam here has, and the prop
doc says so.

## Selection

Nothing to do, and that is worth writing down. react-x11#291 made selection
a core service over the drawn tree, so a component whose output answers the
four accessors in core's `docs/extending.md` joins the document's selection
with no registration — `index.ts` already says this about fence renderers,
and a component is the same seam in a different position.

A component that draws rather than lays out text (a chart) answers no
accessors and is skipped by a selection dragged across it, which is correct.

## Security

The section this format needs most, because this component's primary input
is **streamed model output**.

- **Rung 1 is safe for untrusted documents.** No compilation, no evaluation;
  attribute values go through `JSON.parse`. The worst a hostile document can
  do is name a component the application already decided to expose and hand
  it JSON — which is the same authority the application granted by putting it
  in the map.
- **Rung 2 is not, and cannot be made so.** `new Function` on text from a
  document is arbitrary code execution in the application's process. There is
  no sandbox here and this PRD does not propose building one.
- Therefore `scope` is the opt-in, its prop doc leads with the warning, and
  `docs/components/markdown.md` gets a short section that says plainly: do
  not pass `scope` alongside a document you did not write. A model that has
  been told what components exist will emit tags; one that has been prompt-
  injected will emit expressions.
- The one-line rule for the docs: **`components` decides what a document may
  reach; `scope` decides whether it may compute.**

## Testing and guards

- Parser: block and inline positions, dotted names, every attribute form,
  children with nested markdown, unknown names staying literal, `<` that is
  an autolink, `<` that is neither.
- Backward compatibility: the existing markdown suite must pass unchanged
  with no `components` prop, and a fixture document full of `{braces}` and
  `<Foo/>` must render byte-identically before and after.
- Streaming: the tail-holding table above, character by character, in the
  style of the existing partial tests — a document fed one character at a
  time must never show raw tag syntax.
- Cache: a component block whose source did not change must not re-render
  (the existing render-count harness), and must re-render when `scope`
  changes identity.
- Expressions: compile cache hits, a throwing expression warning once,
  bounded cache growth.
- The QML extraction: `test/qml.test.ts` unchanged and passing is the proof
  that `slurpExpression` moved without changing.

## Milestones

**M1 — tags, no evaluation. Shipped.** `ComponentBlock` and `AttributeValue`
in the AST, `ParseOptions.isComponent` as the gate, `src/markdown/tags.ts`
as the scanner, block dispatch in `parseBlocks` (multi-line tags included),
`components` on `<Markdown>` with dotted resolution, JSON attributes,
markdown children, streaming hold-back, `test/mdx.test.ts`,
`examples/mdx.tsx`. Block position only; no `onUnknownComponent`.

**M2 — expressions.** The `slurpExpression` extraction, `scope`, the compile
cache, spreads, bare `{expr}` in prose, the security docs.

**M1.5 — the inline half**, which M1 found to be a separate piece of work
rather than the other half of the same one. See "The inline half"; it is
gated on a `<richtext>` embedded-element run, and it is the more useful of
the two remaining rungs for prose.

**M3 — considered, not committed.** Fragments (`<>…</>`), a component that
streams into its own children rather than remounting, and a `components` map
that can decline a tag at render time.

## Open questions

1. ~~**Does M1 ship `onUnknownComponent: 'throw'`?**~~ **Closed: no.** The
   prop cannot exist under map-membership gating — see "Public API". A lint
   over the source is the shape this wants, if it is wanted.
2. **Should `scope` be a function?** `scope={(name) => …}` would let an
   application refuse a binding lazily. Proposed: no in M2, an object is the
   MDX-shaped thing; revisit if a caller wants it.
3. ~~**Is `Card.Header` worth the walk?**~~ **Closed: yes**, shipped in M1 —
   flat key first, then the property walk, so a map can spell the dotted
   name literally or hang it off the parent.
4. **Where does `<Formula>` sit after this?** A ` ```math ` fence and
   `<Formula tex="…"/>` become two ways to say one thing. Proposed: leave
   both; fences are how a _model_ writes maths, tags are how a person does.

## Risks

- **Scope creep into "real MDX".** Every deviation above will be read by
  somebody as a bug. Mitigation: the deviations are a documented section, in
  the parser header where its other deviations already live, and the docs
  page says "MDX-shaped" rather than "MDX" in its first sentence.
- **The QML extraction breaks QML.** Mitigation: pure move, QML's suite is
  the gate, and it happens in M2 rather than M1 so the two land separately.
- **`{}` in existing documents.** The gate is `components`, so no existing
  render changes; but an application that adopts `components` for tags gets
  brace-parsing it did not ask for. Mitigation: bare `{expr}` in prose is
  rung 2 only, so adopting rung 1 leaves braces alone.
- **The cache and `scope`.** An application that rebuilds `scope` inline
  every render turns the block cache off and will not know why. Mitigation:
  the prop doc, and the dev-mode warning `fences` should arguably already
  have.

## Related

- `src/markdown/ast.ts` — `ComponentInline`, the reserved seam.
- `src/qml/parse.ts:243` — `slurpExpression`, the technique.
- `docs/prd-table.md` — the continuity contract this follows.
- **`FenceInfo` drops the info string** (`parse.ts:222` keeps only the first
  word): ` ```demo charts ` cannot pass `charts` to its renderer. Unrelated
  to MDX but adjacent, small, and found by the same consumer — worth fixing
  in the same neighbourhood.
