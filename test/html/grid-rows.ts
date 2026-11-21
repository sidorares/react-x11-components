// Where each piece of each grid item, and of each grid, is in columns, as
// Chromium 157 has it, from the top left of its multicol container:
// `scripts/conformance/grid-rows.ts` writes this file, and nothing in it is
// written by hand. The rows are broken an item at a time.

export const GRID_ROWS_DOCUMENT = `<style>body{margin:0}.case{position:relative;margin-bottom:20px}.case i{display:inline-block;width:20px;vertical-align:top}</style>
<div class="case" id="c0" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:60px"><div style="height:10px"></div><div id="c0g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c0i0" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div></div><div id="c0i1" style="line-height:0"><div style="height:10px"></div><div style="height:20px"></div></div><div id="c0i2" style="line-height:0"><div><i style="height:50px"></i></div></div><div id="c0i3" style="line-height:0"><div style="height:10px"></div></div><div id="c0i4" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:10px"></i></div></div><div id="c0i5" style="line-height:0;align-self:start"><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c1" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:120px"><div id="c1g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c1i0" style="line-height:0"><div><i style="height:40px"></i></div></div><div id="c1i1" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c2" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:80px"><div style="height:50px"></div><div id="c2g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c2i0" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div></div><div id="c2i1" style="line-height:0;align-self:end"><div style="height:50px"></div><div style="height:40px"></div></div></div></div>
<div class="case" id="c3" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:60px"><div style="height:50px"></div><div id="c3g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c3i0" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div></div><div id="c3i1" style="line-height:0"><div><i style="height:40px"></i></div></div><div id="c3i2" style="line-height:0"><div style="height:30px"></div><div style="height:50px"></div><div style="height:30px"></div></div><div id="c3i3" style="line-height:0;align-self:end"><div style="height:20px"></div><div style="height:20px"></div></div><div id="c3i4" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div><div><i style="height:10px"></i></div></div><div id="c3i5" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div><div><i style="height:20px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c4" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:120px"><div style="height:50px"></div><div id="c4g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c4i0" style="line-height:0"><div><i style="height:20px"></i></div></div><div id="c4i1" style="line-height:0"><div style="height:40px"></div><div style="height:40px"></div><div style="height:50px"></div></div><div id="c4i2" style="line-height:0;align-self:end"><div style="height:30px"></div><div style="height:20px"></div><div style="height:30px"></div></div></div></div>
<div class="case" id="c5" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:120px"><div style="height:10px"></div><div id="c5g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c5i0" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:10px"></i></div></div><div id="c5i1" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c5i2" style="line-height:0;align-self:start"><div style="height:10px"></div></div></div></div>
<div class="case" id="c6" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:80px"><div style="height:30px"></div><div id="c6g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c6i0" style="line-height:0;align-self:end"><div style="height:40px"></div><div style="height:30px"></div></div><div id="c6i1" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:10px"></i></div></div></div></div>
<div class="case" id="c7" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:120px"><div id="c7g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c7i0" style="line-height:0;align-self:start"><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div></div><div id="c7i1" style="line-height:0"><div style="height:30px"></div><div style="height:20px"></div></div><div id="c7i2" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c8" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:80px"><div style="height:30px"></div><div id="c8g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c8i0" style="line-height:0"><div style="height:40px"></div><div style="height:50px"></div></div><div id="c8i1" style="line-height:0"><div><i style="height:40px"></i></div></div><div id="c8i2" style="line-height:0;align-self:end"><div style="height:20px"></div></div><div id="c8i3" style="line-height:0"><div style="height:40px"></div><div style="height:50px"></div><div style="height:50px"></div></div><div id="c8i4" style="line-height:0"><div style="height:30px"></div></div><div id="c8i5" style="line-height:0"><div style="height:40px"></div><div style="height:40px"></div><div style="height:40px"></div></div></div></div>
<div class="case" id="c9" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:80px"><div style="height:30px"></div><div id="c9g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c9i0" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:50px"></i></div></div><div id="c9i1" style="line-height:0"><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c10" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:120px"><div id="c10g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c10i0" style="line-height:0"><div style="height:40px"></div><div style="height:20px"></div><div style="height:50px"></div></div><div id="c10i1" style="line-height:0;align-self:start"><div style="height:10px"></div></div><div id="c10i2" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div></div><div id="c10i3" style="line-height:0"><div><i style="height:40px"></i></div></div><div id="c10i4" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div><div><i style="height:10px"></i></div></div><div id="c10i5" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c11" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:80px"><div style="height:30px"></div><div id="c11g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c11i0" style="line-height:0"><div style="height:10px"></div><div style="height:10px"></div><div style="height:40px"></div></div><div id="c11i1" style="line-height:0;align-self:start"><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div></div><div id="c11i2" style="line-height:0"><div style="height:20px"></div><div style="height:30px"></div><div style="height:10px"></div></div></div></div>
<div class="case" id="c12" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:80px"><div id="c12g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c12i0" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div><div id="c12i1" style="line-height:0;align-self:start"><div><i style="height:40px"></i></div><div><i style="height:10px"></i></div></div><div id="c12i2" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div></div><div id="c12i3" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c13" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:60px"><div style="height:50px"></div><div id="c13g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c13i0" style="line-height:0;align-self:start"><div style="height:50px"></div><div style="height:40px"></div><div style="height:40px"></div></div><div id="c13i1" style="line-height:0;align-self:end"><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div></div><div id="c13i2" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div></div><div id="c13i3" style="line-height:0;align-self:end"><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c14" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:60px"><div style="height:30px"></div><div id="c14g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c14i0" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div><div><i style="height:40px"></i></div></div><div id="c14i1" style="line-height:0"><div style="height:40px"></div></div><div id="c14i2" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:50px"></i></div></div><div id="c14i3" style="line-height:0;align-self:start"><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div><div><i style="height:10px"></i></div></div><div id="c14i4" style="line-height:0"><div style="height:20px"></div><div style="height:10px"></div><div style="height:30px"></div></div><div id="c14i5" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c15" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:100px"><div id="c15g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c15i0" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div></div><div id="c15i1" style="line-height:0;align-self:end"><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div></div><div id="c15i2" style="line-height:0;align-self:end"><div style="height:50px"></div><div style="height:50px"></div><div style="height:40px"></div></div><div id="c15i3" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c16" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:120px"><div style="height:50px"></div><div id="c16g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c16i0" style="line-height:0"><div><i style="height:40px"></i></div></div><div id="c16i1" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div></div><div id="c16i2" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div></div><div id="c16i3" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div><div><i style="height:30px"></i></div></div><div id="c16i4" style="line-height:0;align-self:start"><div style="height:40px"></div><div style="height:20px"></div></div><div id="c16i5" style="line-height:0"><div style="height:30px"></div><div style="height:40px"></div><div style="height:20px"></div></div></div></div>
<div class="case" id="c17" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:60px"><div style="height:30px"></div><div id="c17g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c17i0" style="line-height:0"><div><i style="height:20px"></i></div></div><div id="c17i1" style="line-height:0;align-self:start"><div style="height:40px"></div><div style="height:50px"></div></div></div></div>
<div class="case" id="c18" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:60px"><div id="c18g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c18i0" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c18i1" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div></div></div></div>
<div class="case" id="c19" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:120px"><div style="height:50px"></div><div id="c19g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c19i0" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div></div><div id="c19i1" style="line-height:0;align-self:end"><div style="height:20px"></div></div><div id="c19i2" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div></div><div id="c19i3" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:20px"></i></div></div><div id="c19i4" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:10px"></i></div></div><div id="c19i5" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c20" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:100px"><div style="height:50px"></div><div id="c20g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c20i0" style="line-height:0;align-self:start"><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div></div><div id="c20i1" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div><div id="c20i2" style="line-height:0;align-self:end"><div style="height:40px"></div><div style="height:50px"></div><div style="height:10px"></div></div><div id="c20i3" style="line-height:0;align-self:end"><div style="height:30px"></div></div><div id="c20i4" style="line-height:0;align-self:end"><div style="height:30px"></div><div style="height:50px"></div></div><div id="c20i5" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c21" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:100px"><div style="height:50px"></div><div id="c21g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c21i0" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div><div><i style="height:20px"></i></div></div><div id="c21i1" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div></div><div id="c21i2" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div></div><div id="c21i3" style="line-height:0"><div style="height:40px"></div><div style="height:10px"></div><div style="height:10px"></div></div><div id="c21i4" style="line-height:0"><div><i style="height:30px"></i></div></div><div id="c21i5" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c22" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:100px"><div id="c22g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c22i0" style="line-height:0"><div style="height:10px"></div><div style="height:20px"></div><div style="height:10px"></div></div><div id="c22i1" style="line-height:0"><div style="height:10px"></div><div style="height:40px"></div><div style="height:50px"></div></div></div></div>
<div class="case" id="c23" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:120px"><div id="c23g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c23i0" style="line-height:0;align-self:start"><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div></div><div id="c23i1" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c24" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:120px"><div style="height:30px"></div><div id="c24g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c24i0" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div></div><div id="c24i1" style="line-height:0;align-self:start"><div style="height:40px"></div><div style="height:30px"></div><div style="height:20px"></div></div></div></div>
<div class="case" id="c25" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:60px"><div id="c25g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c25i0" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:50px"></i></div></div><div id="c25i1" style="line-height:0"><div style="height:40px"></div><div style="height:50px"></div><div style="height:30px"></div></div></div></div>
<div class="case" id="c26" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:120px"><div style="height:10px"></div><div id="c26g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c26i0" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div><div><i style="height:30px"></i></div></div><div id="c26i1" style="line-height:0"><div style="height:20px"></div><div style="height:50px"></div><div style="height:20px"></div></div></div></div>
<div class="case" id="c27" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:100px"><div id="c27g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c27i0" style="line-height:0;align-self:start"><div style="height:10px"></div><div style="height:30px"></div><div style="height:20px"></div></div><div id="c27i1" style="line-height:0"><div><i style="height:50px"></i></div></div><div id="c27i2" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:30px"></i></div></div><div id="c27i3" style="line-height:0;align-self:start"><div style="height:10px"></div><div style="height:10px"></div></div><div id="c27i4" style="line-height:0"><div style="height:30px"></div><div style="height:30px"></div><div style="height:40px"></div></div><div id="c27i5" style="line-height:0;align-self:end"><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c28" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:60px"><div id="c28g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c28i0" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div></div><div id="c28i1" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div><div id="c28i2" style="line-height:0"><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c29" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:60px"><div id="c29g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c29i0" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div><div id="c29i1" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div></div><div id="c29i2" style="line-height:0;align-self:start"><div><i style="height:30px"></i></div><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div></div><div id="c29i3" style="line-height:0;align-self:start"><div><i style="height:30px"></i></div><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c30" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:100px"><div style="height:50px"></div><div id="c30g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c30i0" style="line-height:0;align-self:start"><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div></div><div id="c30i1" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:30px"></i></div><div><i style="height:40px"></i></div></div><div id="c30i2" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c30i3" style="line-height:0;align-self:end"><div><i style="height:40px"></i></div><div><i style="height:10px"></i></div></div></div></div>
<div class="case" id="c31" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:60px"><div style="height:10px"></div><div id="c31g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c31i0" style="line-height:0;align-self:end"><div><i style="height:30px"></i></div><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div></div><div id="c31i1" style="line-height:0"><div><i style="height:30px"></i></div></div><div id="c31i2" style="line-height:0;align-self:end"><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c32" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:60px"><div id="c32g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c32i0" style="line-height:0;align-self:start"><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div></div><div id="c32i1" style="line-height:0"><div style="height:50px"></div><div style="height:10px"></div></div><div id="c32i2" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c32i3" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c33" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:60px"><div style="height:30px"></div><div id="c33g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c33i0" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div></div><div id="c33i1" style="line-height:0"><div style="height:30px"></div><div style="height:30px"></div></div><div id="c33i2" style="line-height:0;align-self:end"><div style="height:50px"></div></div><div id="c33i3" style="line-height:0;align-self:start"><div style="height:40px"></div></div></div></div>
<div class="case" id="c34" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:80px"><div style="height:30px"></div><div id="c34g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c34i0" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div><div><i style="height:10px"></i></div></div><div id="c34i1" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c35" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:100px"><div style="height:10px"></div><div id="c35g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c35i0" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div></div><div id="c35i1" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:10px"></i></div></div><div id="c35i2" style="line-height:0"><div style="height:20px"></div></div><div id="c35i3" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:10px"></i></div></div><div id="c35i4" style="line-height:0"><div style="height:20px"></div><div style="height:30px"></div><div style="height:40px"></div></div><div id="c35i5" style="line-height:0"><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c36" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:100px"><div style="height:50px"></div><div id="c36g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c36i0" style="line-height:0"><div style="height:20px"></div><div style="height:30px"></div></div><div id="c36i1" style="line-height:0;align-self:start"><div style="height:40px"></div><div style="height:10px"></div><div style="height:20px"></div></div><div id="c36i2" style="line-height:0;align-self:end"><div style="height:10px"></div></div><div id="c36i3" style="line-height:0;align-self:start"><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c37" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:120px"><div style="height:30px"></div><div id="c37g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c37i0" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div><div><i style="height:50px"></i></div></div><div id="c37i1" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div></div><div id="c37i2" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div><div id="c37i3" style="line-height:0"><div><i style="height:20px"></i></div></div><div id="c37i4" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div><div id="c37i5" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c38" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:100px"><div style="height:10px"></div><div id="c38g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c38i0" style="line-height:0"><div style="height:50px"></div><div style="height:40px"></div></div><div id="c38i1" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div><div><i style="height:50px"></i></div></div><div id="c38i2" style="line-height:0"><div style="height:50px"></div><div style="height:10px"></div><div style="height:10px"></div></div><div id="c38i3" style="line-height:0"><div style="height:30px"></div><div style="height:30px"></div></div><div id="c38i4" style="line-height:0"><div style="height:40px"></div><div style="height:40px"></div><div style="height:30px"></div></div><div id="c38i5" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c39" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:80px"><div style="height:10px"></div><div id="c39g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c39i0" style="line-height:0"><div style="height:50px"></div><div style="height:30px"></div></div><div id="c39i1" style="line-height:0;align-self:end"><div style="height:30px"></div></div><div id="c39i2" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:40px"></i></div><div><i style="height:10px"></i></div></div><div id="c39i3" style="line-height:0;align-self:end"><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c40" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:60px"><div style="height:30px"></div><div id="c40g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c40i0" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div></div><div id="c40i1" style="line-height:0;align-self:end"><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c41" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:60px"><div style="height:30px"></div><div id="c41g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c41i0" style="line-height:0"><div style="height:40px"></div></div><div id="c41i1" style="line-height:0"><div style="height:30px"></div></div><div id="c41i2" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c42" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:120px"><div style="height:30px"></div><div id="c42g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c42i0" style="line-height:0"><div><i style="height:30px"></i></div></div><div id="c42i1" style="line-height:0;align-self:start"><div style="height:30px"></div></div><div id="c42i2" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div><div><i style="height:50px"></i></div></div><div id="c42i3" style="line-height:0"><div style="height:30px"></div><div style="height:40px"></div><div style="height:10px"></div></div></div></div>
<div class="case" id="c43" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:120px"><div style="height:10px"></div><div id="c43g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c43i0" style="line-height:0"><div style="height:30px"></div><div style="height:40px"></div></div><div id="c43i1" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div><div id="c43i2" style="line-height:0;align-self:end"><div style="height:30px"></div><div style="height:30px"></div><div style="height:10px"></div></div><div id="c43i3" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c43i4" style="line-height:0"><div><i style="height:30px"></i></div></div><div id="c43i5" style="line-height:0"><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c44" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:120px"><div style="height:10px"></div><div id="c44g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c44i0" style="line-height:0"><div style="height:50px"></div><div style="height:30px"></div><div style="height:30px"></div></div><div id="c44i1" style="line-height:0"><div style="height:30px"></div></div></div></div>
<div class="case" id="c45" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:60px"><div id="c45g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c45i0" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div><div id="c45i1" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c45i2" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div><div><i style="height:10px"></i></div></div><div id="c45i3" style="line-height:0"><div><i style="height:40px"></i></div></div><div id="c45i4" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div><div><i style="height:30px"></i></div></div><div id="c45i5" style="line-height:0"><div style="height:40px"></div><div style="height:40px"></div></div></div></div>
<div class="case" id="c46" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:60px"><div style="height:10px"></div><div id="c46g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c46i0" style="line-height:0;align-self:end"><div style="height:30px"></div></div><div id="c46i1" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div></div><div id="c46i2" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c47" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:80px"><div id="c47g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c47i0" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c47i1" style="line-height:0;align-self:start"><div style="height:40px"></div></div></div></div>
<div class="case" id="c48" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:60px"><div style="height:50px"></div><div id="c48g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c48i0" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div><div><i style="height:20px"></i></div></div><div id="c48i1" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div><div><i style="height:10px"></i></div></div><div id="c48i2" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c49" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:60px"><div id="c49g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c49i0" style="line-height:0"><div style="height:50px"></div></div><div id="c49i1" style="line-height:0;align-self:start"><div style="height:20px"></div><div style="height:40px"></div></div></div></div>
<div class="case" id="c50" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:100px"><div style="height:50px"></div><div id="c50g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c50i0" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c50i1" style="line-height:0"><div style="height:40px"></div><div style="height:50px"></div></div><div id="c50i2" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div><div><i style="height:50px"></i></div></div><div id="c50i3" style="line-height:0"><div style="height:40px"></div><div style="height:50px"></div></div></div></div>
<div class="case" id="c51" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:60px"><div style="height:50px"></div><div id="c51g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c51i0" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c51i1" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div><div><i style="height:40px"></i></div></div><div id="c51i2" style="line-height:0;align-self:start"><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c52" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:100px"><div id="c52g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c52i0" style="line-height:0;align-self:end"><div style="height:50px"></div></div><div id="c52i1" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div></div><div id="c52i2" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div></div><div id="c52i3" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div></div><div id="c52i4" style="line-height:0"><div style="height:10px"></div><div style="height:40px"></div><div style="height:10px"></div></div><div id="c52i5" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c53" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:100px"><div id="c53g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c53i0" style="line-height:0;align-self:end"><div style="height:50px"></div><div style="height:30px"></div></div><div id="c53i1" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c54" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:80px"><div id="c54g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c54i0" style="line-height:0"><div style="height:10px"></div><div style="height:30px"></div></div><div id="c54i1" style="line-height:0;align-self:start"><div><i style="height:40px"></i></div></div><div id="c54i2" style="line-height:0"><div style="height:20px"></div></div><div id="c54i3" style="line-height:0"><div><i style="height:40px"></i></div></div><div id="c54i4" style="line-height:0"><div><i style="height:20px"></i></div></div><div id="c54i5" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c55" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:60px"><div style="height:10px"></div><div id="c55g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c55i0" style="line-height:0"><div style="height:30px"></div><div style="height:50px"></div></div><div id="c55i1" style="line-height:0"><div style="height:10px"></div></div><div id="c55i2" style="line-height:0"><div style="height:30px"></div><div style="height:10px"></div></div></div></div>
<div class="case" id="c56" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:60px"><div id="c56g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c56i0" style="line-height:0"><div style="height:30px"></div><div style="height:40px"></div></div><div id="c56i1" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div></div><div id="c56i2" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div></div><div id="c56i3" style="line-height:0"><div style="height:20px"></div><div style="height:40px"></div><div style="height:20px"></div></div><div id="c56i4" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div></div><div id="c56i5" style="line-height:0"><div style="height:50px"></div></div></div></div>
<div class="case" id="c57" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:120px"><div style="height:30px"></div><div id="c57g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c57i0" style="line-height:0"><div style="height:10px"></div><div style="height:40px"></div><div style="height:30px"></div></div><div id="c57i1" style="line-height:0;align-self:end"><div style="height:30px"></div><div style="height:20px"></div></div></div></div>
<div class="case" id="c58" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:100px"><div style="height:10px"></div><div id="c58g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c58i0" style="line-height:0"><div style="height:20px"></div><div style="height:40px"></div></div><div id="c58i1" style="line-height:0;align-self:end"><div><i style="height:30px"></i></div><div><i style="height:10px"></i></div></div><div id="c58i2" style="line-height:0"><div style="height:40px"></div><div style="height:20px"></div><div style="height:40px"></div></div><div id="c58i3" style="line-height:0"><div style="height:20px"></div><div style="height:40px"></div></div><div id="c58i4" style="line-height:0"><div style="height:50px"></div><div style="height:20px"></div><div style="height:10px"></div></div><div id="c58i5" style="line-height:0"><div style="height:10px"></div><div style="height:20px"></div></div></div></div>
<div class="case" id="c59" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:80px"><div id="c59g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c59i0" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div></div><div id="c59i1" style="line-height:0;align-self:end"><div style="height:20px"></div><div style="height:50px"></div></div><div id="c59i2" style="line-height:0"><div style="height:30px"></div></div><div id="c59i3" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div></div><div id="c59i4" style="line-height:0;align-self:end"><div style="height:40px"></div></div><div id="c59i5" style="line-height:0"><div style="height:40px"></div><div style="height:40px"></div><div style="height:50px"></div></div></div></div>
<div class="case" id="c60" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:80px"><div id="c60g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c60i0" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div><div id="c60i1" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c61" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:80px"><div id="c61g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c61i0" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div></div><div id="c61i1" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div></div><div id="c61i2" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c61i3" style="line-height:0"><div style="height:50px"></div></div><div id="c61i4" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div></div><div id="c61i5" style="line-height:0;align-self:end"><div style="height:50px"></div><div style="height:10px"></div></div></div></div>
<div class="case" id="c62" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:100px"><div style="height:30px"></div><div id="c62g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c62i0" style="line-height:0"><div style="height:40px"></div><div style="height:10px"></div></div><div id="c62i1" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c63" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:80px"><div style="height:30px"></div><div id="c63g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c63i0" style="line-height:0"><div><i style="height:20px"></i></div></div><div id="c63i1" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div></div><div id="c63i2" style="line-height:0"><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c64" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:120px"><div id="c64g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c64i0" style="line-height:0"><div style="height:30px"></div><div style="height:10px"></div><div style="height:50px"></div></div><div id="c64i1" style="line-height:0;align-self:start"><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c65" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:60px"><div style="height:10px"></div><div id="c65g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c65i0" style="line-height:0"><div><i style="height:20px"></i></div></div><div id="c65i1" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c66" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:120px"><div id="c66g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c66i0" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:40px"></i></div></div><div id="c66i1" style="line-height:0"><div style="height:20px"></div><div style="height:10px"></div><div style="height:50px"></div></div><div id="c66i2" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:50px"></i></div><div><i style="height:20px"></i></div></div><div id="c66i3" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div><div><i style="height:50px"></i></div><div><i style="height:30px"></i></div></div><div id="c66i4" style="line-height:0"><div style="height:40px"></div><div style="height:10px"></div></div><div id="c66i5" style="line-height:0"><div style="height:50px"></div></div></div></div>
<div class="case" id="c67" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:60px"><div style="height:50px"></div><div id="c67g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c67i0" style="line-height:0"><div style="height:40px"></div><div style="height:50px"></div></div><div id="c67i1" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div><div><i style="height:20px"></i></div></div><div id="c67i2" style="line-height:0"><div style="height:30px"></div><div style="height:10px"></div></div><div id="c67i3" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c68" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:100px"><div style="height:10px"></div><div id="c68g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c68i0" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div></div><div id="c68i1" style="line-height:0"><div style="height:50px"></div><div style="height:40px"></div><div style="height:40px"></div></div><div id="c68i2" style="line-height:0"><div style="height:20px"></div><div style="height:50px"></div><div style="height:50px"></div></div></div></div>
<div class="case" id="c69" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:100px"><div style="height:10px"></div><div id="c69g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c69i0" style="line-height:0"><div><i style="height:30px"></i></div></div><div id="c69i1" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:10px"></i></div></div><div id="c69i2" style="line-height:0"><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c70" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:60px"><div style="height:10px"></div><div id="c70g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c70i0" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div></div><div id="c70i1" style="line-height:0;align-self:start"><div style="height:50px"></div></div><div id="c70i2" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c71" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:60px"><div id="c71g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c71i0" style="line-height:0"><div><i style="height:50px"></i></div></div><div id="c71i1" style="line-height:0;align-self:start"><div style="height:50px"></div></div><div id="c71i2" style="line-height:0"><div style="height:10px"></div><div style="height:30px"></div></div><div id="c71i3" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c72" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:120px"><div style="height:10px"></div><div id="c72g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c72i0" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div><div id="c72i1" style="line-height:0"><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c73" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:100px"><div id="c73g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c73i0" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div></div><div id="c73i1" style="line-height:0;align-self:start"><div style="height:30px"></div></div><div id="c73i2" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div><div><i style="height:30px"></i></div></div><div id="c73i3" style="line-height:0"><div style="height:30px"></div><div style="height:50px"></div><div style="height:20px"></div></div></div></div>
<div class="case" id="c74" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:100px"><div id="c74g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c74i0" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:10px"></i></div></div><div id="c74i1" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c75" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:100px"><div style="height:10px"></div><div id="c75g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c75i0" style="line-height:0"><div style="height:50px"></div><div style="height:20px"></div></div><div id="c75i1" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div></div></div></div>
<div class="case" id="c76" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:100px"><div id="c76g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c76i0" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:50px"></i></div><div><i style="height:30px"></i></div></div><div id="c76i1" style="line-height:0;align-self:end"><div style="height:30px"></div><div style="height:10px"></div></div><div id="c76i2" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c77" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:120px"><div style="height:10px"></div><div id="c77g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c77i0" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div><div><i style="height:30px"></i></div></div><div id="c77i1" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div><div><i style="height:10px"></i></div></div><div id="c77i2" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div><div id="c77i3" style="line-height:0;align-self:end"><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div></div><div id="c77i4" style="line-height:0"><div><i style="height:40px"></i></div></div><div id="c77i5" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c78" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:80px"><div style="height:10px"></div><div id="c78g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c78i0" style="line-height:0"><div style="height:30px"></div><div style="height:50px"></div><div style="height:50px"></div></div><div id="c78i1" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div></div><div id="c78i2" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c79" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:80px"><div id="c79g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c79i0" style="line-height:0"><div><i style="height:30px"></i></div></div><div id="c79i1" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div></div><div id="c79i2" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div></div><div id="c79i3" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div></div><div id="c79i4" style="line-height:0;align-self:end"><div><i style="height:30px"></i></div></div><div id="c79i5" style="line-height:0;align-self:start"><div style="height:50px"></div><div style="height:10px"></div></div></div></div>
<div class="case" id="c80" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:120px"><div id="c80g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c80i0" style="line-height:0"><div style="height:20px"></div><div style="height:20px"></div><div style="height:50px"></div></div><div id="c80i1" style="line-height:0"><div style="height:50px"></div><div style="height:10px"></div><div style="height:30px"></div></div><div id="c80i2" style="line-height:0"><div><i style="height:10px"></i></div></div><div id="c80i3" style="line-height:0"><div style="height:10px"></div><div style="height:10px"></div><div style="height:20px"></div></div><div id="c80i4" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div></div><div id="c80i5" style="line-height:0;align-self:start"><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c81" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:120px"><div style="height:50px"></div><div id="c81g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c81i0" style="line-height:0;align-self:end"><div style="height:30px"></div><div style="height:10px"></div><div style="height:40px"></div></div><div id="c81i1" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:20px"></i></div></div><div id="c81i2" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div></div><div id="c81i3" style="line-height:0"><div><i style="height:20px"></i></div></div><div id="c81i4" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div></div><div id="c81i5" style="line-height:0;align-self:start"><div style="height:20px"></div></div></div></div>
<div class="case" id="c82" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:120px"><div id="c82g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c82i0" style="line-height:0"><div><i style="height:30px"></i></div></div><div id="c82i1" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div></div><div id="c82i2" style="line-height:0"><div style="height:50px"></div><div style="height:30px"></div><div style="height:30px"></div></div><div id="c82i3" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c83" style="columns:3;column-gap:0;column-fill:balance;width:180px;height:80px"><div style="height:30px"></div><div id="c83g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c83i0" style="line-height:0;align-self:end"><div style="height:20px"></div><div style="height:20px"></div></div><div id="c83i1" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c84" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:60px"><div style="height:30px"></div><div id="c84g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c84i0" style="line-height:0;align-self:start"><div><i style="height:10px"></i></div></div><div id="c84i1" style="line-height:0;align-self:start"><div style="height:50px"></div></div><div id="c84i2" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:50px"></i></div><div><i style="height:50px"></i></div></div><div id="c84i3" style="line-height:0;align-self:end"><div style="height:10px"></div><div style="height:10px"></div><div style="height:40px"></div></div><div id="c84i4" style="line-height:0;align-self:end"><div style="height:40px"></div><div style="height:20px"></div><div style="height:40px"></div></div><div id="c84i5" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div><div><i style="height:10px"></i></div></div></div></div>
<div class="case" id="c85" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:120px"><div style="height:30px"></div><div id="c85g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c85i0" style="line-height:0;align-self:start"><div style="height:10px"></div><div style="height:10px"></div><div style="height:30px"></div></div><div id="c85i1" style="line-height:0"><div style="height:30px"></div></div><div id="c85i2" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div><div id="c85i3" style="line-height:0"><div style="height:10px"></div><div style="height:10px"></div><div style="height:50px"></div></div><div id="c85i4" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div><div id="c85i5" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c86" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:120px"><div style="height:10px"></div><div id="c86g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c86i0" style="line-height:0;align-self:end"><div style="height:30px"></div><div style="height:50px"></div><div style="height:40px"></div></div><div id="c86i1" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div><div><i style="height:10px"></i></div></div></div></div>
<div class="case" id="c87" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:60px"><div style="height:30px"></div><div id="c87g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c87i0" style="line-height:0"><div style="height:20px"></div></div><div id="c87i1" style="line-height:0"><div style="height:40px"></div></div></div></div>
<div class="case" id="c88" style="columns:4;column-gap:0;column-fill:auto;width:240px;height:80px"><div style="height:10px"></div><div id="c88g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c88i0" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div></div><div id="c88i1" style="line-height:0"><div style="height:10px"></div></div><div id="c88i2" style="line-height:0"><div style="height:20px"></div></div><div id="c88i3" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c89" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:60px"><div style="height:10px"></div><div id="c89g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c89i0" style="line-height:0;align-self:start"><div><i style="height:30px"></i></div></div><div id="c89i1" style="line-height:0;align-self:end"><div style="height:20px"></div><div style="height:50px"></div></div></div></div>
<div class="case" id="c90" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:100px"><div style="height:10px"></div><div id="c90g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c90i0" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div><div id="c90i1" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c91" style="columns:2;column-gap:0;column-fill:balance;width:120px;height:120px"><div style="height:50px"></div><div id="c91g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c91i0" style="line-height:0"><div><i style="height:20px"></i></div></div><div id="c91i1" style="line-height:0;align-self:start"><div style="height:20px"></div><div style="height:20px"></div></div><div id="c91i2" style="line-height:0"><div style="height:40px"></div></div><div id="c91i3" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c92" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:100px"><div id="c92g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c92i0" style="line-height:0"><div style="height:40px"></div><div style="height:10px"></div></div><div id="c92i1" style="line-height:0"><div style="height:10px"></div></div><div id="c92i2" style="line-height:0;align-self:end"><div><i style="height:20px"></i></div><div><i style="height:20px"></i></div></div></div></div>
<div class="case" id="c93" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:120px"><div id="c93g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c93i0" style="line-height:0"><div><i style="height:50px"></i></div><div><i style="height:20px"></i></div><div><i style="height:10px"></i></div></div><div id="c93i1" style="line-height:0;align-self:end"><div><i style="height:10px"></i></div></div><div id="c93i2" style="line-height:0;align-self:start"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div><div id="c93i3" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div></div><div id="c93i4" style="line-height:0"><div style="height:20px"></div></div><div id="c93i5" style="line-height:0;align-self:start"><div style="height:10px"></div><div style="height:40px"></div><div style="height:10px"></div></div></div></div>
<div class="case" id="c94" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:60px"><div id="c94g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c94i0" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div><div><i style="height:50px"></i></div></div><div id="c94i1" style="line-height:0;align-self:end"><div style="height:20px"></div><div style="height:10px"></div><div style="height:40px"></div></div><div id="c94i2" style="line-height:0;align-self:start"><div><i style="height:10px"></i></div><div><i style="height:10px"></i></div></div></div></div>
<div class="case" id="c95" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:100px"><div style="height:10px"></div><div id="c95g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c95i0" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:40px"></i></div><div><i style="height:40px"></i></div></div><div id="c95i1" style="line-height:0"><div><i style="height:50px"></i></div></div><div id="c95i2" style="line-height:0"><div style="height:10px"></div><div style="height:20px"></div></div><div id="c95i3" style="line-height:0;align-self:end"><div style="height:50px"></div><div style="height:30px"></div></div><div id="c95i4" style="line-height:0"><div><i style="height:50px"></i></div></div><div id="c95i5" style="line-height:0;align-self:end"><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c96" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:100px"><div id="c96g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c96i0" style="line-height:0;align-self:end"><div style="height:50px"></div><div style="height:10px"></div></div><div id="c96i1" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:40px"></i></div></div><div id="c96i2" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div></div><div id="c96i3" style="line-height:0"><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div></div></div>
<div class="case" id="c97" style="columns:4;column-gap:0;column-fill:balance;width:240px;height:80px"><div style="height:50px"></div><div id="c97g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c97i0" style="line-height:0;align-self:start"><div><i style="height:10px"></i></div></div><div id="c97i1" style="line-height:0;align-self:end"><div style="height:40px"></div><div style="height:10px"></div></div><div id="c97i2" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:30px"></i></div></div></div></div>
<div class="case" id="c98" style="columns:3;column-gap:0;column-fill:auto;width:180px;height:100px"><div id="c98g" style="display:grid;grid-template-columns:repeat(2,20px)"><div id="c98i0" style="line-height:0"><div><i style="height:10px"></i></div><div><i style="height:30px"></i></div></div><div id="c98i1" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:20px"></i></div></div><div id="c98i2" style="line-height:0"><div style="height:50px"></div></div><div id="c98i3" style="line-height:0;align-self:end"><div><i style="height:50px"></i></div></div></div></div>
<div class="case" id="c99" style="columns:2;column-gap:0;column-fill:auto;width:120px;height:100px"><div style="height:10px"></div><div id="c99g" style="display:grid;grid-template-columns:repeat(3,20px)"><div id="c99i0" style="line-height:0"><div style="height:20px"></div><div style="height:30px"></div><div style="height:40px"></div></div><div id="c99i1" style="line-height:0"><div><i style="height:30px"></i></div><div><i style="height:40px"></i></div></div><div id="c99i2" style="line-height:0"><div><i style="height:40px"></i></div><div><i style="height:20px"></i></div><div><i style="height:40px"></i></div></div><div id="c99i3" style="line-height:0;align-self:start"><div><i style="height:50px"></i></div><div><i style="height:20px"></i></div></div><div id="c99i4" style="line-height:0;align-self:start"><div style="height:30px"></div><div style="height:20px"></div></div><div id="c99i5" style="line-height:0"><div style="height:30px"></div></div></div></div>
`;

export const GRID_ROWS_RECTS: Record<string, number[][]> = {
  c0g: [
    [0, 10, 60, 50],
    [60, 0, 60, 60],
    [120, 0, 60, 50],
  ],
  c0i0: [
    [0, 10, 20, 50],
    [60, 0, 20, 20],
  ],
  c0i1: [
    [20, 10, 20, 50],
    [80, 0, 20, 20],
  ],
  c0i2: [
    [40, 10, 20, 50],
    [100, 0, 20, 20],
  ],
  c0i3: [
    [60, 20, 20, 40],
    [120, 0, 20, 50],
  ],
  c0i4: [
    [80, 20, 20, 40],
    [140, 0, 20, 50],
  ],
  c0i5: [
    [100, 20, 20, 40],
    [160, 0, 20, 50],
  ],
  c1g: [
    [0, 0, 60, 50],
    [60, 0, 60, 40],
  ],
  c1i0: [
    [0, 0, 20, 50],
    [60, 0, 20, 40],
  ],
  c1i1: [
    [20, 0, 20, 50],
    [80, 0, 20, 40],
  ],
  c2g: [
    [0, 50, 60, 30],
    [60, 0, 60, 60],
  ],
  c2i0: [
    [0, 50, 20, 30],
    [60, 0, 20, 60],
  ],
  c2i1: [
    [20, 50, 20, 30],
    [80, 0, 20, 60],
  ],
  c3g: [
    [60, 0, 60, 60],
    [120, 0, 60, 60],
    [180, 0, 60, 60],
    [240, 0, 60, 80],
    [300, 0, 60, 60],
    [360, 0, 60, 50],
  ],
  c3i0: [
    [60, 0, 20, 60],
    [120, 0, 20, 60],
    [180, 0, 20, 50],
  ],
  c3i1: [
    [80, 0, 20, 60],
    [140, 0, 20, 60],
    [200, 0, 20, 50],
  ],
  c3i2: [
    [100, 0, 20, 60],
    [160, 0, 20, 60],
    [220, 0, 20, 50],
  ],
  c3i3: [[300, 0, 20, 40]],
  c3i4: [
    [260, 0, 20, 60],
    [320, 0, 20, 60],
    [380, 0, 20, 50],
  ],
  c3i5: [
    [280, 0, 20, 60],
    [340, 0, 20, 60],
    [400, 0, 20, 50],
  ],
  c4g: [
    [60, 0, 60, 70],
    [120, 0, 60, 60],
  ],
  c4i0: [
    [60, 0, 20, 70],
    [120, 0, 20, 60],
  ],
  c4i1: [
    [80, 0, 20, 70],
    [140, 0, 20, 60],
  ],
  c4i2: [
    [100, 50, 20, 20],
    [160, 0, 20, 60],
  ],
  c5g: [[0, 10, 60, 40]],
  c5i0: [[0, 10, 20, 40]],
  c5i1: [[20, 10, 20, 40]],
  c5i2: [[40, 10, 20, 10]],
  c6g: [
    [60, 0, 60, 40],
    [120, 0, 60, 30],
  ],
  c6i0: [
    [60, 0, 20, 40],
    [120, 0, 20, 30],
  ],
  c6i1: [
    [80, 0, 20, 40],
    [140, 0, 20, 30],
  ],
  c7g: [
    [0, 0, 60, 80],
    [60, 0, 60, 50],
  ],
  c7i0: [[0, 0, 20, 80]],
  c7i1: [
    [20, 0, 20, 80],
    [80, 0, 20, 50],
  ],
  c7i2: [
    [40, 0, 20, 80],
    [100, 0, 20, 50],
  ],
  c8g: [
    [60, 0, 60, 80],
    [120, 0, 60, 80],
    [180, 0, 60, 70],
  ],
  c8i0: [
    [60, 0, 20, 80],
    [120, 0, 20, 10],
  ],
  c8i1: [
    [80, 0, 20, 80],
    [140, 0, 20, 10],
  ],
  c8i2: [
    [100, 70, 20, 10],
    [160, 0, 20, 10],
  ],
  c8i3: [
    [120, 10, 20, 70],
    [180, 0, 20, 70],
  ],
  c8i4: [
    [140, 10, 20, 70],
    [200, 0, 20, 70],
  ],
  c8i5: [
    [160, 10, 20, 70],
    [220, 0, 20, 70],
  ],
  c9g: [
    [60, 0, 60, 50],
    [120, 0, 60, 50],
  ],
  c9i0: [
    [60, 0, 20, 50],
    [120, 0, 20, 50],
  ],
  c9i1: [
    [80, 0, 20, 50],
    [140, 0, 20, 50],
  ],
  c10g: [
    [0, 0, 60, 110],
    [60, 0, 60, 90],
  ],
  c10i0: [[0, 0, 20, 110]],
  c10i1: [[20, 0, 20, 10]],
  c10i2: [[40, 60, 20, 50]],
  c10i3: [[60, 0, 20, 90]],
  c10i4: [[80, 30, 20, 60]],
  c10i5: [[100, 0, 20, 90]],
  c11g: [
    [0, 30, 60, 50],
    [60, 0, 60, 30],
  ],
  c11i0: [
    [0, 30, 20, 50],
    [60, 0, 20, 30],
  ],
  c11i1: [
    [20, 30, 20, 50],
    [80, 0, 20, 30],
  ],
  c11i2: [
    [40, 30, 20, 50],
    [100, 0, 20, 30],
  ],
  c12g: [
    [0, 0, 60, 70],
    [60, 0, 60, 70],
    [120, 0, 60, 50],
  ],
  c12i0: [[0, 0, 20, 70]],
  c12i1: [[20, 0, 20, 50]],
  c12i2: [
    [60, 0, 20, 70],
    [120, 0, 20, 50],
  ],
  c12i3: [
    [80, 0, 20, 70],
    [140, 0, 20, 50],
  ],
  c13g: [
    [60, 0, 60, 70],
    [120, 0, 60, 60],
    [180, 0, 60, 60],
    [240, 0, 60, 50],
  ],
  c13i0: [
    [60, 0, 20, 60],
    [120, 0, 20, 60],
    [180, 0, 20, 10],
  ],
  c13i1: [[140, 0, 20, 60]],
  c13i2: [
    [180, 10, 20, 50],
    [240, 0, 20, 50],
  ],
  c13i3: [
    [200, 10, 20, 50],
    [260, 0, 20, 50],
  ],
  c14g: [
    [60, 0, 60, 60],
    [120, 0, 60, 60],
    [180, 0, 60, 60],
    [240, 0, 60, 60],
    [300, 0, 60, 20],
  ],
  c14i0: [
    [60, 0, 20, 60],
    [120, 0, 20, 60],
    [180, 0, 20, 40],
  ],
  c14i1: [
    [80, 0, 20, 60],
    [140, 0, 20, 60],
    [200, 0, 20, 40],
  ],
  c14i2: [
    [100, 0, 20, 60],
    [160, 0, 20, 60],
    [220, 0, 20, 40],
  ],
  c14i3: [[240, 0, 20, 50]],
  c14i4: [
    [260, 0, 20, 60],
    [320, 0, 20, 20],
  ],
  c14i5: [
    [280, 0, 20, 60],
    [340, 0, 20, 20],
  ],
  c15g: [
    [0, 0, 60, 100],
    [60, 0, 60, 100],
    [120, 0, 60, 100],
    [180, 0, 60, 50],
  ],
  c15i0: [
    [0, 0, 20, 100],
    [60, 0, 20, 30],
  ],
  c15i1: [
    [20, 10, 20, 90],
    [80, 0, 20, 30],
  ],
  c15i2: [
    [120, 0, 20, 100],
    [180, 0, 20, 40],
  ],
  c15i3: [
    [140, 90, 20, 10],
    [200, 0, 20, 50],
  ],
  c16g: [
    [0, 50, 60, 70],
    [60, 0, 60, 80],
  ],
  c16i0: [[0, 50, 20, 40]],
  c16i1: [[20, 70, 20, 20]],
  c16i2: [[40, 50, 20, 20]],
  c16i3: [
    [0, 90, 20, 30],
    [60, 0, 20, 80],
  ],
  c16i4: [
    [20, 90, 20, 30],
    [80, 0, 20, 30],
  ],
  c16i5: [
    [40, 90, 20, 30],
    [100, 0, 20, 80],
  ],
  c17g: [
    [0, 30, 60, 30],
    [60, 0, 60, 60],
  ],
  c17i0: [
    [0, 30, 20, 30],
    [60, 0, 20, 60],
  ],
  c17i1: [
    [20, 30, 20, 30],
    [80, 0, 20, 60],
  ],
  c18g: [[0, 0, 60, 10]],
  c18i0: [[0, 0, 20, 10]],
  c18i1: [[20, 0, 20, 10]],
  c19g: [
    [60, 0, 60, 120],
    [120, 0, 60, 120],
    [180, 0, 60, 80],
  ],
  c19i0: [
    [60, 0, 20, 120],
    [120, 0, 20, 50],
  ],
  c19i1: [[140, 0, 20, 20]],
  c19i2: [
    [100, 70, 20, 50],
    [160, 0, 20, 30],
  ],
  c19i3: [
    [120, 50, 20, 70],
    [180, 0, 20, 80],
  ],
  c19i4: [
    [140, 50, 20, 70],
    [200, 0, 20, 80],
  ],
  c19i5: [
    [160, 50, 20, 70],
    [220, 0, 20, 80],
  ],
  c20g: [
    [60, 0, 60, 80],
    [120, 0, 60, 80],
    [180, 0, 60, 80],
  ],
  c20i0: [
    [60, 0, 20, 80],
    [120, 0, 20, 20],
  ],
  c20i1: [
    [80, 0, 20, 80],
    [140, 0, 20, 40],
  ],
  c20i2: [
    [100, 0, 20, 80],
    [160, 0, 20, 20],
  ],
  c20i3: [[180, 50, 20, 30]],
  c20i4: [[200, 0, 20, 80]],
  c20i5: [[220, 0, 20, 50]],
  c21g: [
    [0, 50, 60, 50],
    [60, 0, 60, 100],
    [120, 0, 60, 90],
  ],
  c21i0: [
    [0, 50, 20, 50],
    [60, 0, 20, 70],
  ],
  c21i1: [
    [20, 70, 20, 30],
    [80, 0, 20, 30],
  ],
  c21i2: [
    [40, 50, 20, 50],
    [100, 0, 20, 30],
  ],
  c21i3: [[120, 0, 20, 90]],
  c21i4: [[140, 0, 20, 90]],
  c21i5: [[160, 0, 20, 90]],
  c22g: [[0, 0, 60, 100]],
  c22i0: [[0, 0, 20, 100]],
  c22i1: [[20, 0, 20, 100]],
  c23g: [
    [0, 0, 60, 40],
    [60, 0, 60, 40],
    [120, 0, 60, 20],
  ],
  c23i0: [
    [0, 0, 20, 40],
    [60, 0, 20, 40],
  ],
  c23i1: [
    [20, 0, 20, 40],
    [80, 0, 20, 40],
    [140, 0, 20, 20],
  ],
  c24g: [
    [0, 30, 60, 30],
    [60, 0, 60, 60],
  ],
  c24i0: [[0, 30, 20, 20]],
  c24i1: [
    [20, 30, 20, 30],
    [80, 0, 20, 60],
  ],
  c25g: [
    [0, 0, 60, 60],
    [60, 0, 60, 60],
  ],
  c25i0: [
    [0, 0, 20, 60],
    [60, 0, 20, 60],
  ],
  c25i1: [
    [20, 0, 20, 60],
    [80, 0, 20, 60],
  ],
  c26g: [
    [0, 10, 60, 20],
    [60, 0, 60, 30],
    [120, 0, 60, 30],
    [180, 0, 60, 10],
  ],
  c26i0: [
    [0, 10, 20, 20],
    [60, 0, 20, 30],
    [120, 0, 20, 30],
    [180, 0, 20, 10],
  ],
  c26i1: [
    [20, 10, 20, 20],
    [80, 0, 20, 30],
    [140, 0, 20, 30],
    [200, 0, 20, 10],
  ],
  c27g: [
    [0, 0, 60, 100],
    [60, 0, 60, 100],
  ],
  c27i0: [[0, 0, 20, 60]],
  c27i1: [[20, 0, 20, 80]],
  c27i2: [[40, 0, 20, 80]],
  c27i3: [[60, 0, 20, 20]],
  c27i4: [[80, 0, 20, 100]],
  c27i5: [[100, 60, 20, 40]],
  c28g: [
    [0, 0, 60, 60],
    [60, 0, 60, 60],
    [120, 0, 60, 30],
  ],
  c28i0: [
    [0, 0, 20, 60],
    [60, 0, 20, 60],
    [120, 0, 20, 30],
  ],
  c28i1: [
    [20, 0, 20, 60],
    [80, 0, 20, 50],
  ],
  c28i2: [
    [40, 0, 20, 60],
    [100, 0, 20, 60],
    [160, 0, 20, 30],
  ],
  c29g: [
    [0, 0, 60, 60],
    [60, 0, 60, 60],
    [120, 0, 60, 60],
    [180, 0, 60, 60],
    [240, 0, 60, 50],
  ],
  c29i0: [
    [0, 0, 20, 60],
    [60, 0, 20, 40],
  ],
  c29i1: [
    [20, 0, 20, 60],
    [80, 0, 20, 40],
  ],
  c29i2: [
    [120, 0, 20, 60],
    [180, 0, 20, 60],
    [240, 0, 20, 50],
  ],
  c29i3: [
    [140, 0, 20, 60],
    [200, 0, 20, 60],
    [260, 0, 20, 50],
  ],
  c30g: [
    [0, 50, 60, 50],
    [60, 0, 60, 100],
    [120, 0, 60, 50],
  ],
  c30i0: [[0, 50, 20, 50]],
  c30i1: [
    [20, 50, 20, 50],
    [80, 0, 20, 70],
  ],
  c30i2: [[120, 0, 20, 50]],
  c30i3: [[140, 0, 20, 50]],
  c31g: [[60, 0, 60, 60]],
  c31i0: [[60, 0, 20, 60]],
  c31i1: [[80, 0, 20, 60]],
  c31i2: [[100, 20, 20, 40]],
  c32g: [
    [0, 0, 60, 50],
    [60, 0, 60, 50],
    [120, 0, 60, 50],
    [180, 0, 60, 40],
  ],
  c32i0: [
    [0, 0, 20, 50],
    [60, 0, 20, 50],
  ],
  c32i1: [
    [20, 0, 20, 50],
    [80, 0, 20, 50],
  ],
  c32i2: [
    [120, 0, 20, 50],
    [180, 0, 20, 40],
  ],
  c32i3: [
    [140, 0, 20, 50],
    [200, 0, 20, 40],
  ],
  c33g: [
    [60, 0, 60, 60],
    [120, 0, 60, 60],
    [180, 0, 60, 60],
    [240, 0, 60, 30],
  ],
  c33i0: [
    [60, 0, 20, 60],
    [120, 0, 20, 60],
    [180, 0, 20, 40],
  ],
  c33i1: [
    [80, 0, 20, 60],
    [140, 0, 20, 60],
    [200, 0, 20, 40],
  ],
  c33i2: [
    [180, 40, 20, 20],
    [240, 0, 20, 30],
  ],
  c33i3: [
    [200, 40, 20, 20],
    [260, 0, 20, 20],
  ],
  c34g: [
    [0, 30, 60, 50],
    [60, 0, 60, 40],
  ],
  c34i0: [
    [0, 30, 20, 50],
    [60, 0, 20, 40],
  ],
  c34i1: [
    [20, 30, 20, 50],
    [80, 0, 20, 40],
  ],
  c35g: [
    [0, 10, 60, 90],
    [60, 0, 60, 100],
    [120, 0, 60, 40],
  ],
  c35i0: [
    [0, 10, 20, 90],
    [60, 0, 20, 50],
  ],
  c35i1: [
    [20, 10, 20, 90],
    [80, 0, 20, 50],
  ],
  c35i2: [
    [40, 10, 20, 90],
    [100, 0, 20, 50],
  ],
  c35i3: [
    [60, 50, 20, 50],
    [120, 0, 20, 40],
  ],
  c35i4: [
    [80, 50, 20, 50],
    [140, 0, 20, 40],
  ],
  c35i5: [
    [100, 50, 20, 50],
    [160, 0, 20, 40],
  ],
  c36g: [
    [60, 12.5, 60, 25],
    [120, 0, 60, 37.5],
    [180, 0, 60, 37.5],
  ],
  c36i0: [
    [60, 12.5, 20, 25],
    [120, 0, 20, 37.5],
    [180, 0, 20, 7.5],
  ],
  c36i1: [
    [80, 12.5, 20, 25],
    [140, 0, 20, 37.5],
    [200, 0, 20, 7.5],
  ],
  c36i2: [[180, 27.5, 20, 10]],
  c36i3: [[200, 7.5, 20, 30]],
  c37g: [
    [0, 30, 60, 90],
    [60, 0, 60, 110],
  ],
  c37i0: [
    [0, 30, 20, 90],
    [60, 0, 20, 50],
  ],
  c37i1: [
    [20, 30, 20, 90],
    [80, 0, 20, 50],
  ],
  c37i2: [[40, 30, 20, 60]],
  c37i3: [[60, 50, 20, 60]],
  c37i4: [[80, 50, 20, 60]],
  c37i5: [[100, 50, 20, 20]],
  c38g: [
    [0, 10, 60, 90],
    [60, 0, 60, 100],
    [120, 0, 60, 60],
  ],
  c38i0: [
    [0, 10, 20, 90],
    [60, 0, 20, 50],
  ],
  c38i1: [
    [20, 10, 20, 90],
    [80, 0, 20, 50],
  ],
  c38i2: [
    [40, 10, 20, 90],
    [100, 0, 20, 50],
  ],
  c38i3: [
    [60, 50, 20, 50],
    [120, 0, 20, 60],
  ],
  c38i4: [
    [80, 50, 20, 50],
    [140, 0, 20, 60],
  ],
  c38i5: [
    [100, 50, 20, 50],
    [160, 0, 20, 60],
  ],
  c39g: [
    [0, 10, 60, 70],
    [60, 0, 60, 80],
  ],
  c39i0: [
    [0, 10, 20, 70],
    [60, 0, 20, 10],
  ],
  c39i1: [
    [20, 60, 20, 20],
    [80, 0, 20, 10],
  ],
  c39i2: [[60, 10, 20, 70]],
  c39i3: [[80, 10, 20, 70]],
  c40g: [
    [60, 0, 60, 80],
    [120, 0, 60, 60],
  ],
  c40i0: [
    [60, 0, 20, 60],
    [120, 0, 20, 60],
  ],
  c40i1: [[140, 0, 20, 30]],
  c41g: [
    [60, 0, 60, 60],
    [120, 0, 60, 60],
    [180, 0, 60, 30],
  ],
  c41i0: [
    [60, 0, 20, 60],
    [120, 0, 20, 60],
    [180, 0, 20, 30],
  ],
  c41i1: [
    [80, 0, 20, 60],
    [140, 0, 20, 60],
    [200, 0, 20, 30],
  ],
  c41i2: [
    [100, 0, 20, 60],
    [160, 0, 20, 60],
    [220, 0, 20, 30],
  ],
  c42g: [
    [0, 30, 60, 50],
    [60, 0, 60, 80],
  ],
  c42i0: [[0, 30, 20, 30]],
  c42i1: [[20, 30, 20, 30]],
  c42i2: [[60, 10, 20, 70]],
  c42i3: [[80, 0, 20, 80]],
  c43g: [
    [0, 10, 60, 30],
    [60, 0, 60, 40],
    [120, 0, 60, 30],
  ],
  c43i0: [
    [0, 10, 20, 30],
    [60, 0, 20, 40],
  ],
  c43i1: [
    [20, 10, 20, 30],
    [80, 0, 20, 40],
  ],
  c43i2: [
    [40, 10, 20, 30],
    [100, 0, 20, 40],
  ],
  c43i3: [[120, 0, 20, 30]],
  c43i4: [[140, 0, 20, 30]],
  c43i5: [[160, 0, 20, 30]],
  c44g: [[0, 10, 60, 110]],
  c44i0: [[0, 10, 20, 110]],
  c44i1: [[20, 10, 20, 110]],
  c45g: [
    [0, 0, 60, 60],
    [60, 0, 60, 60],
    [120, 0, 60, 60],
    [180, 0, 60, 20],
  ],
  c45i0: [
    [0, 0, 20, 60],
    [60, 0, 20, 60],
  ],
  c45i1: [
    [20, 0, 20, 60],
    [80, 0, 20, 60],
  ],
  c45i2: [
    [40, 0, 20, 60],
    [100, 0, 20, 60],
  ],
  c45i3: [
    [120, 0, 20, 60],
    [180, 0, 20, 20],
  ],
  c45i4: [
    [140, 0, 20, 60],
    [200, 0, 20, 20],
  ],
  c45i5: [
    [160, 0, 20, 60],
    [220, 0, 20, 20],
  ],
  c46g: [
    [60, 0, 60, 60],
    [120, 0, 60, 50],
  ],
  c46i0: [[120, 0, 20, 30]],
  c46i1: [
    [80, 0, 20, 60],
    [140, 0, 20, 50],
  ],
  c46i2: [
    [100, 30, 20, 30],
    [160, 0, 20, 40],
  ],
  c47g: [
    [0, 0, 60, 13.34375],
    [60, 0, 60, 13.34375],
    [120, 0, 60, 13.3125],
  ],
  c47i0: [
    [0, 0, 20, 13.34375],
    [60, 0, 20, 13.34375],
    [120, 0, 20, 13.3125],
  ],
  c47i1: [
    [20, 0, 20, 13.34375],
    [80, 0, 20, 13.34375],
    [140, 0, 20, 13.3125],
  ],
  c48g: [[60, 0, 60, 60]],
  c48i0: [[60, 0, 20, 40]],
  c48i1: [[80, 0, 20, 60]],
  c48i2: [[100, 0, 20, 60]],
  c49g: [
    [0, 0, 60, 20],
    [60, 0, 60, 20],
    [120, 0, 60, 20],
  ],
  c49i0: [
    [0, 0, 20, 20],
    [60, 0, 20, 20],
    [120, 0, 20, 20],
  ],
  c49i1: [
    [20, 0, 20, 20],
    [80, 0, 20, 20],
    [140, 0, 20, 20],
  ],
  c50g: [
    [0, 50, 60, 50],
    [60, 0, 60, 100],
    [120, 0, 60, 100],
  ],
  c50i0: [
    [0, 50, 20, 50],
    [60, 0, 20, 40],
  ],
  c50i1: [
    [20, 50, 20, 50],
    [80, 0, 20, 40],
  ],
  c50i2: [
    [60, 40, 20, 60],
    [120, 0, 20, 100],
  ],
  c50i3: [
    [80, 40, 20, 60],
    [140, 0, 20, 100],
  ],
  c51g: [[60, 0, 60, 50]],
  c51i0: [[60, 0, 20, 50]],
  c51i1: [[80, 0, 20, 50]],
  c51i2: [[100, 0, 20, 40]],
  c52g: [
    [0, 0, 60, 100],
    [60, 0, 60, 50],
  ],
  c52i0: [[0, 10, 20, 50]],
  c52i1: [[20, 40, 20, 20]],
  c52i2: [[40, 0, 20, 60]],
  c52i3: [
    [0, 60, 20, 40],
    [60, 0, 20, 50],
  ],
  c52i4: [
    [20, 60, 20, 40],
    [80, 0, 20, 50],
  ],
  c52i5: [[40, 60, 20, 20]],
  c53g: [
    [0, 0, 60, 30],
    [60, 0, 60, 30],
    [120, 0, 60, 20],
  ],
  c53i0: [
    [0, 0, 20, 30],
    [60, 0, 20, 30],
    [120, 0, 20, 20],
  ],
  c53i1: [
    [20, 0, 20, 30],
    [80, 0, 20, 30],
    [140, 0, 20, 20],
  ],
  c54g: [
    [0, 0, 60, 50],
    [60, 0, 60, 50],
    [120, 0, 60, 50],
  ],
  c54i0: [[0, 0, 20, 40]],
  c54i1: [[20, 0, 20, 40]],
  c54i2: [[40, 0, 20, 40]],
  c54i3: [
    [60, 0, 20, 50],
    [120, 0, 20, 50],
  ],
  c54i4: [
    [80, 0, 20, 50],
    [140, 0, 20, 50],
  ],
  c54i5: [
    [100, 0, 20, 50],
    [160, 0, 20, 50],
  ],
  c55g: [
    [0, 10, 60, 35],
    [60, 0, 60, 45],
  ],
  c55i0: [
    [0, 10, 20, 35],
    [60, 0, 20, 45],
  ],
  c55i1: [
    [20, 10, 20, 35],
    [80, 0, 20, 45],
  ],
  c55i2: [
    [40, 10, 20, 35],
    [100, 0, 20, 45],
  ],
  c56g: [
    [0, 0, 60, 60],
    [60, 0, 60, 60],
    [120, 0, 60, 30],
  ],
  c56i0: [
    [0, 0, 20, 60],
    [60, 0, 20, 10],
  ],
  c56i1: [
    [20, 0, 20, 60],
    [80, 0, 20, 10],
  ],
  c56i2: [
    [40, 0, 20, 60],
    [100, 0, 20, 10],
  ],
  c56i3: [
    [60, 10, 20, 50],
    [120, 0, 20, 30],
  ],
  c56i4: [
    [80, 10, 20, 50],
    [140, 0, 20, 30],
  ],
  c56i5: [
    [100, 10, 20, 50],
    [160, 0, 20, 30],
  ],
  c57g: [
    [0, 30, 60, 50],
    [60, 0, 60, 30],
  ],
  c57i0: [
    [0, 30, 20, 50],
    [60, 0, 20, 30],
  ],
  c57i1: [
    [20, 60, 20, 20],
    [80, 0, 20, 30],
  ],
  c58g: [
    [0, 10, 60, 90],
    [60, 0, 60, 90],
  ],
  c58i0: [
    [0, 10, 20, 90],
    [60, 0, 20, 10],
  ],
  c58i1: [
    [20, 70, 20, 30],
    [80, 0, 20, 10],
  ],
  c58i2: [
    [40, 10, 20, 90],
    [100, 0, 20, 10],
  ],
  c58i3: [[60, 10, 20, 80]],
  c58i4: [[80, 10, 20, 80]],
  c58i5: [[100, 10, 20, 80]],
  c59g: [
    [0, 0, 60, 80],
    [60, 0, 60, 90],
    [120, 0, 60, 50],
  ],
  c59i0: [[0, 0, 20, 70]],
  c59i1: [[20, 0, 20, 70]],
  c59i2: [[40, 0, 20, 70]],
  c59i3: [
    [60, 0, 20, 80],
    [120, 0, 20, 50],
  ],
  c59i4: [[140, 0, 20, 40]],
  c59i5: [
    [100, 0, 20, 80],
    [160, 0, 20, 50],
  ],
  c60g: [
    [0, 0, 60, 80],
    [60, 0, 60, 60],
  ],
  c60i0: [
    [0, 70, 20, 10],
    [60, 0, 20, 60],
  ],
  c60i1: [
    [20, 0, 20, 80],
    [80, 0, 20, 60],
  ],
  c61g: [
    [0, 0, 60, 80],
    [60, 0, 60, 80],
  ],
  c61i0: [[0, 0, 20, 70]],
  c61i1: [[20, 20, 20, 50]],
  c61i2: [[40, 0, 20, 70]],
  c61i3: [[60, 0, 20, 80]],
  c61i4: [[80, 0, 20, 80]],
  c61i5: [[100, 20, 20, 60]],
  c62g: [[0, 30, 60, 70]],
  c62i0: [[0, 30, 20, 70]],
  c62i1: [[20, 30, 20, 70]],
  c63g: [[60, 0, 60, 40]],
  c63i0: [[60, 0, 20, 40]],
  c63i1: [[80, 30, 20, 10]],
  c63i2: [[100, 0, 20, 40]],
  c64g: [[0, 0, 60, 90]],
  c64i0: [[0, 0, 20, 90]],
  c64i1: [[20, 0, 20, 60]],
  c65g: [
    [60, 0, 60, 20],
    [120, 0, 60, 20],
  ],
  c65i0: [
    [60, 0, 20, 20],
    [120, 0, 20, 20],
  ],
  c65i1: [
    [80, 0, 20, 20],
    [140, 0, 20, 20],
  ],
  c66g: [
    [0, 0, 60, 100],
    [60, 0, 60, 100],
    [120, 0, 60, 80],
  ],
  c66i0: [
    [0, 0, 20, 100],
    [60, 0, 20, 20],
  ],
  c66i1: [
    [20, 0, 20, 100],
    [80, 0, 20, 20],
  ],
  c66i2: [
    [40, 0, 20, 100],
    [100, 0, 20, 20],
  ],
  c66i3: [
    [60, 20, 20, 80],
    [120, 0, 20, 80],
  ],
  c66i4: [
    [80, 20, 20, 80],
    [140, 0, 20, 80],
  ],
  c66i5: [
    [100, 20, 20, 80],
    [160, 0, 20, 80],
  ],
  c67g: [
    [60, 0, 60, 60],
    [120, 0, 60, 60],
    [180, 0, 60, 60],
    [240, 0, 60, 20],
  ],
  c67i0: [
    [60, 0, 20, 60],
    [120, 0, 20, 60],
    [180, 0, 20, 20],
  ],
  c67i1: [
    [80, 20, 20, 40],
    [140, 0, 20, 60],
    [200, 0, 20, 20],
  ],
  c67i2: [
    [180, 20, 20, 40],
    [240, 0, 20, 20],
  ],
  c67i3: [
    [200, 20, 20, 40],
    [260, 0, 20, 20],
  ],
  c68g: [
    [0, 10, 60, 90],
    [60, 0, 60, 40],
  ],
  c68i0: [[0, 10, 20, 50]],
  c68i1: [
    [20, 10, 20, 90],
    [80, 0, 20, 40],
  ],
  c68i2: [
    [40, 10, 20, 90],
    [100, 0, 20, 40],
  ],
  c69g: [[60, 0, 60, 50]],
  c69i0: [[60, 0, 20, 50]],
  c69i1: [[80, 0, 20, 50]],
  c69i2: [[100, 0, 20, 50]],
  c70g: [[0, 10, 60, 50]],
  c70i0: [[0, 10, 20, 50]],
  c70i1: [[20, 10, 20, 50]],
  c70i2: [[40, 10, 20, 50]],
  c71g: [
    [0, 0, 60, 60],
    [60, 0, 60, 60],
    [120, 0, 60, 40],
  ],
  c71i0: [[0, 0, 20, 50]],
  c71i1: [[20, 0, 20, 50]],
  c71i2: [
    [0, 50, 20, 10],
    [60, 0, 20, 60],
    [120, 0, 20, 40],
  ],
  c71i3: [
    [20, 50, 20, 10],
    [80, 0, 20, 60],
    [140, 0, 20, 40],
  ],
  c72g: [
    [0, 10, 60, 50],
    [60, 0, 60, 60],
  ],
  c72i0: [
    [0, 10, 20, 50],
    [60, 0, 20, 60],
  ],
  c72i1: [
    [20, 10, 20, 50],
    [80, 0, 20, 60],
  ],
  c73g: [
    [0, 0, 60, 100],
    [60, 0, 60, 30],
  ],
  c73i0: [[0, 10, 20, 20]],
  c73i1: [[20, 0, 20, 30]],
  c73i2: [
    [0, 70, 20, 30],
    [60, 0, 20, 30],
  ],
  c73i3: [
    [20, 30, 20, 70],
    [80, 0, 20, 30],
  ],
  c74g: [[0, 0, 60, 60]],
  c74i0: [[0, 0, 20, 60]],
  c74i1: [[20, 0, 20, 60]],
  c75g: [
    [0, 10, 60, 20],
    [60, 0, 60, 30],
    [120, 0, 60, 20],
  ],
  c75i0: [
    [0, 10, 20, 20],
    [60, 0, 20, 30],
    [120, 0, 20, 20],
  ],
  c75i1: [
    [20, 10, 20, 20],
    [80, 0, 20, 30],
    [140, 0, 20, 20],
  ],
  c76g: [[0, 0, 60, 100]],
  c76i0: [[0, 0, 20, 100]],
  c76i1: [[20, 60, 20, 40]],
  c76i2: [[40, 0, 20, 100]],
  c77g: [
    [0, 10, 60, 80],
    [60, 0, 60, 90],
  ],
  c77i0: [[0, 10, 20, 80]],
  c77i1: [[20, 10, 20, 80]],
  c77i2: [[40, 20, 20, 70]],
  c77i3: [[60, 0, 20, 90]],
  c77i4: [[80, 0, 20, 90]],
  c77i5: [[100, 0, 20, 90]],
  c78g: [
    [0, 10, 60, 70],
    [60, 0, 60, 60],
  ],
  c78i0: [
    [0, 10, 20, 70],
    [60, 0, 20, 60],
  ],
  c78i1: [[20, 10, 20, 70]],
  c78i2: [
    [40, 10, 20, 70],
    [100, 0, 20, 50],
  ],
  c79g: [
    [0, 0, 60, 80],
    [60, 0, 60, 80],
    [120, 0, 60, 80],
    [180, 0, 60, 60],
  ],
  c79i0: [
    [0, 0, 20, 80],
    [60, 0, 20, 40],
  ],
  c79i1: [
    [20, 0, 20, 80],
    [80, 0, 20, 40],
  ],
  c79i2: [
    [40, 0, 20, 80],
    [100, 0, 20, 40],
  ],
  c79i3: [
    [120, 0, 20, 80],
    [180, 0, 20, 60],
  ],
  c79i4: [[200, 0, 20, 30]],
  c79i5: [[160, 0, 20, 60]],
  c80g: [
    [0, 0, 60, 70],
    [60, 0, 60, 70],
    [120, 0, 60, 70],
    [180, 0, 60, 40],
  ],
  c80i0: [
    [0, 0, 20, 70],
    [60, 0, 20, 20],
  ],
  c80i1: [
    [20, 0, 20, 70],
    [80, 0, 20, 20],
  ],
  c80i2: [
    [40, 0, 20, 70],
    [100, 0, 20, 20],
  ],
  c80i3: [
    [60, 20, 20, 50],
    [120, 0, 20, 70],
    [180, 0, 20, 40],
  ],
  c80i4: [
    [80, 20, 20, 50],
    [140, 0, 20, 70],
    [200, 0, 20, 40],
  ],
  c80i5: [[100, 20, 20, 40]],
  c81g: [
    [0, 50, 60, 70],
    [60, 0, 60, 80],
  ],
  c81i0: [
    [0, 60, 20, 60],
    [60, 0, 20, 20],
  ],
  c81i1: [
    [20, 50, 20, 70],
    [80, 0, 20, 50],
  ],
  c81i2: [
    [40, 50, 20, 70],
    [100, 0, 20, 50],
  ],
  c81i3: [[60, 50, 20, 30]],
  c81i4: [[80, 50, 20, 30]],
  c81i5: [[100, 50, 20, 20]],
  c82g: [
    [0, 0, 60, 120],
    [60, 0, 60, 80],
  ],
  c82i0: [[0, 0, 20, 80]],
  c82i1: [[20, 0, 20, 80]],
  c82i2: [
    [0, 80, 20, 40],
    [60, 0, 20, 80],
  ],
  c82i3: [
    [20, 100, 20, 20],
    [80, 0, 20, 80],
  ],
  c83g: [
    [60, 0, 60, 30],
    [120, 0, 60, 30],
  ],
  c83i0: [
    [60, 0, 20, 30],
    [120, 0, 20, 10],
  ],
  c83i1: [
    [80, 0, 20, 30],
    [140, 0, 20, 30],
  ],
  c84g: [
    [60, 0, 60, 60],
    [120, 0, 60, 60],
    [180, 0, 60, 60],
    [240, 0, 60, 60],
    [300, 0, 60, 60],
  ],
  c84i0: [[60, 0, 20, 10]],
  c84i1: [[80, 0, 20, 50]],
  c84i2: [
    [100, 0, 20, 60],
    [160, 0, 20, 60],
    [220, 0, 20, 50],
  ],
  c84i3: [
    [240, 40, 20, 20],
    [300, 0, 20, 40],
  ],
  c84i4: [
    [260, 0, 20, 60],
    [320, 0, 20, 40],
  ],
  c84i5: [
    [280, 40, 20, 20],
    [340, 0, 20, 60],
  ],
  c85g: [
    [0, 30, 60, 60],
    [60, 0, 60, 80],
  ],
  c85i0: [[0, 30, 20, 50]],
  c85i1: [[20, 30, 20, 60]],
  c85i2: [[40, 30, 20, 60]],
  c85i3: [[60, 0, 20, 80]],
  c85i4: [[80, 0, 20, 80]],
  c85i5: [[100, 0, 20, 80]],
  c86g: [
    [0, 10, 60, 110],
    [60, 0, 60, 10],
  ],
  c86i0: [
    [0, 10, 20, 110],
    [60, 0, 20, 10],
  ],
  c86i1: [
    [20, 10, 20, 110],
    [80, 0, 20, 10],
  ],
  c87g: [
    [0, 30, 60, 5],
    [60, 0, 60, 35],
  ],
  c87i0: [
    [0, 30, 20, 5],
    [60, 0, 20, 35],
  ],
  c87i1: [
    [20, 30, 20, 5],
    [80, 0, 20, 35],
  ],
  c88g: [
    [0, 10, 60, 70],
    [60, 0, 60, 60],
  ],
  c88i0: [[0, 10, 20, 20]],
  c88i1: [[20, 10, 20, 20]],
  c88i2: [
    [0, 30, 20, 50],
    [60, 0, 20, 60],
  ],
  c88i3: [
    [20, 30, 20, 50],
    [80, 0, 20, 60],
  ],
  c89g: [
    [0, 10, 60, 50],
    [60, 0, 60, 20],
  ],
  c89i0: [[0, 10, 20, 30]],
  c89i1: [
    [20, 10, 20, 50],
    [80, 0, 20, 20],
  ],
  c90g: [
    [0, 10, 60, 30],
    [60, 0, 60, 40],
  ],
  c90i0: [
    [0, 10, 20, 30],
    [60, 0, 20, 40],
  ],
  c90i1: [
    [20, 10, 20, 30],
    [80, 0, 20, 40],
  ],
  c91g: [
    [0, 50, 60, 40],
    [60, 0, 60, 90],
  ],
  c91i0: [[0, 50, 20, 40]],
  c91i1: [[20, 50, 20, 40]],
  c91i2: [[60, 0, 20, 90]],
  c91i3: [[80, 0, 20, 90]],
  c92g: [[0, 0, 60, 50]],
  c92i0: [[0, 0, 20, 50]],
  c92i1: [[20, 0, 20, 50]],
  c92i2: [[40, 10, 20, 40]],
  c93g: [
    [0, 0, 60, 120],
    [60, 0, 60, 50],
  ],
  c93i0: [[0, 0, 20, 80]],
  c93i1: [[20, 70, 20, 10]],
  c93i2: [[40, 0, 20, 60]],
  c93i3: [
    [0, 80, 20, 40],
    [60, 0, 20, 50],
  ],
  c93i4: [
    [20, 80, 20, 40],
    [80, 0, 20, 50],
  ],
  c93i5: [
    [40, 80, 20, 40],
    [100, 0, 20, 20],
  ],
  c94g: [
    [0, 0, 60, 60],
    [60, 0, 60, 60],
    [120, 0, 60, 50],
  ],
  c94i0: [
    [0, 0, 20, 60],
    [60, 0, 20, 60],
    [120, 0, 20, 50],
  ],
  c94i1: [
    [20, 50, 20, 10],
    [80, 0, 20, 60],
  ],
  c94i2: [[40, 0, 20, 20]],
  c95g: [
    [0, 10, 60, 70],
    [60, 0, 60, 80],
    [120, 0, 60, 80],
  ],
  c95i0: [
    [0, 10, 20, 70],
    [60, 0, 20, 40],
  ],
  c95i1: [
    [20, 10, 20, 70],
    [80, 0, 20, 40],
  ],
  c95i2: [
    [40, 10, 20, 70],
    [100, 0, 20, 40],
  ],
  c95i3: [[120, 0, 20, 80]],
  c95i4: [[140, 0, 20, 80]],
  c95i5: [[160, 50, 20, 30]],
  c96g: [
    [0, 0, 60, 100],
    [60, 0, 60, 70],
  ],
  c96i0: [[0, 10, 20, 60]],
  c96i1: [[20, 0, 20, 70]],
  c96i2: [[60, 0, 20, 70]],
  c96i3: [[80, 0, 20, 70]],
  c97g: [
    [120, 0, 60, 40],
    [180, 0, 60, 30],
  ],
  c97i0: [[120, 0, 20, 10]],
  c97i1: [
    [140, 20, 20, 20],
    [200, 0, 20, 30],
  ],
  c97i2: [
    [160, 0, 20, 40],
    [220, 0, 20, 30],
  ],
  c98g: [[0, 0, 60, 100]],
  c98i0: [[0, 0, 20, 50]],
  c98i1: [[20, 0, 20, 50]],
  c98i2: [[0, 50, 20, 50]],
  c98i3: [[20, 50, 20, 50]],
  c99g: [
    [0, 10, 60, 90],
    [60, 0, 60, 100],
    [120, 0, 60, 20],
  ],
  c99i0: [
    [0, 10, 20, 90],
    [60, 0, 20, 40],
  ],
  c99i1: [
    [20, 10, 20, 90],
    [80, 0, 20, 40],
  ],
  c99i2: [
    [40, 10, 20, 90],
    [100, 0, 20, 40],
  ],
  c99i3: [
    [60, 40, 20, 60],
    [120, 0, 20, 20],
  ],
  c99i4: [[80, 40, 20, 50]],
  c99i5: [
    [100, 40, 20, 60],
    [160, 0, 20, 20],
  ],
};

/** The cases known to differ from Chromium (`KNOWN` in the script). */
export const GRID_ROWS_KNOWN: string[] = [
  'c3',
  'c4',
  'c8',
  'c13',
  'c15',
  'c19',
  'c20',
  'c21',
  'c40',
  'c46',
  'c57',
  'c59',
  'c60',
  'c67',
  'c79',
  'c80',
  'c83',
  'c84',
];
