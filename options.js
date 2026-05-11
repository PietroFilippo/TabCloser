const $rules = document.getElementById('rules');
const $save = document.getElementById('saveStatus');
const $add = document.getElementById('addRule');

let snapshot = { rules: [], accumSec: {}, blocks: {}, focus: {} };
let workingRules = null;

function defaultRule() {
  return {
    id: uuid(),
    domain: '',
    closeAfterSec: 180,
    blockAfterClose: true,
    blockDurationSec: 1800,
    enabled: true,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function initialLoad() {
  snapshot = await browser.runtime.sendMessage({ type: 'getState' });
  workingRules = snapshot.rules.map(r => ({ ...r }));
  render();
}

function render() {
  $rules.innerHTML = '';
  if (!workingRules || !workingRules.length) {
    $rules.innerHTML = '<p class="empty-list">No sites yet. Click "+ Add site" below.</p>';
    return;
  }
  for (const rule of workingRules) {
    $rules.appendChild(renderRule(rule));
  }
}

function statusHtml(rule) {
  const key = normalizeRuleDomain(rule.domain);
  const accum = snapshot.accumSec[key] ?? 0;
  const block = snapshot.blocks[key];
  const blockActive = block && Date.now() < block.until;
  let html = `
    <span>Active time: <strong>${formatDuration(accum)}</strong> / ${formatDuration(rule.closeAfterSec)}</span>
    <button class="reset" data-action="reset">Reset timer</button>
  `;
  if (blockActive) {
    html += `
      <div class="blocked-line">
        Blocked — unblocks in ${formatDuration((block.until - Date.now()) / 1000)}
        <button class="unblock" data-action="unblock">Unblock now</button>
      </div>
    `;
  }
  return html;
}

function bindStatusButtons(statusEl, rule) {
  statusEl.querySelector('[data-action="reset"]')?.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'resetAccum', domain: rule.domain });
    await refreshSnapshot();
    statusEl.innerHTML = statusHtml(rule);
    bindStatusButtons(statusEl, rule);
  });
  statusEl.querySelector('[data-action="unblock"]')?.addEventListener('click', async () => {
    if (confirm(`Unblock ${normalizeRuleDomain(rule.domain)} now?`)) {
      await browser.runtime.sendMessage({ type: 'unblock', domain: rule.domain });
      await refreshSnapshot();
      statusEl.innerHTML = statusHtml(rule);
      bindStatusButtons(statusEl, rule);
    }
  });
}

function renderRule(rule) {
  const div = document.createElement('div');
  div.className = 'rule' + (rule.enabled ? '' : ' disabled');

  div.innerHTML = `
    <div class="rule-header">
      <input type="text" placeholder="e.g. twitter.com" value="${escapeHtml(rule.domain)}" data-field="domain">
      <button class="del" title="Delete rule">&times;</button>
    </div>
    <div class="field">
      <label>Close after</label>
      <input type="number" min="0.1" step="0.1" value="${Math.round(rule.closeAfterSec / 60 * 100) / 100}" data-field="closeAfterMin">
      <span>min of active time</span>
    </div>
    <div class="field">
      <label class="toggle">
        <input type="checkbox" data-field="blockAfterClose" ${rule.blockAfterClose ? 'checked' : ''}>
        Block after close for
      </label>
      <input type="number" min="0.1" step="0.1" value="${Math.round(rule.blockDurationSec / 60 * 100) / 100}" data-field="blockDurationMin" ${rule.blockAfterClose ? '' : 'disabled'}>
      <span>min</span>
    </div>
    <div class="field">
      <label class="toggle">
        <input type="checkbox" data-field="enabled" ${rule.enabled ? 'checked' : ''}>
        Enabled
      </label>
    </div>
    <div class="status">${statusHtml(rule)}</div>
  `;

  div.querySelector('[data-field="domain"]').addEventListener('input', e => {
    rule.domain = e.target.value;
    scheduleSave();
  });
  div.querySelector('[data-field="closeAfterMin"]').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      rule.closeAfterSec = Math.max(1, Math.round(v * 60));
      scheduleSave();
    }
  });
  div.querySelector('[data-field="blockAfterClose"]').addEventListener('change', e => {
    rule.blockAfterClose = e.target.checked;
    const bd = div.querySelector('[data-field="blockDurationMin"]');
    if (bd) bd.disabled = !rule.blockAfterClose;
    scheduleSave();
  });
  div.querySelector('[data-field="blockDurationMin"]')?.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      rule.blockDurationSec = Math.max(1, Math.round(v * 60));
      scheduleSave();
    }
  });
  div.querySelector('[data-field="enabled"]').addEventListener('change', e => {
    rule.enabled = e.target.checked;
    div.classList.toggle('disabled', !rule.enabled);
    scheduleSave();
  });

  div.querySelector('.del').addEventListener('click', () => {
    if (confirm(`Delete rule for "${rule.domain || '(empty)'}"?`)) {
      workingRules = workingRules.filter(r => r.id !== rule.id);
      render();
      scheduleSave();
    }
  });

  bindStatusButtons(div.querySelector('.status'), rule);

  return div;
}

let saveT = null;
function scheduleSave() {
  if (saveT) clearTimeout(saveT);
  $save.textContent = 'Saving...';
  $save.style.color = '#aaa';
  saveT = setTimeout(save, 400);
}

async function save() {
  if (!workingRules) return;
  const toSave = workingRules.filter(r => r.domain && r.domain.trim().length > 0);
  await browser.runtime.sendMessage({ type: 'saveRules', rules: toSave });
  $save.textContent = 'Saved.';
  $save.style.color = '#4caf50';
  setTimeout(() => { $save.textContent = ''; }, 1500);
}

$add.addEventListener('click', () => {
  if (!workingRules) workingRules = [];
  workingRules.push(defaultRule());
  render();
});

async function refreshSnapshot() {
  snapshot = await browser.runtime.sendMessage({ type: 'getState' });
}

// Live status refresh without clobbering form fields.
setInterval(async () => {
  if (!workingRules) return;
  await refreshSnapshot();
  const ruleEls = $rules.querySelectorAll('.rule');
  ruleEls.forEach((el, i) => {
    const rule = workingRules[i];
    if (!rule) return;
    const status = el.querySelector('.status');
    if (status && document.activeElement?.closest('.rule') !== el) {
      // skip re-render if user is interacting with this rule's inputs? Actually safe — status section has no editable inputs.
    }
    if (status) {
      status.innerHTML = statusHtml(rule);
      bindStatusButtons(status, rule);
    }
  });
}, 1000);

initialLoad();
