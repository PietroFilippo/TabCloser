(function initXMediaUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TabCloserXMediaUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createXMediaUtils() {
  function videoSampleTimes(duration) {
    if (!Number.isFinite(duration) || duration <= 0) return [];
    const end = Math.max(0, duration - Math.min(0.1, duration / 20));
    const values = [0, 0.25, 0.5, 0.75, 0.95]
      .map(fraction => Math.min(end, duration * fraction))
      .map(value => Math.round(value * 1000) / 1000);
    return [...new Set(values)];
  }

  class LruCache {
    constructor(limit = 500) {
  function preferredMediaSources(element) {
    const values = [];
    const primary = element?.currentSrc || element?.src;
    if (primary) values.push(primary);
    if (element?.poster && !values.includes(element.poster)) values.push(element.poster);
    return values;
  }

      this.limit = Math.max(1, limit);
      this.values = new Map();
    }
    get(key) {
      if (!this.values.has(key)) return undefined;
      const value = this.values.get(key);
      this.values.delete(key);
      this.values.set(key, value);
      return value;
    }
    set(key, value) {
      if (this.values.has(key)) this.values.delete(key);
      this.values.set(key, value);
      while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value);
    }
    clear() {
      this.values.clear();
    }
    get size() {
      return this.values.size;
    }
  }
  function stableMediaSources(element) {
    const values = [];
    const primary = element?.currentSrc || element?.src;
    if (primary) values.push(primary);
    if (element?.poster && !values.includes(element.poster)) values.push(element.poster);
    return values;
  }


  return { LruCache, preferredMediaSources: stableMediaSources, videoSampleTimes };
});
