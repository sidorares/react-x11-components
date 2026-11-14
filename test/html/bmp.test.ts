import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bmpSize, decodeBmp } from '../../src/html/bmp.js';
import { headerSize } from '../../src/html/image-header.js';
import { decodesImageType } from '../../src/html/image-types.js';

const le32 = (n: number): number[] => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];

/** A BMP of an info header, the pixels' rows as they are stored. */
function bmp(
  width: number,
  height: number,
  bits: number,
  rows: number[][],
  extra: { compression?: number; palette?: number[][]; masks?: number[] } = {},
): Uint8Array {
  const masks = (extra.masks ?? []).flatMap(le32);
  const palette = (extra.palette ?? []).flatMap(([r, g, b]) => [b, g, r, 0]);
  const stride = ((bits * width + 31) >>> 5) * 4;
  const pixels = rows.flatMap((row) => [
    ...row,
    ...new Array(stride - row.length).fill(0),
  ]);
  const offset = 54 + masks.length + palette.length;
  return Uint8Array.from([
    0x42,
    0x4d,
    ...le32(offset + pixels.length),
    0,
    0,
    0,
    0,
    ...le32(offset),
    ...le32(40),
    ...le32(width),
    ...le32(height),
    ...le16(1),
    ...le16(bits),
    ...le32(extra.compression ?? 0),
    ...le32(pixels.length),
    ...le32(2835),
    ...le32(2835),
    ...le32((extra.palette ?? []).length),
    ...le32(0),
    ...masks,
    ...palette,
    ...pixels,
  ]);
}

const pixel = (
  d: { data: Uint8Array; width: number },
  x: number,
  y: number,
) => [...d.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 4)];

test('a 24-bit BMP is read bottom row first, its pixels BGR, as WPT’s image.py writes one', () => {
  // two by two: the stored first row is the image's last
  const file = bmp(2, 2, 24, [
    [0, 0, 255, 0, 255, 0], // bottom: red, green
    [255, 0, 0, 255, 255, 255], // top: blue, white
  ]);
  const d = decodeBmp(file)!;
  assert.equal(d.width, 2);
  assert.equal(d.height, 2);
  assert.deepEqual(pixel(d, 0, 0), [0, 0, 255, 255]);
  assert.deepEqual(pixel(d, 1, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixel(d, 0, 1), [255, 0, 0, 255]);
  assert.deepEqual(pixel(d, 1, 1), [0, 255, 0, 255]);
  assert.deepEqual(headerSize(file), { width: 2, height: 2 });
  assert.deepEqual(bmpSize(file), { width: 2, height: 2 });
});

test('a palette and bit fields are read, a negative height is rows from the top, and a 32-bit one is opaque unless a field names alpha', () => {
  const palette = [
    [10, 20, 30],
    [200, 100, 50],
  ];
  const one = decodeBmp(bmp(3, 1, 1, [[0b01000000]], { palette }))!;
  assert.deepEqual(
    [0, 1, 2].map((x) => pixel(one, x, 0)),
    [
      [10, 20, 30, 255],
      [200, 100, 50, 255],
      [10, 20, 30, 255],
    ],
  );
  const eight = decodeBmp(bmp(2, 1, 8, [[1, 0]], { palette }))!;
  assert.deepEqual(pixel(eight, 0, 0), [200, 100, 50, 255]);
  // top-down, BGRX, and the same with an alpha field
  const plain = decodeBmp(
    bmp(1, -2, 32, [
      [3, 2, 1, 0],
      [6, 5, 4, 0],
    ]),
  )!;
  assert.deepEqual(pixel(plain, 0, 0), [1, 2, 3, 255]);
  assert.deepEqual(pixel(plain, 0, 1), [4, 5, 6, 255]);
  const alpha = decodeBmp(
    bmp(1, 1, 32, [[3, 2, 1, 128]], {
      compression: 6,
      masks: [0xff0000, 0xff00, 0xff, 0xff000000],
    }),
  )!;
  assert.deepEqual(pixel(alpha, 0, 0), [1, 2, 3, 128]);
  // 16 bits, 5-5-5 by default
  const sixteen = decodeBmp(bmp(1, 1, 16, [le16(0b0_11111_00000_00000)]))!;
  assert.deepEqual(pixel(sixteen, 0, 0), [255, 0, 0, 255]);
});

test('what is no BMP read here is none: another format, RLE, and bytes cut short', () => {
  assert.equal(decodeBmp(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(decodeBmp(bmp(1, 1, 8, [[0]], { compression: 1 })), null);
  const whole = bmp(4, 4, 24, new Array(4).fill(new Array(12).fill(9)));
  assert.equal(decodeBmp(whole.slice(0, whole.length - 20)), null);
  assert.equal(decodesImageType('image/bmp'), true);
});
