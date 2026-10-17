import fsp from 'node:fs/promises';
import exifr from 'exifr';
import path from 'node:path';
import {
  THUMBS_DIR,
  PREVIEWS_DIR,
} from './config.mjs';
import { SUPPORTED_EXTENSIONS, RAW_EXTENSIONS, computeMetrics, dhash, makeDerivatives, categorize } from './image.mjs';
import { analyzePaths } from './vision.mjs';
import { assignStyles, interleaveByCategory, scorePhoto, selectPhotos } from './score.mjs';
import { enabledStyles } from './styles.mjs';
import { sha1, mapLimit, nowIso, ensureDir } from './util.mjs';

const MAX_FILE_BYTES = 300 * 1024 * 1024;

async function walkRoot(root, config, out, logger) {
  let stat;
  try {
    stat = await fsp.stat(root);
  } catch {
    logger?.warn(`照片目录不存在或未挂载：${root}`);
    return { missing: true };
  }
  if (!stat.isDirectory()) {
    logger?.warn(`不是目录：${root}`);
    return { missing: true };
  }

  const excludes = (config.excludeDirs ?? []).map((e) => e.toLowerCase());
  const includeRaw = Boolean(config.includeRaw);
  const stack = [root];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (excludes.some((ex) => lower.includes(ex))) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      if (!includeRaw && RAW_EXTENSIONS.has(ext)) continue;
      try {
        const st = await fsp.stat(full);
        if (st.size > MAX_FILE_BYTES || st.size < 1024) continue;
        out.push({ path: full, root, size: st.size, mtimeMs: st.mtimeMs, ext });
        count += 1;
      } catch {
        // unreadable, skip
      }
    }
  }
  return { count };
}

export async function collectFiles(config, logger) {
  const files = [];
  const roots = [];
  for (const root of config.roots) {
    const res = await walkRoot(root, config.scan, files, logger);
    roots.push({ root, missing: Boolean(res.missing), count: res.count ?? 0 });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const max = Math.max(1, config.scan.maxFiles ?? 900);
  const limited = files.slice(0, max);
  return { files: limited, total: files.length, roots };
}

function makeId(file) {
  return sha1(`${file.path}|${file.size}|${Math.round(file.mtimeMs)}`).slice(0, 12);
}

/**
 * Scan → derive thumbnails → on-device Vision → score → select.
 *
 * Two phases so we never hold hundreds of decoded previews in memory:
 * derivatives first, then batched Vision calls.
 */
export async function scanLibrary({ store, config, logger, onProgress = () => {} }) {
  const started = Date.now();
  await ensureDir(THUMBS_DIR);
  await ensureDir(PREVIEWS_DIR);

  const { files, total, roots } = await collectFiles(config, logger);
  logger?.info(`扫描到 ${total} 张候选照片（上限 ${config.scan.maxFiles}）`, {
    roots: roots.filter((r) => !r.missing).map((r) => path.basename(r.root)),
  });

  const entries = [];
  let cached = 0;
  let failed = 0;
  let processed = 0;

  // ---- phase 1: derivatives + cheap metrics -------------------------------
  await mapLimit(files, Math.max(1, Number(config.scan.concurrency) || 3), async (file) => {
    const id = makeId(file);
    const existing = store.getPhoto(id);
    if (
      existing &&
      existing.status === 'analyzed' &&
      existing.mtimeMs === file.mtimeMs &&
      existing.size === file.size
    ) {
      cached += 1;
      entries.push(existing);
      processed += 1;
      onProgress({ phase: 'derive', done: processed, total: files.length });
      return;
    }

    try {
      const derivatives = await makeDerivatives({ file: file.path, id, thumbDir: THUMBS_DIR, previewDir: PREVIEWS_DIR });
      const exif = await exifr
        .parse(file.path, { pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'LensModel'] })
        .catch(() => null);
      const [hash, metrics] = await Promise.all([
        dhash(derivatives.previewBuffer),
        computeMetrics(derivatives.previewBuffer),
      ]);
      entries.push({
        id,
        path: file.path,
        root: file.root,
        relPath: path.relative(file.root, file.path),
        name: path.basename(file.path),
        ext: file.ext,
        size: file.size,
        mtimeMs: file.mtimeMs,
        mtime: new Date(file.mtimeMs).toISOString(),
        exifDate: exif?.DateTimeOriginal ? new Date(exif.DateTimeOriginal).toISOString() : null,
        camera: [exif?.Make, exif?.Model].filter(Boolean).join(' ') || null,
        lens: exif?.LensModel ?? null,
        width: derivatives.width,
        height: derivatives.height,
        format: file.ext.slice(1),
        phash: hash,
        metrics,
        status: 'derived',
        analyzedAt: null,
        vision: null,
        error: null,
      });
    } catch (err) {
      failed += 1;
      logger?.warn(`无法解码 ${path.basename(file.path)}：${err.message}`);
    }
    processed += 1;
    onProgress({ phase: 'derive', done: processed, total: files.length, current: path.basename(file.path) });
    if (processed % 24 === 0) await store.flush();
  });

  // ---- phase 2: Vision ----------------------------------------------------
  const pending = entries.filter((e) => e.status === 'derived');
  logger?.info(`本地 Vision 分析 ${pending.length} 张（已缓存 ${cached} 张）`);
  let analyzed = 0;
  if (pending.length) {
    const results = await analyzePaths(
      pending.map((e) => path.join(PREVIEWS_DIR, `${e.id}.jpg`)),
      { logger, concurrency: 2 },
    );
    for (const entry of pending) {
      const previewPath = path.join(PREVIEWS_DIR, `${entry.id}.jpg`);
      const vision = results.get(previewPath);
      if (!vision || !vision.ok) {
        entry.status = 'analyzed';
        entry.vision = null;
        entry.error = vision?.error ?? 'vision_failed';
        entry.tags = [];
        entry.animals = [];
        entry.faces = [];
        entry.salient = [];
        entry.aesthetic = { score: 0.45, isUtility: false };
        entry.textChars = 0;
      } else {
        entry.status = 'analyzed';
        entry.vision = {
          width: vision.width,
          height: vision.height,
          tags: vision.tags,
          animals: vision.animals,
          faces: vision.faces,
          salient: vision.salient,
          aesthetic: vision.aesthetic,
          textChars: vision.textChars,
        };
        entry.tags = vision.tags;
        entry.animals = vision.animals;
        entry.faces = vision.faces;
        entry.salient = vision.salient;
        entry.aesthetic = vision.aesthetic ?? { score: 0.45, isUtility: false };
        entry.textChars = vision.textChars;
        entry.error = null;
      }
      entry.category = categorize(entry);
      entry.score = scorePhoto(entry);
      entry.analyzedAt = nowIso();
      store.putPhoto(entry);
      analyzed += 1;
      if (analyzed % 8 === 0) {
        await store.flush();
        onProgress({ phase: 'vision', done: analyzed, total: pending.length });
      }
    }
  }

  // Carry over cached entries (they already have scores).
  for (const entry of entries) {
    if (entry.status === 'analyzed' && !store.getPhoto(entry.id)) store.putPhoto(entry);
  }

  // ---- phase 3: selection -------------------------------------------------
  onProgress({ phase: 'select', done: 0, total: 1 });
  const all = store.photoList().filter((p) => p.status === 'analyzed');
  const selection = selectPhotos(all, config);
  const chosen = new Set(selection.selected.map((p) => p.id));
  const enabled = enabledStyles(config).map((s) => s.id);
  const styleMap = assignStyles(interleaveByCategory(selection.selected), enabled, config.styles.perPhoto ?? 1);

  for (const photo of all) {
    const isSelected = chosen.has(photo.id);
    store.putPhoto({
      ...photo,
      selected: isSelected,
      rank: isSelected ? selection.selected.find((p) => p.id === photo.id)?.rank ?? null : null,
      styles: isSelected ? styleMap.get(photo.id) ?? [] : [],
      score: photo.score ?? scorePhoto(photo),
    });
  }

  store.runtime.lastScanAt = nowIso();
  store.runtime.lastScanMs = Date.now() - started;
  await store.flush();
  onProgress({ phase: 'done', done: 1, total: 1 });

  const stats = {
    scanned: files.length,
    cached,
    analyzed,
    failed,
    selected: selection.selected.length,
    byCategory: selection.stats.byCategory,
    elapsedMs: Date.now() - started,
    roots,
  };
  logger?.ok(`扫描完成：${stats.scanned} 张，新增分析 ${analyzed}，选中 ${stats.selected} 张`, {
    categories: stats.byCategory,
    seconds: Math.round(stats.elapsedMs / 1000),
  });
  if (selection.selected.length < config.selection.count) {
    logger?.warn(`可用的高质量照片不足 ${config.selection.count} 张，先用手上的 ${selection.selected.length} 张`);
  }
  return stats;
}
