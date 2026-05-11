const $active = document.getElementById('active');
const $blocks = document.getElementById('blocks');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function render() {
  const s = await browser.runtime.sendMessage({ type: 'getState' });
  const now = Date.now();

  const enabledRules = s.rules.filter(r => r.enabled);
  if (!enabledRules.length) {
    $active.innerHTML = '<div class="empty">No sites configured. Open settings.</div>';
  } else {
    $active.innerHTML = enabledRules.map(r => {
      const key = normalizeRuleDomain(r.domain);
      const accum = s.accumSec[key] ?? 0;
      const limit = r.closeAfterSec;
      const pct = Math.min(100, (accum / limit) * 100);
      const isFocused = s.focus.domain === key;
      const cls = pct > 90 ? 'danger' : pct > 60 ? 'warn' : '';
      return `
        <div class="row">
          <div class="dom">${escapeHtml(key)}${isFocused ? '<span class="tag">(active)</span>' : ''}</div>
          <div class="meta">${formatDuration(accum)} / ${formatDuration(limit)}</div>
          <div class="bar"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');
  }

  const blockEntries = Object.entries(s.blocks).filter(([_, b]) => now < b.until);
  if (!blockEntries.length) {
    $blocks.innerHTML = '<div class="empty">Nothing blocked.</div>';
  } else {
    $blocks.innerHTML = blockEntries.map(([key, b]) => {
      const remaining = Math.max(0, (b.until - now) / 1000);
      return `<div class="row"><div class="dom">${escapeHtml(key)}</div><div class="meta">Unblocks in ${formatDuration(remaining)}</div></div>`;
    }).join('');
  }
}

document.getElementById('openOptions').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

render();
setInterval(render, 1000);
