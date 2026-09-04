# Changelog

## [0.5.0](https://github.com/sidorares/react-x11-components/compare/v0.4.0...v0.5.0) (2026-09-04)


### Features

* **flow:** a mounted node body zooms with the pane ([5f4ce96](https://github.com/sidorares/react-x11-components/commit/5f4ce961371f6207b1939dd73f2765ee877ee08d))
* **flow:** a mounted node body zooms with the pane ([337a0de](https://github.com/sidorares/react-x11-components/commit/337a0de4408ae74a2a1c88bf86a991ecdc87152f))
* **html:** answer [@media](https://github.com/media) (prefers-color-scheme) from the palette in force ([67373f1](https://github.com/sidorares/react-x11-components/commit/67373f1931775dbebf13c59894b361611339482e))
* **maps:** a 2D vector-tile map ([#64](https://github.com/sidorares/react-x11-components/issues/64)) ([5c21b4d](https://github.com/sidorares/react-x11-components/commit/5c21b4dd98cc44ce7c164835dd0f18d737d01856))
* **tabs:** an overflow menu for the tabs that do not fit, and a wash on a line hover ([4073eba](https://github.com/sidorares/react-x11-components/commit/4073eba45c6935a59199b700298f86fc2a5d67a5))
* **tabs:** the tabs that do not fit go in a menu, and a line hover wears a wash ([a65630f](https://github.com/sidorares/react-x11-components/commit/a65630f916d2e31756cbd663e35170efa5342f72))


### Bug Fixes

* **code-editor:** a press lands under the pointer, whatever the display scale ([478011b](https://github.com/sidorares/react-x11-components/commit/478011b5796fae6eea839b4f8a1c2b4be2bb2ced))
* **code-editor:** a press lands under the pointer, whatever the display scale ([41fcb36](https://github.com/sidorares/react-x11-components/commit/41fcb3625728effbd6f2b57226e6271f8c29f912))
* **flow:** the pane thinks in logical pixels, whatever the display scale ([c83f3e1](https://github.com/sidorares/react-x11-components/commit/c83f3e14566d5b0042bfac53cb861b00c3beac52))
* **flow:** the pane thinks in logical pixels, whatever the display scale ([c324bb9](https://github.com/sidorares/react-x11-components/commit/c324bb922a786be418fcf0140f42530e683b9de0))
* **formula:** the mathematics is shaped at its logical size on a retina panel ([171da0b](https://github.com/sidorares/react-x11-components/commit/171da0b0cb19a66e9cb776c3583adcbb1d2c767f))
* **formula:** the mathematics is shaped at its logical size on a retina panel ([eb2c8bb](https://github.com/sidorares/react-x11-components/commit/eb2c8bb03956db1754e3c153a388f6ba1f76a8b2))
* **html, richtext:** degrade on the Cocoa text engine's run shape instead of throwing ([77de3af](https://github.com/sidorares/react-x11-components/commit/77de3af6bcaff621feb4dd26447cf05db3f07088))
* **terminal, html, richtext, charts:** drawn elements know which pixel unit they are in ([27c48ad](https://github.com/sidorares/react-x11-components/commit/27c48ad83e67d53943df99eab920b99eca48ccd5))
* **terminal, html, richtext, charts:** drawn elements know which pixel unit they are in ([a8bfdb2](https://github.com/sidorares/react-x11-components/commit/a8bfdb2e6eeb7a95b37389ca6c523c8e5f281507))
* **terminal:** a text engine without glyph runs degrades instead of throwing ([760b9fe](https://github.com/sidorares/react-x11-components/commit/760b9fe81b9f972ed183d62832ea7d30b0969c1f))
* **terminal:** a text engine without glyph runs degrades instead of throwing ([b83c775](https://github.com/sidorares/react-x11-components/commit/b83c77546d4533a9edebfeda5263a031a8f0a3d3))
* **terminal:** the scroll copy lands the top row ([9be0c59](https://github.com/sidorares/react-x11-components/commit/9be0c592ccfa761911897be13616b6a40cbd963a)), closes [#60](https://github.com/sidorares/react-x11-components/issues/60)
* **terminal:** the scroll copy lands the top row, on react-x11 2.5.0 ([540ad89](https://github.com/sidorares/react-x11-components/commit/540ad897223c66ea106b558861df9b9461ebc404))

## [0.4.0](https://github.com/sidorares/react-x11-components/compare/v0.3.0...v0.4.0) (2026-09-01)


### Features

* **qml:** imports resolve .qml files through a resolver seam ([287c383](https://github.com/sidorares/react-x11-components/commit/287c383c105ba9d4bb256be88680a399f17ed118))
* **qml:** QML as an authoring layer over react-x11 ([6a0b21e](https://github.com/sidorares/react-x11-components/commit/6a0b21e9a328bb23172a405d962ede7139ccf98b))
* **qml:** QML as an authoring layer over react-x11 ([b1b4d87](https://github.com/sidorares/react-x11-components/commit/b1b4d87646271c0902c56f65567945154aee347c))
* **qml:** QtQuick.Layouts over the flex engine, and a layouts-first example ([7d949f3](https://github.com/sidorares/react-x11-components/commit/7d949f3117af769760b6772eaf9d8350c8a7ee9b))
* **qml:** the example root stretches to the window ([2de542a](https://github.com/sidorares/react-x11-components/commit/2de542ae2e58962f82913580c67d971523852899))
* **tabs:** Chakra-shaped &lt;Tabs&gt; with all five variants ([367aebe](https://github.com/sidorares/react-x11-components/commit/367aebe2d7cd3db00a8a17fa67abc17f7b3146dd))
* **tabs:** Chakra-shaped &lt;Tabs&gt; with all five variants ([f80abb4](https://github.com/sidorares/react-x11-components/commit/f80abb4575131d604e8ee073702cf6e401143f6e))
* **terminal:** the vt backend uses Bun's own pty when there is one ([a5fcf28](https://github.com/sidorares/react-x11-components/commit/a5fcf28902d006aa59d2e7e4b7e109266c0e8edc))
* **terminal:** the vt backend uses Bun's own pty when there is one ([54fb37b](https://github.com/sidorares/react-x11-components/commit/54fb37b757a7bc1427a9d0cab5f073981bb7c6bb))


### Bug Fixes

* **tabs:** breathing room in the strip, and rounded shoulders on outline ([f55203e](https://github.com/sidorares/react-x11-components/commit/f55203e46904159397afca7f8cd8fd208df2f70b))
* **tabs:** cap-trim trigger labels so they centre beside their icons ([ef51b73](https://github.com/sidorares/react-x11-components/commit/ef51b7340f958938d5ce64a422028c028f9ab49c))

## [0.3.0](https://github.com/sidorares/react-x11-components/compare/v0.2.1...v0.3.0) (2026-08-25)


### Features

* **examples:** table-non-virtual — the control group with no Table in it ([322719b](https://github.com/sidorares/react-x11-components/commit/322719b490d7142535f25aa7c1efd8b1f3ad6caa))
* **table, tree:** rows built ahead of the scroll — velocity lead, idle prefetch, and a kept band ([a3fd681](https://github.com/sidorares/react-x11-components/commit/a3fd681b327a3b94eb66a90e36e92c230a3c58de))
* **table, tree:** skeleton rows answer a flood, and the idle band stops wobbling the view ([2bf5e73](https://github.com/sidorares/react-x11-components/commit/2bf5e7397f1b7859db679a166d2f11f1ac8c36ee))
* **table, tree:** the catch-up pacing is a prop ([40253ad](https://github.com/sidorares/react-x11-components/commit/40253ad9db5576ef2a88ab20c5b89c6e6d286210))
* **table, tree:** the estimate learns the measured mean, and flicks defer measuring to the settle ([9cde90f](https://github.com/sidorares/react-x11-components/commit/9cde90fd596f15b8e5ddd63712227836f1c39f12))
* **table, tree:** the fast-scroll pill, and skeleton rows that read as rows ([4f4f9ca](https://github.com/sidorares/react-x11-components/commit/4f4f9ca16e0accc85d9f2d7d527f5590f78a6167))
* **table, tree:** the scroll hint waits out a show-delay, and the catch-up budgets follow the measurements ([70901d1](https://github.com/sidorares/react-x11-components/commit/70901d16e17f7beb232137095f304e148c38d32c))
* **tree:** a --stress flag on the example — the generated tree the window is tuned against ([f5dac53](https://github.com/sidorares/react-x11-components/commit/f5dac535b1ba783e5c8fe155ebebe762657129cd))


### Bug Fixes

* **examples:** the table tail follows display order, not the appended id ([3e20cba](https://github.com/sidorares/react-x11-components/commit/3e20cba411e29cac48dfa43084f525e4577d1b6a))
* **table, tree:** clamp the velocity lead — a scrollbar scrub froze the app for seconds ([8e2456b](https://github.com/sidorares/react-x11-components/commit/8e2456bcaf8196a2e3d9b1b72bba2684a2dc2372))


### Performance Improvements

* **table, tree:** a scroll notch pays only for the rows it brought in ([cb521f2](https://github.com/sidorares/react-x11-components/commit/cb521f22fea073f46d79d50128bcc605dc8d517e))
* **table, tree:** row elements reused by identity — a notch stops paying even the memo's toll ([5306cd9](https://github.com/sidorares/react-x11-components/commit/5306cd9c84ca2b8d7a099397265eeca36a6e20b0))

## [0.2.1](https://github.com/sidorares/react-x11-components/compare/v0.2.0...v0.2.1) (2026-08-24)


### Bug Fixes

* **table, tree:** a live tail lands on the newest row, and the slice follows the pane ([4684c7d](https://github.com/sidorares/react-x11-components/commit/4684c7dd0cad8eb88b57154522347a51b5086e9c))
* **table, tree:** a tail settles on the newest row, not on a guess about it ([2462481](https://github.com/sidorares/react-x11-components/commit/24624816c2006929a2068ece2612ebfa097f506b))
* **table:** a live tail lands on the newest row, and the slice follows the pane ([9564274](https://github.com/sidorares/react-x11-components/commit/9564274aa15e290d5e46e03c5f467729bb50ef76))
* **tree:** the same reveal &lt;Table&gt; got, promoted to src/internal/ ([8794a48](https://github.com/sidorares/react-x11-components/commit/8794a4887b8d6c7a74ec7ee5770a02b519807180))

## [0.2.0](https://github.com/sidorares/react-x11-components/compare/v0.1.0...v0.2.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* `@react-x11/components/richtext` no longer exports `tint`. It was only ever a forwarding of a core helper that had nowhere else to live; import it from `react-x11/style` instead.
* **flow:** react-x11 peer floor moves to the first release cut from core master 5f055db (paintDamage, selfDamagedProps, defaultWheel, scrollContents, a11yScene).
* **deps:** components no longer resolve against a palette that spells muted ink 'dim'; apps must be on a core at or past 49fb2b30.
* **tree:** `rowHeight` is the minimum height of a row rather than its exact height, and the default label wraps instead of being clipped. A tree that wants the old look passes `styles={{ label: { textWrap: 'nowrap' } }}`.
* `Sparkline`, `SparklineProps` and `SPARKLINE_ELEMENT` are gone from the barrel, and the `./sparkline` subpath no longer resolves.

### Features

* add &lt;CodeEditor&gt; — multiline code editing with pluggable languages ([2f99840](https://github.com/sidorares/react-x11-components/commit/2f998406454113526bb85896a908dcce39ae4314))
* add &lt;CodeEditor&gt; — multiline code editing with pluggable languages ([7bd4b6f](https://github.com/sidorares/react-x11-components/commit/7bd4b6f195a550f76c0902185fbcad5423b8eafa))
* add &lt;Formula&gt; — selectable TeX mathematics, and a markdown fence seam ([1b4a850](https://github.com/sidorares/react-x11-components/commit/1b4a850e03b76b48b47da9c93f82687bff7969b7))
* add &lt;Formula&gt; — selectable TeX mathematics, and a markdown fence seam ([65c3119](https://github.com/sidorares/react-x11-components/commit/65c31192fc3a3a7ef31c38ca69805f7a0f8a6ede))
* Calendar and DatePicker, plus the desktop's own calendar events ([a57669b](https://github.com/sidorares/react-x11-components/commit/a57669b99d2ad0e93f983fc34190f972cc3ed932))
* **calendar:** the month nav takes its chevrons from core's icon set ([f227e06](https://github.com/sidorares/react-x11-components/commit/f227e066b52703875cded8033ab707652aa50053))
* **calendar:** the month nav takes its chevrons from core's icon set ([63ce6d1](https://github.com/sidorares/react-x11-components/commit/63ce6d1b368180e228d3c55a77824f9ac504654d))
* **charts:** ChartData maxAge time window, plotRef pan/zoom seam ([49bc860](https://github.com/sidorares/react-x11-components/commit/49bc86095c20c13ea90ab93665e75e34e8940917))
* **charts:** shadcn-shaped chart set with cost-bounded rendering ([4c0a9b4](https://github.com/sidorares/react-x11-components/commit/4c0a9b4eeddcab45c3d079862d8830f8fd43c2d8))
* **charts:** shadcn-shaped chart set with cost-bounded rendering ([8be75f5](https://github.com/sidorares/react-x11-components/commit/8be75f582b0fc6c785532656db744f7952b2893f))
* **charts:** the bubble hides on press and re-mounts on release ([1df5d3f](https://github.com/sidorares/react-x11-components/commit/1df5d3f26e0f2beeb8a302e64a437e0c0db496ec))
* **code-editor:** behave through the default-action seam (react-x11[#266](https://github.com/sidorares/react-x11-components/issues/266)) ([e9fceb8](https://github.com/sidorares/react-x11-components/commit/e9fceb8d421aa9da395c32bc2d1bf6af0d54fabc))
* **code-language:** highlight.js as a Language, and the seam it arrives through ([bc5e5d6](https://github.com/sidorares/react-x11-components/commit/bc5e5d6f03bb032dcc948bcc5c12033dd53029c6))
* **code-language:** highlight.js as a Language, and the seam it arrives through ([6b27b73](https://github.com/sidorares/react-x11-components/commit/6b27b73b9f0f9557d32c09d014bb98ba4a9e2f94))
* **code:** static &lt;Code&gt; block; share richtext + code-language modules ([9df6155](https://github.com/sidorares/react-x11-components/commit/9df615569eef2c6ef89334a507fd689e266f47f5))
* **color-picker:** &lt;ColorPicker&gt; and &lt;ColorField&gt;, on core's screen sampler ([e90955a](https://github.com/sidorares/react-x11-components/commit/e90955a3264e8cc91530008a4ddc69feb2b2803e))
* **color-picker:** &lt;ColorPicker&gt; and &lt;ColorField&gt;, on core's screen sampler ([c01b94e](https://github.com/sidorares/react-x11-components/commit/c01b94e96e34a7e602bc3436ee0ca32dcf79be63))
* **deps:** pin core at master a1abc6d and migrate the theme break ([104990e](https://github.com/sidorares/react-x11-components/commit/104990eb8a39814202e7ba098986ed8310599c9c))
* **example:** split the file explorer with a draggable divider ([41531e5](https://github.com/sidorares/react-x11-components/commit/41531e5cd90a2c56fd7aa398f74c6b680d3fce66))
* **examples:** three-effects — the composer stack live, each pass on a switch ([78d1503](https://github.com/sidorares/react-x11-components/commit/78d15032382599ac81a3d6b21e6bd475b90efe10))
* **flow:** a react-flow-shaped directed graph editor ([a6f2b60](https://github.com/sidorares/react-x11-components/commit/a6f2b60b25e4f22f165a2296af86dcb00d245136))
* **flow:** a react-flow-shaped directed graph editor ([3533823](https://github.com/sidorares/react-x11-components/commit/35338232fce778ff4047c3a13cbcb2f52371ad9a))
* **flow:** adopt the seven upstream seams — pans blit, grids tile, the graph is audible ([d8f7f50](https://github.com/sidorares/react-x11-components/commit/d8f7f50417f9bafd10b043ffa220eef7d5ed9d47))
* **flow:** mount real widgets in a node, and let nodes be resized ([bdfc4f5](https://github.com/sidorares/react-x11-components/commit/bdfc4f58d1e953a150da1da2f15c96e0e06528f5))
* **html:** a static HTML + CSS document, selectable, with seams ([8993859](https://github.com/sidorares/react-x11-components/commit/8993859db627fac8038b189aa66af8029ad71e8a))
* **html:** a static HTML + CSS document, selectable, with seams ([7440cb5](https://github.com/sidorares/react-x11-components/commit/7440cb50d34e4f50c3a60d3de3e54d17648c81ea))
* import core's tint instead of vendoring it three times ([2aff958](https://github.com/sidorares/react-x11-components/commit/2aff95802e395fdabf5c903b770fbc862ea46f77))
* **markdown:** streaming-friendly GFM renderer with cross-block selection ([79164b3](https://github.com/sidorares/react-x11-components/commit/79164b3d9af498d0a8812bda18cb6ead5162afa1))
* **markdown:** streaming-friendly GFM with cross-block selection, plus a static &lt;Code&gt; block ([efb713d](https://github.com/sidorares/react-x11-components/commit/efb713dd0df18415359280b7efa132889d888c42))
* remove &lt;Sparkline&gt; ([1092744](https://github.com/sidorares/react-x11-components/commit/10927443011d11a29375eef388e585aa81c4761d))
* **richtext:** background fill modes, underline styles, and the link hook ([392f667](https://github.com/sidorares/react-x11-components/commit/392f66702bab05f214b537403d9acd0ff474935e))
* **table:** align speaks logical start/end — bidi decides, not the prop ([bb4c282](https://github.com/sidorares/react-x11-components/commit/bb4c28229615aa0060ea901f85d7d5bd49d87f01))
* **table:** the data table, succeeding core's &lt;Table&gt; ([53afa85](https://github.com/sidorares/react-x11-components/commit/53afa855ddaf9e249f73969c5924da58a1fed73a))
* **table:** the data table, succeeding core's &lt;Table&gt; ([01f7677](https://github.com/sidorares/react-x11-components/commit/01f7677654c6d0386a89a1b5ba5b73959d9ac3ff))
* **terminal-output:** render a captured terminal session ([f4991b0](https://github.com/sidorares/react-x11-components/commit/f4991b0385bac463e1e1d04616778d49605e444d))
* **terminal-output:** render a captured terminal session ([4f3b48f](https://github.com/sidorares/react-x11-components/commit/4f3b48f62750bd73ec6c2e28f6471b93920fe976))
* **terminal:** `backend="vt"` — a pty, @xterm/headless and a cell-grid renderer ([e5448b2](https://github.com/sidorares/react-x11-components/commit/e5448b2062dfdcf3144b502b0efa81c3e4b904c7))
* **terminal:** backend="vt" — a pty, @xterm/headless and a cell-grid renderer ([d60f522](https://github.com/sidorares/react-x11-components/commit/d60f52272b233f38604ae91b5f658a5a3e251c91))
* **terminal:** make the pty seam usable from off this machine ([941913e](https://github.com/sidorares/react-x11-components/commit/941913e58742124d523d61dfd70a80922b67a420))
* **three:** a react-three-fiber-shaped scene graph over &lt;glarea&gt; ([3060327](https://github.com/sidorares/react-x11-components/commit/30603279bf2dc557013d89fc63c6aa1e1d843e08))
* **three:** a react-three-fiber-shaped scene graph over &lt;glarea&gt; ([11663a0](https://github.com/sidorares/react-x11-components/commit/11663a07ad5c86aabc7e5d7587fea172239e45ea))
* **timeline:** a run of events — Chakra's API over box and text ([0e8bb42](https://github.com/sidorares/react-x11-components/commit/0e8bb42fdb51867b0c6ea6f9e16425f746e125a9))
* **timeline:** a run of events — Chakra's API over box and text ([d6058ee](https://github.com/sidorares/react-x11-components/commit/d6058ee29fbe7ea3007d1f3970986cb2cd43a8ee))
* **tray-host:** &lt;TrayHost&gt;, the system tray on &lt;foreign&gt; ([a68552b](https://github.com/sidorares/react-x11-components/commit/a68552bfad7a5b244b77cc3fab893df5b0abc697))
* **tray-host:** &lt;TrayHost&gt;, the system tray on &lt;foreign&gt; ([047dd7f](https://github.com/sidorares/react-x11-components/commit/047dd7f4ed3085578a8acbf3b1f66816c633461f)), closes [#17](https://github.com/sidorares/react-x11-components/issues/17)
* **tree:** a disclosure tree that succeeds core's, with seams and virtualization ([1042cd8](https://github.com/sidorares/react-x11-components/commit/1042cd8a90d36b9dc43d68e1cc20e0f783b8cbe7))
* **tree:** a disclosure tree that succeeds core's, with seams and virtualization ([5d2e91c](https://github.com/sidorares/react-x11-components/commit/5d2e91c82adad582669fd2f51e9d06f388806d51))
* **tree:** rows are as tall as their content, and virtualization measures them ([0184837](https://github.com/sidorares/react-x11-components/commit/018483756d7ff867a0df7d3808da02970b7fdbda))
* XEmbed wrappers — &lt;Terminal&gt; and &lt;MediaPlayer&gt; ([b40c4a7](https://github.com/sidorares/react-x11-components/commit/b40c4a79d7051bf59174e2da8e215066010bebd1))
* XEmbed wrappers — &lt;Terminal&gt; and &lt;MediaPlayer&gt; ([9dd4db4](https://github.com/sidorares/react-x11-components/commit/9dd4db407b1508ec7b0883832d2cc819a4027b19))


### Bug Fixes

* **charts:** collapse same-x bursts before stroking — ntk[#259](https://github.com/sidorares/react-x11-components/issues/259) workaround ([fe16d9f](https://github.com/sidorares/react-x11-components/commit/fe16d9f068ed8f0d257793f5c32bc7eac95c8609))
* **charts:** plot-local scatter buckets, container containment, ChartData.clear() ([da89ba5](https://github.com/sidorares/react-x11-components/commit/da89ba50a8ff168c5f4335455ef9654f1c64357c))
* **charts:** the hover is a live query — and time-axis tooltip headers ([1868abc](https://github.com/sidorares/react-x11-components/commit/1868abc1cc78c1fdf8717e10655045fe8e40eae6))
* **code-editor:** edit the line array in place, so highlighting is not one edit stale ([a4fca21](https://github.com/sidorares/react-x11-components/commit/a4fca210159d85aa725a6f0250afabfc4f4a0fbc))
* **code-editor:** edit the line array in place, so highlighting is not one edit stale ([08067c7](https://github.com/sidorares/react-x11-components/commit/08067c75d5c95146430c17f2f35cdfb2f68c3529))
* **deps:** name the core commit in the spec, not the branch ([6161610](https://github.com/sidorares/react-x11-components/commit/6161610a75dd7f5d6acbac286c6cbde9463269e8))
* **deps:** name the sha #master floats to — the pin rule ([556989d](https://github.com/sidorares/react-x11-components/commit/556989df815fe9e8a47c019b39d532a61618e062))
* **deps:** pin core at 7026456 — the scroll-blit claim-race fix ([cc61c27](https://github.com/sidorares/react-x11-components/commit/cc61c27518e33ed680944ed8e1c39330c27d19ed))
* **desktop-calendar:** watch reports changes, not the range's contents ([66b8682](https://github.com/sidorares/react-x11-components/commit/66b8682d7325fd2f99d841de8c6ec59705208694))
* **desktop-calendar:** watch reports changes, not the range's contents ([f18b8eb](https://github.com/sidorares/react-x11-components/commit/f18b8ebfb29719d65fc105feb84ee238b524b4a2))
* **examples:** the theme has no $surface token ([d807e70](https://github.com/sidorares/react-x11-components/commit/d807e70703bc5eeafe7e3661d5d6e0ee915820c2))
* **flow:** migrate past the theme break, and guard the ntk[#259](https://github.com/sidorares/react-x11-components/issues/259) hairpin ([8bdafe4](https://github.com/sidorares/react-x11-components/commit/8bdafe4deb1df18c52122df683a9e81edc2e9791))
* **flow:** mounted bodies commit inside the gesture — no trailing, ever ([c4e0568](https://github.com/sidorares/react-x11-components/commit/c4e0568bcb8a29c2f97403b7ac60824d153f9323))
* **html:** controls get their authored spaces back, and default margins ([69be4d1](https://github.com/sidorares/react-x11-components/commit/69be4d151bd190f02546a9baf889e8ee49d963b8))
* **html:** list markers on the item's first line, and auto tables shrink to fit ([ddc932c](https://github.com/sidorares/react-x11-components/commit/ddc932cce5a608beccda84124e68362570c76754))
* **html:** reach the layout engine through react-x11/yoga ([dcd4ed9](https://github.com/sidorares/react-x11-components/commit/dcd4ed953d7e5fc56fc4355e254ac8e6abff41c5))
* **html:** reach the layout engine through react-x11/yoga ([7e23c43](https://github.com/sidorares/react-x11-components/commit/7e23c43a19bb3fc2250a93256935a934bde09200))
* **html:** what a self-review against extreme documents found ([5cb96f8](https://github.com/sidorares/react-x11-components/commit/5cb96f85ff3f66a0fc4a5561fe8bb9484f51155f))
* pin react-x11 to a master that has &lt;foreign&gt; ([fe240bc](https://github.com/sidorares/react-x11-components/commit/fe240bce470caa66e447a585b7f9516fabb2cca3))
* **terminal:** the clipboard chords a terminal actually uses, and say why a pty is missing ([78a78b1](https://github.com/sidorares/react-x11-components/commit/78a78b1bdc47a080c1e6534ae65fb0f65683a24a))
* **three:** draw wireframe as a unique-edge LINES index on the direct backend ([4778783](https://github.com/sidorares/react-x11-components/commit/4778783d3720aa1878b01c5b386a828ee1831c7e))
* **three:** follow the created context's backend for supportsShaders ([75e1d70](https://github.com/sidorares/react-x11-components/commit/75e1d704258bfd32ee49f9295ca0f2f90733aa5f))
* **tree:** keep a row one line tall, and say what bounds the scroll container ([8dd1cbe](https://github.com/sidorares/react-x11-components/commit/8dd1cbe49562bcef0b7b42b7e3032684a5b624b9))
* **tree:** migrate past the theme break — dim is textMuted ([c56f807](https://github.com/sidorares/react-x11-components/commit/c56f807e7e828ed4b702426b412f52c37dd727a7))
* **tree:** the keyboard scrolls only when the selection would leave the viewport ([c01b483](https://github.com/sidorares/react-x11-components/commit/c01b48381f4207c76ad359d183ba7ac5eea3b870))


### Performance Improvements

* **flow:** a drag step repaints the box it moved through, not the graph ([7e4b7fd](https://github.com/sidorares/react-x11-components/commit/7e4b7fd884b953cfe7ee7d7f52de74c8d69ffd9b))
* **flow:** batch edge strokes, land geometry on whole pixels ([d61a62d](https://github.com/sidorares/react-x11-components/commit/d61a62d16000c6c1347e1061da08bcff36cba6a4))
* **flow:** blit hud-on pans — the furniture rides beside the copy ([5962a80](https://github.com/sidorares/react-x11-components/commit/5962a80fdd6de7ff59eaba90ca7cc9bdb7d3c6e4))
* **flow:** bodies composite with the card; a keystroke costs its node ([f6e7dd2](https://github.com/sidorares/react-x11-components/commit/f6e7dd27c1cc65c98442bf4ac996c2ba099aa202))
* **flow:** stroke borders on the fast path, and cite the filed upstream issues ([35dd649](https://github.com/sidorares/react-x11-components/commit/35dd649dce77ede06ae5a2ed852c8746972794e0))
* **html:** a paint costs the viewport, not the document ([b920db3](https://github.com/sidorares/react-x11-components/commit/b920db324df19af3a8bc192b0aae710b20dcb985))

## [0.1.0](https://github.com/sidorares/react-x11-components/compare/v0.0.1...v0.1.0) (2026-08-09)


### Features

* a home for components that do not belong in react-x11 core ([ef79b29](https://github.com/sidorares/react-x11-components/commit/ef79b2974479fa4af9bef06746672dcdc3f5f348))
