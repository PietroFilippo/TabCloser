const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const coordinator = readFileSync(path.join(root, 'x-protection-v2.js'), 'utf8');
const stylesheet = readFileSync(path.join(root, 'x-protection-v3.css'), 'utf8');
const classifier = readFileSync(path.join(root, 'classifier-entry.js'), 'utf8');

test('candidate discovery excludes profile/card images and bare status-link descendants', () => {
  assert.doesNotMatch(coordinator, /card\.wrapper/);
  assert.doesNotMatch(coordinator, /a\[href\*="\/status\/"\] img/);
  assert.doesNotMatch(stylesheet, /card\.wrapper/);
});

test('safe-state visibility override follows the fail-closed hiding rule', () => {
  const hideIndex = stylesheet.indexOf(':not([data-tabcloser-x-protection="off"])');
  const safeIndex = stylesheet.indexOf('[data-tabcloser-media-state="safe"]');
  assert.ok(hideIndex >= 0);
  assert.ok(safeIndex > hideIndex);
});

test('inference runs in a worker with webgl acceleration and a cpu fallback', () => {
  const worker = readFileSync(path.join(root, 'classifier-worker-entry.js'), 'utf8');
  assert.match(classifier, /new Worker\(/);
  assert.doesNotMatch(classifier, /setBackend/);
  assert.match(worker, /setBackend\('webgl'\)/);
  assert.match(worker, /setBackend\('cpu'\)/);
});

test('graphql response bytes stream through before metadata parsing', () => {
  const background = readFileSync(path.join(root, 'background.js'), 'utf8');
  const onData = background.indexOf('filter.ondata');
  const write = background.indexOf('filter.write(event.data)');
  const onStop = background.indexOf('filter.onstop');
  assert.ok(onData >= 0 && write > onData && write < onStop, 'filter must forward each chunk inside ondata');
});

test('transient classification failures retry with backoff instead of censoring forever', () => {
  assert.match(coordinator, /scheduleRetry\(root\)/);
  assert.match(coordinator, /\^\(\?:error\|timeout\)\$/, 'only error and timeout verdicts may retry');
  assert.match(coordinator, /previous\?\.fingerprint === fingerprint \? previous\.retries \|\| 0 : 0/, 'retry budget must reset when media changes');
});

test('failure verdicts hide only their own cell; mature verdicts hide the whole group', () => {
  assert.match(coordinator, /function protectUnsafeResult/);
  assert.match(coordinator, /\^\(\?:error\|timeout\|invalid\)\$/, 'failure reasons are root-scoped');
  assert.doesNotMatch(coordinator, /protectGroup\(root, result\.reason/, 'classification results must route through protectUnsafeResult');
});

test('an X sensitivity flag hard-blocks before any visual classification', () => {
  assert.match(coordinator, /function metadataProtects/);
  assert.match(coordinator, /if \(metadataProtects\(root\)\) \{\s*protectGroup\(root, 'metadata'\);\s*return;/);
});

test('the overlay and click blocker cover the full clickable photo/video cell', () => {
  assert.match(coordinator, /overlayHostFor/);
  assert.match(coordinator, /host\.appendChild\(overlay\)/);
  assert.match(coordinator, /\.tabcloser-overlay-host'\)/, 'click blocker must include the overlay host');
  assert.match(stylesheet, /\.tabcloser-overlay-host \{[^}]*position: relative !important/);
});

test('emoji, avatar, and hashflag images never become media roots or classifier input', () => {
  assert.doesNotMatch(coordinator, /return node\.parentElement/, 'generic parent fallback recreates emoji/avatar roots');
  assert.match(coordinator, /\/emoji\//);
  assert.match(coordinator, /\/profile_images\//);
  assert.match(coordinator, /abs\.twimg\.com/);
  assert.match(coordinator, /filter\(image => !decorativeImage\(image\)\)/);
});

test('a blob-streamed video with a safe poster is released instead of failing closed', () => {
  const posterRelease = coordinator.indexOf("posterVerifiedSafe ? { verdict: 'safe', reason: 'poster' }");
  const invalidFallback = coordinator.indexOf("{ verdict: 'protect', reason: 'invalid' }");
  assert.ok(posterRelease >= 0, 'safe poster must release an unsampleable video');
  assert.ok(invalidFallback >= 0, 'posterless unsampleable video must stay protected');
});

test('a responsive-image fingerprint change requeues instead of leaving media pending', () => {
  assert.doesNotMatch(coordinator, /\[element\.currentSrc, element\.src, element\.poster\]/);
  assert.match(coordinator, /rootFingerprint\(root\) !== fingerprint[\s\S]{0,120}discoverRoot\(root\)/);
  assert.match(coordinator, /attributeFilter: \['src', 'srcset', 'poster', 'href'\]/);
});
