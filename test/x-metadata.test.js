const test = require('node:test');
const assert = require('node:assert/strict');
const { containsSensitivityMarker, extractSensitiveMedia, normalizeMediaUrl } = require('../x-metadata.js');

test('normalizes media URLs without transformation query strings', () => {
  assert.equal(normalizeMediaUrl('https://pbs.twimg.com/media/abc.jpg?format=webp&name=small'), 'https://pbs.twimg.com/media/abc.jpg');
  assert.equal(normalizeMediaUrl('not a URL'), null);
});

test('finds deeply nested sensitivity markers', () => {
  const value = { a: { b: { c: { d: { e: { possibly_sensitive: true } } } } } };
  assert.equal(containsSensitivityMarker(value), true);
});

test('extracts labeled tweet IDs and image/video URLs', () => {
  const payload = {
    data: {
      result: {
        rest_id: '123',
        legacy: {
          possibly_sensitive: true,
          extended_entities: {
            media: [{
              media_url_https: 'https://pbs.twimg.com/media/a.jpg?name=large',
              video_info: { variants: [{ url: 'https://video.twimg.com/ext_tw_video/a.mp4?tag=12' }] },
            }],
          },
        },
      },
    },
  };
  assert.deepEqual(extractSensitiveMedia(payload), {
    urls: ['https://pbs.twimg.com/media/a.jpg', 'https://video.twimg.com/ext_tw_video/a.mp4'],
    tweetIds: ['123'],
  });
});

test('does not label unrelated media from a sensitive sibling', () => {
  const payload = {
    items: [
      { rest_id: '1', legacy: { possibly_sensitive: true, entities: { media: [{ media_url_https: 'https://pbs.twimg.com/media/a.jpg' }] } } },
      { rest_id: '2', legacy: { possibly_sensitive: false, entities: { media: [{ media_url_https: 'https://pbs.twimg.com/media/b.jpg' }] } } },
    ],
  };
  assert.deepEqual(extractSensitiveMedia(payload), {
    urls: ['https://pbs.twimg.com/media/a.jpg'],
    tweetIds: ['1'],
  });
});

test('returns no signal for unlabeled mature-looking media metadata', () => {
  const payload = { rest_id: '9', legacy: { entities: { media: [{ media_url_https: 'https://pbs.twimg.com/media/unlabeled.jpg' }] } } };
  assert.deepEqual(extractSensitiveMedia(payload), { urls: [], tweetIds: [] });
});
