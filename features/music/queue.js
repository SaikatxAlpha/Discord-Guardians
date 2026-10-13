// Per-guild music queue (pure data structure) and a tiny async mutex used
// to serialise playback transitions and prevent queue races.

export const MAX_QUEUE = 100;

export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(fn) {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class MusicQueue {
  constructor(tracks = [], { max = MAX_QUEUE } = {}) {
    this.max = max;
    this.tracks = tracks.slice(0, max);
    this.current = null;
  }

  get length() {
    return this.tracks.length;
  }

  add(track) {
    if (this.tracks.length >= this.max) throw new Error(`The queue is full (${this.max} tracks).`);
    this.tracks.push(track);
    return this.tracks.length;
  }

  /** Add as many as fit; returns how many were added. */
  addMany(tracks) {
    const room = Math.max(0, this.max - this.tracks.length);
    const add = tracks.slice(0, room);
    this.tracks.push(...add);
    return add.length;
  }

  /** Advance: the next track becomes current (or null). */
  next() {
    this.current = this.tracks.shift() ?? null;
    return this.current;
  }

  /** Remove by 1-based position. */
  remove(position) {
    if (!Number.isInteger(position) || position < 1 || position > this.tracks.length) throw new Error(`Position must be between 1 and ${this.tracks.length}.`);
    return this.tracks.splice(position - 1, 1)[0];
  }

  /** Move a track between 1-based positions. */
  move(from, to) {
    const n = this.tracks.length;
    if (![from, to].every((p) => Number.isInteger(p) && p >= 1 && p <= n)) throw new Error(`Positions must be between 1 and ${n}.`);
    const [t] = this.tracks.splice(from - 1, 1);
    this.tracks.splice(to - 1, 0, t);
    return t;
  }

  /** Fisher–Yates shuffle of the upcoming tracks. */
  shuffle(rng = Math.random) {
    for (let i = this.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
    return this.tracks.length;
  }

  clear() {
    this.tracks = [];
    this.current = null;
  }

  toJSON() {
    return { current: this.current, tracks: this.tracks };
  }
}
