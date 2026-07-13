// Fail-closed X media coordinator. Modes: 'off'; 'labeled' hides only media
// X itself marks mature; 'full' additionally runs the bundled local
// classifier and keeps unmatched media hidden until it reports safe.
let mode = 'off';
let settings = { replaceText: false, blockLike: false };
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

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

// Deterministic per-media pick so re-renders never shuffle the artwork.
function sacredArtUrlFor(root) {
  const artList = globalThis.TabCloserSacredArt || [];
  if (!artList.length) return null;
  const pick = artList[hashString(rootFingerprint(root)) % artList.length];
  return browser.runtime.getURL('assets/sacred-art/' + pick);
}

// Clicking censored media opens our own viewer with the painting, never X's
// photo modal (which would show the real media).
let lightbox = null;

function closeLightbox() {
  lightbox?.remove();
  lightbox = null;
}

function openLightbox(url) {
  closeLightbox();
  lightbox = document.createElement('div');
  lightbox.className = 'tabcloser-lightbox';
  const image = document.createElement('img');
  image.src = url;
  image.alt = 'Sacred art shown in place of hidden media';
  lightbox.appendChild(image);
  lightbox.addEventListener('click', closeLightbox);
  document.documentElement.appendChild(lightbox);
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && lightbox) {
    event.stopImmediatePropagation();
    closeLightbox();
  }
}, true);

function quoteForKey(key) {
  const quotes = globalThis.TabCloserQuotes || [];
  if (!quotes.length) return null;
  return quotes[hashString(key) % quotes.length];
}

// A quoted tweet is a nested card inside the same <article>; text replacement
// must stay within the censored media's own layer (main tweet vs quoted card).
function tweetLayerFor(node, article) {
  let current = node;
  while (current && current !== article) {
    if (current instanceof Element && current.matches('div[role="link"]')) return current;
    current = current.parentElement;
  }
  return article;
}

function applyQuoteFor(root) {
  if (!settings.replaceText || !(root instanceof Element)) return;
  const article = root.closest('article');
  if (!article) return;
  const layer = tweetLayerFor(root, article);
  const text = [...article.querySelectorAll('[data-testid="tweetText"]')]
    .find(candidate => tweetLayerFor(candidate, article) === layer);
  if (!text || text.dataset.tabcloserQuoted === 'yes') return;
  const quote = quoteForKey(statusIdFor(root) || text.textContent.slice(0, 40));
  if (!quote) return;
  text.dataset.tabcloserQuoted = 'yes';
  text.classList.add('tabcloser-hidden-text');
  const block = document.createElement('div');
  block.className = 'tabcloser-quote';
  block.textContent = '“' + quote.text + '”';
  const author = document.createElement('div');
  author.className = 'tabcloser-quote-author';
  author.textContent = '— ' + quote.author;
  block.appendChild(author);
  text.insertAdjacentElement('afterend', block);
}

function restoreArticleText(article) {
  if (!(article instanceof Element)) return;
  const text = article.querySelector('[data-testid="tweetText"]');
  if (text) {
    delete text.dataset.tabcloserQuoted;
    text.classList.remove('tabcloser-hidden-text');
  }
  article.querySelectorAll('.tabcloser-quote').forEach(quote => quote.remove());
}

function restoreAllArticleText() {
  document.querySelectorAll('.tabcloser-quote').forEach(quote => quote.remove());
  document.querySelectorAll('[data-tabcloser-quoted]').forEach(text => {
    delete text.dataset.tabcloserQuoted;
    text.classList.remove('tabcloser-hidden-text');
  });
}

function setRootState(root, state, reason) {
  if (!root?.isConnected) return;
  root.dataset.tabcloserMediaState = state;
  root.dataset.tabcloserMediaReason = reason || '';
  const host = overlayHostFor(root);
  const existing = overlayFor(root);
  const article = root.closest('article');
  if (state === 'safe') {
    existing?.remove();
    host.classList.remove('tabcloser-overlay-host');
    if (article && !article.querySelector('[data-tabcloser-media-state="protected"]')) restoreArticleText(article);
    return;
  }
  host.classList.add('tabcloser-overlay-host');
  const overlay = existing || document.createElement('div');
  // Pending media shows through heavily blurred behind a transparent click
  // shield. The painting and notice are reserved for confirmed mature
  // verdicts; a failure verdict that will still be retried renders like the
  // pending state so a successful retry never pops artwork in and out.
  const mature = reason === 'visual' || reason === 'metadata';
  const willRetry = state === 'protected' && !mature && retryableReason.test(reason || '') &&
    (rootRecords.get(root)?.retries || 0) < retryDelaysMs.length;
  const shieldOnly = state === 'pending' || willRetry;
  const artUrl = state === 'protected' && mature ? sacredArtUrlFor(root) : null;
  overlay.className = 'tabcloser-media-overlay' +
    (shieldOnly ? ' tabcloser-media-overlay-pending' : '') +
    (artUrl ? ' tabcloser-media-overlay-art' : '');
  overlay.style.backgroundImage = artUrl ? 'url("' + artUrl + '")' : '';
  overlay.setAttribute('role', 'img');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-label', shieldOnly ? 'Media is being checked by TabCloser' : 'Sensitive media hidden by TabCloser');
  overlay.textContent = '';
  if (!shieldOnly) {
    const label = document.createElement('span');
    label.className = 'tabcloser-overlay-label';
    label.textContent = 'Sensitive media hidden';
    overlay.appendChild(label);
  }
  overlay.title = reason || '';
  if (!existing) host.appendChild(overlay);
  if (state === 'protected' && mature) applyQuoteFor(root);
  root.querySelectorAll('video, audio').forEach(player => {
    player.pause();
    player.muted = true;
  });
}

function clearAllStates() {
  closeLightbox();
  restoreAllArticleText();
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
    // React may rebuild the text node without touching the media; re-apply
    // the quote (idempotent) for confirmed-mature roots.
    const reason = root.dataset.tabcloserMediaReason;
    if (domState === 'protected' && (reason === 'visual' || reason === 'metadata')) applyQuoteFor(root);
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
  settings = { replaceText: config?.replaceText === true, blockLike: config?.blockLike === true };
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
  // Liking a censored post would endorse content the user never saw.
  if (settings.blockLike) {
    const likeButton = event.target.closest('[data-testid="like"]');
    if (likeButton && likeButton.closest('article')?.querySelector('[data-tabcloser-media-state="protected"]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      return;
    }
  }
  // .tabcloser-overlay-host guards the full clickable cell, which extends
  // beyond the media root that carries the state attribute.
  const root = event.target.closest('[data-tabcloser-media-state="pending"], [data-tabcloser-media-state="protected"], .tabcloser-overlay-host');
  if (!root) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
  // A plain click on confirmed-censored media opens the painting large, as if
  // the artwork were the post's own image.
  if (event.type !== 'click' || event.button !== 0) return;
  const stateRoot = root.matches('[data-tabcloser-media-state]')
    ? root
    : root.querySelector('[data-tabcloser-media-state="protected"]');
  const reason = stateRoot?.dataset.tabcloserMediaReason;
  if (stateRoot?.dataset.tabcloserMediaState === 'protected' && (reason === 'visual' || reason === 'metadata')) {
    const url = sacredArtUrlFor(stateRoot);
    if (url) openLightbox(url);
  }
}

window.addEventListener('click', blockPendingOrProtectedActivation, true);
window.addEventListener('auxclick', blockPendingOrProtectedActivation, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') blockPendingOrProtectedActivation(event);
  // X's "L" hotkey likes the focused tweet; block it for censored posts, but
  // never while the user is typing.
  if (settings.blockLike && (event.key === 'l' || event.key === 'L') &&
      !event.ctrlKey && !event.metaKey && !event.altKey) {
    const active = document.activeElement;
    if (active instanceof Element &&
        !active.matches('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]') &&
        active.closest('article')?.querySelector('[data-tabcloser-media-state="protected"]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    }
  }
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
