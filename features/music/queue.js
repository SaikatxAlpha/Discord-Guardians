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
  constructor(tracks = []) {
    this.tracks = tracks.slice(0, MAX_QUEUE);
    this.current = null;
  }

  get length() {
    return this.tracks.length;
  }

  add(track) {
    if (this.tracks.length >= MAX_QUEUE) throw new Error(`The queue is full (${MAX_QUEUE} tracks).`);
    this.tracks.push(track);
    return this.tracks.length;
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

  clear() {
    this.tracks = [];
    this.current = null;
  }

  toJSON() {
    return { current: this.current, tracks: this.tracks };
  }
}
