import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLES, buildPrompt, enabledStyles, styleById } from '../src/styles.mjs';
import { renderKey, parseRenderKey } from '../src/pipeline.mjs';
import { estimateCostCents } from '../src/ark.mjs';

const CONFIG = { styles: { enabled: ['watercolor', 'ghibli'], custom: {} } };

test('every style has the metadata the UI needs', () => {
  for (const style of STYLES) {
    assert.ok(style.id && style.name && style.hint && style.prompt);
    assert.match(style.accent, /^#[0-9a-f]{6}$/i);
  }
});

test('buildPrompt keeps the subject and forbids text/watermarks', () => {
  const prompt = buildPrompt('watercolor', 'person', CONFIG);
  assert.match(prompt, /水彩/);
  assert.match(prompt, /面部特征/);
  assert.match(prompt, /不要添加任何文字/);
  assert.match(prompt, /16:9/);
});

test('buildPrompt uses category-specific preservation', () => {
  const animal = buildPrompt('ghibli', 'animal', CONFIG);
  const landscape = buildPrompt('ghibli', 'landscape', CONFIG);
  assert.match(animal, /毛色/);
  assert.match(landscape, /山脊线/);
  assert.notEqual(animal, landscape);
});

test('custom prompts override the preset but keep the guard rails', () => {
  const config = { styles: { enabled: ['watercolor'], custom: { watercolor: '只用两种颜色' } } };
  const prompt = buildPrompt('watercolor', 'landscape', config);
  assert.match(prompt, /只用两种颜色/);
  assert.match(prompt, /不要添加任何文字/);
});

test('enabledStyles filters unknown ids and keeps order', () => {
  const list = enabledStyles({ styles: { enabled: ['ghibli', 'nope', 'film'] } });
  assert.deepEqual(list.map((s) => s.id), ['ghibli', 'film']);
});

test('styleById returns null for unknown styles', () => {
  assert.equal(styleById('nope'), null);
  assert.equal(styleById('ink').name, '水墨');
});

test('render keys round-trip', () => {
  const key = renderKey('abc123def456', 'watercolor');
  assert.equal(key, 'abc123def456.watercolor');
  assert.deepEqual(parseRenderKey(key), { photoId: 'abc123def456', styleId: 'watercolor' });
});

test('cost estimate follows the configured unit price', () => {
  assert.equal(estimateCostCents({ ark: { priceCents: 20 } }, 3), 60);
  assert.equal(estimateCostCents({ ark: { priceCents: 0 } }, 3), 0);
});
