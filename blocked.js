const params = new URLSearchParams(location.search);
const domain = params.get('domain') || '';
const until = parseInt(params.get('until') || '0', 10);

document.getElementById('domain').textContent = domain;
document.title = `Blocked — ${domain}`;

const $time = document.getElementById('time');
const $countdown = document.querySelector('.countdown');

function tick() {
  const remaining = Math.max(0, (until - Date.now()) / 1000);
  if (remaining <= 0) {
    $countdown.innerHTML = '<span class="expired">Block expired. You can navigate back manually.</span>';
    return false;
  }
  $time.textContent = formatDuration(remaining);
  return true;
}

if (tick()) {
  const id = setInterval(() => {
    if (!tick()) clearInterval(id);
  }, 500);
}
