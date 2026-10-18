import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  ROOT,
  DATA_DIR,
  WALLPAPERS_DIR,
  RENDER_THUMBS_DIR,
  THUMBS_DIR,
  PREVIEWS_DIR,
  BACKUP_DIR,
  ensureDirs,
  loadConfig,
  saveConfig,
  normalizeIntervalSeconds,
} from './config.mjs';
import { Store } from './store.mjs';
import { Wallpaper, WallpaperError } from './wallpaper.mjs';
import { Scheduler } from './scheduler.mjs';
import { Pipeline, renderKey } from './pipeline.mjs';
import { ArkClient, loadApiKey } from './ark.mjs';
import { STYLES, styleById, enabledStyles, promptPreview, buildPrompt } from './styles.mjs';
import { scanLibrary } from './scan.mjs';
import { ensureVisionBinary } from './vision.mjs';
import { deepMerge, ensureDir, exists, nowIso, todayKey } from './util.mjs';
import { interleaveByCategory } from './score.mjs';

export async function createApp({ logger, autoStart = true } = {}) {
  ensureDirs();
  const config = loadConfig();

  if (!(await exists(path.join(ROOT, 'config.json')))) {
    await saveConfig(config);
    logger.info('已生成 config.json（可编辑照片目录、风格、间隔等）');
  }

  const store = new Store();
  store.load();

  const key = await loadApiKey(config);
  let keySource = key.source;
  let ark = key.key ? new ArkClient({ ...config.ark, apiKey: key.key, logger }) : null;
  if (!ark) logger.warn('没有找到 ARK_API_KEY，风格化生成不可用（扫描/选片仍可本地运行）');

  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  const wallpaper = new Wallpaper({ config, logger });
  const scheduler = new Scheduler({
    store,
    config,
    wallpaper,
    logger,
    onUpdate: (event) => {
      bus.emit('invalidate', event);
      if (event.type === 'applied') refreshScreenInfo().catch(() => {});
    },
  });
  const pipeline = new Pipeline({
    store,
    config,
    ark,
    logger,
    onUpdate: (event) => bus.emit('invalidate', event),
    onRenderDone: (renderId) => {
      scheduler.notifyNewRender(renderId);
      bus.emit('invalidate', { type: 'render', key: renderId });
    },
  });

  async function archiveRemovedStyle(styleId = 'cyberpunk') {
    const renders = Object.values(store.renders).filter((r) => r.styleId === styleId);
    if (!renders.length) return 0;
    const archiveDir = path.join(DATA_DIR, 'archive');
    await ensureDir(archiveDir);
    const removedKeys = new Set();
    for (const render of renders) {
      const wallpaper = path.join(WALLPAPERS_DIR, `${render.key}.jpg`);
      if (await exists(wallpaper)) {
        await fsp.rename(wallpaper, path.join(archiveDir, `${render.key}.jpg`)).catch(() => {});
      }
      const thumb = path.join(RENDER_THUMBS_DIR, `${render.key}.jpg`);
      if (await exists(thumb)) {
        await fsp.rename(thumb, path.join(archiveDir, `${render.key}.thumb.jpg`)).catch(() => {});
      }
      store.removeRender(render.key);
      removedKeys.add(render.key);
    }
    scheduler.playlist.queue = scheduler.playlist.queue.filter((key) => !removedKeys.has(key));
    scheduler.playlist.history = scheduler.playlist.history.filter((key) => !removedKeys.has(key));
    if (removedKeys.has(store.runtime.current?.key)) store.runtime.current = null;
    store.runtime.playlist = scheduler.playlist.toJSON();
    await store.flush();
    logger.info(`已把 ${renders.length} 张旧风格成片移到 data/archive（不再参与轮播）`);
    return renders.length;
  }

  function normalizePhotoStyles() {
    const enabled = config.styles.enabled.filter((id) => styleById(id));
    if (!enabled.length) return 0;
    const selected = store.photoList()
      .filter((photo) => photo.selected)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    let changed = 0;
    selected.forEach((photo, index) => {
      const raw = photo.styles ?? [];
      let styles = raw
        .map((id) => (id === 'cyberpunk' ? 'riso' : id))
        .filter((id) => enabled.includes(id));
      if (!styles.length) styles = [enabled[index % enabled.length]];
      styles = [...new Set(styles)].slice(0, config.styles.perPhoto ?? 1);
      if (JSON.stringify(styles) !== JSON.stringify(raw)) {
        store.putPhoto({ ...photo, styles });
        changed += 1;
      }
    });
    return changed;
  }

  let scanning = false;
  let scanState = { phase: 'idle', done: 0, total: 0 };
  let screens = null;
  let wallpaperInfo = null;
  const startedAt = nowIso();

  async function refreshScreenInfo() {
    try {
      screens = await wallpaper.screens();
      wallpaperInfo = await wallpaper.current();
    } catch (err) {
      logger.warn(`读取壁纸状态失败：${err.message}`);
    }
  }

  async function rebuildArk() {
    const nextKey = await loadApiKey(config);
    keySource = nextKey.source;
    ark = nextKey.key ? new ArkClient({ ...config.ark, apiKey: nextKey.key, logger }) : null;
    pipeline.ark = ark;
    return ark;
  }

  async function startScan() {
    if (scanning) return { already: true };
    scanning = true;
    scanState = { phase: 'start', done: 0, total: 0 };
    bus.emit('invalidate', { type: 'scan', scanState });
    try {
      const stats = await scanLibrary({
        store,
        config,
        logger,
        onProgress: (p) => {
          scanState = p;
          bus.emit('invalidate', { type: 'scan-progress', scanState: p });
        },
      });
      bus.emit('invalidate', { type: 'scan-done', stats });
      if (pipeline.running) {
        pipeline.enqueue(pipeline.plan());
        pipeline.pump();
      }
      return stats;
    } catch (err) {
      logger.error(`扫描失败：${err.message}`);
      bus.emit('invalidate', { type: 'scan-error', message: err.message });
      throw err;
    } finally {
      scanning = false;
      scanState = { phase: 'idle', done: 0, total: 0 };
      bus.emit('invalidate', { type: 'scan', scanState });
    }
  }

  async function updateSettings(patch) {
    // Refuse writes from a tab opened before the seconds-based UI: it would
    // silently turn "30" (minutes) into 1800 seconds and clobber the setting.
    if (patch?.rotation?.intervalMinutes != null && patch.rotation.intervalSeconds == null) {
      const err = new Error('控制台页面已过期，请按 Cmd+Shift+R 刷新后再保存');
      err.hint = '旧页面按「分钟」提交，新版本按「秒」提交，直接换算会把 30 分钟写成 1800 秒。';
      err.statusCode = 409;
      throw err;
    }
    if (typeof patch?.wallpaper?.setLockScreen === 'boolean' && patch.wallpaper.lockScreenMode == null) {
      patch = deepMerge(patch, { wallpaper: { lockScreenMode: patch.wallpaper.setLockScreen ? 'on-lock' : 'off' } });
    }
    const prevLockMode = config.wallpaper.lockScreenMode;
    const prevInterval = config.rotation.intervalSeconds;
    const next = deepMerge(config, patch);
    next.roots = (next.roots ?? []).filter((r) => typeof r === 'string' && r.trim());
    next.scan.maxFiles = Math.max(1, Number(next.scan.maxFiles) || 900);
    next.scan.concurrency = Math.max(1, Math.min(4, Number(next.scan.concurrency) || 3));
    next.selection.count = Math.max(1, Number(next.selection.count) || 48);
    next.ark.concurrency = Math.max(1, Math.min(4, Number(next.ark.concurrency) || 2));
    const rawInterval = next.rotation.intervalSeconds;
    if (rawInterval === '' || rawInterval == null) {
      next.rotation.intervalSeconds = prevInterval;
    } else {
      next.rotation.intervalSeconds = normalizeIntervalSeconds(rawInterval, prevInterval);
    }
    next.output.width = Math.max(1280, Number(next.output.width) || 3840);
    next.output.height = Math.max(720, Number(next.output.height) || 2160);
    next.wallpaper.placement = Math.max(0, Math.min(5, Number(next.wallpaper.placement) || 1));
    if (!['on-lock', 'each', 'off'].includes(next.wallpaper.lockScreenMode)) next.wallpaper.lockScreenMode = 'on-lock';

    Object.keys(config).forEach((k) => delete config[k]);
    Object.assign(config, next);
    await saveConfig(config);

    await rebuildArk();
    if (next.rotation.intervalSeconds === 0) {
      scheduler.stop();
    } else if (prevInterval === 0 && !scheduler.enabled) {
      await scheduler.start({ applyNow: false });
    } else {
      scheduler.reschedule();
    }
    if (prevLockMode !== next.wallpaper.lockScreenMode) {
      await wallpaper.setUnified(next.wallpaper.lockScreenMode !== 'off').catch((err) => logger.warn(`切换锁屏模式失败：${err.message}`));
      await refreshScreenInfo();
    }
    logger.info(`设置已更新：每 ${config.rotation.intervalSeconds} 秒轮播（原 ${prevInterval} 秒） · 锁屏模式 ${config.wallpaper.lockScreenMode}`);
    bus.emit('invalidate', { type: 'settings' });
    return config;
  }

  async function updateStyles({ enabled, custom, perPhoto }) {
    if (Array.isArray(enabled)) config.styles.enabled = enabled.filter((id) => styleById(id));
    if (custom && typeof custom === 'object') config.styles.custom = custom;
    if (perPhoto != null) config.styles.perPhoto = Math.max(1, Math.min(3, Number(perPhoto) || 1));
    await saveConfig(config);
    // Re-distribute styles over the existing selection.
    const selected = interleaveByCategory(
      store.photoList().filter((p) => p.selected).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    );
    const enabledIds = enabledStyles(config).map((s) => s.id);
    const rounds = config.styles.perPhoto ?? 1;
    selected.forEach((photo, index) => {
      const styles = [];
      for (let k = 0; k < Math.min(rounds, enabledIds.length); k += 1) {
        styles.push(enabledIds[(index * rounds + k) % enabledIds.length]);
      }
      store.putPhoto({ ...photo, styles });
    });
    await store.flush();
    if (pipeline.running) {
      pipeline.enqueue(pipeline.plan());
      pipeline.pump();
    }
    logger.info('风格设置已更新', { enabled: enabledIds });
    bus.emit('invalidate', { type: 'styles' });
    return config.styles;
  }

  async function startPipeline() {
    if (!pipeline.ark) throw new Error('还没有可用的火山方舟 API Key，无法生成');
    const added = pipeline.enqueue(pipeline.plan());
    if (!added && !pipeline.queue.length) {
      logger.info('没有待生成任务：选片都已有当前风格的成片');
      return { added: 0, reason: 'all-covered', ...pipeline.status() };
    }
    pipeline.start({ replan: false });
    return { added, ...pipeline.status() };
  }

  async function generateVariants(count = 4) {
    if (!pipeline.ark) throw new Error('还没有可用的火山方舟 API Key，无法生成');
    const enabled = config.styles.enabled.filter((id) => styleById(id));
    if (!enabled.length) throw new Error('没有启用任何风格');
    const limit = Math.max(1, Math.min(12, Math.round(Number(count) || 4)));
    const doneByPhoto = new Map();
    for (const render of store.renderList()) {
      if (render.status !== 'done') continue;
      if (!doneByPhoto.has(render.photoId)) doneByPhoto.set(render.photoId, new Set());
      doneByPhoto.get(render.photoId).add(render.styleId);
    }
    const candidates = store.photoList()
      .filter((photo) => photo.selected)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .map((photo) => {
        const done = doneByPhoto.get(photo.id) ?? new Set();
        return {
          photo,
          done: done.size,
          unused: enabled.filter((id) => !done.has(id)),
        };
      })
      .filter((entry) => entry.unused.length)
      .sort((a, b) => a.done - b.done)
      .slice(0, limit);
    if (!candidates.length) {
      throw new Error('所有选片都已有全部启用风格的成片；请启用新风格或增加选片');
    }
    const chosenIds = new Set();
    for (const entry of candidates) {
      const style = entry.unused[0];
      store.putPhoto({ ...entry.photo, styles: [style] });
      chosenIds.add(entry.photo.id);
    }
    await store.flush();
    const jobs = pipeline.plan().filter((job) => chosenIds.has(job.photoId));
    const added = pipeline.enqueue(jobs);
    if (added) pipeline.start({ replan: false });
    const estimateCents = added * (Number(config.ark.priceCents) || 0);
    logger.info(`换风格生成：加入 ${added} 张（预计 ¥${(estimateCents / 100).toFixed(2)}）`);
    bus.emit('invalidate', { type: 'variants', added });
    return { added, estimateCents, ...pipeline.status() };
  }

  async function state() {
    store.rollDay();
    const photos = store.photoList();
    const renders = store.renderList();
    const current = store.runtime.current;
    const next = scheduler.nextUp();
    const styles = STYLES.map((s) => ({
      id: s.id,
      name: s.name,
      en: s.en,
      emoji: s.emoji,
      accent: s.accent,
      hint: s.hint,
      enabled: config.styles.enabled.includes(s.id),
      custom: config.styles.custom?.[s.id] ?? '',
      promptPreview: promptPreview(s.id, config),
    }));

    return {
      app: {
        name: '流光壁纸',
        version: '0.1.0',
        root: ROOT,
        startedAt,
        dataDir: DATA_DIR,
      },
      config,
      summary: {
        ...store.summary(),
        byCategory: photos.filter((p) => p.selected).reduce((acc, p) => {
          acc[p.category] = (acc[p.category] ?? 0) + 1;
          return acc;
        }, {}),
        photos: photos.length,
        renders: renders.length,
        failedRenders: renders.filter((r) => r.status === 'failed').length,
        pending: photos.filter((p) => p.selected && !renders.some((r) => r.photoId === p.id && r.status === 'done')).length,
        today: todayKey(),
      },
      pipeline: pipeline.status(),
      rotation: {
        enabled: scheduler.enabled,
        intervalSeconds: config.rotation.intervalSeconds,
        intervalMinutes: config.rotation.intervalSeconds / 60,
        lockScreenMode: config.wallpaper.lockScreenMode,
        nextAt: current?.nextAt ?? null,
        nextUp: next ? { key: next.key, title: next.title, styleId: next.styleId, photoId: next.photoId } : null,
      },
      current: current
        ? {
            ...current,
            render: store.getRender(current.key) ?? null,
            photo: store.getPhoto(current.photoId) ?? null,
          }
        : null,
      styles,
      scan: { scanning, ...scanState },
      screens: screens ?? [],
      wallpaper: wallpaperInfo
        ? {
            store: wallpaperInfo.store,
            desktop: wallpaperInfo.desktop,
            idle: wallpaperInfo.idle,
            desktopProvider: wallpaperInfo.desktopProvider,
            idleProvider: wallpaperInfo.idleProvider,
            unified: Boolean(wallpaperInfo.unified),
            screenSaverUnified: Boolean(wallpaperInfo.screenSaverUnified),
          }
        : null,
      ark: { hasKey: Boolean(ark), source: keySource, effectiveModel: pipeline.effectiveModel },
      logs: logger.recent(50),
    };
  }

  function photoSummary(photo, rendersByPhoto, forcedRender = null) {
    const renders = rendersByPhoto.get(photo.id) ?? [];
    const doneList = renders.filter((r) => r.status === 'done');
    const preferred = (photo.styles ?? [])[0];
    const done = forcedRender
      ?? doneList.find((r) => r.styleId === preferred)
      ?? doneList.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]
      ?? null;
    const failed = renders.find((r) => r.status === 'failed') ?? null;
    return {
      id: photo.id,
      name: photo.name,
      width: photo.width,
      height: photo.height,
      category: photo.category,
      score: photo.score,
      aesthetic: photo.aesthetic?.score ?? null,
      isUtility: Boolean(photo.aesthetic?.isUtility),
      selected: Boolean(photo.selected),
      rank: photo.rank ?? null,
      styles: photo.styles ?? [],
      tags: (photo.tags ?? []).slice(0, 6).map((t) => t.id),
      faces: photo.faces?.length ?? 0,
      date: photo.exifDate ?? photo.mtime,
      status: photo.status,
      error: photo.error ?? null,
      thumb: `/media/thumb/${photo.id}.jpg`,
      preview: `/media/preview/${photo.id}.jpg`,
      render: done
        ? {
            key: done.key,
            styleId: done.styleId,
            title: done.title,
            prompt: done.prompt ?? '',
            model: done.model ?? '',
            createdAt: done.createdAt ?? null,
            thumb: `/media/render-thumb/${done.key}.jpg`,
            full: `/media/render/${done.key}.jpg`,
          }
        : null,
      renderStatus: done ? 'done' : failed ? 'failed' : renders.some((r) => r.status === 'running') ? 'running' : null,
      renderError: failed?.error ?? null,
    };
  }

  function listPhotos({ limit = 120, offset = 0, filter = 'all', category = '', q = '' } = {}) {
    const rendersByPhoto = new Map();
    for (const render of Object.values(store.renders)) {
      const list = rendersByPhoto.get(render.photoId) ?? [];
      list.push(render);
      rendersByPhoto.set(render.photoId, list);
    }
    if (filter === 'styled') {
      // One card per finished render, not per photo: a photo may have been
      // generated in several styles (e.g. oil and watercolor), and every
      // finished image should be visible and openable in the gallery.
      let entries = Object.values(store.renders)
        .filter((r) => r.status === 'done')
        .map((render) => ({ render, photo: store.getPhoto(render.photoId) }))
        .filter((entry) => entry.photo);
      if (category) entries = entries.filter((entry) => entry.photo.category === category);
      if (q) {
        const needle = q.toLowerCase();
        entries = entries.filter(({ render, photo }) => (
          photo.name.toLowerCase().includes(needle)
          || (photo.tags ?? []).some((tag) => tag.id.includes(needle))
          || (photo.relPath ?? '').toLowerCase().includes(needle)
          || (render.title ?? '').toLowerCase().includes(needle)
        ));
      }
      entries.sort((a, b) => {
        const rankA = a.photo.rank ?? 999;
        const rankB = b.photo.rank ?? 999;
        if (rankA !== rankB) return rankA - rankB;
        return (b.render.createdAt ?? '').localeCompare(a.render.createdAt ?? '');
      });
      const total = entries.length;
      const page = entries.slice(offset, offset + limit);
      return {
        total,
        offset,
        limit,
        items: page.map(({ render, photo }) => photoSummary(photo, rendersByPhoto, render)),
      };
    }

    let photos = store.photoList();
    if (filter === 'selected') photos = photos.filter((p) => p.selected);
    if (filter === 'pending') photos = photos.filter((p) => p.selected && !(rendersByPhoto.get(p.id) ?? []).some((r) => r.status === 'done'));
    if (filter === 'rejected') photos = photos.filter((p) => !p.selected);
    if (category) photos = photos.filter((p) => p.category === category);
    if (q) {
      const needle = q.toLowerCase();
      photos = photos.filter((p) => {
        if (p.name.toLowerCase().includes(needle)) return true;
        if ((p.tags ?? []).some((t) => t.id.includes(needle))) return true;
        if ((p.relPath ?? '').toLowerCase().includes(needle)) return true;
        return false;
      });
    }
    photos.sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1;
      if (a.selected && b.selected) return (a.rank ?? 999) - (b.rank ?? 999);
      return (b.score ?? 0) - (a.score ?? 0);
    });
    const total = photos.length;
    const page = photos.slice(offset, offset + limit);
    return { total, offset, limit, items: page.map((p) => photoSummary(p, rendersByPhoto)) };
  }

  function listRenders({ limit = 200, offset = 0 } = {}) {
    const renders = store.renderList().sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    const total = renders.length;
    const items = renders.slice(offset, offset + limit).map((r) => ({
      key: r.key,
      photoId: r.photoId,
      styleId: r.styleId,
      styleName: styleById(r.styleId)?.name ?? r.styleId,
      title: r.title,
      status: r.status,
      error: r.error ?? null,
      model: r.model,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      createdAt: r.createdAt,
      durationMs: r.durationMs,
      attempts: r.attempts ?? 0,
      thumb: `/media/render-thumb/${r.key}.jpg`,
      full: `/media/render/${r.key}.jpg`,
    }));
    return { total, offset, limit, items };
  }

  async function doctor({ probeModel = false } = {}) {
    const checks = [];
    const push = (id, ok, detail, hint = '') => checks.push({ id, ok, detail, hint });

    push('node', process.versions.node >= '20.11', `Node ${process.versions.node}`);
    push('sharp', true, `libvips ${sharp.versions.vips}`);

    try {
      await ensureVisionBinary({ logger });
      push('vision', true, 'Apple Vision 分析器可运行（本地、免费、不上传）');
    } catch (err) {
      push('vision', false, err.message, '需要 Xcode Command Line Tools：xcode-select --install');
    }

    try {
      const s = await wallpaper.screens();
      push('screens', true, s.map((d) => `${d.name} ${d.width}×${d.height}`).join('，'));
    } catch (err) {
      push('screens', false, err.message);
    }

    try {
      const cur = await wallpaper.current();
      const target = cur.idle?.[0] ? decodeURIComponent(cur.idle[0]).replace('file://', '') : '';
      const label = cur.unified
        ? '桌面与锁屏已联动（屏保未联动）'
          : '锁屏/屏保独立';
      push('wallpaper', true, `${label}${target ? ` · ${target}` : ''}`);
    } catch (err) {
      push('wallpaper', false, err.message, '需要在「系统设置 → 隐私与安全性」里给终端/iTerm 完全磁盘访问权限');
    }

    for (const root of config.roots) {
      const ok = await exists(root);
      push(`root:${path.basename(root)}`, ok, ok ? root : '目录不存在或未挂载', ok ? '' : '检查外接硬盘是否挂载');
    }

    if (!ark) {
      push('ark-key', false, '未找到 ARK_API_KEY', '在 .secrets/volcengine.env 中填写');
    } else {
      push('ark-key', true, `已找到（${keySource}）`);
      if (probeModel) {
        const result = await ark.probe(pipeline.effectiveModel);
        push(
          `ark-model:${pipeline.effectiveModel}`,
          result.status === 'available',
          result.status === 'available' ? '模型可用' : `${result.status}${result.code ? ` / ${result.code}` : ''}`,
          result.hint ?? '',
        );
      }
    }

    try {
      await fsp.access(DATA_DIR, fsConstants.W_OK);
      push('data', true, DATA_DIR);
    } catch {
      push('data', false, '数据目录不可写');
    }

    return { ok: checks.every((c) => c.ok || c.id.startsWith('root:')), checks };
  }

  async function shutdown() {
    try {
      pipeline.dispose();
      scheduler.dispose();
      await wallpaper.dispose().catch(() => {});
      store.flushSync();
    } catch {
      // best effort
    }
  }

  await archiveRemovedStyle('cyberpunk');
  const normalized = normalizePhotoStyles();
  if (normalized) {
    await store.flush();
    logger.info(`已把 ${normalized} 张照片的旧风格重新分配`);
  }

  await wallpaper.backupOriginal().catch(() => {});
  await wallpaper.warmup().catch((err) => logger.warn(`壁纸 helper 预启动失败：${err.message}`));
  if (config.wallpaper.lockScreenMode !== 'off') {
    const session = await wallpaper.sessionState().catch(() => null);
    if (session && !session.unified) {
      await wallpaper.setUnified(true).catch((err) => logger.warn(`开启桌面/锁屏联动失败：${err.message}`));
      logger.info('已开启 macOS「桌面与锁屏使用同一张壁纸」');
    }
  }
  await refreshScreenInfo().catch(() => {});

  // Restore persisted rotation state (only when running as the long-lived daemon).
  if (autoStart) {
    if (config.rotation.intervalSeconds === 0) {
      store.runtime.rotationEnabled = false;
      store.scheduleSave();
    } else if (store.runtime.rotationEnabled !== false) {
      const hasReady = Object.values(store.renders).some((r) => r.status === 'done');
      const applyNow = Boolean(config.rotation.applyOnStart) && hasReady;
      await scheduler.start({ applyNow }).catch((err) => logger.warn(`轮播启动失败：${err.message}`));
    }
    if (store.runtime.pipelineRunning && ark) {
      logger.info('恢复上次未完成的生成队列');
      pipeline.start({ replan: true });
    }
  }

  return {
    config,
    store,
    logger,
    bus,
    wallpaper,
    scheduler,
    pipeline,
    get ark() { return ark; },
    get scanning() { return scanning; },
    actions: {
      startScan,
      updateSettings,
      updateStyles,
      startPipeline,
      generateVariants,
      startRotation: async () => {
        await scheduler.start({ applyNow: !store.runtime.current });
        return scheduler.enabled;
      },
      pauseRotation: () => {
        scheduler.stop();
        return scheduler.enabled;
      },
      pausePipeline: () => {
        pipeline.pause();
        return pipeline.status();
      },
      next: () => scheduler.tick({ reason: 'manual', force: true }),
      apply: (key) => scheduler.applyKey(key),
      restore: async () => {
        scheduler.stop();
        const result = await wallpaper.restore();
        store.runtime.current = null;
        store.runtime.playlist = { queue: [], history: [] };
        store.scheduleSave();
        await refreshScreenInfo();
        bus.emit('invalidate', { type: 'restored' });
        return result;
      },
      retryFailed: (key = null) => {
        const count = pipeline.retryFailed(key);
        if (key) {
          const job = pipeline.plan().find((item) => item.key === key);
          if (job) {
            pipeline.enqueue([job]);
            pipeline.start({ replan: false });
          }
        } else if (pipeline.running) {
          pipeline.start({ replan: true });
        }
        return { count };
      },
      refreshScreenInfo,
      unify: async () => {
        await wallpaper.setUnified(true);
        await refreshScreenInfo();
        logger.info('已重新开启「桌面与锁屏使用同一张壁纸」');
        bus.emit('invalidate', { type: 'unified' });
        return { unified: true };
      },
      doctor,
      state,
      listPhotos,
      listRenders,
      shutdown,
    },
  };
}
