// === State (in-memory; subset persisted) ===
const state = {
  rules: [],          // [{ id, domain, closeAfterSec, blockAfterClose, blockDurationSec, enabled }]
  accumSec: {},       // { [normalizedDomain]: accumulated active seconds }
  blocks: {},         // { [normalizedDomain]: { until: epochMs } }
  focus: { tabId: null, domain: null, enteredAt: null }, // not persisted
};

let closeTimer = null;

// === Persistence ===
async function loadState() {
  const data = await browser.storage.local.get(['rules', 'accumSec', 'blocks']);
  state.rules = data.rules ?? [];
  state.accumSec = data.accumSec ?? {};
  state.blocks = data.blocks ?? {};
}

async function persist() {
  await browser.storage.local.set({
    rules: state.rules,
    accumSec: state.accumSec,
    blocks: state.blocks,
  });
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

// === Messages from popup / options ===
browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg?.type) return;
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
          enabled: r.enabled !== false,
        }));
      state.rules = cleaned;
      // Prune orphan accum/blocks
      const keep = new Set(cleaned.map(r => r.domain));
      for (const k of Object.keys(state.accumSec)) if (!keep.has(k)) delete state.accumSec[k];
      for (const k of Object.keys(state.blocks)) if (!keep.has(k)) delete state.blocks[k];
      await persist();
      await handleFocusChange();
      return { ok: true };
    }
    case 'unblock': {
      const key = normalizeRuleDomain(msg.domain);
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
(async () => {
  await loadState();
  // Periodic safety commit (0.5 min = Firefox MV3 minimum for installed addons)
  browser.alarms.create('commit', { periodInMinutes: 0.5 });
  await handleFocusChange();
})();
