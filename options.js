const $rules = document.getElementById('rules');
const $save = document.getElementById('saveStatus');
const $add = document.getElementById('addRule');
const $xLabeled = document.getElementById('xLabeledEnabled');
const $xLabeledLockMinutes = document.getElementById('xLabeledLockMinutes');
const $xLabeledLockButton = document.getElementById('lockXLabeled');
const $xLabeledStatus = document.getElementById('xLabeledStatus');
const $xModel = document.getElementById('xModelEnabled');
const $xModelLockMinutes = document.getElementById('xModelLockMinutes');
const $xModelLockButton = document.getElementById('lockXModel');
const $xModelStatus = document.getElementById('xModelStatus');

let snapshot = { rules: [], accumSec: {}, blocks: {}, focus: {}, xProtection: {} };
let workingRules = null;
let saveT = null;

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
      if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return e;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function isLocked(until) {
  return Number.isFinite(until) && until > Date.now();
}

function lockText(until) {
  return 'Locked until ' + new Date(until).toLocaleString() + '.';
}

function defaultRule() {
  return {
    id: uuid(),
    domain: '',
    closeAfterSec: 180,
    blockAfterClose: true,
    blockDurationSec: 1800,
    enabled: true,
    disableLockedUntil: null,
  };
}

async function refreshSnapshot() {
  snapshot = await browser.runtime.sendMessage({ type: 'getState' });
}

async function initialLoad() {
  await refreshSnapshot();
  workingRules = snapshot.rules.map(rule => ({ ...rule }));
  render();
  renderXProtection();
}

function render() {
  clear($rules);
  if (!workingRules || !workingRules.length) {
    $rules.appendChild(el('p', { class: 'empty-list' }, 'No sites yet. Click "+ Add site" below.'));
    return;
  }
  workingRules.forEach(rule => $rules.appendChild(renderRule(rule)));
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
    ' / ' + formatDuration(rule.closeAfterSec),
  ]));
  frag.appendChild(el('button', { class: 'reset', 'data-action': 'reset' }, 'Reset timer'));

  if (blockActive) {
    frag.appendChild(el('div', { class: 'blocked-line' }, [
      'Blocked; unblocks in ' + formatDuration((block.until - Date.now()) / 1000) + ' ',
      el('button', { class: 'unblock', 'data-action': 'unblock' }, 'Unblock now'),
    ]));
  }
  return frag;
}

function setStatus(statusEl, rule) {
  clear(statusEl);
  statusEl.appendChild(buildStatus(rule));
  statusEl.querySelector('[data-action="reset"]')?.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'resetAccum', domain: rule.domain });
    await refreshSnapshot();
    setStatus(statusEl, rule);
  });
  statusEl.querySelector('[data-action="unblock"]')?.addEventListener('click', async () => {
    if (!confirm('Unblock ' + normalizeRuleDomain(rule.domain) + ' now?')) return;
    await browser.runtime.sendMessage({ type: 'unblock', domain: rule.domain });
    await refreshSnapshot();
    setStatus(statusEl, rule);
  });
}

function lockControls(rule, locked) {
  if (locked) return el('div', { class: 'rule-lock' }, lockText(rule.disableLockedUntil));
  const minutes = el('input', { type: 'number', min: '1', step: '1', value: '60' });
  const button = el('button', { type: 'button' }, 'Lock rule');
  button.addEventListener('click', async () => {
    const durationSec = Math.round(Number(minutes.value) * 60);
    const saved = await save();
    if (!saved) return;
    const response = await browser.runtime.sendMessage({ type: 'lockRule', id: rule.id, durationSec });
    if (!response.ok) return showSaveError(response.error);
    await initialLoad();
  });
  return el('div', { class: 'lock-controls' }, [
    el('label', null, 'Lock rule for'),
    minutes,
    el('span', null, 'min'),
    button,
  ]);
}

function renderRule(rule) {
  const locked = isLocked(rule.disableLockedUntil);
  const div = el('div', { class: 'rule' + (rule.enabled ? '' : ' disabled') });

  const domainInput = el('input', { type: 'text', placeholder: 'e.g. twitter.com' });
  domainInput.value = rule.domain;
  domainInput.disabled = locked;
  const delBtn = el('button', { class: 'del', title: 'Delete rule', type: 'button' }, 'x');
  delBtn.disabled = locked;
  div.appendChild(el('div', { class: 'rule-header' }, [domainInput, delBtn]));

  const closeAfterInput = el('input', { type: 'number', min: '0.1', step: '0.1' });
  closeAfterInput.value = String(Math.round((rule.closeAfterSec / 60) * 100) / 100);
  closeAfterInput.disabled = locked;
  div.appendChild(el('div', { class: 'field' }, [
    el('label', null, 'Close after'),
    closeAfterInput,
    el('span', null, 'min of active time'),
  ]));

  const blockCheckbox = el('input', { type: 'checkbox' });
  blockCheckbox.checked = rule.blockAfterClose;
  blockCheckbox.disabled = locked;
  const blockDurInput = el('input', { type: 'number', min: '0.1', step: '0.1' });
  blockDurInput.value = String(Math.round((rule.blockDurationSec / 60) * 100) / 100);
  blockDurInput.disabled = locked || !rule.blockAfterClose;
  div.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'toggle' }, [blockCheckbox, ' Block after close for']),
    blockDurInput,
    el('span', null, 'min'),
  ]));

  const enabledCheckbox = el('input', { type: 'checkbox' });
  enabledCheckbox.checked = rule.enabled;
  enabledCheckbox.disabled = locked;
  div.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'toggle' }, [enabledCheckbox, ' Enabled']),
  ]));

  div.appendChild(lockControls(rule, locked));

  const statusEl = el('div', { class: 'status' });
  setStatus(statusEl, rule);
  div.appendChild(statusEl);

  domainInput.addEventListener('input', event => { rule.domain = event.target.value; scheduleSave(); });
  closeAfterInput.addEventListener('input', event => {
    const value = parseFloat(event.target.value);
    if (!isNaN(value) && value > 0) {
      rule.closeAfterSec = Math.max(1, Math.round(value * 60));
      scheduleSave();
    }
  });
  blockCheckbox.addEventListener('change', event => {
    rule.blockAfterClose = event.target.checked;
    blockDurInput.disabled = locked || !rule.blockAfterClose;
    scheduleSave();
  });
  blockDurInput.addEventListener('input', event => {
    const value = parseFloat(event.target.value);
    if (!isNaN(value) && value > 0) {
      rule.blockDurationSec = Math.max(1, Math.round(value * 60));
      scheduleSave();
    }
  });
  enabledCheckbox.addEventListener('change', event => {
    rule.enabled = event.target.checked;
    div.classList.toggle('disabled', !rule.enabled);
    scheduleSave();
  });
  delBtn.addEventListener('click', () => {
    if (confirm('Delete rule for "' + (rule.domain || '(empty)') + '"?')) {
      workingRules = workingRules.filter(item => item.id !== rule.id);
      render();
      scheduleSave();
    }
  });
  return div;
}

function showSaveError(message) {
  $save.textContent = message || 'Unable to save.';
  $save.style.color = '#f66';
}

function scheduleSave() {
  if (saveT) clearTimeout(saveT);
  $save.textContent = 'Saving...';
  $save.style.color = '#aaa';
  saveT = setTimeout(save, 400);
}

async function save() {
  if (!workingRules) return false;
  if (saveT) {
    clearTimeout(saveT);
    saveT = null;
  }
  const rules = workingRules.filter(rule => rule.domain && rule.domain.trim().length > 0);
  const response = await browser.runtime.sendMessage({ type: 'saveRules', rules });
  if (!response.ok) {
    showSaveError(response.error);
    await initialLoad();
    return false;
  }
  $save.textContent = 'Saved.';
  $save.style.color = '#4caf50';
  setTimeout(() => { if ($save.textContent === 'Saved.') $save.textContent = ''; }, 1500);
  return true;
}

function renderXProtection() {
  const config = snapshot.xProtection || {};
  const labeled = config.labeled || {};
  const model = config.model || {};
  const labeledLocked = isLocked(labeled.lockUntil);
  const modelLocked = isLocked(model.lockUntil);

  $xLabeled.checked = labeled.enabled === true;
  // The label tier cannot be turned off while it, or the classifier tier that
  // implies it, is enabled and locked.
  $xLabeled.disabled = labeledLocked || (model.enabled === true && modelLocked);
  $xLabeledLockMinutes.disabled = labeledLocked;
  $xLabeledLockButton.disabled = labeledLocked;
  $xLabeledStatus.textContent = labeledLocked ? lockText(labeled.lockUntil) : '';

  $xModel.checked = model.enabled === true;
  $xModel.disabled = modelLocked;
  $xModelLockMinutes.disabled = modelLocked;
  $xModelLockButton.disabled = modelLocked;
  $xModelStatus.textContent = modelLocked ? lockText(model.lockUntil) : '';
}

async function saveXProtection(labeledEnabled, modelEnabled) {
  const response = await browser.runtime.sendMessage({ type: 'saveXProtection', labeled: labeledEnabled, model: modelEnabled });
  if (!response.ok) showSaveError(response.error);
  await refreshSnapshot();
  renderXProtection();
}

$xLabeled.addEventListener('change', () => {
  // Disabling the label tier also disables the classifier tier it carries.
  const labeledEnabled = $xLabeled.checked;
  saveXProtection(labeledEnabled, labeledEnabled && $xModel.checked);
});

$xModel.addEventListener('change', () => {
  // Enabling the classifier tier switches the label tier on with it.
  saveXProtection($xLabeled.checked || $xModel.checked, $xModel.checked);
});

async function lockXProtection(target, minutesInput) {
  const durationSec = Math.round(Number(minutesInput.value) * 60);
  const response = await browser.runtime.sendMessage({ type: 'lockXProtection', target, durationSec });
  if (!response.ok) showSaveError(response.error);
  await refreshSnapshot();
  renderXProtection();
}

$xLabeledLockButton.addEventListener('click', () => lockXProtection('labeled', $xLabeledLockMinutes));
$xModelLockButton.addEventListener('click', () => lockXProtection('model', $xModelLockMinutes));

$add.addEventListener('click', () => {
  if (!workingRules) workingRules = [];
  workingRules.push(defaultRule());
  render();
});

setInterval(async () => {
  if (!workingRules) return;
  await refreshSnapshot();
  const ruleEls = $rules.querySelectorAll('.rule');
  ruleEls.forEach((ruleEl, index) => {
    const rule = workingRules[index];
    const statusEl = ruleEl.querySelector('.status');
    if (rule && statusEl) setStatus(statusEl, rule);
  });
  renderXProtection();
}, 1000);

initialLoad();
