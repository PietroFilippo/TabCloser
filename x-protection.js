// Sensitive media is identified from X's response metadata. Native warning text
// remains a fallback for media that X renders with an explicit warning card.
let enabled = false;
const sensitiveUrls = new Set();
const sensitiveTweetIds = new Set();

const warningPattern = /(?:sensitive content|content warning|may contain sensitive|potentially sensitive)/i;
const mediaSelector = '[data-testid="tweetPhoto"], [data-testid="videoComponent"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]';
const statusPathPattern = /\/status\/(\d+)(?:\/(?:photo|video)\/\d+)?/;

function normalizeMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

function createReplacement(root) {
  const replacement = document.createElement('div');
  const height = Math.max(96, Math.round(root.getBoundingClientRect().height) || 0);
  replacement.className = 'tabcloser-sensitive-replacement';
  replacement.style.cssText = 'align-items:center;background:#202020;border:1px solid #555;box-sizing:border-box;color:#e6e6e6;display:flex;font:600 14px system-ui,sans-serif;height:' + height + 'px;justify-content:center;padding:20px;text-align:center;width:100%;';
  replacement.setAttribute('role', 'img');
  replacement.setAttribute('aria-label', 'Sensitive media hidden by TabCloser');
  replacement.textContent = 'Sensitive media hidden';
  return replacement;
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

function mediaUrlIsSensitive(node) {
  const sourceNodes = [
    node,
    ...node.querySelectorAll?.('img[src], video[poster], video[src], source[src]') || [],
  ];
  return sourceNodes.some(item => {
    const values = [item.currentSrc, item.src, item.poster].filter(Boolean);
    return values.some(value => sensitiveUrls.has(normalizeMediaUrl(value)));
  });
}

function mediaTweetIsSensitive(node) {
  const tweetId = statusIdFor(node);
  return !!tweetId && sensitiveTweetIds.has(tweetId);
}

function shouldProtect(node) {
  return warningPattern.test(node.innerText || '') ||
    mediaUrlIsSensitive(node) ||
    mediaTweetIsSensitive(node);
}

function mediaRootFor(node) {
  const link = node.closest?.('a[href*="/status/"]');
  if (link && (statusPathPattern.test(link.getAttribute('href') || '') || link.querySelector('img, video'))) return link;

  const player = node.closest?.('video, audio');
  if (player) return player;

  return node.closest?.(mediaSelector) || node;
}

function silencePlayback(root) {
  const players = [
    ...(root.matches?.('video, audio') ? [root] : []),
    ...root.querySelectorAll?.('video, audio') || [],
  ];
  players.forEach(player => {
    player.pause();
    player.muted = true;
    player.volume = 0;
    player.removeAttribute('src');
    player.querySelectorAll('source').forEach(source => source.remove());
    player.load();
  });
}

function blockProtectedActivation(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest('[data-tabcloser-protected="true"]')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
}

window.addEventListener('click', blockProtectedActivation, true);
window.addEventListener('auxclick', blockProtectedActivation, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') blockProtectedActivation(event);
}, true);

function disableMediaNavigation(root) {
  const link = root.closest?.('a[href]');
  if (!link) return;
  link.removeAttribute('href');
  link.setAttribute('aria-disabled', 'true');
  link.tabIndex = -1;
}

function replaceProtected(root) {
  if (root.dataset?.tabcloserProtected === 'true') return;
  if (root.dataset) root.dataset.tabcloserProtected = 'true';
  disableMediaNavigation(root);
  silencePlayback(root);
  const replacement = createReplacement(root);
  if (root.matches?.('img, video, audio')) root.replaceWith(replacement);
  else root.replaceChildren(replacement);
  console.debug('[DEBUG-xmeta-9b4c] protected sensitive media');
}

function protectMedia() {
  if (!enabled) return;
  const candidates = new Set(document.querySelectorAll(mediaSelector));

  document.querySelectorAll('a[href*="/status/"]').forEach(link => {
    const href = link.getAttribute('href') || '';
    if (/\/status\/\d+\/(?:photo|video)\/\d+/.test(href) || link.querySelector('img, video')) {
      candidates.add(link);
    }
  });

  document.querySelectorAll('img[src], video[poster], video[src], source[src]').forEach(node => {
    if (mediaUrlIsSensitive(node)) candidates.add(mediaRootFor(node));
  });

  candidates.forEach(candidate => {
    if (shouldProtect(candidate)) replaceProtected(mediaRootFor(candidate));
  });
}

document.addEventListener('click', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const candidate = target.closest('a[href*="/status/"], ' + mediaSelector);
  if (!candidate) return;
  const root = mediaRootFor(candidate);
  const tweetId = statusIdFor(root);
  console.debug('[DEBUG-xmeta-9b4c] media click evidence', {
    tweetId: tweetId || 'none',
    tweetMetadataMatched: !!tweetId && sensitiveTweetIds.has(tweetId),
    urlMetadataMatched: mediaUrlIsSensitive(root),
    protected: root.dataset?.tabcloserProtected === 'true',
  });
}, true);

document.addEventListener('play', event => {
  const player = event.target;
  if (!(player instanceof HTMLMediaElement) || !enabled || !shouldProtect(player)) return;
  replaceProtected(mediaRootFor(player));
}, true);

function setProtection(config) {
  enabled = config?.enabled === true;
  if (enabled) protectMedia();
}

function addSensitiveMetadata(metadata) {
  console.debug('[DEBUG-xmeta-9b4c] received X metadata', { urls: metadata?.urls?.length || 0, tweetIds: metadata?.tweetIds?.length || 0 });
  for (const url of metadata?.urls || []) {
    const normalized = normalizeMediaUrl(url);
    if (normalized) sensitiveUrls.add(normalized);
  }
  for (const tweetId of metadata?.tweetIds || []) sensitiveTweetIds.add(String(tweetId));
  protectMedia();
}

browser.runtime.sendMessage({ type: 'getState' }).then(state => setProtection(state.xProtection)).catch(() => {});
browser.runtime.onMessage.addListener(message => {
  if (message?.type === 'xProtectionChanged') setProtection(message.xProtection);
  if (message?.type === 'xSensitiveMediaMetadata') addSensitiveMetadata(message.metadata);
});

new MutationObserver(protectMedia).observe(document.documentElement, { childList: true, subtree: true });
