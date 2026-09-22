const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const rule = domain => ({ id: domain, domain, enabled: true, closeAfterSec: 180, blockDurationSec: 1800 });

async function start(t, rules, blocks = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'options.html'), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const callbacks = new Map();
  let timerId = 0;
  w.setInterval = () => 0;
  w.setTimeout = callback => { const id = ++timerId; callbacks.set(id, callback); return id; };
  w.clearTimeout = id => callbacks.delete(id);
  w.browser = { runtime: { sendMessage: async msg => msg.type === 'getState'
    ? { rules: structuredClone(rules), accumSec: {}, blocks, xProtection: {} }
    : { ok: false, error: 'x.com already has a rule. Edit that rule instead.' } } };
  for (const file of ['common.js', 'options.js']) w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  await new Promise(resolve => setImmediate(resolve));
  return { w, async save() { for (const [id, fn] of [...callbacks]) { callbacks.delete(id); await fn(); } } };
}

test('duplicate-domain validation keeps the draft available to correct', async t => {
  const h = await start(t, [rule('x.com')]);
  h.w.document.querySelector('#addRule').click();
  const input = h.w.document.querySelectorAll('input[placeholder="e.g. x.com"]')[1];
  input.value = 'x.com';
  input.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  await h.save();
  assert.match(h.w.document.querySelector('#saveStatus').textContent, /already has a rule/);
  assert.equal(h.w.document.querySelectorAll('.rule').length, 2);
  assert.equal(input.isConnected, true);
  assert.equal(input.value, 'x.com');
});

test('settings explain a longer inherited cooldown instead of promising an earlier unblock', async t => {
  const h = await start(t, [rule('example.com'), rule('video.example.com')], {
    'example.com': { until: Date.now() + 1800000 },
    'video.example.com': { until: Date.now() + 60000 },
  });
  const child = h.w.document.querySelectorAll('.rule')[1];
  assert.match(child.querySelector('.status').textContent, /Blocked by example.com/);
  assert.equal(child.querySelector('[data-action="unblock"]'), null);
});
