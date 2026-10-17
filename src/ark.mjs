import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT, apiKeyPath } from './config.mjs';
import { exists, parseEnvFile, sleep } from './util.mjs';

const REGION_HOSTS = {
  'cn-beijing': 'ark.cn-beijing.volces.com',
  'cn-shanghai': 'ark.cn-shanghai.volces.com',
  'cn-guangzhou': 'ark.cn-guangzhou.volces.com',
};

export class ArkError extends Error {
  constructor(message, { code = 'ArkError', status = 0, retryable = false, hint = '' } = {}) {
    super(message);
    this.name = 'ArkError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.hint = hint;
  }
}

export async function loadApiKey(config) {
  if (process.env.ARK_API_KEY) return { key: process.env.ARK_API_KEY.trim(), source: 'env' };
  const candidates = [
    apiKeyPath(config),
    path.join(ROOT, '..', 'oneline', '.secrets', 'volcengine.env'),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!(await exists(file))) continue;
    try {
      const text = await fsp.readFile(file, 'utf8');
      const parsed = parseEnvFile(text);
      if (parsed.ARK_API_KEY) return { key: parsed.ARK_API_KEY.trim(), source: file };
    } catch {
      // keep looking
    }
  }
  return { key: null, source: null };
}

function hintForCode(code) {
  switch (code) {
    case 'ModelNotOpen':
      return '这个模型还没有在火山方舟控制台「开通管理」里勾选，开通后再试。';
    case 'InvalidEndpointOrModel.NotFound':
      return '模型 ID 无效、已下线，或当前账号未开通；到方舟控制台确认模型并开通。';
    case 'AuthenticationError':
    case 'InvalidApiKey':
      return 'API Key 无效或已过期，请更新 .secrets/volcengine.env。';
    case 'QuotaExceeded':
    case 'RateLimitExceeded':
      return '触发限流或额度不足，降低并发生成数量或稍后再试。';
    case 'SensitiveContentDetected':
    case 'OutputImageSensitiveContentDetected':
      return '内容审核未通过，换一张照片或调整风格提示词。';
    default:
      return '';
  }
}

function classifyError(status, body) {
  const code = body?.error?.code || body?.code || `HTTP${status}`;
  const message = body?.error?.message || body?.message || `HTTP ${status}`;
  const retryable = status === 429 || status >= 500;
  return new ArkError(message, { code, status, retryable, hint: hintForCode(code) });
}

export class ArkClient {
  constructor({ apiKey, region = 'cn-beijing', model, timeoutSec = 180, retries = 2, logger } = {}) {
    if (!apiKey) throw new ArkError('缺少 ARK_API_KEY', { hint: '把密钥写进 .secrets/volcengine.env，或设置环境变量 ARK_API_KEY。' });
    this.apiKey = apiKey;
    this.region = region;
    this.model = model;
    this.timeoutSec = timeoutSec;
    this.retries = retries;
    this.logger = logger;
    this.host = REGION_HOSTS[region] ?? REGION_HOSTS['cn-beijing'];
  }

  url(suffix = '') {
    return `https://${this.host}/api/v3/images/generations${suffix}`;
  }

  async request(body, { timeoutSec, signal } = {}) {
    const timeout = (timeoutSec ?? this.timeoutSec) * 1000;
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    const res = await fetch(this.url(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON error page
    }
    if (!res.ok) {
      throw classifyError(res.status, json ?? { message: text.slice(0, 300) });
    }
    return json;
  }

  async generate({ prompt, imageBuffer, mime = 'image/jpeg', size = '2560x1440', seed, model = this.model, signal }) {
    const dataUrl = `data:${mime};base64,${imageBuffer.toString('base64')}`;
    const body = {
      model,
      prompt,
      image: dataUrl,
      size,
      response_format: 'url',
      watermark: false,
    };
    if (Number.isFinite(seed)) body.seed = seed;

    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const started = Date.now();
        const json = await this.request(body, { signal });
        const item = json?.data?.[0];
        if (!item?.url && !item?.b64_json) throw new ArkError('响应里没有图片', { code: 'EmptyResponse' });
        let buffer;
        if (item.url) {
          const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
          if (!imgRes.ok) throw new ArkError(`下载生成图片失败：HTTP ${imgRes.status}`, { code: 'DownloadFailed', retryable: true, status: imgRes.status });
          buffer = Buffer.from(await imgRes.arrayBuffer());
        } else {
          buffer = Buffer.from(item.b64_json, 'base64');
        }
        return {
          buffer,
          size: item.size ?? size,
          usage: json.usage ?? null,
          model,
          ms: Date.now() - started,
          remoteUrl: item.url ?? null,
        };
      } catch (err) {
        lastError = err;
        const retryable = err.retryable || err.name === 'TimeoutError' || err.name === 'TypeError';
        if (!retryable || attempt >= this.retries) break;
        const wait = 1800 * 2 ** attempt;
        this.logger?.warn(`Ark 请求失败（${err.code ?? err.name}），${Math.round(wait / 1000)}s 后重试`, { attempt: attempt + 1 });
        await sleep(wait);
      }
    }
    throw lastError;
  }

  /**
   * Cheap availability probe: send an intentionally invalid `size`.
   * A model that exists will reject the parameter (InvalidParameter) without
   * generating anything; a missing/unopened model fails earlier.
   */
  async probe(model) {
    try {
      await this.request({ model, prompt: 'probe', size: '0x0', response_format: 'url' }, { timeoutSec: 25 });
      return { model, status: 'available', note: '（意外成功，可能未计费）' };
    } catch (err) {
      const code = err.code ?? '';
      if (code === 'InvalidParameter') return { model, status: 'available' };
      if (code === 'ModelNotOpen') return { model, status: 'not_activated', hint: err.hint };
      if (code === 'InvalidEndpointOrModel.NotFound') return { model, status: 'not_found', hint: err.hint };
      return { model, status: 'error', code, message: err.message, hint: err.hint };
    }
  }

  async listModels() {
    const res = await fetch(`https://${this.host}/api/v3/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new ArkError(`HTTP ${res.status}`, { code: 'ListModelsFailed', status: res.status });
    const json = await res.json();
    return (json.data ?? []).map((m) => m.id);
  }
}

export function estimateCostCents(config, count = 1) {
  return Math.max(0, Math.round((config.ark?.priceCents ?? 20) * count));
}
