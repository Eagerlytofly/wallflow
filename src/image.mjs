import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { ensureDir, exists, clamp, mean, stddev } from './util.mjs';

export const RAW_EXTENSIONS = new Set([
  '.orf', '.ori', '.cr2', '.cr3', '.nef', '.arw', '.rw2', '.raf', '.dng', '.pef', '.srw', '.sr2', '.raw', '.3fr', '.erf',
]);
const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);
const EXOTIC_EXTENSIONS = new Set([...RAW_EXTENSIONS, ...HEIC_EXTENSIONS]);

export const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp', ...EXOTIC_EXTENSIONS,
]);

const SIPS_BIN = '/usr/bin/sips';

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${path.basename(cmd)} failed: ${stderr || err.message}`;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

export function isExotic(file) {
  return EXOTIC_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Decode anything macOS understands (incl. RAW + HEIC) to a JPEG buffer.
 * sharp's bundled libvips has no RAW support and often no HEIC, so `sips`
 * is the bridge. Normal JPEG/PNG never touch this path.
 */
export async function decodeToJpegBuffer(file, { max = 2200 } = {}) {
  if (!isExotic(file)) {
    try {
      return await sharp(file)
        .rotate()
        .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .toBuffer();
    } catch {
      // Odd JPEG variants (12-bit, CMYK, truncated headers …) still decode
      // through ImageIO, so fall through to sips instead of giving up.
    }
  }
  const tmp = path.join(os.tmpdir(), `wallflow-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    await run(SIPS_BIN, ['-s', 'format', 'jpeg', '-Z', String(max), file, '--out', tmp]);
    return await fsp.readFile(tmp);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

export async function imageInfo(file) {
  const meta = await sharp(file, { failOn: 'none' }).metadata();
  return {
    width: meta.autoOrient?.width ?? meta.width ?? 0,
    height: meta.autoOrient?.height ?? meta.height ?? 0,
    format: meta.format ?? path.extname(file).slice(1).toLowerCase(),
  };
}

/**
 * Build the two derivatives we use everywhere: a 2000px preview for vision
 * + AI input, and a 512px thumbnail for the gallery.
 */
export async function makeDerivatives({ file, id, thumbDir, previewDir }) {
  await ensureDir(thumbDir);
  await ensureDir(previewDir);
  const previewBuffer = await decodeToJpegBuffer(file, { max: 2000 });
  const meta = await sharp(previewBuffer).metadata();
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;

  const thumbPath = path.join(thumbDir, `${id}.jpg`);
  const previewPath = path.join(previewDir, `${id}.jpg`);

  const pipeline = sharp(previewBuffer);
  await pipeline.clone().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84 }).toFile(thumbPath);
  await fsp.writeFile(previewPath, previewBuffer);

  return { width, height, thumbPath, previewPath, previewBuffer };
}

function hexFromBits(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16);
  }
  return hex;
}

/** 64-bit difference hash, used to drop near-duplicates and bursts. */
export async function dhash(buffer) {
  const { data } = await sharp(buffer).resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const bits = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      bits.push(left > right ? 1 : 0);
    }
  }
  return hexFromBits(bits);
}

export function hammingDistance(hexA, hexB) {
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

/** Sharpness (Laplacian variance), exposure and colourfulness in one pass. */
export async function computeMetrics(buffer) {
  const { data, info } = await sharp(buffer)
    .resize({ width: 320, height: 320, fit: 'inside' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const px = new Uint8Array(data);

  let sum = 0;
  for (let i = 0; i < px.length; i += 1) sum += px[i];
  const brightness = sum / px.length / 255;

  const contrast = stddev(Array.from(px)) / 255;

  const responses = [];
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const lap = px[i - w] + px[i + w] + px[i - 1] + px[i + 1] - 4 * px[i];
      responses.push(lap);
    }
  }
  const laplacianVar = mean(responses.map((r) => r * r));
  const sharpness = clamp((Math.log10(laplacianVar + 1) - 1.4) / 1.7);

  const rgb = await sharp(buffer).resize(64, 64, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const d = rgb.data;
  const rg = [];
  const yb = [];
  for (let i = 0; i < d.length; i += 3) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    rg.push(r - g);
    yb.push(0.5 * (r + g) - b);
  }
  const colorfulness = clamp(
    (Math.sqrt(stddev(rg) ** 2 + stddev(yb) ** 2) + 0.3 * Math.sqrt(mean(rg) ** 2 + mean(yb) ** 2)) / 110,
  );

  return {
    sharpness,
    brightness,
    contrast,
    colorfulness,
    laplacianVar: Math.round(laplacianVar * 10) / 10,
  };
}

const PERSON_TAGS = ['person', 'people', 'portrait', 'selfie', 'child', 'baby', 'human', 'face', 'man', 'woman', 'bride', 'groom', 'kid', 'girl', 'boy', 'crowd', 'family', 'wedding'];
const ANIMAL_TAGS = ['animal', 'bird', 'dog', 'cat', 'wildlife', 'mammal', 'insect', 'fish', 'reptile', 'pet', 'horse', 'elephant', 'lion', 'tiger', 'deer', 'zebra', 'giraffe', 'monkey', 'bear', 'fox', 'wolf', 'rabbit', 'squirrel', 'butterfly', 'duck', 'swan', 'pelican', 'heron', 'eagle', 'owl', 'penguin', 'whale', 'dolphin', 'turtle', 'frog', 'spider', 'cattle', 'sheep', 'goat', 'poultry', 'seal', 'hippo', 'rhino', 'cheetah', 'leopard'];
const LANDSCAPE_TAGS = ['landscape', 'mountain', 'sky', 'cloud', 'sunset', 'sunrise', 'sea', 'ocean', 'beach', 'lake', 'river', 'forest', 'tree', 'desert', 'snow', 'nature', 'outdoor', 'field', 'valley', 'hill', 'coast', 'island', 'waterfall', 'canyon', 'glacier', 'aurora', 'horizon', 'grassland', 'wetland', 'garden', 'park'];
const URBAN_TAGS = ['building', 'city', 'architecture', 'street', 'skyline', 'house', 'bridge', 'tower', 'urban', 'room', 'interior', 'window', 'wall', 'staircase', 'temple', 'church', 'castle'];

function tagScore(tags, vocabulary) {
  let best = 0;
  for (const tag of tags) {
    if (vocabulary.includes(tag.id)) best = Math.max(best, tag.confidence);
  }
  return best;
}

export function categorize({ tags = [], animals = [], faces = [], width = 0, height = 0 }) {
  const faceArea = faces.reduce((sum, f) => sum + f.w * f.h, 0);
  const personTag = tagScore(tags, PERSON_TAGS);
  const animalTag = Math.max(tagScore(tags, ANIMAL_TAGS), animals.length ? Math.max(...animals.map((a) => a.confidence)) : 0);
  const landscapeTag = tagScore(tags, LANDSCAPE_TAGS);
  const urbanTag = tagScore(tags, URBAN_TAGS);

  if (faces.length > 0 && (faceArea > 0.008 || personTag > 0.35)) return 'person';
  if (personTag > 0.6 && faceArea > 0.002) return 'person';
  if (animalTag > 0.22) return 'animal';
  if (urbanTag > 0.35 && urbanTag > landscapeTag) return 'urban';
  if (landscapeTag > 0.25) return 'landscape';
  if (faces.length > 0) return 'person';
  return 'other';
}

function overlapArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

/** Vision boxes use a bottom-left origin; everything else here is top-left. */
function toTopLeft(box, srcW, srcH) {
  return {
    x: box.x * srcW,
    y: (1 - box.y - box.h) * srcH,
    w: box.w * srcW,
    h: box.h * srcH,
  };
}

/**
 * Pick the crop window that keeps the most interesting content inside.
 * Saliency boxes come from Vision; faces are weighted much higher.
 */
export function smartCrop({ width, height, targetWidth, targetHeight, salient = [], faces = [], mode = 'smart' }) {
  const targetAR = targetWidth / targetHeight;
  const srcAR = width / height;
  let cropW;
  let cropH;
  if (srcAR > targetAR) {
    cropH = height;
    cropW = Math.round(height * targetAR);
  } else {
    cropW = width;
    cropH = Math.round(width / targetAR);
  }
  cropW = Math.min(width, cropW);
  cropH = Math.min(height, cropH);

  const maxX = width - cropW;
  const maxY = height - cropH;

  if (mode === 'center' || (maxX <= 0 && maxY <= 0)) {
    return { left: Math.round(maxX / 2), top: Math.round(maxY / 2), width: cropW, height: cropH };
  }

  const sal = salient.map((s) => ({ ...toTopLeft(s, width, height), weight: 1 }));
  const faceBoxes = faces.map((f) => ({ ...toTopLeft(f, width, height), weight: 4 + 2 * clamp((f.quality ?? 0.5), 0, 1) }));

  const boxes = [...sal, ...faceBoxes];
  const steps = 40;
  let best = null;

  const evaluate = (x, y) => {
    const window = { x, y, w: cropW, h: cropH };
    let score = 0;
    for (const box of boxes) {
      const area = Math.max(1, box.w * box.h);
      const inside = overlapArea(window, box) / area;
      score += inside * box.weight * Math.sqrt(area);
      // Penalise cutting through a face even partially.
      if (box.weight >= 4 && inside > 0.05 && inside < 0.9) score -= 0.6 * box.weight * Math.sqrt(area);
    }
    // Slight preference for a centred, balanced crop.
    const cx = x / Math.max(1, maxX);
    const cy = y / Math.max(1, maxY);
    score += (1 - Math.abs(cx - 0.5) * 2) * 0.02 * (maxX > 0 ? 1 : 0);
    score += (1 - Math.abs(cy - 0.5) * 2) * 0.02 * (maxY > 0 ? 1 : 0);
    return score;
  };

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = Math.round(maxX * t);
    const y = Math.round(maxY * t);
    const s = evaluate(x, y);
    if (!best || s > best.score) best = { score: s, left: x, top: y };
  }

  return { left: best.left, top: best.top, width: cropW, height: cropH };
}

/** Crop + resize a preview to the exact AR we send to Ark. */
export async function composeInput(buffer, crop, { width = 2560, height = 1440, quality = 90 } = {}) {
  return sharp(buffer)
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** Final 4K wallpaper: AI output gets gently resampled to the screen size. */
export async function finalizeRender({ buffer, width, height, quality = 92, outPath, thumbPath }) {
  await ensureDir(path.dirname(outPath));
  const info = await sharp(buffer)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .modulate({ saturation: 1.02 })
    .sharpen({ sigma: 0.6, m1: 0.4, m2: 0.6 })
    .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(outPath);

  let thumbBytes = 0;
  if (thumbPath) {
    await ensureDir(path.dirname(thumbPath));
    const t = await sharp(outPath)
      .resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(thumbPath);
    thumbBytes = t.size;
  }

  return { bytes: info.size, width: info.width, height: info.height, thumbBytes };
}

export async function makePreviewFromFile(file, outPath, max = 1600) {
  await ensureDir(path.dirname(outPath));
  const buf = await decodeToJpegBuffer(file, { max });
  await fsp.writeFile(outPath, buf);
  return outPath;
}

export async function fileExists(p) {
  return exists(p);
}
