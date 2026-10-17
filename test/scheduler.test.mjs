import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.mjs';

function makeScheduler({ lockScreenMode = 'on-lock', locked = false, asleep = false, intervalSeconds = 10 } = {}) {
  const calls = [];
  const store = {
    renders: {},
    runtime: {
      current: null,
      playlist: { queue: [], history: [] },
      rotationEnabled: true,
    },
    scheduleSave() {},
    getRender(key) {
      return { key, title: '测试成片', styleId: 'watercolor', photoId: 'photo1' };
    },
  };
  const config = {
    rotation: { intervalSeconds, notify: false, applyOnStart: false },
    wallpaper: { lockScreenMode, placement: 1 },
  };
  const wallpaper = {
    async setDesktopFast(image) {
      calls.push(['desktop', image]);
      return { ok: true };
    },
    async storeChoice(image, options) {
      calls.push(['store', image, options]);
      return { ok: true };
    },
    async restartAgent() {
      calls.push(['restart']);
      return { ok: true };
    },
    async sessionState() {
      return { locked, asleep };
    },
  };
  const logger = { info() {}, warn() {}, ok() {}, error() {}, debug() {} };
  const scheduler = new Scheduler({ store, config, wallpaper, logger });
  return { scheduler, calls, store };
}

test('apply uses the fast desktop channel on every tick', async () => {
  const { scheduler, calls } = makeScheduler();
  const key = await scheduler.apply('photo1.watercolor', 'test');
  assert.equal(key, 'photo1.watercolor');
  assert.equal(calls[0][0], 'desktop');
  assert.equal(calls[0][1].endsWith('photo1.watercolor.jpg'), true);
});

test('on-lock mode stores the lock choice without restarting the agent', async () => {
  const { scheduler, calls } = makeScheduler({ lockScreenMode: 'on-lock' });
  await scheduler.apply('photo1.watercolor', 'test');
  const store = calls.find((c) => c[0] === 'store');
  assert.ok(store);
  assert.equal(store[2].lock, true);
  assert.equal(store[2].restart, false);
  assert.equal(calls.some((c) => c[0] === 'restart'), false);
});

test('each mode restarts the agent so the lock screen follows every change', async () => {
  const { scheduler, calls } = makeScheduler({ lockScreenMode: 'each' });
  await scheduler.apply('photo1.watercolor', 'test');
  const store = calls.find((c) => c[0] === 'store');
  assert.equal(store[2].restart, true);
});

test('off mode only touches the desktop', async () => {
  const { scheduler, calls } = makeScheduler({ lockScreenMode: 'off' });
  await scheduler.apply('photo1.watercolor', 'test');
  assert.equal(calls.some((c) => c[0] === 'store'), false);
});

test('locking pauses rotation and flushes the lock screen once', async () => {
  const { scheduler, calls } = makeScheduler({ locked: true });
  scheduler.enabled = true;
  scheduler.timer = setTimeout(() => {}, 60_000);
  await scheduler.pollScreen();
  assert.equal(scheduler.screenInactive, true);
  assert.equal(scheduler.timer, null);
  assert.equal(calls.filter((c) => c[0] === 'restart').length, 1);
  // A second poll while still locked must not restart again.
  await scheduler.pollScreen();
  assert.equal(calls.filter((c) => c[0] === 'restart').length, 1);
});

test('lock mode off never restarts the agent on lock', async () => {
  const { scheduler, calls } = makeScheduler({ locked: true, lockScreenMode: 'off' });
  scheduler.enabled = true;
  await scheduler.pollScreen();
  assert.equal(calls.some((c) => c[0] === 'restart'), false);
});

test('unlocking resumes the rotation timer', async () => {
  const { scheduler } = makeScheduler({ locked: false });
  scheduler.enabled = true;
  scheduler.screenInactive = true;
  await scheduler.pollScreen();
  assert.equal(scheduler.screenInactive, false);
  assert.ok(scheduler.timer);
  clearTimeout(scheduler.timer);
});

test('interval 0 means manual mode, positive values pass through', async () => {
  const manual = makeScheduler({ intervalSeconds: 0 });
  assert.equal(manual.scheduler.intervalSeconds, 0);
  assert.equal(manual.scheduler.intervalMs, 0);
  manual.scheduler.enabled = true;
  await manual.scheduler.applyKey('photo1.watercolor');
  assert.equal(manual.scheduler.timer, null);
  assert.equal(manual.store.runtime.current.nextAt, null);

  const fast = makeScheduler({ intervalSeconds: 1 });
  assert.equal(fast.scheduler.intervalSeconds, 1);
  assert.equal(fast.scheduler.intervalMs, 1000);
});
