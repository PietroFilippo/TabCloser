const test = require('node:test');
const assert = require('node:assert/strict');
const controls = require('../x-user-controls.js');
const today = new Date(2026, 8, 22, 12).getTime();
const request = (overrides = {}) => ({ postId: '123', tabId: 1, limitSec: 30, now: today, token: 'one', ...overrides });

test('one shared reservation prevents simultaneous reveals in other tabs', () => {
  const state = controls.normalize();
  assert.equal(controls.begin(state, request()).durationMs, 3000);
  assert.equal(controls.begin(state, request({ tabId: 2, postId: '456' })).ok, false);
  assert.equal(controls.end(state, { token: 'one', tabId: 2, now: today + 1000 }), false);
  assert.equal(state.ledger.usedMs, 3000);
});

test('early release refunds unused time; repeated holds share the post cap', () => {
  const state = controls.normalize();
  controls.begin(state, request());
  assert.equal(controls.end(state, { token: 'one', tabId: 1, now: today + 1000 }), true);
  assert.equal(state.ledger.usedMs, 1000);
  const second = controls.begin(state, request({ token: 'two', now: today + 1000 }));
  assert.equal(second.durationMs, 2000);
  assert.equal(controls.begin(state, request({ now: today + 4000 })).ok, false);
  assert.equal(controls.begin(state, request({ postId: '456', now: today + 4000 })).ok, true);
});

test('daily limit caps the final reveal, and disabling/re-enabling never resets usage', () => {
  const state = controls.normalize();
  controls.begin(state, request({ limitSec: 4 }));
  const last = controls.begin(state, request({ postId: '456', now: today + 4000, limitSec: 4 }));
  assert.equal(last.durationMs, 1000);
  assert.equal(controls.remaining(state, 0, '789', today + 6000).dailyMs, 0);
  assert.equal(controls.begin(state, request({ postId: '789', now: today + 6000, limitSec: 4 })).ok, false);
});

test('restart consumes outstanding reservations and preserves per-post usage', () => {
  const state = controls.normalize();
  controls.begin(state, request());
  const restarted = controls.normalize(JSON.parse(JSON.stringify(state)));
  assert.equal(restarted.ledger.lease, null);
  assert.equal(controls.begin(restarted, request({ now: today + 1000 })).ok, false);
  assert.equal(controls.remaining(restarted, 30, '123', today + 1000).dailyMs, 27000);
});

test('local midnight replenishes once and moving the date backwards does not', () => {
  const state = controls.normalize();
  controls.begin(state, request());
  assert.equal(controls.remaining(state, 30, '123', today - 86400000).postMs, 0);
  assert.equal(controls.remaining(state, 30, '123', today + 86400000).postMs, 3000);
  controls.begin(state, request({ now: today + 86400000 }));
  assert.equal(controls.remaining(state, 30, '123', today).postMs, 0);
});

test('a hold across midnight cannot clear its reservation until it ends', () => {
  const state = controls.normalize();
  const midnight = new Date(2026, 8, 23).getTime();
  controls.begin(state, request({ now: midnight - 1000 }));
  assert.equal(controls.begin(state, request({ now: midnight, postId: '456' })).ok, false);
  controls.end(state, { token: 'one', tabId: 1, now: midnight + 500 });
  assert.equal(controls.begin(state, request({ now: midnight + 500 })).durationMs, 3000);
});

test('invalid manual identities are discarded while valid post and media choices persist', () => {
  const key = '123|https://pbs.twimg.com/media/example';
  const state = controls.normalize({ posts: {123: today, garbage: today}, media: {[key]: today, '123|javascript:alert(1)': today} });
  assert.deepEqual(Object.keys(state.posts), ['123']);
  assert.deepEqual(Object.keys(state.media), [key]);
});
