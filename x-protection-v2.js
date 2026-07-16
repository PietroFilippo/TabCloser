// X media coordinator. Modes: 'off'; 'labeled' hides only media X itself
// marks mature; 'full' additionally classifies images, video posters, and up
// to three frames from a detached low-bandwidth video probe. The visible X
// player is never used, decoded, or seeked by TabCloser.
const xProtectionCoordinatorVersion = 'video-probe-v1';
let mode = 'off';
let settings = { replaceText: false, blockLike: false, sensitivity: 'balanced' };
let operationId = 0;
const sensitiveUrls = new Set();
const sensitiveTweetIds = new Set();
// Session-level visual verdicts: tweet IDs whose direct-video probe returned
// a confirmed mature verdict. Remounted media (Media tab grid, re-rendered
// detail view) is protected from this set without re-probing the video.
// Safe verdicts are never stored here; only 'protect' promotes.
const visuallyProtectedTweetIds = new Set();
const directVideoSourcesByTweetId = new Map();
const directVideoSourceWaitersByTweetId = new Map();
const directVideoVerdictCache = new Map();
const directVideoProbeInFlight = new Map();
const activeDetachedVideoProbes = new Set();
const sacredArtByRoot = new WeakMap();
const blockedPlaybackStateByMedia = new WeakMap();
const rootRecords = new WeakMap();
const verifiedSafeMediaKeys = new Set();
const warningPattern = /(?:sensitive content|content warning|warning\s*:\s*(?:nudity|adult content)|may contain sensitive|potentially sensitive)/i;
const maxDirectVideoEntries = 500;
const mediaSelector = '[data-testid="tweetPhoto"], [data-testid="videoComponent"], [data-testid="videoPlayer"]';
const mediaElementSelector = 'img[src], video, source[src]';
const statusPathPattern = /\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?/;
const statusLinkSelector = 'a[href*="/status/"]';
const extensionUiSelector = '.tabcloser-media-overlay, .tabcloser-lightbox';

const xMetadataDebugPrefix = '[TabCloser DEBUG metadata-v1]';

function xMetadataDebug(event, details = {}) {
  console.debug(xMetadataDebugPrefix, JSON.stringify({ event, ...details }));
}

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

function statusIdFromHref(href) {
  return href.match(statusPathPattern)?.[1] || null;
}

function statusIdFor(node) {
  const directLink = node.closest?.(statusLinkSelector);
  const directId = directLink ? statusIdFromHref(directLink.getAttribute('href') || '') : null;
  if (directId) return directId;
  const article = node.closest?.('article');
  const articleLink = article?.querySelector(statusLinkSelector);
  if (articleLink) return statusIdFromHref(articleLink.getAttribute('href') || '');
  return statusIdFromHref(location.pathname);
}

// X's media-search grid can replace the entire preview with a native mature
// content warning. Those tiles contain no img/video/data-testid media root, so
// they need a deliberately narrow root: a real status link whose own rendered
// text contains one of X's warning phrases. This avoids restoring the old
// catch-all status/card discovery that classified avatars and emoji.
function nativeWarningRootFor(node) {
  if (!(node instanceof Element)) return null;
  if (node.closest('.tabcloser-media-overlay, .tabcloser-lightbox')) return null;
  const link = node.matches(statusLinkSelector) ? node : node.closest(statusLinkSelector);
  if (!link || !statusIdFromHref(link.getAttribute('href') || '')) return null;
  return warningPattern.test(link.textContent || '') ? link : null;
}

function isMediaSearchPage() {
  try {
    const page = new URL(location.href);
    return page.pathname === '/search' && page.searchParams.get('f') === 'media';
  } catch {
    return false;
  }
}

function searchMediaRootFor(node) {
  if (!(node instanceof Element) || !isMediaSearchPage()) return null;
  if (node.closest('.tabcloser-media-overlay, .tabcloser-lightbox')) return null;
  const link = node.matches(statusLinkSelector) ? node : node.closest(statusLinkSelector);
  if (!link || !statusIdFromHref(link.getAttribute('href') || '')) return null;
  if (link.querySelector(mediaSelector)) return null;
  const hasVideo = !!link.querySelector('video, [data-testid="videoComponent"], [data-testid="videoPlayer"]');
  const hasMediaImage = [...link.querySelectorAll('img[src]')].some(image => !decorativeImage(image));
  return hasVideo || hasMediaImage ? link : null;
}

function mediaRootFor(node) {
  if (!(node instanceof Element)) return null;
  if (extensionOwnedElement(node)) return null;
  const warningRoot = nativeWarningRootFor(node);
  if (warningRoot) return warningRoot;
  const selected = node.closest(mediaSelector);
  if (selected) return selected;
  const searchMediaRoot = searchMediaRootFor(node);
  if (searchMediaRoot) return searchMediaRoot;
  const link = node.closest(statusLinkSelector);
  const href = link?.getAttribute('href') || '';
  if (/\/status\/\d+\/(?:photo|video)\/\d+/.test(href) && link.querySelector('img, video')) return link;
  // No generic parent fallback: it turned every emoji/avatar <img> in tweet
  // text into a "media root", flooding the classifier and injecting overlays
  // into text spans (which wedges X's virtualized scroller).
  return null;
}

function decorativeImage(image) {
  if (extensionOwnedElement(image)) return true;
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

function extensionOwnedElement(element) {
  return !!element?.closest?.(extensionUiSelector);
}

function mediaElementsWithin(root, selector) {
  return [
    ...(root.matches?.(selector) ? [root] : []),
    ...root.querySelectorAll(selector),
  ].filter(element => !extensionOwnedElement(element));
}

function sourceValues(root) {
  const values = [];
  for (const element of mediaElementsWithin(root, mediaElementSelector)) {
    for (const value of TabCloserXMediaUtils.preferredMediaSources(element)) {
      if (value && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

function rootFingerprint(root) {
  const shape = 'images=' + mediaElementsWithin(root, 'img[src]').length +
    ',videos=' + mediaElementsWithin(root, 'video').length;
  return [statusIdFor(root) || 'none', shape,
    ...sourceValues(root).map(value => TabCloserXMetadata.normalizeMediaUrl(value) || value)].join('|');
}

function stableMediaVerificationKey(root) {
  const tweetId = statusIdFor(root);
  if (!tweetId) return null;
  const poster = mediaElementsWithin(root, 'video')
    .map(video => video.poster)
    .find(Boolean);
  const stableSource = poster || sourceValues(root).find(value => value && !value.startsWith('blob:'));
  if (!stableSource) return null;
  const normalized = TabCloserXMetadata.normalizeMediaUrl(stableSource) || stableSource;
  return tweetId + '|' + normalized;
}

function rememberVerifiedSafeMedia(root) {
  const key = stableMediaVerificationKey(root);
  if (!key) return;
  verifiedSafeMediaKeys.delete(key);
  verifiedSafeMediaKeys.add(key);
  while (verifiedSafeMediaKeys.size > 500) {
    verifiedSafeMediaKeys.delete(verifiedSafeMediaKeys.values().next().value);
  }
}

function hasVerifiedSafeMedia(root) {
  const key = stableMediaVerificationKey(root);
  if (!key || !verifiedSafeMediaKeys.has(key)) return false;
  verifiedSafeMediaKeys.delete(key);
  verifiedSafeMediaKeys.add(key);
  return true;
}

function mediaUrlIsSensitive(root) {
  return sourceValues(root).some(value => sensitiveUrls.has(TabCloserXMetadata.normalizeMediaUrl(value)));
}

// X's possibly_sensitive label hard-blocks: videos with innocent poster frames
// and borderline images can only be caught reliably through it, and that
// recall is worth the occasional author who over-labels harmless posts.
function metadataProtects(root) {
  const tweetId = statusIdFor(root);
  return warningPattern.test(root.textContent || '') ||
    mediaUrlIsSensitive(root) ||
    (!!tweetId && sensitiveTweetIds.has(tweetId));
}

function rememberVisuallyProtectedTweet(tweetId) {
  const id = tweetId == null ? null : String(tweetId);
  if (!id) return;
  visuallyProtectedTweetIds.delete(id);
  visuallyProtectedTweetIds.add(id);
  while (visuallyProtectedTweetIds.size > 500) {
    visuallyProtectedTweetIds.delete(visuallyProtectedTweetIds.values().next().value);
  }
}

function visualVerdictProtects(root) {
  const tweetId = statusIdFor(root);
  return !!tweetId && visuallyProtectedTweetIds.has(tweetId);
}

function overlayHostFor(root) {
  // X's clickable photo/video cell is usually an ancestor link that is taller
  // than the media root; the overlay must cover (and the blocker must guard)
  // that whole cell, not just the root.
  return root.closest?.(statusLinkSelector) || root;
}

function overlayFor(root) {
  return [...overlayHostFor(root).children].find(child => child.classList?.contains('tabcloser-media-overlay')) || null;
}

function activateOverlayHost(host) {
  host.classList.add('tabcloser-overlay-host');
  host.classList.remove('tabcloser-overlay-host-static');
  const position = getComputedStyle(host).position;
  if (!position || position === 'static') host.classList.add('tabcloser-overlay-host-static');
}

function clearOverlayHost(host) {
  host.classList.remove('tabcloser-overlay-host', 'tabcloser-overlay-host-static');
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

function sacredArtKeyFor(root) {
  const link = root.closest?.(statusLinkSelector);
  const statusPath = (link?.getAttribute('href') || '').match(statusPathPattern)?.[0];
  if (statusPath) return statusPath;
  const tweetId = statusIdFor(root);
  if (tweetId) return '/status/' + tweetId;
  const stableSource = sourceValues(root)
    .map(value => TabCloserXMetadata.normalizeMediaUrl(value) || value)
    .find(value => value && !value.startsWith('blob:'));
  return stableSource || rootFingerprint(root);
}

// Applying an undecoded painting paints progressively (visible white bands
// while scrolling). Each painting is fetched and decoded off-thread once;
// the dark overlay backdrop covers the wait, then the image appears whole.
const decodedArtUrls = new Set();
const artDecodesInFlight = new Map();

function decodeArtUrl(url) {
  if (decodedArtUrls.has(url)) return null;
  let pending = artDecodesInFlight.get(url);
  if (!pending) {
    pending = new Promise(resolve => {
      const image = new Image();
      const finish = () => {
        artDecodesInFlight.delete(url);
        // Errors also settle as "decoded": applying anyway beats retry loops.
        decodedArtUrls.add(url);
        resolve();
      };
      image.addEventListener('load', () => {
        const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
        Promise.resolve(decoded).catch(() => {}).then(finish);
      }, { once: true });
      image.addEventListener('error', finish, { once: true });
      image.src = url;
    });
    artDecodesInFlight.set(url, pending);
  }
  return pending;
}

function paintArtworkWhenReady(url, layers) {
  // Painting a detached layer is harmless (the node is simply discarded), so
  // no connectivity guard: the layers may be appended to the host after this
  // runs synchronously for an already-decoded painting.
  const apply = () => {
    for (const layer of layers) layer.style.backgroundImage = 'url("' + url + '")';
  };
  const pending = decodeArtUrl(url);
  if (!pending) apply();
  else pending.then(apply);
}

// Art entries are generated with their aspect ratio; plain strings (older
// lists, test fixtures) have an unknown aspect and match any cell shape.
function artEntryFile(entry) {
  return typeof entry === 'string' ? entry : entry?.file;
}

function artEntryAspect(entry) {
  const aspect = typeof entry === 'string' ? null : entry?.aspect;
  return Number.isFinite(aspect) && aspect > 0 ? aspect : null;
}

function aspectBucket(aspect) {
  if (aspect < 0.8) return 'tall';
  if (aspect > 1.25) return 'wide';
  return 'square';
}

// X's media cells come in a handful of shapes (16:9 timeline video, 9:16
// vertical video, square grid tiles). Matching the painting's orientation to
// the cell keeps the artwork large instead of a thin strip inside backdrop.
function cellAspectBucketFor(root) {
  const rect = overlayHostFor(root).getBoundingClientRect?.();
  if (!rect || !rect.width || !rect.height) return null;
  return aspectBucket(rect.width / rect.height);
}

// Deterministic per-media pick so re-renders never shuffle the artwork.
function sacredArtUrlFor(root) {
  const artList = globalThis.TabCloserSacredArt || [];
  if (!artList.length) return null;
  const existing = sacredArtByRoot.get(root);
  if (existing) return existing;
  const bucket = cellAspectBucketFor(root);
  const fitting = bucket
    ? artList.filter(entry => {
        const aspect = artEntryAspect(entry);
        return aspect != null && aspectBucket(aspect) === bucket;
      })
    : [];
  const candidates = fitting.length ? fitting : artList;
  const pick = candidates[hashString(sacredArtKeyFor(root)) % candidates.length];
  const url = browser.runtime.getURL('assets/sacred-art/' + artEntryFile(pick));
  sacredArtByRoot.set(root, url);
  return url;
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

// The media viewer (photo/video detail overlay) can live outside the tweet's
// <article>; the matching article is then found by its own status link so the
// post text can still be replaced.
function articleForStatusId(statusId) {
  if (!statusId) return null;
  for (const link of document.querySelectorAll('article a[href*="/status/' + statusId + '"]')) {
    if (statusIdFromHref(link.getAttribute('href') || '') !== statusId) continue;
    const article = link.closest('article');
    if (article) return article;
  }
  return null;
}

function applyQuoteFor(root) {
  if (!settings.replaceText || !(root instanceof Element)) return;
  const statusId = statusIdFor(root);
  let article = root.closest('article');
  let layer = article ? tweetLayerFor(root, article) : null;
  if (!article) {
    article = articleForStatusId(statusId);
    layer = article;
  }
  if (!article) return;
  const text = [...article.querySelectorAll('[data-testid="tweetText"]')]
    .find(candidate => tweetLayerFor(candidate, article) === layer);
  if (!text || text.dataset.tabcloserQuoted === 'yes') return;
  const quote = quoteForKey(statusId || text.textContent.slice(0, 40));
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

function mediaPlayersWithin(root) {
  return [
    ...(root.matches?.('video, audio') ? [root] : []),
    ...root.querySelectorAll('video, audio'),
  ];
}

function blockMediaPlayback(player) {
  if (!blockedPlaybackStateByMedia.has(player)) {
    blockedPlaybackStateByMedia.set(player, {
      muted: player.muted,
    });
  }
  player.pause();
  player.muted = true;
}

function restoreMediaPlayback(player) {
  const state = blockedPlaybackStateByMedia.get(player);
  if (!state) return;
  blockedPlaybackStateByMedia.delete(player);
  player.muted = state.muted;
}

function restoreRootPlayback(root) {
  for (const player of mediaPlayersWithin(root)) restoreMediaPlayback(player);
}

function setRootState(root, state, reason) {
  if (!root?.isConnected) return;
  root.dataset.tabcloserMediaState = state;
  root.dataset.tabcloserMediaReason = reason || '';
  const host = overlayHostFor(root);
  const existing = overlayFor(root);
  const article = root.closest('article');
  if (state === 'safe') {
    restoreRootPlayback(root);
    existing?.remove();
    clearOverlayHost(host);
    // The protected element can live outside the article (media viewer), so a
    // sibling release must also respect the tweet-level session verdict.
    const articleTweetId = article ? statusIdFor(article) : null;
    const tweetStillProtected = !!articleTweetId &&
      (visuallyProtectedTweetIds.has(articleTweetId) || sensitiveTweetIds.has(articleTweetId));
    if (article && !tweetStillProtected &&
        !article.querySelector('[data-tabcloser-media-state="protected"]')) restoreArticleText(article);
    return;
  }
  activateOverlayHost(host);
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
  overlay.style.backgroundImage = '';
  overlay.setAttribute('role', 'img');
  overlay.setAttribute('aria-live', 'polite');
  const hiddenLabel = 'Sensitive media hidden';
  overlay.setAttribute('aria-label', shieldOnly ? 'Media is being checked by TabCloser' : hiddenLabel + ' by TabCloser');
  overlay.textContent = '';
  if (artUrl) {
    // Two layers, one image: a blurred cover backdrop fills the letterbox
    // bars and a contained artwork shows the painting whole. The overlay
    // itself never carries the image — an unblurred cover copy behind the
    // contained one reads as a duplicated painting.
    const backdrop = document.createElement('div');
    backdrop.className = 'tabcloser-overlay-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    const artwork = document.createElement('div');
    artwork.className = 'tabcloser-overlay-artwork';
    artwork.setAttribute('aria-hidden', 'true');
    overlay.appendChild(backdrop);
    overlay.appendChild(artwork);
    paintArtworkWhenReady(artUrl, [backdrop, artwork]);
  }
  if (!shieldOnly) {
    const label = document.createElement('span');
    label.className = 'tabcloser-overlay-label';
    label.textContent = hiddenLabel;
    overlay.appendChild(label);
  }
  overlay.title = reason || '';
  if (!existing) host.appendChild(overlay);
  if (state === 'protected' && mature) applyQuoteFor(root);
  for (const player of mediaPlayersWithin(root)) blockMediaPlayback(player);
}

function clearAllStates() {
  closeLightbox();
  restoreAllArticleText();
  document.querySelectorAll('.tabcloser-media-overlay').forEach(overlay => overlay.remove());
  document.querySelectorAll('.tabcloser-overlay-host').forEach(clearOverlayHost);
  document.querySelectorAll('[data-tabcloser-media-state]').forEach(root => {
    restoreRootPlayback(root);
    delete root.dataset.tabcloserMediaState;
    delete root.dataset.tabcloserMediaReason;
  });
}

function protectGroup(root, reason) {
  const article = root.closest('article');
  if (!article) {
    setRootState(root, 'protected', reason);
    return;
  }
  const layer = tweetLayerFor(root, article);
  const layerRoots = candidateRootsWithin(layer).filter(candidate => tweetLayerFor(candidate, article) === layer);
  const roots = layerRoots.length ? layerRoots : [root];
  for (const candidate of roots) setRootState(candidate, 'protected', reason);
}

function candidateRootsWithin(container) {
  if (!(container instanceof Element || container instanceof Document)) return [];
  if (container instanceof Element && extensionOwnedElement(container)) return [];
  const roots = new Set();
  if (container instanceof Element) {
    const warningRoot = nativeWarningRootFor(container);
    if (warningRoot) roots.add(warningRoot);
    const direct = mediaRootFor(container);
    if (direct) roots.add(direct);
    if (container.matches(mediaSelector)) roots.add(container);
  }
  container.querySelectorAll?.(mediaSelector + ', a[href*="/status/"][href*="/photo/"] img, a[href*="/status/"][href*="/video/"] img, a[href*="/status/"][href*="/video/"] video').forEach(node => {
    const root = mediaRootFor(node);
    if (root) roots.add(root);
  });
  container.querySelectorAll?.(statusLinkSelector).forEach(link => {
    const specialRoot = nativeWarningRootFor(link) || searchMediaRootFor(link);
    if (specialRoot) roots.add(specialRoot);
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

// Squashing a wide or tall frame into the square model input shrinks and
// distorts the subject, which under-scores skin regions. A second, centered
// square crop restores the subject at model resolution. Square-ish frames
// skip it: their squash already matches the crop.
function centerCropPixelsFromDrawable(drawable) {
  const width = drawable.videoWidth || drawable.naturalWidth || drawable.width || 0;
  const height = drawable.videoHeight || drawable.naturalHeight || drawable.height || 0;
  if (!width || !height) return null;
  const crop = Math.min(width, height);
  if (Math.max(width, height) / crop < 1.3) return null;
  const size = TabCloserXVerdict.MODEL_INPUT_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(drawable, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, size, size);
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

function ensureClassificationActive(isActive) {
  if (!isActive()) throw new Error('classification canceled');
}

function trimOldestMapEntries(map, limit = maxDirectVideoEntries) {
  while (map.size > limit) map.delete(map.keys().next().value);
}

function rememberDirectVideoSource(tweetId, source) {
  const id = tweetId == null ? null : String(tweetId);
  if (!id || !approvedXMediaUrl(source)) return false;
  directVideoSourcesByTweetId.delete(id);
  directVideoSourcesByTweetId.set(id, source);
  trimOldestMapEntries(directVideoSourcesByTweetId);
  const waiters = directVideoSourceWaitersByTweetId.get(id);
  if (waiters) {
    directVideoSourceWaitersByTweetId.delete(id);
    for (const resolve of waiters) resolve(source);
  }
  return true;
}

function waitForDirectVideoSource(tweetId, timeoutMs = 1500) {
  const existing = directVideoSourcesByTweetId.get(tweetId);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    let waiters = directVideoSourceWaitersByTweetId.get(tweetId);
    if (!waiters) {
      waiters = new Set();
      directVideoSourceWaitersByTweetId.set(tweetId, waiters);
    }
    let timer = null;
    const finish = value => {
      if (timer != null) clearTimeout(timer);
      waiters.delete(finish);
      if (!waiters.size) directVideoSourceWaitersByTweetId.delete(tweetId);
      resolve(value);
    };
    waiters.add(finish);
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

async function directVideoSourceForRoot(root, waitForDetail) {
  const tweetId = statusIdFor(root);
  if (!tweetId) return null;
  const existing = directVideoSourcesByTweetId.get(tweetId);
  if (existing) return existing;
  const pageTweetId = statusIdFromHref(location.pathname);
  if (!waitForDetail || pageTweetId !== tweetId) return null;
  return waitForDirectVideoSource(tweetId);
}

function detachedVideoSampleTimes(duration, fractions) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const latest = Math.max(0, duration - 0.1);
  const times = fractions.map(fraction => duration * fraction)
    .map(time => Math.min(latest, Math.max(0, time)))
    .map(time => Math.round(time * 1000) / 1000);
  return [...new Set(times)];
}

const baseSampleFractions = [0.15, 0.5, 0.85];
// Extra frames are only sampled when the base pass scored in the borderline
// band, so unremarkable videos keep the original three-frame cost.
const escalationSampleFractions = [0.3, 0.65, 0.95];
// Several frames each just under the single-frame threshold are strong
// evidence: protect when the mean crosses this fraction of the threshold.
const meanThresholdFraction = 0.7;
const escalationBandFraction = 0.5;

function boundedDetachedVideoSampleTimes(duration) {
  return detachedVideoSampleTimes(duration, baseSampleFractions);
}

function disposeDetachedVideoProbe(probe) {
  if (!probe) return;
  activeDetachedVideoProbes.delete(probe);
  try {
    probe.removeAttribute('src');
    probe.load();
  } catch {}
  probe.remove();
}

function cancelDetachedVideoProbes() {
  for (const probe of [...activeDetachedVideoProbes]) disposeDetachedVideoProbe(probe);
  for (const waiters of directVideoSourceWaitersByTweetId.values()) {
    for (const resolve of waiters) resolve(null);
  }
  directVideoSourceWaitersByTweetId.clear();
  directVideoProbeInFlight.clear();
}

async function seekDetachedVideoProbe(probe, time) {
  if (Math.abs(probe.currentTime - time) < 0.02 && probe.readyState >= 2) return;
  const seeked = waitForEvent(probe, 'seeked', 'error', 4000);
  probe.currentTime = time;
  await seeked;
  if (probe.readyState < 2) await waitForEvent(probe, 'loadeddata', 'error', 3000);
}

async function sampleDetachedVideoSource(source, control) {
  const probe = document.createElement('video');
  control.probe = probe;
  probe.className = 'tabcloser-video-probe';
  probe.crossOrigin = 'anonymous';
  probe.muted = true;
  probe.preload = 'auto';
  probe.playsInline = true;
  probe.style.cssText = 'position:fixed;width:2px;height:2px;left:-10000px;top:-10000px;opacity:0;pointer-events:none';
  activeDetachedVideoProbes.add(probe);
  probe.src = source;
  document.documentElement.appendChild(probe);
  try {
    if (probe.readyState < 1) await waitForEvent(probe, 'loadedmetadata', 'error', 4000);
    const baseTimes = boundedDetachedVideoSampleTimes(probe.duration);
    if (!baseTimes.length) throw new Error('detached video duration unavailable');
    const mediaKey = TabCloserXMetadata.normalizeMediaUrl(source) || source;
    const threshold = TabCloserXVerdict.presetValues(settings.sensitivity).threshold;
    const meanThreshold = threshold * meanThresholdFraction;
    const escalationBand = threshold * escalationBandFraction;
    const scores = [];

    const round = value => Math.round(value * 1000) / 1000;
    const aggregates = () => ({
      maxAdultScore: round(scores.length ? Math.max(...scores) : 0),
      meanAdultScore: round(scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0),
    });

    const classifyPixels = (imageData, frameKey) => browser.runtime.sendMessage({
      type: 'classifyXMedia',
      kind: 'frame',
      mediaKey: frameKey,
      pixels: imageData.data,
      width: imageData.width,
      height: imageData.height,
    });
    const matureVerdict = result => result?.verdict === 'protect' && result.reason === 'visual';
    const scoreOf = result => (Number.isFinite(result?.adultScore) ? result.adultScore : 0);

    const classifyFrames = async times => {
      for (const time of times) {
        if (!probe.isConnected) throw new Error('detached video probe canceled');
        await seekDetachedVideoProbe(probe, time);
        if (!probe.isConnected) throw new Error('detached video probe canceled');
        const frameKey = 'direct-video|' + mediaKey + '|t=' + time;
        let result = await classifyPixels(pixelsFromDrawable(probe), frameKey);
        let frameScore = scoreOf(result);
        if (!matureVerdict(result)) {
          const cropData = centerCropPixelsFromDrawable(probe);
          if (cropData) {
            const cropResult = await classifyPixels(cropData, frameKey + '|crop');
            frameScore = Math.max(frameScore, scoreOf(cropResult));
            if (matureVerdict(cropResult)) result = cropResult;
          }
        }
        scores.push(frameScore);
        if (matureVerdict(result)) {
          return { ...result, samplesChecked: scores.length, aggregate: 'max', ...aggregates() };
        }
        const { meanAdultScore } = aggregates();
        if (scores.length >= 2 && meanAdultScore >= meanThreshold) {
          return { verdict: 'protect', reason: 'visual', samplesChecked: scores.length, aggregate: 'mean', ...aggregates() };
        }
      }
      return null;
    };

    const baseVerdict = await classifyFrames(baseTimes);
    if (baseVerdict) return baseVerdict;
    if (scores.length && Math.max(...scores) >= escalationBand) {
      control.extendDeadline?.(6000);
      const extraTimes = detachedVideoSampleTimes(probe.duration, escalationSampleFractions)
        .filter(time => !baseTimes.includes(time));
      const escalatedVerdict = await classifyFrames(extraTimes);
      if (escalatedVerdict) return escalatedVerdict;
    }
    return { verdict: 'safe', reason: 'visual', samplesChecked: scores.length, ...aggregates() };
  } finally {
    disposeDetachedVideoProbe(probe);
  }
}

function classifyDirectVideoSource(source) {
  const normalized = TabCloserXMetadata.normalizeMediaUrl(source) || source;
  const cacheKey = settings.sensitivity + '|' + normalized;
  const cached = directVideoVerdictCache.get(cacheKey);
  if (cached) {
    directVideoVerdictCache.delete(cacheKey);
    directVideoVerdictCache.set(cacheKey, cached);
    return Promise.resolve(cached);
  }
  const existing = directVideoProbeInFlight.get(cacheKey);
  if (existing) return existing;

  const control = { probe: null };
  let timeout = null;
  const timedOut = new Promise((_, reject) => {
    const arm = delayMs => {
      timeout = setTimeout(() => {
        timeout = null;
        disposeDetachedVideoProbe(control.probe);
        reject(new Error('detached video probe timeout'));
      }, delayMs);
    };
    arm(8000);
    // Borderline escalation samples extra frames; it earns a bounded one-time
    // deadline extension instead of raising the cap for every video.
    control.extendDeadline = extraMs => {
      if (timeout == null) return;
      clearTimeout(timeout);
      arm(extraMs);
    };
  });
  const job = Promise.race([sampleDetachedVideoSource(source, control), timedOut])
    .then(result => {
      directVideoVerdictCache.delete(cacheKey);
      directVideoVerdictCache.set(cacheKey, result);
      trimOldestMapEntries(directVideoVerdictCache);
      return result;
    })
    .catch(() => ({ verdict: 'safe', reason: 'probe-unavailable', samplesChecked: 0 }))
    .finally(() => {
      if (timeout != null) clearTimeout(timeout);
      if (directVideoProbeInFlight.get(cacheKey) === job) directVideoProbeInFlight.delete(cacheKey);
      disposeDetachedVideoProbe(control.probe);
    });
  directVideoProbeInFlight.set(cacheKey, job);
  return job;
}

async function classifyVideoPoster(video, keyPrefix, isActive) {
  ensureClassificationActive(isActive);
  const poster = video.poster;
  if (!poster || !approvedXMediaUrl(poster)) return { verdict: 'safe', reason: 'visual' };
  const normalized = TabCloserXMetadata.normalizeMediaUrl(poster) || poster;
  let result;
  try {
    result = await classifyUrl(poster, keyPrefix + '|poster|' + normalized);
  } catch {
    ensureClassificationActive(isActive);
    return { verdict: 'safe', reason: 'visual' };
  }
  ensureClassificationActive(isActive);
  // Poster inference is a best-effort fallback behind X's post metadata. Only
  // a confirmed visual verdict may block a video; classifier failures must not
  // recreate a permanent "hidden until verified" state.
  return result?.verdict === 'protect' && result.reason === 'visual'
    ? result
    : { verdict: 'safe', reason: 'visual' };
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
// own tweet-level label ('metadata') hides every media cell in that tweet layer.
function protectUnsafeResult(root, reason) {
  if (reason === 'metadata') {
    protectGroup(root, reason);
    return;
  }
  setRootState(root, 'protected', reason);
  if (retryableReason.test(reason)) scheduleRetry(root);
}

async function classifyRoot(root, fingerprint, token) {
  const isActive = () => mode === 'full' && root.isConnected && rootRecords.get(root)?.token === token;
  try {
    ensureClassificationActive(isActive);
    if (metadataProtects(root)) {
      protectGroup(root, 'metadata');
      return;
    }
    if (visualVerdictProtects(root)) {
      protectGroup(root, 'visual');
      return;
    }
    const images = [...root.querySelectorAll('img[src]')].filter(image => !decorativeImage(image));
    const videos = [...root.querySelectorAll('video')];
    if (root.matches('img[src]') && !decorativeImage(root)) images.unshift(root);
    if (root.matches('video')) videos.unshift(root);
    if (!images.length && !videos.length) throw new Error('no classifiable media');

    for (const image of images) {
      ensureClassificationActive(isActive);
      const result = await classifyImage(image, fingerprint);
      ensureClassificationActive(isActive);
      if (result.verdict !== 'safe') {
        protectUnsafeResult(root, result.reason || 'visual');
        return;
      }
    }

    if (metadataProtects(root)) {
      protectGroup(root, 'metadata');
      return;
    }
    for (const video of videos) {
      const result = await classifyVideoPoster(video, fingerprint, isActive);
      ensureClassificationActive(isActive);
      if (result.verdict !== 'safe') {
        protectUnsafeResult(root, result.reason || 'visual');
        return;
      }
    }
    const directVideoSource = videos.length > 0
      ? await directVideoSourceForRoot(root, true)
      : null;
    ensureClassificationActive(isActive);
    if (directVideoSource) {
      const result = await classifyDirectVideoSource(directVideoSource);
      ensureClassificationActive(isActive);
      xMetadataDebug('direct-video-verdict', {
        statusId: statusIdFor(root),
        verdict: result.verdict,
        reason: result.reason,
        samplesChecked: result.samplesChecked || 0,
        aggregate: result.aggregate || null,
        maxAdultScore: result.maxAdultScore ?? null,
        meanAdultScore: result.meanAdultScore ?? null,
      });
      if (result.verdict !== 'safe') {
        // Direct-video verdicts are tweet-level: remember the ID so remounted
        // media (Media tab thumbnail, re-rendered detail view) is protected
        // without a second probe, and protect the whole tweet layer so the
        // post text is replaced along with the media.
        if (result.reason === 'visual') {
          rememberVisuallyProtectedTweet(statusIdFor(root));
          protectGroup(root, 'visual');
        } else {
          protectUnsafeResult(root, result.reason || 'visual');
        }
        return;
      }
    }


    ensureClassificationActive(isActive);
    if (rootFingerprint(root) !== fingerprint) {
      discoverRoot(root);
      return;
    }
    if (metadataProtects(root) || root.dataset.tabcloserMediaState === 'protected') {
      protectGroup(root, root.dataset.tabcloserMediaReason || 'metadata');
      return;
    }
    if (visualVerdictProtects(root)) {
      protectGroup(root, 'visual');
      return;
    }
    rememberVerifiedSafeMedia(root);
    const pageStatusId = statusIdFromHref(location.pathname);
    if (pageStatusId) {
      const rootStatusId = statusIdFor(root);
      xMetadataDebug('root-release', {
        pageStatusId,
        rootStatusId,
        statusIdMatches: rootStatusId === pageStatusId,
        rootKind: root.getAttribute?.('data-testid') || root.tagName?.toLowerCase() || null,
        imageCount: images.length,
        videoCount: videos.length,
        knownSensitiveTweet: !!rootStatusId && sensitiveTweetIds.has(rootStatusId),
      });
    }
    setRootState(root, 'safe', 'visual');
  } catch (error) {
    if (mode === 'full' && root.isConnected && rootRecords.get(root)?.token === token) {
      protectUnsafeResult(root, /timeout/i.test(error?.message || '') ? 'timeout' : 'error');
    }
  }
}

const classificationQueue = [];
const maxConcurrentClassifications = 2;
let activeClassifications = 0;

function drainClassificationQueue() {
  while (mode === 'full' && activeClassifications < maxConcurrentClassifications && classificationQueue.length) {
    const task = classificationQueue.shift();
    const record = rootRecords.get(task.root);
    if (!task.root.isConnected || record?.token !== task.token || record.status !== 'pending') continue;
    record.status = 'classifying';
    activeClassifications += 1;
    classifyRoot(task.root, task.fingerprint, task.token).finally(() => {
      activeClassifications -= 1;
      setTimeout(drainClassificationQueue, 0);
    });
  }
}

function queueRootClassification(root, record) {
  classificationQueue.push({ root, fingerprint: record.fingerprint, token: record.token });
  drainClassificationQueue();
}

const intersectionObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting || mode !== 'full') continue;
    intersectionObserver.unobserve(entry.target);
    const record = rootRecords.get(entry.target);
    if (record?.status === 'pending') queueRootClassification(entry.target, record);
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
  if (metadataProtects(root)) {
    protectGroup(root, 'metadata');
    return;
  }
  if (visualVerdictProtects(root)) {
    if (root.dataset.tabcloserMediaState !== 'protected') {
      xMetadataDebug('session-verdict-applied', { statusId: statusIdFor(root) });
    }
    protectGroup(root, 'visual');
    return;
  }
  if (hasVerifiedSafeMedia(root)) {
    const token = ++operationId;
    rootRecords.set(root, { fingerprint, status: 'safe', token, retries: 0 });
    setRootState(root, 'safe', 'visual');
    return;
  }
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

const discoveryQueue = new Set();
let discoveryTimer = null;

function flushDiscoveryQueue() {
  discoveryTimer = null;
  if (mode === 'off') {
    discoveryQueue.clear();
    return;
  }
  const containers = [];
  for (const container of discoveryQueue) {
    if (!container?.isConnected || extensionOwnedElement(container)) continue;
    if (containers.some(parent => parent.contains?.(container))) continue;
    for (let index = containers.length - 1; index >= 0; index -= 1) {
      if (container.contains?.(containers[index])) containers.splice(index, 1);
    }
    containers.push(container);
  }
  discoveryQueue.clear();
  for (const container of containers) discoverWithin(container);
}

function queueDiscovery(container) {
  if (mode === 'off' || !container?.isConnected || extensionOwnedElement(container)) return;
  discoveryQueue.add(container);
  if (discoveryTimer == null) discoveryTimer = setTimeout(flushDiscoveryQueue, 0);
}

function scanKnownRootsForMetadata() {
  const roots = new Set();
  const matchedRoots = [];
  document.querySelectorAll('[data-tabcloser-media-state], ' + mediaSelector).forEach(node => {
    const root = mediaRootFor(node) || node;
    if (roots.has(root)) return;
    roots.add(root);
    if (mode !== 'off' && metadataProtects(root)) {
      matchedRoots.push({
        statusId: statusIdFor(root),
        rootKind: root.getAttribute?.('data-testid') || root.tagName?.toLowerCase() || null,
      });
      protectGroup(root, 'metadata');
    }
  });
  return { rootsScanned: roots.size, matchedRoots: matchedRoots.slice(0, 20) };
}

function setProtection(config) {
  const modelEnabled = config?.model?.enabled === true;
  const labeledEnabled = modelEnabled || config?.labeled?.enabled === true || config?.enabled === true;
  settings = {
    replaceText: config?.replaceText === true,
    blockLike: config?.blockLike === true,
    sensitivity: config?.model?.sensitivity || 'balanced',
  };
  mode = modelEnabled ? 'full' : labeledEnabled ? 'labeled' : 'off';
  document.documentElement.dataset.tabcloserXProtection = mode;
  xMetadataDebug('protection-state', {
    diagnosticVersion: 'video-probe-v1',
    mode,
    labeledEnabled,
    modelEnabled,
  });
  operationId += 1;
  intersectionObserver.disconnect();
  classificationQueue.length = 0;
  discoveryQueue.clear();
  verifiedSafeMediaKeys.clear();
  if (discoveryTimer != null) {
    clearTimeout(discoveryTimer);
    discoveryTimer = null;
  }
  cancelDetachedVideoProbes();
  directVideoVerdictCache.clear();
  // Settings changes (notably sensitivity) invalidate earlier visual verdicts.
  visuallyProtectedTweetIds.clear();
  clearAllStates();
  if (mode !== 'off') discoverWithin(document);
}


function requeueSafeRootsForDirectVideoSources(tweetIds) {
  if (mode !== 'full' || !tweetIds.size) return;
  const roots = new Set(candidateRootsWithin(document));
  document.querySelectorAll('[data-tabcloser-media-state]').forEach(node => roots.add(mediaRootFor(node) || node));
  for (const root of roots) {
    const tweetId = statusIdFor(root);
    if (!mediaElementsWithin(root, 'video').length) continue;
    if (!tweetId || !tweetIds.has(tweetId)) continue;
    const record = rootRecords.get(root);
    if (root.dataset.tabcloserMediaState !== 'safe' && record?.status !== 'safe') continue;
    const verificationKey = stableMediaVerificationKey(root);
    if (verificationKey) verifiedSafeMediaKeys.delete(verificationKey);
    if (record) rootRecords.set(root, { ...record, status: 'stale' });
    discoverRoot(root);
  }
}
function addSensitiveMetadata(metadata) {
  const directVideoTweetIds = new Set();
  for (const [tweetId, source] of Object.entries(metadata?.videoSourcesByTweetId || {})) {
    if (rememberDirectVideoSource(tweetId, source)) directVideoTweetIds.add(String(tweetId));
  }
  for (const url of metadata?.urls || []) {
    const normalized = TabCloserXMetadata.normalizeMediaUrl(url);
    if (normalized) sensitiveUrls.add(normalized);
  }
  for (const tweetId of metadata?.tweetIds || []) sensitiveTweetIds.add(String(tweetId));
  requeueSafeRootsForDirectVideoSources(directVideoTweetIds);
  const scan = mode !== 'off'
    ? scanKnownRootsForMetadata()
    : { rootsScanned: 0, matchedRoots: [] };
  const pageStatusId = statusIdFromHref(location.pathname);
  if (pageStatusId) {
    xMetadataDebug('metadata-applied', {
      pageStatusId,
      receivedTweetIds: [...(metadata?.tweetIds || [])].map(String).slice(0, 20),
      receivedUrlCount: metadata?.urls?.length || 0,
      receivedDirectVideoSourceCount: directVideoTweetIds.size,
      pageTweetKnownSensitive: sensitiveTweetIds.has(pageStatusId),
      ...scan,
    });
  }
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
  if (blocked) blockMediaPlayback(event.target);
}, true);

browser.runtime.onMessage.addListener(message => {
  if (message?.type === 'tabCloserProtectionPing') {
    return Promise.resolve({ version: xProtectionCoordinatorVersion });
  }
  if (message?.type === 'xProtectionChanged') setProtection(message.xProtection);
  if (message?.type === 'xSensitiveMediaMetadata') addSensitiveMetadata(message.metadata);
  if (message?.type === 'xSensitiveMediaDiagnostic') {
    console.debug(xMetadataDebugPrefix, JSON.stringify(message.diagnostic));
  }
});

new MutationObserver(mutations => {
  if (mode === 'off') return;
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') queueDiscovery(mediaRootFor(mutation.target));
    else for (const node of mutation.addedNodes) if (node instanceof Element) queueDiscovery(node);
  }
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset', 'poster', 'href'],
});

browser.storage.local.get('xProtection')
  .then(data => setProtection(data.xProtection))
  .catch(error => {
    xMetadataDebug('protection-storage-error', { error: String(error?.message || error) });
    setProtection(null);
  });
