import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge, readJsonSync, writeJsonAtomic, ensureDirSync } from './util.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.WALLFLOW_CONFIG
  ? path.resolve(ROOT, process.env.WALLFLOW_CONFIG)
  : path.join(ROOT, 'config.json');
export const DATA_DIR = process.env.WALLFLOW_DATA_DIR
  ? path.resolve(ROOT, process.env.WALLFLOW_DATA_DIR)
  : path.join(ROOT, 'data');
export const STATE_PATH = path.join(DATA_DIR, 'state.json');
export const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
export const PREVIEWS_DIR = path.join(DATA_DIR, 'previews');
export const WALLPAPERS_DIR = path.join(DATA_DIR, 'wallpapers');
export const RENDER_THUMBS_DIR = path.join(DATA_DIR, 'render-thumbs');
export const BIN_DIR = path.join(DATA_DIR, 'bin');
export const BACKUP_DIR = path.join(DATA_DIR, 'wallpaper');
export const WEB_DIR = path.join(ROOT, 'web');
export const SECRETS_DIR = path.join(ROOT, '.secrets');

export const MIN_INTERVAL_SECONDS = 30;

export function normalizeIntervalSeconds(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  return Math.max(MIN_INTERVAL_SECONDS, Math.round(n));
}

export const DEFAULT_CONFIG = {
  roots: [path.join(os.homedir(), 'Pictures')],
  scan: {
    maxFiles: 600,
    includeRaw: false,
    minMegapixels: 1.2,
    minWidth: 1200,
    concurrency: 3,
    skipScreenshots: true,
    excludeDirs: ['.photoslibrary', '.thumbnails', 'cache', 'node_modules', '.git', 'Lightroom Catalog'],
  },
  output: {
    width: 3840,
    height: 2160,
    quality: 92,
  },
  selection: {
    count: 48,
    minScore: 0.42,
    maxPerTagOverlap: 0.55,
    quotas: { person: 16, animal: 16, landscape: 16, urban: 8 },
  },
  ark: {
    region: 'cn-beijing',
    model: 'doubao-seedream-4-0-20260415',
    fallbackModels: ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'],
    size: '2560x1440',
    concurrency: 2,
    timeoutSec: 180,
    retries: 2,
    priceCents: 20,
    dailyBudgetCents: 800,
    apiKeyFile: '.secrets/volcengine.env',
  },
  styles: {
    enabled: ['watercolor', 'ghibli', 'oil', 'ink', 'film', 'riso', 'ukiyoe', 'minimal'],
    perPhoto: 1,
    custom: {}, // { styleId: "custom prompt" }
  },
  rotation: {
    intervalSeconds: 0,
    applyOnStart: true,
    notify: false,
  },
  wallpaper: {
    // on-lock: 每次换桌面，锁屏在下一次锁屏时同步（推荐，不闪）
    // each:    每次换壁纸都重启 WallpaperAgent 同步锁屏（短间隔会闪）
    // off:     只换桌面
    lockScreenMode: 'on-lock',
    placement: 1, // 0 auto, 1 fill, 2 fit, 3 stretch, 4 center, 5 tile
  },
  server: {
    port: 7799,
    host: '127.0.0.1',
  },
};

export function loadConfig() {
  const raw = readJsonSync(CONFIG_PATH, null);
  const merged = deepMerge(DEFAULT_CONFIG, raw || {});

  // Migrate the pre-0.2 shape (minutes / boolean lock screen).
  if (raw?.rotation?.intervalMinutes != null && raw?.rotation?.intervalSeconds == null) {
    merged.rotation.intervalSeconds = normalizeIntervalSeconds(Number(raw.rotation.intervalMinutes) * 60);
  }
  if (raw?.wallpaper?.setLockScreen != null && raw?.wallpaper?.lockScreenMode == null) {
    merged.wallpaper.lockScreenMode = raw.wallpaper.setLockScreen ? 'on-lock' : 'off';
  }
  delete merged.rotation.intervalMinutes;
  delete merged.wallpaper.setLockScreen;

  merged.rotation.intervalSeconds = normalizeIntervalSeconds(merged.rotation.intervalSeconds, 0);
  if (!['on-lock', 'each', 'off'].includes(merged.wallpaper.lockScreenMode)) {
    merged.wallpaper.lockScreenMode = 'on-lock';
  }

  merged.roots = (merged.roots || []).filter((r) => typeof r === 'string' && r.trim());
  merged.styles.enabled = (merged.styles.enabled || [])
    .map((id) => (id === 'cyberpunk' ? 'riso' : id))
    .filter(Boolean);
  if (merged.styles.custom && Object.prototype.hasOwnProperty.call(merged.styles.custom, 'cyberpunk')) {
    delete merged.styles.custom.cyberpunk;
  }
  return merged;
}

export async function saveConfig(config) {
  await writeJsonAtomic(CONFIG_PATH, config, true);
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, THUMBS_DIR, PREVIEWS_DIR, WALLPAPERS_DIR, RENDER_THUMBS_DIR, BIN_DIR, BACKUP_DIR, SECRETS_DIR]) {
    ensureDirSync(dir);
  }
}

export function resolveFromRoot(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

export function apiKeyPath(config) {
  return resolveFromRoot(config.ark.apiKeyFile);
}
