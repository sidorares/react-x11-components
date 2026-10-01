# Changelog

## [0.16.1](https://github.com/sidorares/react-x11-components/compare/v0.16.0...v0.16.1) (2026-10-01)


### Bug Fixes

* **html:** a column that wraps sets its lines at the box's own start or end for align-content start and end, where end set them at its start ([#571](https://github.com/sidorares/react-x11-components/issues/571)) ([9ecda22](https://github.com/sidorares/react-x11-components/commit/9ecda2246380677e4a37ae9c8b14c8f20ccbd6a2))
* **html:** a flex item whose first line hangs out of it sits on that line, and only a scroll container holds a baseline to its border box, where every item was held to its height ([#577](https://github.com/sidorares/react-x11-components/issues/577)) ([4ca7323](https://github.com/sidorares/react-x11-components/commit/4ca7323c0c3b40c322082b3a8e7f6aa57fafdf86))
* **html:** a form control has Chrome's margins and sits on its line's baseline, where it had margins of its own and was set middle ([#578](https://github.com/sidorares/react-x11-components/issues/578)) ([b5e1b9b](https://github.com/sidorares/react-x11-components/commit/b5e1b9bd43a5c92d550c370149ad5ff3bf7b8413))
* **html:** a row aligned by the baseline of one item or of none is a line as tall as the row, where Yoga set its items in a line as tall as they are, and a column aligned by baselines keeps each margin across it once ([#579](https://github.com/sidorares/react-x11-components/issues/579)) ([2875870](https://github.com/sidorares/react-x11-components/commit/2875870ec204a24de783a49335063980c4fed77b))
* **html:** an item whose height is a percentage of a height its row does not have is as tall as its content, where Yoga stretched it across its line ([#575](https://github.com/sidorares/react-x11-components/issues/575)) ([a47bc29](https://github.com/sidorares/react-x11-components/commit/a47bc298ebb1bf00635c3f81093c71a20f097447))
* **html:** an item with an auto margin across a row that does not wrap and is aligned by baselines takes the room its line has past it, where Yoga set it by its baseline in a line as tall as the items ([#573](https://github.com/sidorares/react-x11-components/issues/573)) ([70cff04](https://github.com/sidorares/react-x11-components/commit/70cff041cbdaf31d13eb14f63f97158713e9156c))
* **html:** lines that wrap in reverse and are too big for their box start at its start for align-content space-around and space-evenly, where they ran out past it ([#576](https://github.com/sidorares/react-x11-components/issues/576)) ([a192d6c](https://github.com/sidorares/react-x11-components/commit/a192d6cb830ba708e3785acd6845e734265b5987))

## [0.16.0](https://github.com/sidorares/react-x11-components/compare/v0.15.0...v0.16.0) (2026-10-01)


### Features

* **html:** a quotation's marks are its language's, where every language had English's ([#564](https://github.com/sidorares/react-x11-components/issues/564)) ([b438110](https://github.com/sidorares/react-x11-components/commit/b43811094301c1377faea859ca4e6ca87b168a36))


### Bug Fixes

* **html:** a ::marker content ending in a no-break space stands where the default marker does, where it stood a space further out ([#568](https://github.com/sidorares/react-x11-components/issues/568)) ([7772a44](https://github.com/sidorares/react-x11-components/commit/7772a445fdf1714effed52587be543835c0a5985))
* **html:** a background painted through text shows through its descendants' text, where it stopped at the block the text was in ([#560](https://github.com/sidorares/react-x11-components/issues/560)) ([05f681b](https://github.com/sidorares/react-x11-components/commit/05f681bd72cf070cc0d32f83bc7d5e2ce587600e))
* **html:** a box sized to its content takes a percentage padding of its containing block, where the padding was left inside the content ([#559](https://github.com/sidorares/react-x11-components/issues/559)) ([c81028e](https://github.com/sidorares/react-x11-components/commit/c81028ed324b298c4e17121ec083ed949b39557b))
* **html:** a control keeps its look where the appearance that wins is not none, where any none of the page's took it off ([#565](https://github.com/sidorares/react-x11-components/issues/565)) ([3e3e455](https://github.com/sidorares/react-x11-components/commit/3e3e455886bb59afaefabfbe0233244413d91f59))
* **html:** a pseudo-class that takes selectors is as specific as Selectors 4 counts it, where every one counted a class ([#563](https://github.com/sidorares/react-x11-components/issues/563)) ([2d6feb8](https://github.com/sidorares/react-x11-components/commit/2d6feb8f6385f0ff168d1e76fecba8916a5daddf))
* **html:** a replaced element's aspect-ratio is of its border box under box-sizing: border-box, where it was always of its content ([#566](https://github.com/sidorares/react-x11-components/issues/566)) ([797fa74](https://github.com/sidorares/react-x11-components/commit/797fa74c601f6699ec1a35e57362e5823855a8ce))
* **html:** a wrapping column's items are laid out again at the width the box is, where master no longer built ([#562](https://github.com/sidorares/react-x11-components/issues/562)) ([dd9135f](https://github.com/sidorares/react-x11-components/commit/dd9135f98c993352814b3c19df559b486b455ccf))
* **html:** an item across a row that wraps takes the room its auto margins ask for, and keeps its own margins where the lines wrap in reverse, where Yoga stretched it to its line or swapped its top and bottom margins ([#570](https://github.com/sidorares/react-x11-components/issues/570)) ([8a6314f](https://github.com/sidorares/react-x11-components/commit/8a6314f18a33cc4509f827ac0ce51f746eafb195))
* **html:** an item stretched across a line align-content spaces out is as tall as the line, where Yoga made it taller by the room after the line ([#572](https://github.com/sidorares/react-x11-components/issues/572)) ([58c6596](https://github.com/sidorares/react-x11-components/commit/58c65967677856275ae9cffbb7596e0df489efc0))
* **html:** an SVG image with no viewBox is stretched to its box from its own size, where it was drawn at its own size in a corner ([#567](https://github.com/sidorares/react-x11-components/issues/567)) ([64c6e98](https://github.com/sidorares/react-x11-components/commit/64c6e9857bc312cb5a3ae30d202a2d593e6df348))

## [0.15.0](https://github.com/sidorares/react-x11-components/compare/v0.14.1...v0.15.0) (2026-10-01)


### Features

* **html:** a page's meta color-scheme is its root's colour scheme, where the meta was not read ([#553](https://github.com/sidorares/react-x11-components/issues/553)) ([39668fb](https://github.com/sidorares/react-x11-components/commit/39668fb0ba37cd68ebefe9a25b685c4b31ee5a95))
* **html:** a relative colour reads its origin's channels by name, where the declaration it was in was dropped ([#550](https://github.com/sidorares/react-x11-components/issues/550)) ([c2313cf](https://github.com/sidorares/react-x11-components/commit/c2313cf965d334447987ec77165651bcf3ca120f))
* **html:** a system colour is the palette's in its scheme and Chrome's in the other, where it was no colour ([#554](https://github.com/sidorares/react-x11-components/issues/554)) ([cb340f0](https://github.com/sidorares/react-x11-components/commit/cb340f067c6d3880024f975d06eb9fdcf71ab06a))


### Bug Fixes

* **html:** a &lt;use&gt; of a symbol a rule gives display: none draws nothing, where it drew the symbol ([#521](https://github.com/sidorares/react-x11-components/issues/521)) ([eda6c1f](https://github.com/sidorares/react-x11-components/commit/eda6c1f3a03d63882f60c7130fa31ad05dec2cb5))
* **html:** a column group's width is the width of each of its columns that sets none, where it was spread over them ([#530](https://github.com/sidorares/react-x11-components/issues/530)) ([0788120](https://github.com/sidorares/react-x11-components/commit/078812061a33211ab1f1874993a08cbfbabfed65))
* **html:** a column that wraps stretches its items to a line as wide as its widest item, where Yoga held the line to the column's width ([#551](https://github.com/sidorares/react-x11-components/issues/551)) ([8fd526b](https://github.com/sidorares/react-x11-components/commit/8fd526b6dc69b875b854e78f88dbcdd347284d6b))
* **html:** a fixed table's percentages are scaled to come to 100%, and share its width out after its lengths, where they widened it ([#545](https://github.com/sidorares/react-x11-components/issues/545)) ([435db00](https://github.com/sidorares/react-x11-components/commit/435db00f79c5507e8f59610f7b543ee9bacad6fb))
* **html:** a flex box that wraps is as narrow as its widest item at its min-content width, where its items were summed as on one line ([#547](https://github.com/sidorares/react-x11-components/issues/547)) ([8a2c1cf](https://github.com/sidorares/react-x11-components/commit/8a2c1cfe6619fead680c9524b8476dff86696705))
* **html:** a flex item that may not shrink is as wide as its content, and one a minimum widens is as tall as its content at that width ([#528](https://github.com/sidorares/react-x11-components/issues/528)) ([887021c](https://github.com/sidorares/react-x11-components/commit/887021cbcbabaeda4f93d09148f9678185839899))
* **html:** a flex line short of room takes from each item by its content box, where Yoga weighed its padding and borders too ([#543](https://github.com/sidorares/react-x11-components/issues/543)) ([28e65b4](https://github.com/sidorares/react-x11-components/commit/28e65b4f1275ad797a826827779e8807debc09e4))
* **html:** a flex line whose every growing item its maximum stops has each at that maximum, where they were nothing wide ([#512](https://github.com/sidorares/react-x11-components/issues/512)) ([0354ab8](https://github.com/sidorares/react-x11-components/commit/0354ab81fd162fe1fb2ea42ff0577abf7dd42af1))
* **html:** a flex line whose items have a minimum or a maximum is shared out as CSS Flexbox 9.7 has it, where Yoga stopped sharing it out ([#529](https://github.com/sidorares/react-x11-components/issues/529)) ([1f10689](https://github.com/sidorares/react-x11-components/commit/1f10689d1a1a365499b44452bdc8726078a4baf7))
* **html:** a grid's align-items: stretch stretches an image down its row, where only normal was read ([#514](https://github.com/sidorares/react-x11-components/issues/514)) ([13b3423](https://github.com/sidorares/react-x11-components/commit/13b3423ffdbb4daf5f3b075c0de7bab6d1522a4f))
* **html:** a list marker's image is 7px from the content, as Chrome sets it, where it was 0.4em outside the item and a space inside ([#541](https://github.com/sidorares/react-x11-components/issues/541)) ([e2473c9](https://github.com/sidorares/react-x11-components/commit/e2473c93bc762e970d4281dbb6034c4d31437206))
* **html:** a list marker's image with only a viewBox is drawn at the size Chrome gives it, where it drew nothing ([#525](https://github.com/sidorares/react-x11-components/issues/525)) ([cf77b97](https://github.com/sidorares/react-x11-components/commit/cf77b9707df620723fb8bdad267884c1f9e7111a))
* **html:** a rounded background repainted in part keeps the box's shape, where a radius over 64 pixels bent every strip into another ([#533](https://github.com/sidorares/react-x11-components/issues/533)) ([82607e4](https://github.com/sidorares/react-x11-components/commit/82607e4b378280c31cb573ff657edd54a2a7fc9b))
* **html:** a rounded border whose sides differ in colour is a ring, each side in its share of it, where it was a square frame ([#516](https://github.com/sidorares/react-x11-components/issues/516)) ([1fb3cac](https://github.com/sidorares/react-x11-components/commit/1fb3cacfd82da5400c5cce89b5b95ced0b308dab))
* **html:** a rounded box's shadow repainted in part keeps its shape, where a radius over 64 pixels bent every strip into another ([#542](https://github.com/sidorares/react-x11-components/issues/542)) ([6c411ce](https://github.com/sidorares/react-x11-components/commit/6c411cefbfc75464099444eb73ad353972b73d4d))
* **html:** a row that wraps stretches its items to a line as tall as its tallest item, where Yoga held the line to the row's height ([#555](https://github.com/sidorares/react-x11-components/issues/555)) ([4a886a2](https://github.com/sidorares/react-x11-components/commit/4a886a24b948c14896453a8c71d552da70e98ced))
* **html:** a sprite's icon is painted as the rules say of the copy its &lt;use&gt; draws, where it was drawn from its attributes alone ([#518](https://github.com/sidorares/react-x11-components/issues/518)) ([6489a61](https://github.com/sidorares/react-x11-components/commit/6489a61f660c840830e2b4c3c1d7ddffd97507a9))
* **html:** a table a flex box stretches or flexes is as wide as that, and no smaller than its rows or its columns ([#531](https://github.com/sidorares/react-x11-components/issues/531)) ([a0f6fb7](https://github.com/sidorares/react-x11-components/commit/a0f6fb7ae59cb65f714c41a89065252c36cf64f5))
* **html:** a table cell set a border-box height is that tall, where its padding went on it a second time ([#532](https://github.com/sidorares/react-x11-components/issues/532)) ([699bc23](https://github.com/sidorares/react-x11-components/commit/699bc23d22c65ce88bf72710c848f51ff2337669))
* **html:** a table cell spanning rows on the baseline asks its first row for its baseline and the rows for its content alone, as Chrome does ([#520](https://github.com/sidorares/react-x11-components/issues/520)) ([cb4b0e0](https://github.com/sidorares/react-x11-components/commit/cb4b0e0a808f01bf992ea7577caf47856fe23a8e))
* **html:** a table cell's length max-width caps what it asks of its column, and the cell is laid out as wide as its columns ([#523](https://github.com/sidorares/react-x11-components/issues/523)) ([f7a9696](https://github.com/sidorares/react-x11-components/commit/f7a96960c584182fc1fc27571b731cb6766de8bb))
* **html:** a table cell's percentage width is of the table's width less its border-spacing, where the spacing was in it ([#537](https://github.com/sidorares/react-x11-components/issues/537)) ([d745b82](https://github.com/sidorares/react-x11-components/commit/d745b829e37e2dbdfd6ac188ae7db4508cb43767))
* **html:** a text field holding the focus is its element's :focus, and its ring is the element's outline ([#527](https://github.com/sidorares/react-x11-components/issues/527)) ([4ec92cd](https://github.com/sidorares/react-x11-components/commit/4ec92cd6e406dd1d9d473f37951571423878d1c5))
* **html:** a thick dashed or dotted border keeps its pattern where only part of it is repainted ([#519](https://github.com/sidorares/react-x11-components/issues/519)) ([bfa72dc](https://github.com/sidorares/react-x11-components/commit/bfa72dc5a4367c6ac8e96495b5e0fe7d2e54086f))
* **html:** an absolute box that was inline-level stands where a line of its own would put it among blocks, where it went at the block's start ([#556](https://github.com/sidorares/react-x11-components/issues/556)) ([c6bea91](https://github.com/sidorares/react-x11-components/commit/c6bea914e15f4325c123c259d83c5257d9368fd3))
* **html:** an auto table is as wide as its percentage columns need, where a percentage was a length of the room on offer ([#540](https://github.com/sidorares/react-x11-components/issues/540)) ([7f0576b](https://github.com/sidorares/react-x11-components/commit/7f0576bf449fe72342e9922ef13bef4aa1788042))
* **html:** an icon is drawn again as more of its sprite's symbol arrives, where a symbol cut between two chunks kept its first shapes for good ([#539](https://github.com/sidorares/react-x11-components/issues/539)) ([fd13ce8](https://github.com/sidorares/react-x11-components/commit/fd13ce8e1f768b2daa3146d2edb1ded7d24ed3cb))
* **html:** an intrinsic minimum wins over a smaller maximum where a flex or grid item is laid out, and a border-box limit under the padding leaves a box as big as its padding ([#544](https://github.com/sidorares/react-x11-components/issues/544)) ([2473481](https://github.com/sidorares/react-x11-components/commit/2473481eaf66902973ad84d95c3fb266f66830da))
* **html:** an item a column that wraps stretches across its line is as tall as the line made it, where Yoga laid it out again its side margins taller and its top and bottom ones shorter ([#558](https://github.com/sidorares/react-x11-components/issues/558)) ([7806c4d](https://github.com/sidorares/react-x11-components/commit/7806c4dc2f95e06712acf4a7e51eea2769885f6a))
* **html:** an item across a column is as wide as its content at its narrowest, where it was fitted to the column whatever it held ([#546](https://github.com/sidorares/react-x11-components/issues/546)) ([4e94a07](https://github.com/sidorares/react-x11-components/commit/4e94a070c540de2f903dd0a2d882dd554702149e))
* **html:** an SVG drawing ntk throws on leaves the window's context as it found it, where every frame after it drew nothing ([#517](https://github.com/sidorares/react-x11-components/issues/517)) ([119e845](https://github.com/sidorares/react-x11-components/commit/119e845382834fab7691c8f9390563f10b31e1b5))
* **html:** an SVG image shows the element its URL's fragment names as :target, where no :target rule matched ([#552](https://github.com/sidorares/react-x11-components/issues/552)) ([3dfffe3](https://github.com/sidorares/react-x11-components/commit/3dfffe3009a27cadc430e10abaf48ad5db4d42d7))
* **html:** flex items that may shrink give up a row's room in proportion to their content at its widest, where one wider than the row was weighed as no wider ([#548](https://github.com/sidorares/react-x11-components/issues/548)) ([88c12ac](https://github.com/sidorares/react-x11-components/commit/88c12ac4f5c40890a956ad92cf41cd683532506f))
* **html:** tables nested hundreds deep are laid out and painted, where they ran out of the stack and left the document blank ([#549](https://github.com/sidorares/react-x11-components/issues/549)) ([b0e0670](https://github.com/sidorares/react-x11-components/commit/b0e0670af1aeadc08b0e46de4700ad241698ab9f))
* **html:** the lines of a column that wraps are set where align-content says, each as wide as its widest item, where Yoga stretched them to the box ([#557](https://github.com/sidorares/react-x11-components/issues/557)) ([7b67f93](https://github.com/sidorares/react-x11-components/commit/7b67f938581ecb9c57bd12a0500fc9f1b1d39561))
* **html:** what a cell spanning rows needs past them is shared out over the rows as Chrome shares it, where it all went to the last ([#534](https://github.com/sidorares/react-x11-components/issues/534)) ([b1e566b](https://github.com/sidorares/react-x11-components/commit/b1e566b81233b0355a37889b9dc8cbf7393f054a))


### Performance Improvements

* **html:** a sprite's copy is resolved once for the drawings of a style, which a page's icons mostly share ([#526](https://github.com/sidorares/react-x11-components/issues/526)) ([05a6091](https://github.com/sidorares/react-x11-components/commit/05a6091060b62517143dd98a35276cf0f538cc2f))

## [0.14.1](https://github.com/sidorares/react-x11-components/compare/v0.14.0...v0.14.1) (2026-09-30)


### Bug Fixes

* **html:** a double border of one colour is two frames, its lines joined at the corners ([#503](https://github.com/sidorares/react-x11-components/issues/503)) ([5e74324](https://github.com/sidorares/react-x11-components/commit/5e743244e820bfc4b32e59001094c4e70feb37f6))
* **html:** a grid item with a percentage width makes an auto column as wide as its content, where it made it nothing ([#508](https://github.com/sidorares/react-x11-components/issues/508)) ([c4e5ecd](https://github.com/sidorares/react-x11-components/commit/c4e5ecdd427bab1133e09222e3af2e4573064fc7))
* **html:** a rule that names a shape inside an inline SVG paints it, where only the root's fill and stroke were read ([#495](https://github.com/sidorares/react-x11-components/issues/495)) ([226903a](https://github.com/sidorares/react-x11-components/commit/226903afd29aa7eb0891b8bdd0fadf1cdcd90b7a))
* **html:** a table a flex box or a grid stretches gives the height to its rows, and a grid stretches one across its area ([#506](https://github.com/sidorares/react-x11-components/issues/506)) ([b2a6150](https://github.com/sidorares/react-x11-components/commit/b2a6150e00d90dcf458ea8165ffa7ffd43b99523))
* **html:** a table cell on the baseline that sets a height needs that height of its row, not the height and its lift ([#507](https://github.com/sidorares/react-x11-components/issues/507)) ([d3ad4a0](https://github.com/sidorares/react-x11-components/commit/d3ad4a08ac92900789665009c121b941e92bd3b7))
* **html:** a table in a flex row, a grid, a float or an inline-table is as wide as its columns and the spacing either side of them ([#504](https://github.com/sidorares/react-x11-components/issues/504)) ([8ea437a](https://github.com/sidorares/react-x11-components/commit/8ea437af05ceb670a548f65267626abee66073f1))
* **html:** a thick 3D border keeps its corners on their diagonals where only part of it is repainted ([#501](https://github.com/sidorares/react-x11-components/issues/501)) ([3ee6d7b](https://github.com/sidorares/react-x11-components/commit/3ee6d7b5d086d268a586723587396d5133633208))
* **html:** a thick rounded border and a border-area background stay out of the content where only part of the box is repainted ([#510](https://github.com/sidorares/react-x11-components/issues/510)) ([c45f377](https://github.com/sidorares/react-x11-components/commit/c45f377b2824152d64019af4f80cd0f0d00fd917))
* **html:** an SVG image is painted as its own style sheets say, where it was drawn black ([#509](https://github.com/sidorares/react-x11-components/issues/509)) ([71c657d](https://github.com/sidorares/react-x11-components/commit/71c657d5b5f50dc946dbd45682250d91f5a8bc09))

## [0.14.0](https://github.com/sidorares/react-x11-components/compare/v0.13.0...v0.14.0) (2026-09-30)


### Features

* **html:** a box is painted through its transform, turned, scaled and skewed about its transform-origin ([#499](https://github.com/sidorares/react-x11-components/issues/499)) ([feba36d](https://github.com/sidorares/react-x11-components/commit/feba36d2e9a755c717e24b3a9905432966289552))
* **html:** a box that says column-span: all is set across its multicol container's columns ([#500](https://github.com/sidorares/react-x11-components/issues/500)) ([39d56f2](https://github.com/sidorares/react-x11-components/commit/39d56f213aa02b4a0427b60e5da8a285ad4ab85a))
* **html:** a multicol container sets its content in columns ([#498](https://github.com/sidorares/react-x11-components/issues/498)) ([1e2e2b7](https://github.com/sidorares/react-x11-components/commit/1e2e2b7ba4e84ca8a9f1f00987e9eef326a24df5))
* **html:** a radial-gradient() is drawn ([#486](https://github.com/sidorares/react-x11-components/issues/486)) ([ee0e4c5](https://github.com/sidorares/react-x11-components/commit/ee0e4c5619ade7ff13f7422c4a79a3d9608fd5cf))
* **html:** clip-path cuts a box and all it holds to a rectangle: inset(), rect() and xywh() ([#468](https://github.com/sidorares/react-x11-components/issues/468)) ([5871129](https://github.com/sidorares/react-x11-components/commit/587112916ad633f3acf4ac46ea3e38c448985e7f))


### Bug Fixes

* **html:** a block-level button is as wide as its content, and a button set display: inline is an inline-block ([#493](https://github.com/sidorares/react-x11-components/issues/493)) ([9f5155e](https://github.com/sidorares/react-x11-components/commit/9f5155e4fec774f5840fa7a7474539a0c99a7932))
* **html:** a button with no line in it sits on the bottom of its content box ([#474](https://github.com/sidorares/react-x11-components/issues/474)) ([ebb44d2](https://github.com/sidorares/react-x11-components/commit/ebb44d2f2f35b47b4911c9eb384546f15d689417))
* **html:** a button's content is centred in its box ([#478](https://github.com/sidorares/react-x11-components/issues/478)) ([7b2f88f](https://github.com/sidorares/react-x11-components/commit/7b2f88f9cea3116c5faae09a4d392619508bd6aa))
* **html:** a control with a negative tabindex is no Tab stop, and one under aria-hidden is kept from assistive technology ([#470](https://github.com/sidorares/react-x11-components/issues/470)) ([d46ebf6](https://github.com/sidorares/react-x11-components/commit/d46ebf6590481e3734ae95c80f0979582e96c921))
* **html:** a control's widget is cut where the document cuts its element, and a select with no options shows none ([#461](https://github.com/sidorares/react-x11-components/issues/461)) ([b5b1015](https://github.com/sidorares/react-x11-components/commit/b5b1015342a732deb9b68948a0c2c98736b3b2e0))
* **html:** a document of the colour scheme the palette is not is drawn on that scheme's canvas, where a light page had a dark window's ground ([#469](https://github.com/sidorares/react-x11-components/issues/469)) ([877085c](https://github.com/sidorares/react-x11-components/commit/877085c429610a6f9b8b5cb12e41011353f928a8))
* **html:** a flex item's percentage padding and width limits are of its flex box's width, where they were taken again of the item's own ([#467](https://github.com/sidorares/react-x11-components/issues/467)) ([948c31c](https://github.com/sidorares/react-x11-components/commit/948c31cf87f98394bfc982af7f82bb9b0a3cff78))
* **html:** a flex line whose every item its minimum stops has each at that minimum, where they were billions of pixels wide ([#491](https://github.com/sidorares/react-x11-components/issues/491)) ([8c2db4d](https://github.com/sidorares/react-x11-components/commit/8c2db4d907e526d7dcc236038faafb06deede1a8))
* **html:** a flex or grid item that is a flex box or a grid itself lays its items out in the height it was given ([#466](https://github.com/sidorares/react-x11-components/issues/466)) ([9fefd53](https://github.com/sidorares/react-x11-components/commit/9fefd53cec2a339cd0ab9f735008196b7ccad079))
* **html:** a font-family list no face matches ends in the document's font, not in the text engine's pick ([#485](https://github.com/sidorares/react-x11-components/issues/485)) ([ad8b993](https://github.com/sidorares/react-x11-components/commit/ad8b993c18918380c209c86d5f02fe3a12bce21c))
* **html:** a grid item's percentage padding, margins and width limits are of its area's width, where they were taken of the item's own ([#488](https://github.com/sidorares/react-x11-components/issues/488)) ([35cd9ee](https://github.com/sidorares/react-x11-components/commit/35cd9ee6fa2020ade410d5475a861ab18b4ec370))
* **html:** a grid sits on its first item's baseline, and a flex box or a grid in an inline-block gives it its first ([#481](https://github.com/sidorares/react-x11-components/issues/481)) ([07c5a1e](https://github.com/sidorares/react-x11-components/commit/07c5a1e0264f71c2edf974762618a5cf05a15014))
* **html:** a line through is as thick as its font size makes it, and drawn in its style ([#472](https://github.com/sidorares/react-x11-components/issues/472)) ([6209501](https://github.com/sidorares/react-x11-components/commit/6209501700eb8e138587bf21dc29bbc6d9e2ee3c))
* **html:** a percentage width is auto where its containing block is as wide as its content ([#473](https://github.com/sidorares/react-x11-components/issues/473)) ([53578a1](https://github.com/sidorares/react-x11-components/commit/53578a16fd0d30c65f4a5ed114351ad57f385137))
* **html:** a table cell's percentage padding is of its row's width, and a percentage in its width limits is its column's to weigh, where both were taken again of the cell's own width ([#494](https://github.com/sidorares/react-x11-components/issues/494)) ([65c377d](https://github.com/sidorares/react-x11-components/commit/65c377d043a460d76864318dc5bed438e333ea4b))
* **html:** a WOFF2 the text engine does not take is set from the font inside it, and a variable face at the weight its rule has for a style's ([#496](https://github.com/sidorares/react-x11-components/issues/496)) ([c134b6e](https://github.com/sidorares/react-x11-components/commit/c134b6e9583226da23d4d440cf274447072660ec))
* **html:** an [@font-face](https://github.com/font-face) of local() sources is the system family it names, where the name the document gave it went to the text engine ([#465](https://github.com/sidorares/react-x11-components/issues/465)) ([c670266](https://github.com/sidorares/react-x11-components/commit/c6702665078ab1bfd24c9be5226a932a7e709b8e))
* **html:** an [@import](https://github.com/import)'s media queries are conditions on the sheet it imports ([#483](https://github.com/sidorares/react-x11-components/issues/483)) ([4904d70](https://github.com/sidorares/react-x11-components/commit/4904d70ed6f9bf1d5c8f4199f7092482a682e774))
* **html:** an absolute box with no offsets in a table cell goes where the cell's vertical-align put its content ([#492](https://github.com/sidorares/react-x11-components/issues/492)) ([f37c12c](https://github.com/sidorares/react-x11-components/commit/f37c12cfa37551a04c9fc94a2375c493839e31d8))
* **html:** an absolute form control with both offsets on an axis fills what they leave ([#463](https://github.com/sidorares/react-x11-components/issues/463)) ([e82672c](https://github.com/sidorares/react-x11-components/commit/e82672c5ae5898a73f3eae5f005b04829a7a6399))
* **html:** an inline SVG is painted with the fill and stroke the document's styles give it ([#477](https://github.com/sidorares/react-x11-components/issues/477)) ([da41109](https://github.com/sidorares/react-x11-components/commit/da411091c786fd5fd40c88467667e66dd0e2a6fd))
* **html:** an inline SVG's use draws a symbol from another svg of the document, fitted to its viewport, where an icon sprite drew nothing ([#471](https://github.com/sidorares/react-x11-components/issues/471)) ([521c253](https://github.com/sidorares/react-x11-components/commit/521c253414bb75dafcc578ff67564e129f07f44e))
* **html:** an underline left at auto is as thick as its font size makes it, and a thick dotted one is round dots ([#462](https://github.com/sidorares/react-x11-components/issues/462)) ([6777422](https://github.com/sidorares/react-x11-components/commit/67774224a9ae2b94f36d9302f3e20c5edc63fb4f))
* **html:** nextjs.org's header as Chrome lays it out — flex items frozen at their minimums, a row as wide as its buttons, truncated labels measured whole ([#479](https://github.com/sidorares/react-x11-components/issues/479)) ([e30c8f9](https://github.com/sidorares/react-x11-components/commit/e30c8f92e7cf2f9331066169c9aaf523b70c9ab1))
* **html:** the margins of what a flex item holds stay inside it, and a grid item's ([#497](https://github.com/sidorares/react-x11-components/issues/497)) ([5c5e210](https://github.com/sidorares/react-x11-components/commit/5c5e210c2e927cb9906e603676bbf509e31fb66e))
* **html:** the pointer passes through a box that is hidden, or takes no pointer events ([#476](https://github.com/sidorares/react-x11-components/issues/476)) ([210db19](https://github.com/sidorares/react-x11-components/commit/210db19821f36bd964876d7f5c690aa854742ec9))
* **html:** the space white space collapses to is the first one's, in the element it was written in ([#480](https://github.com/sidorares/react-x11-components/issues/480)) ([70b76b1](https://github.com/sidorares/react-x11-components/commit/70b76b1fae2ddd741622600d433da096f62e176c))
* **html:** two sides of different colours share their corner on its diagonal, so a CSS triangle is a triangle ([#490](https://github.com/sidorares/react-x11-components/issues/490)) ([49a4f32](https://github.com/sidorares/react-x11-components/commit/49a4f32b05e107e55f43b6ae1db86418d26efdc4))
* **html:** what `clip` cuts away of an absolute box is not under the pointer, where a label hidden with it took the press of the link under it ([#487](https://github.com/sidorares/react-x11-components/issues/487)) ([135af13](https://github.com/sidorares/react-x11-components/commit/135af136058db272996e1f67646ae716f239f031))

## [0.13.0](https://github.com/sidorares/react-x11-components/compare/v0.12.0...v0.13.0) (2026-09-30)


### Features

* **html:** ::selection colours a selection's band and its text ([#453](https://github.com/sidorares/react-x11-components/issues/453)) ([b2cdc0a](https://github.com/sidorares/react-x11-components/commit/b2cdc0a065beda216b705cab4843f5f7f91daea8))
* **html:** submit forms — an onSubmit seam, labels, image buttons and validation, and the example browser sends them ([#435](https://github.com/sidorares/react-x11-components/issues/435)) ([19b1774](https://github.com/sidorares/react-x11-components/commit/19b1774260078ecc48f66d8b00b343add7c1c886))


### Bug Fixes

* **examples:** the browser reads a data: URL itself, as Fetch's data: URL processor does ([#449](https://github.com/sidorares/react-x11-components/issues/449)) ([ab67168](https://github.com/sidorares/react-x11-components/commit/ab67168f098cb1b785f462aea9a536a7408fc0d6))
* **html:** a control the page set in its own font draws in it ([#451](https://github.com/sidorares/react-x11-components/issues/451)) ([49556bf](https://github.com/sidorares/react-x11-components/commit/49556bf9e10cb488e905dab3797986f88d72f00e))
* **html:** a device-width query is the viewport's width, so a phone sheet stays off a desktop ([#443](https://github.com/sidorares/react-x11-components/issues/443)) ([b48ed14](https://github.com/sidorares/react-x11-components/commit/b48ed14c6e0cf5ba678ee9f7b784eff556cda5cb))
* **html:** a form control's text is the palette's face, not the page's ([#446](https://github.com/sidorares/react-x11-components/issues/446)) ([ad0f658](https://github.com/sidorares/react-x11-components/commit/ad0f65843f7cb32d30e76355db8f2c6f612a1790))
* **html:** a form control's text is the palette's size, not its parent's ([#442](https://github.com/sidorares/react-x11-components/issues/442)) ([72d4d58](https://github.com/sidorares/react-x11-components/commit/72d4d580d1db6eaae3937a2b07a9a53e6ea13a4d))
* **html:** a media query on a size that is no length does not parse, and holds nowhere ([#450](https://github.com/sidorares/react-x11-components/issues/450)) ([326c313](https://github.com/sidorares/react-x11-components/commit/326c3139dc1f2a08a2d20f0116e403ce845b5df0))
* **html:** a media query on the viewport's height is answered from it, and again when it moves ([#439](https://github.com/sidorares/react-x11-components/issues/439)) ([c3efceb](https://github.com/sidorares/react-x11-components/commit/c3efceb338dc4212b6994890fd7cb0f4b03cdcc8))
* **html:** a rem is the root element's font size, and the initial one in the root's own ([#440](https://github.com/sidorares/react-x11-components/issues/440)) ([ab8aa89](https://github.com/sidorares/react-x11-components/commit/ab8aa899e2bd8b853a299b4a8f0e8f0a5e9f27d7))
* **html:** a variable web font the text engine cannot cut an instance from is passed over, where it left the document blank ([#459](https://github.com/sidorares/react-x11-components/issues/459)) ([91ed442](https://github.com/sidorares/react-x11-components/commit/91ed442e2839c7ba560526116824ec349de7bf82))
* **html:** an inline box around a block that clears floats measures from where clearance moved the block from ([#454](https://github.com/sidorares/react-x11-components/issues/454)) ([40851a4](https://github.com/sidorares/react-x11-components/commit/40851a42b7e72bef02d42f301b82973d2002731b))
* **html:** glyphs taller than their line are selected over and repainted where they reach ([#448](https://github.com/sidorares/react-x11-components/issues/448)) ([f58e5ac](https://github.com/sidorares/react-x11-components/commit/f58e5ac99666c109c30e9f6240ac589e28009d48))
* **html:** media queries on the resolution, the orientation, the pointer and the rest are answered, and one on a feature nothing knows is false ([#455](https://github.com/sidorares/react-x11-components/issues/455)) ([0f06def](https://github.com/sidorares/react-x11-components/commit/0f06def26d9c9834467aaeddd5ecfd57f1da0662))
* **html:** Wikipedia's search bar is Chrome's height — a styled button's UA edges, a flex item's negative margin ([#445](https://github.com/sidorares/react-x11-components/issues/445)) ([c69e976](https://github.com/sidorares/react-x11-components/commit/c69e9763dfc08800f3732964fe22e92b699b2c98))


### Performance Improvements

* **html:** a hover waits for a scroll to stop, and a :hover inside :is() restyles where it is ([#458](https://github.com/sidorares/react-x11-components/issues/458)) ([978832a](https://github.com/sidorares/react-x11-components/commit/978832ac7c6d8c874925574a210d3d8afa2e1836))

## [0.12.0](https://github.com/sidorares/react-x11-components/compare/v0.11.0...v0.12.0) (2026-09-30)


### Features

* **html:** light-dark() and color-scheme, resolved against the palette's scheme ([#427](https://github.com/sidorares/react-x11-components/issues/427)) ([21c871e](https://github.com/sidorares/react-x11-components/commit/21c871ec3ac713a7638be32d6fa6d86ba15975a2))
* **html:** the small, large and dynamic viewport units, and vi and vb ([#429](https://github.com/sidorares/react-x11-components/issues/429)) ([bf45d0a](https://github.com/sidorares/react-x11-components/commit/bf45d0a9943fc622bd7036ff229c36d5fe2eb5a9))
* **html:** Wikipedia's header drawn as Chrome draws it ([#415](https://github.com/sidorares/react-x11-components/issues/415)) ([ba37425](https://github.com/sidorares/react-x11-components/commit/ba3742582aec487c664fb5e2c746464038bae815))


### Bug Fixes

* **examples:** the browser asks a secure page's insecure stylesheets and fonts for nothing, and its images over https, as a browser does ([#437](https://github.com/sidorares/react-x11-components/issues/437)) ([418b75d](https://github.com/sidorares/react-x11-components/commit/418b75da4619f462f2d111f248649e91204ef8a7))
* **html:** a /&gt; closes only a void element and one in SVG or MathML ([#430](https://github.com/sidorares/react-x11-components/issues/430)) ([9c4c664](https://github.com/sidorares/react-x11-components/commit/9c4c664d456abfdad1250c14159b0ba807d2afef))
* **html:** a bold or italic word's line height is measured, not taken for its family's ([#436](https://github.com/sidorares/react-x11-components/issues/436)) ([545bc0d](https://github.com/sidorares/react-x11-components/commit/545bc0d9defbcf7a9e7cbd02eec146bd7d578fa4))
* **html:** a box with a formatting context of its own, too wide for a column no float narrows, stays beside the float ([#424](https://github.com/sidorares/react-x11-components/issues/424)) ([d174dca](https://github.com/sidorares/react-x11-components/commit/d174dca1c97345ff5c140bc5936e4a1d5f739238))
* **html:** a box's leading is split with the half above rounded down to a whole pixel, as Blink splits it ([#402](https://github.com/sidorares/react-x11-components/issues/402)) ([14228b9](https://github.com/sidorares/react-x11-components/commit/14228b9a2540115525b6fe4f13a008b6a38c425f))
* **html:** a control's text keeps none of the line height or spacing around it ([#431](https://github.com/sidorares/react-x11-components/issues/431)) ([e7a3571](https://github.com/sidorares/react-x11-components/commit/e7a3571f37d0acabae9babd16f8c96cadcb2099b))
* **html:** a fixed box and a fixed background stay where the scroll pane's viewport is ([#416](https://github.com/sidorares/react-x11-components/issues/416)) ([35064ed](https://github.com/sidorares/react-x11-components/commit/35064ed5a00069fe0409b588a6ab1b54f92a10ba))
* **html:** a hover that gives an inline box a background paints it in place ([#398](https://github.com/sidorares/react-x11-components/issues/398)) ([f8fb71b](https://github.com/sidorares/react-x11-components/commit/f8fb71bf3cc12e1ec20ad07ac2765b029337b970))
* **html:** a line composed a piece at a time fits each piece as a browser does, with a 64th of a pixel to spare ([#419](https://github.com/sidorares/react-x11-components/issues/419)) ([a526ebb](https://github.com/sidorares/react-x11-components/commit/a526ebb69d9f054a0b9f2a4a8165c14a56b92dc4))
* **html:** a line laid out a piece at a time is put in bidi order by its paragraph's levels ([#423](https://github.com/sidorares/react-x11-components/issues/423)) ([62cd69c](https://github.com/sidorares/react-x11-components/commit/62cd69c4cd61146bc07e93a762a7cf08a8ff98d6)), closes [#149](https://github.com/sidorares/react-x11-components/issues/149)
* **html:** a paragraph's lines are fitted as a browser fits them, each element's text rounded up to a 64th ([#412](https://github.com/sidorares/react-x11-components/issues/412)) ([c6f675e](https://github.com/sidorares/react-x11-components/commit/c6f675e2f8cd882a3b390a17b3dba08078fb44bf))
* **html:** a percentage line height is of the element's own font size, whichever rule sets it ([#418](https://github.com/sidorares/react-x11-components/issues/418)) ([a062311](https://github.com/sidorares/react-x11-components/commit/a062311dd9ea87ba4ff09a0d619f09aa219e981e))
* **html:** a piece of a line goes on after its trailing space by what the engine says the space takes ([#433](https://github.com/sidorares/react-x11-components/issues/433)) ([c1184e0](https://github.com/sidorares/react-x11-components/commit/c1184e0a1e184fb20435775b2a121b358adca103))
* **html:** a positioned box a clipping box holds makes the document no taller ([#403](https://github.com/sidorares/react-x11-components/issues/403)) ([d0c20c6](https://github.com/sidorares/react-x11-components/commit/d0c20c6b16263983bcd96d64191e92607f253adf))
* **html:** a pseudo-element's background image is asked for, as its element's ([#409](https://github.com/sidorares/react-x11-components/issues/409)) ([828ebca](https://github.com/sidorares/react-x11-components/commit/828ebcaff5c23494b9a39af3e45c69b825f8e5a3))
* **html:** a relatively positioned inline element's rect is where its offset moves it ([#404](https://github.com/sidorares/react-x11-components/issues/404)) ([a9a6537](https://github.com/sidorares/react-x11-components/commit/a9a653763307581204cc9b9fbbb3eb3e9ed8eec7))
* **html:** a select the page styled is the page's to draw, as a text field is ([#438](https://github.com/sidorares/react-x11-components/issues/438)) ([2b19a7c](https://github.com/sidorares/react-x11-components/commit/2b19a7c5bcea79b18d257639b50efd4d14881703))
* **html:** a space justification widens keeps its kerning, as a browser's does ([#393](https://github.com/sidorares/react-x11-components/issues/393)) ([cdb5cb7](https://github.com/sidorares/react-x11-components/commit/cdb5cb72318fff4888ee273054d52c8eb8f8d5ad))
* **html:** a wrapped inline box's images and gradients span its fragments ([#397](https://github.com/sidorares/react-x11-components/issues/397)) ([aeadc2e](https://github.com/sidorares/react-x11-components/commit/aeadc2e23fd3bda03b94f6d2c0c235ee50a3291c))
* **html:** an empty block past the end of the content makes the document no taller ([#413](https://github.com/sidorares/react-x11-components/issues/413)) ([b817847](https://github.com/sidorares/react-x11-components/commit/b8178472786978e45ae6a87aa8fc18d1ca3dbb8d))
* **html:** an inline box's edge is no place to break a line ([#420](https://github.com/sidorares/react-x11-components/issues/420)) ([f51e387](https://github.com/sidorares/react-x11-components/commit/f51e3870a55991259a99ffeac78c3b1bcd685177))
* **html:** an inline box's fragment ends at its text on a line it breaks after, not past the space the line ends on ([#425](https://github.com/sidorares/react-x11-components/issues/425)) ([a333262](https://github.com/sidorares/react-x11-components/commit/a3332629f616f830d1c8aced07d35e0e3576ab48))
* **html:** an inline box's padding and border below its line count in the document's height ([#434](https://github.com/sidorares/react-x11-components/issues/434)) ([5a224a9](https://github.com/sidorares/react-x11-components/commit/5a224a90238d03d303336bb08acc58de1a03658f))
* **html:** an inline element broken around a block takes the block's line into its rect ([#401](https://github.com/sidorares/react-x11-components/issues/401)) ([f93965b](https://github.com/sidorares/react-x11-components/commit/f93965be2b14a1aecdece7daed1ce3055bea62c9))
* **html:** an inline element whose text is set at no size is where its block's content starts ([#417](https://github.com/sidorares/react-x11-components/issues/417)) ([64c7f10](https://github.com/sidorares/react-x11-components/commit/64c7f10a4214f59f36e48b5a829d4e9f2b720673))
* **html:** an outside marker taller than a block's first line moves the block down, as Blink does ([#422](https://github.com/sidorares/react-x11-components/issues/422)) ([fddab69](https://github.com/sidorares/react-x11-components/commit/fddab696fc99d0e78005334c778c4b68af37a1f0))
* **html:** place-content sets align-content and justify-content ([#428](https://github.com/sidorares/react-x11-components/issues/428)) ([ed20a82](https://github.com/sidorares/react-x11-components/commit/ed20a82fce656c0d3ec7503e931f2362ee96dca0))
* **html:** pre-wrap's spaces at a line's end hang inside their box, and take room before a break ([#414](https://github.com/sidorares/react-x11-components/issues/414)) ([a228971](https://github.com/sidorares/react-x11-components/commit/a22897184a3daf778b5e92ce2c01ba0aa7d4fdcf)), closes [#406](https://github.com/sidorares/react-x11-components/issues/406)
* **html:** what a positioned box holds past its end makes the document taller ([#405](https://github.com/sidorares/react-x11-components/issues/405)) ([aac0691](https://github.com/sidorares/react-x11-components/commit/aac069103625b10fbe941d790f72ee03151c233c))


### Performance Improvements

* **html:** a box shadow is the context's, cast by a shape it draws from a tile ([#407](https://github.com/sidorares/react-x11-components/issues/407)) ([30e0ca2](https://github.com/sidorares/react-x11-components/commit/30e0ca223bd30d814b9382f13cf0ec1c4bafccc5))
* **html:** a hover that widens a shadow, raises a layer or lifts a box is restyled in place ([#411](https://github.com/sidorares/react-x11-components/issues/411)) ([3fad505](https://github.com/sidorares/react-x11-components/commit/3fad5050a21a55cd61352bc4d5c9ef0067b46903))

## [0.11.0](https://github.com/sidorares/react-x11-components/compare/v0.10.0...v0.11.0) (2026-09-29)


### Features

* **html:** a background clipped to border-area is painted where the border is ([#389](https://github.com/sidorares/react-x11-components/issues/389)) ([dc0c86d](https://github.com/sidorares/react-x11-components/commit/dc0c86d6a279cc1b51c51b7837f6571f3d6b75cf))


### Bug Fixes

* **html:** a ::first-line's text-transform sets the first line in capitals ([#387](https://github.com/sidorares/react-x11-components/issues/387)) ([4289cb6](https://github.com/sidorares/react-x11-components/commit/4289cb6d8f0a6fa04def9e44e5a6a6cd5210329a))
* **html:** a document with no html tag paints its html background ([#392](https://github.com/sidorares/react-x11-components/issues/392)) ([47cb6ee](https://github.com/sidorares/react-x11-components/commit/47cb6ee97d8922de323fd6e1402ec6254c1cfa8f))
* **html:** a last child's margin collapses through a percentage height that computes to auto ([#376](https://github.com/sidorares/react-x11-components/issues/376)) ([a654d4e](https://github.com/sidorares/react-x11-components/commit/a654d4e6693ad40289e7b6e023e3af8bedea3484))
* **html:** a line of smaller text alone is as tall as the block's strut ([#368](https://github.com/sidorares/react-x11-components/issues/368)) ([118a44b](https://github.com/sidorares/react-x11-components/commit/118a44b49b90e5beba1cdd523477571671f456ce))
* **html:** a list item's first line is as tall as its marker ([#388](https://github.com/sidorares/react-x11-components/issues/388)) ([6282f94](https://github.com/sidorares/react-x11-components/commit/6282f94aa4a204fcea205795cb717e156f731d3f))
* **html:** a list, a definition and a figure are indented 40px, as the HTML standard indents them ([#373](https://github.com/sidorares/react-x11-components/issues/373)) ([3b16e19](https://github.com/sidorares/react-x11-components/commit/3b16e191dac26a70116a933ec6adda6d8e68d3ca))
* **html:** an ex, a ch and an lh are the element's own face ([#372](https://github.com/sidorares/react-x11-components/issues/372)) ([bb0bfc9](https://github.com/sidorares/react-x11-components/commit/bb0bfc99b4a49250612b47650aa05a3db67f5555))
* **html:** an inline box's background images are drawn, as its colour is ([#384](https://github.com/sidorares/react-x11-components/issues/384)) ([647848c](https://github.com/sidorares/react-x11-components/commit/647848c924a6acfa078f5d3e5fb9e415e7dc5032))
* **html:** an inline element's rect is as tall as its border box, not its line ([#382](https://github.com/sidorares/react-x11-components/issues/382)) ([37f183a](https://github.com/sidorares/react-x11-components/commit/37f183a106c80ec40c8a29cd47940ee92eecc63b))
* **html:** an inline element's rect leaves out a positioned box inside it ([#385](https://github.com/sidorares/react-x11-components/issues/385)) ([5e54444](https://github.com/sidorares/react-x11-components/commit/5e544447bbeda6b295b83e570e05d6afd279f092))
* **html:** an SVG image fills the size it is drawn at ([#379](https://github.com/sidorares/react-x11-components/issues/379)) ([912096b](https://github.com/sidorares/react-x11-components/commit/912096b56cb87adaf94f4c6d5bddff4c2a99c00c))
* **html:** small capitals a face does not have are made of its capitals ([#378](https://github.com/sidorares/react-x11-components/issues/378)) ([aa35381](https://github.com/sidorares/react-x11-components/commit/aa35381c3a8bd74e8f7fa352033de719c8186fc1))
* **html:** what position: relative moves off a line is drawn where it goes ([#390](https://github.com/sidorares/react-x11-components/issues/390)) ([019fb18](https://github.com/sidorares/react-x11-components/commit/019fb18bef682c9bb33aa12c26750f3b3ea98fa2))


### Performance Improvements

* **code-language:** a block of code that changes at its end is tokenized from there ([#381](https://github.com/sidorares/react-x11-components/issues/381)) ([b81d1d2](https://github.com/sidorares/react-x11-components/commit/b81d1d245f0c60c083f08562931436c3dea62f26))
* **code:** a long source is drawn in blocks, so a streamed line repaints one ([#377](https://github.com/sidorares/react-x11-components/issues/377)) ([7850aca](https://github.com/sidorares/react-x11-components/commit/7850acaeed8d832e74e7864cee20b96c28d844cb))
* **markdown:** a table that streams keeps the rows it had ([#383](https://github.com/sidorares/react-x11-components/issues/383)) ([d4d9370](https://github.com/sidorares/react-x11-components/commit/d4d9370f5932a4fe1b3a4ccd0f7404dae61752cb))
* **rich-text-editor:** a value that streams in costs the blocks it changes ([#391](https://github.com/sidorares/react-x11-components/issues/391)) ([1b691fe](https://github.com/sidorares/react-x11-components/commit/1b691fe84afd0848f2913fa9caf1506f415dfa22))
* **terminal-output:** a long capture is drawn as blocks, so an append lays out one ([#375](https://github.com/sidorares/react-x11-components/issues/375)) ([21fa865](https://github.com/sidorares/react-x11-components/commit/21fa8659227e98195bfb1f375cf30902fb11985b))

## [0.10.0](https://github.com/sidorares/react-x11-components/compare/v0.9.0...v0.10.0) (2026-09-29)


### Features

* **code-editor:** squiggles follow edits, and what the editor paints stays true through them ([#139](https://github.com/sidorares/react-x11-components/issues/139)) ([5da30ba](https://github.com/sidorares/react-x11-components/commit/5da30bafbb044f7f9f0174d895357f5d08a68f3d))
* **flow:** renderer="gl" — the graph on the GPU, 200 nodes panning at 120 Hz ([#128](https://github.com/sidorares/react-x11-components/issues/128)) ([eac0367](https://github.com/sidorares/react-x11-components/commit/eac0367dfae2afed96ba8db3c75325516c44f99e))
* **html:** ::first-letter, collapsing borders, overflow clipping and positioning ([#153](https://github.com/sidorares/react-x11-components/issues/153)) ([abe28f4](https://github.com/sidorares/react-x11-components/commit/abe28f41f3496cae5caa3d4fc2f4a81da01f3dec))
* **html:** ::first-line's colour and background, and a pseudo-element ends its selector — CSS 2.1 round 18 ([#174](https://github.com/sidorares/react-x11-components/issues/174)) ([4c026ca](https://github.com/sidorares/react-x11-components/commit/4c026ca992f1d6438c6d212c9ce3cc90503a3b7c))
* **html:** a background is drawn at the size background-size gives it ([#220](https://github.com/sidorares/react-x11-components/issues/220)) ([848c2df](https://github.com/sidorares/react-x11-components/commit/848c2df4b647a6b0b314eed5c18e2a78c76f23b0))
* **html:** a background is every one of its layers ([#221](https://github.com/sidorares/react-x11-components/issues/221)) ([e782794](https://github.com/sidorares/react-x11-components/commit/e7827947a19f2340e3c9d7a662ff106ad5276bf1))
* **html:** a background painted through its text ([#227](https://github.com/sidorares/react-x11-components/issues/227)) ([caf88a9](https://github.com/sidorares/react-x11-components/commit/caf88a9be2202f826d905666a9d58c44e27afb87))
* **html:** a closed details shows its summary, and inside markers take their room ([#208](https://github.com/sidorares/react-x11-components/issues/208)) ([7bf17b8](https://github.com/sidorares/react-x11-components/commit/7bf17b8f2263ba2e4837ebe3825fe4aa8c2480f6))
* **html:** a kept tab goes to its tab stop, and tab-size is read ([#211](https://github.com/sidorares/react-x11-components/issues/211)) ([737b9e1](https://github.com/sidorares/react-x11-components/commit/737b9e1e7028933fcb1817a349ce3ba31ee80781))
* **html:** a list's markers are set in the style ::marker gives them ([#218](https://github.com/sidorares/react-x11-components/issues/218)) ([b1ecb4b](https://github.com/sidorares/react-x11-components/commit/b1ecb4b4d6960fe724a77e34cb03ed0486803c94))
* **html:** an underline sits at its offset, as thick as its thickness ([#219](https://github.com/sidorares/react-x11-components/issues/219)) ([9e0cc76](https://github.com/sidorares/react-x11-components/commit/9e0cc76b8ba24a637b25b74410dea89b23299223))
* **html:** aspect-ratio and object-fit, and a flex box's content height ([#201](https://github.com/sidorares/react-x11-components/issues/201)) ([2e50fe1](https://github.com/sidorares/react-x11-components/commit/2e50fe14bdd3914bfceb757730040e8b8ea1c76e))
* **html:** background images, and the layout fixes the CSS 2.1 suite found ([#145](https://github.com/sidorares/react-x11-components/issues/145)) ([5faf0c3](https://github.com/sidorares/react-x11-components/commit/5faf0c39a3772c641a3d14af8dc15abae0f9edb6))
* **html:** base URLs and [@font-face](https://github.com/font-face) through the resource seam, and a tabbed web browser example ([#264](https://github.com/sidorares/react-x11-components/issues/264)) ([4022598](https://github.com/sidorares/react-x11-components/commit/402259863beb46b44737842443d93e57ffc1cf19))
* **html:** border-image ([#347](https://github.com/sidorares/react-x11-components/issues/347)) ([78375ee](https://github.com/sidorares/react-x11-components/commit/78375eefca0f92ee868b73c5ad1e9aab11daa451))
* **html:** box shadows ([#200](https://github.com/sidorares/react-x11-components/issues/200)) ([4999485](https://github.com/sidorares/react-x11-components/commit/499948573c737fd242252198dcef0c3e240e33ac))
* **html:** calc(), min(), max() and clamp(), and percentages and intrinsic widths as they resolve — CSS 2.1 round 20 ([#177](https://github.com/sidorares/react-x11-components/issues/177)) ([6b41297](https://github.com/sidorares/react-x11-components/commit/6b4129789367d48a9ae19ba5106f20988e81b952))
* **html:** cascade layers ([#193](https://github.com/sidorares/react-x11-components/issues/193)) ([36b8b86](https://github.com/sidorares/react-x11-components/commit/36b8b869080ae56480831646ad35d19992918706))
* **html:** color-mix() ([#179](https://github.com/sidorares/react-x11-components/issues/179)) ([1fa41b1](https://github.com/sidorares/react-x11-components/commit/1fa41b13e769b45fc610caf83550ca4f5f488be6))
* **html:** CSS Color 4's colour functions, CSS syntax as it is read, and the body's inheritance — CSS 2.1 round 19 ([#176](https://github.com/sidorares/react-x11-components/issues/176)) ([261e3aa](https://github.com/sidorares/react-x11-components/commit/261e3aaccff2637480970059eb09728df0bfce7f))
* **html:** CSS containment, contain-intrinsic-size and content-visibility ([#341](https://github.com/sidorares/react-x11-components/issues/341)) ([feef9c4](https://github.com/sidorares/react-x11-components/commit/feef9c43d9e0a4589a1b17e43e2f639b3cfabc42))
* **html:** custom properties and var(), and :root as the html element — CSS round 21 ([#178](https://github.com/sidorares/react-x11-components/issues/178)) ([ad83452](https://github.com/sidorares/react-x11-components/commit/ad83452b2e66143683475d208268b142a3182656))
* **html:** display: contents ([#229](https://github.com/sidorares/react-x11-components/issues/229)) ([be17607](https://github.com/sidorares/react-x11-components/commit/be17607f7239840628cf678705a55858870b8738))
* **html:** display: grid ([#196](https://github.com/sidorares/react-x11-components/issues/196)) ([8a88380](https://github.com/sidorares/react-x11-components/commit/8a8838054dc3966e042efd62666babc2a2feddf4))
* **html:** fit-content, max-content and min-content are widths ([#222](https://github.com/sidorares/react-x11-components/issues/222)) ([c715771](https://github.com/sidorares/react-x11-components/commit/c715771100ee3a297cdc70fb75717a1a1c4a73f7))
* **html:** fixed backgrounds, floats inside inline boxes, and tables no narrower than their content, CSS 2.1 round 12 ([#164](https://github.com/sidorares/react-x11-components/issues/164)) ([4808965](https://github.com/sidorares/react-x11-components/commit/48089650e72a7f7ce83b7014a4e5847785664d7a))
* **html:** flow-root, and the margins of a box beside a float or under a min-height ([#188](https://github.com/sidorares/react-x11-components/issues/188)) ([6364625](https://github.com/sidorares/react-x11-components/commit/63646257b5a0e40dee760ebe0b848223b72ec1e3))
* **html:** generated content, and the layout fixes it brought to light ([#146](https://github.com/sidorares/react-x11-components/issues/146)) ([73d3f34](https://github.com/sidorares/react-x11-components/commit/73d3f34b24fcc6087abe2d935515f7c3e03ca05b))
* **html:** images in generated content ([#184](https://github.com/sidorares/react-x11-components/issues/184)) ([517027e](https://github.com/sidorares/react-x11-components/commit/517027e6abbea8e58877355c6f91de632ccf2ca4))
* **html:** inline boxes take their padding, border and margin ([#148](https://github.com/sidorares/react-x11-components/issues/148)) ([788d83b](https://github.com/sidorares/react-x11-components/commit/788d83b51679d6f4d535e731104e0cee7e6d7c76))
* **html:** justified text, and text that does not wrap is aligned in its box ([#209](https://github.com/sidorares/react-x11-components/issues/209)) ([ae7d90a](https://github.com/sidorares/react-x11-components/commit/ae7d90a1b37bc4aa7ef0719ad585652a8ed2dace))
* **html:** line-clamp, and a truncated line's ellipsis ([#204](https://github.com/sidorares/react-x11-components/issues/204)) ([a42965a](https://github.com/sidorares/react-x11-components/commit/a42965a02a4471880d7a0c49611f4512cd7861e3))
* **html:** linear gradients ([#198](https://github.com/sidorares/react-x11-components/issues/198)) ([c5d6418](https://github.com/sidorares/react-x11-components/commit/c5d641818dcfe3309600de38c999ed6bb1df6d91))
* **html:** list-style-image, and the list-style shorthand's grammar ([#231](https://github.com/sidorares/react-x11-components/issues/231)) ([63759c1](https://github.com/sidorares/react-x11-components/commit/63759c17f79c6fe57a29ab52c9a4ea06e92c9b55))
* **html:** lists count with the list-item counter, as CSS Lists 3 has it ([#242](https://github.com/sidorares/react-x11-components/issues/242)) ([8f7dbbf](https://github.com/sidorares/react-x11-components/commit/8f7dbbfa6e250ef4f6064196a1f31ddd32d6b1e7))
* **html:** logical properties, inset and a single corner's radius ([#192](https://github.com/sidorares/react-x11-components/issues/192)) ([af59018](https://github.com/sidorares/react-x11-components/commit/af590180d56500e7c79813cc94398d36400c7587))
* **html:** nested rules, and media queries' width ranges ([#194](https://github.com/sidorares/react-x11-components/issues/194)) ([12483a9](https://github.com/sidorares/react-x11-components/commit/12483a9bd5b15fe42d8d16e2838a9aca3b267460))
* **html:** outlines ([#230](https://github.com/sidorares/react-x11-components/issues/230)) ([1d8ac00](https://github.com/sidorares/react-x11-components/commit/1d8ac00da362a55217658085bef0e1ee9c055bd6))
* **html:** overflow-clip-margin, background-clip and background-origin ([#344](https://github.com/sidorares/react-x11-components/issues/344)) ([a97bff0](https://github.com/sidorares/react-x11-components/commit/a97bff09f245fd4d244bc1ffabb45fe07c56a8ab))
* **html:** percentage and elliptical radii, and calc()'s infinity ([#199](https://github.com/sidorares/react-x11-components/issues/199)) ([56da1db](https://github.com/sidorares/react-x11-components/commit/56da1dbfc697fd2aed1fd08472b95b24f7b7a7f9))
* **html:** stylesheets decoded as CSS says, and clips and replaced sizes that match a browser, CSS 2.1 round 8 ([#160](https://github.com/sidorares/react-x11-components/issues/160)) ([9b25885](https://github.com/sidorares/react-x11-components/commit/9b2588505410e3ab7ececa11e7444cc68a2ade7b))
* **html:** SVG drawn, and images that keep their proportions within their limits, CSS 2.1 round 13 ([#165](https://github.com/sidorares/react-x11-components/issues/165)) ([16fecd9](https://github.com/sidorares/react-x11-components/commit/16fecd94182518b1384f34bfb211cf8c22c76c55))
* **html:** text casts the shadows text-shadow gives it ([#213](https://github.com/sidorares/react-x11-components/issues/213)) ([7bd4446](https://github.com/sidorares/react-x11-components/commit/7bd4446a46bb6d26780a6f08416ed954777cae23))
* **html:** text is shaped with the OpenType features its style asks for ([#212](https://github.com/sidorares/react-x11-components/issues/212)) ([c88fbb7](https://github.com/sidorares/react-x11-components/commit/c88fbb7e43f72168a5c457e502195a67e871a1df))
* **html:** text-wrap, and a balanced heading ([#223](https://github.com/sidorares/react-x11-components/issues/223)) ([3d2c73e](https://github.com/sidorares/react-x11-components/commit/3d2c73e0fdc07890e0954835205d695397ba1b53))
* **html:** translate, and the translation in a transform ([#224](https://github.com/sidorares/react-x11-components/issues/224)) ([2bf3b6e](https://github.com/sidorares/react-x11-components/commit/2bf3b6e11f5bfa3a75d930b6b385415e6f36863f))
* **html:** unicode-bidi, and HTML's dir, bdi and bdo ([#185](https://github.com/sidorares/react-x11-components/issues/185)) ([9ba8325](https://github.com/sidorares/react-x11-components/commit/9ba8325ed162753b15d2f35ad95c397722a90add))
* **maps:** a bus on a bus stop, house numbers from zoom 18, and snapBuildingNumbers to set them inside their buildings ([#113](https://github.com/sidorares/react-x11-components/issues/113)) ([9fbf881](https://github.com/sidorares/react-x11-components/commit/9fbf881fa374d23744be2e9f7cbf776a7fe9cb4a))


### Bug Fixes

* **code-editor:** a wheel notch scrolls a notch, not forty-eight of them ([#132](https://github.com/sidorares/react-x11-components/issues/132)) ([d4acdf9](https://github.com/sidorares/react-x11-components/commit/d4acdf90f851e25c0d3f8517caab2e979dcd72af))
* **code-editor:** row fills on whole device pixels, so a selection has no seams ([#339](https://github.com/sidorares/react-x11-components/issues/339)) ([1731464](https://github.com/sidorares/react-x11-components/commit/1731464ea978ccc522bba4eb9ab1e075a9891219))
* **codeblock:** unwrapped code is as wide as its longest line ([#365](https://github.com/sidorares/react-x11-components/issues/365)) ([14c302b](https://github.com/sidorares/react-x11-components/commit/14c302bf8c437a6bf2531a6a33b6a2f173cc09e8))
* **examples:** the GL map's error line outlasts the frame summary — a failed map said "idle" ([#122](https://github.com/sidorares/react-x11-components/issues/122)) ([13a1791](https://github.com/sidorares/react-x11-components/commit/13a1791de829e118f1501bf8f72ab6bc19258025))
* **flow:** an animated zoom holds its bodies however slow its frames ([#240](https://github.com/sidorares/react-x11-components/issues/240)) ([e0b7878](https://github.com/sidorares/react-x11-components/commit/e0b7878ae5aaf208bfc11d233f5ad66c2831a5cf))
* **flow:** an edge's arrowheads are in its box, for the cull and for a move's claim ([#357](https://github.com/sidorares/react-x11-components/issues/357)) ([2cd086f](https://github.com/sidorares/react-x11-components/commit/2cd086f0327095df03a54ce23f59b2aa546cd3b0))
* **flow:** every pass draws what a full repaint draws ([#342](https://github.com/sidorares/react-x11-components/issues/342)) ([20b99be](https://github.com/sidorares/react-x11-components/commit/20b99bead2d7545f47699909762ea6e862d27f1a))
* **flow:** how edges are stroked is the pane's choice, not a pass's ([#364](https://github.com/sidorares/react-x11-components/issues/364)) ([52f70dd](https://github.com/sidorares/react-x11-components/commit/52f70dd5445409c37ef231914475d48dd953d120))
* **flow:** one edge is one path, however a pass cuts it ([#358](https://github.com/sidorares/react-x11-components/issues/358)) ([2eb7f2f](https://github.com/sidorares/react-x11-components/commit/2eb7f2f812e0071d6cc717ac8eabbd38e52af5f6))
* **flow:** under GL the world draws every card, so a zoom never shows bare edges ([#251](https://github.com/sidorares/react-x11-components/issues/251)) ([1d5cab2](https://github.com/sidorares/react-x11-components/commit/1d5cab24cdc07ccb043b3ab9eba8850835e7bb92))
* **html:** a ::first-line that sets fonts lays the first line out in them ([#359](https://github.com/sidorares/react-x11-components/issues/359)) ([03cd59b](https://github.com/sidorares/react-x11-components/commit/03cd59b309b02525b1454f234b0df0cb4ccb2b46))
* **html:** a :hover in a :has() follows the pointer, and restyles in place ([#361](https://github.com/sidorares/react-x11-components/issues/361)) ([f2d4929](https://github.com/sidorares/react-x11-components/commit/f2d4929f505a1f50b54f3e3f769292260a6acfc1))
* **html:** a block in an inline box stands on its own line, and right-to-left documents, CSS 2.1 round 15 ([#170](https://github.com/sidorares/react-x11-components/issues/170)) ([34191fe](https://github.com/sidorares/react-x11-components/commit/34191fe3d20d9f81f816ae4ba10122ddd95c8307))
* **html:** a box as wide as its content measures its floats side by side ([#239](https://github.com/sidorares/react-x11-components/issues/239)) ([a306eb9](https://github.com/sidorares/react-x11-components/commit/a306eb9c12dbf7ab42eb5ebd5ffa1430633a6bd1))
* **html:** a box's edges on the pixel each falls nearest ([#189](https://github.com/sidorares/react-x11-components/issues/189)) ([de4306b](https://github.com/sidorares/react-x11-components/commit/de4306b52840dd81dd9ec3982606b71fb2fa0fc9))
* **html:** a box's end edge stays on the line of the content it closes ([#354](https://github.com/sidorares/react-x11-components/issues/354)) ([5978afe](https://github.com/sidorares/react-x11-components/commit/5978afebed1df8bc2a3fbeafcd5c0e20414b162e))
* **html:** a cell with a height of its own centres its content in it ([#274](https://github.com/sidorares/react-x11-components/issues/274)) ([5db1830](https://github.com/sidorares/react-x11-components/commit/5db1830356e88e978ad9c173bb2fd9cd1e7b45d9))
* **html:** a ch is the advance of the font's "0" ([#247](https://github.com/sidorares/react-x11-components/issues/247)) ([5e545d0](https://github.com/sidorares/react-x11-components/commit/5e545d064940ae08b6dcc32a54a275e8b13f52d5))
* **html:** a collapsed border on a half-pixel grid line starts on the pixel ([#272](https://github.com/sidorares/react-x11-components/issues/272)) ([670d27b](https://github.com/sidorares/react-x11-components/commit/670d27b5807267166e6231964a2a6033a002e016))
* **html:** a document's language from its meta, and attribute selectors that are none ([#276](https://github.com/sidorares/react-x11-components/issues/276)) ([d4c8f63](https://github.com/sidorares/react-x11-components/commit/d4c8f6302137211b03f9364fc1d5c3c3454edbec))
* **html:** a flex box's background is painted with its flow's, and its items with the lines ([#325](https://github.com/sidorares/react-x11-components/issues/325)) ([d8a4d75](https://github.com/sidorares/react-x11-components/commit/d8a4d7589fc9557af57151a222d387f7e36beb05))
* **html:** a flex item is shrunk no smaller than its content ([#243](https://github.com/sidorares/react-x11-components/issues/243)) ([3080d7e](https://github.com/sidorares/react-x11-components/commit/3080d7e72be150bc68d9bc422f62effed848d1cf))
* **html:** a flex item with a width is no narrower than it or its content ([#360](https://github.com/sidorares/react-x11-components/issues/360)) ([0c2edf5](https://github.com/sidorares/react-x11-components/commit/0c2edf5933efbe44d7939bd4ba24e4052a743bc1))
* **html:** a flex item's size, its padding once, and its auto margins ([#195](https://github.com/sidorares/react-x11-components/issues/195)) ([dae518a](https://github.com/sidorares/react-x11-components/commit/dae518a02dcebab13bec23ad40f8f23ccb1271aa))
* **html:** a flex item's z-index makes it a stacking context, and flex items paint in order ([#324](https://github.com/sidorares/react-x11-components/issues/324)) ([676c8fb](https://github.com/sidorares/react-x11-components/commit/676c8fb05195f7627a2ee850bb9d584f4bf09d91))
* **html:** a flex row measured for its content does not grow its items ([#206](https://github.com/sidorares/react-x11-components/issues/206)) ([084069a](https://github.com/sidorares/react-x11-components/commit/084069aac8f6937a6251cd6de2bab6199a365813))
* **html:** a float goes on the line it is met on ([#233](https://github.com/sidorares/react-x11-components/issues/233)) ([b1c68c8](https://github.com/sidorares/react-x11-components/commit/b1c68c82b3b39783683bf3cd04abc7de8d9fcc38))
* **html:** a gradient or a shadow far past the window is cut, not thrown ([#234](https://github.com/sidorares/react-x11-components/issues/234)) ([b1cdaca](https://github.com/sidorares/react-x11-components/commit/b1cdaca1f1cc4650379d7b670b75141c148660f8))
* **html:** a hex colour of five or seven digits is none, and no longer throws ([#175](https://github.com/sidorares/react-x11-components/issues/175)) ([cf12517](https://github.com/sidorares/react-x11-components/commit/cf12517453ddb66fbe3b511d023a28f83c6c3ce8))
* **html:** a justified line fills its room however it was laid out ([#352](https://github.com/sidorares/react-x11-components/issues/352)) ([f7970c4](https://github.com/sidorares/react-x11-components/commit/f7970c4ccac31b7c455c2df235197ab317fa8329))
* **html:** a q element is in quotation marks ([#278](https://github.com/sidorares/react-x11-components/issues/278)) ([748be54](https://github.com/sidorares/react-x11-components/commit/748be543dbf195897a86c02507659261937304f1))
* **html:** a raised box is as tall on its line as its own face makes it ([#214](https://github.com/sidorares/react-x11-components/issues/214)) ([d4bde9f](https://github.com/sidorares/react-x11-components/commit/d4bde9fa7272b8bb3a54d1c561fb4ebcbaee3103))
* **html:** a replaced flex item is the size the flex layout makes it, and flex-basis: content ([#327](https://github.com/sidorares/react-x11-components/issues/327)) ([b4081e1](https://github.com/sidorares/react-x11-components/commit/b4081e10be07d318ea31a1cfe70be867cc85b3ae))
* **html:** a rounded box's border follows its corners ([#197](https://github.com/sidorares/react-x11-components/issues/197)) ([83199e7](https://github.com/sidorares/react-x11-components/commit/83199e783f0a58161273b6fed645f03ef2777f56))
* **html:** a shrink-to-fit box has the room its margins and offset leave ([#225](https://github.com/sidorares/react-x11-components/issues/225)) ([60a1691](https://github.com/sidorares/react-x11-components/commit/60a1691ae14d98ea974b2b7ed9223ec43fb5b7ec))
* **html:** a spanning cell's width goes to its columns, less the spacing ([#267](https://github.com/sidorares/react-x11-components/issues/267)) ([be1e8ad](https://github.com/sidorares/react-x11-components/commit/be1e8adc0200ebac87660f349b45d47b5e24d11f))
* **html:** a stacking context paints the positioned boxes in it ([#298](https://github.com/sidorares/react-x11-components/issues/298)) ([1749e44](https://github.com/sidorares/react-x11-components/commit/1749e44f0cec3623441c203e6150347abd4cfb49))
* **html:** a stretched or flexed item has a height for percentages ([#244](https://github.com/sidorares/react-x11-components/issues/244)) ([a964669](https://github.com/sidorares/react-x11-components/commit/a96466992237880cfa9539aa4ee8bf02eaeba011))
* **html:** a table cell sizes as CSS says, and text-decoration is read whole ([1cb9111](https://github.com/sidorares/react-x11-components/commit/1cb911155beb11f2b66af251e44c0873b13db268))
* **html:** a table in an aligned cell keeps its cells' text at their start ([#207](https://github.com/sidorares/react-x11-components/issues/207)) ([44690f7](https://github.com/sidorares/react-x11-components/commit/44690f76534689898c7af909e6b864f150f4eac8))
* **html:** a table's height given out to its rows as browsers do ([#349](https://github.com/sidorares/react-x11-components/issues/349)) ([1656e62](https://github.com/sidorares/react-x11-components/commit/1656e62c2b0a48ebd7d825eb5cd0169a6959dbc7))
* **html:** a top line's baseline, collapsed borders, a line's room and styled fields ([#310](https://github.com/sidorares/react-x11-components/issues/310)) ([ba0f6c1](https://github.com/sidorares/react-x11-components/commit/ba0f6c19ad509736bd1c1032b4a318b1a955945e))
* **html:** a top-aligned box's background is on its text, and a font's size loses to font-size ([#289](https://github.com/sidorares/react-x11-components/issues/289)) ([e520eed](https://github.com/sidorares/react-x11-components/commit/e520eed192709a5620e1bdf3e2163b383f722839))
* **html:** a truncated block cuts each of its lines, and loses none ([#210](https://github.com/sidorares/react-x11-components/issues/210)) ([1b630e2](https://github.com/sidorares/react-x11-components/commit/1b630e205ac98983dcf8d6c3bec12abd3f5c59c4))
* **html:** a word too long for its line runs past it, as in a browser ([#258](https://github.com/sidorares/react-x11-components/issues/258)) ([6bcf96f](https://github.com/sidorares/react-x11-components/commit/6bcf96faa959c410f972bf7e103043e427778761))
* **html:** absolute boxes in grids and flex boxes, and the grid shorthands ([#329](https://github.com/sidorares/react-x11-components/issues/329)) ([082c735](https://github.com/sidorares/react-x11-components/commit/082c735882d1ae5260e288043139f39613c9fa7c))
* **html:** an abbreviation with a title is underlined dotted, as the HTML standard sets it ([#356](https://github.com/sidorares/react-x11-components/issues/356)) ([8bdf7a4](https://github.com/sidorares/react-x11-components/commit/8bdf7a4701aeab72e2c49e37278829dbfa155dc6))
* **html:** an absolute box a max-width holds is centred by its auto margins ([#279](https://github.com/sidorares/react-x11-components/issues/279)) ([3d0f4b9](https://github.com/sidorares/react-x11-components/commit/3d0f4b9b6d4a683974dc950c36f8b59a15270827))
* **html:** an absolute box in a line is where the flow would have put it ([#294](https://github.com/sidorares/react-x11-components/issues/294)) ([3d39f52](https://github.com/sidorares/react-x11-components/commit/3d39f52bfde230ba59d8953a4d6b8fe498c564dc))
* **html:** an image set middle is on its parent's baseline, and capitalize goes by word ([97c9480](https://github.com/sidorares/react-x11-components/commit/97c9480cdb1b3e0369d31ebbc2e82e59098e7759))
* **html:** an image told to be a table cell is an inline image ([#273](https://github.com/sidorares/react-x11-components/issues/273)) ([0290da4](https://github.com/sidorares/react-x11-components/commit/0290da435705aaa6c1edcc9adab3da60e1e6cdcd))
* **html:** an inline box of a larger face has its own line height, not a multiple of the block's ([#355](https://github.com/sidorares/react-x11-components/issues/355)) ([853adef](https://github.com/sidorares/react-x11-components/commit/853adef928ae28eff505acc68e3ce7fb4c677287))
* **html:** an inline box's own line height, and a cleared empty block's margins ([#187](https://github.com/sidorares/react-x11-components/issues/187)) ([3f93ff6](https://github.com/sidorares/react-x11-components/commit/3f93ff6f2781425df1900140dd38df5c106d4b21))
* **html:** an inline element's rect is its border box across, padding and all ([#353](https://github.com/sidorares/react-x11-components/issues/353)) ([9b06a63](https://github.com/sidorares/react-x11-components/commit/9b06a63199cad819a8ecd16382f2875c24f81cdd))
* **html:** anonymous boxes and tables, CSS syntax, baselines and percentage heights ([#152](https://github.com/sidorares/react-x11-components/issues/152)) ([6a145bd](https://github.com/sidorares/react-x11-components/commit/6a145bddaa0d7598b040c95fbaad63e1bb146a28))
* **html:** aspect-ratio both ways, overflow: clip, and the body a written html implies ([#337](https://github.com/sidorares/react-x11-components/issues/337)) ([796a803](https://github.com/sidorares/react-x11-components/commit/796a8032603e1f6cab5338eb11f6e67abb841ccd))
* **html:** background-repeat's space and round ([#345](https://github.com/sidorares/react-x11-components/issues/345)) ([1fc48d2](https://github.com/sidorares/react-x11-components/commit/1fc48d266bf271b7f797d03186a40219c7be6c4f))
* **html:** clearance past a float the margin carries, empty inline boxes, and initial ([#299](https://github.com/sidorares/react-x11-components/issues/299)) ([dcdca94](https://github.com/sidorares/react-x11-components/commit/dcdca9449aa17beb9c43063f5b618f835b2ae975))
* **html:** collapsed borders give a corner to its top-left, a side its widest ([#270](https://github.com/sidorares/react-x11-components/issues/270)) ([3533b7a](https://github.com/sidorares/react-x11-components/commit/3533b7a9018d201ffba5aeacc2036c9a3dffba65))
* **html:** counter styles and [@counter-style](https://github.com/counter-style) ([#334](https://github.com/sidorares/react-x11-components/issues/334)) ([bf71869](https://github.com/sidorares/react-x11-components/commit/bf71869ab273e99939ddee6d28d053591ce5209d))
* **html:** CSS's paint order, and text decorations that reach what is inside, CSS 2.1 round 10 ([#162](https://github.com/sidorares/react-x11-components/issues/162)) ([3e29d9b](https://github.com/sidorares/react-x11-components/commit/3e29d9b9fd4e2e83d348eb6a5fcbac1db27d053b))
* **html:** empty-cells: hide leaves an empty cell undrawn ([#271](https://github.com/sidorares/react-x11-components/issues/271)) ([2b53ab6](https://github.com/sidorares/react-x11-components/commit/2b53ab63084ebf7706fd9fafd000e35381385dff))
* **html:** fit-content() widths, and a content's intrinsic sizes whatever the box's width ([#320](https://github.com/sidorares/react-x11-components/issues/320)) ([4100811](https://github.com/sidorares/react-x11-components/commit/41008117aeb23d62300273bc173ccdd4d8cd912b))
* **html:** fixed tables, negative z-index and absolute margins, CSS 2.1 round 6 ([#154](https://github.com/sidorares/react-x11-components/issues/154)) ([4c46f5a](https://github.com/sidorares/react-x11-components/commit/4c46f5a228910d4ef1c883f4687d107d5a1ce0de))
* **html:** flex items in order and on their baselines, and inherit for flex and grid properties ([#323](https://github.com/sidorares/react-x11-components/issues/323)) ([77b068d](https://github.com/sidorares/react-x11-components/commit/77b068d4dea06db5b754d8ec7dffe16e974292a4))
* **html:** float rules 3 and 7, a canvas's size, and a table's least height ([1748b47](https://github.com/sidorares/react-x11-components/commit/1748b477044d3a661f5a65ba2a618a7268ba9944))
* **html:** float rules 3 and 7, a canvas's size, and a table's least height ([#306](https://github.com/sidorares/react-x11-components/issues/306)) ([1748b47](https://github.com/sidorares/react-x11-components/commit/1748b477044d3a661f5a65ba2a618a7268ba9944))
* **html:** floats beside tall boxes, tables that fill their width, margins after clearance, CSS 2.1 round 11 ([#163](https://github.com/sidorares/react-x11-components/issues/163)) ([389d7e4](https://github.com/sidorares/react-x11-components/commit/389d7e41f74bb33ee8cbc2555581674ccacdaeef))
* **html:** grid areas and line names, and grid-auto-flow ([#331](https://github.com/sidorares/react-x11-components/issues/331)) ([9b3f0be](https://github.com/sidorares/react-x11-components/commit/9b3f0bec07871cfb38c7014a65f675278ba53293))
* **html:** grid items with ratios and percentage heights, auto-fit, and percentage gaps ([#338](https://github.com/sidorares/react-x11-components/issues/338)) ([5db9b03](https://github.com/sidorares/react-x11-components/commit/5db9b03ff35f513628078ee3c6fa709fb455b472))
* **html:** groove, ridge, inset and outset borders are shaded ([#205](https://github.com/sidorares/react-x11-components/issues/205)) ([d1a1df4](https://github.com/sidorares/react-x11-components/commit/d1a1df4303b353e5be08e7956c51caf0b85686df))
* **html:** HTML's presentational attributes as mail writes them — align and &lt;center&gt;, the body's colours, nowrap and clearing breaks, CSS 2.1 round 17 ([#173](https://github.com/sidorares/react-x11-components/issues/173)) ([40991ec](https://github.com/sidorares/react-x11-components/commit/40991ec8375957910d9938cea02ff9799cd48cdd))
* **html:** justify-content's start, end, left and right follow the flex box's direction ([#326](https://github.com/sidorares/react-x11-components/issues/326)) ([ea0cab7](https://github.com/sidorares/react-x11-components/commit/ea0cab7c3d801a3046c4a37e3db6a28e39591934))
* **html:** line-clamp through a flow, -webkit-line-clamp on a -webkit-box only, and lh ([#318](https://github.com/sidorares/react-x11-components/issues/318)) ([3ec873f](https://github.com/sidorares/react-x11-components/commit/3ec873fca5dd6eb51177eefff33135610b95af74))
* **html:** margins collapse through empty blocks, and a new formatting context separates from floats, CSS 2.1 round 7 ([#155](https://github.com/sidorares/react-x11-components/issues/155)) ([ffced56](https://github.com/sidorares/react-x11-components/commit/ffced56fe745fab19545f10202aa93455572e4b7))
* **html:** margins of both signs, clearance, floats beside lines, and set column widths ([#313](https://github.com/sidorares/react-x11-components/issues/313)) ([fdd2b0c](https://github.com/sidorares/react-x11-components/commit/fdd2b0cd8945ee7fbcbadcb61179bf0831e48264))
* **html:** nested boxes that size themselves are laid out once a level ([#235](https://github.com/sidorares/react-x11-components/issues/235)) ([911141b](https://github.com/sidorares/react-x11-components/commit/911141b4386f1134ae3ee34237f6d2ae7b307f73))
* **html:** nested grids and rows of floats lay out in a moment ([#238](https://github.com/sidorares/react-x11-components/issues/238)) ([e5eac7d](https://github.com/sidorares/react-x11-components/commit/e5eac7d83a4718a88e7b0b1026417210dbe95f56))
* **html:** nested tables lay out in a moment, and an empty clip paints nothing ([#241](https://github.com/sidorares/react-x11-components/issues/241)) ([be49a91](https://github.com/sidorares/react-x11-components/commit/be49a91cab1f75c9d06022bc749bc2d61804d14a))
* **html:** ntk 8.14.2 shapes a word across elements, and apart at an inline box's edge ([#321](https://github.com/sidorares/react-x11-components/issues/321)) ([851f79f](https://github.com/sidorares/react-x11-components/commit/851f79f0923b26e8fc1ad2b0e04b1e888ddc4165))
* **html:** object-fit and object-position, a video's poster and an embed's image ([#333](https://github.com/sidorares/react-x11-components/issues/333)) ([8802719](https://github.com/sidorares/react-x11-components/commit/8802719c217da0f6207ca28609d69c3b9761e62e))
* **html:** relative inline boxes move their text, and hidden inline text is hidden — CSS 2.1 round 23 ([#181](https://github.com/sidorares/react-x11-components/issues/181)) ([112013a](https://github.com/sidorares/react-x11-components/commit/112013a1363f08aa431fee149ba4b9818176b1bf))
* **html:** table cells on the baseline, table rows that paint like a browser's, and three parser fixes, CSS 2.1 round 9 ([#161](https://github.com/sidorares/react-x11-components/issues/161)) ([60abdf6](https://github.com/sidorares/react-x11-components/commit/60abdf6191057063fd189eebd4a54701c29dcc16))
* **html:** table columns that set their widths and draw their images, CSS 2.1 round 14 ([#166](https://github.com/sidorares/react-x11-components/issues/166)) ([f8afd23](https://github.com/sidorares/react-x11-components/commit/f8afd23c6f1026bf16d00863c32ff77ddbd8d8b4))
* **html:** text-align-last, family names with their spacing, and line heights below nought ([#314](https://github.com/sidorares/react-x11-components/issues/314)) ([9eeda4d](https://github.com/sidorares/react-x11-components/commit/9eeda4d45d41fa29055cd5808a3c4c218de3b724))
* **html:** the generic monospace takes the smaller size, as in a browser ([#265](https://github.com/sidorares/react-x11-components/issues/265)) ([06df657](https://github.com/sidorares/react-x11-components/commit/06df657d505604e86b6156aba69df1c0a9dada31))
* **html:** the grid track sizing algorithm, and a grid's content alignment ([#330](https://github.com/sidorares/react-x11-components/issues/330)) ([31e489a](https://github.com/sidorares/react-x11-components/commit/31e489afc5912d2f159da8dc38efd3d69f433d0a))
* **html:** the line break after a pre start tag, and pseudo-class arguments ([#190](https://github.com/sidorares/react-x11-components/issues/190)) ([f27e047](https://github.com/sidorares/react-x11-components/commit/f27e0476b1660efda4b655e9b84ed8862e753b8c))
* **html:** the stretch sizing keyword and -webkit-fill-available ([#340](https://github.com/sidorares/react-x11-components/issues/340)) ([6caa4a0](https://github.com/sidorares/react-x11-components/commit/6caa4a04f4a3a0f0a5d7e08fb6575e70284a6b55))
* **html:** url() and font-family read as CSS says, and tables that clip, CSS 2.1 round 16 ([#172](https://github.com/sidorares/react-x11-components/issues/172)) ([87bc485](https://github.com/sidorares/react-x11-components/commit/87bc48510719af2753e51790ed34e6f60291ceb0))
* **html:** vertical-align raises and lowers text, &lt;sub&gt; and &lt;sup&gt; among it ([#182](https://github.com/sidorares/react-x11-components/issues/182)) ([0c1a5f9](https://github.com/sidorares/react-x11-components/commit/0c1a5f941b1ebcadd79a7fb5cc80f1cdffd33332))
* **html:** visibility: collapse takes a table's row or column out ([#261](https://github.com/sidorares/react-x11-components/issues/261)) ([a683804](https://github.com/sidorares/react-x11-components/commit/a6838042827f0db784fdbba5f6ca83ac8478af3c))
* **html:** what is in the head shows where CSS says, and negative inline margins take room back — CSS 2.1 round 25 ([#183](https://github.com/sidorares/react-x11-components/issues/183)) ([03c2cf0](https://github.com/sidorares/react-x11-components/commit/03c2cf0d314ba387f430e3795ab2fb3c3a49b231))
* **html:** white space beside a table's anonymous cell stays in it ([#266](https://github.com/sidorares/react-x11-components/issues/266)) ([e46df64](https://github.com/sidorares/react-x11-components/commit/e46df648d50ead3da749a625d074c4c37f3e1620))
* **html:** white-space on an element, not only on its block ([#186](https://github.com/sidorares/react-x11-components/issues/186)) ([a757f54](https://github.com/sidorares/react-x11-components/commit/a757f54bdf2bc886096c9d03781186615fbe917a))
* **html:** XHTML style sheets read as XML, and what that showed ([#275](https://github.com/sidorares/react-x11-components/issues/275)) ([9ebdce5](https://github.com/sidorares/react-x11-components/commit/9ebdce5a31a687817cab79395e45947847316a05))
* **maps:** a label batch sets its first string however late it starts ([#250](https://github.com/sidorares/react-x11-components/issues/250)) ([48be68c](https://github.com/sidorares/react-x11-components/commit/48be68c9f71cf0e39a80f0f0a9e857009879288b))
* **maps:** cover a zoom-out's holes from the finer tiles in hand, a quarter at a time and up to four levels down — the view went blank at its edges and on a quick zoom out ([#115](https://github.com/sidorares/react-x11-components/issues/115)) ([3e6c006](https://github.com/sidorares/react-x11-components/commit/3e6c0067042f5adbc0e8b53b51e6b4abde4bfb00))
* **maps:** draw the sea over parks in the OpenMapTiles style — a marine reserve painted the water green ([#116](https://github.com/sidorares/react-x11-components/issues/116)) ([de06c3a](https://github.com/sidorares/react-x11-components/commit/de06c3a65508bee7fb56407a9c282a8af40ef31a))
* **maps:** fade a layer the camera zooms out of — a scene's layers are its own, not the camera's ([#125](https://github.com/sidorares/react-x11-components/issues/125)) ([f6e5027](https://github.com/sidorares/react-x11-components/commit/f6e502753a960562b90107fc44c4eafdac86f3d7))
* **markdown:** a tab in running text is set as a space ([#216](https://github.com/sidorares/react-x11-components/issues/216)) ([82a33fd](https://github.com/sidorares/react-x11-components/commit/82a33fdaab144a8c2ceb5e8bc81ee1ca084355b1))
* **qml:** logical pixels at every display scale ([#171](https://github.com/sidorares/react-x11-components/issues/171)) ([fb8b2ae](https://github.com/sidorares/react-x11-components/commit/fb8b2aee20a0c08f0a8ed50c12099c3ac17524cf))
* **qml:** MouseArea's wheel in Qt's units and directions ([#167](https://github.com/sidorares/react-x11-components/issues/167)) ([92d133b](https://github.com/sidorares/react-x11-components/commit/92d133b699fb34c071d43f9a5cae71ca55422489))
* **reorder,maps:** a drop position is a slot; a camera moved during a frame still schedules the next ([#124](https://github.com/sidorares/react-x11-components/issues/124)) ([3a69e34](https://github.com/sidorares/react-x11-components/commit/3a69e3400b6b83e136e2e2e5c1e60c56a70c29b3))
* **richtext:** a tab goes to its stop, every eight spaces ([#252](https://github.com/sidorares/react-x11-components/issues/252)) ([b81714f](https://github.com/sidorares/react-x11-components/commit/b81714f0308f405d3b2bfd0d81fdc86fa20425f1))
* **richtext:** react-x11 ^2.22.8, so macOS draws the decorations it lays out ([#147](https://github.com/sidorares/react-x11-components/issues/147)) ([0e370cd](https://github.com/sidorares/react-x11-components/commit/0e370cddf82f8e86cc81f78c2b7fd4caf4490ac2))
* **richtext:** say how far a code chip draws past the box ([#346](https://github.com/sidorares/react-x11-components/issues/346)) ([d12a765](https://github.com/sidorares/react-x11-components/commit/d12a76532a90205eed33dee7d9631fec90c6fd18))
* **table, tree:** a long flick keeps the virtual window to its budget ([#130](https://github.com/sidorares/react-x11-components/issues/130)) ([d99d355](https://github.com/sidorares/react-x11-components/commit/d99d35585473f4eb6dbf0e190127e50d62da95bf))
* **terminal:** react-x11 ^2.15.0 — the vt grid's Wayland gaps are closed in core, so it draws there ([#119](https://github.com/sidorares/react-x11-components/issues/119)) ([3b82678](https://github.com/sidorares/react-x11-components/commit/3b82678a2fdc715f83eaf2da4b1e18f402ca3c13))
* **three:** put a hovered object's cursor on the window on Cocoa, through the &lt;glarea&gt;'s style — the surface there is a layer with no cursor of its own ([#114](https://github.com/sidorares/react-x11-components/issues/114)) ([04a34b8](https://github.com/sidorares/react-x11-components/commit/04a34b8e9292f172ff955c5d8cb8df2ed3319786))
* **three:** take the pointer from the &lt;glarea&gt;'s own handlers where core forwards it — listening on the surface's window took presses and the wheel from the tree ([#111](https://github.com/sidorares/react-x11-components/issues/111)) ([4d2da84](https://github.com/sidorares/react-x11-components/commit/4d2da840a560ff1d3c563ff29e1d3d3b01f57129))


### Performance Improvements

* **code-editor:** a keystroke repaints its rows, and revealing the caret is a blit ([#137](https://github.com/sidorares/react-x11-components/issues/137)) ([7a0eff5](https://github.com/sidorares/react-x11-components/commit/7a0eff5c99a258b7cfa3cbe194aa1a0a63714f75))
* **code-editor:** a long line's pieces are laid out when something asks ([#268](https://github.com/sidorares/react-x11-components/issues/268)) ([f34e06f](https://github.com/sidorares/react-x11-components/commit/f34e06f261d30160cd6caa1b5688aa9677fcc049))
* **code-editor:** an edit costs the lines it changes — typing, undo, replace ([#133](https://github.com/sidorares/react-x11-components/issues/133)) ([a9bd9fc](https://github.com/sidorares/react-x11-components/commit/a9bd9fc198f79f50b55a5c75e63a4277d22f8228))
* **code-editor:** an edit to a long line keeps the pieces before it ([#249](https://github.com/sidorares/react-x11-components/issues/249)) ([a3b5ca1](https://github.com/sidorares/react-x11-components/commit/a3b5ca1e90f0cda937dd1edf9b1864ee68f81d8c))
* **code-editor:** long lines in pieces, and a scroll that copies what it keeps ([#131](https://github.com/sidorares/react-x11-components/issues/131)) ([40f31d7](https://github.com/sidorares/react-x11-components/commit/40f31d7f46e229bd7f1e0ca26be276e0847a5f1d))
* **code-language:** a line far past the frontier is answered from a guess ([#138](https://github.com/sidorares/react-x11-components/issues/138)) ([9319bd4](https://github.com/sidorares/react-x11-components/commit/9319bd450670f87bba9cd5a1115125c77199828d))
* **code:** warm the mono family while a code component renders ([#292](https://github.com/sidorares/react-x11-components/issues/292)) ([40caa59](https://github.com/sidorares/react-x11-components/commit/40caa5949c97363b4e636681b60a8e511d104e3c))
* **flow:** a drag repaints its node's places in the minimap, not all of it ([#367](https://github.com/sidorares/react-x11-components/issues/367)) ([37c5515](https://github.com/sidorares/react-x11-components/commit/37c551550c49f0077430721fca9f52afdf118669))
* **flow:** a label's place on its route is kept with the route ([#290](https://github.com/sidorares/react-x11-components/issues/290)) ([f866a73](https://github.com/sidorares/react-x11-components/commit/f866a73c636dc68e6be1e5e9cd7532c14c26e31c))
* **flow:** a pass leaves behind the routes it cannot reach ([#287](https://github.com/sidorares/react-x11-components/issues/287)) ([4a76016](https://github.com/sidorares/react-x11-components/commit/4a76016bc04c529f4bdac8b252ffae78141019eb))
* **flow:** the palette is resolved once per theme and palette prop ([#288](https://github.com/sidorares/react-x11-components/issues/288)) ([fadb1a7](https://github.com/sidorares/react-x11-components/commit/fadb1a700c2921f677c87d3f9d2cece7a32ab72f))
* **html:** a flex item says only what Yoga does not already know ([#203](https://github.com/sidorares/react-x11-components/issues/203)) ([20272a2](https://github.com/sidorares/react-x11-components/commit/20272a203141e5348e35eb709774c1013849abc1))
* **html:** a framework's stylesheet, read once and shared ([#202](https://github.com/sidorares/react-x11-components/issues/202)) ([565e060](https://github.com/sidorares/react-x11-components/commit/565e0605738567ac3c52c7d925f2d75159a3f95e))
* **html:** a kept layout is found by comparing, and a line height is kept ([#142](https://github.com/sidorares/react-x11-components/issues/142)) ([da551e9](https://github.com/sidorares/react-x11-components/commit/da551e92e6026d59fd10d2ca432f7baf0b35d089))
* **html:** a pseudo-element index is asked only of an element it can reach ([51a5de7](https://github.com/sidorares/react-x11-components/commit/51a5de7032d6025d706c8174a4c6111c7d9185fb))
* **html:** a resize lays the document out once a frame ([#140](https://github.com/sidorares/react-x11-components/issues/140)) ([4509289](https://github.com/sidorares/react-x11-components/commit/4509289c2e129828e8a0d610503d2821a862d12f))
* **html:** a style is computed once per kind of element ([#141](https://github.com/sidorares/react-x11-components/issues/141)) ([23ede16](https://github.com/sidorares/react-x11-components/commit/23ede16faea013f6fd63522ab1a4094f84263c08))
* **html:** a style is copied by a constructor, not a spread ([#232](https://github.com/sidorares/react-x11-components/issues/232)) ([efb89b5](https://github.com/sidorares/react-x11-components/commit/efb89b576b86bbc147272585e34d5dd224de0019))
* **html:** a table cell's min-content from its words ([#228](https://github.com/sidorares/react-x11-components/issues/228)) ([4830d9b](https://github.com/sidorares/react-x11-components/commit/4830d9bad973ea871e23709bdab45eaf2138ff4c))
* **html:** an edit lays out again only the text it changed ([#135](https://github.com/sidorares/react-x11-components/issues/135)) ([2587ac6](https://github.com/sidorares/react-x11-components/commit/2587ac69c6bd2a5689a9b0378da3af44da800415))
* **html:** bound a shrink-to-fit box's floor before measuring it ([#226](https://github.com/sidorares/react-x11-components/issues/226)) ([3935e9c](https://github.com/sidorares/react-x11-components/commit/3935e9ca9d4233b1318cebbf963a2f1da56da748))
* **html:** find a kept text layout by a number, and a run by its fields ([#191](https://github.com/sidorares/react-x11-components/issues/191)) ([30745e8](https://github.com/sidorares/react-x11-components/commit/30745e8ea13e33049bb685a9468a21365492c9c2))
* **html:** one walk for tabs and shadows, and no text searched for a tab it cannot hold ([#215](https://github.com/sidorares/react-x11-components/issues/215)) ([2d3a00d](https://github.com/sidorares/react-x11-components/commit/2d3a00dbc699ce48f0c09c80f5cf539e11c923c7))
* **html:** paint and hit tests go through what is in view — perf sweep round 14 ([#180](https://github.com/sidorares/react-x11-components/issues/180)) ([07723d4](https://github.com/sidorares/react-x11-components/commit/07723d4f077e4a4d174e0cc50fa4f4e38f07012d))
* **html:** warm a document's faces as soon as its boxes say which ([#319](https://github.com/sidorares/react-x11-components/issues/319)) ([0409040](https://github.com/sidorares/react-x11-components/commit/0409040dfdea81a63950798323461c0d5a70daf4))
* **html:** warm the mono family while a document with code renders ([#300](https://github.com/sidorares/react-x11-components/issues/300)) ([a484b5c](https://github.com/sidorares/react-x11-components/commit/a484b5c4f5c6ebe8967d89d9139a9648a83539d5))
* **html:** what counter styles and a run's shape cost a long document ([#350](https://github.com/sidorares/react-x11-components/issues/350)) ([73f366d](https://github.com/sidorares/react-x11-components/commit/73f366d530bef3702515cb6dd78ef9d4d6b02138))
* **markdown:** a block keeps its key when blocks before it come or go ([#263](https://github.com/sidorares/react-x11-components/issues/263)) ([325d853](https://github.com/sidorares/react-x11-components/commit/325d8533bb97951991ce084a67cfcf3dcbed29e7))
* **markdown:** a list item, its marker and a table cell lay out without a box around them ([#143](https://github.com/sidorares/react-x11-components/issues/143)) ([901f37d](https://github.com/sidorares/react-x11-components/commit/901f37d786dfc299338ce3e51f37b94db0e68638))
* **markdown:** an edit is parsed as an edit of the source before it ([#262](https://github.com/sidorares/react-x11-components/issues/262)) ([a1fe1db](https://github.com/sidorares/react-x11-components/commit/a1fe1db70dd00393df10a7db48af5df55a54950b))
* **rich-text-editor:** a keystroke costs the block it lands in ([#134](https://github.com/sidorares/react-x11-components/issues/134)) ([6caf687](https://github.com/sidorares/react-x11-components/commit/6caf68745afa80c9410e297cfaf40d8ab85b0c0e))
* **rich-text-editor:** a mark added across blocks is one step ([#281](https://github.com/sidorares/react-x11-components/issues/281)) ([9caecd1](https://github.com/sidorares/react-x11-components/commit/9caecd1756afe18ef61c776b47f0fbb2826e9b06))
* **rich-text-editor:** a mark over the document keeps its blocks' keys without mapping them ([#136](https://github.com/sidorares/react-x11-components/issues/136)) ([e10b20d](https://github.com/sidorares/react-x11-components/commit/e10b20da39661e910519d603503fce6375d4731c))
* **rich-text-editor:** warm the mono family when it mounts with code ([#293](https://github.com/sidorares/react-x11-components/issues/293)) ([0709acc](https://github.com/sidorares/react-x11-components/commit/0709acc011bb00c0e4a57990640f033773484cd3))
* the table's sort and the editor's completions share one collator ([#305](https://github.com/sidorares/react-x11-components/issues/305)) ([05a34c9](https://github.com/sidorares/react-x11-components/commit/05a34c9ee8635e1289c9aeb2cdaa49740fbf920c))

## [0.9.0](https://github.com/sidorares/react-x11-components/compare/v0.8.0...v0.9.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* **maps:** <Map> draws through GL by default where the connection has direct GL — on the Cocoa backend, always. A GL surface is invisible to window capture, labels are placed in screen space and fade, and line caps and joins are round. renderer="retained", or REACT_X11_MAP_RENDERER=retained in the environment, keeps the previous behaviour.
* **maps:** `TileCache`'s `key`, `peek`, `ancestorWithSurface` and `descendantsWithSurface` take the `MapSource` rather than its id. And a source object made anew on every render now starts from an empty cache on every render — a stable id no longer papers over it — so create sources once, at module scope or in `useMemo`.

### Features

* **maps:** &lt;Map renderer="auto"&gt; — the GL renderer behind &lt;Map&gt;, with the retained one as its fallback ([#104](https://github.com/sidorares/react-x11-components/issues/104)) ([7449384](https://github.com/sidorares/react-x11-components/commit/74493849f4bb9db0f141c335f376cb907e24dab8))
* **maps:** a GL renderer proof of concept — every frame drawn from vector tiles at display rate, with labels ([#100](https://github.com/sidorares/react-x11-components/issues/100)) ([715da60](https://github.com/sidorares/react-x11-components/commit/715da6053473263b9f3da76f3df20326e0d8cd4d))
* **rich-text-editor:** a WYSIWYG editor — ProseMirror's model, drawn by react-x11, markdown in and out ([#99](https://github.com/sidorares/react-x11-components/issues/99)) ([156e40d](https://github.com/sidorares/react-x11-components/commit/156e40d35394d30abc12b1d37e119295a058edb2))
* **rich-text-editor:** suggestions — @ mentions and a / block menu, a list kept by a plugin and drawn at the trigger ([#102](https://github.com/sidorares/react-x11-components/issues/102)) ([89276ca](https://github.com/sidorares/react-x11-components/commit/89276ca38499e6899ada108d9f9f8cf1d98c270d))
* **rich-text-editor:** table editing, drag and drop, long documents, verified collaboration, and suggestion rows of the app's own ([#103](https://github.com/sidorares/react-x11-components/issues/103)) ([0a48966](https://github.com/sidorares/react-x11-components/commit/0a489666778589cb4f1b07973b6e36bf4ef10987))


### Bug Fixes

* **charts:** &lt;Chart&gt; threw in paint on react-x11 2.12+ — core's _host field shadowed the plot node's method ([#106](https://github.com/sidorares/react-x11-components/issues/106)) ([4f75af4](https://github.com/sidorares/react-x11-components/commit/4f75af4aac70004bc8efb7373f464900920958fa))
* **maps:** a style change leaves raster tiles alone ([#94](https://github.com/sidorares/react-x11-components/issues/94)) ([71b07b3](https://github.com/sidorares/react-x11-components/commit/71b07b3676dd9b463290fdab2e1da7a743ea76d1))
* **maps:** abort the loads the map stops wanting — a tile panned away loaded to the end ([#91](https://github.com/sidorares/react-x11-components/issues/91)) ([a160488](https://github.com/sidorares/react-x11-components/commit/a160488ea74390eb405dc8d9943c83b31f39cb8d))
* **maps:** add the pane's origin to a tile once — markers drifted off their place as the map zoomed ([#95](https://github.com/sidorares/react-x11-components/issues/95)) ([944508a](https://github.com/sidorares/react-x11-components/commit/944508a728b2129e15e2d722270c3c463da6396b))
* **maps:** cache tiles per source object — switching provider showed a patchwork of both ([#89](https://github.com/sidorares/react-x11-components/issues/89)) ([f5174da](https://github.com/sidorares/react-x11-components/commit/f5174da79eefbbb767aa856e478ac54f4381305b))
* **maps:** draw a raster tile once, whole, past its source's depth — the view was a grid of miniatures ([#98](https://github.com/sidorares/react-x11-components/issues/98)) ([364396d](https://github.com/sidorares/react-x11-components/commit/364396d3f50154b9ad58013d5baaa70da6246430))
* **maps:** ease a wheel notch over the frames after it, and keep a touchpad's fractions — the zoom was a staircase ([#105](https://github.com/sidorares/react-x11-components/issues/105)) ([9769d2a](https://github.com/sidorares/react-x11-components/commit/9769d2afcc571e1dcc651466067f2866b638f7a7))
* **maps:** swap a style change in whole, not tile by tile ([#92](https://github.com/sidorares/react-x11-components/issues/92)) ([2bf2bd3](https://github.com/sidorares/react-x11-components/commit/2bf2bd36aff4fe30ab3a66fb884a128e39a7a190))
* **maps:** warn when a source is remade every render — each render refetched the whole view ([#93](https://github.com/sidorares/react-x11-components/issues/93)) ([d3beeb8](https://github.com/sidorares/react-x11-components/commit/d3beeb8de43345f5b2e8b740b3ea3ff9e451658d))
* **terminal:** 'auto' asks the app before PATH — on Cocoa it spawned xterm -into undefined ([#96](https://github.com/sidorares/react-x11-components/issues/96)) ([c7705de](https://github.com/sidorares/react-x11-components/commit/c7705debec229c1cd82c80e26b0d12b568d588d4))

## [0.8.0](https://github.com/sidorares/react-x11-components/compare/v0.7.1...v0.8.0) (2026-09-10)


### Features

* **examples:** a frameRate menu on the vt terminal, and the docs for the window's policy ([#80](https://github.com/sidorares/react-x11-components/issues/80)) ([d7f2a17](https://github.com/sidorares/react-x11-components/commit/d7f2a1712612de5ba447f083d153b273cb065152))
* **terminal:** re-land the react-x11 2.9.0 adoption — opaque grid, copy composite, one emulator subscription ([#82](https://github.com/sidorares/react-x11-components/issues/82)) ([b941af7](https://github.com/sidorares/react-x11-components/commit/b941af7cca95793b738d4e4efb4c98c9ab8c904d))


### Bug Fixes

* **color-picker:** measure the pointer against the logical box ([#85](https://github.com/sidorares/react-x11-components/issues/85)) ([0ef7633](https://github.com/sidorares/react-x11-components/commit/0ef763306ace516511dfcbc8d2846063bec1ced3))
* **color-picker:** the handle sits on the strip border, not under it ([#86](https://github.com/sidorares/react-x11-components/issues/86)) ([eb0e939](https://github.com/sidorares/react-x11-components/commit/eb0e939c3fea685d3133c813e3a60670bd39e051))
* **table, tree:** virtualization mixed device and logical pixels — blank viewport at scale 2 ([#83](https://github.com/sidorares/react-x11-components/issues/83)) ([63726df](https://github.com/sidorares/react-x11-components/commit/63726df20cdfe3e1793082feb3c84595b986bfe5))

## [0.7.1](https://github.com/sidorares/react-x11-components/compare/v0.7.0...v0.7.1) (2026-09-09)


### Bug Fixes

* **html:** a completed source that grows re-parses instead of extending an ended parse ([#78](https://github.com/sidorares/react-x11-components/issues/78)) ([8245063](https://github.com/sidorares/react-x11-components/commit/824506332a1e3aaef0d421fb242eb83b2949cac9)), closes [#77](https://github.com/sidorares/react-x11-components/issues/77)

## [0.7.0](https://github.com/sidorares/react-x11-components/compare/v0.6.0...v0.7.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* **table:** every existing `<Table>` changes shape — the grid is inset four pixels at each edge and rows are rounded rather than full-bleed, so flex columns resolve eight pixels narrower. `rowInset={0}` puts the old grid back.
* **tree:** every existing `<Tree>` changes shape — rows are inset and rounded rather than full-bleed. `styles={{ row: { marginStart: 0, marginEnd: 0, borderRadius: 0 } }}` puts the old band back.
* **desktop-calendar:** `@react-x11/components/desktop-calendar` is gone, and the barrel no longer exports `useDesktopCalendarEvents`, `DesktopCalendar`, `byDay`, `parseKeyFile`, `IcalUnavailableError` or their types. Import them from `react-x11` instead, which needs >= 2.9.1. The result shape is the same one, plus `backend` and `openSettings`, and `status` gained `'denied'` — the user's refusal, which has a Settings switch behind it, as against `'unavailable'`, which does not.

### Features

* **desktop-calendar:** the calendar moved to core — delete this side, floor at ^2.9.1 ([#71](https://github.com/sidorares/react-x11-components/issues/71)) ([ade315a](https://github.com/sidorares/react-x11-components/commit/ade315afba75d3892b8c6ce33b43329f539d3a7f))
* **table:** the row highlight is a pill on the list, not a band across it ([#76](https://github.com/sidorares/react-x11-components/issues/76)) ([fa9923b](https://github.com/sidorares/react-x11-components/commit/fa9923b586ccbf2616c343db76227e7f8243930a))
* **tree:** the row highlight is a pill on the list, not a band across it ([#75](https://github.com/sidorares/react-x11-components/issues/75)) ([011b98e](https://github.com/sidorares/react-x11-components/commit/011b98ed52c6bf9853f5123f283692a87d45a46c))

## [0.6.0](https://github.com/sidorares/react-x11-components/compare/v0.5.0...v0.6.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* **markdown:** MDX — components and expressions in the prose ([#72](https://github.com/sidorares/react-x11-components/issues/72))

### Features

* **markdown:** MDX — components and expressions in the prose ([#72](https://github.com/sidorares/react-x11-components/issues/72)) ([29be2fb](https://github.com/sidorares/react-x11-components/commit/29be2fb5fa2857d2b26ee88a231c7f188aad26b9))

## [0.5.0](https://github.com/sidorares/react-x11-components/compare/v0.4.0...v0.5.0) (2026-09-07)


### Features

* **flow:** a mounted node body zooms with the pane ([5f4ce96](https://github.com/sidorares/react-x11-components/commit/5f4ce961371f6207b1939dd73f2765ee877ee08d))
* **flow:** a mounted node body zooms with the pane ([337a0de](https://github.com/sidorares/react-x11-components/commit/337a0de4408ae74a2a1c88bf86a991ecdc87152f))
* **html:** answer [@media](https://github.com/media) (prefers-color-scheme) from the palette in force ([67373f1](https://github.com/sidorares/react-x11-components/commit/67373f1931775dbebf13c59894b361611339482e))
* **maps:** a 2D vector-tile map ([#64](https://github.com/sidorares/react-x11-components/issues/64)) ([5c21b4d](https://github.com/sidorares/react-x11-components/commit/5c21b4dd98cc44ce7c164835dd0f18d737d01856))
* **reorder:** a drag-and-drop list over core's drag and drop ([#67](https://github.com/sidorares/react-x11-components/issues/67)) ([a8000f0](https://github.com/sidorares/react-x11-components/commit/a8000f0727302a20806f53831c03247fd88a437d))
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
