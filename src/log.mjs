import { EventEmitter } from 'node:events';

const LEVEL_COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function clock() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class Logger extends EventEmitter {
  constructor({ name = 'wallflow', ringSize = 200, quiet = false } = {}) {
    super();
    this.name = name;
    this.ringSize = ringSize;
    this.quiet = quiet;
    this.entries = [];
  }

  log(level, message, meta) {
    const entry = {
      id: this.entries.length + 1,
      at: new Date().toISOString(),
      level,
      message: String(message),
      meta: meta ?? null,
    };
    this.entries.push(entry);
    if (this.entries.length > this.ringSize) this.entries.splice(0, this.entries.length - this.ringSize);

    if (!this.quiet) {
      const color = LEVEL_COLORS[level] ?? '';
      const reset = '\x1b[0m';
      const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      process.stdout.write(`${color}${clock()} ${level.padEnd(5)}${reset} ${message}${extra}\n`);
    }
    this.emit('log', entry);
    return entry;
  }

  debug(m, meta) { return this.log('debug', m, meta); }
  info(m, meta) { return this.log('info', m, meta); }
  ok(m, meta) { return this.log('ok', m, meta); }
  warn(m, meta) { return this.log('warn', m, meta); }
  error(m, meta) { return this.log('error', m, meta); }

  recent(n = 80) {
    return this.entries.slice(-n);
  }
}
