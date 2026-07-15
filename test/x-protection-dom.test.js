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

async function startCoordinator(html, { config, classify } = {}) {
  const dom = new JSDOM(html, {
    url: 'https://x.com/search?q=test&src=typed_query&f=media',
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const classificationMessages = [];
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
        get: async () => ({ xProtection: config || {
          labeled: { enabled: true },
          model: { enabled: true, sensitivity: 'balanced' },
        } }),
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

  window.eval(coordinator);
  await flush(window);

  return {
    classificationMessages,
    dom,
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
        <div><span>Content warning: Adult Content</span></div>
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

    const click = new harness.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    assert.equal(tile.dispatchEvent(click), false, 'protected warning tile navigation must be canceled');
    assert.equal(click.defaultPrevented, true);
  } finally {
    harness.dom.window.close();
  }
});

test('a blob-streamed video samples later frames instead of trusting a safe poster', async () => {
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
    classify(message) {
      if (message.kind === 'url') return { verdict: 'safe', reason: 'visual' };
      const time = Number(message.mediaKey.match(/\|t=([\d.]+)$/)?.[1] || 0);
      return time >= 5
        ? { verdict: 'protect', reason: 'visual' }
        : { verdict: 'safe', reason: 'visual' };
    },
  });

  try {
    const video = harness.window.document.getElementById('video');
    let currentTime = 0;
    Object.defineProperties(video, {
      currentSrc: { configurable: true, get: () => video.src },
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set(value) {
          currentTime = Number(value);
          harness.window.queueMicrotask(() => video.dispatchEvent(new harness.window.Event('seeked')));
        },
      },
      duration: { configurable: true, get: () => 20 },
      readyState: { configurable: true, get: () => 4 },
    });

    // The initial asynchronous scan may have run before the media shims above;
    // rediscovery models X updating a video element after mounting it.
    video.setAttribute('poster', video.poster.replace('poster.jpg', 'poster-rediscovered.jpg'));
    await flush(harness.window, 16);

    const videoRoot = harness.window.document.getElementById('video-root');
    assert.equal(videoRoot.dataset.tabcloserMediaState, 'protected');
    assert.equal(videoRoot.dataset.tabcloserMediaReason, 'visual');
    assert.ok(
      harness.classificationMessages.some(message => message.kind === 'frame' && /\|t=(?:5|10|15|19)/.test(message.mediaKey)),
      'classification should inspect a frame after the poster/first frame',
    );
  } finally {
    harness.dom.window.close();
  }
});
