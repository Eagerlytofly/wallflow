import { shuffle, mulberry32 } from './util.mjs';

/**
 * A shuffle bag: every ready wallpaper is shown once before anything repeats,
 * and newly generated images are spliced into the *upcoming* queue so they
 * start appearing without waiting for the current cycle to finish.
 */
export class Playlist {
  constructor({ queue = [], history = [], seed = Date.now() } = {}) {
    this.queue = [...queue];
    this.history = [...history];
    this.seed = seed;
    this.random = mulberry32(seed);
  }

  get size() {
    return this.queue.length;
  }

  reset(keys, { exclude = null } = {}) {
    const pool = keys.filter((key) => key !== exclude);
    this.queue = shuffle(pool, this.random);
    this.history = exclude ? [exclude, ...this.history] : this.history;
    return this.queue.length;
  }

  add(key, { front = false } = {}) {
    if (!key || this.queue.includes(key)) return false;
    if (front) this.queue.unshift(key);
    else {
      const at = Math.floor(this.random() * (this.queue.length + 1));
      this.queue.splice(at, 0, key);
    }
    return true;
  }

  remove(key) {
    const before = this.queue.length;
    this.queue = this.queue.filter((k) => k !== key);
    return before !== this.queue.length;
  }

  peek() {
    return this.queue[0] ?? null;
  }

  next() {
    const key = this.queue.shift() ?? null;
    if (key) {
      this.history = [key, ...this.history.filter((k) => k !== key)].slice(0, 200);
    }
    return key;
  }

  toJSON() {
    return { queue: this.queue, history: this.history };
  }
}
