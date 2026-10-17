import test from 'node:test';
import assert from 'node:assert/strict';
import { hammingDistance, smartCrop } from '../src/image.mjs';

function overlap(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

test('smartCrop fills the exact target aspect ratio', () => {
  const crop = smartCrop({ width: 4000, height: 3000, targetWidth: 2560, targetHeight: 1440 });
  assert.ok(Math.abs(crop.width / crop.height - 16 / 9) < 0.01);
  assert.ok(crop.left >= 0 && crop.top >= 0);
  assert.ok(crop.left + crop.width <= 4000);
  assert.ok(crop.top + crop.height <= 3000);
});

test('smartCrop keeps a face near the top of a landscape photo', () => {
  const width = 4000;
  const height = 3000;
  const face = { x: 0.42, y: 0.8, w: 0.16, h: 0.14, quality: 0.8 };
  const crop = smartCrop({
    width,
    height,
    targetWidth: 2560,
    targetHeight: 1440,
    faces: [face],
  });
  const box = {
    x: face.x * width,
    y: (1 - face.y - face.h) * height,
    w: face.w * width,
    h: face.h * height,
  };
  const win = { x: crop.left, y: crop.top, w: crop.width, h: crop.height };
  const ratio = overlap(win, box) / (box.w * box.h);
  assert.ok(ratio > 0.9, `face should be fully inside the crop (got ${ratio})`);
  assert.ok(crop.top < 500, `crop should move up to keep the face (top=${crop.top})`);
});

test('smartCrop keeps a portrait subject when converting to 16:9', () => {
  const width = 3000;
  const height = 4000;
  const face = { x: 0.4, y: 0.45, w: 0.2, h: 0.18, quality: 0.7 };
  const crop = smartCrop({ width, height, targetWidth: 2560, targetHeight: 1440, faces: [face] });
  const box = {
    x: face.x * width,
    y: (1 - face.y - face.h) * height,
    w: face.w * width,
    h: face.h * height,
  };
  const win = { x: crop.left, y: crop.top, w: crop.width, h: crop.height };
  assert.ok(overlap(win, box) / (box.w * box.h) > 0.95);
  assert.ok(crop.height < height);
  assert.ok(crop.left + crop.width <= width && crop.top + crop.height <= height);
});

test('smartCrop falls back to centre when there is no saliency', () => {
  const crop = smartCrop({ width: 4000, height: 3000, targetWidth: 1000, targetHeight: 1000 });
  assert.equal(crop.width, 3000);
  assert.equal(crop.height, 3000);
  assert.equal(crop.left, 500);
  assert.equal(crop.top, 0);
});

test('hammingDistance counts differing perceptual-hash bits', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0);
  assert.equal(hammingDistance('0000000000000000', '000000000000000f'), 4);
  assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
});
