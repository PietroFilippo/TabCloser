const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const coordinator = readFileSync(path.join(root, 'x-protection-v2.js'), 'utf8');
const stylesheet = readFileSync(path.join(root, 'x-protection-v3.css'), 'utf8');
const classifier = readFileSync(path.join(root, 'classifier-entry.js'), 'utf8');

test('candidate discovery stays narrow while claiming native warning status tiles', () => {
  assert.doesNotMatch(coordinator, /card\.wrapper/);
  assert.doesNotMatch(coordinator, /a\[href\*="\/status\/"\] img/);
  assert.doesNotMatch(stylesheet, /card\.wrapper/);
  assert.match(coordinator, /function nativeWarningRootFor/);
  assert.match(coordinator, /warningPattern\.test\(link\.innerText/);
});

test('verdict roots override the fail-closed hiding rule', () => {
  const hideIndex = stylesheet.indexOf(':not([data-tabcloser-x-protection="off"])');
  const anchorIndex = stylesheet.search(/\[data-tabcloser-media-state\] \{[^}]*visibility: visible !important/);
  assert.ok(hideIndex >= 0);
  assert.ok(anchorIndex > hideIndex, 'the verdict re-anchor must follow the hide rule');
  assert.match(stylesheet, /:where\(html/, 'the hide rule must stay at zero specificity so nested verdict roots win');
  assert.match(stylesheet, /:where\(:not\(\[data-tabcloser-media-state\]\)\) > \*/, 'hiding applies to direct children only');
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

test('pending and protected media show blurred previews while staying unplayable and unclickable', () => {
  // Blur targets the root's children (not bare img/video selectors) because X
  // renders photos as background-image divs the img selector misses.
  assert.match(stylesheet, /\[data-tabcloser-media-state="pending"\] > :not\(\.tabcloser-media-overlay\) \{[^}]*blur\(/);
  assert.match(stylesheet, /\[data-tabcloser-media-state="protected"\] > :not\(\.tabcloser-media-overlay\) \{[^}]*blur\(/);
  assert.match(stylesheet, /\.tabcloser-media-overlay-pending \{[^}]*background-color: transparent !important/);
  assert.match(stylesheet, /\.tabcloser-media-overlay \{[^}]*rgba\(/, 'protected overlay must be translucent over the blur');
  assert.match(coordinator, /tabcloser-media-overlay-pending/);
});

test('protected media is covered by a deterministic sacred-art painting with a corner notice', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.ok(manifest.web_accessible_resources.some(entry => entry.resources.includes('assets/sacred-art/*')),
    'paintings must be web-accessible on X pages');
  assert.ok(manifest.content_scripts[0].js.includes('sacred-art-list.js'), 'the generated art list must load before the coordinator');
  assert.match(coordinator, /hashString\(rootFingerprint\(root\)\)/, 'artwork choice must be deterministic per media');
  assert.match(coordinator, /state === 'protected' && mature \? sacredArtUrlFor\(root\) : null/,
    'only confirmed mature verdicts may show a painting');
  assert.match(coordinator, /willRetry = state === 'protected' && !mature && retryableReason\.test/,
    'failure verdicts awaiting retry must render like the pending state');
  assert.match(stylesheet, /\.tabcloser-media-overlay-art \{[^}]*background-size: cover !important/);
  assert.match(stylesheet, /\.tabcloser-media-overlay \{[^}]*background-color:/, 'the base overlay must not use the background shorthand, which would reset the painting');
  assert.doesNotMatch(stylesheet, /\.tabcloser-media-overlay \{[^}]*background: rgba/);
});

test('clicking censored media opens the painting viewer instead of X\'s photo modal', () => {
  const clickIndex = coordinator.indexOf('event.preventDefault');
  const lightboxIndex = coordinator.indexOf('if (url) openLightbox(url);');
  assert.ok(clickIndex >= 0 && lightboxIndex > clickIndex, 'the viewer must open only after X\'s activation is blocked');
  assert.match(coordinator, /reason === 'visual' \|\| reason === 'metadata'/, 'the viewer opens only for confirmed mature verdicts');
  assert.match(stylesheet, /\.tabcloser-lightbox \{[^}]*position: fixed !important/);
});

test('quote replacement and like blocking are opt-in and reversible', () => {
  const background = readFileSync(path.join(root, 'background.js'), 'utf8');
  const quotes = readFileSync(path.join(root, 'catholic-quotes.js'), 'utf8');
  assert.match(background, /replaceText: raw\.replaceText === true/, 'toggles default off');
  assert.match(background, /blockLike: raw\.blockLike === true/);
  assert.match(coordinator, /settings\.replaceText/, 'quote swap must respect its toggle');
  assert.match(coordinator, /settings\.blockLike/, 'like blocking must respect its toggle');
  assert.match(coordinator, /restoreArticleText\(article\)/, 'released media must restore the original text');
  assert.match(coordinator, /closest\('\[data-testid="like"\]'\)/, 'only the like button is blocked, not unlike');
  assert.ok(JSON.stringify(quotes.match(/text:/g).length) > 10, 'quote collection present');
});

test('labeled mode hides only X-labelled media; full mode stays fail-closed', () => {
  const background = readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(coordinator, /if \(mode === 'labeled'\) \{[\s\S]{0,220}metadataProtects\(root\)[\s\S]{0,80}return;/);
  assert.match(stylesheet, /:not\(\[data-tabcloser-x-protection="labeled"\]\)/, 'default hiding must not apply in labeled mode');
  assert.match(background, /state\.xProtection\.labeled\.enabled/, 'metadata observer keyed to the labeled tier');
  assert.match(background, /state\.xProtection\.model\.enabled/, 'classifier keyed to the model tier');
  assert.match(background, /legacyEnabled/, 'legacy single-toggle settings must migrate');
});

test('transient classification failures retry with backoff instead of censoring forever', () => {
  assert.match(coordinator, /scheduleRetry\(root\)/);
  assert.match(coordinator, /\^\(\?:error\|timeout\)\$/, 'only error and timeout verdicts may retry');
  assert.match(coordinator, /previous\?\.fingerprint === fingerprint \? previous\.retries \|\| 0 : 0/, 'retry budget must reset when media changes');
});

test('classifier and failure verdicts hide only their own cell; only X labels hide the group', () => {
  assert.match(coordinator, /function protectUnsafeResult/);
  assert.match(coordinator, /if \(reason === 'metadata'\) \{\s*protectGroup\(root, reason\);/, 'only the tweet-level X label spreads to siblings');
  assert.doesNotMatch(coordinator, /protectGroup\(root, result\.reason/, 'classification results must route through protectUnsafeResult');
});

test('the sensitivity preset reaches the worker, keys the cache, and cannot loosen under lock', () => {
  const background = readFileSync(path.join(root, 'background.js'), 'utf8');
  const worker = readFileSync(path.join(root, 'classifier-worker-entry.js'), 'utf8');
  assert.match(worker, /presetValues\(message\.sensitivity\)/);
  assert.match(background, /MODEL_VERSION \+ '\|' \+ sensitivity \+ '\|' \+ mediaKey/, 'cached verdicts must be per-preset');
  assert.match(background, /nextRank < SENSITIVITY_RANK\[current\.model\.sensitivity\] && isLockActive\(current\.model\.lockUntil\)/,
    'lowering sensitivity while the model tier is locked must be refused');
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

test('a blob-streamed video samples later frames and never trusts its poster alone', () => {
  assert.doesNotMatch(coordinator, /reason: 'poster'/);
  assert.doesNotMatch(coordinator, /posterVerifiedSafe/);
  assert.match(coordinator, /classifyVideoFrames\(video, keyPrefix, source \|\| video\.poster \|\| 'inline'\)/);
  assert.match(coordinator, /videoSampleTimes\(video\.duration\)/);
});

test('a responsive-image fingerprint change requeues instead of leaving media pending', () => {
  assert.doesNotMatch(coordinator, /\[element\.currentSrc, element\.src, element\.poster\]/);
  assert.match(coordinator, /rootFingerprint\(root\) !== fingerprint[\s\S]{0,120}discoverRoot\(root\)/);
  assert.match(coordinator, /attributeFilter: \['src', 'srcset', 'poster', 'href'\]/);
});
