const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const rule = (domain, extra = {}) => ({
  id: domain, domain, enabled: true, closeAfterSec: 180,
  blockAfterClose: true, blockDurationSec: 1800, ...extra,
});

// Run the actual background script through its browser event/message seams.
// Time, storage and tabs are isolated; no real tabs or extension data are touched.
async function start({ rules = [rule('x.com')], blocks = {}, accumSec = {}, tabs: initialTabs,
  url = 'https://x.com/home' } = {}) {
  let now = 100000;
  let activeId = 1;
  let focused = true;
  let timerId = 0;
  let saved;
  const tabs = initialTabs || [{ id: 1, url, windowId: 1 }];
  const events = {}, timers = new Map(), alarms = new Map(), removed = [], updates = [];
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const context = vm.createContext({
    console, URL, TextDecoder, Uint8ClampedArray, ArrayBuffer,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    TabCloserXMediaUtils: require('../x-media-utils.js'),
    TabCloserXMetadata: require('../x-metadata.js'),
    TabCloserXVerdict: require('../x-verdict.js'),
    TabCloserClassifier: { warmUp() {} },
    browser: {
      storage: { local: {
        get: async () => structuredClone({ rules, blocks, accumSec }),
        set: async data => { saved = structuredClone(data); }, remove: async () => {},
      } },
      runtime: { getURL: value => 'moz-extension://test/' + value, onMessage: event('message') },
      windows: { getLastFocused: async () => ({ id: 1, focused }), onFocusChanged: event('windowFocus') },
      tabs: {
        query: async query => query.url ? [] : query.active
          ? tabs.filter(tab => tab.id === activeId) : tabs.slice(),
        sendMessage: async () => ({}),
        update: async (id, change) => {
          updates.push({ id, ...change });
          Object.assign(tabs.find(tab => tab.id === id) || {}, change);
        },
        remove: async ids => {
          removed.push(...ids);
          for (const id of ids) {
            const index = tabs.findIndex(tab => tab.id === id);
            if (index >= 0) tabs.splice(index, 1);
          }
          if (!tabs.some(tab => tab.id === activeId)) activeId = tabs[0]?.id;
        },
        onActivated: event('activated'), onUpdated: event('updated'), onRemoved: event('removed'),
      },
      alarms: {
        clear: async name => alarms.delete(name),
        create: (name, options) => alarms.set(name, options), onAlarm: event('alarm'),
      },
      webRequest: { onBeforeRequest: event('request') },
      webNavigation: { onBeforeNavigate: event('navigate') },
    },
  });
  for (const file of ['common.js', 'background.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  await vm.runInContext('bootPromise', context);
  const send = message => events.message(message);
  const state = () => send({ type: 'getState' });
  return {
    events, timers, alarms, removed, updates, send, state,
    saved: () => saved,
    advance(seconds) { now += seconds * 1000; },
    async activate(id) { activeId = id; await events.activated({ tabId: id }); await state(); },
    async focus(value) { focused = value; await events.windowFocus(value ? 1 : -1); await state(); },
    async tick() {
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) { timers.delete(id); await timer.fn(); }
      }
      await state();
    },
  };
}

test('independent site timers pause on tab/window changes and close only matching tabs', async () => {
  const h = await start({ rules: [rule('x.com'), rule('reddit.com')], tabs: [
    { id: 1, url: 'https://x.com' }, { id: 2, url: 'https://reddit.com' },
    { id: 3, url: 'https://mobile.x.com', windowId: 2 },
  ] });
  h.advance(10); await h.activate(2);
  h.advance(20); await h.focus(false);
  h.advance(90); await h.focus(true);
  await h.activate(1);
  const state = await h.state();
  assert.equal(state.accumSec['x.com'], 10);
  assert.equal(state.accumSec['reddit.com'], 20);
  h.advance(170); await h.tick();
  assert.deepEqual(h.removed, [1, 3]);
  assert.equal((await h.state()).accumSec['reddit.com'], 20);
  assert.ok((await h.state()).blocks['x.com']);
});

test('concurrent activation and window-focus notifications count an interval once', async () => {
  const h = await start();
  h.advance(10);
  await Promise.all([h.events.activated({ tabId: 1 }), h.events.windowFocus(1)]);
  assert.equal((await h.state()).accumSec['x.com'], 10);
});

test('the most specific enabled domain controls its own timer regardless of rule order', async () => {
  for (const reverse of [false, true]) {
    const rules = [rule('example.com'), rule('video.example.com', { closeAfterSec: 30 })];
    const h = await start({ rules: reverse ? rules.reverse() : rules, url: 'https://video.example.com/watch' });
    assert.equal((await h.state()).focus.domain, 'video.example.com');
    h.advance(30); await h.tick();
    assert.ok((await h.state()).blocks['video.example.com']);
    assert.equal((await h.state()).blocks['example.com'], undefined);
  }
});

test('an expired parent block cannot mask an active child block on navigation', async () => {
  const h = await start({ url: 'https://untracked.test', blocks: {
    'example.com': { until: 99000 }, 'video.example.com': { until: 700000 },
  } });
  await h.events.navigate({ frameId: 0, tabId: 1, url: 'https://video.example.com/watch' });
  await h.state();
  assert.match(h.updates[0]?.url || '', /blocked.html\?domain=video.example.com/);
});

test('the longest applicable block wins, including an active parent block', async () => {
  const h = await start({ url: 'https://untracked.test', blocks: {
    'video.example.com': { until: 200000 }, 'example.com': { until: 700000 },
  } });
  await h.events.navigate({ frameId: 0, tabId: 1, url: 'https://video.example.com/watch' });
  await h.state();
  assert.match(h.updates[0]?.url || '', /domain=example.com&until=700000/);
});

test('duplicate normalized domains are rejected without changing saved rules', async () => {
  const h = await start();
  const response = await h.send({ type: 'saveRules', rules: [
    rule('x.com'), rule('https://www.X.com/home', { id: 'duplicate', enabled: false }),
  ] });
  assert.equal(response.ok, false);
  assert.match(response.error, /already|duplicate/i);
  assert.equal((await h.state()).rules.length, 1);
});

test('legacy disabled duplicates cannot supply an enabled rule\'s block duration', async () => {
  const h = await start({ rules: [
    rule('x.com', { id: 'disabled', enabled: false, blockDurationSec: 60 }), rule('x.com'),
  ] });
  h.advance(180); await h.tick();
  assert.equal((await h.state()).blocks['x.com'].until, 280000 + 1800000);
});

test('resetting an active timer reschedules its timeout and ignores an obsolete alarm', async () => {
  const h = await start();
  const obsoleteTimeout = [...h.timers.values()][0].fn;
  h.advance(100);
  await h.send({ type: 'resetAccum', domain: 'x.com' });
  assert.equal((await h.state()).accumSec['x.com'], 0);
  h.advance(80); await obsoleteTimeout(); await h.events.alarm({ name: 'autoclose' }); await h.tick();
  assert.deepEqual(h.removed, []);
  h.advance(100); await h.tick();
  assert.deepEqual(h.removed, [1]);
});

test('saving after deleting the active rule does not resurrect orphan elapsed time', async () => {
  const h = await start();
  h.advance(10);
  assert.equal((await h.send({ type: 'saveRules', rules: [] })).ok, true);
  assert.equal((await h.state()).accumSec['x.com'], undefined);
  assert.equal(h.timers.size, 0);
});

test('a new subdomain rule cannot override a currently locked parent timer', async () => {
  const h = await start({ rules: [rule('example.com', { disableLockedUntil: 700000 })] });
  const response = await h.send({ type: 'saveRules', rules: [rule('example.com'), rule('video.example.com')] });
  assert.equal(response.ok, false);
  assert.match(response.error, /locked/i);
});

test('a stale close signal after switching sites cannot close the new site early', async () => {
  const h = await start({ rules: [rule('x.com'), rule('reddit.com')], tabs: [
    { id: 1, url: 'https://x.com' }, { id: 2, url: 'https://reddit.com' },
  ] });
  const stale = [...h.timers.values()][0].fn;
  h.advance(100); await h.activate(2);
  await stale(); await h.events.alarm({ name: 'autoclose' }); await h.state();
  assert.deepEqual(h.removed, []);
  assert.equal((await h.state()).focus.domain, 'reddit.com');
});
