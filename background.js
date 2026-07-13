// === State (in-memory; subset persisted) ===
const state = {
  rules: [],          // [{ id, domain, closeAfterSec, blockAfterClose, blockDurationSec, enabled }]
  accumSec: {},       // { [normalizedDomain]: accumulated active seconds }
  blocks: {},         // { [normalizedDomain]: { until: epochMs } }
  // Two tiers: 'labeled' hides only media X itself marks mature; 'model' adds
  // the on-device classifier. model implies labeled (enable and lock).
  xProtection: {
    labeled: { enabled: false, lockUntil: null },
    model: { enabled: false, lockUntil: null, sensitivity: 'balanced' },
    replaceText: false, // swap censored post text for a Catholic quote
    blockLike: false,   // prevent liking posts whose media is censored
  },
  focus: { tabId: null, domain: null, enteredAt: null }, // not persisted
};

let closeTimer = null;
let bootPromise = null;

// === Persistence ===
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

async function loadState() {
  const data = await browser.storage.local.get(['rules', 'accumSec', 'blocks', 'xProtection']);
  state.rules = data.rules ?? [];
  state.accumSec = data.accumSec ?? {};
  state.blocks = data.blocks ?? {};
  const raw = data.xProtection ?? {};
  // Migrate the legacy single-toggle shape { enabled, disableLockedUntil }.
  const legacyEnabled = raw.enabled === true;
  const legacyLock = finiteOrNull(raw.disableLockedUntil);
  state.xProtection = {
    labeled: {
      enabled: raw.labeled?.enabled === true || legacyEnabled,
      lockUntil: finiteOrNull(raw.labeled?.lockUntil) ?? legacyLock,
    },
    model: {
      enabled: raw.model?.enabled === true || legacyEnabled,
      lockUntil: finiteOrNull(raw.model?.lockUntil) ?? legacyLock,
      sensitivity: SENSITIVITY_RANK[raw.model?.sensitivity] != null ? raw.model.sensitivity : 'balanced',
    },
    replaceText: raw.replaceText === true,
    blockLike: raw.blockLike === true,
  };
}

// Higher rank censors more; loosening is refused while the model tier is locked.
const SENSITIVITY_RANK = { lenient: 0, balanced: 1, strict: 2 };

async function persist() {
  await browser.storage.local.set({
    rules: state.rules,
    accumSec: state.accumSec,
    blocks: state.blocks,
    xProtection: state.xProtection,
  });
}

function isLockActive(until) {
  return Number.isFinite(until) && until > Date.now();
}

async function notifyXProtection() {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.map(tab => browser.tabs.sendMessage(tab.id, {
    type: 'xProtectionChanged',
    xProtection: state.xProtection,
  }).catch(() => {})));
}

// === Lookups ===
function findRule(host) {
  return state.rules.find(r => r.enabled && hostMatches(host, r.domain)) || null;
}

function findBlock(host) {
  for (const [key, block] of Object.entries(state.blocks)) {
    if (hostMatches(host, key)) return { key, block };
  }
  return null;
}

// === Focus / active tab ===
async function getActiveTab() {
  try {
    const win = await browser.windows.getLastFocused();
    if (!win || !win.focused) return null; // user not in any browser window
    const tabs = await browser.tabs.query({ active: true, windowId: win.id });
    return tabs[0] ?? null;
  } catch {
    return null;
  }
}

function clearCloseTimer() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  browser.alarms.clear('autoclose').catch(() => {});
}

function scheduleClose(remainingSec) {
  clearCloseTimer();
  const ms = Math.max(0, remainingSec * 1000);
  closeTimer = setTimeout(() => fireClose(), ms);
  // Backup alarm in case event page unloads (Firefox MV3 allows 0.5 min minimum)
  if (remainingSec >= 30) {
    browser.alarms.create('autoclose', { delayInMinutes: remainingSec / 60 });
  }
}

async function commitFocusElapsed() {
  if (state.focus.domain && state.focus.enteredAt) {
    const elapsed = (Date.now() - state.focus.enteredAt) / 1000;
    state.accumSec[state.focus.domain] =
      (state.accumSec[state.focus.domain] ?? 0) + elapsed;
  }
}

async function fireClose() {
  const key = state.focus.domain;
  if (!key) {
    clearCloseTimer();
    return;
  }
  await commitFocusElapsed();
  state.focus = { tabId: null, domain: null, enteredAt: null };
  closeTimer = null;
  await triggerAutoClose(key);
}

async function triggerAutoClose(domainKey) {
  const rule = state.rules.find(r => normalizeRuleDomain(r.domain) === domainKey);
  if (!rule) {
    await persist();
    return;
  }
  if (rule.blockAfterClose) {
    state.blocks[domainKey] = { until: Date.now() + rule.blockDurationSec * 1000 };
  }
  state.accumSec[domainKey] = 0;
  await persist();

  // Close every tab whose host matches the rule (any window).
  const tabs = await browser.tabs.query({});
  const ids = [];
  for (const t of tabs) {
    const h = hostFromUrl(t.url || '');
    if (h && hostMatches(h, rule.domain)) ids.push(t.id);
  }
  if (ids.length) {
    try {
      await browser.tabs.remove(ids);
    } catch (e) {
      console.warn('tabs.remove failed', e);
    }
  }
}

async function handleFocusChange() {
  await commitFocusElapsed();
  clearCloseTimer();

  const tab = await getActiveTab();
  const host = tab?.url ? hostFromUrl(tab.url) : null;

  // If currently focused tab is a blocked host, redirect immediately.
  if (host && tab) {
    const blk = findBlock(host);
    const onExtensionPage = tab.url?.startsWith(browser.runtime.getURL(''));
    if (blk && Date.now() < blk.block.until && !onExtensionPage) {
      const url = browser.runtime.getURL(
        `blocked.html?domain=${encodeURIComponent(blk.key)}&until=${blk.block.until}`
      );
      try { await browser.tabs.update(tab.id, { url }); } catch {}
      state.focus = { tabId: null, domain: null, enteredAt: null };
      await persist();
      return;
    }
  }

  const rule = host ? findRule(host) : null;
  if (rule && tab) {
    const key = normalizeRuleDomain(rule.domain);
    const accum = state.accumSec[key] ?? 0;
    const remaining = rule.closeAfterSec - accum;
    if (remaining <= 0) {
      state.focus = { tabId: null, domain: null, enteredAt: null };
      await persist();
      await triggerAutoClose(key);
      return;
    }
    state.focus = { tabId: tab.id, domain: key, enteredAt: Date.now() };
    scheduleClose(remaining);
  } else {
    state.focus = { tabId: null, domain: null, enteredAt: null };
  }
  await persist();
}

// === Event listeners ===
browser.tabs.onActivated.addListener(() => handleFocusChange());
browser.windows.onFocusChanged.addListener(() => handleFocusChange());
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) handleFocusChange();
});
browser.tabs.onRemoved.addListener(async (tabId) => {
  if (state.focus.tabId === tabId) {
    await commitFocusElapsed();
    state.focus = { tabId: null, domain: null, enteredAt: null };
    clearCloseTimer();
    await persist();
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'autoclose') {
    await fireClose();
  } else if (alarm.name === 'commit') {
    // Periodic safety commit so accumulated time isn't lost if event page unloads.
    if (state.focus.domain && state.focus.enteredAt) {
      const elapsed = (Date.now() - state.focus.enteredAt) / 1000;
      state.accumSec[state.focus.domain] =
        (state.accumSec[state.focus.domain] ?? 0) + elapsed;
      state.focus.enteredAt = Date.now();
      await persist();
    }
  }
});

// Block redirect on every navigation
browser.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // only top-level
  const host = hostFromUrl(details.url);
  if (!host) return;
  const blk = findBlock(host);
  if (!blk) return;
  if (Date.now() >= blk.block.until) {
    delete state.blocks[blk.key];
    await persist();
    return;
  }
  const url = browser.runtime.getURL(
    `blocked.html?domain=${encodeURIComponent(blk.key)}&until=${blk.block.until}`
  );
  try {
    await browser.tabs.update(details.tabId, { url });
  } catch {}
});


// === X / Twitter sensitive-media metadata ===
function normalizeMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

function containsSensitivityMarker(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return false;
  if (value.possibly_sensitive === true || value.sensitive_media_warning) return true;
  return Object.values(value).some(child => containsSensitivityMarker(child, depth + 1));
}

function extractSensitiveMedia(payload) {
  const urls = new Set();
  const tweetIds = new Set();
  const seen = new Set();

  function addUrl(value) {
    const normalized = normalizeMediaUrl(value);
    if (normalized) urls.add(normalized);
  }

  function inspect(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : node;
    const media = legacy.extended_entities?.media || legacy.entities?.media ||
      node.extended_entities?.media || node.entities?.media;
    if (Array.isArray(media) && media.length && containsSensitivityMarker(node)) {
      const tweetId = node.rest_id || legacy.id_str || node.id_str;
      if (tweetId) tweetIds.add(String(tweetId));
      for (const item of media) {
        addUrl(item.media_url_https);
        addUrl(item.media_url);
        for (const variant of item.video_info?.variants ?? []) addUrl(variant.url);
      }
    }

    for (const child of Object.values(node)) {
      if (child && typeof child === 'object') inspect(child);
    }
  }

  inspect(payload);
  return { urls: [...urls], tweetIds: [...tweetIds] };
}

// Only operations that can carry tweet/media payloads are worth parsing; misses
// simply fall back to the fail-closed visual classifier.
const xTweetOperationPattern = /Timeline|Tweet|Search|Bookmark|Media|Conversation|List|Detail|Likes|Explore/i;

function observeXGraphqlResponse(details) {
  if (!state.xProtection.labeled.enabled || details.tabId < 0) return;
  const operation = new URL(details.url).pathname.split('/').pop() || '';
  if (!xTweetOperationPattern.test(operation)) return;
  console.debug('[DEBUG-xmeta-9b4c] observing X response', new URL(details.url).pathname);
  const filter = browser.webRequest.filterResponseData(details.requestId);
  const decoder = new TextDecoder();
  let response = '';

  filter.ondata = event => {
    // Pass bytes through immediately; the pending overlay already prevents a
    // sensitive flash, so X must never wait on our parsing.
    filter.write(event.data);
    response += decoder.decode(event.data, { stream: true });
  };
  filter.onstop = async () => {
    filter.close();
    response += decoder.decode();
    try {
      const metadata = TabCloserXMetadata.extractSensitiveMedia(JSON.parse(response));
      console.debug('[DEBUG-xmeta-9b4c] parsed X metadata', { urls: metadata.urls.length, tweetIds: metadata.tweetIds.length });
      if (metadata.urls.length || metadata.tweetIds.length) {
        await browser.tabs.sendMessage(details.tabId, { type: 'xSensitiveMediaMetadata', metadata });
      }
    } catch (error) {
      console.debug('[DEBUG-xmeta-9b4c] X response was not parsed or delivered', error?.message || 'unknown error');
    }
  };
  filter.onerror = () => {
    // A failed stream is already disconnected by Firefox; calling disconnect again throws.
    console.debug('[DEBUG-xmeta-9b4c] X response stream ended with an error');
  };
}

browser.webRequest.onBeforeRequest.addListener(
  observeXGraphqlResponse,
  {
    urls: [
      '*://x.com/i/api/graphql/*',
      '*://*.x.com/i/api/graphql/*',
      '*://twitter.com/i/api/graphql/*',
      '*://*.twitter.com/i/api/graphql/*',
    ],
    types: ['xmlhttprequest'],
  },
  ['blocking']
);

// === Local X / Twitter mature-media classification ===
const xClassifierCache = new TabCloserXMediaUtils.LruCache(500);
const xClassifierDiagnostics = { requests: 0, cacheHits: 0, safe: 0, protected: 0, errors: 0, timeouts: 0 };
let xClassifierQueue = Promise.resolve();

function isXPageUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com');
  } catch {
    return false;
  }
}

function isApprovedXMediaUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' &&
      (host === 'pbs.twimg.com' || host === 'video.twimg.com' || host === 'abs.twimg.com' || host.endsWith('.twimg.com'));
  } catch {
    return false;
  }
}

function enqueueXClassification(work) {
  const result = xClassifierQueue.then(work, work);
  xClassifierQueue = result.catch(() => {});
  return result;
}

function preferredXFetchUrl(value) {
  // The model only sees 224px; never download the full-resolution variant.
  try {
    const url = new URL(value);
    if (url.hostname === 'pbs.twimg.com' && /^(large|medium|orig|4096x4096)$/.test(url.searchParams.get('name') || '')) {
      url.searchParams.set('name', 'small');
    }
    return url.href;
  } catch {
    return value;
  }
}

async function fetchXMediaBlob(fetchUrl, cache, signal) {
  const response = await fetch(fetchUrl, { cache, credentials: 'omit', redirect: 'follow', signal });
  if (!response.ok || !isApprovedXMediaUrl(response.url)) throw new Error('media request rejected');
  const type = response.headers.get('content-type') || '';
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (!type.toLowerCase().startsWith('image/')) throw new Error('unsupported media type');
  if (declaredSize > 15 * 1024 * 1024) throw new Error('media is too large');
  const blob = await response.blob();
  if (blob.size > 15 * 1024 * 1024) throw new Error('media is too large');
  return blob;
}

async function imageDataFromXUrl(value) {
  if (!isApprovedXMediaUrl(value)) throw new Error('unapproved media URL');
  const fetchUrl = preferredXFetchUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    let bitmap;
    try {
      bitmap = await createImageBitmap(await fetchXMediaBlob(fetchUrl, 'force-cache', controller.signal));
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // A stale or truncated cache entry decodes as "object no longer usable";
      // retry once bypassing the HTTP cache before failing closed.
      bitmap = await createImageBitmap(await fetchXMediaBlob(fetchUrl, 'reload', controller.signal));
    }
    try {
      const size = TabCloserXVerdict.MODEL_INPUT_SIZE;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('canvas is unavailable');
      context.drawImage(bitmap, 0, 0, size, size);
      return context.getImageData(0, 0, size, size);
    } finally {
      bitmap.close();
    }
  } finally {
    clearTimeout(timeout);
  }
}

function imageDataFromFrameMessage(msg) {
  const size = TabCloserXVerdict.MODEL_INPUT_SIZE;
  if (msg.width !== size || msg.height !== size) throw new Error('invalid frame dimensions');
  let pixels;
  if (msg.pixels instanceof Uint8ClampedArray) pixels = msg.pixels;
  else if (ArrayBuffer.isView(msg.pixels)) pixels = new Uint8ClampedArray(msg.pixels.buffer);
  else if (msg.pixels instanceof ArrayBuffer) pixels = new Uint8ClampedArray(msg.pixels);
  else throw new Error('invalid frame pixels');
  if (pixels.length !== size * size * 4) throw new Error('invalid frame length');
  return new ImageData(new Uint8ClampedArray(pixels), size, size);
}

async function classifyXMedia(msg, sender) {
  if (!state.xProtection.model.enabled || !isXPageUrl(sender?.tab?.url || sender?.url || '')) {
    return { verdict: 'protect', reason: 'invalid', modelVersion: TabCloserXVerdict.MODEL_VERSION };
  }
  const mediaKey = typeof msg.mediaKey === 'string' ? msg.mediaKey.slice(0, 2048) : '';
  if (!mediaKey) return { verdict: 'protect', reason: 'invalid', modelVersion: TabCloserXVerdict.MODEL_VERSION };
  const sensitivity = state.xProtection.model.sensitivity;
  const cacheKey = TabCloserXVerdict.MODEL_VERSION + '|' + sensitivity + '|' + mediaKey;
  const cached = xClassifierCache.get(cacheKey);
  if (cached) {
    xClassifierDiagnostics.cacheHits += 1;
    return cached;
  }
  xClassifierDiagnostics.requests += 1;
  return enqueueXClassification(async () => {
    try {
      const imageData = msg.kind === 'url' ? await imageDataFromXUrl(msg.url) : imageDataFromFrameMessage(msg);
      const classified = await Promise.race([
        TabCloserClassifier.classifyImageData(imageData, sensitivity),
        new Promise((_, reject) => setTimeout(() => reject(new Error('classification timeout')), 10000)),
      ]);
      const result = { verdict: classified.verdict, reason: classified.reason, modelVersion: TabCloserXVerdict.MODEL_VERSION };
      xClassifierCache.set(cacheKey, result);
      if (result.verdict === 'safe') xClassifierDiagnostics.safe += 1;
      else xClassifierDiagnostics.protected += 1;
      return result;
    } catch (error) {
      const timedOut = /timeout|aborted/i.test(error?.message || error?.name || '');
      if (timedOut) xClassifierDiagnostics.timeouts += 1;
      else xClassifierDiagnostics.errors += 1;
      console.warn('[TabCloser] X media classification failed; protecting media', {
        kind: msg.kind,
        mediaKey: mediaKey.slice(0, 160),
        error: error?.message || String(error),
      });
      return { verdict: 'protect', reason: timedOut ? 'timeout' : 'error', modelVersion: TabCloserXVerdict.MODEL_VERSION };
    }
  });
}

// === Messages from popup / options ===
browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg?.type) return;
  if (bootPromise) await bootPromise;
  switch (msg.type) {
    case 'getState': {
      // include in-flight focus seconds so UI reads live time
      const pendingAccum = { ...state.accumSec };
      if (state.focus.domain && state.focus.enteredAt) {
        const elapsed = (Date.now() - state.focus.enteredAt) / 1000;
        pendingAccum[state.focus.domain] =
          (pendingAccum[state.focus.domain] ?? 0) + elapsed;
      }
      return {
        rules: state.rules,
        accumSec: pendingAccum,
        blocks: state.blocks,
        xProtection: state.xProtection,
        focus: { ...state.focus },
        now: Date.now(),
      };
    }
    case 'saveRules': {
      const cleaned = msg.rules
        .filter(r => r && typeof r.domain === 'string' && r.domain.trim().length > 0)
        .map(r => ({
          id: r.id || uuid(),
          domain: normalizeRuleDomain(r.domain),
          closeAfterSec: Math.max(1, Math.round(r.closeAfterSec)),
          blockAfterClose: !!r.blockAfterClose,
          blockDurationSec: Math.max(1, Math.round(r.blockDurationSec)),
          lockUnblock: !!r.lockUnblock,
          enabled: r.enabled !== false,
        }));
      const existingById = new Map(state.rules.map(rule => [rule.id, rule]));
      for (const existing of state.rules) {
        if (!isLockActive(existing.disableLockedUntil)) continue;
        const replacement = cleaned.find(rule => rule.id === existing.id);
        if (!replacement || !replacement.enabled || replacement.domain !== existing.domain ||
            replacement.closeAfterSec !== existing.closeAfterSec ||
            replacement.blockAfterClose !== existing.blockAfterClose ||
            replacement.blockDurationSec !== existing.blockDurationSec ||
            replacement.lockUnblock !== !!existing.lockUnblock) {
          return { ok: false, error: 'Rule for ' + existing.domain + ' is locked until ' + new Date(existing.disableLockedUntil).toLocaleString() + '.' };
        }
      }
      for (const rule of cleaned) rule.disableLockedUntil = existingById.get(rule.id)?.disableLockedUntil ?? null;
      state.rules = cleaned;
      // Prune orphan accum/blocks
      const keep = new Set(cleaned.map(r => r.domain));
      for (const k of Object.keys(state.accumSec)) if (!keep.has(k)) delete state.accumSec[k];
      for (const k of Object.keys(state.blocks)) if (!keep.has(k)) delete state.blocks[k];
      await persist();
      await handleFocusChange();
      return { ok: true };
    }
    case 'lockRule': {
      const rule = state.rules.find(item => item.id === msg.id);
      const durationSec = Math.round(Number(msg.durationSec));
      if (!rule || !rule.enabled || !Number.isFinite(durationSec) || durationSec < 60) return { ok: false, error: 'Choose an enabled rule and a lock duration of at least one minute.' };
      const until = Date.now() + durationSec * 1000;
      if (isLockActive(rule.disableLockedUntil) && until <= rule.disableLockedUntil) return { ok: false, error: 'A rule lock cannot be shortened.' };
      rule.disableLockedUntil = until;
      await persist();
      return { ok: true, until };
    }
    case 'saveXProtection': {
      // model implies labeled: requesting the model tier turns labeled on too.
      const modelEnabled = msg.model === true;
      const labeledEnabled = msg.labeled === true || modelEnabled;
      const current = state.xProtection;
      if (current.labeled.enabled && !labeledEnabled && isLockActive(current.labeled.lockUntil)) {
        return { ok: false, error: 'X-label protection is locked until ' + new Date(current.labeled.lockUntil).toLocaleString() + '.' };
      }
      if (current.model.enabled && !modelEnabled && isLockActive(current.model.lockUntil)) {
        return { ok: false, error: 'The classifier tier is locked until ' + new Date(current.model.lockUntil).toLocaleString() + '.' };
      }
      if (typeof msg.sensitivity === 'string') {
        const nextRank = SENSITIVITY_RANK[msg.sensitivity];
        if (nextRank == null) return { ok: false, error: 'Unknown sensitivity preset.' };
        if (nextRank < SENSITIVITY_RANK[current.model.sensitivity] && isLockActive(current.model.lockUntil)) {
          return { ok: false, error: 'Sensitivity cannot be lowered while the classifier tier is locked (until ' + new Date(current.model.lockUntil).toLocaleString() + ').' };
        }
        current.model.sensitivity = msg.sensitivity;
      }
      current.labeled.enabled = labeledEnabled;
      current.model.enabled = modelEnabled;
      if (typeof msg.replaceText === 'boolean') current.replaceText = msg.replaceText;
      if (typeof msg.blockLike === 'boolean') current.blockLike = msg.blockLike;
      if (modelEnabled) TabCloserClassifier.warmUp();
      await persist();
      await notifyXProtection();
      return { ok: true };
    }
    case 'lockXProtection': {
      const target = msg.target === 'model' ? 'model' : 'labeled';
      const tier = state.xProtection[target];
      const durationSec = Math.round(Number(msg.durationSec));
      if (!tier.enabled || !Number.isFinite(durationSec) || durationSec < 60) return { ok: false, error: 'Enable that protection tier and choose at least one minute.' };
      const until = Date.now() + durationSec * 1000;
      if (isLockActive(tier.lockUntil) && until <= tier.lockUntil) return { ok: false, error: 'A protection lock cannot be shortened.' };
      tier.lockUntil = until;
      // Locking the classifier tier must also pin the labeled tier it implies.
      if (target === 'model') {
        state.xProtection.labeled.lockUntil = Math.max(state.xProtection.labeled.lockUntil ?? 0, until);
      }
      await persist();
      await notifyXProtection();
      return { ok: true, until };
    }
    case 'classifyXMedia':
      return classifyXMedia(msg, sender);
    case 'getXProtectionDiagnostics':
      return {
        ...xClassifierDiagnostics,
        cacheSize: xClassifierCache.size,
        modelVersion: TabCloserXVerdict.MODEL_VERSION,
      };
    case 'unblock': {
      const key = normalizeRuleDomain(msg.domain);
      const rule = state.rules.find(item => normalizeRuleDomain(item.domain) === key);
      if (rule?.lockUnblock && isLockActive(rule.disableLockedUntil)) {
        return { ok: false, error: 'Early unblock for ' + key + ' is locked until ' + new Date(rule.disableLockedUntil).toLocaleString() + '.' };
      }
      delete state.blocks[key];
      state.accumSec[key] = 0;
      await persist();
      return { ok: true };
    }
    case 'resetAccum': {
      const key = normalizeRuleDomain(msg.domain);
      state.accumSec[key] = 0;
      if (state.focus.domain === key) state.focus.enteredAt = Date.now();
      await persist();
      return { ok: true };
    }
  }
});

// === Boot ===
bootPromise = (async () => {
  await loadState();
  if (state.xProtection.model.enabled) TabCloserClassifier.warmUp();
  // Periodic safety commit (0.5 min = Firefox MV3 minimum for installed addons)
  browser.alarms.create('commit', { periodInMinutes: 0.5 });
  await handleFocusChange();
})();
