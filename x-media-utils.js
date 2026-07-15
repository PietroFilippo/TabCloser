(function initXMediaUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TabCloserXMediaUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createXMediaUtils() {
  class LruCache {
    constructor(limit = 500) {
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


  return { LruCache, preferredMediaSources: stableMediaSources };
});
