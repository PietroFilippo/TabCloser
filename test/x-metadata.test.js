const test = require('node:test');
const assert = require('node:assert/strict');
const {
  containsSensitivityMarker,
  extractDirectVideoSources,
  extractAgeVerificationTweetIds,
  extractSensitiveMedia,
  normalizeMediaUrl,
  summarizeSensitivitySignals,
} = require('../x-metadata.js');

test('extracts the lowest-bandwidth direct MP4 for an unlabeled VPN video', () => {
  const payload = {
    data: {
      result: {
        __typename: 'Tweet',
        rest_id: '2077422949787959667',
        legacy: {
          possibly_sensitive: false,
          extended_entities: {
            media: [{
              type: 'video',
              video_info: {
                variants: [
                  { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/amplify_video/207742/pl/master.m3u8' },
                  { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/207742/vid/high.mp4?tag=14' },
                  { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/amplify_video/207742/vid/low.mp4?tag=14' },
                ],
              },
            }],
          },
        },
      },
    },
  };

  assert.deepEqual(extractDirectVideoSources(payload), {
    '2077422949787959667': 'https://video.twimg.com/amplify_video/207742/vid/low.mp4?tag=14',
  });
  assert.deepEqual(extractSensitiveMedia(payload), { urls: [], tweetIds: [] });
});

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

test('maps a VPN-stable sensitive author flag to the media tweet instead of emitting user IDs', () => {
  const payload = {
    data: {
      result: {
        __typename: 'Tweet',
        rest_id: '2077225687815950690',
        core: {
          user_results: {
            result: {
              __typename: 'User',
              rest_id: '2074572527796367360',
              legacy: { possibly_sensitive: true },
            },
          },
        },
        legacy: {
          possibly_sensitive: false,
          extended_entities: {
            media: [{ media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/2077224740972863488/img/poster.jpg' }],
          },
        },
      },
      unrelated_user: {
        __typename: 'User',
        rest_id: '1169269936042205185',
        legacy: { possibly_sensitive: true },
      },
      text_only_tweet: {
        __typename: 'Tweet',
        rest_id: '2077225687815950691',
        core: {
          user_results: {
            result: {
              __typename: 'User',
              rest_id: '2074572527796367360',
              legacy: { possibly_sensitive: true },
            },
          },
        },
        legacy: {
          possibly_sensitive: false,
          full_text: 'A text-only post must not become sensitive media metadata.',
        },
      },
    },
  };

  assert.deepEqual(extractSensitiveMedia(payload), {
    urls: ['https://pbs.twimg.com/amplify_video_thumb/2077224740972863488/img/poster.jpg'],
    tweetIds: ['2077225687815950690'],
  });
});

test('a sensitive profile interstitial protects the author media tweet, other interstitials do not', () => {
  function payloadWithInterstitial(tweetId, interstitialType) {
    return {
      data: {
        result: {
          __typename: 'Tweet',
          rest_id: tweetId,
          core: {
            user_results: {
              result: {
                __typename: 'User',
                rest_id: '2074572527796367361',
                legacy: {
                  possibly_sensitive: false,
                  profile_interstitial_type: interstitialType,
                },
              },
            },
          },
          legacy: {
            possibly_sensitive: false,
            extended_entities: {
              media: [{ media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/2077224740972863489/img/poster.jpg' }],
            },
          },
        },
      },
    };
  }

  assert.deepEqual(extractSensitiveMedia(payloadWithInterstitial('2077225687815950692', 'sensitive_media_warning')), {
    urls: ['https://pbs.twimg.com/amplify_video_thumb/2077224740972863489/img/poster.jpg'],
    tweetIds: ['2077225687815950692'],
  });
  assert.deepEqual(extractSensitiveMedia(payloadWithInterstitial('2077225687815950693', 'SensitiveMedia')), {
    urls: ['https://pbs.twimg.com/amplify_video_thumb/2077224740972863489/img/poster.jpg'],
    tweetIds: ['2077225687815950693'],
  });
  assert.deepEqual(extractSensitiveMedia(payloadWithInterstitial('2077225687815950694', 'fake_account')),
    { urls: [], tweetIds: [] });
  assert.deepEqual(extractSensitiveMedia(payloadWithInterstitial('2077225687815950695', '')),
    { urls: [], tweetIds: [] });
});

test('returns no signal for unlabeled mature-looking media metadata', () => {
  const payload = { rest_id: '9', legacy: { entities: { media: [{ media_url_https: 'https://pbs.twimg.com/media/unlabeled.jpg' }] } } };
  assert.deepEqual(extractSensitiveMedia(payload), { urls: [], tweetIds: [] });
});

test('keeps a sensitive tweet ID when a visibility result omits inline media', () => {
  const payload = {
    data: {
      tweetResult: {
        result: {
          __typename: 'TweetWithVisibilityResults',
          tweet: {
            rest_id: '2075297812791591371',
            legacy: { possibly_sensitive: true },
          },
          limitedActionResults: { limited_actions: [{ action: 'DoNotAllow' }] },
        },
      },
    },
  };

  assert.deepEqual(extractSensitiveMedia(payload), {
    urls: [],
    tweetIds: ['2075297812791591371'],
  });
});

test('treats an age-verification visibility prompt as sensitive only for its paired tweet', () => {
  const payload = {
    data: {
      entries: [
        {
          result: {
            mediaVisibilityResults: {
              blurred_image_interstitial: {
                interstitial_action: 'AgeVerificationPrompt',
              },
            },
            tweet: {
              rest_id: '2075297812791591371',
              legacy: {
                possibly_sensitive: false,
                extended_entities: {
                  media: [{ media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/restricted.jpg' }],
                },
              },
            },
          },
        },
        {
          result: {
            tweet: {
              rest_id: '2075297812791591372',
              legacy: {
                possibly_sensitive: false,
                extended_entities: {
                  media: [{ media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/safe.jpg' }],
                },
              },
            },
          },
        },
      ],
    },
  };

  assert.deepEqual(extractSensitiveMedia(payload), {
    urls: ['https://pbs.twimg.com/amplify_video_thumb/restricted.jpg'],
    tweetIds: ['2075297812791591371'],
  });
  assert.deepEqual(extractAgeVerificationTweetIds(payload), [
    '2075297812791591371',
  ]);
});

test('summarizes visibility signals without exposing post text or media URLs', () => {
  const payload = {
    data: {
      result: {
        __typename: 'TweetWithVisibilityResults',
        tweet: {
          rest_id: '2075297812791591371',
          core: {
            user_results: {
              result: {
                rest_id: '2039193487434719233',
                legacy: {
                  screen_name: 'private_author',
                  possibly_sensitive: true,
                  profile_interstitial_type: 'SensitiveMedia',
                },
              },
            },
          },
          legacy: {
            full_text: 'private fixture text',
            possibly_sensitive: true,
            extended_entities: {
              media: [{ media_url_https: 'https://pbs.twimg.com/media/private.jpg' }],
            },
          },
        },
        limitedActionResults: { limited_actions: [{ action: 'DoNotAllow' }] },
      },
    },
  };

  const summary = summarizeSensitivitySignals(payload, '2075297812791591371');
  assert.deepEqual(summary.candidates, [{
    id: '2075297812791591371',
    typename: null,
    mediaCount: 1,
    possiblySensitive: true,
    hasSensitiveWarning: false,
    authorId: '2039193487434719233',
    authorPossiblySensitive: true,
    authorProfileInterstitialType: 'SensitiveMedia',
    authorHasSensitiveWarning: false,
  }]);
  assert.ok(summary.fields.some(field => field.key === 'possibly_sensitive'));
  assert.ok(summary.fields.some(field => field.key === 'limitedActionResults'));
  assert.equal(JSON.stringify(summary).includes('private fixture'), false);
  assert.equal(JSON.stringify(summary).includes('private.jpg'), false);
  assert.equal(JSON.stringify(summary).includes('private_author'), false);
});
