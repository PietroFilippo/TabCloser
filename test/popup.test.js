const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const now = 100000;
const rule = (domain, extra = {}) => ({ domain, id: domain, enabled: true, closeAfterSec: 180, ...extra });
async function start(t, { rules = [], blocks = {}, accumSec = {}, focus = {}, adultSites = {}, url = 'https://untracked.test' } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'popup.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const data = { rules, blocks, accumSec, focus, adultSites };
  let refresh;
  w.Date.now = () => now;
  w.setInterval = callback => { refresh = callback; };
  w.browser = {
    runtime: { getURL: value => 'moz-extension://test/' + value, sendMessage: async () => data, openOptionsPage: async () => {} },
    tabs: { query: async () => [{ id: 1, url }] },
  };
  for (const file of ['common.js', 'popup.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  await new Promise(resolve => setImmediate(resolve));
  return { document: w.document, data, async refresh() { await refresh(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('a blocked site appears once, without a reset progress bar', async t => {
  const h = await start(t, { rules: [rule('x.com')], blocks: { 'x.com': { until: now + 1800000 } } });
  assert.equal(h.document.querySelectorAll('.row.blocked').length, 1);
  assert.equal(h.document.querySelectorAll('#active .row').length, 0);
  assert.equal(h.document.querySelectorAll('.bar').length, 0);
  assert.equal(h.document.querySelector('#activeSection').hidden, true);
  assert.equal(h.document.querySelector('#current').closest('[hidden]'), null);
  assert.match(h.document.querySelector('#blocks').textContent, /30:00/);
});

test('the block page shows its original domain as current without duplicating it', async t => {
  const h = await start(t, { rules: [rule('x.com')], blocks: { 'x.com': { until: now + 1800000 } },
    url: 'moz-extension://test/blocked.html?domain=x.com&until=1900000' });
  assert.match(h.document.querySelector('#current').textContent, /x.com/);
  assert.ok(h.document.querySelector('#current .blocked'));
  assert.equal(h.document.querySelector('#current').closest('[hidden]'), null);
  assert.equal(h.document.querySelectorAll('#blocks .row, #active .row').length, 0);
});

test('internal browser pages have a friendly current-site description', async t => {
  const h = await start(t, { url: 'about:addons' });
  assert.doesNotMatch(h.document.querySelector('#current').textContent, /has no timer/);
  assert.match(h.document.querySelector('#current').textContent, /browser|internal/i);
});

test('adult block pages never promise an expired cooldown', async t => {
  const h = await start(t, { rules: [rule('adult.example')], adultSites: { enabled: true, lockUntil: now + 60000 }, url: 'moz-extension://test/blocked.html?reason=adult&domain=adult.example' });
  assert.match(h.document.querySelector('#current').textContent, /Blocked by adult-site protection/);
  assert.doesNotMatch(h.document.querySelector('#current').textContent, /Cooldown finished/);
  assert.equal(h.document.querySelectorAll('#active .row').length, 0);
  h.data.adultSites.enabled = false;
  await h.refresh();
  assert.match(h.document.querySelector('#current').textContent, /Paused/);
  h.data.rules = [];
  await h.refresh();
  assert.match(h.document.querySelector('#current').textContent, /protection is off/);
});

test('a child-only block does not relabel or hide the unblocked parent timer', async t => {
  const h = await start(t, { rules: [rule('example.com')],
    blocks: { 'video.example.com': { until: now + 60000 } }, url: 'https://video.example.com' });
  assert.equal(h.document.querySelector('#current .dom').textContent, 'video.example.com');
  assert.equal(h.document.querySelector('#active .dom').textContent, 'example.com');
  assert.equal(h.document.querySelectorAll('#blocks .row').length, 0);
});

test('an empty configuration leaves the current-site note and settings button visible', async t => {
  const h = await start(t);
  assert.match(h.document.querySelector('#current').textContent, /No timer/);
  assert.equal(h.document.querySelector('#current').closest('[hidden]'), null);
  assert.equal(h.document.querySelector('#openOptions').closest('[hidden]'), null);
  assert.equal(h.document.querySelector('#activeSection').hidden, true);
  assert.equal(h.document.querySelector('#blockSection').hidden, true);
});

test('current-site status uses actual focus and the most specific rule', async t => {
  const h = await start(t, { rules: [rule('example.com'), rule('video.example.com')],
    url: 'https://video.example.com', focus: {} });
  assert.match(h.document.querySelector('#current').textContent, /video.example.com/);
  assert.match(h.document.querySelector('#current').textContent, /paused/i);
  h.data.focus = { domain: 'video.example.com', tabId: 1, enteredAt: now };
  await h.refresh();
  assert.match(h.document.querySelector('#current').textContent, /counting/i);
});

for (const count of [1, 5, 10]) {
  test(`${count} tracked sites have accurate counts and working overflow controls`, async t => {
    const h = await start(t, { rules: Array.from({ length: count }, (_, i) => rule(`site${i}.test`)) });
    assert.equal(h.document.querySelectorAll('#active .row').length, Math.min(5, count));
    assert.equal(h.document.querySelector('#activeCount').textContent, String(count));
    assert.equal(h.document.querySelector('#active').closest('[hidden]'), null);
    if (count > 5) {
      const more = h.document.querySelector('#activeMore');
      assert.equal(more.tagName, 'BUTTON');
      more.click(); await h.refresh();
      assert.equal(h.document.querySelectorAll('#active .row').length, count);
      assert.equal(more.getAttribute('aria-expanded'), 'true');
      more.click(); await h.refresh();
      assert.equal(h.document.querySelectorAll('#active .row').length, 5);
    }
  });
}

test('ten blocked sites are counted only once and expand in expiry order', async t => {
  const rules = Array.from({ length: 10 }, (_, i) => rule(`site${i}.test`));
  const blocks = Object.fromEntries(rules.map((r, i) => [r.domain, { until: now + (10 - i) * 60000 }]));
  const h = await start(t, { rules, blocks });
  assert.equal(h.document.querySelectorAll('#active .row').length, 0);
  assert.equal(h.document.querySelector('#blockCount').textContent, '10');
  assert.match(h.document.querySelector('#blocks .row').textContent, /site9.test/);
  h.document.querySelector('#blockMore').click(); await h.refresh();
  assert.equal(h.document.querySelectorAll('#blocks .row').length, 10);
});

test('an expired cooldown becomes a paused timer and parent blocks also cover child rules', async t => {
  const h = await start(t, { rules: [rule('example.com'), rule('video.example.com')],
    blocks: { 'example.com': { until: now + 60000 } } });
  assert.equal(h.document.querySelectorAll('#active .row').length, 0);
  delete h.data.blocks['example.com'];
  await h.refresh();
  assert.equal(h.document.querySelectorAll('#active .row').length, 2);
  assert.equal(h.document.querySelectorAll('#blocks .row').length, 0);
});
