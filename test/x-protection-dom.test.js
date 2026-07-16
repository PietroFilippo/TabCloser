const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const coordinator = readFileSync(path.join(root, 'x-protection-v2.js'), 'utf8');
const mediaUtils = require('../x-media-utils.js');
const metadata = require('../x-metadata.js');
const verdict = require('../x-verdict.js');

function flush(window, turns = 8) {
  return new Promise(resolve => {
    function next(remaining) {
      if (!remaining) return resolve();
      window.setTimeout(() => next(remaining - 1), 0);
    }
    next(turns);
  });
}

async function startCoordinator(html, {
  config,
  classify,
  prepare,
  url = 'https://x.com/search?q=test&src=typed_query&f=media',
} = {}) {
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const classificationMessages = [];
  const debugMessages = [];
  window.console.debug = (...args) => debugMessages.push(args);
  let contentMessageListener = null;

  // jsdom deliberately omits layout/media playback. These shims model only
  // the browser seams the coordinator needs for discovery and classification.
  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent; },
    });
  }
  window.HTMLMediaElement.prototype.pause = function pause() {};
  window.HTMLMediaElement.prototype.load = function load() {};
  // jsdom never loads image resources: paintings "decode" on the next timer
  // turn so decode-gated artwork application stays observable. Tests can set
  // window.__artImageLoader to control when a painting finishes loading.
  window.Image = function FixtureArtImage() {
    const image = window.document.createElement('img');
    image.decode = () => Promise.resolve();
    let value = '';
    Object.defineProperty(image, 'src', {
      configurable: true,
      get: () => value,
      set(next) {
        value = next;
        const loader = window.__artImageLoader ||
          (target => window.setTimeout(() => target.dispatchEvent(new window.Event('load')), 0));
        loader(image);
      },
    });
    return image;
  };
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      drawImage() {},
      getImageData() {
        const size = verdict.MODEL_INPUT_SIZE;
        return { data: new Uint8ClampedArray(size * size * 4), width: size, height: size };
      },
    };
  };

  window.IntersectionObserver = class IntersectionObserver {
    constructor(callback) { this.callback = callback; }
    observe(target) {
      window.setTimeout(() => this.callback([{ isIntersecting: true, target }]), 0);
    }
    unobserve() {}
    disconnect() {}
  };

  window.TabCloserXMediaUtils = mediaUtils;
  window.TabCloserXMetadata = metadata;
  window.TabCloserXVerdict = verdict;
  window.TabCloserSacredArt = ['test-painting.jpg'];
  window.TabCloserQuotes = [];
  window.browser = {
    storage: {
      local: {
        get: async () => ({
          xProtection: config || {
            labeled: { enabled: true },
            model: { enabled: true, sensitivity: 'balanced' },
          },
        }),
      },
    },
    runtime: {
      getURL: value => 'moz-extension://tabcloser/' + value,
      onMessage: {
        addListener(listener) { contentMessageListener = listener; },
      },
      async sendMessage(message) {
        classificationMessages.push(message);
        return classify ? classify(message) : { verdict: 'safe', reason: 'visual' };
      },
    },
  };

  prepare?.(window);
  window.eval(coordinator);
  await flush(window);

  return {
    classificationMessages,
    dom,
    debugMessages,
    async sendContentMessage(message) {
      assert.ok(contentMessageListener, 'content-script message listener was not registered');
      contentMessageListener(message);
      await flush(window);
    },
    window,
  };
}

test('a native X mature-content warning tile is replaced and cannot open the post', async () => {
  const harness = await startCoordinator(`
    <main>
      <a id="warning-tile" href="/example/status/1234567890">
        <div><span>Warning: Nudity</span></div>
      </a>
    </main>
  `, {
    config: {
      labeled: { enabled: true },
      model: { enabled: false, sensitivity: 'balanced' },
    },
  });

  try {
    const tile = harness.window.document.getElementById('warning-tile');
    assert.equal(tile.dataset.tabcloserMediaState, 'protected');
    assert.equal(tile.dataset.tabcloserMediaReason, 'metadata');
    assert.ok(tile.querySelector('.tabcloser-media-overlay-art'), 'warning tile should show replacement art');
    assert.ok(tile.querySelector('.tabcloser-overlay-artwork'), 'the full painting should render above its fill backdrop');
    assert.ok(tile.classList.contains('tabcloser-overlay-host-static'), 'a genuinely static host needs the positioning fallback');

    const click = new harness.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    assert.equal(tile.dispatchEvent(click), false, 'protected warning tile navigation must be canceled');
    assert.equal(click.defaultPrevented, true);
  } finally {
    harness.dom.window.close();
  }
});

test('a blob-streamed video uses its poster without sampling or seeking the player', async () => {
  const harness = await startCoordinator(`
    <article>
      <a href="/example/status/9876543210/video/1">
        <div id="video-root" data-testid="videoComponent">
          <video id="video" poster="https://pbs.twimg.com/amplify_video_thumb/987/img/poster.jpg"
            src="blob:https://x.com/fixture-video"></video>
        </div>
      </a>
    </article>
  `, {
    prepare(window) {
      const video = window.document.getElementById('video');
      let currentTime = 7;
      window.__videoSeekCount = 0;
      Object.defineProperty(video, 'currentTime', {
        configurable: true,
        get: () => currentTime,
        set(value) {
          window.__videoSeekCount += 1;
          currentTime = Number(value);
        },
      });
      video.muted = false;
    },
  });

  try {
    const video = harness.window.document.getElementById('video');
    const videoRoot = harness.window.document.getElementById('video-root');
    assert.equal(videoRoot.dataset.tabcloserMediaState, 'safe');
    assert.equal(videoRoot.dataset.tabcloserMediaReason, 'visual');
    assert.deepEqual(harness.classificationMessages.map(message => message.kind), ['url']);
    assert.equal(harness.window.__videoSeekCount, 0);
    assert.equal(video.currentTime, 7);
    assert.equal(video.muted, false);
  } finally {
    harness.dom.window.close();
  }
});

function configureFixtureVideo(window, video, source = '') {
  let currentTime = 0;
  Object.defineProperties(video, {
    currentSrc: { configurable: true, get: () => source },
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set(value) {
        currentTime = Number(value);
        window.queueMicrotask(() => video.dispatchEvent(new window.Event('seeked')));
      },
    },
    duration: { configurable: true, get: () => 20 },
    readyState: { configurable: true, get: () => 4 },
    buffered: {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => 20 }),
    },
  });
}

function laterFrameClassifier(message) {
  if (message.kind === 'url') return { verdict: 'safe', reason: 'visual', adultScore: 0.01 };
  const time = Number(message.mediaKey.match(/\|t=([\d.]+)$/)?.[1] || 0);
  // A strong score (>= 2x threshold): decisive on its own.
  return time >= 5
    ? { verdict: 'protect', reason: 'visual', adultScore: 0.5 }
    : { verdict: 'safe', reason: 'visual', adultScore: 0.02 };
}

test('a generic status-link video tile in media search is released after poster classification', async () => {
  const harness = await startCoordinator(
    '<main>' +
      '<a id="video-tile" href="/example/status/2222222222">' +
        '<img src="https://pbs.twimg.com/amplify_video_thumb/222/img/poster.jpg">' +
        '<video id="grid-video"></video>' +
      '</a>' +
    '</main>',
    {
      prepare(window) {
        configureFixtureVideo(window, window.document.getElementById('grid-video'), 'blob:https://x.com/grid-video');
      },
      classify: laterFrameClassifier,
    },
  );

  try {
    const tile = harness.window.document.getElementById('video-tile');
    assert.equal(tile.dataset.tabcloserMediaState, 'safe');
    assert.equal(harness.classificationMessages.some(message => message.kind === 'frame'), false);
  } finally {
    harness.dom.window.close();
  }
});

test('a safe poster-only X video thumbnail is released without waiting for a player', async () => {
  const harness = await startCoordinator(
    '<main><a id="poster-tile" href="/example/status/2233333333">' +
      '<img src="https://pbs.twimg.com/amplify_video_thumb/223/img/poster.jpg">' +
    '</a></main>',
    { classify: () => ({ verdict: 'safe', reason: 'visual' }) },
  );

  try {
    await harness.sendContentMessage({
      type: 'xSensitiveMediaMetadata',
      metadata: {
        urls: [],
        tweetIds: [],
        videoSourcesByTweetId: {
          '2233333333': 'https://video.twimg.com/amplify_video/223/vid/low.mp4',
        },
      },
    });
    const tile = harness.window.document.getElementById('poster-tile');
    assert.equal(tile.dataset.tabcloserMediaState, 'safe');
    assert.equal(tile.dataset.tabcloserMediaReason, 'visual');
    assert.deepEqual(harness.classificationMessages.map(message => message.kind), ['url']);
  } finally {
    harness.dom.window.close();
  }
});

test('a mature video poster still protects an otherwise unlabeled video', async () => {
  const harness = await startCoordinator(
    '<article><a href="/example/status/2244444445/video/1">' +
      '<div id="mature-poster-root" data-testid="videoComponent">' +
        '<video poster="https://pbs.twimg.com/amplify_video_thumb/224/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    { classify: () => ({ verdict: 'protect', reason: 'visual' }) },
  );

  try {
    const root = harness.window.document.getElementById('mature-poster-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    assert.deepEqual(harness.classificationMessages.map(message => message.kind), ['url']);
  } finally {
    harness.dom.window.close();
  }
});

test('a VPN-unlabeled blob video checks bounded detached frames without seeking the visible player', async () => {
  const tweetId = '2077422949787959667';
  const directSource = 'https://video.twimg.com/amplify_video/207742/vid/low.mp4?tag=14';
  const harness = await startCoordinator(
    '<article><a href="/example/status/' + tweetId + '/video/1">' +
      '<div id="vpn-video-root" data-testid="videoComponent">' +
        '<video id="vpn-visible-video" poster="https://pbs.twimg.com/amplify_video_thumb/207742/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      url: 'https://x.com/example/status/' + tweetId,
      prepare(window) {
        const visibleVideo = window.document.getElementById('vpn-visible-video');
        let visibleTime = 7;
        window.__visibleSeekCount = 0;
        Object.defineProperties(visibleVideo, {
          currentSrc: { configurable: true, get: () => 'blob:https://x.com/vpn-visible-video' },
          currentTime: {
            configurable: true,
            get: () => visibleTime,
            set(value) {
              window.__visibleSeekCount += 1;
              visibleTime = Number(value);
            },
          },
        });

        const createElement = window.document.createElement.bind(window.document);
        window.document.createElement = function createElementWithVideoProbe(tagName, options) {
          const element = createElement(tagName, options);
          if (String(tagName).toLowerCase() === 'video') configureFixtureVideo(window, element, directSource);
          return element;
        };
      },
      classify(message) {
        if (message.kind === 'url') return { verdict: 'safe', reason: 'visual', adultScore: 0.01 };
        const time = Number(message.mediaKey.match(/\|t=([\d.]+)$/)?.[1] || 0);
        return time >= 5
          ? { verdict: 'protect', reason: 'visual', adultScore: 0.5 }
          : { verdict: 'safe', reason: 'visual', adultScore: 0.02 };
      },
    },
  );

  try {
    await harness.sendContentMessage({
      type: 'xSensitiveMediaMetadata',
      metadata: {
        urls: [],
        tweetIds: [],
        videoSourcesByTweetId: { [tweetId]: directSource },
      },
    });
    await flush(harness.window, 24);

    const root = harness.window.document.getElementById('vpn-video-root');
    const visibleVideo = harness.window.document.getElementById('vpn-visible-video');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    assert.deepEqual(harness.classificationMessages.map(message => message.kind), ['url', 'frame', 'frame']);
    assert.equal(harness.window.__visibleSeekCount, 0);
    assert.equal(visibleVideo.currentTime, 7);
    assert.equal(harness.window.document.querySelector('.tabcloser-video-probe'), null,
      'the detached probe must always be removed');
  } finally {
    harness.dom.window.close();
  }
});


test('a failed detached video probe is removed and cannot leave media hidden forever', async () => {
  const tweetId = '2077422949787959668';
  const directSource = 'https://video.twimg.com/amplify_video/207742/vid/unavailable.mp4?tag=14';
  const harness = await startCoordinator(
    '<article><a href="/example/status/' + tweetId + '/video/1">' +
      '<div id="failed-probe-root" data-testid="videoComponent">' +
        '<video poster="https://pbs.twimg.com/amplify_video_thumb/207742/img/safe-poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      url: 'https://x.com/example/status/' + tweetId,
      prepare(window) {
        const appendChild = window.document.documentElement.appendChild.bind(window.document.documentElement);
        window.document.documentElement.appendChild = function appendWithProbeFailure(node) {
          const result = appendChild(node);
          if (node.classList?.contains('tabcloser-video-probe')) {
            window.queueMicrotask(() => node.dispatchEvent(new window.Event('error')));
          }
          return result;
        };
      },
      classify: () => ({ verdict: 'safe', reason: 'visual' }),
    },
  );

  try {
    await harness.sendContentMessage({
      type: 'xSensitiveMediaMetadata',
      metadata: {
        urls: [],
        tweetIds: [],
        videoSourcesByTweetId: { [tweetId]: directSource },
      },
    });
    await flush(harness.window, 20);

    const root = harness.window.document.getElementById('failed-probe-root');
    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    assert.equal(harness.window.document.querySelector('.tabcloser-video-probe'), null);
  } finally {
    harness.dom.window.close();
  }
});

test('an invalid poster verdict does not permanently hide an unlabeled video', async () => {
  const harness = await startCoordinator(
    '<article><a href="/example/status/2244444446/video/1">' +
      '<div id="invalid-poster-root" data-testid="videoComponent">' +
        '<video poster="https://pbs.twimg.com/amplify_video_thumb/225/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    { classify: () => ({ verdict: 'protect', reason: 'invalid' }) },
  );

  try {
    const root = harness.window.document.getElementById('invalid-poster-root');
    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
  } finally {
    harness.dom.window.close();
  }
});
test('mounting a source-less video does not trigger frame classification', async () => {
  const harness = await startCoordinator(
    '<article><a href="/example/status/3333333333">' +
      '<div id="late-video-root" data-testid="videoComponent">' +
        '<img src="https://pbs.twimg.com/amplify_video_thumb/333/img/poster.jpg">' +
      '</div>' +
    '</a></article>',
    { classify: laterFrameClassifier },
  );

  try {
    const root = harness.window.document.getElementById('late-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'safe');

    const video = harness.window.document.createElement('video');
    configureFixtureVideo(harness.window, video);
    root.appendChild(video);
    await flush(harness.window, 16);

    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    assert.equal(harness.classificationMessages.some(message => message.kind === 'frame'), false);
  } finally {
    harness.dom.window.close();
  }
});


test('outer tweet metadata does not censor a safe quoted tweet in the same article', async () => {
  const harness = await startCoordinator(`
    <article>
      <a href="/outer/status/5555555555/photo/1">
        <div id="outer-root" data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/outer.jpg"></div>
      </a>
      <div id="quoted-card" role="link">
        <div id="quoted-text" data-testid="tweetText">A safe quoted post</div>
        <a href="/quoted/status/6666666666/photo/1">
          <div id="quoted-root" data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/quoted.jpg"></div>
        </a>
      </div>
    </article>
  `, {
    config: {
      labeled: { enabled: true },
      model: { enabled: true, sensitivity: 'balanced' },
      replaceText: true,
    },
    prepare(window) {
      window.TabCloserQuotes = [{ text: 'Replacement', author: 'Author' }];
    },
  });

  try {
    await harness.sendContentMessage({
      type: 'xSensitiveMediaMetadata',
      metadata: { urls: [], tweetIds: ['5555555555'] },
    });

    const outer = harness.window.document.getElementById('outer-root');
    const quoted = harness.window.document.getElementById('quoted-root');
    const quotedText = harness.window.document.getElementById('quoted-text');
    assert.equal(outer.dataset.tabcloserMediaState, 'protected');
    assert.equal(quoted.dataset.tabcloserMediaState, 'safe', 'nested quoted media belongs to a separate tweet layer');
    assert.equal(quotedText.dataset.tabcloserQuoted, undefined);
    assert.equal(quotedText.classList.contains('tabcloser-hidden-text'), false);
    assert.equal(harness.window.document.querySelector('.tabcloser-quote'), null);
  } finally {
    harness.dom.window.close();
  }
});

test('turning protection off cancels an in-flight video-poster classification', async () => {
  const posterResolvers = [];
  const harness = await startCoordinator(
    '<article><a href="/example/status/7777777777/video/1">' +
      '<div id="cancel-root" data-testid="videoComponent"><video id="cancel-video" poster="https://pbs.twimg.com/amplify_video_thumb/777/img/poster.jpg"></video></div>' +
    '</a></article>',
    {
      prepare(window) {
        configureFixtureVideo(window, window.document.getElementById('cancel-video'));
      },
      classify() {
        return new Promise(resolve => { posterResolvers.push(resolve); });
      },
    },
  );

  try {
    const inFlightCount = harness.classificationMessages.length;
    assert.ok(inFlightCount > 0, 'the poster should be awaiting a verdict');
    await harness.sendContentMessage({
      type: 'xProtectionChanged',
      xProtection: {
        labeled: { enabled: false },
        model: { enabled: false, sensitivity: 'balanced' },
      },
    });
    for (const resolve of [...posterResolvers]) resolve({ verdict: 'safe', reason: 'visual' });
    await flush(harness.window, 12);

    const root = harness.window.document.getElementById('cancel-root');
    assert.equal(harness.window.document.documentElement.dataset.tabcloserXProtection, 'off');
    assert.equal(root.dataset.tabcloserMediaState, undefined, 'turning protection off must clear the media state');
    assert.equal(harness.classificationMessages.length, inFlightCount, 'no further poster work may start after protection is disabled');
  } finally {
    harness.dom.window.close();
  }
});

test('visibility-only TweetDetail metadata protects the current detail video', async () => {
  const harness = await startCoordinator(

    '<div id="modal-video-root" data-testid="videoComponent">' +
      '<img src="https://pbs.twimg.com/amplify_video_thumb/444/img/poster.jpg">' +
    '</div>',
    { url: 'https://x.com/example/status/4444444444/video/1' },
  );

  try {
    const root = harness.window.document.getElementById('modal-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    const extracted = metadata.extractSensitiveMedia({
      data: {
        result: {
          __typename: 'TweetWithVisibilityResults',
          tweet: {
            rest_id: '4444444444',
            legacy: { possibly_sensitive: true },
          },
          limitedActionResults: { limited_actions: [{ action: 'DoNotAllow' }] },
        },
      },
    });
    await harness.sendContentMessage({
      type: 'xSensitiveMediaMetadata',
      metadata: extracted,
    });
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    assert.ok(harness.debugMessages.some(([, serialized]) => {
      const diagnostic = JSON.parse(serialized);
      return diagnostic?.event === 'metadata-applied' &&
        diagnostic.pageStatusId === '4444444444' &&
        diagnostic.pageTweetKnownSensitive === true &&
        diagnostic.matchedRoots.some(match => match.statusId === '4444444444');
    }));
    assert.equal(root.dataset.tabcloserMediaReason, 'metadata');
  } finally {
    harness.dom.window.close();
  }
});

test('nested X media roots are classified once instead of again through their status link', async () => {
  const harness = await startCoordinator(
    '<main><a href="/example/status/2211111111">' +
      '<div id="single-root" data-testid="tweetPhoto">' +
        '<img src="https://pbs.twimg.com/media/single.jpg">' +
      '</div>' +
    '</a></main>',
  );

  try {
    assert.equal(harness.window.document.getElementById('single-root').dataset.tabcloserMediaState, 'safe');
    assert.equal(harness.classificationMessages.length, 1, 'the containing status link must not become a duplicate root');
  } finally {
    harness.dom.window.close();
  }
});

test('replacement artwork never becomes a media root or classifier input', async () => {
  const harness = await startCoordinator(
    '<main><a href="/example/status/2244444444/photo/1">' +
      '<div id="painted-root" data-testid="tweetPhoto">' +
        '<img src="https://pbs.twimg.com/media/protected.jpg">' +
      '</div>' +
    '</a></main>',
    { classify: () => ({ verdict: 'protect', reason: 'visual' }) },
  );

  try {
    await flush(harness.window, 20);
    const root = harness.window.document.getElementById('painted-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    assert.ok(root.closest('a').querySelector('.tabcloser-overlay-artwork'));
    assert.equal(harness.classificationMessages.length, 1, 'adding replacement art must not requeue the protected tile');
    assert.equal(
      harness.classificationMessages.some(message => String(message.url || '').startsWith('moz-extension:')),
      false,
      'extension-owned artwork must never be classified',
    );
  } finally {
    harness.dom.window.close();
  }
});

test('an absolutely positioned X grid anchor keeps its positioning', async () => {
  const harness = await startCoordinator(
    '<div style="position:relative;padding-bottom:100%">' +
      '<a id="absolute-tile" style="position:absolute;inset:0" href="/example/status/2255555555">' +
        '<span>Warning: Nudity</span>' +
      '</a>' +
    '</div>',
    {
      config: {
        labeled: { enabled: true },
        model: { enabled: false, sensitivity: 'balanced' },
      },
    },
  );

  try {
    const tile = harness.window.document.getElementById('absolute-tile');
    assert.ok(tile.classList.contains('tabcloser-overlay-host'));
    assert.equal(tile.classList.contains('tabcloser-overlay-host-static'), false);
    assert.equal(harness.window.getComputedStyle(tile).position, 'absolute');
  } finally {
    harness.dom.window.close();
  }
});

test('video poster classification does not depend on buffered ranges', async () => {
  const harness = await startCoordinator(
    '<article><a href="/example/status/2266666666/video/1">' +
      '<div id="buffered-root" data-testid="videoComponent">' +
        '<video id="buffered-video" poster="https://pbs.twimg.com/amplify_video_thumb/226/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      prepare(window) {
        const video = window.document.getElementById('buffered-video');
        configureFixtureVideo(window, video, 'blob:https://x.com/slow-vpn-video');
        Object.defineProperty(video, 'buffered', {
          configurable: true,
          get: () => ({ length: 1, start: () => 0, end: () => 1 }),
        });
      },
    },
  );

  try {
    const root = harness.window.document.getElementById('buffered-root');
    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    assert.equal(
      harness.classificationMessages.some(message => /\|t=(?:5|10|15|19)/.test(message.mediaKey || '')),
      false,
      'classification must not trigger remote segment loads by seeking beyond the buffer',
    );
  } finally {
    harness.dom.window.close();
  }
});

test('replacement artwork stays stable while X changes the media source', async () => {
  const harness = await startCoordinator(
    '<article><a href="/example/status/2277777777/photo/1">' +
      '<div id="stable-art-root" data-testid="tweetPhoto">' +
        '<img id="stable-art-image" src="https://pbs.twimg.com/media/source-0.jpg">' +
      '</div>' +
    '</a></article>',
    {
      prepare(window) {
        window.TabCloserSacredArt = Array.from({ length: 97 }, (_, index) => 'painting-' + index + '.jpg');
      },
      classify: () => ({ verdict: 'protect', reason: 'visual' }),
    },
  );

  try {
    await flush(harness.window, 20);
    const root = harness.window.document.getElementById('stable-art-root');
    const image = harness.window.document.getElementById('stable-art-image');
    const host = root.closest('a');
    const firstArtwork = host.querySelector('.tabcloser-overlay-artwork')?.style.backgroundImage;
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    assert.ok(firstArtwork);

    for (let index = 1; index <= 3; index += 1) {
      image.src = 'https://pbs.twimg.com/media/source-' + index + '.jpg';
      await flush(harness.window, 16);
      assert.equal(root.dataset.tabcloserMediaState, 'protected');
      assert.equal(host.querySelector('.tabcloser-overlay-artwork')?.style.backgroundImage, firstArtwork);
    }
  } finally {
    harness.dom.window.close();
  }
});

test('buffer growth does not reclassify a verified video poster', async () => {
  let bufferedEnd = 1;
  const harness = await startCoordinator(
    '<article><a href="/example/status/2288888888/video/1">' +
      '<div id="progress-root" data-testid="videoComponent">' +
        '<video id="progress-video" poster="https://pbs.twimg.com/amplify_video_thumb/228/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      prepare(window) {
        const video = window.document.getElementById('progress-video');
        configureFixtureVideo(window, video, 'blob:https://x.com/progressive-vpn-video');
        Object.defineProperty(video, 'buffered', {
          configurable: true,
          get: () => ({ length: 1, start: () => 0, end: () => bufferedEnd }),
        });
      },
      classify: laterFrameClassifier,
    },
  );

  try {
    const root = harness.window.document.getElementById('progress-root');
    const video = harness.window.document.getElementById('progress-video');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    const classificationsBeforeGrowth = harness.classificationMessages.length;

    bufferedEnd = 20;
    video.dispatchEvent(new harness.window.Event('progress'));
    await new Promise(resolve => harness.window.setTimeout(resolve, 150));
    await flush(harness.window, 24);

    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    assert.equal(harness.classificationMessages.length, classificationsBeforeGrowth);
  } finally {
    harness.dom.window.close();
  }
});

test('MediaSource buffer growth without an event does not reclassify a verified poster', async () => {
  let bufferedEnd = 1;
  const harness = await startCoordinator(
    '<article><a href="/example/status/2299999999/video/1">' +
      '<div id="eventless-root" data-testid="videoComponent">' +
        '<video id="eventless-video" poster="https://pbs.twimg.com/amplify_video_thumb/229/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      prepare(window) {
        const video = window.document.getElementById('eventless-video');
        configureFixtureVideo(window, video, 'blob:https://x.com/eventless-mediasource-video');
        Object.defineProperty(video, 'buffered', {
          configurable: true,
          get: () => ({ length: 1, start: () => 0, end: () => bufferedEnd }),
        });
      },
    },
  );

  try {
    const root = harness.window.document.getElementById('eventless-root');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    const classificationsBeforeGrowth = harness.classificationMessages.length;

    bufferedEnd = 20;
    await new Promise(resolve => harness.window.setTimeout(resolve, 400));
    await flush(harness.window, 24);

    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    assert.equal(harness.classificationMessages.length, classificationsBeforeGrowth);
  } finally {
    harness.dom.window.close();
  }
});

test('a safe blob video is released only after its time and mute state are restored', async () => {
  const harness = await startCoordinator(
    '<article><a href="/example/status/2300000000/video/1">' +
      '<div id="restore-root" data-testid="videoComponent">' +
        '<video id="restore-video" poster="https://pbs.twimg.com/amplify_video_thumb/230/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      prepare(window) {
        const root = window.document.getElementById('restore-root');
        const video = window.document.getElementById('restore-video');
        let currentTime = 0;
        Object.defineProperties(video, {
          currentSrc: { configurable: true, get: () => 'blob:https://x.com/restore-video' },
          currentTime: {
            configurable: true,
            get: () => currentTime,
            set(value) {
              const nextTime = Number(value);
              const delay = nextTime === 0 && currentTime > 0 ? 50 : 0;
              window.setTimeout(() => {
                currentTime = nextTime;
                video.dispatchEvent(new window.Event('seeked'));
              }, delay);
            },
          },
          duration: { configurable: true, get: () => 20 },
          readyState: { configurable: true, get: () => 4 },
          buffered: {
            configurable: true,
            get: () => ({ length: 1, start: () => 0, end: () => 20 }),
          },
        });
        video.muted = false;
        window.__safePlaybackSnapshot = null;
        new window.MutationObserver(() => {
          if (root.dataset.tabcloserMediaState === 'safe' && !window.__safePlaybackSnapshot) {
            window.__safePlaybackSnapshot = { currentTime: video.currentTime, muted: video.muted };
          }
        }).observe(root, { attributes: true, attributeFilter: ['data-tabcloser-media-state'] });
      },
    },
  );

  try {
    const root = harness.window.document.getElementById('restore-root');
    await new Promise(resolve => harness.window.setTimeout(resolve, 100));
    await flush(harness.window, 20);

    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    assert.deepEqual(harness.window.__safePlaybackSnapshot, { currentTime: 0, muted: false });
  } finally {
    harness.dom.window.close();
  }
});

test('a fully verified detail video stays safe when X remounts its timeline poster', async () => {
  const poster = 'https://pbs.twimg.com/amplify_video_thumb/231/img/poster.jpg';
  const harness = await startCoordinator(
    '<main id="route"><article><a href="/example/status/2311111111/video/1">' +
      '<div id="detail-root" data-testid="videoComponent">' +
        '<video id="detail-video" poster="' + poster + '"></video>' +
      '</div>' +
    '</a></article></main>',
    {
      prepare(window) {
        configureFixtureVideo(
          window,
          window.document.getElementById('detail-video'),
          'blob:https://x.com/detail-safe-video',
        );
      },
    },
  );

  try {
    assert.equal(harness.window.document.getElementById('detail-root').dataset.tabcloserMediaState, 'safe');
    const classificationsBeforeRemount = harness.classificationMessages.length;
    const route = harness.window.document.getElementById('route');
    route.innerHTML =
      '<article><a href="/example/status/2311111111">' +
        '<div id="timeline-root" data-testid="tweetPhoto">' +
          '<img src="' + poster + '">' +
        '</div>' +
      '</a></article>';
    await flush(harness.window, 24);

    const timelineRoot = harness.window.document.getElementById('timeline-root');
    assert.equal(timelineRoot.dataset.tabcloserMediaState, 'safe');
    assert.equal(timelineRoot.dataset.tabcloserMediaReason, 'visual');
    assert.equal(
      harness.classificationMessages.length,
      classificationsBeforeRemount,
      'the same stable video poster must reuse the completed detail verification',
    );
  } finally {
    harness.dom.window.close();
  }
});

test('poster verification never seeks an HLS video to expand its buffer', async () => {
  let currentTime = 0;
  let bufferedEnd = 18;
  const harness = await startCoordinator(
    '<article><a href="/example/status/2322222222/video/1">' +
      '<div id="windowed-root" data-testid="videoComponent">' +
        '<video id="windowed-video" poster="https://pbs.twimg.com/amplify_video_thumb/232/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      prepare(window) {
        const video = window.document.getElementById('windowed-video');
        Object.defineProperties(video, {
          currentSrc: { configurable: true, get: () => 'blob:https://x.com/windowed-hls-video' },
          currentTime: {
            configurable: true,
            get: () => currentTime,
            set(value) {
              const nextTime = Number(value);
              currentTime = nextTime;
              window.queueMicrotask(() => video.dispatchEvent(new window.Event('seeked')));
              if (nextTime < 15) return;
              window.setTimeout(() => {
                if (currentTime >= nextTime - 0.02) {
                  bufferedEnd = Math.max(bufferedEnd, Math.min(60, nextTime + 18));
                }
              }, 50);
            },
          },
          duration: { configurable: true, get: () => 60 },
          readyState: { configurable: true, get: () => 4 },
          buffered: {
            configurable: true,
            get: () => ({ length: 1, start: () => 0, end: () => bufferedEnd }),
          },
        });
        video.muted = false;
      },
    },
  );

  try {
    const root = harness.window.document.getElementById('windowed-root');
    const video = harness.window.document.getElementById('windowed-video');
    await new Promise(resolve => harness.window.setTimeout(resolve, 1200));
    await flush(harness.window, 24);

    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    assert.equal(currentTime, 0, 'the original playback position must be restored after the final verdict');
    assert.equal(video.muted, false, 'the original mute state must be restored after the final verdict');
    assert.equal(
      harness.classificationMessages.some(message => message.kind === 'frame'),
      false,
      'video playback frames must never be sampled',
    );
  } finally {
    harness.dom.window.close();
  }
});

test('a direct-video mature verdict persists for remounted media without a second probe', async () => {
  const tweetId = '3011111111111111111';
  const otherTweetId = '3022222222222222222';
  const directSource = 'https://video.twimg.com/amplify_video/301111/vid/low.mp4?tag=14';
  const harness = await startCoordinator(
    '<article><a href="/example/status/' + tweetId + '/video/1">' +
      '<div id="session-video-root" data-testid="videoComponent">' +
        '<video poster="https://pbs.twimg.com/amplify_video_thumb/301111/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      url: 'https://x.com/example/status/' + tweetId,
      prepare(window) {
        const createElement = window.document.createElement.bind(window.document);
        window.document.createElement = function createElementWithVideoProbe(tagName, options) {
          const element = createElement(tagName, options);
          if (String(tagName).toLowerCase() === 'video') configureFixtureVideo(window, element, directSource);
          return element;
        };
      },
      classify: laterFrameClassifier,
    },
  );

  try {
    await harness.sendContentMessage({
      type: 'xSensitiveMediaMetadata',
      metadata: {
        urls: [],
        tweetIds: [],
        videoSourcesByTweetId: { [tweetId]: directSource },
      },
    });
    await flush(harness.window, 24);

    const root = harness.window.document.getElementById('session-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    const frameMessagesAfterDetail = harness.classificationMessages.filter(message => message.kind === 'frame').length;
    assert.ok(frameMessagesAfterDetail > 0, 'the detail view must have probed the direct video');

    // Simulate navigating back to the Media tab: X remounts the grid with
    // poster-only tiles for the same tweet and an unrelated one.
    harness.window.document.body.innerHTML =
      '<main>' +
        '<a id="regrid-tile" href="/example/status/' + tweetId + '/video/1">' +
          '<img src="https://pbs.twimg.com/amplify_video_thumb/301111/img/poster.jpg">' +
        '</a>' +
        '<a id="other-tile" href="/example/status/' + otherTweetId + '/video/1">' +
          '<img src="https://pbs.twimg.com/amplify_video_thumb/302222/img/other-poster.jpg">' +
        '</a>' +
      '</main>';
    await flush(harness.window, 24);

    const regridTile = harness.window.document.getElementById('regrid-tile');
    assert.equal(regridTile.dataset.tabcloserMediaState, 'protected',
      'the remounted thumbnail must inherit the session verdict');
    assert.equal(regridTile.dataset.tabcloserMediaReason, 'visual');
    assert.ok(regridTile.querySelector('.tabcloser-media-overlay-art'),
      'the remounted thumbnail must be painted immediately');

    const frameMessagesAfterRemount = harness.classificationMessages.filter(message => message.kind === 'frame').length;
    assert.equal(frameMessagesAfterRemount, frameMessagesAfterDetail,
      'the remounted tweet must not trigger a second video probe');

    const otherTile = harness.window.document.getElementById('other-tile');
    assert.equal(otherTile.dataset.tabcloserMediaState, 'safe',
      'an unrelated tweet must not inherit the verdict');
    assert.equal(otherTile.querySelector('.tabcloser-media-overlay'), null);
  } finally {
    harness.dom.window.close();
  }
});

test('a direct-video safe verdict is not propagated as protected on remount', async () => {
  const tweetId = '3033333333333333333';
  const directSource = 'https://video.twimg.com/amplify_video/303333/vid/low.mp4?tag=14';
  const harness = await startCoordinator(
    '<article><a href="/example/status/' + tweetId + '/video/1">' +
      '<div id="safe-video-root" data-testid="videoComponent">' +
        '<video poster="https://pbs.twimg.com/amplify_video_thumb/303333/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      url: 'https://x.com/example/status/' + tweetId,
      prepare(window) {
        const createElement = window.document.createElement.bind(window.document);
        window.document.createElement = function createElementWithVideoProbe(tagName, options) {
          const element = createElement(tagName, options);
          if (String(tagName).toLowerCase() === 'video') configureFixtureVideo(window, element, directSource);
          return element;
        };
      },
      classify: () => ({ verdict: 'safe', reason: 'visual' }),
    },
  );

  try {
    await harness.sendContentMessage({
      type: 'xSensitiveMediaMetadata',
      metadata: {
        urls: [],
        tweetIds: [],
        videoSourcesByTweetId: { [tweetId]: directSource },
      },
    });
    await flush(harness.window, 24);
    assert.equal(harness.window.document.getElementById('safe-video-root').dataset.tabcloserMediaState, 'safe');

    harness.window.document.body.innerHTML =
      '<main><a id="safe-regrid-tile" href="/example/status/' + tweetId + '/video/1">' +
        '<img src="https://pbs.twimg.com/amplify_video_thumb/303333/img/poster.jpg">' +
      '</a></main>';
    await flush(harness.window, 24);

    const tile = harness.window.document.getElementById('safe-regrid-tile');
    assert.equal(tile.dataset.tabcloserMediaState, 'safe');
    assert.equal(tile.querySelector('.tabcloser-media-overlay-art'), null);
  } finally {
    harness.dom.window.close();
  }
});

test('post text is replaced when the media viewer lives outside the tweet article', async () => {
  const tweetId = '3044444444444444444';
  const directSource = 'https://video.twimg.com/amplify_video/304444/vid/low.mp4?tag=14';
  const harness = await startCoordinator(
    '<div id="outside-viewer" data-testid="videoComponent">' +
      '<video poster="https://pbs.twimg.com/amplify_video_thumb/304444/img/poster.jpg"></video>' +
    '</div>' +
    '<article id="detail-article">' +
      '<a href="/example/status/' + tweetId + '"><time>1h</time></a>' +
      '<div data-testid="tweetText">original sensitive text</div>' +
    '</article>',
    {
      url: 'https://x.com/example/status/' + tweetId,
      config: {
        labeled: { enabled: true },
        model: { enabled: true, sensitivity: 'balanced' },
        replaceText: true,
      },
      prepare(window) {
        window.TabCloserQuotes = [{ text: 'Test quote', author: 'Test Author' }];
        const createElement = window.document.createElement.bind(window.document);
        window.document.createElement = function createElementWithVideoProbe(tagName, options) {
          const element = createElement(tagName, options);
          if (String(tagName).toLowerCase() === 'video') configureFixtureVideo(window, element, directSource);
          return element;
        };
      },
      classify(message) {
        return message.kind === 'frame'
          ? { verdict: 'protect', reason: 'visual', adultScore: 0.5 }
          : { verdict: 'safe', reason: 'visual', adultScore: 0.01 };
      },
    },
  );

  try {
    await harness.sendContentMessage({
      type: 'xSensitiveMediaMetadata',
      metadata: {
        urls: [],
        tweetIds: [],
        videoSourcesByTweetId: { [tweetId]: directSource },
      },
    });
    await flush(harness.window, 24);

    const viewer = harness.window.document.getElementById('outside-viewer');
    assert.equal(viewer.dataset.tabcloserMediaState, 'protected');
    assert.equal(viewer.dataset.tabcloserMediaReason, 'visual');

    const article = harness.window.document.getElementById('detail-article');
    const text = article.querySelector('[data-testid="tweetText"]');
    assert.equal(text.dataset.tabcloserQuoted, 'yes', 'the article located by status ID must have its text replaced');
    assert.ok(text.classList.contains('tabcloser-hidden-text'));
    assert.ok(article.querySelector('.tabcloser-quote'), 'a quote must replace the post text');
  } finally {
    harness.dom.window.close();
  }
});

// Frames report an adultScore below the single-frame threshold (0.2 balanced)
// but with a mean above 0.7 * threshold, or in the escalation band (>= 0.1).
function scoredFrameClassifier(scoresByTime) {
  return message => {
    if (message.kind === 'url') return { verdict: 'safe', reason: 'visual', adultScore: 0.01 };
    const time = Number(message.mediaKey.match(/\|t=([\d.]+)$/)?.[1] || 0);
    const adultScore = scoresByTime[time] ?? 0;
    return { verdict: adultScore >= 0.2 ? 'protect' : 'safe', reason: 'visual', adultScore };
  };
}

function directVideoHarness(tweetId, directSource, classify) {
  return startCoordinator(
    '<article><a href="/example/status/' + tweetId + '/video/1">' +
      '<div id="scored-video-root" data-testid="videoComponent">' +
        '<video poster="https://pbs.twimg.com/amplify_video_thumb/305555/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      url: 'https://x.com/example/status/' + tweetId,
      prepare(window) {
        const createElement = window.document.createElement.bind(window.document);
        window.document.createElement = function createElementWithVideoProbe(tagName, options) {
          const element = createElement(tagName, options);
          if (String(tagName).toLowerCase() === 'video') configureFixtureVideo(window, element, directSource);
          return element;
        };
      },
      classify,
    },
  );
}

async function sendDirectVideoMetadata(harness, tweetId, directSource) {
  await harness.sendContentMessage({
    type: 'xSensitiveMediaMetadata',
    metadata: { urls: [], tweetIds: [], videoSourcesByTweetId: { [tweetId]: directSource } },
  });
  await flush(harness.window, 24);
}

function directVideoVerdicts(harness) {
  return harness.debugMessages
    .map(args => { try { return JSON.parse(args[1]); } catch { return null; } })
    .filter(entry => entry?.event === 'direct-video-verdict');
}

test('borderline frame scores aggregate to a mature verdict without extra sampling', async () => {
  const tweetId = '3055555555555555555';
  const directSource = 'https://video.twimg.com/amplify_video/305555/vid/low.mp4?tag=14';
  // Base frames land at t=3, 10, 17 for a 20s fixture; each is below the
  // 0.2 single-frame threshold, but three frames average 0.16 >= 0.14.
  const harness = await directVideoHarness(tweetId, directSource,
    scoredFrameClassifier({ 3: 0.16, 10: 0.16, 17: 0.16 }));

  try {
    await sendDirectVideoMetadata(harness, tweetId, directSource);
    const root = harness.window.document.getElementById('scored-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    const [verdict] = directVideoVerdicts(harness);
    assert.equal(verdict.aggregate, 'mean');
    assert.equal(verdict.samplesChecked, 3, 'the mean rule needs three agreeing frames, never two');
    assert.equal(verdict.promoted, true);
  } finally {
    harness.dom.window.close();
  }
});

test('a marginal single frame with clean neighbors censors locally but is not promoted', async () => {
  const tweetId = '3166666666666666666';
  const directSource = 'https://video.twimg.com/amplify_video/316666/vid/low.mp4?tag=14';
  // One frame at 0.25 (marginal: above 0.2, below the 0.4 strong bar); every
  // other base and escalation frame is clean, so nothing corroborates it.
  const harness = await directVideoHarness(tweetId, directSource,
    scoredFrameClassifier({ 3: 0.25, 10: 0.02, 17: 0.02, 6: 0.02, 13: 0.02, 19: 0.02 }));

  try {
    await sendDirectVideoMetadata(harness, tweetId, directSource);
    const root = harness.window.document.getElementById('scored-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected',
      'the mounted player still fails closed on a marginal frame');
    const [verdict] = directVideoVerdicts(harness);
    assert.equal(verdict.aggregate, 'max-unconfirmed');
    assert.equal(verdict.promoted, false);
    assert.equal(verdict.samplesChecked, 6, 'a marginal hit must exhaust the escalation frames looking for corroboration');

    // The session set must not know this tweet: a remounted grid tile gets a
    // fresh look instead of inheriting the doubtful verdict.
    harness.window.document.body.innerHTML =
      '<main><a id="marginal-regrid-tile" href="/example/status/' + tweetId + '/video/1">' +
        '<img src="https://pbs.twimg.com/amplify_video_thumb/316666/img/poster.jpg">' +
      '</a></main>';
    await flush(harness.window, 24);
    const tile = harness.window.document.getElementById('marginal-regrid-tile');
    assert.equal(tile.dataset.tabcloserMediaState, 'safe',
      'an unconfirmed marginal verdict must not paint other surfaces of the tweet');
  } finally {
    harness.dom.window.close();
  }
});

test('a marginal frame corroborated by a second suspicious frame protects and promotes', async () => {
  const tweetId = '3177777777777777777';
  const directSource = 'https://video.twimg.com/amplify_video/317777/vid/low.mp4?tag=14';
  // Frame one is marginal (0.25); frame two sits in the escalation band
  // (0.12 >= 0.1), which is enough agreement to confirm the verdict.
  const harness = await directVideoHarness(tweetId, directSource,
    scoredFrameClassifier({ 3: 0.25, 10: 0.12, 17: 0.02 }));

  try {
    await sendDirectVideoMetadata(harness, tweetId, directSource);
    const root = harness.window.document.getElementById('scored-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    const [verdict] = directVideoVerdicts(harness);
    assert.equal(verdict.aggregate, 'confirmed');
    assert.equal(verdict.promoted, true);
    assert.equal(verdict.samplesChecked, 2, 'corroboration must stop sampling at the confirming frame');
  } finally {
    harness.dom.window.close();
  }
});

test('a borderline base pass escalates to extra frames and catches a late explicit frame', async () => {
  const tweetId = '3066666666666666666';
  const directSource = 'https://video.twimg.com/amplify_video/306666/vid/low.mp4?tag=14';
  // Base frames (3, 10, 17) stay borderline-low: max 0.12 >= 0.1 escalation
  // band but mean 0.117 < 0.14. The first escalation frame (t=6) is explicit.
  const harness = await directVideoHarness(tweetId, directSource,
    scoredFrameClassifier({ 3: 0.12, 10: 0.11, 17: 0.12, 6: 0.5 }));

  try {
    await sendDirectVideoMetadata(harness, tweetId, directSource);
    const root = harness.window.document.getElementById('scored-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    const frameCount = harness.classificationMessages.filter(message => message.kind === 'frame').length;
    assert.equal(frameCount, 4, 'escalation must stop at the first explicit frame');
    const [verdict] = directVideoVerdicts(harness);
    assert.equal(verdict.aggregate, 'max');
    assert.equal(verdict.samplesChecked, 4);
  } finally {
    harness.dom.window.close();
  }
});

function croppedVideoHarness(tweetId, directSource, videoWidth, videoHeight, classify) {
  return startCoordinator(
    '<article><a href="/example/status/' + tweetId + '/video/1">' +
      '<div id="cropped-video-root" data-testid="videoComponent">' +
        '<video poster="https://pbs.twimg.com/amplify_video_thumb/308888/img/poster.jpg"></video>' +
      '</div>' +
    '</a></article>',
    {
      url: 'https://x.com/example/status/' + tweetId,
      prepare(window) {
        const createElement = window.document.createElement.bind(window.document);
        window.document.createElement = function createElementWithVideoProbe(tagName, options) {
          const element = createElement(tagName, options);
          if (String(tagName).toLowerCase() === 'video') {
            configureFixtureVideo(window, element, directSource);
            Object.defineProperties(element, {
              videoWidth: { configurable: true, get: () => videoWidth },
              videoHeight: { configurable: true, get: () => videoHeight },
            });
          }
          return element;
        };
      },
      classify,
    },
  );
}

// Squashed frames score just above the crop gate (0.25 * 0.2 = 0.05
// balanced), so the crop pass runs and catches what the squash missed.
function cropAwareClassifier(message) {
  if (message.kind === 'url') return { verdict: 'safe', reason: 'visual', adultScore: 0.01 };
  return message.mediaKey.endsWith('|crop')
    ? { verdict: 'protect', reason: 'visual', adultScore: 0.6 }
    : { verdict: 'safe', reason: 'visual', adultScore: 0.06 };
}

// Squashed frames read clearly innocent (below the crop gate); the crop pass
// must not run even though it would falsely protect.
function innocentSquashClassifier(message) {
  if (message.kind === 'url') return { verdict: 'safe', reason: 'visual', adultScore: 0.01 };
  return message.mediaKey.endsWith('|crop')
    ? { verdict: 'protect', reason: 'visual', adultScore: 0.84 }
    : { verdict: 'safe', reason: 'visual', adultScore: 0.02 };
}

test('a wide video frame is caught by the centered crop when the squashed frame misses', async () => {
  const tweetId = '3088888888888888888';
  const directSource = 'https://video.twimg.com/amplify_video/308888/vid/low.mp4?tag=14';
  const harness = await croppedVideoHarness(tweetId, directSource, 1280, 720, cropAwareClassifier);

  try {
    await sendDirectVideoMetadata(harness, tweetId, directSource);
    const root = harness.window.document.getElementById('cropped-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    assert.equal(root.dataset.tabcloserMediaReason, 'visual');
    const frameKeys = harness.classificationMessages
      .filter(message => message.kind === 'frame')
      .map(message => message.mediaKey);
    assert.ok(frameKeys.some(key => key.endsWith('|crop')), 'a wide frame must also be classified center-cropped');
    assert.equal(frameKeys.length, 2, 'the crop verdict must stop sampling at the first frame');
  } finally {
    harness.dom.window.close();
  }
});

test('a clearly innocent vertical video never reaches the crop pass that would falsely protect it', async () => {
  const tweetId = '3155555555555555555';
  const directSource = 'https://video.twimg.com/amplify_video/315555/vid/low.mp4?tag=14';
  const harness = await croppedVideoHarness(tweetId, directSource, 406, 720, innocentSquashClassifier);

  try {
    await sendDirectVideoMetadata(harness, tweetId, directSource);
    const root = harness.window.document.getElementById('cropped-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'safe',
      'innocent squash frames must release the video without consulting the crop');
    const frameKeys = harness.classificationMessages
      .filter(message => message.kind === 'frame')
      .map(message => message.mediaKey);
    assert.equal(frameKeys.some(key => key.endsWith('|crop')), false,
      'the crop gate must skip frames whose squashed score shows no suspicion');
    const [verdict] = directVideoVerdicts(harness);
    assert.equal(verdict.verdict, 'safe');
    assert.equal(verdict.frames.length, 3, 'per-frame scores must be logged for diagnosis');
    assert.ok(verdict.frames.every(frame => frame.crop === null));
  } finally {
    harness.dom.window.close();
  }
});

test('a square video never pays for a center-crop classification', async () => {
  const tweetId = '3099999999999999999';
  const directSource = 'https://video.twimg.com/amplify_video/309999/vid/low.mp4?tag=14';
  const harness = await croppedVideoHarness(tweetId, directSource, 720, 720, cropAwareClassifier);

  try {
    await sendDirectVideoMetadata(harness, tweetId, directSource);
    const root = harness.window.document.getElementById('cropped-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    const frameKeys = harness.classificationMessages
      .filter(message => message.kind === 'frame')
      .map(message => message.mediaKey);
    assert.equal(frameKeys.some(key => key.endsWith('|crop')), false,
      'square frames must skip the redundant crop');
    assert.equal(frameKeys.length, 3);
  } finally {
    harness.dom.window.close();
  }
});

test('a clean video keeps the original three-frame cost with no escalation', async () => {
  const tweetId = '3077777777777777777';
  const directSource = 'https://video.twimg.com/amplify_video/307777/vid/low.mp4?tag=14';
  const harness = await directVideoHarness(tweetId, directSource,
    scoredFrameClassifier({ 3: 0.02, 10: 0.02, 17: 0.02 }));

  try {
    await sendDirectVideoMetadata(harness, tweetId, directSource);
    const root = harness.window.document.getElementById('scored-video-root');
    assert.equal(root.dataset.tabcloserMediaState, 'safe');
    const frameCount = harness.classificationMessages.filter(message => message.kind === 'frame').length;
    assert.equal(frameCount, 3, 'clean videos must never pay for escalation frames');
    const [verdict] = directVideoVerdicts(harness);
    assert.equal(verdict.verdict, 'safe');
    assert.equal(verdict.samplesChecked, 3);
  } finally {
    harness.dom.window.close();
  }
});

test('the painting is picked to match the censored cell shape', async () => {
  function shapedHarness(width, height) {
    return startCoordinator(
      '<article><a id="shaped-host" href="/example/status/3133333333/photo/1">' +
        '<div id="shaped-root" data-testid="tweetPhoto">' +
          '<img src="https://pbs.twimg.com/media/shaped-fixture.jpg">' +
        '</div>' +
      '</a></article>',
      {
        prepare(window) {
          window.TabCloserSacredArt = [
            { file: 'wide-painting.jpg', aspect: 2.4 },
            { file: 'tall-painting.jpg', aspect: 0.6 },
            { file: 'square-painting.jpg', aspect: 1.0 },
          ];
          const host = window.document.getElementById('shaped-host');
          host.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height });
        },
        classify: () => ({ verdict: 'protect', reason: 'visual' }),
      },
    );
  }

  const tall = await shapedHarness(270, 480);
  try {
    await flush(tall.window, 16);
    const artwork = tall.window.document.querySelector('.tabcloser-overlay-artwork');
    assert.ok(artwork.style.backgroundImage.includes('tall-painting.jpg'),
      'a vertical cell must receive a tall painting');
  } finally {
    tall.dom.window.close();
  }

  const wide = await shapedHarness(480, 270);
  try {
    await flush(wide.window, 16);
    const artwork = wide.window.document.querySelector('.tabcloser-overlay-artwork');
    assert.ok(artwork.style.backgroundImage.includes('wide-painting.jpg'),
      'a horizontal cell must receive a wide painting');
  } finally {
    wide.dom.window.close();
  }
});

test('the painting renders as one blurred backdrop plus one contained copy, never a duplicate', async () => {
  const harness = await startCoordinator(
    '<article><a href="/example/status/3111111111/photo/1">' +
      '<div id="dup-root" data-testid="tweetPhoto">' +
        '<img src="https://pbs.twimg.com/media/dup-fixture.jpg">' +
      '</div>' +
    '</a></article>',
    { classify: () => ({ verdict: 'protect', reason: 'visual' }) },
  );

  try {
    await flush(harness.window, 16);
    const root = harness.window.document.getElementById('dup-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    const overlay = root.closest('a').querySelector('.tabcloser-media-overlay-art');
    assert.ok(overlay);
    assert.equal(overlay.style.backgroundImage, '',
      'the overlay itself must not carry an unblurred cover copy of the painting');
    const backdrop = overlay.querySelector('.tabcloser-overlay-backdrop');
    const artwork = overlay.querySelector('.tabcloser-overlay-artwork');
    assert.ok(backdrop, 'the blurred backdrop layer must exist');
    assert.ok(artwork, 'the contained artwork layer must exist');
    assert.ok(artwork.style.backgroundImage.includes('test-painting.jpg'));
    assert.equal(backdrop.style.backgroundImage, artwork.style.backgroundImage,
      'both layers must show the same painting');
  } finally {
    harness.dom.window.close();
  }
});

test('a painting is applied only after it decodes, never while partially loaded', async () => {
  const harness = await startCoordinator(
    '<article><a href="/example/status/3122222222/photo/1">' +
      '<div id="decode-root" data-testid="tweetPhoto">' +
        '<img src="https://pbs.twimg.com/media/decode-fixture.jpg">' +
      '</div>' +
    '</a></article>',
    {
      prepare(window) {
        window.__pendingArtImages = [];
        window.__artImageLoader = image => window.__pendingArtImages.push(image);
      },
      classify: () => ({ verdict: 'protect', reason: 'visual' }),
    },
  );

  try {
    await flush(harness.window, 16);
    const root = harness.window.document.getElementById('decode-root');
    assert.equal(root.dataset.tabcloserMediaState, 'protected');
    const overlay = root.closest('a').querySelector('.tabcloser-media-overlay-art');
    const backdrop = overlay.querySelector('.tabcloser-overlay-backdrop');
    const artwork = overlay.querySelector('.tabcloser-overlay-artwork');
    assert.ok(artwork, 'the artwork layer mounts immediately as a dark shield');
    assert.equal(artwork.style.backgroundImage, '',
      'an undecoded painting must not be painted (progressive bands would flash)');
    assert.equal(backdrop.style.backgroundImage, '');
    assert.equal(harness.window.__pendingArtImages.length, 1, 'the painting must be preloaded exactly once');

    for (const image of harness.window.__pendingArtImages) {
      image.dispatchEvent(new harness.window.Event('load'));
    }
    await flush(harness.window, 8);
    assert.ok(artwork.style.backgroundImage.includes('test-painting.jpg'),
      'the painting must appear once decoding completes');
    assert.equal(backdrop.style.backgroundImage, artwork.style.backgroundImage);
  } finally {
    harness.dom.window.close();
  }
});
