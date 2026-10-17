import test from 'node:test';
import assert from 'node:assert/strict';
import { Playlist } from '../src/playlist.mjs';

test('a shuffle bag shows every key once before repeating', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  const playlist = new Playlist({ seed: 42 });
  playlist.reset(keys);
  const seen = [];
  for (let i = 0; i < keys.length; i += 1) seen.push(playlist.next());
  assert.deepEqual(new Set(seen), new Set(keys));
  assert.equal(seen.length, keys.length);
});

test('reset can exclude the currently displayed key', () => {
  const playlist = new Playlist({ seed: 1 });
  playlist.reset(['a', 'b', 'c'], { exclude: 'a' });
  const seen = [playlist.next(), playlist.next()];
  assert.ok(!seen.includes('a'));
});

test('new renders can be spliced into the upcoming queue', () => {
  const playlist = new Playlist({ seed: 7 });
  playlist.reset(['a', 'b', 'c']);
  assert.equal(playlist.add('new'), true);
  assert.equal(playlist.add('new'), false, 'no duplicates');
  let count = 0;
  while (playlist.next()) count += 1;
  assert.equal(count, 4);
});

test('history keeps the most recent keys, newest first', () => {
  const playlist = new Playlist({ seed: 3 });
  playlist.reset(['a', 'b']);
  playlist.next();
  const second = playlist.next();
  assert.equal(playlist.history[0], second);
  assert.equal(playlist.history.length, 2);
});

test('removing a key prevents it from being shown', () => {
  const playlist = new Playlist({ seed: 5 });
  playlist.reset(['a', 'b', 'c']);
  playlist.remove('a');
  const seen = [];
  let key = playlist.next();
  while (key) {
    seen.push(key);
    key = playlist.next();
  }
  assert.deepEqual(seen.sort(), ['b', 'c']);
});
