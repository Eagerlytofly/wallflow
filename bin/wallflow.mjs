#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { createApp } from '../src/app.mjs';
import { Logger } from '../src/log.mjs';
import { createWebServer } from '../src/server.mjs';
import { CONFIG_PATH, loadConfig } from '../src/config.mjs';

const HELP = `
流光壁纸 · wallflow

把本地照片变成会轮播的 AI 风格化壁纸（桌面 + 锁屏）。

用法：
  wallflow serve [--port 7799] [--open]     启动控制台 + 轮播 + 生成队列
  wallflow scan [--limit 900]               扫描照片、本地选片（不调用大模型）
  wallflow style [--limit 8]                生成成片（需先停止服务，避免状态竞争）
  wallflow next                             立即换下一张
  wallflow apply <renderKey>                指定某张成片设为壁纸
  wallflow restore                          恢复使用前的原始壁纸
  wallflow unify                            修复「桌面与锁屏联动」（锁屏不跟桌面时用）
  wallflow doctor [--probe]                 体检（目录 / Vision / 壁纸 / 方舟模型）
  wallflow status                           打印当前状态
  wallflow config                           显示配置文件路径

已有服务在运行时，scan / next / apply / restore / doctor / status 会自动通过 HTTP 调用它，
不会和后台进程抢状态文件。

环境变量：
  PORT              覆盖服务端口
  ARK_API_KEY       火山方舟 API Key（也可写入 .secrets/volcengine.env）
`;

const logger = new Logger({ quiet: false });

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function printStatus(state) {
  const s = state.summary;
  process.stdout.write(`
  照片索引    ${s.photos} 张（选中 ${s.selected}）
  成片        ${s.renders} 张（已就绪 ${s.ready}）
  今日生成    ${s.dayCount} 张 · 约 ${(s.dayCostCents / 100).toFixed(2)} 元
  生成队列    ${state.pipeline.running ? '运行中' : '空闲'} · 等待 ${state.pipeline.queued} · 进行中 ${state.pipeline.active.length}
  轮播        ${state.rotation.enabled ? '开启' : '暂停'} · 每 ${state.rotation.intervalMinutes} 分钟
  当前壁纸    ${state.current?.title || '—'}  ${state.current ? `（${fmtDate(state.current.appliedAt)} 设置）` : ''}
  下一张      ${state.rotation.nextUp?.title || '—'}
`);
}

function printDoctor(report) {
  process.stdout.write('\n体检结果\n');
  for (const check of report.checks) {
    const mark = check.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    process.stdout.write(`  ${mark} ${check.id.padEnd(24)} ${check.detail}\n`);
    if (!check.ok && check.hint) process.stdout.write(`      ${check.hint}\n`);
  }
  process.stdout.write('\n');
}

function resolvePort(values) {
  if (values.port) return Number(values.port);
  if (process.env.PORT) return Number(process.env.PORT);
  try {
    return Number(loadConfig().server.port) || 7799;
  } catch {
    return 7799;
  }
}

async function serverUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function remote(port, path, init) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `HTTP ${res.status}`);
    err.hint = json?.error?.hint;
    throw err;
  }
  return json;
}

async function waitUntil(fn, { timeoutMs = 45 * 60 * 1000, intervalMs = 500 } = {}) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      open: { type: 'boolean', default: false },
      limit: { type: 'string' },
      probe: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0] ?? 'help';
  if (command === 'help' || values.help) {
    process.stdout.write(HELP);
    return;
  }

  const port = resolvePort(values);

  if (command === 'serve') {
    const app = await createApp({ logger });
    const web = createWebServer(app);
    await web.listen({ port, host: app.config.server.host });
    const url = `http://${app.config.server.host}:${port}`;
    logger.ok(`控制台已就绪 → ${url}`);
    const photos = app.store.photoList().length;
    if (!photos) logger.info('还没有照片索引：打开控制台点「扫描照片」，或运行 wallflow scan');
    else logger.info(`已索引 ${photos} 张照片，其中 ${app.store.photoList().filter((p) => p.selected).length} 张选中`);
    if (values.open) execFile('open', [url], () => {});

    let closing = false;
    const shutdown = async (signal) => {
      if (closing) return;
      closing = true;
      logger.info(`收到 ${signal}，正在退出…`);
      await web.close().catch(() => {});
      await app.actions.shutdown().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return;
  }

  const up = await serverUp(port);

  if (command === 'status') {
    if (up) {
      printStatus(await remote(port, '/api/state'));
      return;
    }
    const app = await createApp({ logger, autoStart: false });
    printStatus(await app.actions.state());
    await app.actions.shutdown();
    return;
  }

  if (command === 'config') {
    process.stdout.write(`${CONFIG_PATH}\n`);
    return;
  }

  if (command === 'scan') {
    if (up) {
      await remote(port, '/api/scan', { method: 'POST' });
      logger.ok('已把扫描任务交给运行中的服务，进度见控制台');
      return;
    }
    const app = await createApp({ logger, autoStart: false });
    const stats = await app.actions.startScan();
    await app.actions.shutdown();
    if (values.json) process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
    return;
  }

  if (command === 'style') {
    if (up) {
      logger.warn('服务正在运行，直接用控制台「开始生成」，或先停止服务再运行命令行批量生成。');
      return;
    }
    const app = await createApp({ logger, autoStart: false });
    if (!app.ark) throw new Error('缺少 ARK_API_KEY，无法生成。先配置 .secrets/volcengine.env');
    const limit = values.limit ? Number(values.limit) : 0;
    let jobs = app.pipeline.plan();
    if (limit > 0) jobs = jobs.slice(0, limit);
    if (!jobs.length) {
      logger.info('没有需要生成的成片（可能已经全部完成）');
      await app.actions.shutdown();
      return;
    }
    logger.info(`准备生成 ${jobs.length} 张，模型 ${app.pipeline.effectiveModel}`);
    app.pipeline.enqueue(jobs);
    app.pipeline.start({ replan: false });
    await waitUntil(() => !app.pipeline.running && app.pipeline.workers === 0);
    const stats = app.store.summary();
    logger.ok(`生成完成：可用成片 ${stats.ready} 张，今日花费约 ${(stats.dayCostCents / 100).toFixed(2)} 元`);
    await app.actions.shutdown();
    return;
  }

  if (command === 'next') {
    if (up) {
      const result = await remote(port, '/api/next', { method: 'POST' });
      logger.ok(result.key ? `已切换：${result.key}` : '没有可用的成片');
      return;
    }
    const app = await createApp({ logger, autoStart: false });
    const key = await app.scheduler.tick({ reason: 'cli', force: true });
    await app.actions.shutdown();
    if (!key) {
      logger.warn('没有可用的成片，先运行 wallflow style');
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'apply') {
    const key = positionals[1];
    if (!key) throw new Error('用法：wallflow apply <renderKey>');
    if (up) {
      await remote(port, '/api/apply', { method: 'POST', body: JSON.stringify({ key }) });
      logger.ok(`已应用：${key}`);
      return;
    }
    const app = await createApp({ logger, autoStart: false });
    await app.scheduler.applyKey(key);
    await app.actions.shutdown();
    return;
  }

  if (command === 'restore') {
    if (up) {
      await remote(port, '/api/restore', { method: 'POST' });
      logger.ok('已恢复原始壁纸配置');
      return;
    }
    const app = await createApp({ logger, autoStart: false });
    const result = await app.wallpaper.restore();
    logger.ok(`已恢复原始壁纸配置（${result.restored}）`);
    await app.actions.shutdown();
    return;
  }

  if (command === 'unify') {
    if (up) {
      await remote(port, '/api/lockscreen/unify', { method: 'POST' });
      logger.ok('已重新联动桌面与锁屏，请锁屏确认');
      return;
    }
    const app = await createApp({ logger, autoStart: false });
    await app.wallpaper.setUnified(true);
    logger.ok('已重新联动桌面与锁屏，请锁屏确认');
    await app.actions.shutdown();
    return;
  }

  if (command === 'doctor') {
    if (up) {
      const report = await remote(port, `/api/doctor${values.probe ? '?probe=1' : ''}`);
      if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else printDoctor(report);
      return;
    }
    const app = await createApp({ logger, autoStart: false });
    const report = await app.actions.doctor({ probeModel: values.probe });
    if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else printDoctor(report);
    await app.actions.shutdown();
    return;
  }

  process.stdout.write(HELP);
  process.exitCode = 1;
}

main().catch((err) => {
  logger.error(err.message);
  if (err.hint) logger.info(err.hint);
  process.exitCode = 1;
});
