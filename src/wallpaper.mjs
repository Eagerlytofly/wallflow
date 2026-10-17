import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BIN_DIR, BACKUP_DIR, ROOT } from './config.mjs';
import { ensureDir, exists, timestampSlug } from './util.mjs';

const SOURCE = path.join(ROOT, 'native', 'Wallpaper.swift');
const BINARY = path.join(BIN_DIR, 'wallpaper-helper');
const STORE = path.join(os.homedir(), 'Library/Application Support/com.apple.wallpaper/Store/Index.plist');

export class WallpaperError extends Error {
  constructor(message, { stderr = '' } = {}) {
    super(message);
    this.name = 'WallpaperError';
    this.stderr = stderr;
  }
}

let buildPromise = null;

function exec(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function ensureBinary() {
  if (buildPromise) return buildPromise;
  buildPromise = (async () => {
    let needsBuild = true;
    if (await exists(BINARY)) {
      const [src, bin] = await Promise.all([fsp.stat(SOURCE), fsp.stat(BINARY)]);
      needsBuild = src.mtimeMs > bin.mtimeMs;
    }
    if (needsBuild) {
      await ensureDir(BIN_DIR);
      await exec('swiftc', ['-O', SOURCE, '-o', BINARY], { timeout: 180000 });
    }
    return BINARY;
  })();
  try {
    return await buildPromise;
  } catch (err) {
    buildPromise = null;
    throw new WallpaperError(`壁纸 helper 编译失败：${err.stderr || err.message}`, { stderr: err.stderr });
  }
}

export class Wallpaper {
  constructor({ config, logger } = {}) {
    this.config = config;
    this.logger = logger;
    this.storePath = STORE;
    this.agent = null;
    this.buffer = '';
    this.seq = 0;
    this.pending = new Map();
    this.stderr = '';
  }

  async ready() {
    await ensureBinary();
    return true;
  }

  /** Start the long-lived helper so each change costs milliseconds. */
  async warmup() {
    await this.ready();
    await this.ensureAgent();
    return true;
  }

  async ensureAgent() {
    if (this.agent && !this.agent.killed) return this.agent;
    const bin = await ensureBinary();
    const proc = spawn(bin, ['agent'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.agent = proc;
    this.buffer = '';
    this.stderr = '';
    proc.stdout.on('data', (chunk) => this.onStdout(chunk));
    proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    proc.on('exit', (code) => {
      const error = new WallpaperError(`壁纸 helper 已退出（code ${code}）${this.stderr ? `: ${this.stderr.trim()}` : ''}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.agent = null;
    });
    proc.on('error', (err) => {
      this.logger?.warn(`壁纸 helper 无法启动：${err.message}`);
    });
    return proc;
  }

  onStdout(chunk) {
    this.buffer += chunk.toString();
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) {
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = null;
        }
        if (msg && msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.ok === false) reject(new WallpaperError(msg.error || '壁纸操作失败'));
          else resolve(msg);
        }
      }
      index = this.buffer.indexOf('\n');
    }
  }

  async rpc(cmd, args = {}, { timeout = 20000 } = {}) {
    await this.ensureAgent();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WallpaperError(`壁纸 helper 超时（${cmd}）`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.agent.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new WallpaperError(`壁纸 helper 写入失败：${err.message}`));
      }
    });
  }

  async oneShot(command, args) {
    const bin = await ensureBinary();
    try {
      const { stdout } = await exec(bin, [command, ...args]);
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      return JSON.parse(line);
    } catch (err) {
      throw new WallpaperError(err.stderr?.trim() || err.message, { stderr: err.stderr });
    }
  }

  /** ~10 ms, no flicker, desktop only. */
  async setDesktopFast(imagePath) {
    try {
      return await this.rpc('desktop', { image: imagePath });
    } catch (err) {
      this.logger?.warn(`快速通道失败，回退到一次性调用：${err.message}`);
      await this.killAgent();
      return this.oneShot('desktop', ['--image', imagePath]);
    }
  }

  /** Persist Desktop + Idle in the wallpaper store. Restarting is what applies it to the lock screen. */
  async storeChoice(imagePath, { lock = true, placement = 1, restart = false } = {}) {
    try {
      return await this.rpc('store', { image: imagePath, lock, placement, restart });
    } catch (err) {
      this.logger?.warn(`写入壁纸存储失败：${err.message}`);
      await this.killAgent();
      const args = ['--image', imagePath, '--placement', String(placement)];
      if (lock) args.push('--lock');
      if (restart) args.push('--restart');
      return this.oneShot('store', args);
    }
  }

  async setUnified(enabled = true) {
    try {
      return await this.rpc('unified', { enabled });
    } catch {
      await this.killAgent();
      return this.oneShot('unified', enabled ? [] : ['--off']);
    }
  }

  async restartAgent() {
    try {
      return await this.rpc('restart');
    } catch {
      return this.oneShot('restart', []);
    }
  }

  async sessionState() {
    try {
      return await this.rpc('state');
    } catch {
      return this.oneShot('state', []);
    }
  }

  async screens() {
    const bin = await ensureBinary();
    const { stdout } = await exec(bin, ['screens']);
    return JSON.parse(stdout);
  }

  async current() {
    try {
      const result = await this.rpc('current');
      return result;
    } catch {
      return this.oneShot('current', []);
    }
  }

  async backupOriginal() {
    await ensureDir(BACKUP_DIR);
    const original = path.join(BACKUP_DIR, 'original.plist');
    if (await exists(original)) return original;
    if (!(await exists(this.storePath))) return null;
    await fsp.copyFile(this.storePath, original);
    this.logger?.info(`已备份原始壁纸配置 → ${path.relative(ROOT, original)}`);
    return original;
  }

  async snapshot() {
    await ensureDir(BACKUP_DIR);
    if (!(await exists(this.storePath))) return null;
    const file = path.join(BACKUP_DIR, `index-${timestampSlug()}.plist`);
    await fsp.copyFile(this.storePath, file);
    return file;
  }

  async restore(backupPath) {
    const target = backupPath ?? path.join(BACKUP_DIR, 'original.plist');
    if (!(await exists(target))) throw new WallpaperError(`找不到备份文件：${target}`);
    const result = await this.oneShot('restore', ['--backup', target]);
    if (!result.ok) throw new WallpaperError(result.error || '恢复壁纸失败');
    return result;
  }

  async listBackups() {
    await ensureDir(BACKUP_DIR);
    const entries = await fsp.readdir(BACKUP_DIR).catch(() => []);
    return entries.filter((f) => f.endsWith('.plist')).sort();
  }

  async killAgent() {
    if (!this.agent) return;
    const proc = this.agent;
    this.agent = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new WallpaperError('壁纸 helper 已重启'));
    }
    this.pending.clear();
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }

  async dispose() {
    if (!this.agent) return;
    try {
      await this.rpc('quit', {}, { timeout: 1000 });
    } catch {
      // ignore
    }
    await this.killAgent();
  }
}
