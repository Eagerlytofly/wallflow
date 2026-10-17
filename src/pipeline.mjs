import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALLPAPERS_DIR, RENDER_THUMBS_DIR, PREVIEWS_DIR, THUMBS_DIR } from './config.mjs';
import { buildPrompt, styleById } from './styles.mjs';
import { composeInput, finalizeRender, makeDerivatives, smartCrop } from './image.mjs';
import { assignStyles, interleaveByCategory, CATEGORY_LABELS } from './score.mjs';
import { existsSync, clamp } from './util.mjs';

export function renderKey(photoId, styleId) {
  return `${photoId}.${styleId}`;
}

export function parseRenderKey(key) {
  const at = key.indexOf('.');
  return { photoId: key.slice(0, at), styleId: key.slice(at + 1) };
}

function inputSize(config) {
  const match = /^(\d+)x(\d+)$/.exec(String(config.ark.size ?? ''));
  if (match) return { width: Number(match[1]), height: Number(match[2]) };
  return { width: 2560, height: 1440 };
}

const MODERATION_CODES = new Set([
  'SensitiveContentDetected',
  'InputImageSensitiveContentDetected',
  'OutputImageSensitiveContentDetected',
]);

function isModerationError(err) {
  if (!err) return false;
  if (MODERATION_CODES.has(err.code)) return true;
  return /sensitive information|sensitive content|内容审核/i.test(err.message ?? '');
}

function safetySuffix(category) {
  return category === 'person'
    ? '\n安全要求：人物着装完整、姿态自然，画面健康；不出现裸露、血腥、暴力或令人不适的内容。'
    : '\n安全要求：画面中只出现自然风景、动物或静物，不出现人物、人体、裸露、血腥、暴力或令人不适的内容。';
}

function dateLabel(photo) {
  const raw = photo.exifDate || photo.mtime;
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function makeTitle(photo, style) {
  const bits = [style?.name ?? style?.id ?? '成片'];
  const category = CATEGORY_LABELS[photo.category];
  if (category) bits.push(category);
  const date = dateLabel(photo);
  if (date) bits.push(date);
  return bits.join(' · ');
}

export class Pipeline {
  constructor({ store, config, ark, logger, onUpdate, onRenderDone }) {
    this.store = store;
    this.config = config;
    this.ark = ark;
    this.logger = logger;
    this.onUpdate = onUpdate ?? (() => {});
    this.onRenderDone = onRenderDone ?? (() => {});
    this.queue = [];
    this.queued = new Set();
    this.active = new Map();
    this.workers = 0;
    this.running = false;
    this.effectiveModel = config.ark.model;
    this.abort = new AbortController();
    this.lastError = null;
  }

  get concurrency() {
    return clamp(Number(this.config.ark.concurrency) || 2, 1, 4);
  }

  budgetLeft() {
    this.store.rollDay();
    const budget = Number(this.config.ark.dailyBudgetCents) || 0;
    if (budget <= 0) return Infinity;
    const spent = this.store.runtime.stats.dayCostCents + this.active.size * (this.config.ark.priceCents ?? 0);
    return budget - spent;
  }

  /** Build the missing work from the current selection. */
  plan() {
    const photos = interleaveByCategory(
      this.store.photoList().filter((p) => p.selected).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    );
    const enabled = this.config.styles.enabled.filter((id) => styleById(id));
    if (!enabled.length || !photos.length) return [];

    const assignments = assignStyles(photos, enabled, this.config.styles.perPhoto ?? 1);
    const jobs = [];
    for (const photo of photos) {
      const styles = photo.styles?.length ? photo.styles : assignments.get(photo.id) ?? [];
      for (const styleId of styles) {
        if (!styleById(styleId)) continue;
        const key = renderKey(photo.id, styleId);
        const render = this.store.getRender(key);
        if (render?.status === 'done' && existsSync(path.join(WALLPAPERS_DIR, `${key}.jpg`))) continue;
        if (render?.status === 'running') continue;
        if (render?.status === 'failed' && (render.attempts ?? 0) >= 4) continue;
        jobs.push({ key, photoId: photo.id, styleId });
      }
    }
    return jobs;
  }

  enqueue(jobs) {
    let added = 0;
    for (const job of jobs) {
      if (this.queued.has(job.key)) continue;
      if (this.active.has(job.key)) continue;
      this.queue.push(job);
      this.queued.add(job.key);
      added += 1;
    }
    if (added) {
      this.logger?.info(`加入生成队列 ${added} 张（待处理 ${this.queue.length}）`);
      this.onUpdate({ type: 'queue', queued: this.queue.length });
    }
    return added;
  }

  /** Enqueue everything missing and start workers. */
  start({ replan = true } = {}) {
    if (replan) this.enqueue(this.plan());
    if (!this.queue.length && this.running) return 0;
    this.running = true;
    this.store.runtime.pipelineRunning = true;
    this.store.scheduleSave();
    this.abort = new AbortController();
    this.logger?.info('生成队列已启动', { concurrency: this.concurrency, model: this.effectiveModel });
    this.pump();
    this.onUpdate({ type: 'pipeline', running: true });
    return this.queue.length;
  }

  pause() {
    if (!this.running) return;
    this.running = false;
    this.store.runtime.pipelineRunning = false;
    this.store.scheduleSave();
    this.logger?.info('生成队列已暂停（进行中的请求会完成）');
    this.onUpdate({ type: 'pipeline', running: false });
  }

  stop() {
    this.pause();
    this.abort.abort();
  }

  /** Abort in-flight work without clobbering the persisted "was running" flag. */
  dispose() {
    this.abort.abort();
  }

  pump() {
    if (!this.running) return;
    if (this.budgetLeft() <= 0) {
      this.running = false;
      this.store.runtime.pipelineRunning = false;
      this.store.scheduleSave();
      this.logger?.warn(`已达到今日生成预算（${this.config.ark.dailyBudgetCents / 100} 元），自动暂停`);
      this.onUpdate({ type: 'pipeline', running: false, reason: 'budget' });
      return;
    }
    while (this.workers < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.queued.delete(job.key);
      this.workers += 1;
      this.runJob(job)
        .catch((err) => this.logger?.error(`任务异常：${err.message}`))
        .finally(() => {
          this.workers -= 1;
          this.onUpdate({ type: 'progress' });
          this.pump();
        });
    }
    if (!this.queue.length && this.workers === 0) {
      this.running = false;
      this.store.runtime.pipelineRunning = false;
      this.store.scheduleSave();
      this.logger?.ok('队列已全部处理完');
      this.onUpdate({ type: 'pipeline', running: false, done: true });
    }
  }

  async generateWithModels({ prompt, imageBuffer, size, seed, models, signal }) {
    let lastModelError = null;
    for (const model of models) {
      try {
        const result = await this.ark.generate({ prompt, imageBuffer, size, seed, model, signal });
        if (model !== this.effectiveModel) {
          this.logger?.warn(`主模型不可用，本次改用 ${model}`);
          this.effectiveModel = model;
        }
        return result;
      } catch (err) {
        const modelLevel = ['InvalidEndpointOrModel.NotFound', 'ModelNotOpen'].includes(err.code);
        if (modelLevel) {
          lastModelError = err;
          this.logger?.warn(`模型 ${model} 不可用（${err.code}），尝试下一个`);
          continue;
        }
        throw err;
      }
    }
    throw lastModelError ?? new Error('没有可用模型');
  }

  async runJob(job) {
    const photo = this.store.getPhoto(job.photoId);
    const style = styleById(job.styleId);
    if (!photo || !style) return;

    const key = job.key;
    const existing = this.store.getRender(key);
    const attempts = (existing?.attempts ?? 0) + 1;
    const startedAt = new Date().toISOString();
    this.active.set(key, { key, photoId: photo.id, styleId: style.id, step: 'preparing', startedAt, attempts });
    this.store.putRender({
      ...(existing ?? {}),
      key,
      photoId: photo.id,
      styleId: style.id,
      status: 'running',
      attempts,
      startedAt,
      error: null,
      model: this.effectiveModel,
    });
    this.onUpdate({ type: 'job', key, status: 'running' });

    try {
      const size = inputSize(this.config);
      const previewPath = path.join(PREVIEWS_DIR, `${photo.id}.jpg`);
      let preview;
      try {
        preview = await fsp.readFile(previewPath);
      } catch {
        // Preview cache was cleaned; rebuild it from the original file.
        const rebuilt = await makeDerivatives({
          file: photo.path,
          id: photo.id,
          thumbDir: THUMBS_DIR,
          previewDir: PREVIEWS_DIR,
        });
        preview = rebuilt.previewBuffer;
      }
      const crop = smartCrop({
        width: photo.width,
        height: photo.height,
        targetWidth: size.width,
        targetHeight: size.height,
        salient: photo.salient ?? [],
        faces: photo.faces ?? [],
        mode: 'smart',
      });
      const input = await composeInput(preview, crop, { width: size.width, height: size.height });

      this.active.get(key).step = 'generating';
      this.onUpdate({ type: 'job', key, status: 'generating' });

      const basePrompt = buildPrompt(style.id, photo.category, this.config);
      const baseSeed = parseInt(photo.id.slice(0, 8), 16) % 2147483647;
      const models = [this.effectiveModel, ...(this.config.ark.fallbackModels ?? [])]
        .filter((m, i, arr) => m && arr.indexOf(m) === i);

      let prompt = basePrompt;
      let seed = baseSeed;
      let moderationRetry = false;
      let result = null;
      try {
        result = await this.generateWithModels({
          prompt,
          imageBuffer: input,
          size: this.config.ark.size,
          seed,
          models,
          signal: this.abort.signal,
        });
      } catch (err) {
        if (!isModerationError(err)) throw err;
        // Image moderation on the *output* is often a false positive for
        // abstract styles. Retry once with an explicit safety clause and a
        // different seed before giving up.
        moderationRetry = true;
        prompt = `${basePrompt}${safetySuffix(photo.category)}`;
        seed = (baseSeed + 1) % 2147483647;
        this.logger?.warn(`内容审核未通过（可能误判），用安全提示词重试一次：${key}`);
        try {
          result = await this.generateWithModels({
            prompt,
            imageBuffer: input,
            size: this.config.ark.size,
            seed,
            models,
            signal: this.abort.signal,
          });
        } catch (retryErr) {
          if (isModerationError(retryErr)) {
            const err = new Error('内容审核未通过（模型可能误判），安全重试后仍失败');
            err.code = 'ModerationRejected';
            err.moderation = true;
            err.hint = '可点「重试」或换一个风格；这类失败通常不扣费。';
            throw err;
          }
          throw retryErr;
        }
      }

      this.active.get(key).step = 'finalizing';
      this.onUpdate({ type: 'job', key, status: 'finalizing' });
      const outPath = path.join(WALLPAPERS_DIR, `${key}.jpg`);
      const thumbPath = path.join(RENDER_THUMBS_DIR, `${key}.jpg`);
      const finalized = await finalizeRender({
        buffer: result.buffer,
        width: this.config.output.width,
        height: this.config.output.height,
        quality: this.config.output.quality,
        outPath,
        thumbPath,
      });

      const costCents = Number(this.config.ark.priceCents) || 0;
      const render = {
        key,
        photoId: photo.id,
        styleId: style.id,
        title: makeTitle(photo, style),
        status: 'done',
        model: result.model,
        prompt,
        moderationRetry,
        width: finalized.width,
        height: finalized.height,
        bytes: finalized.bytes,
        seed,
        usage: result.usage,
        costCents,
        attempts,
        createdAt: new Date().toISOString(),
        startedAt,
        durationMs: result.ms,
        error: null,
      };
      this.store.putRender(render);
      this.store.recordRenderDone({ costCents });
      this.lastError = null;
      this.logger?.ok(`成片完成 ${key}`, {
        model: result.model,
        size: `${finalized.width}×${finalized.height}`,
        seconds: Math.round(result.ms / 100) / 10,
      });
      this.onRenderDone(key);
      this.onUpdate({ type: 'render', key, status: 'done' });
    } catch (err) {
      const aborted = err.name === 'AbortError' || err.message === 'aborted';
      const render = this.store.getRender(key) ?? { key, photoId: photo.id, styleId: style.id };
      if (aborted) {
        this.store.putRender({ ...render, status: 'failed', attempts: Math.max(0, attempts - 1), error: '已取消' });
      } else {
        const moderation = err.moderation || isModerationError(err);
        if (moderation) {
          this.logger?.warn(`内容审核失败，已标记为需人工重试：${key}`);
        }
        this.store.recordRenderFailed();
        this.store.putRender({
          ...render,
          status: 'failed',
          attempts: moderation ? Math.max(attempts, 4) : attempts,
          failedAt: new Date().toISOString(),
          error: [err.message, err.hint].filter(Boolean).join(' · '),
          errorCode: err.code ?? null,
          moderation,
        });
        this.store.runtime.lastError = `生成失败：${err.message}`;
        this.lastError = err;
        this.logger?.error(`生成失败 ${key}：${err.message}`, err.hint ? { hint: err.hint } : undefined);
      }
      this.onUpdate({ type: 'render', key, status: 'failed' });
    } finally {
      this.active.delete(key);
      this.store.scheduleSave();
    }
  }

  retryFailed(key = null) {
    let count = 0;
    for (const render of Object.values(this.store.renders)) {
      if (render.status !== 'failed') continue;
      if (key && render.key !== key) continue;
      this.store.putRender({
        ...render,
        status: 'pending',
        attempts: 0,
        error: null,
        errorCode: null,
        moderation: false,
      });
      count += 1;
    }
    this.logger?.info(`已重置 ${count} 个失败任务${key ? `（${key}）` : ''}`);
    return count;
  }

  status() {
    return {
      running: this.running,
      workers: this.workers,
      queued: this.queue.length,
      concurrency: this.concurrency,
      effectiveModel: this.effectiveModel,
      budgetLeftCents: this.budgetLeft(),
      lastError: this.lastError ? this.lastError.message : null,
      active: [...this.active.values()].map((job) => ({
        ...job,
        elapsedMs: Date.now() - new Date(job.startedAt).getTime(),
      })),
    };
  }
}
