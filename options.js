const $rules = document.getElementById('rules');
const $save = document.getElementById('saveStatus');
const $add = document.getElementById('addRule');

let snapshot = { rules: [], accumSec: {}, blocks: {}, focus: {} };
let workingRules = null;

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

async function initialLoad() {
  snapshot = await browser.runtime.sendMessage({ type: 'getState' });
  workingRules = snapshot.rules.map(r => ({ ...r }));
  render();
}

function render() {
  clear($rules);
  if (!workingRules || !workingRules.length) {
    $rules.appendChild(el('p', { class: 'empty-list' }, 'No sites yet. Click "+ Add site" below.'));
    return;
  }
  for (const rule of workingRules) {
    $rules.appendChild(renderRule(rule));
  }
}

function buildStatus(rule) {
  const key = normalizeRuleDomain(rule.domain);
  const accum = snapshot.accumSec[key] ?? 0;
  const block = snapshot.blocks[key];
  const blockActive = block && Date.now() < block.until;

  const frag = document.createDocumentFragment();

  frag.appendChild(el('span', null, [
    'Active time: ',
    el('strong', null, formatDuration(accum)),
    ` / ${formatDuration(rule.closeAfterSec)}`,
  ]));

  frag.appendChild(el('button', { class: 'reset', 'data-action': 'reset' }, 'Reset timer'));

  if (blockActive) {
    const remaining = formatDuration((block.until - Date.now()) / 1000);
    frag.appendChild(el('div', { class: 'blocked-line' }, [
      `Blocked — unblocks in ${remaining} `,
      el('button', { class: 'unblock', 'data-action': 'unblock' }, 'Unblock now'),
    ]));
  }

  return frag;
}

function setStatus(statusEl, rule) {
  clear(statusEl);
  statusEl.appendChild(buildStatus(rule));
  bindStatusButtons(statusEl, rule);
}

function bindStatusButtons(statusEl, rule) {
  statusEl.querySelector('[data-action="reset"]')?.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'resetAccum', domain: rule.domain });
    await refreshSnapshot();
    setStatus(statusEl, rule);
  });
  statusEl.querySelector('[data-action="unblock"]')?.addEventListener('click', async () => {
    if (confirm(`Unblock ${normalizeRuleDomain(rule.domain)} now?`)) {
      await browser.runtime.sendMessage({ type: 'unblock', domain: rule.domain });
      await refreshSnapshot();
      setStatus(statusEl, rule);
    }
  });
}

function renderRule(rule) {
  const div = el('div', { class: 'rule' + (rule.enabled ? '' : ' disabled') });

  // Header: domain input + delete button
  const domainInput = el('input', { type: 'text', placeholder: 'e.g. twitter.com', 'data-field': 'domain' });
  domainInput.value = rule.domain;
  const delBtn = el('button', { class: 'del', title: 'Delete rule' }, '×');
  div.appendChild(el('div', { class: 'rule-header' }, [domainInput, delBtn]));

  // Close-after
  const closeAfterInput = el('input', { type: 'number', min: '0.1', step: '0.1', 'data-field': 'closeAfterMin' });
  closeAfterInput.value = String(Math.round((rule.closeAfterSec / 60) * 100) / 100);
  div.appendChild(el('div', { class: 'field' }, [
    el('label', null, 'Close after'),
    closeAfterInput,
    el('span', null, 'min of active time'),
  ]));

  // Block after close + duration
  const blockCheckbox = el('input', { type: 'checkbox', 'data-field': 'blockAfterClose' });
  blockCheckbox.checked = rule.blockAfterClose;
  const blockDurInput = el('input', { type: 'number', min: '0.1', step: '0.1', 'data-field': 'blockDurationMin' });
  blockDurInput.value = String(Math.round((rule.blockDurationSec / 60) * 100) / 100);
  blockDurInput.disabled = !rule.blockAfterClose;
  div.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'toggle' }, [blockCheckbox, ' Block after close for']),
    blockDurInput,
    el('span', null, 'min'),
  ]));

  // Enabled toggle
  const enabledCheckbox = el('input', { type: 'checkbox', 'data-field': 'enabled' });
  enabledCheckbox.checked = rule.enabled;
  div.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'toggle' }, [enabledCheckbox, ' Enabled']),
  ]));

  // Status
  const statusEl = el('div', { class: 'status' });
  setStatus(statusEl, rule);
  div.appendChild(statusEl);

  // Wire events
  domainInput.addEventListener('input', e => {
    rule.domain = e.target.value;
    scheduleSave();
  });
  closeAfterInput.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      rule.closeAfterSec = Math.max(1, Math.round(v * 60));
      scheduleSave();
    }
  });
  blockCheckbox.addEventListener('change', e => {
    rule.blockAfterClose = e.target.checked;
    blockDurInput.disabled = !rule.blockAfterClose;
    scheduleSave();
  });
  blockDurInput.addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      rule.blockDurationSec = Math.max(1, Math.round(v * 60));
      scheduleSave();
    }
  });
  enabledCheckbox.addEventListener('change', e => {
    rule.enabled = e.target.checked;
    div.classList.toggle('disabled', !rule.enabled);
    scheduleSave();
  });
  delBtn.addEventListener('click', () => {
    if (confirm(`Delete rule for "${rule.domain || '(empty)'}"?`)) {
      workingRules = workingRules.filter(r => r.id !== rule.id);
      render();
      scheduleSave();
    }
  });

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

// Live status refresh without rebuilding the form
setInterval(async () => {
  if (!workingRules) return;
  await refreshSnapshot();
  const ruleEls = $rules.querySelectorAll('.rule');
  ruleEls.forEach((ruleEl, i) => {
    const rule = workingRules[i];
    if (!rule) return;
    const statusEl = ruleEl.querySelector('.status');
    if (statusEl) setStatus(statusEl, rule);
  });
}, 1000);

initialLoad();
