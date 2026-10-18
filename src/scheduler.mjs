import { execFile } from 'node:child_process';
import path from 'node:path';
import { WALLPAPERS_DIR } from './config.mjs';
import { Playlist } from './playlist.mjs';
import { existsSync } from './util.mjs';

/**
 * Rotation is decoupled from generation: it only ever looks at finished
 * renders, so playback never blocks on the model.
 *
 * Two wallpaper channels are used:
 *  - fast desktop (NSWorkspace, ~10 ms, no flicker) on every tick
 *  - wallpaper store + WallpaperAgent restart only when needed for the lock
 *    screen (default: when the screen locks), because that restart flashes.
 */
export class Scheduler {
  constructor({ store, config, wallpaper, logger, onUpdate }) {
    this.store = store;
    this.config = config;
    this.wallpaper = wallpaper;
    this.logger = logger;
    this.onUpdate = onUpdate ?? (() => {});
    this.timer = null;
    this.lockTimer = null;
    this.healthTimer = null;
    this.lastHealthWarn = 0;
    this.enabled = false;
    this.ticking = null;
    this.screenInactive = false;
    this.lastError = null;
    this.warnedFlash = false;
    const saved = store.runtime.playlist ?? {};
    this.playlist = new Playlist({ queue: saved.queue ?? [], history: saved.history ?? [] });
  }

  get intervalSeconds() {
    const value = Number(this.config.rotation.intervalSeconds);
    return Number.isFinite(value) ? Math.max(0, value) : 1800;
  }

  get intervalMs() {
    return this.intervalSeconds * 1000;
  }

  get lockMode() {
    return this.config.wallpaper.lockScreenMode ?? 'on-lock';
  }

  readyKeys() {
    return Object.values(this.store.renders)
      .filter((r) => r.status === 'done' && existsSync(path.join(WALLPAPERS_DIR, `${r.key}.jpg`)))
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
      .map((r) => r.key);
  }

  async start({ applyNow = false } = {}) {
    this.enabled = true;
    this.store.runtime.rotationEnabled = true;
    this.syncPlaylist();
    this.store.scheduleSave();
    this.startScreenWatcher();
    this.logger?.info(this.intervalSeconds > 0 ? '壁纸轮播已开启' : '自动轮播已关闭（手动切换）', {
      intervalSeconds: this.intervalSeconds,
      lockMode: this.lockMode,
    });
    if (this.lockMode === 'each' && this.intervalSeconds <= 30 && !this.warnedFlash) {
      this.warnedFlash = true;
      this.logger?.warn('锁屏同步为「每次」，短间隔下每次都会重启 WallpaperAgent，可能出现闪烁；建议改成「锁屏时同步」');
    }
    if (applyNow) {
      await this.tick({ reason: 'start', force: true });
    } else if (!this.store.runtime.current) {
      this.scheduleNext(1500);
    } else {
      this.alignNextAt();
      this.scheduleNext();
    }
    this.onUpdate({ type: 'rotation', enabled: true });
  }

  stop() {
    if (this.intervalSeconds === 0) {
      const current = this.store.runtime.current;
      if (current?.nextAt) {
        current.nextAt = null;
        this.store.scheduleSave();
      }
    }
    if (!this.enabled) {
      this.clearTimer();
      this.stopScreenWatcher();
      return;
    }
    this.enabled = false;
    this.store.runtime.rotationEnabled = false;
    this.store.scheduleSave();
    this.clearTimer();
    this.stopScreenWatcher();
    this.logger?.info('壁纸轮播已暂停');
    this.onUpdate({ type: 'rotation', enabled: false });
  }

  /** Process exit: keep the user's rotation preference for next launch. */
  dispose() {
    this.clearTimer();
    this.stopScreenWatcher();
  }

  startScreenWatcher() {
    if (this.lockTimer) return;
    this.lockTimer = setInterval(() => {
      this.pollScreen().catch((err) => this.logger?.debug(`屏幕状态检查失败：${err.message}`));
    }, 2500);
    this.healthTimer = setInterval(() => this.checkHealth(), 10_000);
    this.lockTimer.unref?.();
    this.pollScreen().catch(() => {});
  }

  stopScreenWatcher() {
    if (this.lockTimer) {
      clearInterval(this.lockTimer);
      this.lockTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /** Recover a timer that was lost while the Mac slept or the screen locked. */
  checkHealth() {
    if (!this.enabled || this.intervalSeconds <= 0 || this.screenInactive || this.ticking) return;
    const current = this.store.runtime.current;
    if (!current) {
      if (!this.timer) this.scheduleNext(1000);
      return;
    }
    const applied = Date.parse(current.appliedAt);
    if (!Number.isFinite(applied)) return;
    const due = applied + this.intervalMs;
    const overdue = Date.now() - due;
    if (!this.timer || overdue > Math.max(this.intervalMs, 10_000)) {
      if (Date.now() - this.lastHealthWarn > 60_000) {
        this.lastHealthWarn = Date.now();
        this.logger?.warn(`轮播计时器未按计划运行，自动恢复（延迟 ${Math.round(overdue / 1000)} 秒）`);
      }
      if (overdue > 0) {
        this.tick({ reason: 'watchdog' }).catch((err) => this.logger?.warn(`自动恢复失败：${err.message}`));
      } else {
        this.scheduleNext(Math.max(1000, due - Date.now()));
      }
    }
  }

  /**
   * While the screen is locked or asleep, stop rotating (nobody is looking).
   * On the lock transition, flush the latest wallpaper into the lock screen
   * by restarting WallpaperAgent once — the flash happens while locking.
   */
  async pollScreen() {
    if (!this.enabled) return;
    const state = await this.wallpaper.sessionState().catch(() => null);
    if (!state) return;
    const inactive = Boolean(state.locked || state.asleep);
    if (inactive && !this.screenInactive) {
      this.screenInactive = true;
      this.clearTimer();
      if (state.locked && this.lockMode !== 'off') {
        try {
          await this.wallpaper.restartAgent();
          this.logger?.info('屏幕已锁定，锁屏壁纸已同步');
        } catch (err) {
          this.logger?.warn(`锁屏壁纸同步失败：${err.message}`);
        }
      }
      this.onUpdate({ type: 'screen', inactive: true });
    } else if (!inactive && this.screenInactive) {
      this.screenInactive = false;
      this.logger?.info('屏幕已解锁，继续轮播');
      this.scheduleNext(1500);
      this.onUpdate({ type: 'screen', inactive: false });
    }
  }

  syncPlaylist() {
    const ready = this.readyKeys();
    const known = new Set([
      ...this.playlist.queue,
      ...this.playlist.history,
      this.store.runtime.current?.key,
    ].filter(Boolean));
    let added = 0;
    for (const key of ready) {
      if (!known.has(key) && this.playlist.add(key)) added += 1;
    }
    if (added) this.logger?.info(`轮播已补入 ${added} 张成片`);
    return added;
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  scheduleNext(delayMs = null) {
    this.clearTimer();
    if (!this.enabled || this.intervalMs <= 0) return;
    const current = this.store.runtime.current;
    let delay = delayMs;
    if (delay == null) {
      const nextAt = current?.nextAt ? new Date(current.nextAt).getTime() : 0;
      delay = nextAt > Date.now() ? nextAt - Date.now() : 5000;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick({ reason: 'timer' }).catch((err) => this.logger?.error(`轮播失败：${err.message}`));
    }, Math.max(1000, delay));
    this.timer.unref?.();
  }

  async tick({ reason = 'timer', force = false } = {}) {
    if (!force && !this.enabled) return null;
    if (!force && this.screenInactive) return null;
    if (this.ticking) {
      if (!force) return this.ticking;
      // A manual "next" must not be swallowed by an in-flight timer tick.
      await this.ticking.catch(() => {});
    }
    this.ticking = (async () => {
      const ready = this.readyKeys();
      if (!ready.length) {
        this.logger?.warn('还没有可播放的成片，等生成队列产出第一张');
        this.scheduleNext(30_000);
        return null;
      }

      const readySet = new Set(ready);
      this.playlist.queue = this.playlist.queue.filter((key) => readySet.has(key));

      const current = this.store.runtime.current;
      if (current && !readySet.has(current.key)) {
        this.logger?.warn('当前壁纸已不在成片库中，自动切换下一张');
      }

      let key = this.playlist.next();
      if (!key) {
        this.playlist.reset(ready, { exclude: current?.key ?? null });
        key = this.playlist.next();
      }
      if (!key) {
        this.logger?.warn('成片库里只有当前这一张，继续等待新成片');
        this.scheduleNext(30_000);
        return null;
      }

      const applied = await this.apply(key, reason);
      if (applied && this.intervalMs > 0) this.scheduleNext(this.intervalMs);
      return applied;
    })();
    try {
      return await this.ticking;
    } finally {
      this.ticking = null;
    }
  }

  async apply(key, reason = 'timer') {
    const render = this.store.getRender(key);
    const file = path.join(WALLPAPERS_DIR, `${key}.jpg`);
    try {
      const fast = await this.wallpaper.setDesktopFast(file);
      if (!fast?.ok) throw new Error(fast?.error || '桌面壁纸设置失败');

      // Persist the choice (Desktop + Idle) without restarting the agent.
      // It becomes visible on the lock screen at the next lock transition.
      // WallpaperAgent can race the NSWorkspace update and rewrite the store
      // with a Desktop-only choice; verify Idle survived and write it again.
      const mode = this.lockMode;
      if (mode !== 'off') {
        const placement = this.config.wallpaper.placement ?? 1;
        const restart = mode === 'each' || this.screenInactive;
        const expected = path.basename(file);
        const writeChoice = () => this.wallpaper.storeChoice(file, { lock: true, placement, restart });
        const idleMatches = async () => {
          if (typeof this.wallpaper.current !== 'function') return true;
          const info = await this.wallpaper.current().catch(() => null);
          return (info?.idle ?? []).some((url) => url.endsWith(expected));
        };
        // Give WallpaperAgent a beat to finish its own NSWorkspace update;
        // writing the store in the same tick is often overwritten.
        await new Promise((resolve) => setTimeout(resolve, 700));
        await writeChoice();
        if (!(await idleMatches())) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          await writeChoice();
          if (!(await idleMatches())) {
            this.logger?.warn('锁屏壁纸写入未生效，稍后会再次同步');
          }
        }
      }

      const appliedAt = new Date();
      const nextAt = this.intervalMs > 0 ? new Date(appliedAt.getTime() + this.intervalMs) : null;
      this.store.runtime.current = {
        key,
        file,
        appliedAt: appliedAt.toISOString(),
        nextAt: nextAt ? nextAt.toISOString() : null,
        title: render?.title ?? '',
        styleId: render?.styleId ?? '',
        photoId: render?.photoId ?? '',
        lockScreen: mode !== 'off',
      };
      this.store.runtime.playlist = this.playlist.toJSON();
      this.store.runtime.lastError = null;
      this.store.scheduleSave();
      this.logger?.ok(`壁纸已切换：${render?.title || key}（${reason}）`, {
        fast: 'NSWorkspace',
        lock: mode === 'off' ? '仅桌面' : mode === 'each' ? '桌面 + 锁屏' : '锁屏随锁定同步',
      });
      this.notify(render);
      this.onUpdate({ type: 'applied', key, reason });
      return key;
    } catch (err) {
      this.lastError = err;
      this.store.runtime.lastError = `壁纸设置失败：${err.message}`;
      this.store.scheduleSave();
      this.logger?.error(`壁纸设置失败：${err.message}`);
      this.scheduleNext(60_000);
      return null;
    }
  }

  async applyKey(key, { reason = 'manual' } = {}) {
    if (!this.store.getRender(key)) throw new Error('找不到这张成片');
    this.playlist.remove(key);
    const applied = await this.apply(key, reason);
    if (applied) this.scheduleNext(this.intervalMs);
    return applied;
  }

  notifyNewRender(key) {
    if (!this.enabled) return;
    const added = this.playlist.add(key);
    if (added) {
      this.store.runtime.playlist = this.playlist.toJSON();
      this.store.scheduleSave();
      this.onUpdate({ type: 'playlist' });
    }
    if (added && !this.store.runtime.current) {
      this.tick({ reason: 'first-render' }).catch(() => {});
    }
  }

  nextUp() {
    const key = this.playlist.peek();
    if (!key) return null;
    const render = this.store.getRender(key);
    return render ? { key, ...render } : null;
  }

  /** Keep nextAt in line with the (possibly just changed) interval. */
  alignNextAt() {
    const current = this.store.runtime.current;
    if (!current?.appliedAt) return;
    if (this.intervalMs <= 0) {
      if (current.nextAt !== null) {
        current.nextAt = null;
        this.store.scheduleSave();
      }
      return;
    }
    const applied = new Date(current.appliedAt).getTime();
    if (!Number.isFinite(applied)) return;
    const next = applied + this.intervalMs;
    if (next <= Date.now()) return;
    current.nextAt = new Date(next).toISOString();
    this.store.scheduleSave();
  }

  reschedule() {
    if (!this.enabled) return;
    this.alignNextAt();
    this.scheduleNext();
  }

  notify(render) {
    if (!this.config.rotation.notify) return;
    const title = '流光壁纸';
    const message = render?.title ? `已切换：${render.title}` : '壁纸已切换';
    execFile('osascript', ['-e', `display notification "${message.replace(/"/g, '')}" with title "${title}"`], () => {});
  }
}
