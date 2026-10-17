import { clamp } from './util.mjs';

export const CATEGORY_LABELS = {
  person: '人物',
  animal: '动物',
  landscape: '风景',
  urban: '城市',
  other: '其他',
};

const CATEGORY_BONUS = {
  person: 0.94,
  animal: 0.96,
  landscape: 1.0,
  urban: 0.82,
  other: 0.5,
};

export function megapixels(photo) {
  return ((photo.width || 0) * (photo.height || 0)) / 1e6;
}

function resolutionScore(photo) {
  const mp = megapixels(photo);
  return clamp((Math.log10(Math.max(mp, 0.1)) + 0.3) / 1.4);
}

function exposureScore(photo) {
  const b = photo.metrics?.brightness ?? 0.5;
  // Ideal mid-tone; heavy under/over exposure loses.
  return clamp(1 - Math.abs(b - 0.48) * 2.6);
}

function faceScore(photo) {
  if (!photo.faces?.length) return 0;
  const q = Math.max(...photo.faces.map((f) => f.quality ?? 0.5));
  const area = photo.faces.reduce((sum, f) => sum + f.w * f.h, 0);
  return clamp(q * 0.7 + clamp(area / 0.08) * 0.3);
}

/**
 * Wallpaper-suitability score in 0..1. Deliberately transparent: every
 * component is visible in the UI so a weird pick can be explained.
 */
export function scorePhoto(photo) {
  const aesthetic = clamp(photo.aesthetic?.score ?? 0.45);
  const sharpness = clamp(photo.metrics?.sharpness ?? 0.3);
  const colorfulness = clamp(photo.metrics?.colorfulness ?? 0.3);
  const exposure = exposureScore(photo);
  const category = photo.category ?? 'other';
  const bonus = CATEGORY_BONUS[category] ?? 0.5;

  let score =
    aesthetic * 0.4 +
    sharpness * 0.18 +
    resolutionScore(photo) * 0.1 +
    colorfulness * 0.08 +
    exposure * 0.08 +
    bonus * 0.1 +
    faceScore(photo) * 0.06;

  const textChars = photo.textChars ?? 0;
  if (textChars > 300) score -= 0.3;
  else if (textChars > 120) score -= 0.1;
  if (photo.aesthetic?.isUtility) score -= 0.35;

  return clamp(Number(score.toFixed(4)));
}

export function rejectionReason(photo, config) {
  const scan = config.scan;
  if (photo.status !== 'analyzed') return '未分析';
  if ((photo.width || 0) < scan.minWidth) return '分辨率太低';
  if (megapixels(photo) < scan.minMegapixels) return '像素太低';
  if ((photo.metrics?.sharpness ?? 1) < 0.06) return '画面模糊';
  if (scan.skipScreenshots && photo.aesthetic?.isUtility) return '截屏/文档';
  if (scan.skipScreenshots && (photo.textChars ?? 0) > 260) return '文字过多';
  if ((photo.score ?? 0) < config.selection.minScore) return '评分不足';
  return null;
}

function tagSet(photo) {
  return new Set((photo.tags ?? []).slice(0, 8).map((t) => t.id));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Pick a varied, high-quality set. Quotas guarantee the wallpaper rotation
 * is not 48 photos of the same bird, and tag similarity prevents bursts
 * from the same shoot flooding the list.
 */
export function selectPhotos(photos, config) {
  const rejection = new Map();
  const eligible = [];
  for (const photo of photos) {
    const reason = rejectionReason(photo, config);
    if (reason) rejection.set(photo.id, reason);
    else eligible.push(photo);
  }

  eligible.sort((a, b) => b.score - a.score);

  // Near-duplicate suppression (burst shots) on top of exact-path hashing.
  const unique = [];
  for (const photo of eligible) {
    const tooClose = unique.some((other) => other.phash && photo.phash && hamming(photo.phash, other.phash) <= 5);
    if (tooClose) rejection.set(photo.id, '重复/连拍');
    else unique.push(photo);
  }

  const target = Math.min(config.selection.count, unique.length);
  const quotas = config.selection.quotas ?? {};
  const selected = [];
  const selectedIds = new Set();
  const selectedTags = [];

  const tryTake = (photo, { enforceDiversity }) => {
    if (selectedIds.has(photo.id) || selected.length >= target) return false;
    const tags = tagSet(photo);
    if (enforceDiversity && selectedTags.some((t) => jaccard(tags, t) > config.selection.maxPerTagOverlap)) return false;
    selected.push(photo);
    selectedIds.add(photo.id);
    selectedTags.push(tags);
    return true;
  };

  for (const [category, quota] of Object.entries(quotas)) {
    let taken = 0;
    for (const photo of unique) {
      if (taken >= quota || selected.length >= target) break;
      if (photo.category !== category) continue;
      if (tryTake(photo, { enforceDiversity: true })) taken += 1;
    }
  }

  for (const photo of unique) {
    if (selected.length >= target) break;
    tryTake(photo, { enforceDiversity: true });
  }
  // Relax diversity if we still have room (small libraries).
  for (const photo of unique) {
    if (selected.length >= target) break;
    tryTake(photo, { enforceDiversity: false });
  }

  const byCategory = {};
  for (const photo of selected) byCategory[photo.category] = (byCategory[photo.category] ?? 0) + 1;

  return {
    selected: selected.map((p, i) => ({ ...p, rank: i + 1 })),
    rejected: rejection,
    stats: {
      eligible: eligible.length,
      unique: unique.length,
      selected: selected.length,
      target,
      byCategory,
    },
  };
}

function hamming(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return 64;
  let distance = 0;
  for (let i = 0; i < hexA.length; i += 1) {
    let xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/**
 * Interleave categories (person → animal → landscape → urban → …) so the
 * first few generated wallpapers already show variety instead of eight
 * portraits in a row.
 */
export function interleaveByCategory(photos) {
  const order = ['person', 'animal', 'landscape', 'urban', 'other'];
  const groups = new Map(order.map((cat) => [cat, []]));
  for (const photo of photos) {
    if (!groups.has(photo.category)) groups.set(photo.category, []);
    groups.get(photo.category).push(photo);
  }
  const out = [];
  let added = true;
  while (added) {
    added = false;
    for (const category of order) {
      const list = groups.get(category);
      if (list && list.length) {
        out.push(list.shift());
        added = true;
      }
    }
  }
  return out;
}

/**
 * Spread styles evenly across the selection so the rotation does not end up
 * with eight watercolours in a row. Deterministic for a given library.
 */
export function assignStyles(selected, styleIds, perPhoto = 1) {
  const assignments = new Map();
  if (!styleIds.length) return assignments;
  const rounds = Math.max(1, Math.min(perPhoto, styleIds.length));
  selected.forEach((photo, index) => {
    const styles = [];
    for (let k = 0; k < rounds; k += 1) {
      styles.push(styleIds[(index * rounds + k) % styleIds.length]);
    }
    assignments.set(photo.id, styles);
  });
  return assignments;
}
