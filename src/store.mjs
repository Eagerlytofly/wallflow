import fs from 'node:fs';
import { STATE_PATH } from './config.mjs';
import { readJsonSync, writeJsonAtomic, nowIso, todayKey } from './util.mjs';

function defaultState() {
  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    photos: {},
    renders: {},
    runtime: {
      lastScanAt: null,
      lastScanMs: null,
      lastScanError: null,
      current: null, // { key, appliedAt, nextAt }
      playlist: { queue: [], history: [] },
      rotationEnabled: true,
      pipelineRunning: false,
      stats: {
        generated: 0,
        failed: 0,
        costCents: 0,
        day: todayKey(),
        dayCount: 0,
        dayCostCents: 0,
      },
      lastError: null,
    },
  };
}

function mergeState(state) {
  const base = defaultState();
  const merged = { ...base, ...state };
  merged.photos = state?.photos ?? {};
  merged.renders = state?.renders ?? {};
  merged.runtime = { ...base.runtime, ...(state?.runtime ?? {}) };
  merged.runtime.playlist = { ...base.runtime.playlist, ...(state?.runtime?.playlist ?? {}) };
  merged.runtime.stats = { ...base.runtime.stats, ...(state?.runtime?.stats ?? {}) };
  return merged;
}

export class Store {
  constructor(file = STATE_PATH) {
    this.file = file;
    this.state = defaultState();
    this.saveTimer = null;
    this.saving = false;
    this.dirty = false;
  }

  load() {
    const raw = readJsonSync(this.file, null);
    this.state = mergeState(raw);
    this.rollDay();
    return this.state;
  }

  get photos() { return this.state.photos; }
  get renders() { return this.state.renders; }
  get runtime() { return this.state.runtime; }

  photoList() { return Object.values(this.state.photos); }
  renderList() { return Object.values(this.state.renders); }

  getPhoto(id) { return this.state.photos[id] ?? null; }
  getRender(key) { return this.state.renders[key] ?? null; }

  putPhoto(photo) {
    this.state.photos[photo.id] = photo;
    this.scheduleSave();
  }

  putRender(render) {
    this.state.renders[render.key] = render;
    this.scheduleSave();
  }

  removeRender(key) {
    delete this.state.renders[key];
    this.scheduleSave();
  }

  rollDay() {
    const stats = this.state.runtime.stats;
    const day = todayKey();
    if (stats.day !== day) {
      stats.day = day;
      stats.dayCount = 0;
      stats.dayCostCents = 0;
    }
  }

  recordRenderDone({ costCents = 0 }) {
    this.rollDay();
    const stats = this.state.runtime.stats;
    stats.generated += 1;
    stats.dayCount += 1;
    stats.costCents += costCents;
    stats.dayCostCents += costCents;
    this.scheduleSave();
  }

  recordRenderFailed() {
    this.rollDay();
    this.state.runtime.stats.failed += 1;
    this.scheduleSave();
  }

  scheduleSave(delay = 350) {
    this.dirty = true;
    this.state.updatedAt = nowIso();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((err) => {
        process.stderr.write(`state save failed: ${err.message}\n`);
      });
    }, delay);
    this.saveTimer.unref?.();
  }

  async flush() {
    if (!this.dirty || this.saving) return;
    this.saving = true;
    this.dirty = false;
    try {
      await writeJsonAtomic(this.file, this.state);
    } finally {
      this.saving = false;
      if (this.dirty) this.scheduleSave(120);
    }
  }

  flushSync() {
    if (!this.dirty) return;
    fs.writeFileSync(this.file, JSON.stringify(this.state));
    this.dirty = false;
  }

  summary() {
    const photos = this.photoList();
    const renders = this.renderList();
    const stats = this.state.runtime.stats;
    return {
      photos: photos.length,
      selected: photos.filter((p) => p.selected).length,
      analyzed: photos.filter((p) => p.status === 'analyzed').length,
      ready: renders.filter((r) => r.status === 'done').length,
      failedRenders: renders.filter((r) => r.status === 'failed').length,
      costCents: stats.costCents,
      dayCount: stats.dayCount,
      dayCostCents: stats.dayCostCents,
      day: stats.day,
      lastScanAt: this.state.runtime.lastScanAt,
    };
  }
}
