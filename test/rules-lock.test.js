const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const background = readFileSync(path.join(root, 'background.js'), 'utf8');
const options = readFileSync(path.join(root, 'options.js'), 'utf8');

test('a locked rule with lockUnblock refuses early unblock in the background', () => {
  assert.match(background, /rule\?\.lockUnblock && isLockActive\(rule\.disableLockedUntil\)/,
    'the unblock handler must enforce the lock, not just the UI');
  assert.match(background, /lockUnblock: !!r\.lockUnblock/, 'saveRules must persist the flag');
  assert.match(background, /replacement\.lockUnblock !== !!existing\.lockUnblock/,
    'a locked rule must not allow toggling lockUnblock');
});

test('the options page exposes and respects the unblock lock', () => {
  assert.match(options, /lockUnblock/);
  assert.match(options, /rule\.lockUnblock && isLocked\(rule\.disableLockedUntil\)/,
    'the Unblock now button must be withheld while locked');
});
