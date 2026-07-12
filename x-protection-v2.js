// Fail-closed X media coordinator. Modes: 'off'; 'labeled' hides only media
// X itself marks mature; 'full' additionally runs the bundled local
// classifier and keeps unmatched media hidden until it reports safe.
let mode = 'off';
let operationId = 0;
const sensitiveUrls = new Set();
const sensitiveTweetIds = new Set();
const rootRecords = new WeakMap();
const warningPattern = /(?:sensitive content|content warning|may contain sensitive|potentially sensitive)/i;
const mediaSelector = '[data-testid="tweetPhoto"], [data-testid="videoComponent"], [data-testid="videoPlayer"]';
const mediaElementSelector = 'img[src], video[poster], video[src], source[src]';
const statusPathPattern = /\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?/;

function waitForEvent(target, successEvent, errorEvent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(false, new Error(successEvent + ' timeout')), timeoutMs);
    function finish(ok, value) {
      clearTimeout(timeout);
      target.removeEventListener(successEvent, onSuccess);
      if (errorEvent) target.removeEventListener(errorEvent, onError);
      ok ? resolve(value) : reject(value);
    }
    function onSuccess(event) { finish(true, event); }
    function onError() { finish(false, new Error(errorEvent || 'media error')); }
    target.addEventListener(successEvent, onSuccess, { once: true });
    if (errorEvent) target.addEventListener(errorEvent, onError, { once: true });
  });
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout')), timeoutMs)),
  ]);
}

function statusIdFromHref(href) {
  return href.match(statusPathPattern)?.[1] || null;
}

function statusIdFor(node) {
  const directLink = node.closest?.('a[href*="/status/"]');
  const directId = directLink ? statusIdFromHref(directLink.getAttribute('href') || '') : null;
  if (directId) return directId;
  const article = node.closest?.('article');
  const articleLink = article?.querySelector('a[href*="/status/"]');
  return articleLink ? statusIdFromHref(articleLink.getAttribute('href') || '') : null;
}

function mediaRootFor(node) {
  if (!(node instanceof Element)) return null;
  const selected = node.closest(mediaSelector);
  if (selected) return selected;
  const link = node.closest('a[href*="/status/"]');
  const href = link?.getAttribute('href') || '';
  if (/\/status\/\d+\/(?:photo|video)\/\d+/.test(href) && link.querySelector('img, video')) return link;
  // No generic parent fallback: it turned every emoji/avatar <img> in tweet
  // text into a "media root", flooding the classifier and injecting overlays
  // into text spans (which wedges X's virtualized scroller).
  return null;
}

function decorativeImage(image) {
  const value = image.currentSrc || image.src || '';
  try {
    const url = new URL(value);
    return url.hostname === 'abs.twimg.com' ||
      url.pathname.startsWith('/emoji/') ||
      url.pathname.startsWith('/profile_images/') ||
      url.pathname.startsWith('/semantic_core_img/') ||
      url.pathname.startsWith('/hashflags/');
  } catch {
    return false;
  }
}

function sourceValues(root) {
  const elements = [
    ...(root.matches?.(mediaElementSelector) ? [root] : []),
    ...root.querySelectorAll(mediaElementSelector),
  ];
  const values = [];
  for (const element of elements) {
    for (const value of TabCloserXMediaUtils.preferredMediaSources(element)) {
      if (value && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

function rootFingerprint(root) {
  return [statusIdFor(root) || 'none', ...sourceValues(root).map(value => TabCloserXMetadata.normalizeMediaUrl(value) || value)].join('|');
}

function mediaUrlIsSensitive(root) {
  return sourceValues(root).some(value => sensitiveUrls.has(TabCloserXMetadata.normalizeMediaUrl(value)));
}

// X's possibly_sensitive label hard-blocks: videos with innocent poster frames
// and borderline images can only be caught reliably through it, and that
// recall is worth the occasional author who over-labels harmless posts.
function metadataProtects(root) {
  const tweetId = statusIdFor(root);
  return warningPattern.test(root.innerText || '') ||
    mediaUrlIsSensitive(root) ||
    (!!tweetId && sensitiveTweetIds.has(tweetId));
}

function overlayHostFor(root) {
  // X's clickable photo/video cell is usually an ancestor link that is taller
  // than the media root; the overlay must cover (and the blocker must guard)
  // that whole cell, not just the root.
  return root.closest?.('a[href*="/status/"]') || root;
}

function overlayFor(root) {
  return [...overlayHostFor(root).children].find(child => child.classList?.contains('tabcloser-media-overlay')) || null;
}

function setRootState(root, state, reason) {
  if (!root?.isConnected) return;
  root.dataset.tabcloserMediaState = state;
  root.dataset.tabcloserMediaReason = reason || '';
  const host = overlayHostFor(root);
  const existing = overlayFor(root);
  if (state === 'safe') {
    existing?.remove();
    host.classList.remove('tabcloser-overlay-host');
    return;
  }
  host.classList.add('tabcloser-overlay-host');
  const overlay = existing || document.createElement('div');
  // Pending media shows through heavily blurred, so its overlay is just a
  // transparent click shield; protected media gets the opaque notice.
  overlay.className = 'tabcloser-media-overlay' + (state === 'pending' ? ' tabcloser-media-overlay-pending' : '');
  overlay.setAttribute('role', 'img');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-label', state === 'pending' ? 'Media is being checked by TabCloser' : 'Sensitive media hidden by TabCloser');
  overlay.textContent = state === 'pending' ? '' : 'Sensitive media hidden';
  overlay.title = reason || '';
  if (!existing) host.appendChild(overlay);
  root.querySelectorAll('video, audio').forEach(player => {
    player.pause();
    player.muted = true;
  });
}

function clearAllStates() {
  document.querySelectorAll('.tabcloser-media-overlay').forEach(overlay => overlay.remove());
  document.querySelectorAll('.tabcloser-overlay-host').forEach(host => host.classList.remove('tabcloser-overlay-host'));
  document.querySelectorAll('[data-tabcloser-media-state]').forEach(root => {
    delete root.dataset.tabcloserMediaState;
    delete root.dataset.tabcloserMediaReason;
  });
}

function protectGroup(root, reason) {
  const article = root.closest('article');
  const roots = article ? candidateRootsWithin(article) : [root];
  for (const candidate of roots) setRootState(candidate, 'protected', reason);
}

function candidateRootsWithin(container) {
  if (!(container instanceof Element || container instanceof Document)) return [];
  const roots = new Set();
  if (container instanceof Element) {
    const direct = mediaRootFor(container);
    if (direct) roots.add(direct);
    if (container.matches(mediaSelector)) roots.add(container);
  }
  container.querySelectorAll?.(mediaSelector + ', a[href*="/status/"][href*="/photo/"] img, a[href*="/status/"][href*="/video/"] img, a[href*="/status/"][href*="/video/"] video').forEach(node => {
    const root = mediaRootFor(node);
    if (root) roots.add(root);
  });
  return [...roots];
}

function approvedXMediaUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' &&
      (host === 'pbs.twimg.com' || host === 'video.twimg.com' || host === 'abs.twimg.com' || host.endsWith('.twimg.com'));
  } catch {
    return false;
  }
}

function pixelsFromDrawable(drawable) {
  const size = TabCloserXVerdict.MODEL_INPUT_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(drawable, 0, 0, size, size);
  return context.getImageData(0, 0, size, size);
}

async function classifyUrl(value, mediaKey) {
  if (approvedXMediaUrl(value)) {
    return browser.runtime.sendMessage({ type: 'classifyXMedia', kind: 'url', mediaKey, url: value });
  }
  throw new Error('external URL requires pixel classification');
}

async function classifyImage(image, keyPrefix) {
  const value = image.currentSrc || image.src;
  const normalized = TabCloserXMetadata.normalizeMediaUrl(value);
  if (value && approvedXMediaUrl(value)) return classifyUrl(value, keyPrefix + '|image|' + normalized);
  if (!image.complete) await waitForEvent(image, 'load', 'error', 10000);
  const imageData = pixelsFromDrawable(image);
  return browser.runtime.sendMessage({
    type: 'classifyXMedia',
    kind: 'frame',
    mediaKey: keyPrefix + '|image-pixels|' + (normalized || 'external'),
    pixels: imageData.data,
    width: imageData.width,
    height: imageData.height,
  });
}

async function seekVideo(video, time) {
  if (Math.abs(video.currentTime - time) < 0.02 && video.readyState >= 2) return;
  video.currentTime = time;
  await waitForEvent(video, 'seeked', 'error', 5000);
}

async function classifyVideo(video, keyPrefix) {
  let posterVerifiedSafe = false;
  if (video.poster) {
    const poster = await classifyUrl(video.poster, keyPrefix + '|poster|' + (TabCloserXMetadata.normalizeMediaUrl(video.poster) || video.poster));
    if (poster.verdict !== 'safe') return poster;
    posterVerifiedSafe = true;
  }

  const source = video.currentSrc || video.src || video.querySelector('source[src]')?.src;
  if (!source || !approvedXMediaUrl(source)) {
    // X streams timeline videos via MSE blob: URLs we cannot sample. The
    // poster is generated from the video itself, so a safe poster releases it;
    // X-labelled sensitive videos are still caught by the metadata path.
    return posterVerifiedSafe ? { verdict: 'safe', reason: 'poster' } : { verdict: 'protect', reason: 'invalid' };
  }
  const probe = document.createElement('video');
  probe.className = 'tabcloser-video-probe';
  probe.crossOrigin = 'anonymous';
  probe.muted = true;
  probe.preload = 'auto';
  probe.src = source;
  document.documentElement.appendChild(probe);
  try {
    if (probe.readyState < 1) await waitForEvent(probe, 'loadedmetadata', 'error', 8000);
    const times = TabCloserXMediaUtils.videoSampleTimes(probe.duration);
    if (!times.length) return { verdict: 'protect', reason: 'invalid' };
    for (const time of times) {
      await seekVideo(probe, time);
      if (probe.readyState < 2) await waitForEvent(probe, 'loadeddata', 'error', 5000);
      const imageData = pixelsFromDrawable(probe);
      const result = await browser.runtime.sendMessage({
        type: 'classifyXMedia',
        kind: 'frame',
        mediaKey: keyPrefix + '|video|' + (TabCloserXMetadata.normalizeMediaUrl(source) || source) + '|t=' + time,
        pixels: imageData.data,
        width: imageData.width,
        height: imageData.height,
      });
      if (result.verdict !== 'safe') return result;
    }
    return { verdict: 'safe', reason: 'visual' };
  } finally {
    probe.removeAttribute('src');
    probe.load();
    probe.remove();
  }
}

// A failed classification (image mid-load, cold classifier, fetch hiccup) must
// not censor forever: retry with backoff. Deterministic verdicts never retry.
const retryDelaysMs = [2000, 8000];
const retryableReason = /^(?:error|timeout)$/;

function scheduleRetry(root) {
  const record = rootRecords.get(root);
  if (!record) return;
  const attempt = record.retries || 0;
  if (attempt >= retryDelaysMs.length) return;
  record.retries = attempt + 1;
  setTimeout(() => {
    if (mode !== 'full' || !root.isConnected || rootRecords.get(root) !== record) return;
    rootRecords.set(root, { ...record, status: 'stale' });
    discoverRoot(root);
  }, retryDelaysMs[attempt]);
}

// Classifier verdicts are per-image, so they only hide their own cell: every
// sibling is independently classified and stands on its own judgment, and a
// false positive must not censor innocent neighbors. Failure verdicts
// (couldn't check) are also root-scoped so a retry can release them. Only X's
// own tweet-level label ('metadata') hides every media cell in the article.
function protectUnsafeResult(root, reason) {
  if (reason === 'metadata') {
    protectGroup(root, reason);
    return;
  }
  setRootState(root, 'protected', reason);
  if (retryableReason.test(reason)) scheduleRetry(root);
}

async function classifyRoot(root, fingerprint, token) {
  try {
    if (metadataProtects(root)) {
      protectGroup(root, 'metadata');
      return;
    }
    const images = [...root.querySelectorAll('img[src]')].filter(image => !decorativeImage(image));
    const videos = [...root.querySelectorAll('video')];
    if (root.matches('img[src]') && !decorativeImage(root)) images.unshift(root);
    if (root.matches('video')) videos.unshift(root);
    if (!images.length && !videos.length) throw new Error('no classifiable media');

    for (const image of images) {
      const result = await classifyImage(image, fingerprint);
      if (result.verdict !== 'safe') {
        protectUnsafeResult(root, result.reason || 'visual');
        return;
      }
    }
    for (const video of videos) {
      const result = await withTimeout(classifyVideo(video, fingerprint), 20000, 'video preflight');
      if (result.verdict !== 'safe') {
        protectUnsafeResult(root, result.reason || 'visual');
        return;
      }
    }

    const current = rootRecords.get(root);
    if (mode !== 'full' || !root.isConnected || current?.token !== token) return;
    if (rootFingerprint(root) !== fingerprint) {
      discoverRoot(root);
      return;
    }
    if (metadataProtects(root) || root.dataset.tabcloserMediaState === 'protected') {
      protectGroup(root, root.dataset.tabcloserMediaReason || 'metadata');
      return;
    }
    setRootState(root, 'safe', 'visual');
  } catch (error) {
    if (mode === 'full' && root.isConnected && rootRecords.get(root)?.token === token) {
      protectUnsafeResult(root, /timeout/i.test(error?.message || '') ? 'timeout' : 'error');
    }
  }
}

const intersectionObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting || mode !== 'full') continue;
    intersectionObserver.unobserve(entry.target);
    const record = rootRecords.get(entry.target);
    if (record?.status === 'pending') classifyRoot(entry.target, record.fingerprint, record.token);
  }
}, { rootMargin: '300px 0px' });

function discoverRoot(root) {
  if (mode === 'off' || !root?.isConnected) return;
  if (mode === 'labeled') {
    // Labeled tier: only X's own mature label hides media; nothing is queued
    // for classification and unflagged media stays untouched.
    if (metadataProtects(root)) protectGroup(root, 'metadata');
    return;
  }
  const fingerprint = rootFingerprint(root);
  if (!fingerprint || fingerprint === 'none') return;
  const previous = rootRecords.get(root);
  const domState = root.dataset.tabcloserMediaState;
  if (previous?.fingerprint === fingerprint && previous.status !== 'stale' && domState) {
    if (metadataProtects(root) && root.dataset.tabcloserMediaState !== 'protected') protectGroup(root, 'metadata');
    return;
  }
  const token = ++operationId;
  // Retry budget carries across re-discoveries of the same media; new media
  // (fingerprint change) starts fresh.
  const retries = previous?.fingerprint === fingerprint ? previous.retries || 0 : 0;
  rootRecords.set(root, { fingerprint, status: 'pending', token, retries });
  setRootState(root, 'pending', 'pending');
  if (metadataProtects(root)) protectGroup(root, 'metadata');
  else intersectionObserver.observe(root);
}

function discoverWithin(container) {
  for (const root of candidateRootsWithin(container)) discoverRoot(root);
}

function scanKnownRootsForMetadata() {
  document.querySelectorAll('[data-tabcloser-media-state], ' + mediaSelector).forEach(node => {
    const root = mediaRootFor(node) || node;
    if (mode !== 'off' && metadataProtects(root)) protectGroup(root, 'metadata');
  });
}

function setProtection(config) {
  const modelEnabled = config?.model?.enabled === true;
  const labeledEnabled = modelEnabled || config?.labeled?.enabled === true || config?.enabled === true;
  mode = modelEnabled ? 'full' : labeledEnabled ? 'labeled' : 'off';
  document.documentElement.dataset.tabcloserXProtection = mode;
  operationId += 1;
  intersectionObserver.disconnect();
  clearAllStates();
  if (mode !== 'off') discoverWithin(document);
}

function addSensitiveMetadata(metadata) {
  for (const url of metadata?.urls || []) {
    const normalized = TabCloserXMetadata.normalizeMediaUrl(url);
    if (normalized) sensitiveUrls.add(normalized);
  }
  for (const tweetId of metadata?.tweetIds || []) sensitiveTweetIds.add(String(tweetId));
  if (mode !== 'off') scanKnownRootsForMetadata();
}

function blockPendingOrProtectedActivation(event) {
  if (mode === 'off' || !(event.target instanceof Element)) return;
  // .tabcloser-overlay-host guards the full clickable cell, which extends
  // beyond the media root that carries the state attribute.
  const root = event.target.closest('[data-tabcloser-media-state="pending"], [data-tabcloser-media-state="protected"], .tabcloser-overlay-host');
  if (!root) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
}

window.addEventListener('click', blockPendingOrProtectedActivation, true);
window.addEventListener('auxclick', blockPendingOrProtectedActivation, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') blockPendingOrProtectedActivation(event);
}, true);
document.addEventListener('play', event => {
  if (mode === 'off' || !(event.target instanceof HTMLMediaElement)) return;
  const root = mediaRootFor(event.target);
  const rootState = root?.dataset.tabcloserMediaState;
  // Full mode is fail-closed (only verified-safe may play); labeled mode only
  // stops media that X's label explicitly protected.
  const blocked = mode === 'full' ? rootState !== 'safe' : rootState === 'pending' || rootState === 'protected';
  if (blocked) {
    event.target.pause();
    event.target.muted = true;
  }
}, true);

browser.runtime.onMessage.addListener(message => {
  if (message?.type === 'xProtectionChanged') setProtection(message.xProtection);
  if (message?.type === 'xSensitiveMediaMetadata') addSensitiveMetadata(message.metadata);
});

new MutationObserver(mutations => {
  if (mode === 'off') return;
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') discoverRoot(mediaRootFor(mutation.target));
    else for (const node of mutation.addedNodes) if (node instanceof Element) discoverWithin(node);
  }
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset', 'poster', 'href'],
});

browser.storage.local.get('xProtection')
  .then(data => setProtection(data.xProtection))
  .catch(() => setProtection(null));
