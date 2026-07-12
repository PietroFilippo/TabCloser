const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../manifest.json');

test('extension CSP permits the bundled classifier WebAssembly runtime', () => {
  const policy = manifest.content_security_policy?.extension_pages || '';
  assert.match(policy, /script-src[^;]*'self'/);
  assert.match(policy, /script-src[^;]*'wasm-unsafe-eval'/);
  assert.match(policy, /object-src 'self'/);
});
