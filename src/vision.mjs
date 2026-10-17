import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BIN_DIR, ROOT } from './config.mjs';
import { ensureDir, exists, mapLimit } from './util.mjs';

const SOURCE = path.join(ROOT, 'native', 'VisionAnalyze.swift');
const BINARY = path.join(BIN_DIR, 'vision-analyze');
const BATCH_SIZE = 24;

let compiledOnce = null;

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 180000, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function needsBuild() {
  if (!(await exists(BINARY))) return true;
  const [srcStat, binStat] = await Promise.all([fsp.stat(SOURCE), fsp.stat(BINARY)]);
  return srcStat.mtimeMs > binStat.mtimeMs;
}

export async function ensureVisionBinary({ logger } = {}) {
  if (compiledOnce) return compiledOnce;
  compiledOnce = (async () => {
    if (!(await needsBuild())) return BINARY;
    await ensureDir(BIN_DIR);
    logger?.info('编译 Vision 分析器（首次运行，约 3-8 秒）');
    await exec('swiftc', ['-O', SOURCE, '-o', BINARY], { timeout: 240000 });
    logger?.ok('Vision 分析器就绪');
    return BINARY;
  })();
  try {
    return await compiledOnce;
  } catch (err) {
    compiledOnce = null;
    err.message = `Vision 分析器编译失败：${err.stderr || err.message}`;
    throw err;
  }
}

/** Analyze one batch of images; returns a Map path → result. */
export async function analyzePaths(paths, { logger, concurrency = 2 } = {}) {
  if (!paths.length) return new Map();
  const bin = await ensureVisionBinary({ logger });
  const batches = [];
  for (let i = 0; i < paths.length; i += BATCH_SIZE) batches.push(paths.slice(i, i + BATCH_SIZE));

  const results = new Map();
  await mapLimit(batches, Math.max(1, concurrency), async (batch) => {
    const { stdout } = await exec(bin, batch, { timeout: 120000 });
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`Vision 输出无法解析：${stdout.slice(0, 200)}`);
    }
    for (const item of parsed) results.set(item.path, item);
  });
  return results;
}

export async function visionVersion() {
  await ensureVisionBinary();
  const { stdout } = await exec(BINARY, [], { timeout: 10000 });
  return stdout.trim();
}
