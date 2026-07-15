const test = require('node:test');
const assert = require('node:assert/strict');
const { LruCache, preferredMediaSources } = require('../x-media-utils.js');

test('responsive images use one stable preferred source instead of src plus currentSrc', () => {
  assert.deepEqual(preferredMediaSources({
    currentSrc: 'https://pbs.twimg.com/media/a-large.jpg',
    src: 'https://pbs.twimg.com/media/a-small.jpg',
    poster: '',
  }), ['https://pbs.twimg.com/media/a-large.jpg']);
});

test('LRU cache refreshes reads and evicts the oldest item', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});
