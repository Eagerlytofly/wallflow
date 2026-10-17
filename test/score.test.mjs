import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignStyles,
  interleaveByCategory,
  rejectionReason,
  scorePhoto,
  selectPhotos,
} from '../src/score.mjs';

const CONFIG = {
  scan: { minWidth: 1200, minMegapixels: 1.2, skipScreenshots: true },
  selection: {
    count: 6,
    minScore: 0.3,
    maxPerTagOverlap: 0.55,
    quotas: { person: 2, animal: 2, landscape: 2, urban: 1 },
  },
};

function photo(overrides = {}) {
  const base = {
    id: Math.random().toString(36).slice(2, 12),
    status: 'analyzed',
    width: 4000,
    height: 3000,
    category: 'landscape',
    aesthetic: { score: 0.7, isUtility: false },
    metrics: { sharpness: 0.8, brightness: 0.5, contrast: 0.25, colorfulness: 0.5 },
    tags: [{ id: 'outdoor', confidence: 0.9 }],
    faces: [],
    salient: [],
    phash: 'ffffffffffffffff',
    textChars: 0,
  };
  return { ...base, ...overrides, id: overrides.id ?? base.id };
}

test('scorePhoto prefers beautiful, sharp, high-resolution photos', () => {
  const good = photo({ aesthetic: { score: 0.9 }, metrics: { sharpness: 0.95, brightness: 0.5, colorfulness: 0.6 } });
  const flat = photo({ aesthetic: { score: 0.35 }, metrics: { sharpness: 0.4, brightness: 0.5, colorfulness: 0.2 } });
  assert.ok(scorePhoto(good) > scorePhoto(flat));
  assert.ok(scorePhoto(good) <= 1 && scorePhoto(good) >= 0);
});

test('scorePhoto penalises utility screenshots and heavy text', () => {
  const normal = photo({ aesthetic: { score: 0.7, isUtility: false } });
  const utility = photo({ aesthetic: { score: 0.7, isUtility: true } });
  const texty = photo({ textChars: 500 });
  assert.ok(scorePhoto(utility) < scorePhoto(normal));
  assert.ok(scorePhoto(texty) < scorePhoto(normal));
});

function scored(overrides = {}) {
  const p = photo(overrides);
  p.score = scorePhoto(p);
  return p;
}

test('rejectionReason gates tiny, blurry and screenshot images', () => {
  assert.equal(rejectionReason(scored({ width: 800, height: 600 }), CONFIG), '分辨率太低');
  assert.equal(rejectionReason(scored({ metrics: { sharpness: 0.01, brightness: 0.5, colorfulness: 0.4 } }), CONFIG), '画面模糊');
  assert.equal(rejectionReason(scored({ aesthetic: { score: 0.8, isUtility: true } }), CONFIG), '截屏/文档');
  assert.equal(rejectionReason(scored({ textChars: 400 }), CONFIG), '文字过多');
  assert.equal(rejectionReason(scored(), CONFIG), null);
});

test('selectPhotos respects count and category quotas', () => {
  const photos = [];
  for (let i = 0; i < 8; i += 1) {
    photos.push(photo({ id: `p${i}`, category: 'person', tags: [{ id: `person${i}`, confidence: 0.9 }], phash: `${i.toString(16).repeat(16)}` }));
    photos.push(photo({ id: `a${i}`, category: 'animal', tags: [{ id: `animal${i}`, confidence: 0.9 }], phash: `${(i + 4).toString(16).repeat(16)}` }));
    photos.push(photo({ id: `l${i}`, category: 'landscape', tags: [{ id: `land${i}`, confidence: 0.9 }], phash: `${(i + 8).toString(16).repeat(16)}` }));
  }
  photos.forEach((p) => { p.score = scorePhoto(p); });
  const result = selectPhotos(photos, CONFIG);
  assert.equal(result.selected.length, CONFIG.selection.count);
  const counts = {};
  for (const p of result.selected) counts[p.category] = (counts[p.category] ?? 0) + 1;
  assert.ok(counts.person <= 2);
  assert.ok(counts.animal <= 2);
  assert.ok(counts.landscape <= 2);
});

test('selectPhotos drops near-duplicates by perceptual hash', () => {
  const a = photo({ id: 'dup1', phash: '0000000000000000' });
  const b = photo({ id: 'dup2', phash: '0000000000000001' });
  a.score = scorePhoto(a);
  b.score = scorePhoto(b);
  const result = selectPhotos([a, b], { ...CONFIG, selection: { ...CONFIG.selection, count: 10, quotas: {} } });
  assert.equal(result.selected.length, 1);
  assert.equal(result.rejected.get('dup2'), '重复/连拍');
});

test('interleaveByCategory alternates categories', () => {
  const photos = [
    ...Array.from({ length: 3 }, (_, i) => photo({ id: `p${i}`, category: 'person' })),
    ...Array.from({ length: 3 }, (_, i) => photo({ id: `a${i}`, category: 'animal' })),
    ...Array.from({ length: 2 }, (_, i) => photo({ id: `l${i}`, category: 'landscape' })),
  ];
  const out = interleaveByCategory(photos).map((p) => p.category);
  assert.deepEqual(out.slice(0, 6), ['person', 'animal', 'landscape', 'person', 'animal', 'landscape']);
});

test('assignStyles spreads styles in round-robin order', () => {
  const photos = Array.from({ length: 5 }, (_, i) => photo({ id: `x${i}` }));
  const map = assignStyles(photos, ['a', 'b', 'c'], 1);
  assert.deepEqual([...map.values()].map((s) => s[0]), ['a', 'b', 'c', 'a', 'b']);
});
