const test = require('node:test');
const assert = require('node:assert/strict');
const { LruCache, preferredMediaSources, videoSampleTimes } = require('../x-media-utils.js');

test('produces five bounded video sample times', () => {
  assert.deepEqual(videoSampleTimes(100), [0, 25, 50, 75, 95]);
  assert.deepEqual(videoSampleTimes(Infinity), []);
  assert.deepEqual(videoSampleTimes(0), []);
});

test('LRU cache refreshes reads and evicts the oldest item', () => {
test('responsive images use one stable preferred source instead of src plus currentSrc', () => {
  assert.deepEqual(preferredMediaSources({
    currentSrc: 'https://pbs.twimg.com/media/a-large.jpg',
    src: 'https://pbs.twimg.com/media/a-small.jpg',
    poster: '',
  }), ['https://pbs.twimg.com/media/a-large.jpg']);
});

  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});
