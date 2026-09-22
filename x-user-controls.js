// Durable manual choices and a shared, reservation-based reveal allowance.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TabCloserXUserControls = api;
})(globalThis, function() {
  const POST_LIMIT_MS = 3000;
  const validPost = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
  function validMedia(value) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    const split = value.indexOf('|');
    if (!validPost(value.slice(0, split))) return false;
    try {
      const url = new URL(value.slice(split + 1));
      return url.protocol === 'https:' && /^(pbs|video)\.twimg\.com$/.test(url.hostname);
    } catch { return false; }
  }
  function dayAt(now) {
    const date = new Date(now);
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }
  function normalize(raw = {}) {
    raw = raw || {};
    const entries = (values, valid) => Object.fromEntries(Object.entries(values || {})
      .filter(([key, at]) => valid(key) && Number.isFinite(at)));
    const ledger = raw.ledger || {};
    return {
      posts: entries(raw.posts, validPost), media: entries(raw.media, validMedia),
      ledger: {
        day: /^\d{4}-\d{2}-\d{2}$/.test(ledger.day) ? ledger.day : '',
        usedMs: Math.max(0, Number(ledger.usedMs) || 0),
        posts: Object.fromEntries(Object.entries(ledger.posts || {}).filter(([key, value]) => validPost(key) && Number.isFinite(value) && value >= 0)),
        // An interrupted reveal keeps its reservation. Never resume visibility on startup.
        lease: null,
      },
    };
  }
  function rollDay(state, now) {
    const day = dayAt(now);
    // Moving the clock backwards cannot refill the allowance.
    if (day > state.ledger.day && !(state.ledger.lease?.deadline > now)) {
      state.ledger = { day, usedMs: 0, posts: {}, lease: null };
    }
  }
  function remaining(state, limitSec, postId, now) {
    rollDay(state, now);
    return {
      dailyMs: Math.max(0, limitSec * 1000 - state.ledger.usedMs),
      postMs: Math.max(0, POST_LIMIT_MS - (state.ledger.posts[postId] || 0)),
      day: state.ledger.day,
    };
  }
  function begin(state, { postId, tabId, limitSec, now, token }) {
    if (!validPost(postId)) return { ok: false, error: 'This post has no stable identity.' };
    const left = remaining(state, limitSec, postId, now);
    if (state.ledger.lease?.deadline > now) return { ok: false, error: 'A reveal is already active in another view.' };
    const durationMs = Math.floor(Math.min(left.dailyMs, left.postMs, POST_LIMIT_MS));
    if (durationMs <= 0) return { ok: false, error: left.dailyMs <= 0 ? 'No daily reveal allowance remains.' : 'This post has used its three seconds today.' };
    const lease = { token, postId, tabId, startedAt: now, deadline: now + durationMs, durationMs };
    // Reserve before sending permission to the page. Reloads/crashes cannot refund time.
    state.ledger.usedMs += durationMs;
    state.ledger.posts[postId] = (state.ledger.posts[postId] || 0) + durationMs;
    state.ledger.lease = lease;
    return { ok: true, ...lease, ...remaining(state, limitSec, postId, now) };
  }
  function end(state, { token, tabId, now }) {
    const lease = state.ledger.lease;
    if (!lease || lease.token !== token || lease.tabId !== tabId) return false;
    const elapsed = Math.min(lease.durationMs, Math.max(0, now - lease.startedAt));
    // A backwards clock consumes the reservation instead of granting extra time.
    const refund = now < lease.startedAt ? 0 : lease.durationMs - elapsed;
    state.ledger.usedMs = Math.max(0, state.ledger.usedMs - refund);
    state.ledger.posts[lease.postId] = Math.max(0, state.ledger.posts[lease.postId] - refund);
    state.ledger.lease = null;
    return true;
  }
  return { normalize, validPost, validMedia, remaining, begin, end, POST_LIMIT_MS };
});
