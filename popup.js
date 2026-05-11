const $active = document.getElementById('active');
const $blocks = document.getElementById('blocks');

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

function renderActive(rule, s) {
  const key = normalizeRuleDomain(rule.domain);
  const accum = s.accumSec[key] ?? 0;
  const limit = rule.closeAfterSec;
  const pct = Math.min(100, (accum / limit) * 100);
  const isFocused = s.focus.domain === key;
  const cls = pct > 90 ? 'danger' : pct > 60 ? 'warn' : '';

  const domLine = el('div', { class: 'dom' }, key);
  if (isFocused) domLine.appendChild(el('span', { class: 'tag' }, '(active)'));

  return el('div', { class: 'row' }, [
    domLine,
    el('div', { class: 'meta' }, `${formatDuration(accum)} / ${formatDuration(limit)}`),
    el('div', { class: 'bar' },
      el('div', { class: 'bar-fill' + (cls ? ' ' + cls : ''), style: `width:${pct}%` })
    ),
  ]);
}

function renderBlock(key, b, now) {
  const remaining = Math.max(0, (b.until - now) / 1000);
  return el('div', { class: 'row' }, [
    el('div', { class: 'dom' }, key),
    el('div', { class: 'meta' }, `Unblocks in ${formatDuration(remaining)}`),
  ]);
}

async function render() {
  const s = await browser.runtime.sendMessage({ type: 'getState' });
  const now = Date.now();

  clear($active);
  const enabled = s.rules.filter(r => r.enabled);
  if (!enabled.length) {
    $active.appendChild(el('div', { class: 'empty' }, 'No sites configured. Open settings.'));
  } else {
    enabled.forEach(r => $active.appendChild(renderActive(r, s)));
  }

  clear($blocks);
  const blockEntries = Object.entries(s.blocks).filter(([_, b]) => now < b.until);
  if (!blockEntries.length) {
    $blocks.appendChild(el('div', { class: 'empty' }, 'Nothing blocked.'));
  } else {
    blockEntries.forEach(([k, b]) => $blocks.appendChild(renderBlock(k, b, now)));
  }
}

document.getElementById('openOptions').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

render();
setInterval(render, 1000);
