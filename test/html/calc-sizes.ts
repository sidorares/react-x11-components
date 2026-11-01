// `calc-size()` as Chromium 156 reads it, and the sizes it makes of boxes,
// over this document, none of them written by hand:
// `scripts/conformance/calc-sizes.ts` writes this file. Nothing in a box is
// text, which a platform's fonts would have another width for.

export const CALC_SIZE_DOCUMENT = `<style>html,body{font-size:16px}body{margin:0}.set{width:400px;height:300px;position:relative}.unset{width:400px}.c{width:30px;height:20px}.w{display:inline-block;width:30px;height:20px;vertical-align:top}</style><span id="r0" style="width:calc-size(fit-content, size + 10px)"></span>
<span id="r1" style="height:calc-size(fit-content, size + 10px)"></span>
<span id="r2" style="min-width:calc-size(fit-content, size + 10px)"></span>
<span id="r3" style="min-height:calc-size(fit-content, size + 10px)"></span>
<span id="r4" style="max-width:calc-size(fit-content, size + 10px)"></span>
<span id="r5" style="max-height:calc-size(fit-content, size + 10px)"></span>
<span id="r6" style="flex-basis:calc-size(fit-content, size + 10px)"></span>
<span id="r7" style="width:calc-size(auto, size * 2)"></span>
<span id="r8" style="height:calc-size(auto, size * 2)"></span>
<span id="r9" style="min-width:calc-size(auto, size * 2)"></span>
<span id="r10" style="min-height:calc-size(auto, size * 2)"></span>
<span id="r11" style="max-width:calc-size(auto, size * 2)"></span>
<span id="r12" style="max-height:calc-size(auto, size * 2)"></span>
<span id="r13" style="flex-basis:calc-size(auto, size * 2)"></span>
<span id="r14" style="width:calc-size(min-content, size)"></span>
<span id="r15" style="height:calc-size(min-content, size)"></span>
<span id="r16" style="min-width:calc-size(min-content, size)"></span>
<span id="r17" style="min-height:calc-size(min-content, size)"></span>
<span id="r18" style="max-width:calc-size(min-content, size)"></span>
<span id="r19" style="max-height:calc-size(min-content, size)"></span>
<span id="r20" style="flex-basis:calc-size(min-content, size)"></span>
<span id="r21" style="width:calc-size(max-content, size)"></span>
<span id="r22" style="height:calc-size(max-content, size)"></span>
<span id="r23" style="min-width:calc-size(max-content, size)"></span>
<span id="r24" style="min-height:calc-size(max-content, size)"></span>
<span id="r25" style="max-width:calc-size(max-content, size)"></span>
<span id="r26" style="max-height:calc-size(max-content, size)"></span>
<span id="r27" style="flex-basis:calc-size(max-content, size)"></span>
<span id="r28" style="width:calc-size(stretch, size)"></span>
<span id="r29" style="height:calc-size(stretch, size)"></span>
<span id="r30" style="min-width:calc-size(stretch, size)"></span>
<span id="r31" style="min-height:calc-size(stretch, size)"></span>
<span id="r32" style="max-width:calc-size(stretch, size)"></span>
<span id="r33" style="max-height:calc-size(stretch, size)"></span>
<span id="r34" style="flex-basis:calc-size(stretch, size)"></span>
<span id="r35" style="width:calc-size(-webkit-fill-available, size)"></span>
<span id="r36" style="height:calc-size(-webkit-fill-available, size)"></span>
<span id="r37" style="min-width:calc-size(-webkit-fill-available, size)"></span>
<span id="r38" style="min-height:calc-size(-webkit-fill-available, size)"></span>
<span id="r39" style="max-width:calc-size(-webkit-fill-available, size)"></span>
<span id="r40" style="max-height:calc-size(-webkit-fill-available, size)"></span>
<span id="r41" style="flex-basis:calc-size(-webkit-fill-available, size)"></span>
<span id="r42" style="width:calc-size(-webkit-fit-content, size)"></span>
<span id="r43" style="height:calc-size(-webkit-fit-content, size)"></span>
<span id="r44" style="min-width:calc-size(-webkit-fit-content, size)"></span>
<span id="r45" style="min-height:calc-size(-webkit-fit-content, size)"></span>
<span id="r46" style="max-width:calc-size(-webkit-fit-content, size)"></span>
<span id="r47" style="max-height:calc-size(-webkit-fit-content, size)"></span>
<span id="r48" style="flex-basis:calc-size(-webkit-fit-content, size)"></span>
<span id="r49" style="width:calc-size(-webkit-min-content, size)"></span>
<span id="r50" style="height:calc-size(-webkit-min-content, size)"></span>
<span id="r51" style="min-width:calc-size(-webkit-min-content, size)"></span>
<span id="r52" style="min-height:calc-size(-webkit-min-content, size)"></span>
<span id="r53" style="max-width:calc-size(-webkit-min-content, size)"></span>
<span id="r54" style="max-height:calc-size(-webkit-min-content, size)"></span>
<span id="r55" style="flex-basis:calc-size(-webkit-min-content, size)"></span>
<span id="r56" style="width:calc-size(-webkit-max-content, size)"></span>
<span id="r57" style="height:calc-size(-webkit-max-content, size)"></span>
<span id="r58" style="min-width:calc-size(-webkit-max-content, size)"></span>
<span id="r59" style="min-height:calc-size(-webkit-max-content, size)"></span>
<span id="r60" style="max-width:calc-size(-webkit-max-content, size)"></span>
<span id="r61" style="max-height:calc-size(-webkit-max-content, size)"></span>
<span id="r62" style="flex-basis:calc-size(-webkit-max-content, size)"></span>
<span id="r63" style="width:calc-size(-moz-available, size)"></span>
<span id="r64" style="height:calc-size(-moz-available, size)"></span>
<span id="r65" style="min-width:calc-size(-moz-available, size)"></span>
<span id="r66" style="min-height:calc-size(-moz-available, size)"></span>
<span id="r67" style="max-width:calc-size(-moz-available, size)"></span>
<span id="r68" style="max-height:calc-size(-moz-available, size)"></span>
<span id="r69" style="flex-basis:calc-size(-moz-available, size)"></span>
<span id="r70" style="width:calc-size(fit-content(20px), size)"></span>
<span id="r71" style="height:calc-size(fit-content(20px), size)"></span>
<span id="r72" style="min-width:calc-size(fit-content(20px), size)"></span>
<span id="r73" style="min-height:calc-size(fit-content(20px), size)"></span>
<span id="r74" style="max-width:calc-size(fit-content(20px), size)"></span>
<span id="r75" style="max-height:calc-size(fit-content(20px), size)"></span>
<span id="r76" style="flex-basis:calc-size(fit-content(20px), size)"></span>
<span id="r77" style="width:calc-size(none, size)"></span>
<span id="r78" style="height:calc-size(none, size)"></span>
<span id="r79" style="min-width:calc-size(none, size)"></span>
<span id="r80" style="min-height:calc-size(none, size)"></span>
<span id="r81" style="max-width:calc-size(none, size)"></span>
<span id="r82" style="max-height:calc-size(none, size)"></span>
<span id="r83" style="flex-basis:calc-size(none, size)"></span>
<span id="r84" style="width:calc-size(content, size)"></span>
<span id="r85" style="height:calc-size(content, size)"></span>
<span id="r86" style="min-width:calc-size(content, size)"></span>
<span id="r87" style="min-height:calc-size(content, size)"></span>
<span id="r88" style="max-width:calc-size(content, size)"></span>
<span id="r89" style="max-height:calc-size(content, size)"></span>
<span id="r90" style="flex-basis:calc-size(content, size)"></span>
<span id="r91" style="width:calc-size(any, 10px)"></span>
<span id="r92" style="height:calc-size(any, 10px)"></span>
<span id="r93" style="min-width:calc-size(any, 10px)"></span>
<span id="r94" style="min-height:calc-size(any, 10px)"></span>
<span id="r95" style="max-width:calc-size(any, 10px)"></span>
<span id="r96" style="max-height:calc-size(any, 10px)"></span>
<span id="r97" style="flex-basis:calc-size(any, 10px)"></span>
<span id="r98" style="width:calc-size(any, size)"></span>
<span id="r99" style="height:calc-size(any, size)"></span>
<span id="r100" style="min-width:calc-size(any, size)"></span>
<span id="r101" style="min-height:calc-size(any, size)"></span>
<span id="r102" style="max-width:calc-size(any, size)"></span>
<span id="r103" style="max-height:calc-size(any, size)"></span>
<span id="r104" style="flex-basis:calc-size(any, size)"></span>
<span id="r105" style="width:calc-size(any, 10px + 5%)"></span>
<span id="r106" style="height:calc-size(any, 10px + 5%)"></span>
<span id="r107" style="min-width:calc-size(any, 10px + 5%)"></span>
<span id="r108" style="min-height:calc-size(any, 10px + 5%)"></span>
<span id="r109" style="max-width:calc-size(any, 10px + 5%)"></span>
<span id="r110" style="max-height:calc-size(any, 10px + 5%)"></span>
<span id="r111" style="flex-basis:calc-size(any, 10px + 5%)"></span>
<span id="r112" style="width:calc-size(any, 0)"></span>
<span id="r113" style="height:calc-size(any, 0)"></span>
<span id="r114" style="min-width:calc-size(any, 0)"></span>
<span id="r115" style="min-height:calc-size(any, 0)"></span>
<span id="r116" style="max-width:calc-size(any, 0)"></span>
<span id="r117" style="max-height:calc-size(any, 0)"></span>
<span id="r118" style="flex-basis:calc-size(any, 0)"></span>
<span id="r119" style="width:calc-size(auto)"></span>
<span id="r120" style="height:calc-size(auto)"></span>
<span id="r121" style="min-width:calc-size(auto)"></span>
<span id="r122" style="min-height:calc-size(auto)"></span>
<span id="r123" style="max-width:calc-size(auto)"></span>
<span id="r124" style="max-height:calc-size(auto)"></span>
<span id="r125" style="flex-basis:calc-size(auto)"></span>
<span id="r126" style="width:calc-size(fit-content)"></span>
<span id="r127" style="height:calc-size(fit-content)"></span>
<span id="r128" style="min-width:calc-size(fit-content)"></span>
<span id="r129" style="min-height:calc-size(fit-content)"></span>
<span id="r130" style="max-width:calc-size(fit-content)"></span>
<span id="r131" style="max-height:calc-size(fit-content)"></span>
<span id="r132" style="flex-basis:calc-size(fit-content)"></span>
<span id="r133" style="width:calc-size(10px)"></span>
<span id="r134" style="height:calc-size(10px)"></span>
<span id="r135" style="min-width:calc-size(10px)"></span>
<span id="r136" style="min-height:calc-size(10px)"></span>
<span id="r137" style="max-width:calc-size(10px)"></span>
<span id="r138" style="max-height:calc-size(10px)"></span>
<span id="r139" style="flex-basis:calc-size(10px)"></span>
<span id="r140" style="width:calc-size(10px, size)"></span>
<span id="r141" style="height:calc-size(10px, size)"></span>
<span id="r142" style="min-width:calc-size(10px, size)"></span>
<span id="r143" style="min-height:calc-size(10px, size)"></span>
<span id="r144" style="max-width:calc-size(10px, size)"></span>
<span id="r145" style="max-height:calc-size(10px, size)"></span>
<span id="r146" style="flex-basis:calc-size(10px, size)"></span>
<span id="r147" style="width:calc-size(50%, size + 10px)"></span>
<span id="r148" style="height:calc-size(50%, size + 10px)"></span>
<span id="r149" style="min-width:calc-size(50%, size + 10px)"></span>
<span id="r150" style="min-height:calc-size(50%, size + 10px)"></span>
<span id="r151" style="max-width:calc-size(50%, size + 10px)"></span>
<span id="r152" style="max-height:calc-size(50%, size + 10px)"></span>
<span id="r153" style="flex-basis:calc-size(50%, size + 10px)"></span>
<span id="r154" style="width:calc-size(calc-size(auto, size + 1px), size * 2)"></span>
<span id="r155" style="height:calc-size(calc-size(auto, size + 1px), size * 2)"></span>
<span id="r156" style="min-width:calc-size(calc-size(auto, size + 1px), size * 2)"></span>
<span id="r157" style="min-height:calc-size(calc-size(auto, size + 1px), size * 2)"></span>
<span id="r158" style="max-width:calc-size(calc-size(auto, size + 1px), size * 2)"></span>
<span id="r159" style="max-height:calc-size(calc-size(auto, size + 1px), size * 2)"></span>
<span id="r160" style="flex-basis:calc-size(calc-size(auto, size + 1px), size * 2)"></span>
<span id="r161" style="width:calc-size(calc-size(50px, size + 1px), size * 2)"></span>
<span id="r162" style="height:calc-size(calc-size(50px, size + 1px), size * 2)"></span>
<span id="r163" style="min-width:calc-size(calc-size(50px, size + 1px), size * 2)"></span>
<span id="r164" style="min-height:calc-size(calc-size(50px, size + 1px), size * 2)"></span>
<span id="r165" style="max-width:calc-size(calc-size(50px, size + 1px), size * 2)"></span>
<span id="r166" style="max-height:calc-size(calc-size(50px, size + 1px), size * 2)"></span>
<span id="r167" style="flex-basis:calc-size(calc-size(50px, size + 1px), size * 2)"></span>
<span id="r168" style="width:calc-size(calc-size(fit-content, size), size)"></span>
<span id="r169" style="height:calc-size(calc-size(fit-content, size), size)"></span>
<span id="r170" style="min-width:calc-size(calc-size(fit-content, size), size)"></span>
<span id="r171" style="min-height:calc-size(calc-size(fit-content, size), size)"></span>
<span id="r172" style="max-width:calc-size(calc-size(fit-content, size), size)"></span>
<span id="r173" style="max-height:calc-size(calc-size(fit-content, size), size)"></span>
<span id="r174" style="flex-basis:calc-size(calc-size(fit-content, size), size)"></span>
<span id="r175" style="width:calc-size(auto, size, junk)"></span>
<span id="r176" style="height:calc-size(auto, size, junk)"></span>
<span id="r177" style="min-width:calc-size(auto, size, junk)"></span>
<span id="r178" style="min-height:calc-size(auto, size, junk)"></span>
<span id="r179" style="max-width:calc-size(auto, size, junk)"></span>
<span id="r180" style="max-height:calc-size(auto, size, junk)"></span>
<span id="r181" style="flex-basis:calc-size(auto, size, junk)"></span>
<span id="r182" style="width:calc-size(auto, size - 10px)"></span>
<span id="r183" style="width:calc-size(auto, 10px - size)"></span>
<span id="r184" style="width:calc-size(auto, -1 * size)"></span>
<span id="r185" style="width:calc-size(auto, size * -2)"></span>
<span id="r186" style="width:calc-size(auto, size / 2)"></span>
<span id="r187" style="width:calc-size(auto, size * 0.5 + 10%)"></span>
<span id="r188" style="width:calc-size(auto, 50% - size)"></span>
<span id="r189" style="width:calc-size(auto, 10px)"></span>
<span id="r190" style="width:calc-size(auto, 10%)"></span>
<span id="r191" style="width:calc-size(auto, 10px + 5%)"></span>
<span id="r192" style="width:calc-size(auto, 0px)"></span>
<span id="r193" style="width:calc-size(auto, 0)"></span>
<span id="r194" style="width:calc-size(auto, 5)"></span>
<span id="r195" style="width:calc-size(auto, size * 0)"></span>
<span id="r196" style="width:calc-size(auto, size + size)"></span>
<span id="r197" style="width:calc-size(auto, size + 1em)"></span>
<span id="r198" style="width:calc-size(auto, 1em + 2px + size)"></span>
<span id="r199" style="width:calc-size(auto, size + 10px + 5%)"></span>
<span id="r200" style="width:calc-size(auto, 5% + size + 10px)"></span>
<span id="r201" style="width:calc-size(auto, size - 10px - 5%)"></span>
<span id="r202" style="width:calc-size(auto, -10px + size * 2)"></span>
<span id="r203" style="width:calc-size(auto, size * 1.5)"></span>
<span id="r204" style="width:calc-size(auto, size * 0.1 + 0.25px)"></span>
<span id="r205" style="width:calc-size(auto, size * 1)"></span>
<span id="r206" style="width:calc-size(auto, -1 * size - 10px)"></span>
<span id="r207" style="width:calc-size(auto, (size + 10px) * 2)"></span>
<span id="r208" style="width:calc-size(auto, size * size)"></span>
<span id="r209" style="width:calc-size(auto, size / size)"></span>
<span id="r210" style="width:calc-size(auto, 2 / size)"></span>
<span id="r211" style="width:calc-size(auto, min(size, 100px))"></span>
<span id="r212" style="width:calc-size(auto, max(size, 100px))"></span>
<span id="r213" style="width:calc-size(auto, clamp(10px, size, 100px))"></span>
<span id="r214" style="width:calc-size(auto, round(size, 10px))"></span>
<span id="r215" style="width:calc-size(auto, abs(size))"></span>
<span id="r216" style="width:calc-size(auto, calc(size + 1px))"></span>
<span id="r217" style="width:calc-size(auto, sign(size) * 1px)"></span>
<span id="r218" style="width:calc-size(auto, size * sign(size))"></span>
<span id="r219" style="width:calc-size(auto, -size)"></span>
<span id="r220" style="width:calc-size(auto, 0px - size)"></span>
<span id="r221" style="width:calc-size(auto, 0px + size)"></span>
<span id="r222" style="width:calc-size(auto, size + 0px)"></span>
<span id="r223" style="width:calc-size(auto, 10px + 5px + size)"></span>
<span id="r224" style="width:calc-size(auto, size + 10px + 10px)"></span>
<span id="r225" style="width:calc-size(auto, (size + 10px) + 5px)"></span>
<span id="r226" style="width:calc-size(auto, 1em + 1em + size)"></span>
<span id="r227" style="width:calc-size(auto, 10px - 5px + size)"></span>
<span id="r228" style="width:calc-size(auto, 10px - 10px + size)"></span>
<span id="r229" style="width:calc-size(auto, 10px * 2 + size)"></span>
<span id="r230" style="width:calc-size(auto, (size - 10px) * 2)"></span>
<span id="r231" style="width:calc-size(auto, (size + 10px) / 2)"></span>
<span id="r232" style="width:calc-size(auto, -1 * (size + 10px))"></span>
<span id="r233" style="width:calc-size(auto, 2 * (size * 3))"></span>
<span id="r234" style="width:calc-size(auto, size / 2 * 2)"></span>
<span id="r235" style="width:calc-size(auto, 1 * size)"></span>
<span id="r236" style="width:calc-size(auto, 2 * 3 * size)"></span>
<span id="r237" style="width:calc-size(auto, min(100px, size))"></span>
<span id="r238" style="width:calc-size(auto, max(size))"></span>
<span id="r239" style="width:calc-size(auto, min(size, 10px, 20px))"></span>
<span id="r240" style="width:calc-size(auto, min(size * 2, 10px))"></span>
<span id="r241" style="width:calc-size(auto, min(size + 1px, 10px))"></span>
<span id="r242" style="width:calc-size(auto, min(size, 1em))"></span>
<span id="r243" style="width:calc-size(auto, min(size, calc(100px + 5%)))"></span>
<span id="r244" style="width:calc-size(auto, calc(size * 2) + 1px)"></span>
<span id="r245" style="width:calc-size(auto, min(10px, 20px) + size)"></span>
<span id="r246" style="width:calc-size(auto, 5mm + size)"></span>
<span id="r247" style="width:calc-size(auto, 1in + size)"></span>
<span id="r248" style="width:calc-size(auto, 1rem + 1em + size)"></span>
<span id="r249" style="width:calc-size(auto, size + 1.123456789px)"></span>
<span id="r250" style="width:calc-size(auto, 0.123456789 * size)"></span>
<span id="r251" style="width:calc-size(auto, 1000000 * size)"></span>
<span id="r252" style="width:calc-size(auto, 1e-7 * size)"></span>
<span id="r253" style="width:calc-size(auto, size + 10)"></span>
<span id="r254" style="width:calc-size(auto, 5 * 5)"></span>
<span id="r255" style="width:calc-size(auto, 10px * 10px)"></span>
<span id="r256" style="width:calc-size(auto, 1deg)"></span>
<span id="r257" style="width:calc-size(auto, pi * size)"></span>
<span id="r258" style="width:calc-size(auto, e * 1px + size)"></span>
<span id="r259" style="width:calc-size(auto, sin(30deg) * size)"></span>
<span id="r260" style="width:calc-size(auto, pow(2, 2) * size)"></span>
<span id="r261" style="width:calc-size(auto, sqrt(4) * size)"></span>
<span id="r262" style="width:calc-size(auto, exp(1) * size)"></span>
<span id="r263" style="width:calc-size(auto, sign(-1px) * size)"></span>
<span id="r264" style="width:calc-size(auto, mod(size, 7px))"></span>
<span id="r265" style="width:calc-size(auto, rem(size, 7px))"></span>
<span id="r266" style="width:calc-size(auto, hypot(size, 3px))"></span>
<span id="r267" style="width:calc-size(auto, round(up, size, 10px))"></span>
<span id="r268" style="width:calc-size(auto, 10px - 2 * size)"></span>
<span id="r269" style="width:calc-size(auto, 10% - 2 * size + 5px)"></span>
<span id="r270" style="width:calc-size(auto, 10px - (size + 5px))"></span>
<span id="r271" style="width:calc-size(auto, 10px - (size - 5px))"></span>
<span id="r272" style="width:calc-size(auto, 10px - min(size, 1px))"></span>
<span id="r273" style="width:calc-size(auto, min(size, 1px) - 10px)"></span>
<span id="r274" style="width:calc-size(auto, 2 * min(size, 1px))"></span>
<span id="r275" style="width:calc-size(auto, min(size, 1px) / 2)"></span>
<span id="r276" style="width:calc-size(auto, size / 2 + size / 2)"></span>
<span id="r277" style="width:calc-size(auto, -1 * size + 1px)"></span>
<span id="r278" style="width:calc-size(auto, 1 * size * sign(size))"></span>
<span id="r279" style="width:calc-size(auto, abs(size) * 2)"></span>
<span id="r280" style="width:calc-size(auto, size * (1 + 2))"></span>
<span id="r281" style="width:calc-size(auto, size * calc(1 + 2))"></span>
<span id="r282" style="width:calc-size(auto, size * 0 + 1px)"></span>
<span id="r283" style="width:calc-size(auto, -0px)"></span>
<span id="r284" style="width:calc-size(auto, size * -0)"></span>
<span id="r285" style="width:calc-size(auto, 1px * size)"></span>
<span id="r286" style="width:calc-size(auto, size * 1px)"></span>
<span id="r287" style="width:calc-size(auto, (size))"></span>
<span id="r288" style="width:calc-size(auto, ((size + 1px)))"></span>
<span id="r289" style="width:calc-size(auto, size+1px)"></span>
<span id="r290" style="width:calc-size(auto, size +1px)"></span>
<span id="r291" style="width:calc-size(auto, size*2)"></span>
<span id="r292" style="width:calc-size(auto, size/2)"></span>
<span id="r293" style="width:calc-size(auto, 1px + 1%)"></span>
<span id="r294" style="width:calc-size(auto, 1px - 1%)"></span>
<span id="r295" style="width:calc-size(auto, 10% + 20%)"></span>
<span id="r296" style="width:calc-size(auto, 10% - 10%)"></span>
<span id="r297" style="width:calc-size(auto, 2 * 10%)"></span>
<span id="r298" style="width:calc-size(auto, min(10%, 20%))"></span>
<span id="r299" style="width:calc-size(auto, min(10%, 20%) + size)"></span>
<span id="r300" style="width:calc-size(auto, calc(1px))"></span>
<span id="r301" style="width:calc-size(auto, max(size, min(size, 1px)))"></span>
<span id="r302" style="width:calc-size(auto, round(size, 1px) + 1px)"></span>
<span id="r303" style="width:calc-size(auto, round(nearest, size, 1px))"></span>
<span id="r304" style="width:calc-size(auto, round(to-zero, size, 1px))"></span>
<span id="r305" style="width:calc-size(auto, clamp(1px, 2px, 3px) + size)"></span>
<span id="r306" style="width:calc-size(auto, clamp(size, 1px, 2px))"></span>
<span id="r307" style="width:calc-size(auto, sign(size) * size)"></span>
<span id="r308" style="width:calc-size(auto, abs(-1px) + size)"></span>
<span id="r309" style="width:calc-size(auto, mod(5px, 3px) + size)"></span>
<span id="r310" style="width:calc-size(auto, hypot(3px, 4px) + size)"></span>
<span id="r311" style="width:calc-size(auto, size / 2px)"></span>
<span id="r312" style="width:calc-size(auto, (size * 2) - size)"></span>
<span id="r313" style="width:calc-size(auto, size - size)"></span>
<span id="r314" style="width:calc-size(10em, size)"></span>
<span id="r315" style="width:calc-size(calc(10px + 5%), size)"></span>
<span id="r316" style="width:calc-size(-10px, size)"></span>
<span id="r317" style="width:calc-size(50px + 10px, size)"></span>
<span id="r318" style="width:calc-size(calc(50px + 10px), size)"></span>
<span id="r319" style="width:calc-size(10px * 2, size)"></span>
<span id="r320" style="width:calc-size(min(10px, 5%), size)"></span>
<span id="r321" style="width:calc-size(min(10px, 20px), size)"></span>
<span id="r322" style="width:calc-size(max(1em, 10px), size)"></span>
<span id="r323" style="width:calc-size(1em + 1px, size)"></span>
<span id="r324" style="width:calc-size(0, size)"></span>
<span id="r325" style="width:calc-size(0px, size)"></span>
<span id="r326" style="width:calc-size(5, size)"></span>
<span id="r327" style="width:calc-size(size, size)"></span>
<span id="r328" style="width:calc-size(10%, size)"></span>
<span id="r329" style="width:calc-size(-10%, size)"></span>
<span id="r330" style="width:calc-size(10px + 10%, size)"></span>
<span id="r331" style="width:calc-size(10% - 10px, size)"></span>
<span id="r332" style="width:calc-size(2 * 1em, size)"></span>
<span id="r333" style="width:calc-size(0%, size)"></span>
<span id="r334" style="width:calc-size(min(1px, 2%), size)"></span>
<span id="r335" style="width:calc-size(min(1em, 2px), size)"></span>
<span id="r336" style="width:calc-size(clamp(1px, 2%, 3px), size)"></span>
<span id="r337" style="width:calc-size(AUTO, SIZE * 2)"></span>
<span id="r338" style="width:CALC-SIZE(auto, size)"></span>
<span id="r339" style="width:calc-size( auto , size )"></span>
<span id="r340" style="width:calc-size(auto,)"></span>
<span id="r341" style="width:calc-size(,size)"></span>
<span id="r342" style="width:calc-size()"></span>
<span id="r343" style="width:calc(calc-size(auto, size))"></span>
<span id="r344" style="width:calc-size(any, any)"></span>
<span id="r345" style="width:calc-size(auto, auto)"></span>
<span id="r346" style="width:calc-size(auto, min-content)"></span>
<span id="r347" style="width:calc-size(10px, 20%)"></span>
<span id="r348" style="width:calc-size(calc-size(any, 10px), 5px)"></span>
<span id="r349" style="width:calc-size(calc-size(10px, 20px), 30px)"></span>
<span id="r350" style="width:calc-size(any, calc-size(auto, size))"></span>
<span id="r351" style="width:calc-size(auto, calc-size(auto, size))"></span>
<div class="set"><div id="b0" style="width:calc-size(auto, min(size, 100px))"><div class="c"></div></div></div>
<div class="set"><div id="b1" style="width:calc-size(auto, max(size, 500px))"><div class="c"></div></div></div>
<div class="set"><div id="b2" style="width:calc-size(auto, clamp(10px, size, 100px))"><div class="c"></div></div></div>
<div class="set"><div id="b3" style="width:calc-size(-10px, size)"><div class="c"></div></div></div>
<div class="set"><div id="b4" style="width:calc-size(calc-size(auto, size * 0.5), size + 10px)"><div class="c"></div></div></div>
<div class="set"><div id="b5" style="width:calc-size(calc-size(min-content, size + 1px), 2 * size)"><div class="c"></div></div></div>
<div class="set"><div id="b6" style="width:calc-size(calc-size(any, 10px), size * 3)"><div class="c"></div></div></div>
<div class="set"><div id="b7" style="width:calc-size(fit-content, round(size, 50px))"><div class="c"></div></div></div>
<div class="set"><div id="b8" style="width:100px;min-width:calc-size(auto, size + 200px)"><div class="c"></div></div></div>
<div class="set"><div id="b9" style="width:100px;min-width:calc-size(auto, 300px)"><div class="c"></div></div></div>
<div class="set"><div id="b10" style="width:100px;min-width:calc-size(fit-content, size + 200px)"><div class="c"></div></div></div>
<div class="set"><div id="b11" style="width:100px;min-width:calc-size(max-content, size + 200px)"><div class="c"></div></div></div>
<div class="set"><div id="b12" style="width:100px;min-width:calc-size(min-content, size * 5)"><div class="c"></div></div></div>
<div class="set"><div id="b13" style="width:100px;min-width:calc-size(any, 300px)"><div class="c"></div></div></div>
<div class="set"><div id="b14" style="width:100px;min-width:calc-size(300px, size)"><div class="c"></div></div></div>
<div class="set"><div id="b15" style="width:100px;min-width:calc-size(stretch, size * 0.5)"><div class="c"></div></div></div>
<div class="set"><div id="b16" style="width:100px;min-width:calc-size(10%, size * 3)"><div class="c"></div></div></div>
<div class="set"><div id="b17" style="width:100px;min-width:calc-size(any, 50%)"><div class="c"></div></div></div>
<div class="set"><div id="b18" style="width:100px;min-width:calc-size(fit-content, 150px)"><div class="c"></div></div></div>
<div class="set"><div id="b19" style="width:100px;min-width:calc-size(fit-content, 50%)"><div class="c"></div></div></div>
<div class="set"><div id="b20" style="width:300px;max-width:calc-size(fit-content, size + 10px)"><div class="c"></div></div></div>
<div class="set"><div id="b21" style="width:300px;max-width:calc-size(min-content, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b22" style="width:300px;max-width:calc-size(max-content, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b23" style="width:300px;max-width:calc-size(stretch, size * 0.5)"><div class="c"></div></div></div>
<div class="set"><div id="b24" style="width:300px;max-width:calc-size(any, 50px)"><div class="c"></div></div></div>
<div class="set"><div id="b25" style="width:300px;max-width:calc-size(50px, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b26" style="width:300px;max-width:calc-size(fit-content, -10px)"><div class="c"></div></div></div>
<div class="set"><div id="b27" style="width:300px;max-width:calc-size(any, 10%)"><div class="c"></div></div></div>
<div class="set"><div id="b28" style="width:300px;max-width:calc-size(fit-content, 10%)"><div class="c"></div></div></div>
<div class="set"><div id="b29" style="width:300px;max-width:calc-size(-10px, size)"><div class="c"></div></div></div>
<div class="set"><div id="b30" style="width:300px;max-width:calc-size(fit-content, min(size, 5px))"><div class="c"></div></div></div>
<div class="set"><div id="b31" style="height:calc-size(stretch, size * 0.5)"><div class="c"></div></div></div>
<div class="set"><div id="b32" style="height:calc-size(auto, min(size, 5px))"><div class="c"></div></div></div>
<div class="set"><div id="b33" style="height:calc-size(auto, max(size, 50px))"><div class="c"></div></div></div>
<div class="set"><div id="b34" style="height:calc-size(auto, min(size, 1%))"><div class="c"></div></div></div>
<div class="set"><div id="b35" style="height:10px;min-height:calc-size(auto, size + 100px)"><div class="c"></div></div></div>
<div class="set"><div id="b36" style="height:10px;min-height:calc-size(auto, 100px)"><div class="c"></div></div></div>
<div class="set"><div id="b37" style="height:10px;min-height:calc-size(fit-content, size + 5px)"><div class="c"></div></div></div>
<div class="set"><div id="b38" style="height:10px;min-height:calc-size(min-content, size + 5px)"><div class="c"></div></div></div>
<div class="set"><div id="b39" style="height:10px;min-height:calc-size(max-content, size * 3)"><div class="c"></div></div></div>
<div class="set"><div id="b40" style="height:10px;min-height:calc-size(stretch, size * 0.5)"><div class="c"></div></div></div>
<div class="set"><div id="b41" style="height:10px;min-height:calc-size(any, 50px)"><div class="c"></div></div></div>
<div class="set"><div id="b42" style="height:10px;min-height:calc-size(50px, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b43" style="height:10px;min-height:calc-size(10%, size)"><div class="c"></div></div></div>
<div class="set"><div id="b44" style="height:10px;min-height:calc-size(10%, 50px)"><div class="c"></div></div></div>
<div class="set"><div id="b45" style="height:10px;min-height:calc-size(fit-content, 10%)"><div class="c"></div></div></div>
<div class="set"><div id="b46" style="height:10px;min-height:calc-size(fit-content, size + 10%)"><div class="c"></div></div></div>
<div class="set"><div id="b47" style="height:10px;min-height:calc-size(any, 10%)"><div class="c"></div></div></div>
<div class="set"><div id="b48" style="height:10px;min-height:calc-size(auto, 10%)"><div class="c"></div></div></div>
<div class="set"><div id="b49" style="height:10px;min-height:min-content"><div class="c"></div></div></div>
<div class="set"><div id="b50" style="height:10px;min-height:fit-content"><div class="c"></div></div></div>
<div class="set"><div id="b51" style="height:10px;min-height:max-content"><div class="c"></div></div></div>
<div class="set"><div id="b52" style="min-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b53" style="min-height:calc-size(any, 50px)"><div class="c"></div></div></div>
<div class="set"><div id="b54" style="height:100px;max-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b55" style="height:100px;max-height:calc-size(min-content, size + 5px)"><div class="c"></div></div></div>
<div class="set"><div id="b56" style="height:100px;max-height:calc-size(max-content, size * 0.5)"><div class="c"></div></div></div>
<div class="set"><div id="b57" style="height:100px;max-height:calc-size(any, 50px)"><div class="c"></div></div></div>
<div class="set"><div id="b58" style="height:100px;max-height:calc-size(50px, size * 0.5)"><div class="c"></div></div></div>
<div class="set"><div id="b59" style="height:100px;max-height:calc-size(10%, size)"><div class="c"></div></div></div>
<div class="set"><div id="b60" style="height:100px;max-height:calc-size(10%, 50px)"><div class="c"></div></div></div>
<div class="set"><div id="b61" style="height:100px;max-height:calc-size(fit-content, 10%)"><div class="c"></div></div></div>
<div class="set"><div id="b62" style="height:100px;max-height:calc-size(fit-content, size + 10%)"><div class="c"></div></div></div>
<div class="set"><div id="b63" style="height:100px;max-height:calc-size(fit-content, -5px)"><div class="c"></div></div></div>
<div class="set"><div id="b64" style="height:100px;max-height:calc-size(-5px, size)"><div class="c"></div></div></div>
<div class="set"><div id="b65" style="height:100px;max-height:calc-size(any, 10%)"><div class="c"></div></div></div>
<div class="set"><div id="b66" style="height:100px;max-height:min-content"><div class="c"></div></div></div>
<div class="set"><div id="b67" style="height:100px;max-height:fit-content"><div class="c"></div></div></div>
<div class="set"><div id="b68" style="height:100px;max-height:max-content"><div class="c"></div></div></div>
<div class="set"><div id="b69" style="max-height:calc-size(fit-content, size * 0.5)"><div class="c"></div></div></div>
<div class="set"><div id="b70" style="box-sizing:border-box;padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)"><div class="c"></div></div></div>
<div class="set"><div id="b71" style="box-sizing:border-box;padding:10px;width:300px;max-width:calc-size(fit-content, size + 10px)"><div class="c"></div></div></div>
<div class="set"><div id="b72" style="box-sizing:border-box;padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b73" style="box-sizing:border-box;padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b74" style="padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)"><div class="c"></div></div></div>
<div class="set"><div id="b75" style="padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b76" style="padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b77" style="width:calc-size(auto, min(size, 100px))"><div class="c"></div></div></div>
<div class="unset"><div id="b78" style="width:calc-size(auto, max(size, 500px))"><div class="c"></div></div></div>
<div class="unset"><div id="b79" style="width:calc-size(auto, clamp(10px, size, 100px))"><div class="c"></div></div></div>
<div class="unset"><div id="b80" style="width:calc-size(-10px, size)"><div class="c"></div></div></div>
<div class="unset"><div id="b81" style="width:calc-size(calc-size(auto, size * 0.5), size + 10px)"><div class="c"></div></div></div>
<div class="unset"><div id="b82" style="width:calc-size(calc-size(min-content, size + 1px), 2 * size)"><div class="c"></div></div></div>
<div class="unset"><div id="b83" style="width:calc-size(calc-size(any, 10px), size * 3)"><div class="c"></div></div></div>
<div class="unset"><div id="b84" style="width:calc-size(fit-content, round(size, 50px))"><div class="c"></div></div></div>
<div class="unset"><div id="b85" style="width:100px;min-width:calc-size(auto, size + 200px)"><div class="c"></div></div></div>
<div class="unset"><div id="b86" style="width:100px;min-width:calc-size(auto, 300px)"><div class="c"></div></div></div>
<div class="unset"><div id="b87" style="width:100px;min-width:calc-size(fit-content, size + 200px)"><div class="c"></div></div></div>
<div class="unset"><div id="b88" style="width:100px;min-width:calc-size(max-content, size + 200px)"><div class="c"></div></div></div>
<div class="unset"><div id="b89" style="width:100px;min-width:calc-size(min-content, size * 5)"><div class="c"></div></div></div>
<div class="unset"><div id="b90" style="width:100px;min-width:calc-size(any, 300px)"><div class="c"></div></div></div>
<div class="unset"><div id="b91" style="width:100px;min-width:calc-size(300px, size)"><div class="c"></div></div></div>
<div class="unset"><div id="b92" style="width:100px;min-width:calc-size(stretch, size * 0.5)"><div class="c"></div></div></div>
<div class="unset"><div id="b93" style="width:100px;min-width:calc-size(10%, size * 3)"><div class="c"></div></div></div>
<div class="unset"><div id="b94" style="width:100px;min-width:calc-size(any, 50%)"><div class="c"></div></div></div>
<div class="unset"><div id="b95" style="width:100px;min-width:calc-size(fit-content, 150px)"><div class="c"></div></div></div>
<div class="unset"><div id="b96" style="width:100px;min-width:calc-size(fit-content, 50%)"><div class="c"></div></div></div>
<div class="unset"><div id="b97" style="width:300px;max-width:calc-size(fit-content, size + 10px)"><div class="c"></div></div></div>
<div class="unset"><div id="b98" style="width:300px;max-width:calc-size(min-content, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b99" style="width:300px;max-width:calc-size(max-content, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b100" style="width:300px;max-width:calc-size(stretch, size * 0.5)"><div class="c"></div></div></div>
<div class="unset"><div id="b101" style="width:300px;max-width:calc-size(any, 50px)"><div class="c"></div></div></div>
<div class="unset"><div id="b102" style="width:300px;max-width:calc-size(50px, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b103" style="width:300px;max-width:calc-size(fit-content, -10px)"><div class="c"></div></div></div>
<div class="unset"><div id="b104" style="width:300px;max-width:calc-size(any, 10%)"><div class="c"></div></div></div>
<div class="unset"><div id="b105" style="width:300px;max-width:calc-size(fit-content, 10%)"><div class="c"></div></div></div>
<div class="unset"><div id="b106" style="width:300px;max-width:calc-size(-10px, size)"><div class="c"></div></div></div>
<div class="unset"><div id="b107" style="width:300px;max-width:calc-size(fit-content, min(size, 5px))"><div class="c"></div></div></div>
<div class="unset"><div id="b108" style="height:calc-size(50%, 10px)"><div class="c"></div></div></div>
<div class="unset"><div id="b109" style="height:calc-size(10px, 20%)"><div class="c"></div></div></div>
<div class="unset"><div id="b110" style="height:calc-size(auto, min(size, 5px))"><div class="c"></div></div></div>
<div class="unset"><div id="b111" style="height:calc-size(auto, max(size, 50px))"><div class="c"></div></div></div>
<div class="unset"><div id="b112" style="height:calc-size(auto, min(size, 1%))"><div class="c"></div></div></div>
<div class="unset"><div id="b113" style="height:10px;min-height:calc-size(auto, size + 100px)"><div class="c"></div></div></div>
<div class="unset"><div id="b114" style="height:10px;min-height:calc-size(auto, 100px)"><div class="c"></div></div></div>
<div class="unset"><div id="b115" style="height:10px;min-height:calc-size(fit-content, size + 5px)"><div class="c"></div></div></div>
<div class="unset"><div id="b116" style="height:10px;min-height:calc-size(min-content, size + 5px)"><div class="c"></div></div></div>
<div class="unset"><div id="b117" style="height:10px;min-height:calc-size(max-content, size * 3)"><div class="c"></div></div></div>
<div class="unset"><div id="b118" style="height:10px;min-height:calc-size(any, 50px)"><div class="c"></div></div></div>
<div class="unset"><div id="b119" style="height:10px;min-height:calc-size(50px, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b120" style="height:10px;min-height:calc-size(10%, 50px)"><div class="c"></div></div></div>
<div class="unset"><div id="b121" style="height:10px;min-height:calc-size(fit-content, size + 10%)"><div class="c"></div></div></div>
<div class="unset"><div id="b122" style="height:10px;min-height:min-content"><div class="c"></div></div></div>
<div class="unset"><div id="b123" style="height:10px;min-height:fit-content"><div class="c"></div></div></div>
<div class="unset"><div id="b124" style="height:10px;min-height:max-content"><div class="c"></div></div></div>
<div class="unset"><div id="b125" style="min-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b126" style="min-height:calc-size(any, 50px)"><div class="c"></div></div></div>
<div class="unset"><div id="b127" style="height:100px;max-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b128" style="height:100px;max-height:calc-size(min-content, size + 5px)"><div class="c"></div></div></div>
<div class="unset"><div id="b129" style="height:100px;max-height:calc-size(max-content, size * 0.5)"><div class="c"></div></div></div>
<div class="unset"><div id="b130" style="height:100px;max-height:calc-size(any, 50px)"><div class="c"></div></div></div>
<div class="unset"><div id="b131" style="height:100px;max-height:calc-size(50px, size * 0.5)"><div class="c"></div></div></div>
<div class="unset"><div id="b132" style="height:100px;max-height:calc-size(fit-content, 10%)"><div class="c"></div></div></div>
<div class="unset"><div id="b133" style="height:100px;max-height:calc-size(fit-content, size + 10%)"><div class="c"></div></div></div>
<div class="unset"><div id="b134" style="height:100px;max-height:calc-size(fit-content, -5px)"><div class="c"></div></div></div>
<div class="unset"><div id="b135" style="height:100px;max-height:calc-size(-5px, size)"><div class="c"></div></div></div>
<div class="unset"><div id="b136" style="height:100px;max-height:calc-size(any, 10%)"><div class="c"></div></div></div>
<div class="unset"><div id="b137" style="height:100px;max-height:min-content"><div class="c"></div></div></div>
<div class="unset"><div id="b138" style="height:100px;max-height:fit-content"><div class="c"></div></div></div>
<div class="unset"><div id="b139" style="height:100px;max-height:max-content"><div class="c"></div></div></div>
<div class="unset"><div id="b140" style="max-height:calc-size(fit-content, size * 0.5)"><div class="c"></div></div></div>
<div class="unset"><div id="b141" style="box-sizing:border-box;padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)"><div class="c"></div></div></div>
<div class="unset"><div id="b142" style="box-sizing:border-box;padding:10px;width:300px;max-width:calc-size(fit-content, size + 10px)"><div class="c"></div></div></div>
<div class="unset"><div id="b143" style="box-sizing:border-box;padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b144" style="box-sizing:border-box;padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b145" style="padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)"><div class="c"></div></div></div>
<div class="unset"><div id="b146" style="padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="unset"><div id="b147" style="padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)"><div class="c"></div></div></div>
<div class="set"><div id="b148" style="width:300px;max-width:calc-size(min-content, size + 1px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b149" style="width:300px;max-width:calc-size(max-content, size + 1px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b150" style="width:300px;max-width:calc-size(fit-content, size + 1px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b151" style="position:absolute;width:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b152" style="position:absolute;width:calc-size(fit-content, size * 2)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b153" style="position:absolute;width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b154" style="position:absolute;width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b155" style="position:absolute;width:calc-size(stretch, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b156" style="position:absolute;width:calc-size(any, 70px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b157" style="position:absolute;width:calc-size(auto, 70px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b158" style="position:absolute;width:calc-size(auto, min(size, 45px))"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b159" style="position:absolute;left:0;right:0;width:calc-size(auto, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b160" style="position:absolute;top:0;bottom:0;height:calc-size(auto, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b161" style="position:absolute;min-width:calc-size(auto, 70px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b162" style="position:absolute;min-width:calc-size(auto, size + 70px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b163" style="position:absolute;min-width:calc-size(fit-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b164" style="position:absolute;min-width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b165" style="position:absolute;min-width:calc-size(any, 170px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b166" style="position:absolute;max-width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b167" style="position:absolute;max-width:calc-size(fit-content, size - 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b168" style="position:absolute;max-width:calc-size(any, 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b169" style="position:absolute;min-height:calc-size(fit-content, size * 2)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b170" style="position:absolute;max-height:calc-size(fit-content, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b171" style="position:absolute;height:100px;max-height:calc-size(fit-content, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b172" style="position:absolute;height:5px;min-height:calc-size(fit-content, size * 2)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="o173" style="float:left"><div id="b173" style="width:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o174" style="float:left"><div id="b174" style="width:calc-size(stretch, size * 0.5)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o175" style="float:left"><div id="b175" style="width:calc-size(any, 70px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o176" style="float:left"><div id="b176" style="width:calc-size(auto, 70px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o177" style="float:left"><div id="b177" style="width:calc-size(auto, min(size, 45px))"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o178" style="float:left"><div id="b178" style="left:0;right:0;width:calc-size(auto, size * 0.5)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o179" style="float:left"><div id="b179" style="min-width:calc-size(auto, 70px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o180" style="float:left"><div id="b180" style="min-width:calc-size(auto, size + 70px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o181" style="float:left"><div id="b181" style="min-width:calc-size(fit-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o182" style="float:left"><div id="b182" style="min-width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o183" style="float:left"><div id="b183" style="min-width:calc-size(any, 170px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o184" style="float:left"><div id="b184" style="max-width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o185" style="float:left"><div id="b185" style="max-width:calc-size(fit-content, size - 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o186" style="float:left"><div id="b186" style="max-width:calc-size(any, 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o187" style="float:left"><div id="b187" style="min-height:calc-size(fit-content, size * 2)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o188" style="float:left"><div id="b188" style="max-height:calc-size(fit-content, size * 0.5)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o189" style="float:left"><div id="b189" style="height:100px;max-height:calc-size(fit-content, size * 0.5)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="o190" style="float:left"><div id="b190" style="height:5px;min-height:calc-size(fit-content, size * 2)"><b class="w"></b><b class="w"></b></div></div></div>
<div class="set"><div id="b191" style="display:inline-block;width:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b192" style="display:inline-block;width:calc-size(fit-content, size * 2)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b193" style="display:inline-block;width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b194" style="display:inline-block;width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b195" style="display:inline-block;width:calc-size(stretch, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b196" style="display:inline-block;width:calc-size(any, 70px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b197" style="display:inline-block;width:calc-size(auto, 70px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b198" style="display:inline-block;width:calc-size(auto, min(size, 45px))"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b199" style="display:inline-block;left:0;right:0;width:calc-size(auto, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b200" style="display:inline-block;min-width:calc-size(auto, 70px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b201" style="display:inline-block;min-width:calc-size(auto, size + 70px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b202" style="display:inline-block;min-width:calc-size(fit-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b203" style="display:inline-block;min-width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b204" style="display:inline-block;min-width:calc-size(any, 170px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b205" style="display:inline-block;max-width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b206" style="display:inline-block;max-width:calc-size(fit-content, size - 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b207" style="display:inline-block;max-width:calc-size(any, 7px)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b208" style="display:inline-block;min-height:calc-size(fit-content, size * 2)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b209" style="display:inline-block;max-height:calc-size(fit-content, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b210" style="display:inline-block;height:100px;max-height:calc-size(fit-content, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div class="set"><div id="b211" style="display:inline-block;height:5px;min-height:calc-size(fit-content, size * 2)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;width:400px"><div id="b212" style="min-width:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b213" style="min-width:calc-size(auto, size * 2)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b214" style="min-width:calc-size(auto, 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b215" style="min-width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b216" style="min-width:calc-size(fit-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b217" style="min-width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b218" style="min-width:calc-size(any, 70px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b219" style="flex-shrink:0;min-width:calc-size(fit-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b220" style="flex-shrink:0;width:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b221" style="flex-shrink:0;width:calc-size(fit-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b222" style="flex-shrink:0;width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b223" style="flex-shrink:0;width:calc-size(auto, min(size, 45px))"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b224" style="flex-shrink:0;flex-basis:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b225" style="flex-shrink:0;flex-basis:calc-size(content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b226" style="flex-shrink:0;flex-basis:calc-size(fit-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b227" style="flex-shrink:0;flex-basis:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b228" style="flex-shrink:0;flex-basis:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b229" style="flex-shrink:0;flex-basis:calc-size(any, 70px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b230" style="flex-shrink:0;flex-basis:calc-size(70px, size * 2)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b231" style="flex-shrink:0;flex-basis:calc-size(auto, size + 7px);width:100px"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b232" style="flex-shrink:0;flex-basis:calc-size(content, size + 7px);width:100px"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;width:400px"><div id="b233" style="flex-shrink:0;max-width:calc-size(fit-content, size - 5px)"><b class="w"></b><b class="w"></b></div><div style="flex:0 0 380px;height:5px"></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b234" style="min-height:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b235" style="min-height:calc-size(fit-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b236" style="max-height:calc-size(fit-content, size - 7px)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b237" style="flex-basis:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b238" style="flex-basis:calc-size(content, size * 2)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b239" style="flex-basis:calc-size(any, 70px)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b240" style="flex-basis:calc-size(70px, size * 2)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b241" style="width:calc-size(auto, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b242" style="width:calc-size(stretch, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b243" style="width:calc-size(max-content, size * 0.5)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b244" style="width:calc-size(fit-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:flex;flex-direction:column;width:400px;height:300px"><div id="b245" style="max-width:calc-size(fit-content, size - 7px)"><b class="w"></b><b class="w"></b></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b246" style="width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b247" style="width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b248" style="width:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b249" style="min-width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b250" style="min-width:calc-size(auto, 70px)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b251" style="min-width:calc-size(any, 170px)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b252" style="max-width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b253" style="max-width:calc-size(any, 7px)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b254" style="height:calc-size(auto, size * 2)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b255" style="min-height:calc-size(fit-content, size * 2)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:grid;grid-template-columns:auto 1fr;width:400px"><div id="b256" style="max-height:calc-size(fit-content, size * 0.5)"><b class="w"></b><b class="w"></b></div><div style="height:5px"></div></div>
<div style="display:flex;width:10px"><div id="o257"><div id="b257" style="width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div style="display:flex;width:10px"><div id="o258"><div id="b258" style="width:calc-size(max-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div style="display:flex;width:10px"><div id="o259"><div id="b259" style="width:calc-size(auto, size + 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div style="display:flex;width:10px"><div id="o260"><div id="b260" style="width:calc-size(any, 70px)"><b class="w"></b><b class="w"></b></div></div></div>
<div style="display:flex;width:10px"><div id="o261"><div id="b261" style="min-width:calc-size(min-content, size + 7px)"><b class="w"></b><b class="w"></b></div></div></div>
<div style="display:flex;width:10px"><div id="o262"><div id="b262" style="max-width:calc-size(min-content, size * 0.5)"><b class="w"></b><b class="w"></b></div></div></div>
`;

/** A size, a value, what `el.style` keeps of it — nothing where the size
 *  does not take it — and what `getComputedStyle` reads, of `r<i>`. */
export const CALC_SIZE_READS: readonly (readonly [
  string,
  string,
  string,
  string,
])[] = JSON.parse(`[
["width","calc-size(fit-content, size + 10px)","calc-size(fit-content, 10px + size)","calc-size(fit-content, 10px + size)"],
["height","calc-size(fit-content, size + 10px)","calc-size(fit-content, 10px + size)","calc-size(fit-content, 10px + size)"],
["min-width","calc-size(fit-content, size + 10px)","calc-size(fit-content, 10px + size)","calc-size(fit-content, 10px + size)"],
["min-height","calc-size(fit-content, size + 10px)","calc-size(fit-content, 10px + size)","calc-size(fit-content, 10px + size)"],
["max-width","calc-size(fit-content, size + 10px)","calc-size(fit-content, 10px + size)","calc-size(fit-content, 10px + size)"],
["max-height","calc-size(fit-content, size + 10px)","calc-size(fit-content, 10px + size)","calc-size(fit-content, 10px + size)"],
["flex-basis","calc-size(fit-content, size + 10px)","calc-size(fit-content, 10px + size)","calc-size(fit-content, 10px + size)"],
["width","calc-size(auto, size * 2)","calc-size(auto, 2 * size)","calc-size(auto, 2 * size)"],
["height","calc-size(auto, size * 2)","calc-size(auto, 2 * size)","calc-size(auto, 2 * size)"],
["min-width","calc-size(auto, size * 2)","calc-size(auto, 2 * size)","calc-size(auto, 2 * size)"],
["min-height","calc-size(auto, size * 2)","calc-size(auto, 2 * size)","calc-size(auto, 2 * size)"],
["max-width","calc-size(auto, size * 2)","","none"],
["max-height","calc-size(auto, size * 2)","","none"],
["flex-basis","calc-size(auto, size * 2)","calc-size(auto, 2 * size)","calc-size(auto, 2 * size)"],
["width","calc-size(min-content, size)","calc-size(min-content, size)","calc-size(min-content, size)"],
["height","calc-size(min-content, size)","calc-size(min-content, size)","calc-size(min-content, size)"],
["min-width","calc-size(min-content, size)","calc-size(min-content, size)","calc-size(min-content, size)"],
["min-height","calc-size(min-content, size)","calc-size(min-content, size)","calc-size(min-content, size)"],
["max-width","calc-size(min-content, size)","calc-size(min-content, size)","calc-size(min-content, size)"],
["max-height","calc-size(min-content, size)","calc-size(min-content, size)","calc-size(min-content, size)"],
["flex-basis","calc-size(min-content, size)","calc-size(min-content, size)","calc-size(min-content, size)"],
["width","calc-size(max-content, size)","calc-size(max-content, size)","calc-size(max-content, size)"],
["height","calc-size(max-content, size)","calc-size(max-content, size)","calc-size(max-content, size)"],
["min-width","calc-size(max-content, size)","calc-size(max-content, size)","calc-size(max-content, size)"],
["min-height","calc-size(max-content, size)","calc-size(max-content, size)","calc-size(max-content, size)"],
["max-width","calc-size(max-content, size)","calc-size(max-content, size)","calc-size(max-content, size)"],
["max-height","calc-size(max-content, size)","calc-size(max-content, size)","calc-size(max-content, size)"],
["flex-basis","calc-size(max-content, size)","calc-size(max-content, size)","calc-size(max-content, size)"],
["width","calc-size(stretch, size)","calc-size(stretch, size)","calc-size(stretch, size)"],
["height","calc-size(stretch, size)","calc-size(stretch, size)","calc-size(stretch, size)"],
["min-width","calc-size(stretch, size)","calc-size(stretch, size)","calc-size(stretch, size)"],
["min-height","calc-size(stretch, size)","calc-size(stretch, size)","calc-size(stretch, size)"],
["max-width","calc-size(stretch, size)","calc-size(stretch, size)","calc-size(stretch, size)"],
["max-height","calc-size(stretch, size)","calc-size(stretch, size)","calc-size(stretch, size)"],
["flex-basis","calc-size(stretch, size)","calc-size(stretch, size)","calc-size(stretch, size)"],
["width","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)"],
["height","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)"],
["min-width","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)"],
["min-height","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)"],
["max-width","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)"],
["max-height","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)","calc-size(-webkit-fill-available, size)"],
["flex-basis","calc-size(-webkit-fill-available, size)","","auto"],
["width","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)"],
["height","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)"],
["min-width","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)"],
["min-height","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)"],
["max-width","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)"],
["max-height","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)","calc-size(-webkit-fit-content, size)"],
["flex-basis","calc-size(-webkit-fit-content, size)","","auto"],
["width","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)"],
["height","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)"],
["min-width","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)"],
["min-height","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)"],
["max-width","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)"],
["max-height","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)","calc-size(-webkit-min-content, size)"],
["flex-basis","calc-size(-webkit-min-content, size)","","auto"],
["width","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)"],
["height","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)"],
["min-width","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)"],
["min-height","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)"],
["max-width","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)"],
["max-height","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)","calc-size(-webkit-max-content, size)"],
["flex-basis","calc-size(-webkit-max-content, size)","","auto"],
["width","calc-size(-moz-available, size)","","auto"],
["height","calc-size(-moz-available, size)","","auto"],
["min-width","calc-size(-moz-available, size)","","0px"],
["min-height","calc-size(-moz-available, size)","","0px"],
["max-width","calc-size(-moz-available, size)","","none"],
["max-height","calc-size(-moz-available, size)","","none"],
["flex-basis","calc-size(-moz-available, size)","","auto"],
["width","calc-size(fit-content(20px), size)","","auto"],
["height","calc-size(fit-content(20px), size)","","auto"],
["min-width","calc-size(fit-content(20px), size)","","0px"],
["min-height","calc-size(fit-content(20px), size)","","0px"],
["max-width","calc-size(fit-content(20px), size)","","none"],
["max-height","calc-size(fit-content(20px), size)","","none"],
["flex-basis","calc-size(fit-content(20px), size)","","auto"],
["width","calc-size(none, size)","","auto"],
["height","calc-size(none, size)","","auto"],
["min-width","calc-size(none, size)","","0px"],
["min-height","calc-size(none, size)","","0px"],
["max-width","calc-size(none, size)","","none"],
["max-height","calc-size(none, size)","","none"],
["flex-basis","calc-size(none, size)","","auto"],
["width","calc-size(content, size)","","auto"],
["height","calc-size(content, size)","","auto"],
["min-width","calc-size(content, size)","","0px"],
["min-height","calc-size(content, size)","","0px"],
["max-width","calc-size(content, size)","","none"],
["max-height","calc-size(content, size)","","none"],
["flex-basis","calc-size(content, size)","calc-size(content, size)","calc-size(content, size)"],
["width","calc-size(any, 10px)","calc-size(any, 10px)","calc-size(any, 10px)"],
["height","calc-size(any, 10px)","calc-size(any, 10px)","calc-size(any, 10px)"],
["min-width","calc-size(any, 10px)","calc-size(any, 10px)","calc-size(any, 10px)"],
["min-height","calc-size(any, 10px)","calc-size(any, 10px)","calc-size(any, 10px)"],
["max-width","calc-size(any, 10px)","calc-size(any, 10px)","calc-size(any, 10px)"],
["max-height","calc-size(any, 10px)","calc-size(any, 10px)","calc-size(any, 10px)"],
["flex-basis","calc-size(any, 10px)","calc-size(any, 10px)","calc-size(any, 10px)"],
["width","calc-size(any, size)","","auto"],
["height","calc-size(any, size)","","auto"],
["min-width","calc-size(any, size)","","0px"],
["min-height","calc-size(any, size)","","0px"],
["max-width","calc-size(any, size)","","none"],
["max-height","calc-size(any, size)","","none"],
["flex-basis","calc-size(any, size)","","auto"],
["width","calc-size(any, 10px + 5%)","calc-size(any, 5% + 10px)","calc-size(any, 5% + 10px)"],
["height","calc-size(any, 10px + 5%)","calc-size(any, 5% + 10px)","calc-size(any, 5% + 10px)"],
["min-width","calc-size(any, 10px + 5%)","calc-size(any, 5% + 10px)","calc-size(any, 5% + 10px)"],
["min-height","calc-size(any, 10px + 5%)","calc-size(any, 5% + 10px)","calc-size(any, 5% + 10px)"],
["max-width","calc-size(any, 10px + 5%)","calc-size(any, 5% + 10px)","calc-size(any, 5% + 10px)"],
["max-height","calc-size(any, 10px + 5%)","calc-size(any, 5% + 10px)","calc-size(any, 5% + 10px)"],
["flex-basis","calc-size(any, 10px + 5%)","calc-size(any, 5% + 10px)","calc-size(any, 5% + 10px)"],
["width","calc-size(any, 0)","","auto"],
["height","calc-size(any, 0)","","auto"],
["min-width","calc-size(any, 0)","","0px"],
["min-height","calc-size(any, 0)","","0px"],
["max-width","calc-size(any, 0)","","none"],
["max-height","calc-size(any, 0)","","none"],
["flex-basis","calc-size(any, 0)","","auto"],
["width","calc-size(auto)","","auto"],
["height","calc-size(auto)","","auto"],
["min-width","calc-size(auto)","","0px"],
["min-height","calc-size(auto)","","0px"],
["max-width","calc-size(auto)","","none"],
["max-height","calc-size(auto)","","none"],
["flex-basis","calc-size(auto)","","auto"],
["width","calc-size(fit-content)","","auto"],
["height","calc-size(fit-content)","","auto"],
["min-width","calc-size(fit-content)","","0px"],
["min-height","calc-size(fit-content)","","0px"],
["max-width","calc-size(fit-content)","","none"],
["max-height","calc-size(fit-content)","","none"],
["flex-basis","calc-size(fit-content)","","auto"],
["width","calc-size(10px)","","auto"],
["height","calc-size(10px)","","auto"],
["min-width","calc-size(10px)","","0px"],
["min-height","calc-size(10px)","","0px"],
["max-width","calc-size(10px)","","none"],
["max-height","calc-size(10px)","","none"],
["flex-basis","calc-size(10px)","","auto"],
["width","calc-size(10px, size)","calc-size(10px, size)","calc-size(10px, size)"],
["height","calc-size(10px, size)","calc-size(10px, size)","calc-size(10px, size)"],
["min-width","calc-size(10px, size)","calc-size(10px, size)","calc-size(10px, size)"],
["min-height","calc-size(10px, size)","calc-size(10px, size)","calc-size(10px, size)"],
["max-width","calc-size(10px, size)","calc-size(10px, size)","calc-size(10px, size)"],
["max-height","calc-size(10px, size)","calc-size(10px, size)","calc-size(10px, size)"],
["flex-basis","calc-size(10px, size)","calc-size(10px, size)","calc-size(10px, size)"],
["width","calc-size(50%, size + 10px)","calc-size(50%, 10px + size)","calc-size(50%, 10px + size)"],
["height","calc-size(50%, size + 10px)","calc-size(50%, 10px + size)","calc-size(50%, 10px + size)"],
["min-width","calc-size(50%, size + 10px)","calc-size(50%, 10px + size)","calc-size(50%, 10px + size)"],
["min-height","calc-size(50%, size + 10px)","calc-size(50%, 10px + size)","calc-size(50%, 10px + size)"],
["max-width","calc-size(50%, size + 10px)","calc-size(50%, 10px + size)","calc-size(50%, 10px + size)"],
["max-height","calc-size(50%, size + 10px)","calc-size(50%, 10px + size)","calc-size(50%, 10px + size)"],
["flex-basis","calc-size(50%, size + 10px)","calc-size(50%, 10px + size)","calc-size(50%, 10px + size)"],
["width","calc-size(calc-size(auto, size + 1px), size * 2)","calc-size(calc-size(auto, 1px + size), 2 * size)","calc-size(calc-size(auto, 1px + size), 2 * size)"],
["height","calc-size(calc-size(auto, size + 1px), size * 2)","calc-size(calc-size(auto, 1px + size), 2 * size)","calc-size(calc-size(auto, 1px + size), 2 * size)"],
["min-width","calc-size(calc-size(auto, size + 1px), size * 2)","calc-size(calc-size(auto, 1px + size), 2 * size)","calc-size(calc-size(auto, 1px + size), 2 * size)"],
["min-height","calc-size(calc-size(auto, size + 1px), size * 2)","calc-size(calc-size(auto, 1px + size), 2 * size)","calc-size(calc-size(auto, 1px + size), 2 * size)"],
["max-width","calc-size(calc-size(auto, size + 1px), size * 2)","","none"],
["max-height","calc-size(calc-size(auto, size + 1px), size * 2)","","none"],
["flex-basis","calc-size(calc-size(auto, size + 1px), size * 2)","calc-size(calc-size(auto, 1px + size), 2 * size)","calc-size(calc-size(auto, 1px + size), 2 * size)"],
["width","calc-size(calc-size(50px, size + 1px), size * 2)","calc-size(calc-size(50px, 1px + size), 2 * size)","calc-size(calc-size(50px, 1px + size), 2 * size)"],
["height","calc-size(calc-size(50px, size + 1px), size * 2)","calc-size(calc-size(50px, 1px + size), 2 * size)","calc-size(calc-size(50px, 1px + size), 2 * size)"],
["min-width","calc-size(calc-size(50px, size + 1px), size * 2)","calc-size(calc-size(50px, 1px + size), 2 * size)","calc-size(calc-size(50px, 1px + size), 2 * size)"],
["min-height","calc-size(calc-size(50px, size + 1px), size * 2)","calc-size(calc-size(50px, 1px + size), 2 * size)","calc-size(calc-size(50px, 1px + size), 2 * size)"],
["max-width","calc-size(calc-size(50px, size + 1px), size * 2)","calc-size(calc-size(50px, 1px + size), 2 * size)","calc-size(calc-size(50px, 1px + size), 2 * size)"],
["max-height","calc-size(calc-size(50px, size + 1px), size * 2)","calc-size(calc-size(50px, 1px + size), 2 * size)","calc-size(calc-size(50px, 1px + size), 2 * size)"],
["flex-basis","calc-size(calc-size(50px, size + 1px), size * 2)","calc-size(calc-size(50px, 1px + size), 2 * size)","calc-size(calc-size(50px, 1px + size), 2 * size)"],
["width","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)"],
["height","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)"],
["min-width","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)"],
["min-height","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)"],
["max-width","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)"],
["max-height","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)"],
["flex-basis","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)","calc-size(calc-size(fit-content, size), size)"],
["width","calc-size(auto, size, junk)","calc-size(auto, size)","calc-size(auto, size)"],
["height","calc-size(auto, size, junk)","calc-size(auto, size)","calc-size(auto, size)"],
["min-width","calc-size(auto, size, junk)","calc-size(auto, size)","calc-size(auto, size)"],
["min-height","calc-size(auto, size, junk)","calc-size(auto, size)","calc-size(auto, size)"],
["max-width","calc-size(auto, size, junk)","","none"],
["max-height","calc-size(auto, size, junk)","","none"],
["flex-basis","calc-size(auto, size, junk)","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size(auto, size - 10px)","calc-size(auto, -10px + size)","calc-size(auto, -10px + size)"],
["width","calc-size(auto, 10px - size)","calc-size(auto, 10px - size)","calc-size(auto, 10px - size)"],
["width","calc-size(auto, -1 * size)","calc-size(auto, -1 * size)","calc-size(auto, -1 * size)"],
["width","calc-size(auto, size * -2)","calc-size(auto, -2 * size)","calc-size(auto, -2 * size)"],
["width","calc-size(auto, size / 2)","calc-size(auto, 0.5 * size)","calc-size(auto, 0.5 * size)"],
["width","calc-size(auto, size * 0.5 + 10%)","calc-size(auto, 10% + (0.5 * size))","calc-size(auto, 10% + (0.5 * size))"],
["width","calc-size(auto, 50% - size)","calc-size(auto, 50% - size)","calc-size(auto, 50% - size)"],
["width","calc-size(auto, 10px)","calc-size(auto, 10px)","calc-size(auto, 10px)"],
["width","calc-size(auto, 10%)","calc-size(auto, 10%)","calc-size(auto, 10%)"],
["width","calc-size(auto, 10px + 5%)","calc-size(auto, 5% + 10px)","calc-size(auto, 5% + 10px)"],
["width","calc-size(auto, 0px)","calc-size(auto, 0px)","calc-size(auto, 0px)"],
["width","calc-size(auto, 0)","","auto"],
["width","calc-size(auto, 5)","","auto"],
["width","calc-size(auto, size * 0)","calc-size(auto, 0 * size)","calc-size(auto, 0 * size)"],
["width","calc-size(auto, size + size)","calc-size(auto, size + size)","calc-size(auto, size + size)"],
["width","calc-size(auto, size + 1em)","calc-size(auto, 1em + size)","calc-size(auto, 16px + size)"],
["width","calc-size(auto, 1em + 2px + size)","calc-size(auto, 1em + 2px + size)","calc-size(auto, 18px + size)"],
["width","calc-size(auto, size + 10px + 5%)","calc-size(auto, 5% + 10px + size)","calc-size(auto, 5% + 10px + size)"],
["width","calc-size(auto, 5% + size + 10px)","calc-size(auto, 5% + 10px + size)","calc-size(auto, 5% + 10px + size)"],
["width","calc-size(auto, size - 10px - 5%)","calc-size(auto, -5% - 10px + size)","calc-size(auto, -5% - 10px + size)"],
["width","calc-size(auto, -10px + size * 2)","calc-size(auto, -10px + (2 * size))","calc-size(auto, -10px + (2 * size))"],
["width","calc-size(auto, size * 1.5)","calc-size(auto, 1.5 * size)","calc-size(auto, 1.5 * size)"],
["width","calc-size(auto, size * 0.1 + 0.25px)","calc-size(auto, 0.25px + (0.1 * size))","calc-size(auto, 0.25px + (0.1 * size))"],
["width","calc-size(auto, size * 1)","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size(auto, -1 * size - 10px)","calc-size(auto, -10px + (-1 * size))","calc-size(auto, -10px + (-1 * size))"],
["width","calc-size(auto, (size + 10px) * 2)","calc-size(auto, 2 * (10px + size))","calc-size(auto, 2 * (10px + size))"],
["width","calc-size(auto, size * size)","","auto"],
["width","calc-size(auto, size / size)","","auto"],
["width","calc-size(auto, 2 / size)","","auto"],
["width","calc-size(auto, min(size, 100px))","calc-size(auto, min(size, 100px))","calc-size(auto, min(size, 100px))"],
["width","calc-size(auto, max(size, 100px))","calc-size(auto, max(size, 100px))","calc-size(auto, max(size, 100px))"],
["width","calc-size(auto, clamp(10px, size, 100px))","calc-size(auto, clamp(10px, size, 100px))","calc-size(auto, clamp(10px, size, 100px))"],
["width","calc-size(auto, round(size, 10px))","calc-size(auto, round(size, 10px))","calc-size(auto, round(size, 10px))"],
["width","calc-size(auto, abs(size))","calc-size(auto, abs(size))","calc-size(auto, abs(size))"],
["width","calc-size(auto, calc(size + 1px))","calc-size(auto, 1px + size)","calc-size(auto, 1px + size)"],
["width","calc-size(auto, sign(size) * 1px)","calc-size(auto, 1px * sign(size))","calc-size(auto, 1px * sign(size))"],
["width","calc-size(auto, size * sign(size))","calc-size(auto, size * sign(size))","calc-size(auto, size * sign(size))"],
["width","calc-size(auto, -size)","","auto"],
["width","calc-size(auto, 0px - size)","calc-size(auto, 0px - size)","calc-size(auto, 0px - size)"],
["width","calc-size(auto, 0px + size)","calc-size(auto, 0px + size)","calc-size(auto, 0px + size)"],
["width","calc-size(auto, size + 0px)","calc-size(auto, 0px + size)","calc-size(auto, 0px + size)"],
["width","calc-size(auto, 10px + 5px + size)","calc-size(auto, 15px + size)","calc-size(auto, 15px + size)"],
["width","calc-size(auto, size + 10px + 10px)","calc-size(auto, 20px + size)","calc-size(auto, 20px + size)"],
["width","calc-size(auto, (size + 10px) + 5px)","calc-size(auto, 15px + size)","calc-size(auto, 15px + size)"],
["width","calc-size(auto, 1em + 1em + size)","calc-size(auto, 2em + size)","calc-size(auto, 32px + size)"],
["width","calc-size(auto, 10px - 5px + size)","calc-size(auto, 5px + size)","calc-size(auto, 5px + size)"],
["width","calc-size(auto, 10px - 10px + size)","calc-size(auto, 0px + size)","calc-size(auto, 0px + size)"],
["width","calc-size(auto, 10px * 2 + size)","calc-size(auto, 20px + size)","calc-size(auto, 20px + size)"],
["width","calc-size(auto, (size - 10px) * 2)","calc-size(auto, 2 * (-10px + size))","calc-size(auto, 2 * (-10px + size))"],
["width","calc-size(auto, (size + 10px) / 2)","calc-size(auto, 0.5 * (10px + size))","calc-size(auto, 0.5 * (10px + size))"],
["width","calc-size(auto, -1 * (size + 10px))","calc-size(auto, -1 * (10px + size))","calc-size(auto, -1 * (10px + size))"],
["width","calc-size(auto, 2 * (size * 3))","calc-size(auto, 6 * size)","calc-size(auto, 6 * size)"],
["width","calc-size(auto, size / 2 * 2)","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size(auto, 1 * size)","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size(auto, 2 * 3 * size)","calc-size(auto, 6 * size)","calc-size(auto, 6 * size)"],
["width","calc-size(auto, min(100px, size))","calc-size(auto, min(100px, size))","calc-size(auto, min(100px, size))"],
["width","calc-size(auto, max(size))","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size(auto, min(size, 10px, 20px))","calc-size(auto, min(size, 10px, 20px))","calc-size(auto, min(size, 10px, 20px))"],
["width","calc-size(auto, min(size * 2, 10px))","calc-size(auto, min(2 * size, 10px))","calc-size(auto, min(2 * size, 10px))"],
["width","calc-size(auto, min(size + 1px, 10px))","calc-size(auto, min(1px + size, 10px))","calc-size(auto, min(1px + size, 10px))"],
["width","calc-size(auto, min(size, 1em))","calc-size(auto, min(size, 1em))","calc-size(auto, min(size, 16px))"],
["width","calc-size(auto, min(size, calc(100px + 5%)))","calc-size(auto, min(size, 5% + 100px))","calc-size(auto, min(size, 5% + 100px))"],
["width","calc-size(auto, calc(size * 2) + 1px)","calc-size(auto, 1px + (2 * size))","calc-size(auto, 1px + (2 * size))"],
["width","calc-size(auto, min(10px, 20px) + size)","calc-size(auto, 10px + size)","calc-size(auto, 10px + size)"],
["width","calc-size(auto, 5mm + size)","calc-size(auto, 18.8976px + size)","calc-size(auto, 18.8976px + size)"],
["width","calc-size(auto, 1in + size)","calc-size(auto, 96px + size)","calc-size(auto, 96px + size)"],
["width","calc-size(auto, 1rem + 1em + size)","calc-size(auto, 1em + 1rem + size)","calc-size(auto, 32px + size)"],
["width","calc-size(auto, size + 1.123456789px)","calc-size(auto, 1.12346px + size)","calc-size(auto, 1.12346px + size)"],
["width","calc-size(auto, 0.123456789 * size)","calc-size(auto, 0.123457 * size)","calc-size(auto, 0.123457 * size)"],
["width","calc-size(auto, 1000000 * size)","calc-size(auto, 1e+06 * size)","calc-size(auto, 1e+06 * size)"],
["width","calc-size(auto, 1e-7 * size)","calc-size(auto, 1e-07 * size)","calc-size(auto, 1e-07 * size)"],
["width","calc-size(auto, size + 10)","","auto"],
["width","calc-size(auto, 5 * 5)","","auto"],
["width","calc-size(auto, 10px * 10px)","","auto"],
["width","calc-size(auto, 1deg)","","auto"],
["width","calc-size(auto, pi * size)","calc-size(auto, 3.14159 * size)","calc-size(auto, 3.14159 * size)"],
["width","calc-size(auto, e * 1px + size)","calc-size(auto, 2.71828px + size)","calc-size(auto, 2.71828px + size)"],
["width","calc-size(auto, sin(30deg) * size)","calc-size(auto, 0.5 * size)","calc-size(auto, 0.5 * size)"],
["width","calc-size(auto, pow(2, 2) * size)","calc-size(auto, 4 * size)","calc-size(auto, 4 * size)"],
["width","calc-size(auto, sqrt(4) * size)","calc-size(auto, 2 * size)","calc-size(auto, 2 * size)"],
["width","calc-size(auto, exp(1) * size)","calc-size(auto, 2.71828 * size)","calc-size(auto, 2.71828 * size)"],
["width","calc-size(auto, sign(-1px) * size)","calc-size(auto, -1 * size)","calc-size(auto, -1 * size)"],
["width","calc-size(auto, mod(size, 7px))","calc-size(auto, mod(size, 7px))","calc-size(auto, mod(size, 7px))"],
["width","calc-size(auto, rem(size, 7px))","calc-size(auto, rem(size, 7px))","calc-size(auto, rem(size, 7px))"],
["width","calc-size(auto, hypot(size, 3px))","calc-size(auto, hypot(size, 3px))","calc-size(auto, hypot(size, 3px))"],
["width","calc-size(auto, round(up, size, 10px))","calc-size(auto, round(up, size, 10px))","calc-size(auto, round(up, size, 10px))"],
["width","calc-size(auto, 10px - 2 * size)","calc-size(auto, 10px - (2 * size))","calc-size(auto, 10px - (2 * size))"],
["width","calc-size(auto, 10% - 2 * size + 5px)","calc-size(auto, 10% + 5px - (2 * size))","calc-size(auto, 10% + 5px - (2 * size))"],
["width","calc-size(auto, 10px - (size + 5px))","calc-size(auto, 5px - size)","calc-size(auto, 5px - size)"],
["width","calc-size(auto, 10px - (size - 5px))","calc-size(auto, 15px - size)","calc-size(auto, 15px - size)"],
["width","calc-size(auto, 10px - min(size, 1px))","calc-size(auto, 10px - min(size, 1px))","calc-size(auto, 10px - min(size, 1px))"],
["width","calc-size(auto, min(size, 1px) - 10px)","calc-size(auto, -10px + min(size, 1px))","calc-size(auto, -10px + min(size, 1px))"],
["width","calc-size(auto, 2 * min(size, 1px))","calc-size(auto, 2 * min(size, 1px))","calc-size(auto, 2 * min(size, 1px))"],
["width","calc-size(auto, min(size, 1px) / 2)","calc-size(auto, 0.5 * min(size, 1px))","calc-size(auto, 0.5 * min(size, 1px))"],
["width","calc-size(auto, size / 2 + size / 2)","calc-size(auto, (0.5 * size) + (0.5 * size))","calc-size(auto, (0.5 * size) + (0.5 * size))"],
["width","calc-size(auto, -1 * size + 1px)","calc-size(auto, 1px + (-1 * size))","calc-size(auto, 1px + (-1 * size))"],
["width","calc-size(auto, 1 * size * sign(size))","calc-size(auto, size * sign(size))","calc-size(auto, size * sign(size))"],
["width","calc-size(auto, abs(size) * 2)","calc-size(auto, 2 * abs(size))","calc-size(auto, 2 * abs(size))"],
["width","calc-size(auto, size * (1 + 2))","calc-size(auto, 3 * size)","calc-size(auto, 3 * size)"],
["width","calc-size(auto, size * calc(1 + 2))","calc-size(auto, 3 * size)","calc-size(auto, 3 * size)"],
["width","calc-size(auto, size * 0 + 1px)","calc-size(auto, 1px + (0 * size))","calc-size(auto, 1px + (0 * size))"],
["width","calc-size(auto, -0px)","calc-size(auto, 0px)","calc-size(auto, 0px)"],
["width","calc-size(auto, size * -0)","calc-size(auto, 0 * size)","calc-size(auto, 0 * size)"],
["width","calc-size(auto, 1px * size)","","auto"],
["width","calc-size(auto, size * 1px)","","auto"],
["width","calc-size(auto, (size))","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size(auto, ((size + 1px)))","calc-size(auto, 1px + size)","calc-size(auto, 1px + size)"],
["width","calc-size(auto, size+1px)","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size(auto, size +1px)","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size(auto, size*2)","calc-size(auto, 2 * size)","calc-size(auto, 2 * size)"],
["width","calc-size(auto, size/2)","calc-size(auto, 0.5 * size)","calc-size(auto, 0.5 * size)"],
["width","calc-size(auto, 1px + 1%)","calc-size(auto, 1% + 1px)","calc-size(auto, 1% + 1px)"],
["width","calc-size(auto, 1px - 1%)","calc-size(auto, -1% + 1px)","calc-size(auto, -1% + 1px)"],
["width","calc-size(auto, 10% + 20%)","calc-size(auto, 30%)","calc-size(auto, 30%)"],
["width","calc-size(auto, 10% - 10%)","calc-size(auto, 0%)","calc-size(auto, 0%)"],
["width","calc-size(auto, 2 * 10%)","calc-size(auto, 20%)","calc-size(auto, 20%)"],
["width","calc-size(auto, min(10%, 20%))","calc-size(auto, min(10%, 20%))","calc-size(auto, min(10%, 20%))"],
["width","calc-size(auto, min(10%, 20%) + size)","calc-size(auto, min(10%, 20%) + size)","calc-size(auto, min(10%, 20%) + size)"],
["width","calc-size(auto, calc(1px))","calc-size(auto, 1px)","calc-size(auto, 1px)"],
["width","calc-size(auto, max(size, min(size, 1px)))","calc-size(auto, max(size, min(size, 1px)))","calc-size(auto, max(size, min(size, 1px)))"],
["width","calc-size(auto, round(size, 1px) + 1px)","calc-size(auto, 1px + round(size, 1px))","calc-size(auto, 1px + round(size, 1px))"],
["width","calc-size(auto, round(nearest, size, 1px))","calc-size(auto, round(size, 1px))","calc-size(auto, round(size, 1px))"],
["width","calc-size(auto, round(to-zero, size, 1px))","calc-size(auto, round(to-zero, size, 1px))","calc-size(auto, round(to-zero, size, 1px))"],
["width","calc-size(auto, clamp(1px, 2px, 3px) + size)","calc-size(auto, 2px + size)","calc-size(auto, 2px + size)"],
["width","calc-size(auto, clamp(size, 1px, 2px))","calc-size(auto, clamp(size, 1px, 2px))","calc-size(auto, clamp(size, 1px, 2px))"],
["width","calc-size(auto, sign(size) * size)","calc-size(auto, sign(size) * size)","calc-size(auto, sign(size) * size)"],
["width","calc-size(auto, abs(-1px) + size)","calc-size(auto, 1px + size)","calc-size(auto, 1px + size)"],
["width","calc-size(auto, mod(5px, 3px) + size)","calc-size(auto, 2px + size)","calc-size(auto, 2px + size)"],
["width","calc-size(auto, hypot(3px, 4px) + size)","calc-size(auto, 5px + size)","calc-size(auto, 5px + size)"],
["width","calc-size(auto, size / 2px)","","auto"],
["width","calc-size(auto, (size * 2) - size)","calc-size(auto, (2 * size) - size)","calc-size(auto, (2 * size) - size)"],
["width","calc-size(auto, size - size)","calc-size(auto, size - size)","calc-size(auto, size - size)"],
["width","calc-size(10em, size)","calc-size(10em, size)","calc-size(160px, size)"],
["width","calc-size(calc(10px + 5%), size)","calc-size(5% + 10px, size)","calc-size(5% + 10px, size)"],
["width","calc-size(-10px, size)","calc-size(-10px, size)","calc-size(-10px, size)"],
["width","calc-size(50px + 10px, size)","calc-size(60px, size)","calc-size(60px, size)"],
["width","calc-size(calc(50px + 10px), size)","calc-size(60px, size)","calc-size(60px, size)"],
["width","calc-size(10px * 2, size)","calc-size(20px, size)","calc-size(20px, size)"],
["width","calc-size(min(10px, 5%), size)","calc-size(min(10px, 5%), size)","calc-size(min(10px, 5%), size)"],
["width","calc-size(min(10px, 20px), size)","calc-size(10px, size)","calc-size(10px, size)"],
["width","calc-size(max(1em, 10px), size)","calc-size(max(1em, 10px), size)","calc-size(16px, size)"],
["width","calc-size(1em + 1px, size)","calc-size(1em + 1px, size)","calc-size(17px, size)"],
["width","calc-size(0, size)","","auto"],
["width","calc-size(0px, size)","calc-size(0px, size)","calc-size(0px, size)"],
["width","calc-size(5, size)","","auto"],
["width","calc-size(size, size)","","auto"],
["width","calc-size(10%, size)","calc-size(10%, size)","calc-size(10%, size)"],
["width","calc-size(-10%, size)","calc-size(-10%, size)","calc-size(-10%, size)"],
["width","calc-size(10px + 10%, size)","calc-size(10% + 10px, size)","calc-size(10% + 10px, size)"],
["width","calc-size(10% - 10px, size)","calc-size(10% - 10px, size)","calc-size(10% - 10px, size)"],
["width","calc-size(2 * 1em, size)","calc-size(2em, size)","calc-size(32px, size)"],
["width","calc-size(0%, size)","calc-size(0%, size)","calc-size(0%, size)"],
["width","calc-size(min(1px, 2%), size)","calc-size(min(1px, 2%), size)","calc-size(min(1px, 2%), size)"],
["width","calc-size(min(1em, 2px), size)","calc-size(min(1em, 2px), size)","calc-size(2px, size)"],
["width","calc-size(clamp(1px, 2%, 3px), size)","calc-size(clamp(1px, 2%, 3px), size)","calc-size(clamp(1px, 2%, 3px), size)"],
["width","calc-size(AUTO, SIZE * 2)","calc-size(auto, 2 * size)","calc-size(auto, 2 * size)"],
["width","CALC-SIZE(auto, size)","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size( auto , size )","calc-size(auto, size)","calc-size(auto, size)"],
["width","calc-size(auto,)","","auto"],
["width","calc-size(,size)","","auto"],
["width","calc-size()","","auto"],
["width","calc(calc-size(auto, size))","","auto"],
["width","calc-size(any, any)","","auto"],
["width","calc-size(auto, auto)","","auto"],
["width","calc-size(auto, min-content)","","auto"],
["width","calc-size(10px, 20%)","calc-size(10px, 20%)","calc-size(10px, 20%)"],
["width","calc-size(calc-size(any, 10px), 5px)","calc-size(calc-size(any, 10px), 5px)","calc-size(calc-size(any, 10px), 5px)"],
["width","calc-size(calc-size(10px, 20px), 30px)","calc-size(calc-size(10px, 20px), 30px)","calc-size(calc-size(10px, 20px), 30px)"],
["width","calc-size(any, calc-size(auto, size))","","auto"],
["width","calc-size(auto, calc-size(auto, size))","","auto"]
]`);

/** A kind of box, its style, the width and the height of `b<i>`, and those
 *  of `o<i>`, what a float was shrunk to fit around it. */
export const CALC_SIZE_BOXES: readonly (readonly [
  string,
  string,
  readonly [number, number],
  readonly [number, number] | null,
])[] = JSON.parse(`[
["set","width:calc-size(auto, min(size, 100px))",[100,20],null],
["set","width:calc-size(auto, max(size, 500px))",[500,20],null],
["set","width:calc-size(auto, clamp(10px, size, 100px))",[100,20],null],
["set","width:calc-size(-10px, size)",[0,20],null],
["set","width:calc-size(calc-size(auto, size * 0.5), size + 10px)",[210,20],null],
["set","width:calc-size(calc-size(min-content, size + 1px), 2 * size)",[62,20],null],
["set","width:calc-size(calc-size(any, 10px), size * 3)",[30,20],null],
["set","width:calc-size(fit-content, round(size, 50px))",[50,20],null],
["set","width:100px;min-width:calc-size(auto, size + 200px)",[200,20],null],
["set","width:100px;min-width:calc-size(auto, 300px)",[300,20],null],
["set","width:100px;min-width:calc-size(fit-content, size + 200px)",[230,20],null],
["set","width:100px;min-width:calc-size(max-content, size + 200px)",[230,20],null],
["set","width:100px;min-width:calc-size(min-content, size * 5)",[150,20],null],
["set","width:100px;min-width:calc-size(any, 300px)",[300,20],null],
["set","width:100px;min-width:calc-size(300px, size)",[300,20],null],
["set","width:100px;min-width:calc-size(stretch, size * 0.5)",[200,20],null],
["set","width:100px;min-width:calc-size(10%, size * 3)",[120,20],null],
["set","width:100px;min-width:calc-size(any, 50%)",[200,20],null],
["set","width:100px;min-width:calc-size(fit-content, 150px)",[150,20],null],
["set","width:100px;min-width:calc-size(fit-content, 50%)",[200,20],null],
["set","width:300px;max-width:calc-size(fit-content, size + 10px)",[40,20],null],
["set","width:300px;max-width:calc-size(min-content, size * 2)",[60,20],null],
["set","width:300px;max-width:calc-size(max-content, size * 2)",[60,20],null],
["set","width:300px;max-width:calc-size(stretch, size * 0.5)",[200,20],null],
["set","width:300px;max-width:calc-size(any, 50px)",[50,20],null],
["set","width:300px;max-width:calc-size(50px, size * 2)",[100,20],null],
["set","width:300px;max-width:calc-size(fit-content, -10px)",[0,20],null],
["set","width:300px;max-width:calc-size(any, 10%)",[40,20],null],
["set","width:300px;max-width:calc-size(fit-content, 10%)",[40,20],null],
["set","width:300px;max-width:calc-size(-10px, size)",[0,20],null],
["set","width:300px;max-width:calc-size(fit-content, min(size, 5px))",[5,20],null],
["set","height:calc-size(stretch, size * 0.5)",[400,150],null],
["set","height:calc-size(auto, min(size, 5px))",[400,5],null],
["set","height:calc-size(auto, max(size, 50px))",[400,50],null],
["set","height:calc-size(auto, min(size, 1%))",[400,3],null],
["set","height:10px;min-height:calc-size(auto, size + 100px)",[400,100],null],
["set","height:10px;min-height:calc-size(auto, 100px)",[400,100],null],
["set","height:10px;min-height:calc-size(fit-content, size + 5px)",[400,25],null],
["set","height:10px;min-height:calc-size(min-content, size + 5px)",[400,25],null],
["set","height:10px;min-height:calc-size(max-content, size * 3)",[400,60],null],
["set","height:10px;min-height:calc-size(stretch, size * 0.5)",[400,150],null],
["set","height:10px;min-height:calc-size(any, 50px)",[400,50],null],
["set","height:10px;min-height:calc-size(50px, size * 2)",[400,100],null],
["set","height:10px;min-height:calc-size(10%, size)",[400,30],null],
["set","height:10px;min-height:calc-size(10%, 50px)",[400,50],null],
["set","height:10px;min-height:calc-size(fit-content, 10%)",[400,30],null],
["set","height:10px;min-height:calc-size(fit-content, size + 10%)",[400,50],null],
["set","height:10px;min-height:calc-size(any, 10%)",[400,30],null],
["set","height:10px;min-height:calc-size(auto, 10%)",[400,30],null],
["set","height:10px;min-height:min-content",[400,20],null],
["set","height:10px;min-height:fit-content",[400,20],null],
["set","height:10px;min-height:max-content",[400,20],null],
["set","min-height:calc-size(fit-content, size * 2)",[400,40],null],
["set","min-height:calc-size(any, 50px)",[400,50],null],
["set","height:100px;max-height:calc-size(fit-content, size * 2)",[400,40],null],
["set","height:100px;max-height:calc-size(min-content, size + 5px)",[400,25],null],
["set","height:100px;max-height:calc-size(max-content, size * 0.5)",[400,10],null],
["set","height:100px;max-height:calc-size(any, 50px)",[400,50],null],
["set","height:100px;max-height:calc-size(50px, size * 0.5)",[400,25],null],
["set","height:100px;max-height:calc-size(10%, size)",[400,30],null],
["set","height:100px;max-height:calc-size(10%, 50px)",[400,50],null],
["set","height:100px;max-height:calc-size(fit-content, 10%)",[400,30],null],
["set","height:100px;max-height:calc-size(fit-content, size + 10%)",[400,50],null],
["set","height:100px;max-height:calc-size(fit-content, -5px)",[400,0],null],
["set","height:100px;max-height:calc-size(-5px, size)",[400,0],null],
["set","height:100px;max-height:calc-size(any, 10%)",[400,30],null],
["set","height:100px;max-height:min-content",[400,20],null],
["set","height:100px;max-height:fit-content",[400,20],null],
["set","height:100px;max-height:max-content",[400,20],null],
["set","max-height:calc-size(fit-content, size * 0.5)",[400,10],null],
["set","box-sizing:border-box;padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)",[250,40],null],
["set","box-sizing:border-box;padding:10px;width:300px;max-width:calc-size(fit-content, size + 10px)",[60,40],null],
["set","box-sizing:border-box;padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)",[400,80],null],
["set","box-sizing:border-box;padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)",[400,80],null],
["set","padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)",[250,40],null],
["set","padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)",[400,60],null],
["set","padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)",[400,60],null],
["unset","width:calc-size(auto, min(size, 100px))",[100,20],null],
["unset","width:calc-size(auto, max(size, 500px))",[500,20],null],
["unset","width:calc-size(auto, clamp(10px, size, 100px))",[100,20],null],
["unset","width:calc-size(-10px, size)",[0,20],null],
["unset","width:calc-size(calc-size(auto, size * 0.5), size + 10px)",[210,20],null],
["unset","width:calc-size(calc-size(min-content, size + 1px), 2 * size)",[62,20],null],
["unset","width:calc-size(calc-size(any, 10px), size * 3)",[30,20],null],
["unset","width:calc-size(fit-content, round(size, 50px))",[50,20],null],
["unset","width:100px;min-width:calc-size(auto, size + 200px)",[200,20],null],
["unset","width:100px;min-width:calc-size(auto, 300px)",[300,20],null],
["unset","width:100px;min-width:calc-size(fit-content, size + 200px)",[230,20],null],
["unset","width:100px;min-width:calc-size(max-content, size + 200px)",[230,20],null],
["unset","width:100px;min-width:calc-size(min-content, size * 5)",[150,20],null],
["unset","width:100px;min-width:calc-size(any, 300px)",[300,20],null],
["unset","width:100px;min-width:calc-size(300px, size)",[300,20],null],
["unset","width:100px;min-width:calc-size(stretch, size * 0.5)",[200,20],null],
["unset","width:100px;min-width:calc-size(10%, size * 3)",[120,20],null],
["unset","width:100px;min-width:calc-size(any, 50%)",[200,20],null],
["unset","width:100px;min-width:calc-size(fit-content, 150px)",[150,20],null],
["unset","width:100px;min-width:calc-size(fit-content, 50%)",[200,20],null],
["unset","width:300px;max-width:calc-size(fit-content, size + 10px)",[40,20],null],
["unset","width:300px;max-width:calc-size(min-content, size * 2)",[60,20],null],
["unset","width:300px;max-width:calc-size(max-content, size * 2)",[60,20],null],
["unset","width:300px;max-width:calc-size(stretch, size * 0.5)",[200,20],null],
["unset","width:300px;max-width:calc-size(any, 50px)",[50,20],null],
["unset","width:300px;max-width:calc-size(50px, size * 2)",[100,20],null],
["unset","width:300px;max-width:calc-size(fit-content, -10px)",[0,20],null],
["unset","width:300px;max-width:calc-size(any, 10%)",[40,20],null],
["unset","width:300px;max-width:calc-size(fit-content, 10%)",[40,20],null],
["unset","width:300px;max-width:calc-size(-10px, size)",[0,20],null],
["unset","width:300px;max-width:calc-size(fit-content, min(size, 5px))",[5,20],null],
["unset","height:calc-size(50%, 10px)",[400,20],null],
["unset","height:calc-size(10px, 20%)",[400,0],null],
["unset","height:calc-size(auto, min(size, 5px))",[400,5],null],
["unset","height:calc-size(auto, max(size, 50px))",[400,50],null],
["unset","height:calc-size(auto, min(size, 1%))",[400,0],null],
["unset","height:10px;min-height:calc-size(auto, size + 100px)",[400,100],null],
["unset","height:10px;min-height:calc-size(auto, 100px)",[400,100],null],
["unset","height:10px;min-height:calc-size(fit-content, size + 5px)",[400,25],null],
["unset","height:10px;min-height:calc-size(min-content, size + 5px)",[400,25],null],
["unset","height:10px;min-height:calc-size(max-content, size * 3)",[400,60],null],
["unset","height:10px;min-height:calc-size(any, 50px)",[400,50],null],
["unset","height:10px;min-height:calc-size(50px, size * 2)",[400,100],null],
["unset","height:10px;min-height:calc-size(10%, 50px)",[400,50],null],
["unset","height:10px;min-height:calc-size(fit-content, size + 10%)",[400,20],null],
["unset","height:10px;min-height:min-content",[400,20],null],
["unset","height:10px;min-height:fit-content",[400,20],null],
["unset","height:10px;min-height:max-content",[400,20],null],
["unset","min-height:calc-size(fit-content, size * 2)",[400,40],null],
["unset","min-height:calc-size(any, 50px)",[400,50],null],
["unset","height:100px;max-height:calc-size(fit-content, size * 2)",[400,40],null],
["unset","height:100px;max-height:calc-size(min-content, size + 5px)",[400,25],null],
["unset","height:100px;max-height:calc-size(max-content, size * 0.5)",[400,10],null],
["unset","height:100px;max-height:calc-size(any, 50px)",[400,50],null],
["unset","height:100px;max-height:calc-size(50px, size * 0.5)",[400,25],null],
["unset","height:100px;max-height:calc-size(fit-content, 10%)",[400,0],null],
["unset","height:100px;max-height:calc-size(fit-content, size + 10%)",[400,20],null],
["unset","height:100px;max-height:calc-size(fit-content, -5px)",[400,0],null],
["unset","height:100px;max-height:calc-size(-5px, size)",[400,0],null],
["unset","height:100px;max-height:calc-size(any, 10%)",[400,0],null],
["unset","height:100px;max-height:min-content",[400,20],null],
["unset","height:100px;max-height:fit-content",[400,20],null],
["unset","height:100px;max-height:max-content",[400,20],null],
["unset","max-height:calc-size(fit-content, size * 0.5)",[400,10],null],
["unset","box-sizing:border-box;padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)",[250,40],null],
["unset","box-sizing:border-box;padding:10px;width:300px;max-width:calc-size(fit-content, size + 10px)",[60,40],null],
["unset","box-sizing:border-box;padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)",[400,80],null],
["unset","box-sizing:border-box;padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)",[400,80],null],
["unset","padding:10px;width:100px;min-width:calc-size(fit-content, size + 200px)",[250,40],null],
["unset","padding:10px;height:100px;max-height:calc-size(fit-content, size * 2)",[400,60],null],
["unset","padding:10px;height:10px;min-height:calc-size(fit-content, size * 2)",[400,60],null],
["set","width:300px;max-width:calc-size(min-content, size + 1px)",[31,40],null],
["set","width:300px;max-width:calc-size(max-content, size + 1px)",[61,20],null],
["set","width:300px;max-width:calc-size(fit-content, size + 1px)",[61,20],null],
["absolute","width:calc-size(auto, size + 7px)",[67,20],null],
["absolute","width:calc-size(fit-content, size * 2)",[120,20],null],
["absolute","width:calc-size(min-content, size + 7px)",[37,40],null],
["absolute","width:calc-size(max-content, size + 7px)",[67,20],null],
["absolute","width:calc-size(stretch, size * 0.5)",[200,20],null],
["absolute","width:calc-size(any, 70px)",[70,20],null],
["absolute","width:calc-size(auto, 70px)",[70,20],null],
["absolute","width:calc-size(auto, min(size, 45px))",[45,40],null],
["absolute","left:0;right:0;width:calc-size(auto, size * 0.5)",[200,20],null],
["absolute","top:0;bottom:0;height:calc-size(auto, size * 0.5)",[60,150],null],
["absolute","min-width:calc-size(auto, 70px)",[70,20],null],
["absolute","min-width:calc-size(auto, size + 70px)",[70,20],null],
["absolute","min-width:calc-size(fit-content, size + 7px)",[67,20],null],
["absolute","min-width:calc-size(max-content, size + 7px)",[67,20],null],
["absolute","min-width:calc-size(any, 170px)",[170,20],null],
["absolute","max-width:calc-size(min-content, size + 7px)",[37,40],null],
["absolute","max-width:calc-size(fit-content, size - 7px)",[53,40],null],
["absolute","max-width:calc-size(any, 7px)",[7,40],null],
["absolute","min-height:calc-size(fit-content, size * 2)",[60,40],null],
["absolute","max-height:calc-size(fit-content, size * 0.5)",[60,10],null],
["absolute","height:100px;max-height:calc-size(fit-content, size * 0.5)",[60,10],null],
["absolute","height:5px;min-height:calc-size(fit-content, size * 2)",[60,40],null],
["float","width:calc-size(auto, size + 7px)",[74,20],[67,20]],
["float","width:calc-size(stretch, size * 0.5)",[15,40],[30,40]],
["float","width:calc-size(any, 70px)",[70,20],[70,20]],
["float","width:calc-size(auto, 70px)",[70,20],[70,20]],
["float","width:calc-size(auto, min(size, 45px))",[45,40],[45,40]],
["float","left:0;right:0;width:calc-size(auto, size * 0.5)",[15,40],[30,40]],
["float","min-width:calc-size(auto, 70px)",[70,20],[70,20]],
["float","min-width:calc-size(auto, size + 70px)",[70,20],[70,20]],
["float","min-width:calc-size(fit-content, size + 7px)",[67,20],[67,20]],
["float","min-width:calc-size(max-content, size + 7px)",[67,20],[67,20]],
["float","min-width:calc-size(any, 170px)",[170,20],[170,20]],
["float","max-width:calc-size(min-content, size + 7px)",[37,40],[37,40]],
["float","max-width:calc-size(fit-content, size - 7px)",[46,40],[53,40]],
["float","max-width:calc-size(any, 7px)",[7,40],[7,40]],
["float","min-height:calc-size(fit-content, size * 2)",[60,40],[60,40]],
["float","max-height:calc-size(fit-content, size * 0.5)",[60,10],[60,10]],
["float","height:100px;max-height:calc-size(fit-content, size * 0.5)",[60,10],[60,10]],
["float","height:5px;min-height:calc-size(fit-content, size * 2)",[60,40],[60,40]],
["inline-block","width:calc-size(auto, size + 7px)",[67,20],null],
["inline-block","width:calc-size(fit-content, size * 2)",[120,20],null],
["inline-block","width:calc-size(min-content, size + 7px)",[37,40],null],
["inline-block","width:calc-size(max-content, size + 7px)",[67,20],null],
["inline-block","width:calc-size(stretch, size * 0.5)",[200,20],null],
["inline-block","width:calc-size(any, 70px)",[70,20],null],
["inline-block","width:calc-size(auto, 70px)",[70,20],null],
["inline-block","width:calc-size(auto, min(size, 45px))",[45,40],null],
["inline-block","left:0;right:0;width:calc-size(auto, size * 0.5)",[30,40],null],
["inline-block","min-width:calc-size(auto, 70px)",[70,20],null],
["inline-block","min-width:calc-size(auto, size + 70px)",[70,20],null],
["inline-block","min-width:calc-size(fit-content, size + 7px)",[67,20],null],
["inline-block","min-width:calc-size(max-content, size + 7px)",[67,20],null],
["inline-block","min-width:calc-size(any, 170px)",[170,20],null],
["inline-block","max-width:calc-size(min-content, size + 7px)",[37,40],null],
["inline-block","max-width:calc-size(fit-content, size - 7px)",[53,40],null],
["inline-block","max-width:calc-size(any, 7px)",[7,40],null],
["inline-block","min-height:calc-size(fit-content, size * 2)",[60,40],null],
["inline-block","max-height:calc-size(fit-content, size * 0.5)",[60,10],null],
["inline-block","height:100px;max-height:calc-size(fit-content, size * 0.5)",[60,10],null],
["inline-block","height:5px;min-height:calc-size(fit-content, size * 2)",[60,40],null],
["flex","min-width:calc-size(auto, size + 7px)",[37,40],null],
["flex","min-width:calc-size(auto, size * 2)",[60,20],null],
["flex","min-width:calc-size(auto, 7px)",[20,40],null],
["flex","min-width:calc-size(min-content, size + 7px)",[37,40],null],
["flex","min-width:calc-size(fit-content, size + 7px)",[67,20],null],
["flex","min-width:calc-size(max-content, size + 7px)",[67,20],null],
["flex","min-width:calc-size(any, 70px)",[70,20],null],
["flex","flex-shrink:0;min-width:calc-size(fit-content, size + 7px)",[67,20],null],
["flex","flex-shrink:0;width:calc-size(auto, size + 7px)",[67,20],null],
["flex","flex-shrink:0;width:calc-size(fit-content, size + 7px)",[67,20],null],
["flex","flex-shrink:0;width:calc-size(max-content, size + 7px)",[67,20],null],
["flex","flex-shrink:0;width:calc-size(auto, min(size, 45px))",[45,40],null],
["flex","flex-shrink:0;flex-basis:calc-size(auto, size + 7px)",[67,20],null],
["flex","flex-shrink:0;flex-basis:calc-size(content, size + 7px)",[67,20],null],
["flex","flex-shrink:0;flex-basis:calc-size(fit-content, size + 7px)",[67,20],null],
["flex","flex-shrink:0;flex-basis:calc-size(min-content, size + 7px)",[37,40],null],
["flex","flex-shrink:0;flex-basis:calc-size(max-content, size + 7px)",[67,20],null],
["flex","flex-shrink:0;flex-basis:calc-size(any, 70px)",[70,20],null],
["flex","flex-shrink:0;flex-basis:calc-size(70px, size * 2)",[140,20],null],
["flex","flex-shrink:0;flex-basis:calc-size(auto, size + 7px);width:100px",[107,20],null],
["flex","flex-shrink:0;flex-basis:calc-size(content, size + 7px);width:100px",[67,20],null],
["flex","flex-shrink:0;max-width:calc-size(fit-content, size - 5px)",[55,40],null],
["column","min-height:calc-size(auto, size + 7px)",[400,27],null],
["column","min-height:calc-size(fit-content, size + 7px)",[400,27],null],
["column","max-height:calc-size(fit-content, size - 7px)",[400,13],null],
["column","flex-basis:calc-size(auto, size + 7px)",[400,27],null],
["column","flex-basis:calc-size(content, size * 2)",[400,40],null],
["column","flex-basis:calc-size(any, 70px)",[400,70],null],
["column","flex-basis:calc-size(70px, size * 2)",[400,140],null],
["column","width:calc-size(auto, size * 0.5)",[200,20],null],
["column","width:calc-size(stretch, size * 0.5)",[200,20],null],
["column","width:calc-size(max-content, size * 0.5)",[30,40],null],
["column","width:calc-size(fit-content, size + 7px)",[67,20],null],
["column","max-width:calc-size(fit-content, size - 7px)",[53,40],null],
["grid","width:calc-size(max-content, size + 7px)",[67,20],null],
["grid","width:calc-size(min-content, size + 7px)",[37,40],null],
["grid","width:calc-size(auto, size + 7px)",[74,20],null],
["grid","min-width:calc-size(max-content, size + 7px)",[67,20],null],
["grid","min-width:calc-size(auto, 70px)",[70,20],null],
["grid","min-width:calc-size(any, 170px)",[170,20],null],
["grid","max-width:calc-size(min-content, size + 7px)",[37,40],null],
["grid","max-width:calc-size(any, 7px)",[7,40],null],
["grid","height:calc-size(auto, size * 2)",[60,80],null],
["grid","min-height:calc-size(fit-content, size * 2)",[60,40],null],
["grid","max-height:calc-size(fit-content, size * 0.5)",[60,10],null],
["in an item","width:calc-size(min-content, size + 7px)",[37,40],[37,40]],
["in an item","width:calc-size(max-content, size + 7px)",[67,20],[67,20]],
["in an item","width:calc-size(auto, size + 7px)",[44,40],[37,40]],
["in an item","width:calc-size(any, 70px)",[70,20],[70,20]],
["in an item","min-width:calc-size(min-content, size + 7px)",[37,40],[37,40]],
["in an item","max-width:calc-size(min-content, size * 0.5)",[15,40],[15,40]]
]`);
