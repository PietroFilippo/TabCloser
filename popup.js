const $current = document.getElementById('current');
const $active = document.getElementById('active');
const $activeMore = document.getElementById('activeMore');
const $blocks = document.getElementById('blocks');
const $activeCount = document.getElementById('activeCount');
const $blockCount = document.getElementById('blockCount');
const $blockMore = document.getElementById('blockMore');
const $activeSection = document.getElementById('activeSection');
const $blockSection = document.getElementById('blockSection');
const $error = document.getElementById('error');

const MAX_ROWS = 5;
let showAllActive = false;
let showAllBlocks = false;
let renderVersion = 0;

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

function renderActive(rule, s) {
  const key = normalizeRuleDomain(rule.domain);
  const accum = s.accumSec[key] ?? 0;
  const limit = rule.closeAfterSec;
  const pct = progressFor(rule, s);
  const cls = pct > 90 ? 'danger' : pct > 60 ? 'warn' : '';

  const counting = s.focus?.domain === key && s.focus.enteredAt != null;

  return el('div', { class: 'row' + (counting ? ' active' : '') }, [
    el('div', { class: 'row-top' }, [
      el('div', { class: 'dom', title: key }, key),
      el('span', { class: 'status' + (counting ? ' counting' : '') }, counting ? 'Counting' : 'Paused'),
    ]),
    el('div', { class: 'row-detail' }, [
      el('span', null, counting ? 'Time used' : 'Resumes when focused'),
      el('span', { class: 'meta' }, `${formatDuration(accum)} / ${formatDuration(limit)}`),
    ]),
    el('div', { class: 'bar' },
      el('div', { class: 'bar-fill' + (cls ? ' ' + cls : ''), style: `width:${pct}%` })
    ),
  ]);
}

function renderBlock(key, b, now, blockedBy = key) {
  const remaining = Math.max(0, (b.until - now) / 1000);
  return el('div', { class: 'row blocked' }, [
    el('div', { class: 'row-top' }, [
      el('div', { class: 'dom', title: key }, key),
      el('span', { class: 'status' }, 'Blocked'),
    ]),
    el('div', { class: 'row-detail' }, [
      el('span', { title: blockedBy !== key ? `Blocked by ${blockedBy}` : 'Includes subdomains' },
        blockedBy !== key ? `By ${blockedBy}` : 'Available in'),
      el('span', { class: 'meta countdown' }, formatDuration(remaining)),
    ]),
  ]);
}

async function currentPage() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    const blockedPage = new URL(browser.runtime.getURL('blocked.html'));
    if (url.protocol === blockedPage.protocol && url.hostname === blockedPage.hostname &&
        url.pathname === blockedPage.pathname) {
      return { host: normalizeRuleDomain(url.searchParams.get('domain') || ''), blockedPage: true, adult: url.searchParams.get('reason') === 'adult' };
    }
    return { host: hostFromUrl(tab.url) };
  } catch {
    return { host: null };
  }
}

function updateOverflow(button, count, expanded) {
  button.hidden = count <= MAX_ROWS;
  button.setAttribute('aria-expanded', String(expanded && count > MAX_ROWS));
  button.textContent = expanded ? 'Show fewer' : `Show ${count - MAX_ROWS} more`;
}

function renderState(s, page) {
  const host = page.host;
  const now = Date.now();
  // Old installations may already contain duplicate domains. Show the same
  // enabled rule that enforcement uses until the user resolves them in settings.
  const enabled = [...new Map(s.rules.filter(r => r.enabled).map(r => {
    const key = normalizeRuleDomain(r.domain);
    return [key, ruleForHost(s.rules, key)];
  })).values()];
  const currentBlock = activeBlockForHost(s.blocks, host, now);
  // A child-domain cooldown need not block its parent's other hosts. Keep
  // that parent's independent timer in the tracked list.
  const adultBlocked = page.adult && s.adultSites?.enabled;
  const currentRule = currentBlock || adultBlocked ? null : ruleForHost(enabled, host);
  const currentKey = currentRule ? normalizeRuleDomain(currentRule.domain) : host;
  document.getElementById('currentDot').className = 'dot ' + (currentBlock || adultBlocked ? 'dot-amber'
    : currentRule && s.focus?.domain === currentKey && s.focus.enteredAt != null ? 'dot-green' : 'dot-muted');

  // Current site — always shown.
  clear($current);
  if (adultBlocked) {
    $current.appendChild(el('div', { class: 'row blocked' }, [
      el('div', { class: 'dom' }, host),
      el('div', { class: 'row-detail' }, s.adultSites.error || 'Blocked by adult-site protection.'),
      el('div', { class: 'meta' }, s.adultSites.lockUntil > now ? 'Settings locked until ' + new Date(s.adultSites.lockUntil).toLocaleString() : 'Manage in settings'),
    ]));
  } else if (currentBlock) {
    $current.appendChild(renderBlock(currentKey, currentBlock.block, now, currentBlock.key));
  } else if (currentRule) {
    $current.appendChild(renderActive(currentRule, s));
  } else {
    $current.appendChild(el('div', { class: 'row muted-row' }, [
      el('div', { class: 'dom', title: host }, host || 'Browser page'),
      el('div', { class: 'row-detail' }, host
        ? (page.adult ? 'Adult-site protection is off.' : page.blockedPage ? 'Cooldown finished. You can return to the site.' : 'No timer for this site.')
        : 'Timers run on websites, not internal pages.'),
    ]));
  }

  // Blocked rules have one cooldown card, never a second zeroed timer card.
  clear($active);
  const others = enabled
    .filter(r => r !== currentRule && !(adultBlocked && r === ruleForHost(enabled, host)) && !activeBlockForHost(s.blocks, normalizeRuleDomain(r.domain), now))
    .sort((a, b) => progressFor(b, s) - progressFor(a, s) || a.domain.localeCompare(b.domain));
  $activeSection.hidden = !others.length;
  $activeCount.textContent = String(others.length);
  others.slice(0, showAllActive ? others.length : MAX_ROWS)
    .forEach(r => $active.appendChild(renderActive(r, s)));
  updateOverflow($activeMore, others.length, showAllActive);

  // Blocked — soonest to unblock first.
  clear($blocks);
  const blockEntries = Object.entries(s.blocks)
    .filter(([key, b]) => now < b.until && key !== currentBlock?.key && key !== currentKey)
    .map(([key]) => [key, activeBlockForHost(s.blocks, key, now)])
    .sort((a, b) => a[1].block.until - b[1].block.until || a[0].localeCompare(b[0]));
  $blockSection.hidden = !blockEntries.length;
  $blockCount.textContent = String(blockEntries.length);
  blockEntries.slice(0, showAllBlocks ? blockEntries.length : MAX_ROWS)
    .forEach(([key, match]) => $blocks.appendChild(renderBlock(key, match.block, now, match.key)));
  updateOverflow($blockMore, blockEntries.length, showAllBlocks);
}

async function render() {
  const version = ++renderVersion;
  try {
    const [s, page] = await Promise.all([
      browser.runtime.sendMessage({ type: 'getState' }), currentPage(),
    ]);
    if (version !== renderVersion) return;
    renderState(s, page);
    $error.hidden = true;
  } catch {
    if (version === renderVersion) $error.hidden = false;
  }
}

$activeMore.addEventListener('click', () => { showAllActive = !showAllActive; render(); });
$blockMore.addEventListener('click', () => { showAllBlocks = !showAllBlocks; render(); });
document.getElementById('openOptions').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

render();
setInterval(render, 1000);
