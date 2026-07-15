const $current = document.getElementById('current');
const $active = document.getElementById('active');
const $activeMore = document.getElementById('activeMore');
const $blocks = document.getElementById('blocks');
const $activeCount = document.getElementById('activeCount');
const $blockCount = document.getElementById('blockCount');
const $blockMore = document.getElementById('blockMore');

const MAX_ROWS = 5;

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
  }
  if (children != null) {
    for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return e;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function progressFor(rule, s) {
  const key = normalizeRuleDomain(rule.domain);
  const accum = s.accumSec[key] ?? 0;
  return Math.min(100, (accum / rule.closeAfterSec) * 100);
}

function renderActive(rule, s, isCurrent) {
  const key = normalizeRuleDomain(rule.domain);
  const accum = s.accumSec[key] ?? 0;
  const limit = rule.closeAfterSec;
  const pct = progressFor(rule, s);
  const cls = pct > 90 ? 'danger' : pct > 60 ? 'warn' : '';

  const domLine = el('div', { class: 'dom' }, key);
  if (isCurrent) domLine.appendChild(el('span', { class: 'tag' }, '● active'));

  return el('div', { class: 'row' + (isCurrent ? ' active' : '') }, [
    el('div', { class: 'row-top' }, [
      domLine,
      el('div', { class: 'meta' }, `${formatDuration(accum)} / ${formatDuration(limit)}`),
    ]),
    el('div', { class: 'bar' },
      el('div', { class: 'bar-fill' + (cls ? ' ' + cls : ''), style: `width:${pct}%` })
    ),
  ]);
}

function renderBlock(key, b, now) {
  const remaining = Math.max(0, (b.until - now) / 1000);
  return el('div', { class: 'row blocked' }, [
    el('div', { class: 'row-top' }, [
      el('div', { class: 'dom' }, key),
      el('div', { class: 'meta' }, `${formatDuration(remaining)} left`),
    ]),
  ]);
}

async function currentHost() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab?.url ? hostFromUrl(tab.url) : null;
  } catch {
    return null;
  }
}

async function render() {
  const [s, host] = await Promise.all([
    browser.runtime.sendMessage({ type: 'getState' }),
    currentHost(),
  ]);
  const now = Date.now();
  const enabled = s.rules.filter(r => r.enabled);
  const currentRule = host ? enabled.find(r => hostMatches(host, r.domain)) : null;

  // Current site — always shown.
  clear($current);
  if (currentRule) {
    $current.appendChild(renderActive(currentRule, s, true));
  } else {
    const label = host || 'this page';
    $current.appendChild(el('div', { class: 'row muted-row' },
      el('div', { class: 'dom-plain' }, label + ' has no timer.')));
  }

  // Tracked sites — everything except the current one, closest-to-limit first.
  clear($active);
  const others = enabled
    .filter(r => r !== currentRule)
    .sort((a, b) => progressFor(b, s) - progressFor(a, s));
  $activeCount.textContent = others.length || '';
  clear($activeMore);
  if (!others.length) {
    $active.appendChild(el('div', { class: 'empty' }, currentRule ? 'No other sites tracked.' : 'No sites configured. Open settings.'));
  } else {
    others.slice(0, MAX_ROWS).forEach(r => $active.appendChild(renderActive(r, s, false)));
    if (others.length > MAX_ROWS) $activeMore.textContent = `+${others.length - MAX_ROWS} more in settings`;
  }

  // Blocked — soonest to unblock first.
  clear($blocks);
  clear($blockMore);
  const blockEntries = Object.entries(s.blocks).filter(([_, b]) => now < b.until)
    .sort((a, b) => a[1].until - b[1].until);
  $blockCount.textContent = blockEntries.length || '';
  if (!blockEntries.length) {
    $blocks.appendChild(el('div', { class: 'empty' }, 'Nothing blocked.'));
  } else {
    blockEntries.slice(0, MAX_ROWS).forEach(([k, b]) => $blocks.appendChild(renderBlock(k, b, now)));
    if (blockEntries.length > MAX_ROWS) $blockMore.textContent = `+${blockEntries.length - MAX_ROWS} more`;
  }
}

document.getElementById('openOptions').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

render();
setInterval(render, 1000);
