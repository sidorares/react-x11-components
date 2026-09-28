// A second X client that watches a window it does not own: GetImage back to
// back over `box`, each sample compared with the first inside the `cards`
// rects less the `exclude` ones — pixels that must not change while it runs.
// In a process of its own, so the app's event loop and its frame timing are
// untouched by the reading. Prints one JSON line.
//
//   node watch.mjs '{"wid":123,"box":{x,y,w,h},"cards":[…],"exclude":[…],"ms":3000,"out":"dir"}'
//
// `out` is optional: with it, the first sample and up to `saves` bad ones are
// written there as PNGs, the watched pixels opaque and the rest dimmed.
import { mkdirSync, writeFileSync } from 'node:fs';

import { PNG } from 'pngjs';
import x11 from 'x11';

const cfg = JSON.parse(process.argv[2]);
const { wid, box, cards, ms, out } = cfg;
const saves = cfg.saves ?? 8;
if (out) mkdirSync(out, { recursive: true });

const mask = new Uint8Array(box.w * box.h);
const paint = (rects, value) => {
  for (const r of rects) {
    for (
      let y = Math.max(r.y, box.y);
      y < Math.min(r.y + r.h, box.y + box.h);
      y++
    ) {
      for (
        let x = Math.max(r.x, box.x);
        x < Math.min(r.x + r.w, box.x + box.w);
        x++
      ) {
        mask[(y - box.y) * box.w + (x - box.x)] = value;
      }
    }
  }
};
paint(cards, 1);
paint(cfg.exclude ?? [], 0);

const save = (name, data) => {
  if (!out) return;
  const png = new PNG({ width: box.w, height: box.h });
  for (let i = 0; i < box.w * box.h; i++) {
    // ZPixmap from a little-endian server with the standard visual: BGRx
    png.data[i * 4] = data[i * 4 + 2];
    png.data[i * 4 + 1] = data[i * 4 + 1];
    png.data[i * 4 + 2] = data[i * 4];
    png.data[i * 4 + 3] = mask[i] ? 255 : 150;
  }
  writeFileSync(`${out}/${name}.png`, PNG.sync.write(png));
};

/** The watched pixels two samples disagree on: a count and the box round them. */
const diff = (a, b) => {
  let n = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2])
      continue;
    n++;
    const x = i % box.w;
    const y = (i / box.w) | 0;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return n
    ? { n, x: x0 + box.x, y: y0 + box.y, w: x1 - x0 + 1, h: y1 - y0 + 1 }
    : null;
};

x11.createClient((err, display) => {
  if (err) throw err;
  const X = display.client;
  X.on('error', (e) => {
    console.log(JSON.stringify({ error: String(e.message ?? e) }));
    process.exit(1);
  });
  let ref = null;
  let samples = 0;
  let bad = 0;
  let saved = 0;
  let runs = 0;
  let inRun = false;
  const events = [];
  const t0 = performance.now();
  const next = () => {
    X.GetImage(2, wid, box.x, box.y, box.w, box.h, 0xffffffff, (e, img) => {
      if (e) {
        console.log(JSON.stringify({ error: String(e.message ?? e) }));
        process.exit(1);
      }
      const t = performance.now() - t0;
      if (!ref) {
        ref = Buffer.from(img.data);
        save('ref', ref);
      } else {
        samples++;
        const d = diff(ref, img.data);
        if (d) {
          bad++;
          if (!inRun) runs++;
          inRun = true;
          if (events.length < 20) events.push({ t: Math.round(t), ...d });
          if (saved < saves)
            save(`bad-${saved++}-${Math.round(t)}ms`, img.data);
        } else {
          inRun = false;
        }
      }
      if (t < ms) next();
      else {
        const rate = Math.round(samples / (t / 1000));
        console.log(JSON.stringify({ samples, rate, bad, runs, events }));
        process.exit(0);
      }
    });
  };
  next();
});
