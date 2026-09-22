const params = new URLSearchParams(location.search);
const domain = params.get('domain') || '';
const until = parseInt(params.get('until') || '0', 10);

document.getElementById('domain').textContent = domain;
document.title = `Blocked — ${domain}`;

const $time = document.getElementById('time');
const $countdown = document.querySelector('.countdown');
const adult = params.get('reason') === 'adult';
document.getElementById('settings').addEventListener('click', () => browser.runtime.openOptionsPage());

async function renderAdultBlock() {
  const config = (await browser.runtime.sendMessage({ type: 'getState' })).adultSites || {};
  document.querySelector('.badge').textContent = 'PROTECTED';
  $countdown.textContent = config.error || (config.enabled ? 'Adult-site protection is on.' : 'Adult-site protection is off. You can navigate back manually.');
  document.querySelector('.note').textContent = config.lockUntil > Date.now()
    ? 'Settings locked until ' + new Date(config.lockUntil).toLocaleString() + '. The block stays on after the lock expires.'
    : 'This domain matches the bundled pornography list. You can manage protection in settings.';
}

function tick() {
  const remaining = Math.max(0, (until - Date.now()) / 1000);
  if (remaining <= 0) {
    while ($countdown.firstChild) $countdown.removeChild($countdown.firstChild);
    const span = document.createElement('span');
    span.className = 'expired';
    span.textContent = 'Block expired. You can navigate back manually.';
    $countdown.appendChild(span);
    return false;
  }
  $time.textContent = formatDuration(remaining);
  return true;
}

if (adult) {
  renderAdultBlock();
  setInterval(renderAdultBlock, 1000);
} else if (tick()) {
  const id = setInterval(() => {
    if (!tick()) clearInterval(id);
  }, 500);
}
